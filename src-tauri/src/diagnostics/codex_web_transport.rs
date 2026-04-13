use crate::diagnostics::{current_diagnostics_dir, ensure_parent_dir};
use crate::orchestrator::store::unix_ms;
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;

const WEB_TRANSPORT_EVENTS_FILE: &str = "codex_web_transport_events.json";
const WEB_TRANSPORT_CACHE_TTL_MS: u64 = 5_000;

/// Module-level cache for web transport event snapshots.
/// Initialised lazily inside `current_web_transport_snapshot()` but placed here
/// so `record_web_transport_event` can update it after persisting.
static WEB_TRANSPORT_CACHE: OnceLock<RwLock<Option<(u64, WebTransportDomainSnapshot)>>> =
    OnceLock::new();

fn web_transport_cache() -> &'static RwLock<Option<(u64, WebTransportDomainSnapshot)>> {
    WEB_TRANSPORT_CACHE.get_or_init(|| RwLock::new(None))
}

#[cfg(test)]
fn reset_web_transport_cache_for_test() {
    if let Some(cache) = WEB_TRANSPORT_CACHE.get() {
        *cache.write() = None;
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct WebTransportDomainSnapshot {
    pub ws_open_observed: EventCount,
    pub ws_error_observed: EventCountWithDetail,
    pub ws_close_observed: EventCountWithCloseCode,
    pub ws_reconnect_scheduled: EventCount,
    pub ws_reconnect_attempted: EventCount,
    pub http_fallback_engaged: EventCountWithRoute,
    pub thread_refresh_failed: EventCount,
    pub active_thread_poll_failed: EventCount,
    pub live_notification_gap_observed: EventCount,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct EventCount {
    pub last_unix_ms: u64,
    pub count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct EventCountWithDetail {
    pub last_unix_ms: u64,
    pub count: u32,
    pub latest_detail: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct EventCountWithCloseCode {
    pub last_unix_ms: u64,
    pub count: u32,
    pub latest_close_code: Option<u16>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct EventCountWithRoute {
    pub last_unix_ms: u64,
    pub count: u32,
    pub latest_route: Option<String>,
}

fn default_snapshot() -> WebTransportDomainSnapshot {
    WebTransportDomainSnapshot::default()
}

fn load_web_transport_snapshot_uncached() -> WebTransportDomainSnapshot {
    let Some(dir) = current_diagnostics_dir() else {
        return default_snapshot();
    };
    let path = dir.join(WEB_TRANSPORT_EVENTS_FILE);
    let bytes = match std::fs::read(&path) {
        Ok(b) => b,
        Err(_) => return default_snapshot(),
    };
    serde_json::from_slice(&bytes).unwrap_or_else(|_| default_snapshot())
}

pub(crate) fn persist_web_transport_events(snapshot: &WebTransportDomainSnapshot) {
    let Some(dir) = current_diagnostics_dir() else {
        return;
    };
    let path = dir.join(WEB_TRANSPORT_EVENTS_FILE);
    if let Err(err) = ensure_parent_dir(&path) {
        log::warn!("failed to create diagnostics parent dir: {err}");
        return;
    }
    let payload = serde_json::to_value(snapshot).unwrap_or_default();
    if let Err(err) = crate::diagnostics::write_pretty_json(&path, &payload) {
        log::warn!("failed to persist web transport events: {err}");
    }
}

pub(crate) fn record_web_transport_event(event_type: &str, detail: Option<String>) {
    let now = unix_ms();
    let (updated, snapshot) = {
        let snapshot = current_web_transport_snapshot();
        let mut s = snapshot.clone();
        match event_type {
            "ws_open_observed" => {
                s.ws_open_observed.last_unix_ms = now;
                s.ws_open_observed.count += 1;
            }
            "ws_error_observed" => {
                s.ws_error_observed.last_unix_ms = now;
                s.ws_error_observed.count += 1;
                s.ws_error_observed.latest_detail = detail;
            }
            "ws_close_observed" => {
                s.ws_close_observed.last_unix_ms = now;
                s.ws_close_observed.count += 1;
                if let Some(d) = &detail {
                    s.ws_close_observed.latest_close_code = d.parse().ok();
                }
            }
            "ws_reconnect_scheduled" => {
                s.ws_reconnect_scheduled.last_unix_ms = now;
                s.ws_reconnect_scheduled.count += 1;
            }
            "ws_reconnect_attempted" => {
                s.ws_reconnect_attempted.last_unix_ms = now;
                s.ws_reconnect_attempted.count += 1;
            }
            "http_fallback_engaged" => {
                s.http_fallback_engaged.last_unix_ms = now;
                s.http_fallback_engaged.count += 1;
                s.http_fallback_engaged.latest_route = detail;
            }
            "thread_refresh_failed" => {
                s.thread_refresh_failed.last_unix_ms = now;
                s.thread_refresh_failed.count += 1;
            }
            "active_thread_poll_failed" => {
                s.active_thread_poll_failed.last_unix_ms = now;
                s.active_thread_poll_failed.count += 1;
            }
            "live_notification_gap_observed" => {
                s.live_notification_gap_observed.last_unix_ms = now;
                s.live_notification_gap_observed.count += 1;
            }
            _ => {
                log::warn!("unknown web transport event type: {event_type}");
                return;
            }
        }
        (true, s)
    };

    if updated {
        persist_web_transport_events(&snapshot);
        // Invalidate the in-memory cache so the next read picks up the persisted state.
        let cache = web_transport_cache();
        let mut guard = cache.write();
        *guard = Some((now, snapshot));
    }
}

pub(crate) fn current_web_transport_snapshot() -> WebTransportDomainSnapshot {
    let cache = web_transport_cache();
    let now = unix_ms();
    if let Some((captured_at, snapshot)) = cache.read().clone() {
        if now.saturating_sub(captured_at) < WEB_TRANSPORT_CACHE_TTL_MS {
            return snapshot;
        }
    }
    let snapshot = load_web_transport_snapshot_uncached();
    *cache.write() = Some((now, snapshot.clone()));
    snapshot
}

#[cfg(test)]
mod tests {
    use super::{
        current_web_transport_snapshot, default_snapshot, persist_web_transport_events,
        record_web_transport_event, reset_web_transport_cache_for_test,
    };
    use crate::diagnostics::set_test_user_data_dir_override;

    fn with_test_dir(f: impl FnOnce()) {
        let temp = tempfile::tempdir().expect("temp dir");
        let prev = set_test_user_data_dir_override(Some(temp.path()));
        // Reset the in-memory cache so each test starts with a clean slate.
        reset_web_transport_cache_for_test();
        f();
        set_test_user_data_dir_override(prev.as_deref());
    }

    #[test]
    fn record_increments_ws_open_count() {
        with_test_dir(|| {
            // First record increments from zero.
            record_web_transport_event("ws_open_observed", None);
            let snap = current_web_transport_snapshot();
            assert_eq!(snap.ws_open_observed.count, 1);
            assert!(snap.ws_open_observed.last_unix_ms > 0);

            // Second record increments to two.
            record_web_transport_event("ws_open_observed", None);
            let snap = current_web_transport_snapshot();
            assert_eq!(snap.ws_open_observed.count, 2);
        });
    }

    #[test]
    fn record_ws_error_stores_detail() {
        with_test_dir(|| {
            record_web_transport_event("ws_error_observed", Some("ECONNRESET".to_string()));
            let snap = current_web_transport_snapshot();
            assert_eq!(snap.ws_error_observed.count, 1);
            assert_eq!(
                snap.ws_error_observed.latest_detail.as_deref(),
                Some("ECONNRESET")
            );
        });
    }

    #[test]
    fn record_ws_close_extracts_close_code() {
        with_test_dir(|| {
            record_web_transport_event("ws_close_observed", Some("1001".to_string()));
            let snap = current_web_transport_snapshot();
            assert_eq!(snap.ws_close_observed.count, 1);
            assert_eq!(snap.ws_close_observed.latest_close_code, Some(1001));
        });
    }

    #[test]
    fn record_http_fallback_stores_route() {
        with_test_dir(|| {
            record_web_transport_event(
                "http_fallback_engaged",
                Some("/v1/threads/123".to_string()),
            );
            let snap = current_web_transport_snapshot();
            assert_eq!(snap.http_fallback_engaged.count, 1);
            assert_eq!(
                snap.http_fallback_engaged.latest_route.as_deref(),
                Some("/v1/threads/123")
            );
        });
    }

    #[test]
    fn snapshot_returns_correct_default_values() {
        let snap = default_snapshot();
        assert_eq!(snap.ws_open_observed.count, 0);
        assert_eq!(snap.ws_error_observed.count, 0);
        assert_eq!(snap.ws_error_observed.latest_detail, None);
        assert_eq!(snap.ws_close_observed.count, 0);
        assert_eq!(snap.ws_close_observed.latest_close_code, None);
        assert_eq!(snap.ws_reconnect_scheduled.count, 0);
        assert_eq!(snap.ws_reconnect_attempted.count, 0);
        assert_eq!(snap.http_fallback_engaged.count, 0);
        assert_eq!(snap.http_fallback_engaged.latest_route, None);
        assert_eq!(snap.thread_refresh_failed.count, 0);
        assert_eq!(snap.active_thread_poll_failed.count, 0);
        assert_eq!(snap.live_notification_gap_observed.count, 0);
    }

    #[test]
    fn persist_and_load_roundtrip() {
        with_test_dir(|| {
            let mut snap = default_snapshot();
            snap.ws_open_observed.count = 5;
            snap.ws_open_observed.last_unix_ms = 1_700_000_000_000;
            snap.ws_error_observed.count = 3;
            snap.ws_error_observed.latest_detail = Some("timeout".to_string());
            snap.ws_close_observed.count = 2;
            snap.ws_close_observed.latest_close_code = Some(1000);
            snap.http_fallback_engaged.count = 1;
            snap.http_fallback_engaged.latest_route = Some("/v1/models".to_string());

            persist_web_transport_events(&snap);

            let loaded = current_web_transport_snapshot();
            assert_eq!(loaded.ws_open_observed.count, 5);
            assert_eq!(loaded.ws_error_observed.count, 3);
            assert_eq!(
                loaded.ws_error_observed.latest_detail.as_deref(),
                Some("timeout")
            );
            assert_eq!(loaded.ws_close_observed.count, 2);
            assert_eq!(loaded.ws_close_observed.latest_close_code, Some(1000));
            assert_eq!(loaded.http_fallback_engaged.count, 1);
            assert_eq!(
                loaded.http_fallback_engaged.latest_route.as_deref(),
                Some("/v1/models")
            );
        });
    }

    #[test]
    fn unknown_event_type_does_not_panic() {
        with_test_dir(|| {
            // Should not panic and should not increment any counter.
            record_web_transport_event("unknown_event", Some("detail".to_string()));
            let snap = current_web_transport_snapshot();
            assert_eq!(snap.ws_open_observed.count, 0);
        });
    }
}
