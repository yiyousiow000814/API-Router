use crate::orchestrator::gateway::ClientSessionRuntime;
use std::collections::{HashMap, HashSet};

pub(crate) fn session_has_rollout(entry: &ClientSessionRuntime) -> bool {
    entry
        .rollout_path
        .as_deref()
        .map(str::trim)
        .is_some_and(|path| !path.is_empty())
}

pub(crate) fn recent_client_sessions_with_main_parent_context(
    map: &HashMap<String, ClientSessionRuntime>,
    primary_limit: usize,
) -> Vec<(String, ClientSessionRuntime)> {
    let mut items: Vec<_> = map
        .iter()
        .map(|(sid, runtime)| (sid.clone(), runtime.clone()))
        .collect();
    items.sort_by(|(left_sid, left_runtime), (right_sid, right_runtime)| {
        let left_last_seen = super::session_retention::session_last_seen_unix_ms(left_runtime);
        let right_last_seen = super::session_retention::session_last_seen_unix_ms(right_runtime);
        right_last_seen
            .cmp(&left_last_seen)
            .then_with(|| left_sid.cmp(right_sid))
    });
    if items.len() <= primary_limit {
        return items;
    }

    let mut selected_ids: HashSet<String> = items
        .iter()
        .take(primary_limit)
        .map(|(sid, _runtime)| sid.clone())
        .collect();

    for (_sid, runtime) in items.iter().take(primary_limit) {
        if !(runtime.is_agent || runtime.is_review) {
            continue;
        }
        let Some(parent_sid) = runtime
            .agent_parent_session_id
            .as_deref()
            .map(str::trim)
            .filter(|sid| !sid.is_empty())
        else {
            continue;
        };
        if map.contains_key(parent_sid) {
            selected_ids.insert(parent_sid.to_string());
        }
    }

    items.retain(|(sid, _runtime)| selected_ids.contains(sid));
    items
}

pub(crate) fn visible_client_session_items(
    map: &HashMap<String, ClientSessionRuntime>,
    primary_limit: usize,
) -> Vec<(String, ClientSessionRuntime)> {
    let visible_sessions = map
        .iter()
        .filter(|(_sid, runtime)| session_has_rollout(runtime))
        .map(|(sid, runtime)| (sid.clone(), runtime.clone()))
        .collect::<HashMap<_, _>>();
    recent_client_sessions_with_main_parent_context(&visible_sessions, primary_limit)
}
