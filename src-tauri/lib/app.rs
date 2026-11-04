//! App lifecycle commands — graceful shutdown handshake and health/diagnostics.

use tauri::{Manager, State};
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};
use crate::AppState;

/** How long a close request may stay unacknowledged before the next one is let
 *  through. A live frontend acknowledges within milliseconds. */
pub(crate) const CLOSE_ACK_TIMEOUT: Duration = Duration::from_secs(3);

/** What the window knows about the close in flight. */
#[derive(Default)]
pub(crate) struct CloseGate {
    /** When the first unanswered close was held. */
    requested: Option<Instant>,
    /** The frontend picked the request up and is asking or saving. */
    acked: bool,
}

impl CloseGate {
    /** Decide a `CloseRequested`: true lets the window close. A confirmed close
     *  always goes through. An acknowledged one is held, however long the prompt
     *  or save takes. An unacknowledged one is held until `timeout` has passed
     *  since it was first held, so a crashed or frozen frontend cannot trap the
     *  window the way an always-held close would. */
    pub(crate) fn allows(&mut self, confirmed: bool, now: Instant, timeout: Duration) -> bool {
        if confirmed {
            return true;
        }
        if self.acked {
            return false;
        }
        match self.requested {
            Some(at) if now.duration_since(at) >= timeout => {
                *self = CloseGate::default();
                true
            }
            Some(_) => false,
            None => {
                self.requested = Some(now);
                false
            }
        }
    }

    pub(crate) fn ack(&mut self) {
        self.acked = true;
    }

    pub(crate) fn reset(&mut self) {
        *self = CloseGate::default();
    }
}

/** Frontend confirms it saved everything — safe to actually close. */
#[tauri::command]
pub fn app_ready_to_close(app: tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    state.closing.store(true, Ordering::SeqCst);
    if let Some(w) = app.get_webview_window("main") {
        w.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/** Frontend picked up `app:before-close` and is now asking or saving: hold
 *  further close requests until it confirms or cancels. */
#[tauri::command]
pub fn app_close_ack(state: State<AppState>) {
    state.close_gate.lock().expect("lock").ack();
}

/** Frontend decided to stay open after `app_ready_to_close` had already been
 *  accepted but the window did not close. Clear the confirmation, so the next
 *  window close raises `app:before-close` again instead of slipping through. */
#[tauri::command]
pub fn app_cancel_close(state: State<AppState>) {
    state.closing.store(false, Ordering::SeqCst);
    state.close_gate.lock().expect("lock").reset();
}

/** Minimal health/diagnostics surface (reused by the future cloud service). */
#[tauri::command]
pub fn health(state: State<AppState>) -> Result<String, String> {
    let vault_open = state.vault.lock().expect("lock").is_some();
    let git_repo = state.git.lock().expect("lock").as_ref().map(|g| g.is_repo()).unwrap_or(false);
    Ok(serde_json::json!({
        "version": env!("CARGO_PKG_VERSION"),
        "vaultOpen": vault_open,
        "gitRepo": git_repo,
    }).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const T: Duration = Duration::from_secs(3);

    #[test]
    fn confirmed_close_always_goes_through() {
        let mut gate = CloseGate::default();
        gate.ack();
        assert!(gate.allows(true, Instant::now(), T));
    }

    #[test]
    fn first_close_is_held() {
        let mut gate = CloseGate::default();
        assert!(!gate.allows(false, Instant::now(), T));
    }

    #[test]
    fn acknowledged_close_is_held_past_the_timeout() {
        let mut gate = CloseGate::default();
        let t0 = Instant::now();
        assert!(!gate.allows(false, t0, T));
        gate.ack();
        assert!(!gate.allows(false, t0 + T * 10, T));
    }

    #[test]
    fn unacknowledged_close_is_held_inside_the_timeout() {
        let mut gate = CloseGate::default();
        let t0 = Instant::now();
        assert!(!gate.allows(false, t0, T));
        assert!(!gate.allows(false, t0 + T / 2, T));
    }

    #[test]
    fn unacknowledged_close_goes_through_after_the_timeout() {
        let mut gate = CloseGate::default();
        let t0 = Instant::now();
        assert!(!gate.allows(false, t0, T));
        assert!(gate.allows(false, t0 + T, T));
    }

    #[test]
    fn cancel_clears_the_request_and_the_ack() {
        let mut gate = CloseGate::default();
        let t0 = Instant::now();
        assert!(!gate.allows(false, t0, T));
        gate.ack();
        gate.reset();
        // A fresh request: held, then timed out on its own clock.
        assert!(!gate.allows(false, t0 + T * 10, T));
        assert!(!gate.allows(false, t0 + T * 10 + T / 2, T));
        assert!(gate.allows(false, t0 + T * 11, T));
    }
}
