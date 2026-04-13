use crate::orchestrator::gateway::ClientSessionRuntime;
use serde_json::json;
use std::collections::HashSet;

struct SessionRetentionDecision {
    keep: bool,
    drop_reason: Option<&'static str>,
}

#[derive(Clone, Copy)]
struct SessionRetentionSources {
    present_in_terminal_snapshot: bool,
    terminal_snapshot_is_fresh: bool,
    present_in_app_server_snapshot: bool,
    discovery_is_fresh: bool,
}

pub(crate) fn retain_live_app_server_sessions(
    map: &mut std::collections::HashMap<String, ClientSessionRuntime>,
    now: u64,
    terminal_snapshot_items: &[crate::platform::windows_terminal::InferredWtSession],
    terminal_snapshot_is_fresh: bool,
    snapshot_items: &[serde_json::Value],
    snapshot_is_fresh: bool,
) -> Vec<String> {
    let terminal_live_session_ids: HashSet<String> = terminal_snapshot_items
        .iter()
        .filter_map(|item| item.codex_session_id.clone())
        .collect();
    let terminal_live_wt_sessions: HashSet<String> = terminal_snapshot_items
        .iter()
        .filter_map(|item| normalized_wt_session_key(&item.wt_session))
        .collect();
    let snapshot_live_session_ids: HashSet<String> = snapshot_items
        .iter()
        .filter(|item| super::thread_index_merge::thread_item_is_live_presence(item))
        .filter_map(|item| super::thread_index_merge::thread_item_string_field(item, "id"))
        .collect();
    let mut removed_main_sessions = Vec::new();
    let mut removed_main_session_details = Vec::new();
    map.retain(|_, entry| {
        let present_in_terminal_snapshot =
            terminal_session_present(entry, &terminal_live_session_ids, &terminal_live_wt_sessions);
        let decision = evaluate_runtime_session_retention(
            entry,
            now,
            crate::platform::windows_terminal::is_pid_alive,
            SessionRetentionSources {
                present_in_terminal_snapshot,
                terminal_snapshot_is_fresh,
                present_in_app_server_snapshot: snapshot_live_session_ids
                    .contains(&entry.codex_session_id),
                discovery_is_fresh: snapshot_is_fresh,
            },
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
                "presentInFreshTerminalSnapshot": present_in_terminal_snapshot,
                "terminalSnapshotFresh": terminal_snapshot_is_fresh,
                "presentInLiveAppServerSnapshot": snapshot_live_session_ids.contains(&entry.codex_session_id),
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
    let present_in_terminal_snapshot = entry
        .wt_session
        .as_deref()
        .map(str::trim)
        .is_some_and(|wt| !wt.is_empty() && is_wt_session_alive(wt));
    evaluate_runtime_session_retention(
        entry,
        now,
        is_pid_alive,
        SessionRetentionSources {
            present_in_terminal_snapshot,
            terminal_snapshot_is_fresh: discovery_is_fresh,
            present_in_app_server_snapshot,
            discovery_is_fresh,
        },
    )
    .keep
}

fn evaluate_runtime_session_retention(
    entry: &ClientSessionRuntime,
    now: u64,
    is_pid_alive: fn(u32) -> bool,
    sources: SessionRetentionSources,
) -> SessionRetentionDecision {
    const PIDLESS_DESKTOP_LIVE_MAX_STALE_MS: u64 = 60 * 1000;
    const PIDLESS_WSL_GATEWAY_HEARTBEAT_MAX_STALE_MS: u64 = 60 * 1000;

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
            if sources.terminal_snapshot_is_fresh && !sources.present_in_terminal_snapshot {
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
        if sources.present_in_app_server_snapshot {
            return SessionRetentionDecision {
                keep: true,
                drop_reason: None,
            };
        }
        if runtime_session_is_wsl(entry) {
            if !sources.discovery_is_fresh {
                return SessionRetentionDecision {
                    keep: true,
                    drop_reason: None,
                };
            }
            let keep = entry.last_request_unix_ms != 0
                && now.saturating_sub(entry.last_request_unix_ms)
                    <= PIDLESS_WSL_GATEWAY_HEARTBEAT_MAX_STALE_MS;
            return SessionRetentionDecision {
                keep,
                drop_reason: (!keep).then_some("wsl_pidless_missing_recent_gateway_heartbeat"),
            };
        }
        if !sources.discovery_is_fresh {
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

fn runtime_session_is_wsl(entry: &ClientSessionRuntime) -> bool {
    if entry
        .wt_session
        .as_deref()
        .map(str::trim)
        .is_some_and(|wt| wt.to_ascii_lowercase().starts_with("wsl:"))
    {
        return true;
    }
    entry.rollout_path.as_deref().is_some_and(|path| {
        let normalized = path.trim().replace('/', "\\").to_ascii_lowercase();
        normalized.starts_with(r"\\wsl.localhost\")
            || normalized.starts_with(r"\\wsl$\")
            || normalized.starts_with(r"\home\")
    })
}

fn terminal_session_present(
    entry: &ClientSessionRuntime,
    live_session_ids: &HashSet<String>,
    live_wt_sessions: &HashSet<String>,
) -> bool {
    if live_session_ids.contains(&entry.codex_session_id) {
        return true;
    }
    entry
        .wt_session
        .as_deref()
        .and_then(normalized_wt_session_key)
        .is_some_and(|wt| live_wt_sessions.contains(&wt))
}

fn normalized_wt_session_key(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let normalized = trimmed
        .trim_start_matches("wsl:")
        .trim_start_matches("WSL:")
        .trim();
    (!normalized.is_empty()).then(|| normalized.to_ascii_lowercase())
}
