use crate::orchestrator::gateway::web_codex_home::WorkspaceTarget;
use crate::orchestrator::gateway::web_codex_session_runtime::workspace_thread_runtime_snapshot;
use chrono::DateTime;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::Arc;

mod source;

type JsonMap = serde_json::Map<String, Value>;

use self::source::{
    find_rollout_path_in_items, has_missing_session_rollout_path, is_auxiliary_thread_preview_text,
    is_filtered_test_thread_cwd, merge_items_without_duplicates, normalize_thread_items_shape,
    rebuild_workspace_thread_items, sort_threads_by_updated_desc, thread_item_should_be_visible,
};

const THREADS_WINDOWS_INDEX_STALE_SECS: i64 = 45;
const THREADS_WSL2_INDEX_STALE_SECS: i64 = 180;
const THREADS_REFRESH_STUCK_SECS: i64 = 12;
const THREADS_REFRESH_FAILURE_BACKOFF_SECS: i64 = 15;
const THREADS_FORCE_WAIT_MAX_MS: u64 = 1500;

#[derive(Default)]
struct WorkspaceThreadsBucket {
    items: Vec<Value>,
    updated_at_unix_secs: i64,
    refreshing: bool,
    refresh_started_at_unix_secs: i64,
    last_failed_at_unix_secs: i64,
    last_rebuild_ms: i64,
    revision: u64,
}

#[derive(Clone)]
struct MergedThreadSnapshotCache {
    windows_revision: u64,
    wsl2_revision: u64,
    items: Arc<Vec<Value>>,
}

impl Default for MergedThreadSnapshotCache {
    fn default() -> Self {
        Self {
            windows_revision: 0,
            wsl2_revision: 0,
            items: Arc::new(Vec::new()),
        }
    }
}

#[derive(Default)]
struct ThreadsWorkspaceIndex {
    windows: WorkspaceThreadsBucket,
    wsl2: WorkspaceThreadsBucket,
    merged_snapshot_cache: MergedThreadSnapshotCache,
}

#[derive(Clone)]
pub(super) struct ThreadListSnapshot {
    pub(super) items: Vec<Value>,
    pub(super) cache_hit: bool,
    pub(super) rebuild_ms: i64,
    pub(super) refreshing: bool,
}

#[derive(Clone)]
pub(crate) struct CachedThreadIndexSnapshot {
    pub(crate) items: Arc<Vec<Value>>,
    pub(crate) fresh: bool,
}

fn current_unix_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|v| v.as_secs() as i64)
        .unwrap_or(0)
}

fn thread_index_stale_secs(target: WorkspaceTarget) -> i64 {
    match target {
        WorkspaceTarget::Windows => THREADS_WINDOWS_INDEX_STALE_SECS,
        WorkspaceTarget::Wsl2 => THREADS_WSL2_INDEX_STALE_SECS,
    }
}

fn workspace_bucket_is_stale(
    target: WorkspaceTarget,
    bucket: &WorkspaceThreadsBucket,
    now_unix_secs: i64,
) -> bool {
    now_unix_secs.saturating_sub(bucket.updated_at_unix_secs) >= thread_index_stale_secs(target)
}

fn parse_timestamp_secs(value: &Value) -> Option<i64> {
    match value {
        Value::Number(number) => number.as_i64().map(|raw| {
            if raw.abs() >= 1_000_000_000_000 {
                raw / 1000
            } else {
                raw
            }
        }),
        Value::String(text) => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                return None;
            }
            if let Ok(raw) = trimmed.parse::<i64>() {
                return Some(if raw.abs() >= 1_000_000_000_000 {
                    raw / 1000
                } else {
                    raw
                });
            }
            DateTime::parse_from_rfc3339(trimmed)
                .ok()
                .map(|value| value.timestamp())
        }
        _ => None,
    }
}

struct NotificationScopes<'a> {
    notification: &'a Value,
    params: Option<&'a JsonMap>,
    thread: Option<&'a JsonMap>,
    item: Option<&'a JsonMap>,
    payload: Option<&'a JsonMap>,
    method_lower: String,
}

fn extract_notification_status_value(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_ascii_lowercase())
            }
        }
        Value::Object(map) => map
            .get("type")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| value.to_ascii_lowercase()),
        _ => None,
    }
}

pub(crate) fn explicit_notification_status(params: Option<&JsonMap>) -> Option<String> {
    let params = params?;
    params
        .get("status")
        .and_then(extract_notification_status_value)
        .or_else(|| {
            params
                .get("turn")
                .and_then(Value::as_object)
                .and_then(|turn| turn.get("status"))
                .and_then(extract_notification_status_value)
        })
        .or_else(|| {
            params
                .get("thread")
                .and_then(Value::as_object)
                .and_then(|thread| thread.get("status"))
                .and_then(extract_notification_status_value)
        })
}

