//! Per-request cancellation registry shared by the desktop and web adapters.
//!
//! A single shared `AtomicBool` cannot describe two overlapping requests:
//! starting the second one reset the flag and silently revived the first, whose
//! events then leaked into the newer turn. Each request now owns its own token,
//! addressed by the client-supplied request id, so Stop (or retry) only ever
//! cancels the stream it was meant for — concurrent requests stay independent.
//!
//! A Stop can also overtake its own request: the frontend mints the id, sends
//! `ask_ai`, and a Stop sent right after may reach the backend while `ask_ai`
//! is still reading the API key. A cancelled id is therefore remembered for a
//! while ([`Tombstones`]) and a request that begins under it starts cancelled
//! instead of streaming a turn nobody is listening to any more.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::Notify;

/// How long a cancelled request id stays cancelled.
const TOMBSTONE_TTL: Duration = Duration::from_secs(120);
/// Upper bound on remembered cancelled ids; the oldest is forgotten first.
const MAX_TOMBSTONES: usize = 1024;

/// Cancellation state of one request: a flag the hot path can read without
/// awaiting, plus a wakeup so a task parked on I/O notices Stop immediately
/// instead of on the next poll tick.
#[derive(Debug, Default)]
pub struct CancelToken {
    flag: AtomicBool,
    notify: Notify,
}

impl CancelToken {
    pub fn new() -> Self {
        Self::default()
    }

    /// A token that is cancelled from the start.
    pub fn cancelled_token() -> Self {
        let token = Self::default();
        token.flag.store(true, Ordering::SeqCst);
        token
    }

    pub fn cancel(&self) {
        self.flag.store(true, Ordering::SeqCst);
        self.notify.notify_waiters();
    }

    pub fn is_cancelled(&self) -> bool {
        self.flag.load(Ordering::SeqCst)
    }

    /// Resolve once the token is cancelled.
    pub async fn cancelled(&self) {
        loop {
            let notified = self.notify.notified();
            tokio::pin!(notified);
            // Register as a waiter before reading the flag: a `cancel` between
            // the read and the await would otherwise wake nobody.
            notified.as_mut().enable();
            if self.is_cancelled() {
                return;
            }
            notified.await;
        }
    }
}

/// Request ids cancelled recently, so a request that starts after its own Stop
/// starts cancelled. Ids are minted per request and never legitimately reused
/// after a Stop, so remembering them cannot cancel an unrelated request.
#[derive(Default)]
pub struct Tombstones {
    entries: VecDeque<(String, Instant)>,
}

impl Tombstones {
    pub fn insert(&mut self, id: &str) {
        self.evict_expired();
        if self.entries.iter().any(|(entry, _)| entry == id) {
            return;
        }
        if self.entries.len() >= MAX_TOMBSTONES {
            self.entries.pop_front();
        }
        self.entries.push_back((id.to_string(), Instant::now()));
    }

    pub fn contains(&mut self, id: &str) -> bool {
        self.evict_expired();
        self.entries.iter().any(|(entry, _)| entry == id)
    }

    fn evict_expired(&mut self) {
        while self
            .entries
            .front()
            .is_some_and(|(_, at)| at.elapsed() > TOMBSTONE_TTL)
        {
            self.entries.pop_front();
        }
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.entries.len()
    }
}

#[derive(Default)]
struct Registry {
    live: HashMap<String, Arc<CancelToken>>,
    cancelled: Tombstones,
}

/// Every in-flight AI stream, keyed by the id the caller sent with the request.
#[derive(Default)]
pub struct AiRequests {
    inner: Mutex<Registry>,
}

impl AiRequests {
    pub fn new() -> Self {
        Self::default()
    }

    /// Take ownership of `id` and hand back the guard whose token its stream
    /// watches. Reusing an id supersedes the stream that held it before, so a
    /// caller cannot accidentally revive a stale request by re-registering. An
    /// id that was cancelled before it began starts cancelled.
    pub fn begin(self: &Arc<Self>, id: &str) -> RequestGuard {
        let token = {
            let mut registry = self.registry();
            let token = if !id.is_empty() && registry.cancelled.contains(id) {
                Arc::new(CancelToken::cancelled_token())
            } else {
                Arc::new(CancelToken::new())
            };
            if let Some(previous) = registry.live.insert(id.to_string(), Arc::clone(&token)) {
                previous.cancel();
            }
            token
        };
        RequestGuard {
            id: id.to_string(),
            token,
            registry: Arc::clone(self),
        }
    }

    /// Cancel `id` and forget it. An empty id cancels every in-flight request —
    /// the compatibility path for callers that predate request identity.
    pub fn cancel(&self, id: &str) {
        let mut registry = self.registry();
        if id.is_empty() {
            for token in registry.live.values() {
                token.cancel();
            }
            registry.live.clear();
            return;
        }
        registry.cancelled.insert(id);
        if let Some(token) = registry.live.remove(id) {
            token.cancel();
        }
    }

