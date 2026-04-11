use crate::orchestrator::gateway::ClientSessionRuntime;

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
    !matches!(
        thread_item_status_type(item).as_deref(),
        None | Some("notLoaded")
    )
}

pub(crate) fn next_last_discovered_unix_ms(prev: u64, now: u64, discovery_is_fresh: bool) -> u64 {
    if discovery_is_fresh {
        return now;
    }
    prev
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
        if rollout_path.is_none() && !map.contains_key(&session_id) {
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
        let live_presence = snapshot_is_fresh && thread_item_is_live_presence(item);
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
            let observed_unix_ms = if live_presence {
                updated_unix_ms.max(now)
            } else {
                now
            };
            entry.last_discovered_unix_ms =
                next_last_discovered_unix_ms(entry.last_discovered_unix_ms, observed_unix_ms, true);
        }
    }
}