impl<'a> NotificationScopes<'a> {
    fn new(notification: &'a Value) -> Self {
        let params = notification
            .get("params")
            .and_then(Value::as_object)
            .or_else(|| notification.get("payload").and_then(Value::as_object));
        let thread = params.and_then(|map| map.get("thread").and_then(Value::as_object));
        let item = params
            .and_then(|map| map.get("item").and_then(Value::as_object))
            .or_else(|| params.and_then(|map| map.get("payload").and_then(Value::as_object)));
        let payload = params
            .and_then(|map| map.get("payload").and_then(Value::as_object))
            .or(item);
        let method_lower = notification
            .get("method")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default()
            .to_ascii_lowercase();
        Self {
            notification,
            params,
            thread,
            item,
            payload,
            method_lower,
        }
    }

    fn first_non_empty_str(&self, objects: &[Option<&JsonMap>], keys: &[&str]) -> Option<String> {
        objects.iter().flatten().find_map(|map| {
            keys.iter()
                .find_map(|key| map.get(*key).and_then(Value::as_str))
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        })
    }

    fn thread_id(&self) -> Option<String> {
        self.first_non_empty_str(
            &[self.params, self.item, self.payload],
            &["threadId", "thread_id"],
        )
    }

    fn rollout_path(&self) -> Option<String> {
        self.first_non_empty_str(
            &[self.params, self.thread, self.item, self.payload],
            &["rolloutPath", "rollout_path", "path"],
        )
    }

    fn cwd(&self) -> Option<String> {
        self.first_non_empty_str(
            &[self.params, self.thread, self.item, self.payload],
            &["cwd"],
        )
    }

    fn parent_thread_id(&self) -> Option<String> {
        self.first_non_empty_str(
            &[self.params, self.thread, self.item, self.payload],
            &[
                "parentThreadId",
                "parent_thread_id",
                "agentParentSessionId",
                "agent_parent_session_id",
            ],
        )
        .or_else(|| {
            self.params
                .and_then(|params| params.get("source"))
                .and_then(Value::as_object)
                .and_then(|source| source.get("subagent").or_else(|| source.get("subAgent")))
                .and_then(Value::as_object)
                .and_then(|subagent| {
                    subagent
                        .get("thread_spawn")
                        .or_else(|| subagent.get("threadSpawn"))
                })
                .and_then(Value::as_object)
                .and_then(|spawn| {
                    spawn
                        .get("parent_thread_id")
                        .or_else(|| spawn.get("parentThreadId"))
                })
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        })
    }

    fn agent_role(&self) -> Option<String> {
        self.first_non_empty_str(
            &[self.thread, self.item, self.payload, self.params],
            &["agentRole", "agent_role"],
        )
        .or_else(|| {
            self.params
                .and_then(|params| params.get("source"))
                .and_then(Value::as_object)
                .and_then(|source| source.get("subagent").or_else(|| source.get("subAgent")))
                .and_then(Value::as_object)
                .and_then(|subagent| {
                    subagent
                        .get("thread_spawn")
                        .or_else(|| subagent.get("threadSpawn"))
                })
                .and_then(Value::as_object)
                .and_then(|spawn| spawn.get("agent_role").or_else(|| spawn.get("agentRole")))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        })
    }

    fn status(&self) -> Option<String> {
        let explicit_status = explicit_notification_status(self.params);
        explicit_status.clone().or_else(|| {
            if self.method_lower.contains("turn/started") {
                Some("running".to_string())
            } else if matches!(
                explicit_status.as_deref(),
                Some("failed" | "error" | "denied" | "timeout")
            ) {
                Some("failed".to_string())
            } else if matches!(
                explicit_status.as_deref(),
                Some("cancelled" | "interrupted")
            ) {
                Some("interrupted".to_string())
            } else if self.method_lower.contains("turn/completed")
                || self.method_lower.contains("turn/finished")
            {
                Some("completed".to_string())
            } else if self.method_lower.contains("turn/failed") {
                Some("failed".to_string())
            } else if self.method_lower.contains("turn/cancelled") {
                Some("interrupted".to_string())
            } else {
                None
            }
        })
    }

