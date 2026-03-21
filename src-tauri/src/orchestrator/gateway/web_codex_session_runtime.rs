use super::web_codex_home::WorkspaceTarget;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

#[cfg_attr(not(test), allow(dead_code))]
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct WorkspaceRuntimeSnapshot {
    pub(crate) workspace_target: Option<WorkspaceTarget>,
    pub(crate) workspace_label: String,
    pub(crate) home_override: Option<String>,
    pub(crate) connected: bool,
    pub(crate) connected_at_unix_secs: Option<i64>,
    pub(crate) last_replay_cursor: u64,
    pub(crate) last_replay_last_event_id: Option<u64>,
    pub(crate) last_replay_at_unix_secs: Option<i64>,
}

#[cfg_attr(not(test), allow(dead_code))]
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct WorkspaceThreadRuntimeSnapshot {
    pub(crate) thread_id: String,
    pub(crate) cwd: Option<String>,
    pub(crate) rollout_path: Option<String>,
    pub(crate) status: Option<String>,
    pub(crate) last_event_id: Option<u64>,
    pub(crate) last_turn_id: Option<String>,
    pub(crate) updated_at_unix_secs: i64,
}

pub(crate) struct WorkspaceThreadRuntimeUpdate<'a> {
    pub(crate) thread_id: &'a str,
    pub(crate) cwd: Option<&'a str>,
    pub(crate) rollout_path: Option<&'a str>,
    pub(crate) status: Option<&'a str>,
    pub(crate) last_event_id: Option<u64>,
    pub(crate) last_turn_id: Option<&'a str>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct WorkspaceRuntimeRecord {
    workspace_target: Option<WorkspaceTarget>,
    workspace_label: String,
    home_override: Option<String>,
    connected: bool,
    connected_at_unix_secs: Option<i64>,
    last_replay_cursor: u64,
    last_replay_last_event_id: Option<u64>,
    last_replay_at_unix_secs: Option<i64>,
    threads: HashMap<String, WorkspaceThreadRuntimeRecord>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct WorkspaceThreadRuntimeRecord {
    thread_id: String,
    cwd: Option<String>,
    rollout_path: Option<String>,
    status: Option<String>,
    last_event_id: Option<u64>,
    last_turn_id: Option<String>,
    updated_at_unix_secs: i64,
}

fn current_unix_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|v| v.as_secs() as i64)
        .unwrap_or(0)
}

fn workspace_label(workspace_target: Option<WorkspaceTarget>) -> &'static str {
    match workspace_target {
        Some(WorkspaceTarget::Windows) => "windows",
        Some(WorkspaceTarget::Wsl2) => "wsl2",
        None => "all",
    }
}

fn runtime_registry() -> &'static Mutex<HashMap<String, WorkspaceRuntimeRecord>> {
    static REGISTRY: OnceLock<Mutex<HashMap<String, WorkspaceRuntimeRecord>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

fn runtime_key(workspace_target: Option<WorkspaceTarget>, home_override: Option<&str>) -> String {
    let home = home_override
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or_default();
    format!("{}::{home}", workspace_label(workspace_target))
}

fn lock_registry() -> std::sync::MutexGuard<'static, HashMap<String, WorkspaceRuntimeRecord>> {
    match runtime_registry().lock() {
        Ok(guard) => guard,
        Err(err) => err.into_inner(),
    }
}

fn ensure_runtime_record(
    workspace_target: Option<WorkspaceTarget>,
    home_override: Option<&str>,
) -> WorkspaceRuntimeRecord {
    WorkspaceRuntimeRecord {
        workspace_target,
        workspace_label: workspace_label(workspace_target).to_string(),
        home_override: home_override
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string),
        connected: false,
        connected_at_unix_secs: None,
        last_replay_cursor: 0,
        last_replay_last_event_id: None,
        last_replay_at_unix_secs: None,
        threads: HashMap::new(),
    }
}

