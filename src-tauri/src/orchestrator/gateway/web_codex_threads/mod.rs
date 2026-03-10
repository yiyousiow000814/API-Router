use crate::orchestrator::gateway::web_codex_home::WorkspaceTarget;
use serde_json::Value;

mod source;

use self::source::{
    find_rollout_path_in_items, merge_items_without_duplicates, rebuild_workspace_thread_items,
    sort_threads_by_updated_desc,
};

const THREADS_INDEX_STALE_SECS: i64 = 15;

#[derive(Default)]
struct WorkspaceThreadsBucket {
    items: Vec<Value>,
    updated_at_unix_secs: i64,
    refreshing: bool,
    last_rebuild_ms: i64,
}

#[derive(Default)]
struct ThreadsWorkspaceIndex {
    windows: WorkspaceThreadsBucket,
    wsl2: WorkspaceThreadsBucket,
}

#[derive(Clone)]
pub(super) struct ThreadListSnapshot {
    pub(super) items: Vec<Value>,
    pub(super) cache_hit: bool,
    pub(super) rebuild_ms: i64,
}

fn current_unix_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|v| v.as_secs() as i64)
        .unwrap_or(0)
}

fn threads_workspace_index() -> &'static std::sync::Mutex<ThreadsWorkspaceIndex> {
    static INDEX: std::sync::OnceLock<std::sync::Mutex<ThreadsWorkspaceIndex>> =
        std::sync::OnceLock::new();
    INDEX.get_or_init(|| std::sync::Mutex::new(ThreadsWorkspaceIndex::default()))
}

fn lock_threads_workspace_index() -> std::sync::MutexGuard<'static, ThreadsWorkspaceIndex> {
    match threads_workspace_index().lock() {
        Ok(v) => v,
        Err(err) => err.into_inner(),
    }
}

fn workspace_bucket_ref(
    index: &ThreadsWorkspaceIndex,
    target: WorkspaceTarget,
) -> &WorkspaceThreadsBucket {
    match target {
        WorkspaceTarget::Windows => &index.windows,
        WorkspaceTarget::Wsl2 => &index.wsl2,
    }
}

fn workspace_bucket_mut(
    index: &mut ThreadsWorkspaceIndex,
    target: WorkspaceTarget,
) -> &mut WorkspaceThreadsBucket {
    match target {
        WorkspaceTarget::Windows => &mut index.windows,
        WorkspaceTarget::Wsl2 => &mut index.wsl2,
    }
}

pub(super) fn invalidate_thread_list_cache_all() {
    let mut index = lock_threads_workspace_index();
    index.windows = WorkspaceThreadsBucket::default();
    index.wsl2 = WorkspaceThreadsBucket::default();
}

pub(super) fn spawn_thread_index_prewarm() {
    for target in [WorkspaceTarget::Windows, WorkspaceTarget::Wsl2] {
        let should_spawn = {
            let mut index = lock_threads_workspace_index();
            let bucket = workspace_bucket_mut(&mut index, target);
            if bucket.refreshing || !bucket.items.is_empty() {
                false
            } else {
                bucket.refreshing = true;
                true
            }
        };
        if should_spawn {
            tokio::spawn(async move {
                refresh_workspace_thread_index(target).await;
            });
        }
    }
}

pub(super) async fn list_threads_snapshot(
    workspace: Option<WorkspaceTarget>,
    force: bool,
) -> ThreadListSnapshot {
    match workspace {
        Some(target) => list_workspace_snapshot(target, force).await,
        None => {
            let (windows, wsl2) = tokio::join!(
                list_workspace_snapshot(WorkspaceTarget::Windows, force),
                list_workspace_snapshot(WorkspaceTarget::Wsl2, force)
            );
            let mut merged = merge_items_without_duplicates(windows.items, wsl2.items);
            sort_threads_by_updated_desc(&mut merged);
            ThreadListSnapshot {
                items: merged,
                cache_hit: windows.cache_hit && wsl2.cache_hit,
                rebuild_ms: windows.rebuild_ms.max(wsl2.rebuild_ms),
            }
        }
    }
}

pub(super) async fn known_rollout_path_for_thread(
    workspace: WorkspaceTarget,
    thread_id: &str,
) -> Option<String> {
    let snapshot = list_workspace_snapshot(workspace, false).await;
    find_rollout_path_in_items(&snapshot.items, thread_id)
}

async fn list_workspace_snapshot(target: WorkspaceTarget, force: bool) -> ThreadListSnapshot {
    ensure_workspace_index_fresh(target, force).await;
    let index = lock_threads_workspace_index();
    let bucket = workspace_bucket_ref(&index, target);
    ThreadListSnapshot {
        items: bucket.items.clone(),
        cache_hit: !force && bucket.updated_at_unix_secs > 0,
        rebuild_ms: bucket.last_rebuild_ms,
    }
}

async fn refresh_workspace_thread_index(target: WorkspaceTarget) {
    let started = std::time::Instant::now();
    let items = rebuild_workspace_thread_items(target).await;
    let rebuild_ms = i64::try_from(started.elapsed().as_millis()).unwrap_or(i64::MAX);
    let mut index = lock_threads_workspace_index();
    let bucket = workspace_bucket_mut(&mut index, target);
    bucket.items = items;
    bucket.updated_at_unix_secs = current_unix_secs();
    bucket.refreshing = false;
    bucket.last_rebuild_ms = rebuild_ms;
}