    fn preview(&self) -> Option<String> {
        let preview = self
            .payload
            .and_then(|payload| payload.get("content").and_then(Value::as_array))
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

    fn timestamp_secs(&self) -> Option<i64> {
        self.notification
            .get("timestamp")
            .or_else(|| self.params.and_then(|value| value.get("timestamp")))
            .or_else(|| self.payload.and_then(|value| value.get("timestamp")))
            .and_then(parse_timestamp_secs)
    }
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

#[cfg(test)]
pub(super) fn clear_threads_workspace_index_for_test() {
    *lock_threads_workspace_index() = ThreadsWorkspaceIndex::default();
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

fn workspace_target_label(target: WorkspaceTarget) -> &'static str {
    match target {
        WorkspaceTarget::Windows => "windows",
        WorkspaceTarget::Wsl2 => "wsl2",
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
        .filter(thread_item_should_be_visible)
        .filter(|item| {
            !item
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

fn mark_bucket_items_changed(bucket: &mut WorkspaceThreadsBucket) {
    bucket.revision = bucket.revision.wrapping_add(1);
}

fn merged_thread_items_snapshot(index: &mut ThreadsWorkspaceIndex) -> Arc<Vec<Value>> {
    let windows_revision = index.windows.revision;
    let wsl2_revision = index.wsl2.revision;
    let cache = &index.merged_snapshot_cache;
    if cache.windows_revision == windows_revision && cache.wsl2_revision == wsl2_revision {
        return cache.items.clone();
    }

    let mut merged =
        merge_items_without_duplicates(index.windows.items.clone(), index.wsl2.items.clone());
    sort_threads_by_updated_desc(&mut merged);
    let merged = Arc::new(merged);
    index.merged_snapshot_cache = MergedThreadSnapshotCache {
        windows_revision,
        wsl2_revision,
        items: merged.clone(),
    };
    merged
}

fn log_thread_index_rebuild_delta(
    target: WorkspaceTarget,
    previous_items: &[Value],
    next_items: &[Value],
    rebuild_ms: i64,
) {
    let previous_ids = previous_items
        .iter()
        .filter_map(|item| {
            item.get("id")
                .or_else(|| item.get("threadId"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        })
        .collect::<HashSet<_>>();
    let next_ids = next_items
        .iter()
        .filter_map(|item| {
            item.get("id")
                .or_else(|| item.get("threadId"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        })
        .collect::<HashSet<_>>();
    let mut added_ids = next_ids
        .difference(&previous_ids)
        .cloned()
        .collect::<Vec<_>>();
    let mut removed_ids = previous_ids
        .difference(&next_ids)
        .cloned()
        .collect::<Vec<_>>();
    added_ids.sort();
    removed_ids.sort();
    if added_ids.is_empty() && removed_ids.is_empty() {
        return;
    }
    let _ =
        crate::orchestrator::gateway::web_codex_storage::append_codex_live_trace_entry(&json!({
            "source": "thread.index",
            "entry": {
                "at": crate::orchestrator::store::unix_ms(),
                "kind": "thread.index.rebuild.delta",
                "workspace": match target {
                    WorkspaceTarget::Windows => "windows",
                    WorkspaceTarget::Wsl2 => "wsl2",
                },
                "rebuildMs": rebuild_ms,
                "previousCount": previous_items.len(),
                "nextCount": next_items.len(),
                "addedIds": added_ids,
                "removedIds": removed_ids,
            }
        }));
}

fn bucket_refresh_is_stuck(bucket: &WorkspaceThreadsBucket, now_unix_secs: i64) -> bool {
    bucket.refreshing
        && (bucket.refresh_started_at_unix_secs <= 0
            || now_unix_secs.saturating_sub(bucket.refresh_started_at_unix_secs)
                >= THREADS_REFRESH_STUCK_SECS)
}

fn bucket_refresh_failure_backoff_active(
    bucket: &WorkspaceThreadsBucket,
    now_unix_secs: i64,
) -> bool {
    bucket.last_failed_at_unix_secs > 0
        && now_unix_secs.saturating_sub(bucket.last_failed_at_unix_secs)
            < THREADS_REFRESH_FAILURE_BACKOFF_SECS
}

pub(super) fn invalidate_thread_list_cache_all() {
    let mut index = lock_threads_workspace_index();
    index.windows = WorkspaceThreadsBucket::default();
    index.wsl2 = WorkspaceThreadsBucket::default();
    index.merged_snapshot_cache = MergedThreadSnapshotCache::default();
}

pub(super) fn upsert_thread_item_hint(workspace: WorkspaceTarget, item: Value) {
    let mut normalized = vec![item];
    normalize_thread_items_shape(&mut normalized);
    let Some(item) = normalized.into_iter().next() else {
        return;
    };
    if !thread_item_should_be_visible(&item) {
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
    mark_bucket_items_changed(bucket);
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
                    .is_some_and(|value| !value.is_null());
                has_subagent || map.values().any(|child| scan(child, depth + 1))
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

pub(super) fn upsert_thread_notification_hint(workspace: WorkspaceTarget, notification: &Value) {
    let scopes = NotificationScopes::new(notification);
    let Some(thread_id) = scopes.thread_id() else {
        return;
    };
    let is_subagent = notification_is_subagent(notification);
    if is_subagent {
        return;
    }
    if scopes.agent_role().is_some() && !is_subagent {
        return;
    }
    let cwd = scopes.cwd();
    if cwd
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
        "updatedAt": scopes.timestamp_secs().unwrap_or_else(current_unix_secs),
    });
    if is_subagent {
        if let Some(obj) = item.as_object_mut() {
            obj.insert("isSubagent".to_string(), Value::Bool(true));
        }
    }
    if let Some(parent_thread_id) = scopes.parent_thread_id() {
        if let Some(obj) = item.as_object_mut() {
            obj.insert(
                "agent_parent_session_id".to_string(),
                Value::String(parent_thread_id),
            );
        }
    }
    if let Some(agent_role) = scopes.agent_role() {
        if let Some(obj) = item.as_object_mut() {
            obj.insert("agentRole".to_string(), Value::String(agent_role));
        }
    }
    if let Some(path) = scopes.rollout_path() {
        if let Some(obj) = item.as_object_mut() {
            obj.insert("path".to_string(), Value::String(path));
        }
    }
    if let Some(cwd) = cwd {
        if let Some(obj) = item.as_object_mut() {
            obj.insert("cwd".to_string(), Value::String(cwd));
        }
    }
    if let Some(preview) = scopes.preview() {
        if let Some(obj) = item.as_object_mut() {
            obj.insert("preview".to_string(), Value::String(preview.clone()));
            obj.insert("title".to_string(), Value::String(preview));
        }
    }
    if let Some(status) = scopes.status() {
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
            spawn_thread_index_refresh(target);
        }
    }
}

pub(crate) fn cached_threads_snapshot_stale_while_revalidate() -> CachedThreadIndexSnapshot {
    let now = current_unix_secs();
    let mut refresh_targets = Vec::new();
    {
        let mut index = lock_threads_workspace_index();
        for target in [WorkspaceTarget::Windows, WorkspaceTarget::Wsl2] {
            let bucket = workspace_bucket_mut(&mut index, target);
            if bucket_refresh_is_stuck(bucket, now) {
                clear_bucket_refreshing(bucket);
            }
            let has_items = !bucket.items.is_empty();
            let stale = workspace_bucket_is_stale(target, bucket, now);
            let has_missing_rollout = has_missing_session_rollout_path(&bucket.items);
            if (!has_items || stale || has_missing_rollout)
                && !bucket.refreshing
                && !bucket_refresh_failure_backoff_active(bucket, now)
            {
                mark_bucket_refreshing(bucket);
                refresh_targets.push(target);
            }
        }
    }

    for target in refresh_targets {
        spawn_thread_index_refresh(target);
    }

    let mut index = lock_threads_workspace_index();
    let merged = merged_thread_items_snapshot(&mut index);
    let windows = workspace_bucket_ref(&index, WorkspaceTarget::Windows);
    let wsl2 = workspace_bucket_ref(&index, WorkspaceTarget::Wsl2);
    let fresh = [
        (WorkspaceTarget::Windows, windows),
        (WorkspaceTarget::Wsl2, wsl2),
    ]
    .into_iter()
    .all(|(target, bucket)| {
        bucket.updated_at_unix_secs > 0 && !workspace_bucket_is_stale(target, bucket, now)
    });
    CachedThreadIndexSnapshot {
        items: merged,
        fresh,
    }
}

fn spawn_thread_index_refresh(target: WorkspaceTarget) {
    tauri::async_runtime::spawn(async move {
        refresh_workspace_thread_index(target).await;
    });
}

pub(super) async fn list_threads_snapshot(
    workspace: Option<WorkspaceTarget>,
    force: bool,
) -> ThreadListSnapshot {
    match workspace {
        Some(target) => list_workspace_snapshot(target, force).await,
        None if !force => {
            let snapshot = cached_threads_snapshot_stale_while_revalidate();
            ThreadListSnapshot {
                items: snapshot.items.as_ref().clone(),
                cache_hit: snapshot.fresh,
                rebuild_ms: 0,
                refreshing: !snapshot.fresh,
            }
        }
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
                refreshing: windows.refreshing || wsl2.refreshing,
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
        refreshing: bucket.refreshing,
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
    let (ok, item_count, detail, metrics) = {
        let mut index = lock_threads_workspace_index();
        let bucket = workspace_bucket_mut(&mut index, target);
        let mut ok = true;
        let mut detail = None;
        let mut metrics = None;
        match rebuilt_items {
            Ok(Ok(rebuilt)) => {
                metrics = rebuilt.metrics;
                let rebuilt_items = rebuilt.items;
                let previous_items = bucket.items.clone();
                let retained_live_items = retained_live_notification_items(&bucket.items);
                let mut next_items =
                    merge_items_without_duplicates(rebuilt_items, retained_live_items);
                sort_threads_by_updated_desc(&mut next_items);
                if previous_items != next_items {
                    mark_bucket_items_changed(bucket);
                }
                bucket.items = next_items;
                bucket.updated_at_unix_secs = current_unix_secs();
                bucket.last_failed_at_unix_secs = 0;
                log_thread_index_rebuild_delta(target, &previous_items, &bucket.items, rebuild_ms);
            }
            Ok(Err(err)) => {
                log::warn!("failed to rebuild {:?} Codex thread index: {err}", target);
                bucket.last_failed_at_unix_secs = current_unix_secs();
                ok = false;
                detail = Some(err);
            }
            Err(_) => {
                log::warn!("timed out rebuilding {:?} Codex thread index", target);
                bucket.last_failed_at_unix_secs = current_unix_secs();
                ok = false;
                detail = Some("thread index rebuild timed out".to_string());
            }
        }
        clear_bucket_refreshing(bucket);
        bucket.last_rebuild_ms = rebuild_ms;
        (ok, bucket.items.len(), detail, metrics)
    };
    let mut pipeline = crate::diagnostics::codex_web_pipeline::CodexWebPipelineEvent::new(
        "/codex/threads",
        workspace_target_label(target),
        "session_index_rebuild",
        u64::try_from(rebuild_ms).unwrap_or(u64::MAX),
    );
    pipeline.source = Some("session-index".to_string());
    pipeline.item_count = Some(item_count);
    pipeline.ok = Some(ok);
    pipeline.detail = detail;
    pipeline.metrics = metrics;
    crate::diagnostics::codex_web_pipeline::append_pipeline_event(pipeline);
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
        AsyncRefresh,
    }
    let action = {
        let mut index = lock_threads_workspace_index();
        let bucket = workspace_bucket_mut(&mut index, target);
        if bucket_refresh_is_stuck(bucket, now) {
            clear_bucket_refreshing(bucket);
        }
        let has_items = !bucket.items.is_empty();
        let stale = workspace_bucket_is_stale(target, bucket, now);
        let has_missing_rollout = has_missing_session_rollout_path(&bucket.items);
        let in_failure_backoff = bucket_refresh_failure_backoff_active(bucket, now);
        let needs_refresh = !bucket.refreshing
            && !in_failure_backoff
            && (!has_items || has_missing_rollout || stale);

        if needs_refresh {
            mark_bucket_refreshing(bucket);
            Action::AsyncRefresh
        } else {
            Action::None
        }
    };

    match action {
        Action::None => {}
        Action::AsyncRefresh => spawn_thread_index_refresh(target),
    }
}

#[cfg(test)]
#[allow(clippy::await_holding_lock)]
mod tests {
    use super::{
        find_rollout_path_in_items, has_missing_session_rollout_path,
        invalidate_thread_list_cache_all, list_threads_snapshot, lock_threads_workspace_index,
        thread_index_stale_secs, upsert_thread_item_hint, upsert_thread_notification_hint,
        workspace_bucket_is_stale, workspace_bucket_mut, workspace_bucket_ref, NotificationScopes,
        WorkspaceThreadsBucket, THREADS_REFRESH_STUCK_SECS, THREADS_WINDOWS_INDEX_STALE_SECS,
        THREADS_WSL2_INDEX_STALE_SECS,
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

    async fn wait_for_workspace_refresh_to_finish(target: WorkspaceTarget) {
        for _ in 0..40 {
            {
                let index = lock_threads_workspace_index();
                if !workspace_bucket_ref(&index, target).refreshing {
                    return;
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
    }

    #[test]
    fn wsl_thread_index_stays_fresh_longer_than_windows_index() {
        assert!(
            thread_index_stale_secs(WorkspaceTarget::Wsl2)
                > thread_index_stale_secs(WorkspaceTarget::Windows)
        );
        let bucket = WorkspaceThreadsBucket {
            updated_at_unix_secs: 1_000,
            ..WorkspaceThreadsBucket::default()
        };

        assert!(workspace_bucket_is_stale(
            WorkspaceTarget::Windows,
            &bucket,
            1_000 + THREADS_WINDOWS_INDEX_STALE_SECS
        ));
        assert!(!workspace_bucket_is_stale(
            WorkspaceTarget::Wsl2,
            &bucket,
            1_000 + THREADS_WINDOWS_INDEX_STALE_SECS
        ));
        assert!(workspace_bucket_is_stale(
            WorkspaceTarget::Wsl2,
            &bucket,
            1_000 + THREADS_WSL2_INDEX_STALE_SECS
        ));
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

    #[test]
    fn notification_scope_status_keeps_failed_turn_completed_failed() {
        let notification = serde_json::json!({
            "method": "turn/completed",
            "params": {
                "threadId": "thread-1",
                "status": "failed"
            }
        });
        let scopes = NotificationScopes::new(&notification);
        assert_eq!(scopes.status().as_deref(), Some("failed"));
    }

    #[test]
    fn notification_scope_status_keeps_nested_failed_turn_completed_failed() {
        let notification = serde_json::json!({
            "method": "turn/completed",
            "params": {
                "threadId": "thread-1",
                "turn": {
                    "id": "turn-1",
                    "status": "failed"
                }
            }
        });
        let scopes = NotificationScopes::new(&notification);
        assert_eq!(scopes.status().as_deref(), Some("failed"));
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
                clear_last_turn_id: false,
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

        let index = lock_threads_workspace_index();
        let bucket = workspace_bucket_ref(&index, WorkspaceTarget::Windows);
        assert!(
            bucket
                .items
                .iter()
                .all(|item| { item.get("id").and_then(Value::as_str) != Some("thread-test") }),
            "test temp threads should not survive as live-notification items"
        );
    }

    #[tokio::test]
    async fn live_notification_hint_drops_subagent_threads() {
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
                                "parent_thread_id": "parent-thread",
                                "agent_role": "explorer"
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
            "subagent live notification thread items should stay out of the sidebar"
        );
    }

    #[tokio::test]
    async fn live_notification_hint_drops_string_subagent_threads() {
        let _test_guard = codex_app_server::lock_test_globals();
        invalidate_thread_list_cache_all();

        upsert_thread_notification_hint(
            WorkspaceTarget::Windows,
            &serde_json::json!({
                "method": "codex/event/response_item",
                "params": {
                    "rolloutPath": "C:\\Users\\yiyou\\.codex\\sessions\\rollout-review.jsonl",
                    "cwd": "C:\\Users\\yiyou\\API-Router",
                    "source": {
                        "subagent": "review"
                    },
                    "payload": {
                        "type": "message",
                        "role": "assistant",
                        "thread_id": "thread-string-subagent",
                        "content": [{
                            "type": "output_text",
                            "text": "review finding"
                        }]
                    }
                }
            }),
        );

        let snapshot = list_threads_snapshot(Some(WorkspaceTarget::Windows), false).await;
        assert!(
            snapshot.items.iter().all(|item| {
                item.get("id").and_then(Value::as_str) != Some("thread-string-subagent")
            }),
            "string-shaped subagent live notifications should stay out of the sidebar"
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

        let index = lock_threads_workspace_index();
        let snapshot = workspace_bucket_ref(&index, WorkspaceTarget::Windows);
        assert!(
            snapshot
                .items
                .iter()
                .all(|item| item.get("id").and_then(Value::as_str) != Some("thread-agent-role")),
            "agent-role live notifications should not surface in sidebar"
        );
    }

    #[tokio::test]
    async fn live_notification_hint_uses_notification_timestamp_for_updated_at() {
        let _test_guard = codex_app_server::lock_test_globals();
        invalidate_thread_list_cache_all();

        upsert_thread_notification_hint(
            WorkspaceTarget::Windows,
            &serde_json::json!({
                "method": "turn/started",
                "timestamp": "2026-03-24T18:48:43.600Z",
                "params": {
                    "threadId": "thread-timestamp",
                    "cwd": "C:\\Users\\yiyou\\API-Router",
                    "rolloutPath": "C:\\Users\\yiyou\\.codex\\sessions\\2026\\03\\24\\rollout-thread-timestamp.jsonl"
                }
            }),
        );

        let snapshot = list_threads_snapshot(Some(WorkspaceTarget::Windows), false).await;
        let item = snapshot
            .items
            .iter()
            .find(|candidate| {
                candidate.get("id").and_then(Value::as_str) == Some("thread-timestamp")
            })
            .expect("thread timestamp item");
        assert_eq!(
            item.get("updatedAt").and_then(Value::as_i64),
            Some(1774378123)
        );
    }

    #[tokio::test]
    async fn list_threads_snapshot_refreshes_cached_missing_rollout_in_background() {
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
        wait_for_workspace_refresh_to_finish(WorkspaceTarget::Windows).await;
        codex_app_server::_set_test_request_handler(None).await;
        invalidate_thread_list_cache_all();
        assert!(snapshot.refreshing);
        assert_eq!(
            snapshot
                .items
                .first()
                .and_then(|item| item.get("id"))
                .and_then(Value::as_str),
            Some("missing-thread")
        );
    }

    #[tokio::test]
    async fn list_threads_snapshot_refreshes_missing_hint_rollout_in_background() {
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
        wait_for_workspace_refresh_to_finish(WorkspaceTarget::Windows).await;
        codex_app_server::_set_test_request_handler(None).await;
        invalidate_thread_list_cache_all();
        assert!(snapshot.refreshing);
        assert_eq!(
            snapshot
                .items
                .first()
                .and_then(|item| item.get("id"))
                .and_then(Value::as_str),
            Some("missing-hint-thread")
        );
    }

    #[tokio::test]
    async fn cold_non_force_workspace_snapshot_returns_before_rebuild_finishes() {
        let _test_guard = codex_app_server::lock_test_globals();
        let temp = tempfile::tempdir().expect("tempdir");
        let codex_home = temp.path().join(".codex");
        std::fs::create_dir_all(codex_home.join("sessions")).expect("sessions dir");
        let _guard = EnvGuard::set(
            "API_ROUTER_WEB_CODEX_CODEX_HOME",
            &codex_home.to_string_lossy(),
        );
        invalidate_thread_list_cache_all();

        codex_app_server::_set_test_request_handler(Some(Arc::new(
            move |_home, method, _params| {
                if method == "thread/loaded/list" {
                    std::thread::sleep(std::time::Duration::from_millis(200));
                    return Ok(serde_json::json!({ "data": [] }));
                }
                Err(format!("{method} should not be called for cold list"))
            },
        )))
        .await;

        let started = std::time::Instant::now();
        let snapshot = list_threads_snapshot(Some(WorkspaceTarget::Windows), false).await;
        let elapsed = started.elapsed();
        wait_for_workspace_refresh_to_finish(WorkspaceTarget::Windows).await;
        codex_app_server::_set_test_request_handler(None).await;
        invalidate_thread_list_cache_all();

        assert!(
            elapsed < std::time::Duration::from_millis(100),
            "cold non-force list should return without waiting for rebuild"
        );
        assert!(snapshot.items.is_empty());
        assert!(snapshot.refreshing);
        assert!(!snapshot.cache_hit);
    }

    #[test]
    fn cached_threads_snapshot_stale_while_revalidate_does_not_require_tokio_runtime() {
        let _test_guard = codex_app_server::lock_test_globals();
        super::clear_threads_workspace_index_for_test();

        let snapshot = super::cached_threads_snapshot_stale_while_revalidate();

        assert!(snapshot.items.is_empty());
        assert!(!snapshot.fresh);
    }

    #[test]
    fn cached_threads_snapshot_stale_while_revalidate_reuses_merged_items_when_unchanged() {
        let _test_guard = codex_app_server::lock_test_globals();
        invalidate_thread_list_cache_all();
        upsert_thread_item_hint(
            WorkspaceTarget::Windows,
            serde_json::json!({
                "id": "thread-win",
                "workspace": "windows",
                "preview": "windows",
                "path": "C:\\temp\\thread-win.jsonl",
                "updatedAt": 1742330000
            }),
        );
        upsert_thread_item_hint(
            WorkspaceTarget::Wsl2,
            serde_json::json!({
                "id": "thread-wsl",
                "workspace": "wsl2",
                "preview": "wsl2",
                "path": "/tmp/thread-wsl.jsonl",
                "updatedAt": 1742331000
            }),
        );

        let first = super::cached_threads_snapshot_stale_while_revalidate();
        let second = super::cached_threads_snapshot_stale_while_revalidate();

        assert_eq!(first.items.len(), 2);
        assert_eq!(second.items.len(), 2);
        assert!(
            std::ptr::eq(first.items.as_ptr(), second.items.as_ptr()),
            "unchanged thread index should reuse merged snapshot backing storage"
        );
    }

    #[test]
    fn invalidate_thread_list_cache_all_drops_stale_merged_snapshot_cache() {
        let _test_guard = codex_app_server::lock_test_globals();
        invalidate_thread_list_cache_all();
        upsert_thread_item_hint(
            WorkspaceTarget::Windows,
            serde_json::json!({
                "id": "old-thread-win",
                "workspace": "windows",
                "preview": "old-windows",
                "path": "C:\\temp\\old-thread-win.jsonl",
                "updatedAt": 1742330000
            }),
        );
        upsert_thread_item_hint(
            WorkspaceTarget::Wsl2,
            serde_json::json!({
                "id": "old-thread-wsl",
                "workspace": "wsl2",
                "preview": "old-wsl2",
                "path": "/tmp/old-thread-wsl.jsonl",
                "updatedAt": 1742331000
            }),
        );
        let old_snapshot = super::cached_threads_snapshot_stale_while_revalidate();
        assert_eq!(old_snapshot.items.len(), 2);
        assert!(old_snapshot
            .items
            .iter()
            .any(|item| item.get("id").and_then(Value::as_str) == Some("old-thread-win")));

        invalidate_thread_list_cache_all();
        upsert_thread_item_hint(
            WorkspaceTarget::Windows,
            serde_json::json!({
                "id": "new-thread-win",
                "workspace": "windows",
                "preview": "new-windows",
                "path": "C:\\temp\\new-thread-win.jsonl",
                "updatedAt": 1742332000
            }),
        );
        upsert_thread_item_hint(
            WorkspaceTarget::Wsl2,
            serde_json::json!({
                "id": "new-thread-wsl",
                "workspace": "wsl2",
                "preview": "new-wsl2",
                "path": "/tmp/new-thread-wsl.jsonl",
                "updatedAt": 1742333000
            }),
        );

        let new_snapshot = super::cached_threads_snapshot_stale_while_revalidate();
        let ids = new_snapshot
            .items
            .iter()
            .filter_map(|item| item.get("id").and_then(Value::as_str))
            .collect::<Vec<_>>();

        assert_eq!(
            ids,
            vec!["new-thread-wsl", "new-thread-win"],
            "invalidation must drop stale merged snapshot cache before new hints reuse the same revisions"
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

    #[tokio::test]
    async fn merged_thread_snapshot_does_not_wait_for_wsl_refreshing_empty_bucket() {
        let _test_guard = codex_app_server::lock_test_globals();
        invalidate_thread_list_cache_all();
        upsert_thread_item_hint(
            WorkspaceTarget::Windows,
            serde_json::json!({
                "id": "thread-win",
                "workspace": "windows",
                "source": "session-index",
                "updatedAt": 1742331000
            }),
        );
        {
            let mut index = lock_threads_workspace_index();
            let bucket = workspace_bucket_mut(&mut index, WorkspaceTarget::Wsl2);
            bucket.items.clear();
            bucket.refreshing = true;
            bucket.refresh_started_at_unix_secs = super::current_unix_secs();
        }

        let snapshot = tokio::time::timeout(
            std::time::Duration::from_millis(250),
            list_threads_snapshot(None, false),
        )
        .await
        .expect("merged snapshot should not wait for WSL2 background refresh");

        assert_eq!(snapshot.items.len(), 1);
        assert_eq!(
            snapshot.items[0].get("id").and_then(Value::as_str),
            Some("thread-win")
        );
    }

    #[tokio::test]
    async fn wsl2_thread_snapshot_does_not_wait_for_existing_background_refresh() {
        let _test_guard = codex_app_server::lock_test_globals();
        invalidate_thread_list_cache_all();
        {
            let mut index = lock_threads_workspace_index();
            let bucket = workspace_bucket_mut(&mut index, WorkspaceTarget::Wsl2);
            bucket.items.clear();
            bucket.refreshing = true;
            bucket.refresh_started_at_unix_secs = super::current_unix_secs();
        }

        let snapshot = tokio::time::timeout(
            std::time::Duration::from_millis(250),
            list_threads_snapshot(Some(WorkspaceTarget::Wsl2), false),
        )
        .await
        .expect("WSL2 snapshot should return cache while refresh runs in background");

        assert!(snapshot.items.is_empty());
        let index = lock_threads_workspace_index();
        let bucket = workspace_bucket_ref(&index, WorkspaceTarget::Wsl2);
        assert!(bucket.refreshing);
    }

    #[test]
    fn cached_thread_snapshot_respects_wsl2_failure_backoff() {
        let _test_guard = codex_app_server::lock_test_globals();
        invalidate_thread_list_cache_all();
        {
            let mut index = lock_threads_workspace_index();
            let bucket = workspace_bucket_mut(&mut index, WorkspaceTarget::Wsl2);
            bucket.items.clear();
            bucket.refreshing = false;
            bucket.last_failed_at_unix_secs = super::current_unix_secs();
        }

        let snapshot = super::cached_threads_snapshot_stale_while_revalidate();

        assert!(snapshot.items.is_empty());
        let index = lock_threads_workspace_index();
        let bucket = workspace_bucket_ref(&index, WorkspaceTarget::Wsl2);
        assert!(
            !bucket.refreshing,
            "recent WSL2 failure should not immediately start another refresh"
        );
    }
}
