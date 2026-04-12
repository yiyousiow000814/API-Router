use crate::orchestrator::gateway::ClientSessionRuntime;
use serde_json::json;
use std::collections::{HashMap, HashSet};

pub(crate) fn session_has_rollout(entry: &ClientSessionRuntime) -> bool {
    entry
        .rollout_path
        .as_deref()
        .map(str::trim)
        .is_some_and(|path| !path.is_empty())
}

pub(crate) fn recent_client_sessions_with_main_parent_context(
    visible_map: &HashMap<String, ClientSessionRuntime>,
    full_map: &HashMap<String, ClientSessionRuntime>,
    primary_limit: usize,
) -> Vec<(String, ClientSessionRuntime)> {
    let mut items: Vec<_> = visible_map
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
        if full_map.contains_key(parent_sid) {
            selected_ids.insert(parent_sid.to_string());
        }
    }

    items = selected_ids
        .into_iter()
        .filter_map(|sid| full_map.get(&sid).map(|runtime| (sid, runtime.clone())))
        .collect();
    items.sort_by(|(left_sid, left_runtime), (right_sid, right_runtime)| {
        let left_last_seen = super::session_retention::session_last_seen_unix_ms(left_runtime);
        let right_last_seen = super::session_retention::session_last_seen_unix_ms(right_runtime);
        right_last_seen
            .cmp(&left_last_seen)
            .then_with(|| left_sid.cmp(right_sid))
    });
    items
}

fn summarize_runtime_session_for_trace(
    sid: &str,
    runtime: &ClientSessionRuntime,
) -> serde_json::Value {
    json!({
        "id": sid,
        "lastSeenUnixMs": super::session_retention::session_last_seen_unix_ms(runtime),
        "lastRequestUnixMs": runtime.last_request_unix_ms,
        "lastDiscoveredUnixMs": runtime.last_discovered_unix_ms,
        "confirmedRouter": runtime.confirmed_router,
        "isAgent": runtime.is_agent,
        "isReview": runtime.is_review,
        "parentSessionId": runtime.agent_parent_session_id,
        "rolloutPath": runtime.rollout_path,
        "wtSession": runtime.wt_session,
        "reportedModelProvider": runtime.last_reported_model_provider,
    })
}

pub(crate) fn trace_visible_client_session_selection(
    visible_map: &HashMap<String, ClientSessionRuntime>,
    full_map: &HashMap<String, ClientSessionRuntime>,
    primary_limit: usize,
    selected_items: &[(String, ClientSessionRuntime)],
) {
    let mut sorted_candidates: Vec<_> = visible_map
        .iter()
        .map(|(sid, runtime)| (sid.clone(), runtime.clone()))
        .collect();
    sorted_candidates.sort_by(|(left_sid, left_runtime), (right_sid, right_runtime)| {
        let left_last_seen = super::session_retention::session_last_seen_unix_ms(left_runtime);
        let right_last_seen = super::session_retention::session_last_seen_unix_ms(right_runtime);
        right_last_seen
            .cmp(&left_last_seen)
            .then_with(|| left_sid.cmp(right_sid))
    });

    let primary_ids = sorted_candidates
        .iter()
        .take(primary_limit)
        .map(|(sid, _)| sid.clone())
        .collect::<Vec<_>>();
    let selected_ids = selected_items
        .iter()
        .map(|(sid, _)| sid.clone())
        .collect::<Vec<_>>();
    let selected_id_set = selected_ids.iter().cloned().collect::<HashSet<_>>();
    let primary_id_set = primary_ids.iter().cloned().collect::<HashSet<_>>();
    let injected_parent_ids = selected_ids
        .iter()
        .filter(|sid| !primary_id_set.contains(*sid))
        .cloned()
        .collect::<Vec<_>>();

    let _ =
        crate::orchestrator::gateway::web_codex_storage::append_codex_live_trace_entry(&json!({
            "source": "status.session_visibility",
            "entry": {
                "at": crate::orchestrator::store::unix_ms(),
                "kind": "status.session_visibility.selection",
                "primaryLimit": primary_limit,
                "fullMapCount": full_map.len(),
                "visibleMapCount": visible_map.len(),
                "primaryIds": primary_ids,
                "selectedIds": selected_ids,
                "injectedParentIds": injected_parent_ids,
                "topCandidates": sorted_candidates
                    .iter()
                    .take(40)
                    .map(|(sid, runtime)| summarize_runtime_session_for_trace(sid, runtime))
                    .collect::<Vec<_>>(),
                "selectedSessions": selected_items
                    .iter()
                    .map(|(sid, runtime)| summarize_runtime_session_for_trace(sid, runtime))
                    .collect::<Vec<_>>(),
                "droppedVisibleCandidates": sorted_candidates
                    .iter()
                    .filter(|(sid, _)| !selected_id_set.contains(sid))
                    .take(40)
                    .map(|(sid, runtime)| summarize_runtime_session_for_trace(sid, runtime))
                    .collect::<Vec<_>>(),
            }
        }));
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
    let selected =
        recent_client_sessions_with_main_parent_context(&visible_sessions, map, primary_limit);
    trace_visible_client_session_selection(&visible_sessions, map, primary_limit, &selected);
    selected
}