fn normalize_optional_text(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn normalize_thread_id(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

pub(crate) fn ensure_workspace_runtime_registered(
    workspace_target: Option<WorkspaceTarget>,
    home_override: Option<&str>,
) {
    let key = runtime_key(workspace_target, home_override);
    let mut guard = lock_registry();
    guard
        .entry(key)
        .or_insert_with(|| ensure_runtime_record(workspace_target, home_override));
}

pub(crate) fn mark_workspace_runtime_connected(
    workspace_target: Option<WorkspaceTarget>,
    home_override: Option<&str>,
) {
    let key = runtime_key(workspace_target, home_override);
    let now = current_unix_secs();
    let mut guard = lock_registry();
    let entry = guard
        .entry(key)
        .or_insert_with(|| ensure_runtime_record(workspace_target, home_override));
    entry.connected = true;
    if entry.connected_at_unix_secs.is_none() {
        entry.connected_at_unix_secs = Some(now);
    }
}

pub(crate) fn mark_workspace_runtime_replay(
    workspace_target: Option<WorkspaceTarget>,
    home_override: Option<&str>,
    cursor: u64,
    last_event_id: Option<u64>,
) {
    let key = runtime_key(workspace_target, home_override);
    let now = current_unix_secs();
    let mut guard = lock_registry();
    let entry = guard
        .entry(key)
        .or_insert_with(|| ensure_runtime_record(workspace_target, home_override));
    entry.last_replay_cursor = cursor;
    entry.last_replay_last_event_id = last_event_id;
    entry.last_replay_at_unix_secs = Some(now);
}

pub(crate) fn upsert_workspace_thread_runtime(
    workspace_target: Option<WorkspaceTarget>,
    home_override: Option<&str>,
    update: WorkspaceThreadRuntimeUpdate<'_>,
) {
    let Some(thread_id) = normalize_thread_id(update.thread_id) else {
        return;
    };
    let key = runtime_key(workspace_target, home_override);
    let now = current_unix_secs();
    let mut guard = lock_registry();
    let entry = guard
        .entry(key)
        .or_insert_with(|| ensure_runtime_record(workspace_target, home_override));
    let thread =
        entry
            .threads
            .entry(thread_id.clone())
            .or_insert_with(|| WorkspaceThreadRuntimeRecord {
                thread_id: thread_id.clone(),
                cwd: None,
                rollout_path: None,
                status: None,
                last_event_id: None,
                last_turn_id: None,
                updated_at_unix_secs: now,
            });
    if let Some(cwd) = normalize_optional_text(update.cwd) {
        thread.cwd = Some(cwd);
    }
    if let Some(rollout_path) = normalize_optional_text(update.rollout_path) {
        thread.rollout_path = Some(rollout_path);
    }
    if let Some(status) = normalize_optional_text(update.status) {
        thread.status = Some(status);
    }
    if let Some(last_event_id) = update.last_event_id {
        thread.last_event_id = Some(last_event_id);
    }
    if let Some(last_turn_id) = normalize_optional_text(update.last_turn_id) {
        thread.last_turn_id = Some(last_turn_id);
    }
    thread.updated_at_unix_secs = now;
}

#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn workspace_runtime_snapshot(
    workspace_target: Option<WorkspaceTarget>,
    home_override: Option<&str>,
) -> WorkspaceRuntimeSnapshot {
    let key = runtime_key(workspace_target, home_override);
    let mut guard = lock_registry();
    let entry = guard
        .entry(key)
        .or_insert_with(|| ensure_runtime_record(workspace_target, home_override))
        .clone();
    WorkspaceRuntimeSnapshot {
        workspace_target: entry.workspace_target,
        workspace_label: entry.workspace_label,
        home_override: entry.home_override,
        connected: entry.connected,
        connected_at_unix_secs: entry.connected_at_unix_secs,
        last_replay_cursor: entry.last_replay_cursor,
        last_replay_last_event_id: entry.last_replay_last_event_id,
        last_replay_at_unix_secs: entry.last_replay_at_unix_secs,
    }
}

#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn workspace_thread_runtime_snapshot(
    workspace_target: Option<WorkspaceTarget>,
    home_override: Option<&str>,
    thread_id: &str,
) -> Option<WorkspaceThreadRuntimeSnapshot> {
    let key = runtime_key(workspace_target, home_override);
    let guard = lock_registry();
    let entry = guard.get(&key)?;
    let thread = entry.threads.get(thread_id.trim())?;
    Some(WorkspaceThreadRuntimeSnapshot {
        thread_id: thread.thread_id.clone(),
        cwd: thread.cwd.clone(),
        rollout_path: thread.rollout_path.clone(),
        status: thread.status.clone(),
        last_event_id: thread.last_event_id,
        last_turn_id: thread.last_turn_id.clone(),
        updated_at_unix_secs: thread.updated_at_unix_secs,
    })
}

