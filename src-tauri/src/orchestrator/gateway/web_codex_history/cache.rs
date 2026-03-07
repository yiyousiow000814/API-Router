use super::HistoryTurn;
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};

const MAX_HISTORY_TURNS_CACHE_ENTRIES: usize = 8;

#[derive(Clone, Debug, PartialEq, Eq)]
struct RolloutFileKey {
    len: u64,
    modified_ms: u128,
}

#[derive(Clone)]
struct HistoryTurnsCacheEntry {
    file_key: RolloutFileKey,
    turns: Arc<Vec<HistoryTurn>>,
    access_seq: u64,
}

#[derive(Default)]
struct HistoryTurnsCacheState {
    access_seq: u64,
    by_path: HashMap<String, HistoryTurnsCacheEntry>,
}

fn history_turns_cache() -> &'static Mutex<HistoryTurnsCacheState> {
    static CACHE: OnceLock<Mutex<HistoryTurnsCacheState>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HistoryTurnsCacheState::default()))
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

fn prune_history_turns_cache(state: &mut HistoryTurnsCacheState) {
    while state.by_path.len() > MAX_HISTORY_TURNS_CACHE_ENTRIES {
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

fn load_cached_turns(
    path: &Path,
    parser: fn(&Path) -> Result<Vec<HistoryTurn>, String>,
) -> Result<Arc<Vec<HistoryTurn>>, String> {
    let path_key = cache_path_key(path);
    let file_key = rollout_file_key(path)?;
    {
        let mut state = match history_turns_cache().lock() {
            Ok(guard) => guard,
            Err(err) => err.into_inner(),
        };
        state.access_seq = state.access_seq.saturating_add(1);
        let access_seq = state.access_seq;
        if let Some(entry) = state.by_path.get_mut(&path_key) {
            if entry.file_key == file_key {
                entry.access_seq = access_seq;
                return Ok(entry.turns.clone());
            }
        }
    }

    let parsed = Arc::new(parser(path)?);
    let mut state = match history_turns_cache().lock() {
        Ok(guard) => guard,
        Err(err) => err.into_inner(),
    };
    state.access_seq = state.access_seq.saturating_add(1);
    let access_seq = state.access_seq;
    state.by_path.insert(
        path_key,
        HistoryTurnsCacheEntry {
            file_key,
            turns: parsed.clone(),
            access_seq,
        },
    );
    prune_history_turns_cache(&mut state);
    Ok(parsed)
}

pub(super) fn load_cached_rollout_turns(path: &Path) -> Result<Arc<Vec<HistoryTurn>>, String> {
    load_cached_turns(path, super::parse_rollout_turns)
}

#[cfg(test)]
pub(super) fn _clear_history_turns_cache_for_test() {
    match history_turns_cache().lock() {
        Ok(mut guard) => guard.by_path.clear(),
        Err(err) => err.into_inner().by_path.clear(),
    }
}
