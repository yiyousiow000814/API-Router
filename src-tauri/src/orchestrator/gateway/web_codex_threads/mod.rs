use crate::orchestrator::gateway::web_codex_home::WorkspaceTarget;
use crate::orchestrator::gateway::web_codex_session_runtime::workspace_thread_runtime_snapshot;
use serde_json::{json, Value};

mod source;

use self::source::{
    find_rollout_path_in_items, has_missing_session_rollout_path, is_auxiliary_thread_preview_text,
    is_filtered_test_thread_cwd, merge_items_without_duplicates, normalize_thread_items_shape,
    rebuild_workspace_thread_items, sort_threads_by_updated_desc,
};

const THREADS_INDEX_STALE_SECS: i64 = 15;
const THREADS_REFRESH_STUCK_SECS: i64 = 12;
const THREADS_FORCE_WAIT_MAX_MS: u64 = 1500;

#[derive(Default)]
struct WorkspaceThreadsBucket {
    items: Vec<Value>,
    updated_at_unix_secs: i64,
    refreshing: bool,
    refresh_started_at_unix_secs: i64,
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

fn retained_live_notification_items(items: &[Value]) -> Vec<Value> {
    let mut retained = items
        .iter()
        .filter(|item| {
            item.get("source").and_then(Value::as_str).map(str::trim) == Some("live-notification")
        })
        .cloned()
        .collect::<Vec<_>>();
    normalize_thread_items_shape(&mut retained);
    retained
        .into_iter()
        .filter(|item| {
            item.get("filterReason")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .is_none()
                && !item
                    .get("preview")
                    .and_then(Value::as_str)
                    .map(is_auxiliary_thread_preview_text)
                    .unwrap_or(false)
                && !item
                    .get("cwd")
                    .and_then(Value::as_str)
                    .map(is_filtered_test_thread_cwd)
                    .unwrap_or(false)
        })
        .collect()
}

fn mark_bucket_refreshing(bucket: &mut WorkspaceThreadsBucket) {
    bucket.refreshing = true;
    bucket.refresh_started_at_unix_secs = current_unix_secs();
}

fn clear_bucket_refreshing(bucket: &mut WorkspaceThreadsBucket) {
    bucket.refreshing = false;
    bucket.refresh_started_at_unix_secs = 0;
}

fn bucket_refresh_is_stuck(bucket: &WorkspaceThreadsBucket, now_unix_secs: i64) -> bool {
    bucket.refreshing
        && (bucket.refresh_started_at_unix_secs <= 0
            || now_unix_secs.saturating_sub(bucket.refresh_started_at_unix_secs)
                >= THREADS_REFRESH_STUCK_SECS)
}

pub(super) fn invalidate_thread_list_cache_all() {
    let mut index = lock_threads_workspace_index();
    index.windows = WorkspaceThreadsBucket::default();
    index.wsl2 = WorkspaceThreadsBucket::default();
}

pub(super) fn upsert_thread_item_hint(workspace: WorkspaceTarget, item: Value) {
    let mut normalized = vec![item];
    normalize_thread_items_shape(&mut normalized);
    let Some(item) = normalized.into_iter().next() else {
        return;
    };
    if item
        .get("filterReason")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .is_some()
    {
        return;
    }

    let id = item
        .get("id")
        .or_else(|| item.get("threadId"))
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default()
        .to_string();
    if id.is_empty() {
        return;
    }

    let mut index = lock_threads_workspace_index();
    let bucket = workspace_bucket_mut(&mut index, workspace);
    if let Some(existing) = bucket.items.iter_mut().find(|existing| {
        existing
            .get("id")
            .or_else(|| existing.get("threadId"))
            .and_then(Value::as_str)
            .map(str::trim)
            == Some(id.as_str())
    }) {
        let merged = merge_items_without_duplicates(vec![existing.clone()], vec![item]);
        if let Some(next) = merged.into_iter().next() {
            *existing = next;
        }
    } else {
        bucket.items.push(item);
    }
    sort_threads_by_updated_desc(&mut bucket.items);
    bucket.updated_at_unix_secs = current_unix_secs();
}

fn notification_is_subagent(notification: &Value) -> bool {
    fn scan(value: &Value, depth: usize) -> bool {
        if depth > 6 {
            return false;
        }
        match value {
            Value::Object(map) => {
                let has_subagent = map
                    .get("subagent")
                    .or_else(|| map.get("subAgent"))
                    .and_then(Value::as_object)
                    .is_some();
                let has_agent_role = map
                    .get("agent_role")
                    .or_else(|| map.get("agentRole"))
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .map(|value| !value.is_empty())
                    .unwrap_or(false);
                let has_agent_nickname = map
                    .get("agent_nickname")
                    .or_else(|| map.get("agentNickname"))
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .map(|value| !value.is_empty())
                    .unwrap_or(false);
                has_subagent
                    || has_agent_role
                    || has_agent_nickname
                    || map.values().any(|child| scan(child, depth + 1))
            }
            Value::Array(items) => items.iter().take(40).any(|child| scan(child, depth + 1)),
            _ => false,
        }
    }

    let params = notification
        .get("params")
        .or_else(|| notification.get("payload"))
        .unwrap_or(notification);
    scan(params, 0)
}

fn notification_thread_id(notification: &Value) -> Option<String> {
    let params = notification
        .get("params")
        .and_then(Value::as_object)
        .or_else(|| notification.get("payload").and_then(Value::as_object));
    let direct = params
        .and_then(|map| map.get("threadId").and_then(Value::as_str))
        .or_else(|| params.and_then(|map| map.get("thread_id").and_then(Value::as_str)));
    if let Some(thread_id) = direct {
        return Some(thread_id.trim().to_string()).filter(|value| !value.is_empty());
    }
    params
        .and_then(|map| map.get("item").and_then(Value::as_object))
        .or_else(|| params.and_then(|map| map.get("payload").and_then(Value::as_object)))
        .and_then(|item| {
            item.get("threadId")
                .and_then(Value::as_str)
                .or_else(|| item.get("thread_id").and_then(Value::as_str))
        })
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn notification_rollout_path(notification: &Value) -> Option<String> {
    let params = notification
        .get("params")
        .and_then(Value::as_object)
        .or_else(|| notification.get("payload").and_then(Value::as_object));
    let thread = params.and_then(|map| map.get("thread").and_then(Value::as_object));
    let item = params
        .and_then(|map| map.get("item").and_then(Value::as_object))
        .or_else(|| params.and_then(|map| map.get("payload").and_then(Value::as_object)));
    [
        params.and_then(|map| map.get("rolloutPath").and_then(Value::as_str)),
        params.and_then(|map| map.get("rollout_path").and_then(Value::as_str)),
        params.and_then(|map| map.get("path").and_then(Value::as_str)),
        thread.and_then(|map| map.get("rolloutPath").and_then(Value::as_str)),
        thread.and_then(|map| map.get("rollout_path").and_then(Value::as_str)),
        thread.and_then(|map| map.get("path").and_then(Value::as_str)),
        item.and_then(|map| map.get("rolloutPath").and_then(Value::as_str)),
        item.and_then(|map| map.get("rollout_path").and_then(Value::as_str)),
        item.and_then(|map| map.get("path").and_then(Value::as_str)),
    ]
    .into_iter()
    .flatten()
    .map(str::trim)
    .find(|value| !value.is_empty())
    .map(str::to_string)
}

fn notification_cwd(notification: &Value) -> Option<String> {
    let params = notification
        .get("params")
        .and_then(Value::as_object)
        .or_else(|| notification.get("payload").and_then(Value::as_object));
    let thread = params.and_then(|map| map.get("thread").and_then(Value::as_object));
    let item = params
        .and_then(|map| map.get("item").and_then(Value::as_object))
        .or_else(|| params.and_then(|map| map.get("payload").and_then(Value::as_object)));
    [
        params.and_then(|map| map.get("cwd").and_then(Value::as_str)),
        thread.and_then(|map| map.get("cwd").and_then(Value::as_str)),
        item.and_then(|map| map.get("cwd").and_then(Value::as_str)),
    ]
    .into_iter()
    .flatten()
    .map(str::trim)
    .find(|value| !value.is_empty())
    .map(str::to_string)
}

fn notification_status(notification: &Value) -> Option<String> {
    let method = notification
        .get("method")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default()
        .to_ascii_lowercase();
    let params = notification
        .get("params")
        .and_then(Value::as_object)
        .or_else(|| notification.get("payload").and_then(Value::as_object));
    let status = params
        .and_then(|map| map.get("status").and_then(Value::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    status.or_else(|| {
        if method.contains("turn/started") {
            Some("running".to_string())
        } else if method.contains("turn/completed") || method.contains("turn/finished") {
            Some("completed".to_string())
        } else if method.contains("turn/failed") {
            Some("failed".to_string())
        } else if method.contains("turn/cancelled") {
            Some("interrupted".to_string())
        } else {
            None
        }
    })
}

fn notification_preview(notification: &Value) -> Option<String> {
    let payload = notification
        .get("params")
        .and_then(Value::as_object)
        .and_then(|map| map.get("payload"))
        .or_else(|| {
            notification
                .get("params")
                .and_then(Value::as_object)
                .and_then(|map| map.get("item"))
        })
        .and_then(Value::as_object)?;
    let preview = payload
        .get("content")
        .and_then(Value::as_array)
        .and_then(|parts| {
            parts.iter().find_map(|part| {
                part.get("text")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string)
            })
        })?;
    if is_auxiliary_thread_preview_text(&preview) {
        return None;
    }
    Some(preview)
}

pub(super) fn upsert_thread_notification_hint(workspace: WorkspaceTarget, notification: &Value) {
    let Some(thread_id) = notification_thread_id(notification) else {
        return;
    };
    if notification_cwd(notification)
        .as_deref()
        .map(is_filtered_test_thread_cwd)
        .unwrap_or(false)
    {
        return;
    }
    let mut item = json!({
        "id": thread_id,
        "workspace": match workspace {
            WorkspaceTarget::Windows => "windows",
            WorkspaceTarget::Wsl2 => "wsl2",
        },
        "source": "live-notification",
        "updatedAt": current_unix_secs(),
    });
    if notification_is_subagent(notification) {
        if let Some(obj) = item.as_object_mut() {
            obj.insert("isSubagent".to_string(), Value::Bool(true));
        }
    }
    if let Some(path) = notification_rollout_path(notification) {
        if let Some(obj) = item.as_object_mut() {
            obj.insert("path".to_string(), Value::String(path));
        }
    }
    if let Some(cwd) = notification_cwd(notification) {
        if let Some(obj) = item.as_object_mut() {
            obj.insert("cwd".to_string(), Value::String(cwd));
        }
    }
    if let Some(preview) = notification_preview(notification) {
        if let Some(obj) = item.as_object_mut() {
            obj.insert("preview".to_string(), Value::String(preview.clone()));
            obj.insert("title".to_string(), Value::String(preview));
        }
    }
    if let Some(status) = notification_status(notification) {
        if let Some(obj) = item.as_object_mut() {
            obj.insert("status".to_string(), json!({ "type": status }));
        }
    }
    upsert_thread_item_hint(workspace, item);
}

pub(super) fn spawn_thread_index_prewarm() {
    for target in [WorkspaceTarget::Windows, WorkspaceTarget::Wsl2] {
        let should_spawn = {
            let mut index = lock_threads_workspace_index();
            let bucket = workspace_bucket_mut(&mut index, target);
            if bucket.refreshing || !bucket.items.is_empty() {
                false
            } else {
                mark_bucket_refreshing(bucket);
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
    let home = crate::orchestrator::gateway::web_codex_home::web_codex_rpc_home_override_for_target(
        Some(workspace),
    );
    if let Some(snapshot) =
        workspace_thread_runtime_snapshot(Some(workspace), home.as_deref(), thread_id)
    {
        if let Some(path) = snapshot.rollout_path {
            return Some(path);
        }
    }
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
    let rebuilt_items = tokio::time::timeout(
        std::time::Duration::from_secs(THREADS_REFRESH_STUCK_SECS as u64),
        rebuild_workspace_thread_items(target),
    )
    .await;
    let rebuild_ms = i64::try_from(started.elapsed().as_millis()).unwrap_or(i64::MAX);
    let mut index = lock_threads_workspace_index();
    let bucket = workspace_bucket_mut(&mut index, target);
    match rebuilt_items {
        Ok(Ok(rebuilt_items)) => {
            let retained_live_items = retained_live_notification_items(&bucket.items);
            bucket.items = merge_items_without_duplicates(rebuilt_items, retained_live_items);
            sort_threads_by_updated_desc(&mut bucket.items);
            bucket.updated_at_unix_secs = current_unix_secs();
        }
        Ok(Err(err)) => {
            log::warn!("failed to rebuild {:?} Codex thread index: {err}", target);
        }
        Err(_) => {
            log::warn!("timed out rebuilding {:?} Codex thread index", target);
        }
    }
    clear_bucket_refreshing(bucket);
    bucket.last_rebuild_ms = rebuild_ms;
}

async fn ensure_workspace_index_fresh(target: WorkspaceTarget, force: bool) {
    if force {
        let wait_started = std::time::Instant::now();
        loop {
            let action = {
                let mut index = lock_threads_workspace_index();
                let bucket = workspace_bucket_mut(&mut index, target);
                if bucket.refreshing && !bucket_refresh_is_stuck(bucket, current_unix_secs()) {
                    None
                } else {
                    mark_bucket_refreshing(bucket);
                    Some(())
                }
            };
            if action.is_some() {
                refresh_workspace_thread_index(target).await;
                return;
            }
            if wait_started.elapsed() >= std::time::Duration::from_millis(THREADS_FORCE_WAIT_MAX_MS)
            {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    }

    let now = current_unix_secs();
    enum Action {
        None,
        SyncRefresh,
        AsyncRefresh,
    }
    let action = {
        let mut index = lock_threads_workspace_index();
        let bucket = workspace_bucket_mut(&mut index, target);
        if bucket_refresh_is_stuck(bucket, now) {
            clear_bucket_refreshing(bucket);
        }
        let has_items = !bucket.items.is_empty();
        let stale = now.saturating_sub(bucket.updated_at_unix_secs) >= THREADS_INDEX_STALE_SECS;
        let has_missing_rollout = has_missing_session_rollout_path(&bucket.items);
        if (!has_items || has_missing_rollout) && !bucket.refreshing {
            mark_bucket_refreshing(bucket);
            Action::SyncRefresh
        } else if stale && !bucket.refreshing {
            mark_bucket_refreshing(bucket);
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
        find_rollout_path_in_items, has_missing_session_rollout_path,
        invalidate_thread_list_cache_all, list_threads_snapshot, lock_threads_workspace_index,
        upsert_thread_item_hint, upsert_thread_notification_hint, workspace_bucket_mut,
        workspace_bucket_ref, THREADS_REFRESH_STUCK_SECS,
    };
    use crate::codex_app_server;
    use crate::orchestrator::gateway::web_codex_home::WorkspaceTarget;
    use crate::orchestrator::gateway::web_codex_session_runtime::upsert_workspace_thread_runtime;
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
        let _test_guard = codex_app_server::lock_test_globals();
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
                match method {
                    "thread/loaded/list" => Ok(serde_json::json!({ "data": [] })),
                    other => Err(format!("{other} should not be called for sidebar index")),
                }
            },
        )))
        .await;

        let snapshot = list_threads_snapshot(Some(WorkspaceTarget::Windows), true).await;
        codex_app_server::_set_test_request_handler(None).await;

        let calls = rpc_calls.lock().expect("rpc calls").clone();
        assert_eq!(
            calls,
            vec!["thread/loaded/list"],
            "unexpected RPC calls: {calls:?}"
        );
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

    #[tokio::test]
    async fn upsert_thread_item_hint_makes_new_thread_visible_immediately() {
        let _test_guard = codex_app_server::lock_test_globals();
        invalidate_thread_list_cache_all();

        upsert_thread_item_hint(
            WorkspaceTarget::Windows,
            serde_json::json!({
                "id": "thread-live",
                "workspace": "windows",
                "preview": "build exe",
                "path": "C:\\temp\\rollout-live.jsonl",
                "status": { "type": "running" },
                "updatedAt": 1742269999
            }),
        );

        let snapshot = list_threads_snapshot(Some(WorkspaceTarget::Windows), false).await;
        let item = snapshot
            .items
            .iter()
            .find(|item| item.get("id").and_then(Value::as_str) == Some("thread-live"))
            .expect("injected thread item");
        assert_eq!(
            item.get("path").and_then(Value::as_str),
            Some("C:\\temp\\rollout-live.jsonl")
        );
        assert_eq!(
            item.get("status")
                .and_then(Value::as_object)
                .and_then(|status| status.get("type"))
                .and_then(Value::as_str),
            Some("running")
        );
    }

    #[tokio::test]
    async fn known_rollout_path_prefers_session_runtime_registry() {
        let _test_guard = codex_app_server::lock_test_globals();
        invalidate_thread_list_cache_all();
        let _guard = EnvGuard::set("API_ROUTER_WEB_CODEX_CODEX_HOME", r"C:\Users\yiyou\.codex");
        upsert_workspace_thread_runtime(
            Some(WorkspaceTarget::Windows),
            Some(r"C:\Users\yiyou\.codex"),
            crate::orchestrator::gateway::web_codex_session_runtime::WorkspaceThreadRuntimeUpdate {
                thread_id: "thread-runtime",
                cwd: Some(r"C:\repo"),
                rollout_path: Some(r"C:\repo\.codex\sessions\rollout-thread-runtime.jsonl"),
                status: Some("running"),
                last_event_id: Some(42),
                last_turn_id: Some("turn-1"),
            },
        );

        let path =
            super::known_rollout_path_for_thread(WorkspaceTarget::Windows, "thread-runtime").await;
        assert_eq!(
            path.as_deref(),
            Some(r"C:\repo\.codex\sessions\rollout-thread-runtime.jsonl")
        );
    }

    #[tokio::test]
    async fn live_notification_hint_carries_rollout_path_and_preview() {
        let _test_guard = codex_app_server::lock_test_globals();
        invalidate_thread_list_cache_all();

        upsert_thread_notification_hint(
            WorkspaceTarget::Wsl2,
            &serde_json::json!({
                "method": "codex/event/response_item",
                "params": {
                    "rolloutPath": "/home/yiyou/.codex/sessions/rollout-live.jsonl",
                    "cwd": "/home/yiyou/repo",
                    "payload": {
                        "type": "message",
                        "role": "user",
                        "thread_id": "thread-live",
                        "content": [{ "type": "input_text", "text": "build exe" }]
                    }
                }
            }),
        );

        {
            let index = lock_threads_workspace_index();
            let bucket = workspace_bucket_ref(&index, WorkspaceTarget::Wsl2);
            assert_eq!(
                bucket.items.len(),
                1,
                "live hint should be inserted immediately"
            );
            assert_eq!(
                bucket.items[0].get("id").and_then(Value::as_str),
                Some("thread-live")
            );
        }

        let snapshot = list_threads_snapshot(Some(WorkspaceTarget::Wsl2), false).await;
        let item = snapshot
            .items
            .iter()
            .find(|item| item.get("id").and_then(Value::as_str) == Some("thread-live"))
            .expect("live notification thread item");
        assert_eq!(
            item.get("path").and_then(Value::as_str),
            Some("/home/yiyou/.codex/sessions/rollout-live.jsonl")
        );
        assert_eq!(
            item.get("cwd").and_then(Value::as_str),
            Some("/home/yiyou/repo")
        );
        assert_eq!(
            item.get("preview").and_then(Value::as_str),
            Some("build exe")
        );
    }

    #[tokio::test]
    async fn live_notification_hint_ignores_permissions_instruction_preview() {
        let _test_guard = codex_app_server::lock_test_globals();
        invalidate_thread_list_cache_all();

        upsert_thread_notification_hint(
            WorkspaceTarget::Windows,
            &serde_json::json!({
                "method": "codex/event/response_item",
                "params": {
                    "rolloutPath": "C:\\Users\\yiyou\\.codex\\sessions\\rollout-live.jsonl",
                    "cwd": "C:\\Users\\yiyou\\API-Router",
                    "payload": {
                        "type": "message",
                        "role": "developer",
                        "thread_id": "thread-live",
                        "content": [{
                            "type": "input_text",
                            "text": "<permissions instructions>\nFilesystem sandboxing defines which files can be read or written."
                        }]
                    }
                }
            }),
        );

        let snapshot = list_threads_snapshot(Some(WorkspaceTarget::Windows), false).await;
        let item = snapshot
            .items
            .iter()
            .find(|item| item.get("id").and_then(Value::as_str) == Some("thread-live"))
            .expect("live notification thread item");
        assert!(
            item.get("preview").is_none(),
            "permissions scaffolding should not become thread preview"
        );
    }

    #[tokio::test]
    async fn live_notification_hint_ignores_test_temp_threads() {
        let _test_guard = codex_app_server::lock_test_globals();
        invalidate_thread_list_cache_all();

        upsert_thread_notification_hint(
            WorkspaceTarget::Windows,
            &serde_json::json!({
                "method": "codex/event/response_item",
                "params": {
                    "rolloutPath": "C:\\Users\\yiyou\\.codex\\sessions\\rollout-live.jsonl",
                    "cwd": "C:\\Users\\yiyou\\API-Router\\.tmp-codex-web-real-send-1234",
                    "payload": {
                        "type": "message",
                        "role": "user",
                        "thread_id": "thread-test",
                        "content": [{
                            "type": "input_text",
                            "text": "Reply with OK only. [codex-web-real-send 1234]"
                        }]
                    }
                }
            }),
        );

        let snapshot = list_threads_snapshot(Some(WorkspaceTarget::Windows), false).await;
        assert!(
            snapshot
                .items
                .iter()
                .all(|item| { item.get("id").and_then(Value::as_str) != Some("thread-test") }),
            "test temp threads should not survive as live-notification items"
        );
    }

    #[tokio::test]
    async fn live_notification_hint_ignores_subagent_threads() {
        let _test_guard = codex_app_server::lock_test_globals();
        invalidate_thread_list_cache_all();

        upsert_thread_notification_hint(
            WorkspaceTarget::Windows,
            &serde_json::json!({
                "method": "codex/event/response_item",
                "params": {
                    "rolloutPath": "C:\\Users\\yiyou\\.codex\\sessions\\rollout-subagent.jsonl",
                    "cwd": "C:\\Users\\yiyou\\API-Router",
                    "source": {
                        "subagent": {
                            "thread_spawn": {
                                "parent_thread_id": "parent-thread"
                            }
                        }
                    },
                    "payload": {
                        "type": "message",
                        "role": "assistant",
                        "thread_id": "thread-subagent",
                        "content": [{
                            "type": "output_text",
                            "text": "In repo C:\\Users\\yiyou\\API-Router..."
                        }]
                    }
                }
            }),
        );

        let snapshot = list_threads_snapshot(Some(WorkspaceTarget::Windows), false).await;
        assert!(
            snapshot
                .items
                .iter()
                .all(|item| item.get("id").and_then(Value::as_str) != Some("thread-subagent")),
            "subagent live notifications should not surface in sidebar"
        );
    }

    #[tokio::test]
    async fn live_notification_hint_ignores_agent_role_threads() {
        let _test_guard = codex_app_server::lock_test_globals();
        invalidate_thread_list_cache_all();

        upsert_thread_notification_hint(
            WorkspaceTarget::Windows,
            &serde_json::json!({
                "method": "thread/updated",
                "params": {
                    "threadId": "thread-agent-role",
                    "cwd": "C:\\Users\\yiyou\\API-Router",
                    "thread": {
                        "id": "thread-agent-role",
                        "agent_role": "explorer",
                        "agent_nickname": "McClintock"
                    },
                    "payload": {
                        "thread_id": "thread-agent-role",
                        "message": "In repo C:\\Users\\yiyou\\API-Router, inspect..."
                    }
                }
            }),
        );

        let snapshot = list_threads_snapshot(Some(WorkspaceTarget::Windows), false).await;
        assert!(
            snapshot
                .items
                .iter()
                .all(|item| item.get("id").and_then(Value::as_str) != Some("thread-agent-role")),
            "agent-role live notifications should not surface in sidebar"
        );
    }

    #[tokio::test]
    async fn list_threads_snapshot_rebuilds_when_cached_session_rollout_is_missing() {
        let _test_guard = codex_app_server::lock_test_globals();
        let temp = tempfile::tempdir().expect("tempdir");
        let codex_home = temp.path().join(".codex");
        std::fs::create_dir_all(codex_home.join("sessions")).expect("sessions dir");
        let _guard = EnvGuard::set(
            "API_ROUTER_WEB_CODEX_CODEX_HOME",
            &codex_home.to_string_lossy(),
        );

        invalidate_thread_list_cache_all();
        upsert_thread_item_hint(
            WorkspaceTarget::Windows,
            serde_json::json!({
                "id": "missing-thread",
                "workspace": "windows",
                "preview": "stale",
                "path": "C:\\temp\\definitely-missing-rollout.jsonl",
                "source": "windows-session-index",
                "status": { "type": "notLoaded" },
                "updatedAt": 1742269999
            }),
        );
        {
            let index = lock_threads_workspace_index();
            let bucket = workspace_bucket_ref(&index, WorkspaceTarget::Windows);
            assert!(
                !bucket.refreshing,
                "cached missing-rollout hint should not start as refreshing"
            );
            assert!(
                has_missing_session_rollout_path(&bucket.items),
                "cached missing-rollout hint should force rebuild"
            );
        }

        codex_app_server::_set_test_request_handler(Some(Arc::new(
            move |_home, method, _params| match method {
                "thread/loaded/list" => Ok(serde_json::json!({ "data": [] })),
                other => Err(format!(
                    "{other} should not be called for missing-rollout rebuild"
                )),
            },
        )))
        .await;
        let snapshot = list_threads_snapshot(Some(WorkspaceTarget::Windows), false).await;
        codex_app_server::_set_test_request_handler(None).await;
        assert!(
            snapshot.items.is_empty(),
            "missing session rollout path should force rebuild and drop stale cached item: {:?}",
            snapshot.items
        );
    }

    #[tokio::test]
    async fn list_threads_snapshot_rebuilds_when_hint_rollout_is_missing() {
        let _test_guard = codex_app_server::lock_test_globals();
        let temp = tempfile::tempdir().expect("tempdir");
        let codex_home = temp.path().join(".codex");
        std::fs::create_dir_all(codex_home.join("sessions")).expect("sessions dir");
        let _guard = EnvGuard::set(
            "API_ROUTER_WEB_CODEX_CODEX_HOME",
            &codex_home.to_string_lossy(),
        );

        invalidate_thread_list_cache_all();
        upsert_thread_item_hint(
            WorkspaceTarget::Windows,
            serde_json::json!({
                "id": "missing-hint-thread",
                "workspace": "windows",
                "preview": "stale",
                "path": "\\\\?\\C:\\Users\\yiyou\\.codex\\sessions\\2026\\03\\19\\rollout-missing-hint-thread.jsonl",
                "source": "app-server-thread-start",
                "status": { "type": "notLoaded" },
                "updatedAt": 1742269999
            }),
        );
        {
            let index = lock_threads_workspace_index();
            let bucket = workspace_bucket_ref(&index, WorkspaceTarget::Windows);
            assert!(
                !bucket.refreshing,
                "cached missing hinted rollout should not start as refreshing"
            );
            assert!(
                has_missing_session_rollout_path(&bucket.items),
                "cached missing hinted rollout should force rebuild"
            );
        }

        codex_app_server::_set_test_request_handler(Some(Arc::new(
            move |_home, method, _params| match method {
                "thread/loaded/list" => Ok(serde_json::json!({ "data": [] })),
                other => Err(format!(
                    "{other} should not be called for missing-hint-rollout rebuild"
                )),
            },
        )))
        .await;
        let snapshot = list_threads_snapshot(Some(WorkspaceTarget::Windows), false).await;
        codex_app_server::_set_test_request_handler(None).await;
        assert!(
            snapshot.items.is_empty(),
            "missing hinted rollout path should force rebuild and drop stale cached item: {:?}",
            snapshot.items
        );
    }

    #[tokio::test]
    async fn force_refresh_recovers_stale_refresh_lock() {
        let _test_guard = codex_app_server::lock_test_globals();
        let temp = tempfile::tempdir().expect("tempdir");
        let codex_home = temp.path().join(".codex");
        let sessions = codex_home
            .join("sessions")
            .join("2026")
            .join("03")
            .join("19");
        std::fs::create_dir_all(&sessions).expect("sessions dir");
        let thread_id = "019d0632-813e-7341-a914-39b8424f2a7e";
        let rollout = sessions.join(format!("rollout-2026-03-19T21-04-26-{thread_id}.jsonl"));
        std::fs::write(
            &rollout,
            format!(
                "{{\"type\":\"session_meta\",\"payload\":{{\"id\":\"{thread_id}\",\"cwd\":\"C:\\\\Users\\\\yiyou\\\\API-Router\",\"created_at\":1742340000}}}}\n\
{{\"type\":\"response_item\",\"payload\":{{\"type\":\"message\",\"role\":\"user\",\"content\":[{{\"type\":\"input_text\",\"text\":\"build exe\"}}]}}}}\n"
            ),
        )
        .expect("rollout write");
        std::fs::write(
            codex_home.join("history.jsonl"),
            format!("{{\"session_id\":\"{thread_id}\",\"text\":\"build exe\"}}\n"),
        )
        .expect("history write");

        let _guard = EnvGuard::set(
            "API_ROUTER_WEB_CODEX_CODEX_HOME",
            &codex_home.to_string_lossy(),
        );
        invalidate_thread_list_cache_all();
        {
            let mut index = lock_threads_workspace_index();
            let bucket = workspace_bucket_mut(&mut index, WorkspaceTarget::Windows);
            bucket.refreshing = true;
            bucket.refresh_started_at_unix_secs =
                super::current_unix_secs() - THREADS_REFRESH_STUCK_SECS - 1;
            bucket.items = vec![serde_json::json!({
                "id": "stale-cached-thread",
                "workspace": "windows",
                "preview": "stale",
                "path": "C:\\temp\\stale.jsonl",
                "updatedAt": 1742330000
            })];
        }

        codex_app_server::_set_test_request_handler(Some(Arc::new(
            move |_home, method, _params| match method {
                "thread/loaded/list" => Ok(serde_json::json!({ "data": [] })),
                other => Err(format!(
                    "{other} should not be called for stale-refresh recovery"
                )),
            },
        )))
        .await;
        let snapshot = tokio::time::timeout(
            std::time::Duration::from_secs(3),
            list_threads_snapshot(Some(WorkspaceTarget::Windows), true),
        )
        .await
        .expect("force refresh should not hang");
        codex_app_server::_set_test_request_handler(None).await;

        let item = snapshot
            .items
            .iter()
            .find(|item| item.get("id").and_then(Value::as_str) == Some(thread_id))
            .expect("rebuilt thread item");
        assert_eq!(
            item.get("preview").and_then(Value::as_str),
            Some("build exe")
        );
        let index = lock_threads_workspace_index();
        let bucket = workspace_bucket_ref(&index, WorkspaceTarget::Windows);
        assert!(
            !bucket.refreshing,
            "stale refresh lock should be cleared after rebuild"
        );
    }
}
