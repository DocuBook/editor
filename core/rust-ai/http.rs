//! Shared HTTP clients for provider chat requests.
//!
//! Building a `reqwest::Client` per request threw away its connection pool, so
//! every model round — a prompt turn with web tools runs up to five, plus
//! semantic retries — paid DNS, TCP and TLS setup again before the provider
//! could even start its prefill. Clients are cached instead and keep their
//! pooled connections warm between rounds and turns.
//!
//! A custom endpoint is pinned to the addresses it was validated against
//! (`provider::validated_custom_addrs`), so its client is cached under that
//! exact host and address set: a new DNS answer builds a new pinned client, and
//! no request can ever reach an address that was not validated for it.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// Longest gap between two chunks of a streaming response.
const READ_TIMEOUT: Duration = Duration::from_secs(120);
/// Idle pooled connections are dropped after this long.
const POOL_IDLE_TIMEOUT: Duration = Duration::from_secs(90);
/// Distinct pinned endpoints kept; more than a handful only happens when DNS
/// keeps rotating, and then the cache simply starts over.
const MAX_PINNED_CLIENTS: usize = 8;

type PinKey = (String, Vec<SocketAddr>);

fn builder() -> reqwest::ClientBuilder {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(CONNECT_TIMEOUT)
        .read_timeout(READ_TIMEOUT)
        .pool_idle_timeout(POOL_IDLE_TIMEOUT)
}

/// Client for a chat request. `pinned` is the `(host, addresses)` pair from
/// `validated_custom_addrs` for a custom endpoint, `None` for a catalog provider.
pub fn chat_client(pinned: Option<&(String, Vec<SocketAddr>)>) -> Result<reqwest::Client, String> {
    let Some((host, addrs)) = pinned else {
        static SHARED: OnceLock<reqwest::Client> = OnceLock::new();
        if let Some(client) = SHARED.get() {
            return Ok(client.clone());
        }
        let client = builder()
            .build()
            .map_err(|error| format!("Client error: {error}"))?;
        return Ok(SHARED.get_or_init(|| client).clone());
    };
    static PINNED: OnceLock<Mutex<HashMap<PinKey, reqwest::Client>>> = OnceLock::new();
    let mut sorted = addrs.clone();
    sorted.sort();
    sorted.dedup();
    let key = (host.clone(), sorted);
    let cache = PINNED.get_or_init(Default::default);
    if let Some(client) = cache.lock().unwrap_or_else(|e| e.into_inner()).get(&key) {
        return Ok(client.clone());
    }
    let client = builder()
        .resolve_to_addrs(host, addrs)
        .build()
        .map_err(|error| format!("Client error: {error}"))?;
    let mut clients = cache.lock().unwrap_or_else(|e| e.into_inner());
    if clients.len() >= MAX_PINNED_CLIENTS && !clients.contains_key(&key) {
        clients.clear();
    }
    Ok(clients.entry(key).or_insert(client).clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn rounds_reuse_one_pooled_connection() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;

        // A keep-alive server that counts accepted connections.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let accepted = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&accepted);
        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else { return };
                counter.fetch_add(1, Ordering::SeqCst);
                tokio::spawn(async move {
                    let mut buf = [0u8; 4096];
                    while let Ok(read) = socket.read(&mut buf).await {
                        if read == 0 {
                            return;
                        }
                        let _ = socket
                            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok")
                            .await;
                    }
                });
            }
        });

        let pinned = ("pool-test.invalid".to_string(), vec![addr]);
        for _ in 0..3 {
            let client = chat_client(Some(&pinned)).unwrap();
            let body = client
                .get(format!("http://pool-test.invalid:{}/", addr.port()))
                .send()
                .await
                .unwrap()
                .text()
                .await
                .unwrap();
            assert_eq!(body, "ok");
        }
        assert_eq!(accepted.load(Ordering::SeqCst), 1, "later rounds must reuse the pooled connection");
    }
}
