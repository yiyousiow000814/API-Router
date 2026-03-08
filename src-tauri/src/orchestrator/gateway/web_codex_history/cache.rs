use super::ParsedRolloutHistory;
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};

const MAX_HISTORY_ROLLOUT_CACHE_ENTRIES: usize = 8;

#[derive(Clone, Debug, PartialEq, Eq)]
struct RolloutFileKey {
    len: u64,
    modified_ms: u128,
}

#[derive(Clone)]
struct HistoryRolloutCacheEntry {
    file_key: RolloutFileKey,
    parsed: Arc<ParsedRolloutHistory>,
    access_seq: u64,
}

#[derive(Default)]
struct HistoryRolloutCacheState {
    access_seq: u64,
    by_path: HashMap<String, HistoryRolloutCacheEntry>,
}

fn history_rollout_cache() -> &'static Mutex<HistoryRolloutCacheState> {
    static CACHE: OnceLock<Mutex<HistoryRolloutCacheState>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HistoryRolloutCacheState::default()))
}

fn rollout_file_key(path: &Path) -> Result<RolloutFileKey, String> {
    let meta = std::fs::metadata(path).map_err(|e| e.to_string())?;
    let modified = meta
        .modified()
        .map_err(|e| e.to_string())?
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?;
    Ok(RolloutFileKey {
        len: meta.len(),
        modified_ms: modified.as_millis(),
    })
}

fn cache_path_key(path: &Path) -> String {
    path.to_string_lossy().to_string()
}

fn prune_history_rollout_cache(state: &mut HistoryRolloutCacheState) {
    while state.by_path.len() > MAX_HISTORY_ROLLOUT_CACHE_ENTRIES {
        let Some((oldest_key, _)) = state
            .by_path
            .iter()
            .min_by_key(|(_, entry)| entry.access_seq)
            .map(|(key, entry)| (key.clone(), entry.access_seq))
        else {
            break;
        };
        state.by_path.remove(&oldest_key);
    }
}

fn load_cached_rollout(
    path: &Path,
    parser: fn(&Path) -> Result<ParsedRolloutHistory, String>,
) -> Result<Arc<ParsedRolloutHistory>, String> {
    let path_key = cache_path_key(path);
    let file_key = rollout_file_key(path)?;
    {
        let mut state = match history_rollout_cache().lock() {
            Ok(guard) => guard,
            Err(err) => err.into_inner(),
        };
        state.access_seq = state.access_seq.saturating_add(1);
        let access_seq = state.access_seq;
        if let Some(entry) = state.by_path.get_mut(&path_key) {
            if entry.file_key == file_key {
                entry.access_seq = access_seq;
                return Ok(entry.parsed.clone());
            }
        }
    }

    let parsed = Arc::new(parser(path)?);
    let mut state = match history_rollout_cache().lock() {
        Ok(guard) => guard,
        Err(err) => err.into_inner(),
    };
    state.access_seq = state.access_seq.saturating_add(1);
    let access_seq = state.access_seq;
    state.by_path.insert(
        path_key,
        HistoryRolloutCacheEntry {
            file_key,
            parsed: parsed.clone(),
            access_seq,
        },
    );
    prune_history_rollout_cache(&mut state);
    Ok(parsed)
}

pub(super) fn load_cached_rollout_history(
    path: &Path,
) -> Result<Arc<ParsedRolloutHistory>, String> {
    load_cached_rollout(path, super::parse_rollout_history)
}

#[cfg(test)]
pub(super) fn _clear_history_turns_cache_for_test() {
    match history_rollout_cache().lock() {
        Ok(mut guard) => guard.by_path.clear(),
        Err(err) => err.into_inner().by_path.clear(),
    }
}
