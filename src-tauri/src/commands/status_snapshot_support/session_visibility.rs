use crate::orchestrator::gateway::session_meta_identity::SessionMetaIdentity;
use crate::orchestrator::gateway::ClientSessionRuntime;
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::io::BufRead;

#[derive(Clone, Debug)]
struct RolloutRuntimeIdentity {
    session_id: String,
    agent_parent_session_id: Option<String>,
    is_agent: bool,
    is_review: bool,
}

#[derive(Default)]
struct RolloutRuntimeIdentityCache {
    identities: HashMap<String, Option<RolloutRuntimeIdentity>>,
}

impl RolloutRuntimeIdentityCache {
    fn read<F>(&mut self, path: &str, loader: F) -> Option<&RolloutRuntimeIdentity>
    where
        F: FnOnce(&str) -> Option<RolloutRuntimeIdentity>,
    {
        use std::collections::hash_map::Entry;

        let key = path.trim().to_string();
        if key.is_empty() {
            return None;
        }
        match self.identities.entry(key) {
            Entry::Occupied(entry) => entry.into_mut().as_ref(),
            Entry::Vacant(entry) => entry.insert(loader(path)).as_ref(),
        }
    }
}

pub(crate) fn session_has_rollout(entry: &ClientSessionRuntime) -> bool {
    entry
        .rollout_path
        .as_deref()
        .map(str::trim)
        .is_some_and(|path| !path.is_empty())
}

fn read_rollout_runtime_identity(path: &str) -> Option<RolloutRuntimeIdentity> {
    let file = std::fs::File::open(std::path::Path::new(path)).ok()?;
    let reader = std::io::BufReader::new(file);
    for line in reader.lines().take(8).map_while(Result::ok) {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let value: serde_json::Value = serde_json::from_str(trimmed).ok()?;
        let Some(identity) = SessionMetaIdentity::from_session_meta_event(&value) else {
            continue;
        };
        return Some(RolloutRuntimeIdentity {
            session_id: identity.session_id,
            agent_parent_session_id: identity.agent_parent_session_id,
            is_agent: identity.is_agent,
            is_review: identity.is_review,
        });
    }
    None
}

fn normalize_client_session_identity_from_rollout_path_with_cache(
    entry: &mut ClientSessionRuntime,
    cache: &mut RolloutRuntimeIdentityCache,
) {
    let Some(rollout_path) = entry
        .rollout_path
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty())
    else {
        return;
    };
    let Some(identity) = cache.read(rollout_path, read_rollout_runtime_identity) else {
        return;
    };
    if !identity
        .session_id
        .eq_ignore_ascii_case(entry.codex_session_id.trim())
    {
        return;
    }
    if let Some(parent_sid) = identity
        .agent_parent_session_id
        .as_deref()
        .map(str::trim)
        .filter(|sid| !sid.is_empty())
    {
        entry.agent_parent_session_id = Some(parent_sid.to_string());
    }
    if identity.is_agent {
        entry.is_agent = true;
    }
    if identity.is_review {
        entry.is_review = true;
        entry.is_agent = true;
    }
}

pub(crate) fn normalize_client_session_identities_from_rollouts(
    map: &mut HashMap<String, ClientSessionRuntime>,
) {
    let mut cache = RolloutRuntimeIdentityCache::default();
    for entry in map.values_mut() {
        normalize_client_session_identity_from_rollout_path_with_cache(entry, &mut cache);
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rollout_identity_cache_reads_shared_path_once_per_refresh() {
        let mut reads = 0usize;
        let mut cache = RolloutRuntimeIdentityCache::default();

        let first = cache
            .read("C:/rollouts/shared.jsonl", |_| {
                reads += 1;
                Some(RolloutRuntimeIdentity {
                    session_id: "agent-child".to_string(),
                    agent_parent_session_id: Some("parent-thread".to_string()),
                    is_agent: true,
                    is_review: false,
                })
            })
            .cloned();
        let second = cache
            .read("C:/rollouts/shared.jsonl", |_| {
                reads += 1;
                None
            })
            .cloned();

        assert_eq!(reads, 1, "shared rollout path should be read once");
        assert_eq!(
            first.and_then(|identity| identity.agent_parent_session_id),
            Some("parent-thread".to_string())
        );
        assert_eq!(
            second.map(|identity| identity.session_id),
            Some("agent-child".to_string())
        );
    }
}
