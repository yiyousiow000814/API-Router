use crate::orchestrator::gateway::ClientSessionRuntime;
use serde_json::json;
use std::collections::HashSet;

struct SessionRetentionDecision {
    keep: bool,
    drop_reason: Option<&'static str>,
}

pub(crate) fn retain_live_app_server_sessions(
    map: &mut std::collections::HashMap<String, ClientSessionRuntime>,
    now: u64,
    snapshot_items: &[serde_json::Value],
    snapshot_is_fresh: bool,
) -> Vec<String> {
    let snapshot_session_ids: HashSet<String> = snapshot_items
        .iter()
        .filter_map(|item| super::thread_index_merge::thread_item_string_field(item, "id"))
        .collect();
    let mut removed_main_sessions = Vec::new();
    let mut removed_main_session_details = Vec::new();
    map.retain(|_, entry| {
        let decision = evaluate_runtime_session_retention(
            entry,
            now,
            crate::platform::windows_terminal::is_pid_alive,
            crate::platform::windows_terminal::is_wt_session_alive,
            snapshot_session_ids.contains(&entry.codex_session_id),
            0,
            snapshot_is_fresh,
        );
        if !(decision.keep || entry.is_agent || entry.is_review) {
            removed_main_sessions.push(entry.codex_session_id.clone());
            removed_main_session_details.push(json!({
                "id": entry.codex_session_id,
                "dropReason": decision.drop_reason.unwrap_or("unknown"),
                "wtSession": entry.wt_session,
                "pid": entry.pid,
                "lastRequestUnixMs": entry.last_request_unix_ms,
                "lastDiscoveredUnixMs": entry.last_discovered_unix_ms,
                "lastSeenUnixMs": session_last_seen_unix_ms(entry),
                "confirmedRouter": entry.confirmed_router,
                "presentInAppServerSnapshot": snapshot_session_ids.contains(&entry.codex_session_id),
                "snapshotFresh": snapshot_is_fresh,
                "rolloutPath": entry.rollout_path,
            }));
        }
        decision.keep
    });
    if !removed_main_session_details.is_empty() {
        let _ = crate::orchestrator::gateway::web_codex_storage::append_codex_live_trace_entry(
            &json!({
                "source": "status.session_retention",
                "entry": {
                    "at": now,
                    "kind": "status.session_retention.removed_main_sessions",
                    "count": removed_main_session_details.len(),
                    "sessions": removed_main_session_details,
                }
            }),
        );
    }
    removed_main_sessions
}

pub(crate) fn session_is_active(entry: &ClientSessionRuntime, now: u64) -> bool {
    entry.last_request_unix_ms > 0 && now.saturating_sub(entry.last_request_unix_ms) < 60_000
}

pub(crate) fn session_last_seen_unix_ms(entry: &ClientSessionRuntime) -> u64 {
    entry
        .last_request_unix_ms
        .max(entry.last_discovered_unix_ms)
}

#[allow(dead_code)]
pub(crate) fn should_keep_runtime_session(
    entry: &ClientSessionRuntime,
    now: u64,
    is_pid_alive: fn(u32) -> bool,
    is_wt_session_alive: fn(&str) -> bool,
    present_in_app_server_snapshot: bool,
    _wsl_discovery_miss_count: u8,
    discovery_is_fresh: bool,
) -> bool {
    evaluate_runtime_session_retention(
        entry,
        now,
        is_pid_alive,
        is_wt_session_alive,
        present_in_app_server_snapshot,
        _wsl_discovery_miss_count,
        discovery_is_fresh,
    )
    .keep
}

fn evaluate_runtime_session_retention(
    entry: &ClientSessionRuntime,
    now: u64,
    is_pid_alive: fn(u32) -> bool,
    is_wt_session_alive: fn(&str) -> bool,
    present_in_app_server_snapshot: bool,
    _wsl_discovery_miss_count: u8,
    discovery_is_fresh: bool,
) -> SessionRetentionDecision {
    const PIDLESS_DESKTOP_LIVE_MAX_STALE_MS: u64 = 60 * 1000;

    let active = session_is_active(entry, now);
    if entry.pid != 0 && !is_pid_alive(entry.pid) {
        return SessionRetentionDecision {
            keep: false,
            drop_reason: Some("pid_not_alive"),
        };
    }
    if entry.is_review {
        return SessionRetentionDecision {
            keep: active,
            drop_reason: (!active).then_some("review_idle_timeout"),
        };
    }
    if entry.is_agent {
        return SessionRetentionDecision {
            keep: active,
            drop_reason: (!active).then_some("agent_idle_hidden"),
        };
    }
    if entry.pid == 0 {
        let wt = entry.wt_session.as_deref().unwrap_or_default().trim();
        if !wt.is_empty() {
            if discovery_is_fresh && !is_wt_session_alive(wt) {
                return SessionRetentionDecision {
                    keep: false,
                    drop_reason: Some("wt_session_not_alive"),
                };
            }
            return SessionRetentionDecision {
                keep: true,
                drop_reason: None,
            };
        }
        if present_in_app_server_snapshot {
            return SessionRetentionDecision {
                keep: true,
                drop_reason: None,
            };
        }
        if !discovery_is_fresh {
            return SessionRetentionDecision {
                keep: true,
                drop_reason: None,
            };
        }
        let last_seen = session_last_seen_unix_ms(entry);
        let keep =
            last_seen != 0 && now.saturating_sub(last_seen) <= PIDLESS_DESKTOP_LIVE_MAX_STALE_MS;
        return SessionRetentionDecision {
            keep,
            drop_reason: (!keep).then_some("pidless_main_absent_from_app_server_and_stale"),
        };
    }
    SessionRetentionDecision {
        keep: true,
        drop_reason: None,
    }
}
