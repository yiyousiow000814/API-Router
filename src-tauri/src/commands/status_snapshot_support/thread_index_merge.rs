use crate::orchestrator::gateway::ClientSessionRuntime;
use serde_json::json;

pub(crate) fn thread_item_string_field(item: &serde_json::Value, key: &str) -> Option<String> {
    item.get(key)
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

pub(crate) fn thread_item_bool_field(item: &serde_json::Value, key: &str) -> bool {
    item.get(key)
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false)
}

pub(crate) fn thread_item_parent_session_id(item: &serde_json::Value) -> Option<String> {
    for key in [
        "parentThreadId",
        "parent_thread_id",
        "agentParentSessionId",
        "agent_parent_session_id",
    ] {
        if let Some(value) = thread_item_string_field(item, key) {
            return Some(value);
        }
    }
    item.get("source")
        .and_then(serde_json::Value::as_object)
        .and_then(|source| source.get("subagent").or_else(|| source.get("subAgent")))
        .and_then(serde_json::Value::as_object)
        .and_then(|subagent| {
            subagent
                .get("thread_spawn")
                .or_else(|| subagent.get("threadSpawn"))
        })
        .and_then(serde_json::Value::as_object)
        .and_then(|spawn| {
            spawn
                .get("parent_thread_id")
                .or_else(|| spawn.get("parentThreadId"))
        })
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

pub(crate) fn thread_item_status_type(item: &serde_json::Value) -> Option<String> {
    item.get("status")
        .and_then(serde_json::Value::as_object)
        .and_then(|status| status.get("type"))
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

pub(crate) fn thread_item_base_url(item: &serde_json::Value) -> Option<String> {
    for key in ["base_url", "baseUrl", "model_provider_base_url"] {
        if let Some(value) = thread_item_string_field(item, key) {
            return Some(value);
        }
    }
    None
}

pub(crate) fn thread_item_updated_unix_ms(item: &serde_json::Value) -> u64 {
    let raw = item
        .get("updatedAt")
        .and_then(serde_json::Value::as_i64)
        .unwrap_or(0);
    if raw <= 0 {
        return 0;
    }
    let normalized = if raw >= 1_000_000_000_000 {
        raw
    } else {
        raw.saturating_mul(1000)
    };
    u64::try_from(normalized).unwrap_or(0)
}

pub(crate) fn thread_item_is_live_presence(item: &serde_json::Value) -> bool {
    matches!(
        thread_item_status_type(item).as_deref(),
        Some("running") | Some("queued") | Some("pending") | Some("reconnecting")
    )
}

pub(crate) fn next_last_discovered_unix_ms(prev: u64, now: u64, discovery_is_fresh: bool) -> u64 {
    if discovery_is_fresh {
        return now;
    }
    prev
}

struct NotLoadedRefreshTrace<'a> {
    session_id: &'a str,
    entry: &'a ClientSessionRuntime,
    updated_unix_ms: u64,
    now: u64,
    live_presence: bool,
    should_promote_not_loaded_to_now: bool,
    previous_last_discovered_unix_ms: u64,
    rollout_path: Option<&'a str>,
}

fn trace_not_loaded_session_promotion(trace: NotLoadedRefreshTrace<'_>) {
    let _ =
        crate::orchestrator::gateway::web_codex_storage::append_codex_live_trace_entry(&json!({
            "source": "status.thread_index_merge",
            "entry": {
                "at": crate::orchestrator::store::unix_ms(),
                "kind": "status.thread_index_merge.not_loaded_refresh",
                "sessionId": trace.session_id,
                "livePresence": trace.live_presence,
                "shouldPromoteNotLoadedToNow": trace.should_promote_not_loaded_to_now,
                "updatedUnixMs": trace.updated_unix_ms,
                "nowUnixMs": trace.now,
                "previousLastDiscoveredUnixMs": trace.previous_last_discovered_unix_ms,
                "nextLastDiscoveredUnixMs": trace.entry.last_discovered_unix_ms,
                "lastRequestUnixMs": trace.entry.last_request_unix_ms,
                "confirmedRouter": trace.entry.confirmed_router,
                "isAgent": trace.entry.is_agent,
                "isReview": trace.entry.is_review,
                "parentSessionId": trace.entry.agent_parent_session_id,
                "rolloutPath": trace.rollout_path,
            }
        }));
}

pub(crate) fn merge_thread_index_session_hints(
    map: &mut std::collections::HashMap<String, ClientSessionRuntime>,
    now: u64,
    items: &[serde_json::Value],
    snapshot_is_fresh: bool,
) {
    for item in items {
        let Some(session_id) = thread_item_string_field(item, "id") else {
            continue;
        };
        let rollout_path = thread_item_string_field(item, "path");
        let entry_already_exists = map.contains_key(&session_id);
        if rollout_path.is_none() && !entry_already_exists {
            continue;
        }
        let live_presence = snapshot_is_fresh && thread_item_is_live_presence(item);
        if !entry_already_exists && !live_presence {
            continue;
        }
        let entry = map
            .entry(session_id.clone())
            .or_insert_with(|| ClientSessionRuntime {
                codex_session_id: session_id.clone(),
                pid: 0,
                wt_session: None,
                last_request_unix_ms: 0,
                last_discovered_unix_ms: 0,
                last_reported_model_provider: None,
                last_reported_model: None,
                last_reported_base_url: None,
                rollout_path: None,
                agent_parent_session_id: None,
                is_agent: false,
                is_review: false,
                confirmed_router: false,
            });
        let updated_unix_ms = thread_item_updated_unix_ms(item);
        let should_refresh_discovery = snapshot_is_fresh;
        if let Some(rollout_path) = rollout_path.as_deref() {
            entry.rollout_path = Some(rollout_path.to_string());
        }
        if let Some(model_provider) = thread_item_string_field(item, "modelProvider") {
            super::super::merge_discovered_model_provider(entry, Some(model_provider.as_str()));
        }
        if let Some(model) = thread_item_string_field(item, "model") {
            entry.last_reported_model = Some(model);
        }
        if let Some(base_url) = thread_item_base_url(item) {
            entry.last_reported_base_url = Some(base_url);
        }
        if let Some(parent_sid) = thread_item_parent_session_id(item) {
            entry.agent_parent_session_id = Some(parent_sid);
        }
        if thread_item_bool_field(item, "isSubagent") {
            entry.is_agent = true;
        }
        if matches!(
            thread_item_string_field(item, "agentRole").as_deref(),
            Some("review")
        ) {
            entry.is_review = true;
            entry.is_agent = true;
        }
        if should_refresh_discovery {
            let previous_last_discovered_unix_ms = entry.last_discovered_unix_ms;
            let observed_unix_ms = if live_presence {
                updated_unix_ms.max(now)
            } else if updated_unix_ms > 0 {
                updated_unix_ms
            } else {
                entry.last_discovered_unix_ms
            };
            if observed_unix_ms > 0 {
                entry.last_discovered_unix_ms = next_last_discovered_unix_ms(
                    entry.last_discovered_unix_ms,
                    observed_unix_ms,
                    true,
                );
                if !live_presence {
                    trace_not_loaded_session_promotion(NotLoadedRefreshTrace {
                        session_id: &session_id,
                        entry,
                        updated_unix_ms,
                        now,
                        live_presence,
                        should_promote_not_loaded_to_now: false,
                        previous_last_discovered_unix_ms,
                        rollout_path: rollout_path.as_deref(),
                    });
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn merge_thread_index_session_hints_preserves_subagent_parent_context_for_live_thread() {
        let mut map = HashMap::new();

        merge_thread_index_session_hints(
            &mut map,
            2_000_000,
            &[serde_json::json!({
                "id": "agent-thread",
                "path": "C:\\Users\\yiyou\\.codex\\sessions\\2026\\04\\12\\rollout-agent-thread.jsonl",
                "status": { "type": "running" },
                "updatedAt": 1742269999,
                "isSubagent": true,
                "agent_parent_session_id": "main-thread",
                "agentRole": "explorer"
            })],
            true,
        );

        let entry = map.get("agent-thread").expect("agent thread entry");
        assert!(
            entry.is_agent,
            "subagent thread should remain marked as agent"
        );
        assert!(
            !entry.is_review,
            "explorer agent should not be promoted to review"
        );
        assert_eq!(
            entry.agent_parent_session_id.as_deref(),
            Some("main-thread"),
            "parent session context should survive thread-index merge"
        );
        assert_eq!(
            entry.rollout_path.as_deref(),
            Some("C:\\Users\\yiyou\\.codex\\sessions\\2026\\04\\12\\rollout-agent-thread.jsonl")
        );
    }

    #[test]
    fn merge_thread_index_does_not_create_runtime_entry_for_first_seen_not_loaded_main() {
        let mut map = HashMap::new();

        merge_thread_index_session_hints(
            &mut map,
            2_000_000,
            &[serde_json::json!({
                "id": "old-main-thread",
                "path": "C:\\Users\\yiyou\\.codex\\sessions\\2026\\03\\14\\rollout-old-main-thread.jsonl",
                "status": { "type": "notLoaded" },
                "updatedAt": 1_742_269_999,
            })],
            true,
        );

        assert!(
            !map.contains_key("old-main-thread"),
            "historical notLoaded main thread should not be promoted into the runtime session map"
        );
    }

    #[test]
    fn merge_thread_index_does_not_create_runtime_entry_for_first_seen_not_loaded_subagent() {
        let mut map = HashMap::new();

        merge_thread_index_session_hints(
            &mut map,
            2_000_000,
            &[serde_json::json!({
                "id": "old-agent-thread",
                "path": "C:\\Users\\yiyou\\.codex\\sessions\\2026\\03\\14\\rollout-old-agent-thread.jsonl",
                "status": { "type": "notLoaded" },
                "updatedAt": 1_742_269_999,
                "isSubagent": true,
                "agent_parent_session_id": "main-thread",
                "agentRole": "explorer"
            })],
            true,
        );

        assert!(
            !map.contains_key("old-agent-thread"),
            "historical notLoaded subagent should not be promoted into the runtime session map"
        );
    }

    #[test]
    fn system_error_thread_is_not_treated_as_live_presence() {
        assert!(
            !thread_item_is_live_presence(&serde_json::json!({
                "id": "thread-system-error",
                "status": { "type": "systemError" }
            })),
            "systemError thread snapshots must not be treated as live runtime evidence"
        );
    }

    #[test]
    fn merge_thread_index_system_error_does_not_refresh_existing_runtime_session_to_now() {
        let now = 1_800_000_000_000_u64;
        let previous_last_discovered = now.saturating_sub(10 * 60 * 1000);
        let system_error_updated_at = now.saturating_sub(5 * 60 * 1000);
        let mut map = HashMap::from([(
            "thread-system-error".to_string(),
            ClientSessionRuntime {
                codex_session_id: "thread-system-error".to_string(),
                pid: 0,
                wt_session: Some("wt-thread-system-error".to_string()),
                last_request_unix_ms: now.saturating_sub(20 * 60 * 1000),
                last_discovered_unix_ms: previous_last_discovered,
                last_reported_model_provider: Some("api_router".to_string()),
                last_reported_model: Some("gpt-5.4".to_string()),
                last_reported_base_url: Some("http://127.0.0.1:4000/v1".to_string()),
                rollout_path: Some(
                    "C:\\Users\\yiyou\\.codex\\sessions\\thread-system-error.jsonl".to_string(),
                ),
                agent_parent_session_id: None,
                is_agent: false,
                is_review: false,
                confirmed_router: true,
            },
        )]);

        merge_thread_index_session_hints(
            &mut map,
            now,
            &[serde_json::json!({
                "id": "thread-system-error",
                "workspace": "windows",
                "path": "C:\\Users\\yiyou\\.codex\\sessions\\thread-system-error.jsonl",
                "status": { "type": "systemError" },
                "updatedAt": system_error_updated_at / 1000
            })],
            true,
        );

        let entry = map
            .get("thread-system-error")
            .expect("system error runtime session");
        assert_eq!(
            entry.last_discovered_unix_ms,
            system_error_updated_at,
            "terminal systemError thread snapshots should preserve their own updatedAt instead of refreshing discovery to now"
        );
    }
}