    fn registry(&self) -> std::sync::MutexGuard<'_, Registry> {
        // A panic while holding this lock cannot corrupt the map (the only
        // mutations are insert/remove of whole entries), so recover the guard
        // instead of poisoning cancellation for every later request.
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Retire `id` only if it still refers to `token`: a request that finished
    /// after being cancelled must not evict a newer stream that reused the id.
    fn release(&self, id: &str, token: &Arc<CancelToken>) {
        let mut registry = self.registry();
        if registry
            .live
            .get(id)
            .is_some_and(|current| Arc::ptr_eq(current, token))
        {
            registry.live.remove(id);
        }
    }
}

/// Owns one request's cancellation slot for as long as the request lives,
/// releasing it on drop — including the early returns in `ask_ai`.
pub struct RequestGuard {
    id: String,
    token: Arc<CancelToken>,
    registry: Arc<AiRequests>,
}

impl RequestGuard {
    /// The token the streaming task watches.
    pub fn token(&self) -> Arc<CancelToken> {
        Arc::clone(&self.token)
    }

    pub fn is_cancelled(&self) -> bool {
        self.token.is_cancelled()
    }
}

impl Drop for RequestGuard {
    fn drop(&mut self) {
        self.registry.release(&self.id, &self.token);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn registry() -> Arc<AiRequests> {
        Arc::new(AiRequests::new())
    }

    #[test]
    fn cancelling_one_request_leaves_its_neighbour_running() {
        // The regression: a shared flag meant the first Stop reset the second
        // request's cancellation state, so an old stream kept emitting into the
        // newer turn.
        let requests = registry();
        let first = requests.begin("a");
        let second = requests.begin("b");

        requests.cancel("a");

        assert!(first.is_cancelled());
        assert!(!second.is_cancelled());
    }

    #[test]
    fn cancel_targets_only_the_named_request() {
        let requests = registry();
        let first = requests.begin("a");
        let second = requests.begin("b");

        requests.cancel("b");

        assert!(!first.is_cancelled());
        assert!(second.is_cancelled());
    }

    #[test]
    fn empty_id_cancels_everything() {
        let requests = registry();
        let first = requests.begin("a");
        let second = requests.begin("b");

        requests.cancel("");

        assert!(first.is_cancelled());
        assert!(second.is_cancelled());
        assert_eq!(requests.registry().live.len(), 0);
    }

    #[test]
    fn reusing_an_id_supersedes_the_previous_owner() {
        let requests = registry();
        let stale = requests.begin("a");
        let fresh = requests.begin("a");

        assert!(stale.is_cancelled());
        assert!(!fresh.is_cancelled());
    }

    #[test]
    fn guard_drop_releases_only_its_own_slot() {
        let requests = registry();
        let stale = requests.begin("a");
        drop(stale);
        assert_eq!(requests.registry().live.len(), 0);

        // A late drop of the superseded original must not evict the replacement.
        let superseded = requests.begin("b");
        let replacement = requests.begin("b");
        drop(superseded);
        assert_eq!(requests.registry().live.len(), 1);
        requests.cancel("b");
        assert!(replacement.is_cancelled());
    }

    #[test]
    fn a_stop_that_overtakes_its_request_still_cancels_it() {
        // The frontend can send Stop while `ask_ai` is still resolving its key,
        // before the request registered; the Stop must not be lost.
        let requests = registry();
        requests.cancel("early");
        let guard = requests.begin("early");
        assert!(guard.is_cancelled());
        // Other ids are unaffected.
        assert!(!requests.begin("other").is_cancelled());
    }

    #[test]
    fn tombstones_are_bounded() {
        let mut tombstones = Tombstones::default();
        for index in 0..MAX_TOMBSTONES + 10 {
            tombstones.insert(&format!("id-{index}"));
        }
        assert_eq!(tombstones.len(), MAX_TOMBSTONES);
        assert!(!tombstones.contains("id-0"));
        assert!(tombstones.contains(&format!("id-{}", MAX_TOMBSTONES + 9)));
    }

    #[tokio::test]
    async fn cancelled_wakes_a_parked_waiter() {
        let token = Arc::new(CancelToken::new());
        let waiter = tokio::spawn({
            let token = Arc::clone(&token);
            async move { token.cancelled().await }
        });
        tokio::task::yield_now().await;
        token.cancel();
        tokio::time::timeout(Duration::from_secs(1), waiter)
            .await
            .expect("cancel must wake the waiter without polling")
            .unwrap();
        // Already-cancelled tokens resolve immediately.
        tokio::time::timeout(Duration::from_millis(50), token.cancelled())
            .await
            .unwrap();
    }
}