#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn workspace_thread_runtime_count(
    workspace_target: Option<WorkspaceTarget>,
    home_override: Option<&str>,
) -> usize {
    let key = runtime_key(workspace_target, home_override);
    let guard = lock_registry();
    guard
        .get(&key)
        .map(|entry| entry.threads.len())
        .unwrap_or(0)
}

#[cfg(test)]
pub(crate) fn _clear_workspace_runtime_registry_for_test() {
    lock_registry().clear();
}

#[cfg(test)]
mod tests {
    use super::{
        _clear_workspace_runtime_registry_for_test, ensure_workspace_runtime_registered,
        mark_workspace_runtime_connected, mark_workspace_runtime_replay,
        upsert_workspace_thread_runtime, workspace_runtime_snapshot,
        workspace_thread_runtime_count, workspace_thread_runtime_snapshot,
    };
    use crate::orchestrator::gateway::web_codex_home::WorkspaceTarget;

    #[test]
    fn workspace_runtime_snapshot_registers_default_record() {
        _clear_workspace_runtime_registry_for_test();
        let snapshot = workspace_runtime_snapshot(
            Some(WorkspaceTarget::Windows),
            Some("C:\\Users\\yiyou\\.codex"),
        );
        assert_eq!(snapshot.workspace_label, "windows");
        assert_eq!(
            snapshot.home_override.as_deref(),
            Some("C:\\Users\\yiyou\\.codex")
        );
        assert!(!snapshot.connected);
        assert_eq!(snapshot.last_replay_cursor, 0);
        assert_eq!(snapshot.last_replay_last_event_id, None);
    }

    #[test]
    fn workspace_runtime_marks_connected_and_replay_progress() {
        _clear_workspace_runtime_registry_for_test();
        ensure_workspace_runtime_registered(
            Some(WorkspaceTarget::Wsl2),
            Some("/home/yiyou/.codex"),
        );
        mark_workspace_runtime_connected(Some(WorkspaceTarget::Wsl2), Some("/home/yiyou/.codex"));
        mark_workspace_runtime_replay(
            Some(WorkspaceTarget::Wsl2),
            Some("/home/yiyou/.codex"),
            88,
            Some(96),
        );

        let snapshot =
            workspace_runtime_snapshot(Some(WorkspaceTarget::Wsl2), Some("/home/yiyou/.codex"));
        assert_eq!(snapshot.workspace_label, "wsl2");
        assert!(snapshot.connected);
        assert!(snapshot.connected_at_unix_secs.is_some());
        assert_eq!(snapshot.last_replay_cursor, 88);
        assert_eq!(snapshot.last_replay_last_event_id, Some(96));
        assert!(snapshot.last_replay_at_unix_secs.is_some());
    }

    #[test]
    fn workspace_thread_runtime_snapshot_tracks_latest_thread_state() {
        _clear_workspace_runtime_registry_for_test();
        upsert_workspace_thread_runtime(
            Some(WorkspaceTarget::Windows),
            Some("C:\\Users\\yiyou\\.codex"),
            super::WorkspaceThreadRuntimeUpdate {
                thread_id: "thread-1",
                cwd: Some("C:\\repo"),
                rollout_path: Some("C:\\repo\\.codex\\sessions\\rollout-thread-1.jsonl"),
                status: Some("running"),
                last_event_id: Some(12),
                last_turn_id: Some("turn-9"),
            },
        );

        let snapshot = workspace_thread_runtime_snapshot(
            Some(WorkspaceTarget::Windows),
            Some("C:\\Users\\yiyou\\.codex"),
            "thread-1",
        )
        .expect("thread runtime snapshot");
        assert_eq!(snapshot.thread_id, "thread-1");
        assert_eq!(snapshot.cwd.as_deref(), Some("C:\\repo"));
        assert_eq!(
            snapshot.rollout_path.as_deref(),
            Some("C:\\repo\\.codex\\sessions\\rollout-thread-1.jsonl")
        );
        assert_eq!(snapshot.status.as_deref(), Some("running"));
        assert_eq!(snapshot.last_event_id, Some(12));
        assert_eq!(snapshot.last_turn_id.as_deref(), Some("turn-9"));
        assert_eq!(
            workspace_thread_runtime_count(
                Some(WorkspaceTarget::Windows),
                Some("C:\\Users\\yiyou\\.codex")
            ),
            1
        );
    }
}