async fn ensure_workspace_index_fresh(target: WorkspaceTarget, force: bool) {
    let now = current_unix_secs();
    enum Action {
        None,
        SyncRefresh,
        AsyncRefresh,
    }
    let action = {
        let mut index = lock_threads_workspace_index();
        let bucket = workspace_bucket_mut(&mut index, target);
        let has_items = !bucket.items.is_empty();
        let stale = now.saturating_sub(bucket.updated_at_unix_secs) >= THREADS_INDEX_STALE_SECS;
        if force {
            if bucket.refreshing {
                Action::None
            } else {
                bucket.refreshing = true;
                Action::SyncRefresh
            }
        } else if !has_items && !bucket.refreshing {
            bucket.refreshing = true;
            Action::SyncRefresh
        } else if stale && !bucket.refreshing {
            bucket.refreshing = true;
            Action::AsyncRefresh
        } else {
            Action::None
        }
    };

    match action {
        Action::None => {}
        Action::SyncRefresh => refresh_workspace_thread_index(target).await,
        Action::AsyncRefresh => {
            tokio::spawn(async move {
                refresh_workspace_thread_index(target).await;
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        find_rollout_path_in_items, invalidate_thread_list_cache_all, list_threads_snapshot,
    };
    use crate::codex_app_server;
    use crate::orchestrator::gateway::web_codex_home::WorkspaceTarget;
    use serde_json::Value;
    use std::sync::{Arc, Mutex};

    struct EnvGuard {
        key: &'static str,
        prev: Option<String>,
    }

    impl EnvGuard {
        fn set(key: &'static str, value: &str) -> Self {
            let prev = std::env::var(key).ok();
            std::env::set_var(key, value);
            Self { key, prev }
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            if let Some(prev) = self.prev.as_deref() {
                std::env::set_var(self.key, prev);
            } else {
                std::env::remove_var(self.key);
            }
        }
    }

    #[tokio::test]
    async fn windows_thread_list_uses_session_index_without_thread_list_rpc() {
        let temp = tempfile::tempdir().expect("tempdir");
        let codex_home = temp.path().join(".codex");
        let sessions = codex_home
            .join("sessions")
            .join("2026")
            .join("03")
            .join("06");
        std::fs::create_dir_all(&sessions).expect("sessions dir");
        let thread_id = "019cbfa3-3342-7ae2-a788-984dc07bc729";
        let rollout = sessions.join(format!("rollout-2026-03-06T04-14-29-{thread_id}.jsonl"));
        std::fs::write(
            &rollout,
            r#"{"type":"session_meta","payload":{"id":"019cbfa3-3342-7ae2-a788-984dc07bc729","cwd":"C:\\repo","created_at":1741234469}}
{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"build exe"}]}}
"#,
        )
        .expect("rollout write");
        std::fs::write(
            codex_home.join("history.jsonl"),
            r#"{"session_id":"019cbfa3-3342-7ae2-a788-984dc07bc729","text":"build exe"}"#,
        )
        .expect("history write");

        let _guard = EnvGuard::set(
            "API_ROUTER_WEB_CODEX_CODEX_HOME",
            &codex_home.to_string_lossy(),
        );
        invalidate_thread_list_cache_all();

        let rpc_calls: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let rpc_calls_clone = rpc_calls.clone();
        codex_app_server::_set_test_request_handler(Some(Arc::new(
            move |_home, method, _params| {
                rpc_calls_clone
                    .lock()
                    .expect("rpc calls lock")
                    .push(method.to_string());
                Err("thread/list should not be called for sidebar index".to_string())
            },
        )))
        .await;

        let snapshot = list_threads_snapshot(Some(WorkspaceTarget::Windows), true).await;
        codex_app_server::_set_test_request_handler(None).await;

        let calls = rpc_calls.lock().expect("rpc calls").clone();
        assert!(calls.is_empty(), "unexpected RPC calls: {calls:?}");
        assert_eq!(snapshot.items.len(), 1);
        let item = snapshot.items.first().unwrap_or(&Value::Null);
        assert_eq!(
            item.get("preview").and_then(|v| v.as_str()),
            Some("build exe")
        );
        assert_eq!(
            item.get("workspace").and_then(|v| v.as_str()),
            Some("windows")
        );
    }

    #[test]
    fn known_rollout_path_lookup_matches_thread_id() {
        let items = vec![
            serde_json::json!({
                "id": "t1",
                "path": "C:\\\\Users\\\\me\\\\.codex\\\\sessions\\\\a.jsonl"
            }),
            serde_json::json!({
                "id": "t2",
                "path": "\\\\wsl.localhost\\\\Ubuntu\\\\home\\\\me\\\\.codex\\\\sessions\\\\b.jsonl"
            }),
        ];
        assert_eq!(
            find_rollout_path_in_items(&items, "t2").as_deref(),
            Some("\\\\wsl.localhost\\\\Ubuntu\\\\home\\\\me\\\\.codex\\\\sessions\\\\b.jsonl")
        );
        assert!(find_rollout_path_in_items(&items, "missing").is_none());
    }
}
