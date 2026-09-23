//! Per-request cancellation registry shared by the desktop and web adapters.
//!
//! A single shared `AtomicBool` cannot describe two overlapping requests:
//! starting the second one reset the flag and silently revived the first, whose
//! events then leaked into the newer turn. Each request now owns its own flag,
//! addressed by the client-supplied request id, so Stop (or retry) only ever
//! cancels the stream it was meant for — concurrent requests stay independent.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

/// Every in-flight AI stream, keyed by the id the caller sent with the request.
#[derive(Default)]
pub struct AiRequests {
    inner: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl AiRequests {
    pub fn new() -> Self {
        Self::default()
    }

    /// Take ownership of `id` and hand back the guard whose flag its stream
    /// watches. Reusing an id supersedes the stream that held it before, so a
    /// caller cannot accidentally revive a stale request by re-registering.
    pub fn begin(self: &Arc<Self>, id: &str) -> RequestGuard {
        let flag = Arc::new(AtomicBool::new(false));
        {
            let mut live = self.live();
            if let Some(previous) = live.insert(id.to_string(), Arc::clone(&flag)) {
                previous.store(true, Ordering::SeqCst);
            }
        }
        RequestGuard {
            id: id.to_string(),
            flag,
            registry: Arc::clone(self),
        }
    }

    /// Cancel `id` and forget it. An empty id cancels every in-flight request —
    /// the compatibility path for callers that predate request identity.
    pub fn cancel(&self, id: &str) {
        let mut live = self.live();
        if id.is_empty() {
            for flag in live.values() {
                flag.store(true, Ordering::SeqCst);
            }
            live.clear();
            return;
        }
        if let Some(flag) = live.remove(id) {
            flag.store(true, Ordering::SeqCst);
        }
    }

    fn live(&self) -> std::sync::MutexGuard<'_, HashMap<String, Arc<AtomicBool>>> {
        // A panic while holding this lock cannot corrupt the map (the only
        // mutations are insert/remove of whole entries), so recover the guard
        // instead of poisoning cancellation for every later request.
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Retire `id` only if it still refers to `flag`: a request that finished
    /// after being cancelled must not evict a newer stream that reused the id.
    fn release(&self, id: &str, flag: &Arc<AtomicBool>) {
        let mut live = self.live();
        if live
            .get(id)
            .is_some_and(|current| Arc::ptr_eq(current, flag))
        {
            live.remove(id);
        }
    }
}

/// Owns one request's cancellation slot for as long as the request lives,
/// releasing it on drop — including the early returns in `ask_ai`.
pub struct RequestGuard {
    id: String,
    flag: Arc<AtomicBool>,
    registry: Arc<AiRequests>,
}

impl RequestGuard {
    /// The flag the streaming task polls between chunks.
    pub fn flag(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.flag)
    }
}

impl Drop for RequestGuard {
    fn drop(&mut self) {
        self.registry.release(&self.id, &self.flag);
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

        assert!(first.flag().load(Ordering::SeqCst));
        assert!(!second.flag().load(Ordering::SeqCst));
    }

    #[test]
    fn cancel_targets_only_the_named_request() {
        let requests = registry();
        let first = requests.begin("a");
        let second = requests.begin("b");

        requests.cancel("b");

        assert!(!first.flag().load(Ordering::SeqCst));
        assert!(second.flag().load(Ordering::SeqCst));
    }

    #[test]
    fn empty_id_cancels_everything() {
        let requests = registry();
        let first = requests.begin("a");
        let second = requests.begin("b");

        requests.cancel("");

        assert!(first.flag().load(Ordering::SeqCst));
        assert!(second.flag().load(Ordering::SeqCst));
        assert_eq!(requests.live().len(), 0);
    }

    #[test]
    fn reusing_an_id_supersedes_the_previous_owner() {
        let requests = registry();
        let stale = requests.begin("a");
        let fresh = requests.begin("a");

        assert!(stale.flag().load(Ordering::SeqCst));
        assert!(!fresh.flag().load(Ordering::SeqCst));
    }

    #[test]
    fn guard_drop_releases_only_its_own_slot() {
        let requests = registry();
        let stale = requests.begin("a");
        drop(stale);
        assert_eq!(requests.live().len(), 0);

        // A late drop of the cancelled original must not evict the replacement.
        let cancelled = requests.begin("a");
        requests.cancel("a");
        let replacement = requests.begin("a");
        drop(cancelled);
        assert_eq!(requests.live().len(), 1);
        requests.cancel("a");
        assert!(replacement.flag().load(Ordering::SeqCst));
    }
}
