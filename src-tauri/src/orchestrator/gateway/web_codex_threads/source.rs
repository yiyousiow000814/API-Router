use super::current_unix_secs;
use crate::orchestrator::gateway::session_meta_identity::SessionMetaIdentity;
use crate::orchestrator::gateway::web_codex_home::{
    default_windows_codex_dir, web_codex_wsl_session_home_for_launch, WorkspaceTarget,
};
#[cfg(test)]
use crate::orchestrator::gateway::web_codex_rollout_path::session_candidate_should_replace_existing;
use crate::orchestrator::gateway::web_codex_session_manager::{
    overlay_runtime_thread_item, runtime_thread_payload, CodexSessionManager,
};
use rusqlite::{Connection, OpenFlags};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use tokio::process::Command;

const THREADS_MAX_AGE_SECS: i64 = 30 * 24 * 60 * 60;
const THREADS_MAX_ITEMS: usize = 600;
const WSL_SCAN_TIMEOUT_SECS: u64 = 5;
const LOADED_THREAD_OVERLAY_TIMEOUT_MS: u64 = 750;
const LOADED_THREAD_OVERLAY_MAX_ITEMS: usize = 48;
const VISIBLE_SESSION_SOURCES: &[&str] = &["cli", "vscode", "exec"];

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub(super) struct SessionFileIdentityHint {
    pub(super) is_subagent: bool,
    pub(super) agent_parent_session_id: Option<String>,
    pub(super) agent_role: Option<String>,
}

#[derive(Clone)]
struct SessionFileScanCacheEntry {
    file_len: u64,
    modified_unix_ms: u128,
    scan: Option<SessionFileScan>,
}

#[derive(Clone)]
#[cfg(test)]
struct HistoryPreviewMapCacheEntry {
    file_len: u64,
    modified_unix_ms: u128,
    previews: HashMap<String, String>,
}

pub(super) struct ThreadRebuildResult {
    pub(super) items: Vec<Value>,
    pub(super) metrics: Option<Value>,
}

struct ThreadFetchResult {
    items: Vec<Value>,
    metrics: Option<Value>,
}

struct WslThreadScanResult {
    items: Vec<Value>,
    metrics: Option<Value>,
}

fn session_file_scan_cache() -> &'static Mutex<HashMap<PathBuf, SessionFileScanCacheEntry>> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, SessionFileScanCacheEntry>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

#[cfg(test)]
fn history_preview_map_cache() -> &'static Mutex<HashMap<PathBuf, HistoryPreviewMapCacheEntry>> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, HistoryPreviewMapCacheEntry>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ThreadFilterReason {
    TemporaryWorkspace,
    AuxiliaryPromptOnly,
    SyntheticProbe,
}

impl ThreadFilterReason {
    fn as_str(self) -> &'static str {
        match self {
            Self::TemporaryWorkspace => "temporary-workspace",
            Self::AuxiliaryPromptOnly => "auxiliary-prompt-only",
            Self::SyntheticProbe => "synthetic-probe",
        }
    }
}

pub(super) async fn rebuild_workspace_thread_items(
    target: WorkspaceTarget,
) -> Result<ThreadRebuildResult, String> {
    let fetched = match target {
        WorkspaceTarget::Windows => {
            fetch_windows_threads_from_sessions().map(|items| ThreadFetchResult {
                items,
                metrics: None,
            })
        }
        WorkspaceTarget::Wsl2 => fetch_wsl2_threads_from_sessions().await,
    };
    let ThreadFetchResult { mut items, metrics } = fetched?;
    overlay_loaded_thread_runtime(target, &mut items).await;
    normalize_thread_items_shape(&mut items);
    filter_auxiliary_threads(&mut items);
    filter_threads_within_last_month(&mut items);
    sort_threads_by_updated_desc(&mut items);
    if items.len() > THREADS_MAX_ITEMS {
        items.truncate(THREADS_MAX_ITEMS);
    }
    Ok(ThreadRebuildResult { items, metrics })
}

async fn overlay_loaded_thread_runtime(target: WorkspaceTarget, items: &mut Vec<Value>) {
    let manager = CodexSessionManager::new(Some(target));
    let loaded_ids = match tokio::time::timeout(
        std::time::Duration::from_millis(LOADED_THREAD_OVERLAY_TIMEOUT_MS),
        manager.loaded_thread_ids(),
    )
    .await
    {
        Ok(Ok(ids)) => ids,
        Ok(Err(_)) | Err(_) => return,
    };
    if loaded_ids.is_empty() {
        return;
    }
    let mut loaded_threads = Vec::new();
    for thread_id in loaded_ids.iter().take(LOADED_THREAD_OVERLAY_MAX_ITEMS) {
        let response = match manager.read_thread(thread_id, false).await {
            Ok(value) => value,
            Err(_) => continue,
        };
        if runtime_thread_payload(&response).is_none() {
            continue;
        }
        loaded_threads.push(response);
    }

    let mut index_by_id = HashMap::new();
    for (index, item) in items.iter().enumerate() {
        let id = item
            .get("id")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default();
        if !id.is_empty() {
            index_by_id.insert(id.to_string(), index);
        }
    }

    for response in loaded_threads {
        let Some(thread) = runtime_thread_payload(&response) else {
            continue;
        };
        let Some(thread_obj) = thread.as_object() else {
            continue;
        };
        let thread_id = thread_obj
            .get("id")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default()
            .to_string();
        if thread_id.is_empty() {
            continue;
        }
        let existing_index = index_by_id.get(&thread_id).copied();
        match existing_index {
            Some(index) => {
                if let Some(item) = items.get_mut(index) {
                    overlay_runtime_thread_item(item, &response);
                }
            }
            None => {
                let mut synthesized = json!({
                    "id": thread_id,
                    "workspace": match target {
                        WorkspaceTarget::Windows => "windows",
                        WorkspaceTarget::Wsl2 => "wsl2",
                    },
                    "source": "app-server-loaded-thread",
                    "status": { "type": "notLoaded" }
                });
                overlay_runtime_thread_item(&mut synthesized, &response);
                index_by_id.insert(
                    synthesized
                        .get("id")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    items.len(),
                );
                items.push(synthesized);
            }
        }
    }

    let loaded_id_set = loaded_ids
        .into_iter()
        .collect::<std::collections::HashSet<_>>();
    for thread_id in loaded_id_set {
        if index_by_id.contains_key(&thread_id) {
            continue;
        }
        items.push(json!({
            "id": thread_id,
            "workspace": match target {
                WorkspaceTarget::Windows => "windows",
                WorkspaceTarget::Wsl2 => "wsl2",
            },
            "source": "app-server-loaded-thread",
            "status": { "type": "idle" }
        }));
    }
}

fn normalize_preview_text(raw: &str) -> Option<String> {
    let text = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    let mut out = trimmed.to_string();
    if out.chars().count() > 120 {
        out = out.chars().take(119).collect::<String>() + "\u{2026}";
    }
    Some(out)
}

fn is_auxiliary_preview(preview: &str) -> bool {
    let text = preview.trim().to_ascii_lowercase();
    text.starts_with("# agents.md instructions")
        || text.starts_with("<permissions instructions>")
        || text.starts_with("review the code changes against the base branch")
}

fn is_synthetic_probe_preview(preview: &str) -> bool {
    let text = preview.trim().to_ascii_lowercase();
    text == "say ok only"
        || text == "say ok only."
        || text.starts_with("reply with ok only.")
        || text.starts_with("reply with ok only [")
        || text.starts_with("reply with ok only. [")
        || text.starts_with("reply with exactly")
        || (text.starts_with("reply with ")
            && (text.contains(" only") || text.contains("nothing else")))
        || text.starts_with("use the shell to ")
        || text.starts_with("<user_action>")
        || text.starts_with("<turn_aborted>")
        || text.starts_with("sync smoke test")
        || text.starts_with("embedfix_")
        || text.starts_with("livefix_")
        || text.starts_with("histchk_")
        || text.starts_with("live_real_")
        || text.starts_with("livee2e")
        || text.starts_with("zxqw_")
}

fn is_auxiliary_instruction_text(raw: &str) -> bool {
    let text = raw.trim().to_ascii_lowercase();
    text.contains("# agents.md instructions")
        || text.contains("<permissions instructions>")
        || text.contains("<environment_context>")
        || text.contains("<turn_context>")
        || text.contains("review the code changes against the base branch")
        || text.contains("another language model started to solve this problem")
        || text.contains("<user_action>")
        || text.contains("<turn_aborted>")
}

pub(super) fn is_auxiliary_thread_preview_text(raw: &str) -> bool {
    is_auxiliary_preview(raw)
        || is_auxiliary_instruction_text(raw)
        || is_synthetic_probe_preview(raw)
}

pub(super) fn is_filtered_test_thread_cwd(raw: &str) -> bool {
    let text = raw.trim().replace('/', "\\").to_ascii_lowercase();
    text.contains("\\.tmp-codex-web")
        || text.ends_with("\\usersyiyouapi-router")
        || text.ends_with("\\home\\yiyou\\.tmp-codex-web-live-sync-debug")
}

pub(super) fn scan_session_file_identity_hint(path: &Path) -> Option<SessionFileIdentityHint> {
    let scan = scan_session_file(path)?;
    Some(SessionFileIdentityHint {
        is_subagent: scan.is_subagent,
        agent_parent_session_id: scan.agent_parent_session_id,
        agent_role: scan.agent_role,
    })
}

#[cfg_attr(not(test), allow(dead_code))]
#[derive(Clone)]
struct SessionFileScan {
    id: String,
    cwd: String,
    created_at: i64,
    session_source: Option<Value>,
    is_subagent: bool,
    agent_parent_session_id: Option<String>,
    agent_role: Option<String>,
    preview: Option<String>,
    filter_reason: Option<ThreadFilterReason>,
}

struct ParsedSessionMeta {
    id: String,
    cwd: String,
    created_at: i64,
    session_source: Option<Value>,
    is_subagent: bool,
    agent_parent_session_id: Option<String>,
    agent_role: Option<String>,
}

fn is_visible_session_source(value: &Value) -> bool {
    value
        .as_str()
        .map(str::trim)
        .filter(|source| !source.is_empty())
        .is_some_and(|source| VISIBLE_SESSION_SOURCES.contains(&source))
}

pub(super) fn thread_item_should_be_visible(item: &Value) -> bool {
    if item
        .get("filterReason")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|reason| !reason.is_empty())
        .is_some()
    {
        return false;
    }

    if let Some(session_source) = item.get("sessionSource") {
        return is_visible_session_source(session_source);
    }

    let is_subagent = item
        .get("isSubagent")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if is_subagent {
        return false;
    }

    item.get("agentRole")
        .or_else(|| item.get("agent_role"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|role| !role.is_empty())
        .is_none()
}

fn session_file_fingerprint(path: &Path) -> Option<(u64, u128)> {
    let metadata = std::fs::metadata(path).ok()?;
    let modified = metadata.modified().ok()?;
    let modified_unix_ms = modified
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_millis();
    Some((metadata.len(), modified_unix_ms))
}

fn classify_thread_filter_reason(
    preview: Option<&str>,
    cwd: &str,
    _is_subagent: bool,
    auxiliary_prompt_only: bool,
) -> Option<ThreadFilterReason> {
    if is_filtered_test_thread_cwd(cwd) {
        return Some(ThreadFilterReason::TemporaryWorkspace);
    }
    if auxiliary_prompt_only {
        return Some(ThreadFilterReason::AuxiliaryPromptOnly);
    }
    let preview = preview.map(str::trim).unwrap_or_default();
    if !preview.is_empty() && is_synthetic_probe_preview(preview) {
        return Some(ThreadFilterReason::SyntheticProbe);
    }
    None
}

fn scan_session_file(path: &Path) -> Option<SessionFileScan> {
    let normalized_path = path.to_path_buf();
    let (file_len, modified_unix_ms) = session_file_fingerprint(path)?;
    {
        let cache = session_file_scan_cache();
        let guard = match cache.lock() {
            Ok(guard) => guard,
            Err(err) => err.into_inner(),
        };
        if let Some(entry) = guard.get(&normalized_path) {
            if entry.file_len == file_len && entry.modified_unix_ms == modified_unix_ms {
                return entry.scan.clone();
            }
        }
    }
    let scan = scan_session_file_uncached(path);
    {
        let cache = session_file_scan_cache();
        let mut guard = match cache.lock() {
            Ok(guard) => guard,
            Err(err) => err.into_inner(),
        };
        guard.insert(
            normalized_path,
            SessionFileScanCacheEntry {
                file_len,
                modified_unix_ms,
                scan: scan.clone(),
            },
        );
    }
    scan
}

fn scan_session_file_uncached(path: &Path) -> Option<SessionFileScan> {
    let file = File::open(path).ok()?;
    let reader = BufReader::new(file);
    let mut fallback_event_preview: Option<String> = None;
    let mut first_user_preview: Option<String> = None;
    let mut first_non_aux_user_preview: Option<String> = None;
    let mut meta: Option<ParsedSessionMeta> = None;
    let mut saw_aux_user_prompt = false;
    let mut saw_non_aux_user_prompt = false;
    for line in reader.lines().take(320).map_while(Result::ok) {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };
        if v.get("type").and_then(|x| x.as_str()) == Some("session_meta") && meta.is_none() {
            let identity = SessionMetaIdentity::from_session_meta_event(&v)?;
            let id = identity.session_id;
            let cwd = identity.cwd.unwrap_or_default();
            if !id.is_empty() && !cwd.is_empty() {
                meta = Some(ParsedSessionMeta {
                    id,
                    cwd,
                    created_at: identity.created_at.unwrap_or(0),
                    session_source: identity.source,
                    is_subagent: identity.is_agent,
                    agent_parent_session_id: identity.agent_parent_session_id,
                    agent_role: identity.agent_role,
                });
            }
            continue;
        }
        if v.get("type").and_then(|x| x.as_str()) == Some("event_msg")
            && fallback_event_preview.is_none()
        {
            if let Some(message) = v
                .get("payload")
                .and_then(|x| x.get("message"))
                .and_then(|x| x.as_str())
            {
                fallback_event_preview = normalize_preview_text(message);
            }
        }
        if v.get("type").and_then(|x| x.as_str()) != Some("response_item") {
            continue;
        }
        let payload = match v.get("payload").and_then(|x| x.as_object()) {
            Some(v) => v,
            None => continue,
        };
        if payload.get("type").and_then(|x| x.as_str()) != Some("message") {
            continue;
        }
        if payload.get("role").and_then(|x| x.as_str()) != Some("user") {
            continue;
        }
        let Some(content) = payload.get("content").and_then(|x| x.as_array()) else {
            continue;
        };
        for item in content {
            if let Some(text) = item.get("text").and_then(|x| x.as_str()) {
                let raw = text.trim();
                if raw.is_empty() {
                    continue;
                }
                if let Some(normalized) = normalize_preview_text(raw) {
                    if first_user_preview.is_none() {
                        first_user_preview = Some(normalized.clone());
                    }
                    if !is_auxiliary_thread_preview_text(raw)
                        && first_non_aux_user_preview.is_none()
                    {
                        first_non_aux_user_preview = Some(normalized);
                    }
                }
                if is_auxiliary_thread_preview_text(raw) {
                    saw_aux_user_prompt = true;
                } else {
                    saw_non_aux_user_prompt = true;
                }
                break;
            }
        }
    }
    let ParsedSessionMeta {
        id,
        cwd,
        created_at,
        session_source,
        is_subagent,
        agent_parent_session_id,
        agent_role,
    } = meta?;
    let preview = first_non_aux_user_preview
        .or(first_user_preview)
        .or(fallback_event_preview);
    let filter_reason = classify_thread_filter_reason(
        preview.as_deref(),
        &cwd,
        is_subagent,
        saw_aux_user_prompt && !saw_non_aux_user_prompt,
    );
    Some(SessionFileScan {
        id,
        cwd,
        created_at,
        session_source,
        is_subagent,
        agent_parent_session_id,
        agent_role,
        preview,
        filter_reason,
    })
}

#[cfg(test)]
fn file_updated_unix_secs(path: &Path) -> i64 {
    let modified = match std::fs::metadata(path).and_then(|m| m.modified()) {
        Ok(v) => v,
        Err(_) => return 0,
    };
    match modified.duration_since(std::time::UNIX_EPOCH) {
        Ok(v) => v.as_secs() as i64,
        Err(_) => 0,
    }
}

#[cfg(test)]
fn collect_jsonl_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let read = match std::fs::read_dir(dir) {
        Ok(v) => v,
        Err(_) => return,
    };
    let now_unix_secs = current_unix_secs();
    for entry in read.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_jsonl_files(&path, out);
            continue;
        }
        let is_jsonl = path
            .extension()
            .and_then(|v| v.to_str())
            .map(|v| v.eq_ignore_ascii_case("jsonl"))
            .unwrap_or(false);
        if is_jsonl {
            let updated_at = file_updated_unix_secs(&path);
            if updated_at > 0 && now_unix_secs.saturating_sub(updated_at) > THREADS_MAX_AGE_SECS {
                continue;
            }
            out.push(path);
        }
    }
}

#[cfg(test)]
fn parse_history_preview_map(history_path: &Path) -> HashMap<String, String> {
    let normalized_path = history_path.to_path_buf();
    if let Some((file_len, modified_unix_ms)) = session_file_fingerprint(history_path) {
        let cache = history_preview_map_cache();
        let guard = match cache.lock() {
            Ok(guard) => guard,
            Err(err) => err.into_inner(),
        };
        if let Some(entry) = guard.get(&normalized_path) {
            if entry.file_len == file_len && entry.modified_unix_ms == modified_unix_ms {
                return entry.previews.clone();
            }
        }
    }
    let mut map = HashMap::new();
    let file = match File::open(history_path) {
        Ok(v) => v,
        Err(_) => return map,
    };
    let reader = BufReader::new(file);
    for line in reader.lines().map_while(Result::ok) {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };
        let Some(id) = v
            .get("session_id")
            .and_then(|x| x.as_str())
            .map(str::trim)
            .filter(|x| !x.is_empty())
        else {
            continue;
        };
        let text = v
            .get("text")
            .and_then(|x| x.as_str())
            .and_then(normalize_preview_text);
        if let Some(text) = text {
            if !is_auxiliary_thread_preview_text(&text) {
                map.entry(id.to_string()).or_insert(text);
            }
        }
    }
    if let Some((file_len, modified_unix_ms)) = session_file_fingerprint(history_path) {
        let cache = history_preview_map_cache();
        let mut guard = match cache.lock() {
            Ok(guard) => guard,
            Err(err) => err.into_inner(),
        };
        guard.insert(
            normalized_path,
            HistoryPreviewMapCacheEntry {
                file_len,
                modified_unix_ms,
                previews: map.clone(),
            },
        );
    }
    map
}

fn parse_sqlite_session_source(raw: Option<String>) -> Option<Value> {
    let text = raw
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    serde_json::from_str::<Value>(text)
        .ok()
        .filter(|value| !value.is_null())
        .or_else(|| Some(Value::String(text.to_string())))
}

fn sqlite_thread_source_is_subagent(raw: &str) -> bool {
    let text = raw.trim().to_ascii_lowercase();
    text.contains("subagent") || text.contains("review")
}

fn sqlite_thread_table_columns(conn: &Connection) -> Result<HashSet<String>, String> {
    let mut stmt = conn
        .prepare("PRAGMA table_info(threads)")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>("name"))
        .map_err(|e| e.to_string())?;
    let mut columns = HashSet::new();
    for row in rows {
        columns.insert(row.map_err(|e| e.to_string())?);
    }
    Ok(columns)
}

fn sqlite_optional_column_expr(columns: &HashSet<String>, name: &str) -> String {
    if columns.contains(name) {
        format!("{name} AS {name}")
    } else {
        format!("NULL AS {name}")
    }
}

fn sqlite_time_expr(
    columns: &HashSet<String>,
    ms_column: &str,
    seconds_column: &str,
    fallback_expr: Option<&str>,
) -> String {
    let mut parts = Vec::new();
    if columns.contains(ms_column) {
        parts.push(ms_column.to_string());
    }
    if columns.contains(seconds_column) {
        parts.push(format!("{seconds_column} * 1000"));
    }
    if let Some(fallback_expr) = fallback_expr {
        parts.push(fallback_expr.to_string());
    }
    if parts.is_empty() {
        "0".to_string()
    } else {
        format!("COALESCE({}, 0)", parts.join(", "))
    }
}

fn normalize_optional_path_text(raw: Option<String>) -> Option<String> {
    raw.as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| normalize_thread_path(value).to_string_lossy().to_string())
}

fn sqlite_thread_item_from_row(
    row: &rusqlite::Row<'_>,
    workspace: &str,
    source: &str,
) -> rusqlite::Result<Option<Value>> {
    let id = row.get::<_, String>("id")?;
    let id = id.trim();
    if id.is_empty() {
        return Ok(None);
    }
    let path = row
        .get::<_, Option<String>>("rollout_path")?
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let cwd = normalize_optional_path_text(row.get::<_, Option<String>>("cwd")?);
    let title = row
        .get::<_, Option<String>>("title")?
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let preview = row
        .get::<_, Option<String>>("preview")?
        .as_deref()
        .and_then(normalize_preview_text)
        .or_else(|| title.as_deref().and_then(normalize_preview_text))
        .or_else(|| {
            row.get::<_, Option<String>>("first_user_message")
                .ok()
                .flatten()
                .as_deref()
                .and_then(normalize_preview_text)
        })
        .unwrap_or_default();
    let session_source = parse_sqlite_session_source(row.get::<_, Option<String>>("source")?);
    let thread_source = row
        .get::<_, Option<String>>("thread_source")?
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let agent_role = row
        .get::<_, Option<String>>("agent_role")?
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let created_at_ms = row.get::<_, i64>("created_at_ms_value")?;
    let updated_at_ms = row.get::<_, i64>("updated_at_ms_value")?;
    let is_subagent = session_source
        .as_ref()
        .and_then(crate::orchestrator::gateway::session_meta_identity::session_meta_source_subagent)
        .is_some()
        || thread_source
            .as_deref()
            .is_some_and(sqlite_thread_source_is_subagent)
        || agent_role.is_some();

    let mut item = json!({
        "id": id,
        "workspace": workspace,
        "source": source,
        "preview": preview,
        "status": { "type": "notLoaded" },
        "createdAt": created_at_ms,
        "updatedAt": updated_at_ms,
    });
    let Some(obj) = item.as_object_mut() else {
        return Ok(None);
    };
    if let Some(path) = path {
        obj.insert("path".to_string(), Value::String(path));
    }
    if let Some(cwd) = cwd {
        obj.insert("cwd".to_string(), Value::String(cwd));
    }
    if let Some(title) = title {
        obj.insert("title".to_string(), Value::String(title));
    }
    if let Some(session_source) = session_source {
        obj.insert("sessionSource".to_string(), session_source);
    }
    if let Some(thread_source) = thread_source {
        obj.insert("threadSource".to_string(), Value::String(thread_source));
    }
    if let Some(agent_role) = agent_role {
        obj.insert("agentRole".to_string(), Value::String(agent_role));
    }
    if is_subagent {
        obj.insert("isSubagent".to_string(), Value::Bool(true));
    }
    Ok(Some(item))
}

fn fetch_threads_from_state_sqlite(
    codex_dir: &Path,
    workspace: &str,
    source: &str,
) -> Result<Option<Vec<Value>>, String> {
    let state_path = codex_dir.join("state_5.sqlite");
    if !state_path.exists() || !state_path.is_file() {
        return Ok(None);
    }
    let conn = Connection::open_with_flags(&state_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| e.to_string())?;
    let columns = sqlite_thread_table_columns(&conn)?;
    if !columns.contains("id") {
        return Err("threads table missing id column".to_string());
    }
    let created_at_expr = sqlite_time_expr(&columns, "created_at_ms", "created_at", None);
    let updated_at_expr = sqlite_time_expr(
        &columns,
        "updated_at_ms",
        "updated_at",
        Some(&created_at_expr),
    );
    let archived_predicate = if columns.contains("archived") {
        "COALESCE(archived, 0) = 0".to_string()
    } else {
        "1 = 1".to_string()
    };
    let has_time_columns = columns.contains("created_at_ms")
        || columns.contains("created_at")
        || columns.contains("updated_at_ms")
        || columns.contains("updated_at");
    let age_predicate = if has_time_columns {
        format!("{updated_at_expr} >= ?1")
    } else {
        "1 = 1".to_string()
    };
    let query = format!(
        r#"
            SELECT
                id,
                {},
                {},
                {},
                {},
                {},
                {},
                {},
                {},
                {} AS created_at_ms_value,
                {} AS updated_at_ms_value
            FROM threads
            WHERE {}
              AND {}
            ORDER BY updated_at_ms_value DESC
        "#,
        sqlite_optional_column_expr(&columns, "rollout_path"),
        sqlite_optional_column_expr(&columns, "cwd"),
        sqlite_optional_column_expr(&columns, "source"),
        sqlite_optional_column_expr(&columns, "thread_source"),
        sqlite_optional_column_expr(&columns, "agent_role"),
        sqlite_optional_column_expr(&columns, "title"),
        sqlite_optional_column_expr(&columns, "preview"),
        sqlite_optional_column_expr(&columns, "first_user_message"),
        created_at_expr,
        updated_at_expr,
        archived_predicate,
        age_predicate,
    );
    let min_updated_ms = current_unix_secs()
        .saturating_sub(THREADS_MAX_AGE_SECS)
        .saturating_mul(1000);
    let mut stmt = conn.prepare(&query).map_err(|e| e.to_string())?;
    let mut items = Vec::new();
    if has_time_columns {
        let mut rows = stmt.query([min_updated_ms]).map_err(|e| e.to_string())?;
        while let Some(row) = rows.next().map_err(|e| e.to_string())? {
            if let Some(item) =
                sqlite_thread_item_from_row(row, workspace, source).map_err(|e| e.to_string())?
            {
                items.push(item);
            }
        }
    } else {
        let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
        while let Some(row) = rows.next().map_err(|e| e.to_string())? {
            if let Some(item) =
                sqlite_thread_item_from_row(row, workspace, source).map_err(|e| e.to_string())?
            {
                items.push(item);
            }
        }
    }
    Ok(Some(items))
}

fn fetch_windows_threads_from_sessions() -> Result<Vec<Value>, String> {
    let codex_dirs = windows_thread_index_codex_dirs();
    if codex_dirs.is_empty() {
        return Ok(Vec::new());
    };
    let mut items = Vec::new();
    for codex_dir in codex_dirs {
        match fetch_threads_from_state_sqlite(&codex_dir, "windows", "windows-session-index") {
            Ok(Some(sqlite_items)) => {
                items = merge_items_without_duplicates(items, sqlite_items);
            }
            Ok(None) => {}
            Err(error) => {
                return Err(format!(
                    "failed to read Windows Codex thread index sqlite at {}: {error}",
                    codex_dir.join("state_5.sqlite").to_string_lossy()
                ));
            }
        }
    }
    Ok(items)
}

fn push_unique_path(paths: &mut Vec<PathBuf>, path: Option<PathBuf>) {
    let Some(path) = path else {
        return;
    };
    if paths.iter().any(|existing| existing == &path) {
        return;
    }
    paths.push(path);
}

fn windows_thread_index_codex_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    push_unique_path(&mut dirs, default_windows_codex_dir());
    dirs
}

#[cfg(test)]
fn parse_wsl_thread_scan_output(text: &str) -> Result<Vec<Value>, String> {
    parse_wsl_thread_scan_result(text).map(|result| result.items)
}

fn parse_wsl_thread_scan_result(text: &str) -> Result<WslThreadScanResult, String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Ok(WslThreadScanResult {
            items: Vec::new(),
            metrics: None,
        });
    }
    let array_start = trimmed.find('[');
    let object_start = trimmed.find('{');
    let start = match (array_start, object_start) {
        (Some(array), Some(object)) => array.min(object),
        (Some(array), None) => array,
        (None, Some(object)) => object,
        (None, None) => {
            return Err("invalid WSL thread scan JSON: missing JSON payload".to_string())
        }
    };
    let json_text = &trimmed[start..];
    let value: Value = serde_json::from_str(json_text)
        .map_err(|err| format!("invalid WSL thread scan JSON: {err}"))?;
    match value {
        Value::Array(items) => Ok(WslThreadScanResult {
            items,
            metrics: None,
        }),
        Value::Object(mut obj) => {
            let items = obj
                .remove("items")
                .and_then(|value| value.as_array().cloned())
                .ok_or_else(|| "invalid WSL thread scan JSON: missing items array".to_string())?;
            let metrics = obj.remove("metrics");
            if let Some(sqlite_error) = metrics
                .as_ref()
                .and_then(Value::as_object)
                .and_then(|metrics| metrics.get("sqliteError"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                return Err(format!("WSL sqlite thread index failed: {sqlite_error}"));
            }
            Ok(WslThreadScanResult { items, metrics })
        }
        _ => Err("invalid WSL thread scan JSON: expected array or object".to_string()),
    }
}

fn shell_single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn wsl_thread_scan_script() -> String {
    format!(
        r###"python3 - <<'PY'
import json
import os
from pathlib import Path
import sqlite3
import time

MAX_ITEMS = {THREADS_MAX_ITEMS}
MAX_AGE_SECS = {THREADS_MAX_AGE_SECS}

def normalize_preview_text(raw):
    text = " ".join(str(raw).split()).strip()
    if not text:
        return None
    return text[:119] + "\u2026" if len(text) > 120 else text

def is_auxiliary_instruction_text(raw):
    text = str(raw).strip().lower()
    return (
        "# agents.md instructions" in text
        or "<permissions instructions>" in text
        or "<environment_context>" in text
        or "<turn_context>" in text
        or "review the code changes against the base branch" in text
        or "another language model started to solve this problem" in text
        or "<user_action>" in text
        or "<turn_aborted>" in text
    )

def is_synthetic_probe_preview(raw):
    text = str(raw).strip().lower()
    return (
        text == "say ok only"
        or text == "say ok only."
        or text.startswith("reply with ok only.")
        or text.startswith("reply with ok only [")
        or text.startswith("reply with ok only. [")
        or text.startswith("reply with exactly")
        or (text.startswith("reply with ") and (" only" in text or "nothing else" in text))
        or text.startswith("use the shell to ")
        or text.startswith("sync smoke test")
        or text.startswith("embedfix_")
        or text.startswith("livefix_")
        or text.startswith("histchk_")
        or text.startswith("live_real_")
        or text.startswith("livee2e")
        or text.startswith("zxqw_")
    )

def is_filtered_test_thread_cwd(raw):
    text = str(raw).strip().replace("/", "\\\\").lower()
    return (
        "\\\\.tmp-codex-web" in text
        or text.endswith("\\\\usersyiyouapi-router")
        or text.endswith("\\\\home\\\\yiyou\\\\.tmp-codex-web-live-sync-debug")
    )

def normalize_session_path_like(raw):
    text = str(raw or "").strip().replace("\\\\", "/")
    while "//" in text:
        text = text.replace("//", "/")
    if len(text) > 1:
        text = text.rstrip("/")
    return text.lower()

def classify_filter_reason(preview, cwd, auxiliary_prompt_only):
    if is_filtered_test_thread_cwd(cwd):
        return "temporary-workspace"
    if auxiliary_prompt_only:
        return "auxiliary-prompt-only"
    if preview and is_synthetic_probe_preview(preview):
        return "synthetic-probe"
    return None

def is_visible_candidate(item):
    if not isinstance(item, dict):
        return False
    filter_reason = item.get("filterReason")
    if isinstance(filter_reason, str) and filter_reason.strip():
        return False
    session_source = item.get("sessionSource")
    if session_source is not None:
        return isinstance(session_source, str) and session_source.strip() in ("cli", "vscode", "exec")
    if bool(item.get("isSubagent")):
        return False
    agent_role = item.get("agentRole") or item.get("agent_role")
    if isinstance(agent_role, str) and agent_role.strip():
        return False
    preview = item.get("preview") or item.get("title") or item.get("name") or ""
    if is_auxiliary_instruction_text(preview) or is_synthetic_probe_preview(preview):
        return False
    cwd = item.get("cwd") or ""
    if is_filtered_test_thread_cwd(cwd):
        return False
    return True

def int_or_none(raw):
    try:
        return int(raw)
    except Exception:
        return None

def parse_sqlite_session_source(raw):
    if raw is None:
        return None
    text = str(raw).strip()
    if not text:
        return None
    try:
        value = json.loads(text)
    except Exception:
        value = None
    return value if value is not None else text

def sqlite_thread_source_is_subagent(raw):
    text = str(raw or "").strip().lower()
    return "subagent" in text or "review" in text

def sqlite_optional_column_expr(columns, name):
    return f"{{name}} AS {{name}}" if name in columns else f"NULL AS {{name}}"

def sqlite_time_expr(columns, ms_column, seconds_column, fallback_expr=None):
    parts = []
    if ms_column in columns:
        parts.append(ms_column)
    if seconds_column in columns:
        parts.append(f"{{seconds_column}} * 1000")
    if fallback_expr:
        parts.append(fallback_expr)
    if not parts:
        return "0"
    return "COALESCE(" + ", ".join(parts) + ", 0)"

root = Path(os.environ.get("API_ROUTER_WSL_CODEX_HOME") or (Path.home() / ".codex"))
state_path = root / "state_5.sqlite"
distro = (os.environ.get("WSL_DISTRO_NAME") or "").strip()
started_ms = int(time.time() * 1000)
metrics = {{
    "indexSource": "sqlite",
    "outputItemCount": 0,
    "elapsedMs": 0,
}}

def to_windows_path(path_obj):
    text = str(path_obj or "").strip()
    if not text:
        return None
    if distro and text.startswith("/"):
        return "\\\\wsl.localhost\\{{}}\\{{}}".format(distro, text.lstrip("/").replace("/", "\\\\"))
    return text

def fetch_sqlite_items(state_path: Path):
    conn = sqlite3.connect(f"file:{{state_path}}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    columns = {{
        str(row["name"]).strip()
        for row in conn.execute("PRAGMA table_info(threads)")
        if row["name"] is not None
    }}
    if "id" not in columns:
        raise RuntimeError("threads table missing id column")
    created_at_expr = sqlite_time_expr(columns, "created_at_ms", "created_at")
    updated_at_expr = sqlite_time_expr(columns, "updated_at_ms", "updated_at", created_at_expr)
    archived_predicate = "COALESCE(archived, 0) = 0" if "archived" in columns else "1 = 1"
    has_time_columns = any(
        name in columns for name in ("created_at_ms", "created_at", "updated_at_ms", "updated_at")
    )
    age_predicate = f"{{updated_at_expr}} >= ?" if has_time_columns else "1 = 1"
    query = f"""
        SELECT
            id,
            {{sqlite_optional_column_expr(columns, "rollout_path")}},
            {{sqlite_optional_column_expr(columns, "cwd")}},
            {{sqlite_optional_column_expr(columns, "source")}},
            {{sqlite_optional_column_expr(columns, "thread_source")}},
            {{sqlite_optional_column_expr(columns, "agent_role")}},
            {{sqlite_optional_column_expr(columns, "title")}},
            {{sqlite_optional_column_expr(columns, "preview")}},
            {{sqlite_optional_column_expr(columns, "first_user_message")}},
            {{created_at_expr}} AS created_at_ms_value,
            {{updated_at_expr}} AS updated_at_ms_value
        FROM threads
        WHERE {{archived_predicate}}
          AND {{age_predicate}}
        ORDER BY updated_at_ms_value DESC
    """
    params = (int((time.time() - MAX_AGE_SECS) * 1000),) if has_time_columns else ()
    items = []
    for row in conn.execute(query, params):
        sid = str(row["id"] or "").strip()
        if not sid:
            continue
        raw_title = row["title"]
        title = str(raw_title).strip() if isinstance(raw_title, str) and raw_title.strip() else None
        preview = (
            normalize_preview_text(row["preview"])
            or (normalize_preview_text(title) if title else None)
            or normalize_preview_text(row["first_user_message"])
            or ""
        )
        session_source = parse_sqlite_session_source(row["source"])
        thread_source = (
            str(row["thread_source"]).strip()
            if isinstance(row["thread_source"], str) and row["thread_source"].strip()
            else None
        )
        agent_role = (
            str(row["agent_role"]).strip()
            if isinstance(row["agent_role"], str) and row["agent_role"].strip()
            else None
        )
        is_subagent = (
            isinstance(session_source, dict)
            and bool(session_source.get("subagent") or session_source.get("subAgent"))
        ) or (
            isinstance(session_source, str) and sqlite_thread_source_is_subagent(session_source)
        ) or (
            thread_source is not None and sqlite_thread_source_is_subagent(thread_source)
        ) or bool(agent_role)
        created_at = int_or_none(row["created_at_ms_value"]) or 0
        updated_at = int_or_none(row["updated_at_ms_value"]) or created_at
        cwd = str(row["cwd"]).strip() if isinstance(row["cwd"], str) and row["cwd"].strip() else ""
        filter_reason = classify_filter_reason(preview, cwd, False)
        candidate = {{
            "id": sid,
            "cwd": cwd,
            "workspace": "wsl2",
            "preview": preview,
            "source": "wsl-session-index",
            "isSubagent": is_subagent,
            "agentRole": agent_role,
            "isAuxiliary": filter_reason == "auxiliary-prompt-only",
            "filterReason": filter_reason,
            "status": {{"type": "notLoaded"}},
            "createdAt": created_at or updated_at,
            "updatedAt": updated_at,
        }}
        if title:
            candidate["title"] = title
        if session_source is not None:
            candidate["sessionSource"] = session_source
        if thread_source is not None:
            candidate["threadSource"] = thread_source
        path = to_windows_path(row["rollout_path"])
        if path:
            candidate["path"] = path
        if not is_visible_candidate(candidate):
            continue
        items.append(candidate)
        if len(items) >= MAX_ITEMS:
            break
    conn.close()
    return items

if not state_path.exists():
    metrics["disabledReason"] = "sqlite-not-found"
    metrics["elapsedMs"] = int(time.time() * 1000) - started_ms
    print(json.dumps({{"items": [], "metrics": metrics}}, ensure_ascii=False))
    raise SystemExit(0)

try:
    items = fetch_sqlite_items(state_path)
    metrics["outputItemCount"] = len(items)
    metrics["elapsedMs"] = int(time.time() * 1000) - started_ms
    print(json.dumps({{"items": items, "metrics": metrics}}, ensure_ascii=False))
except Exception as exc:
    metrics["sqliteError"] = str(exc)
    metrics["elapsedMs"] = int(time.time() * 1000) - started_ms
    print(json.dumps({{"items": [], "metrics": metrics}}, ensure_ascii=False))
PY"###
    )
}

async fn fetch_wsl2_threads_from_sessions() -> Result<ThreadFetchResult, String> {
    if !cfg!(target_os = "windows") {
        return Ok(ThreadFetchResult {
            items: Vec::new(),
            metrics: None,
        });
    }
    let Some(session_home) = web_codex_wsl_session_home_for_launch() else {
        return Ok(ThreadFetchResult {
            items: Vec::new(),
            metrics: Some(json!({
                "disabledReason": "wsl-not-configured",
            })),
        });
    };
    let script = format!(
        "export API_ROUTER_WSL_CODEX_HOME={};\n{}",
        shell_single_quote(&session_home.linux_path),
        wsl_thread_scan_script()
    );
    let mut cmd = Command::new("wsl.exe");
    if let Some(distro) = session_home
        .distro
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        cmd.arg("-d").arg(distro);
    }
    cmd.arg("-e").arg("bash").arg("-lc").arg(script);
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(0x08000000);
    }
    let output = match tokio::time::timeout(
        std::time::Duration::from_secs(WSL_SCAN_TIMEOUT_SECS),
        cmd.output(),
    )
    .await
    {
        Ok(Ok(v)) if v.status.success() => v,
        Ok(Ok(v)) => {
            let stderr = String::from_utf8_lossy(&v.stderr).trim().to_string();
            return Err(if stderr.is_empty() {
                "WSL thread scan failed".to_string()
            } else {
                stderr
            });
        }
        Ok(Err(err)) => return Err(format!("failed to launch WSL thread scan: {err}")),
        Err(_) => return Err("WSL thread scan timed out".to_string()),
    };
    let result = parse_wsl_thread_scan_result(&String::from_utf8_lossy(&output.stdout))?;
    Ok(ThreadFetchResult {
        items: result.items,
        metrics: result.metrics,
    })
}

#[cfg(test)]
fn build_threads_from_session_dir<F>(
    sessions_dir: &Path,
    history_path: &Path,
    workspace: &str,
    source: &str,
    path_mapper: F,
) -> Vec<Value>
where
    F: Fn(&Path) -> String,
{
    let previews = parse_history_preview_map(history_path);
    let mut files = Vec::new();
    collect_jsonl_files(sessions_dir, &mut files);

    let mut by_id: HashMap<String, Value> = HashMap::new();
    for file in files {
        let Some(scan) = scan_session_file(&file) else {
            continue;
        };
        let SessionFileScan {
            id,
            cwd,
            created_at,
            session_source,
            is_subagent,
            agent_parent_session_id,
            agent_role,
            preview: scanned_preview,
            filter_reason,
        } = scan;
        let updated_at = file_updated_unix_secs(&file);
        let preview = previews
            .get(&id)
            .and_then(|v| normalize_preview_text(v))
            .or(scanned_preview)
            .unwrap_or_default();
        let filter_reason = filter_reason
            .or_else(|| classify_thread_filter_reason(Some(&preview), &cwd, is_subagent, false));
        let candidate = json!({
            "id": id,
            "cwd": cwd,
            "workspace": workspace,
            "preview": preview,
            "path": path_mapper(&file),
            "source": source,
            "sessionSource": session_source,
            "isAuxiliary": matches!(filter_reason, Some(ThreadFilterReason::AuxiliaryPromptOnly)),
            "isSubagent": is_subagent,
            "agent_parent_session_id": agent_parent_session_id,
            "agentRole": agent_role,
            "filterReason": filter_reason.map(ThreadFilterReason::as_str),
            "status": { "type": "notLoaded" },
            "createdAt": if created_at > 0 { created_at } else { updated_at },
            "updatedAt": updated_at,
        });
        let should_replace = by_id.get(&id).is_some_and(|existing| {
            session_candidate_should_replace_existing(
                existing.get("path").and_then(Value::as_str),
                existing
                    .get("updatedAt")
                    .and_then(|value| value.as_i64())
                    .unwrap_or(0),
                candidate.get("path").and_then(Value::as_str),
                updated_at,
            )
        });
        if should_replace || !by_id.contains_key(&id) {
            by_id.insert(id, candidate);
        }
    }
    by_id.into_values().collect()
}

fn normalize_thread_path(raw: &str) -> PathBuf {
    let normalized = raw
        .trim()
        .replace("\\\\?\\UNC\\", "\\\\")
        .replace("\\\\?\\", "");
    PathBuf::from(normalized)
}

fn looks_like_local_session_rollout(path: &str) -> bool {
    let normalized = path.trim().replace('\\', "/").to_ascii_lowercase();
    normalized.contains("/.codex/sessions/") && normalized.contains("/rollout-")
}

pub(super) fn has_missing_session_rollout_path(items: &[Value]) -> bool {
    items.iter().any(|item| {
        let path = item
            .get("path")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default();
        if path.is_empty() {
            return false;
        }
        let source = item
            .get("source")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default();
        let is_session_cache_source = matches!(
            source,
            "windows-session-index"
                | "wsl-session-index"
                | "app-server-loaded-thread"
                | "app-server-thread-start"
        );
        let is_legacy_cache_shape =
            item.get("workspace").and_then(Value::as_str).is_none() && source.is_empty();
        if source == "live-notification" {
            return false;
        }
        if matches!(source, "windows-session-index" | "wsl-session-index") {
            return false;
        }
        if !is_session_cache_source
            && !is_legacy_cache_shape
            && !looks_like_local_session_rollout(path)
        {
            return false;
        }
        if is_legacy_cache_shape {
            return true;
        }
        !normalize_thread_path(path).exists()
    })
}

#[cfg(test)]
fn clear_session_file_scan_cache_for_test() {
    let cache = session_file_scan_cache();
    let mut guard = match cache.lock() {
        Ok(guard) => guard,
        Err(err) => err.into_inner(),
    };
    guard.clear();
}

#[cfg(test)]
fn clear_history_preview_map_cache_for_test() {
    let cache = history_preview_map_cache();
    let mut guard = match cache.lock() {
        Ok(guard) => guard,
        Err(err) => err.into_inner(),
    };
    guard.clear();
}

pub(super) fn normalize_thread_items_shape(items: &mut [Value]) {
    for item in items {
        let Some(obj) = item.as_object_mut() else {
            continue;
        };
        if !obj.contains_key("id") {
            if let Some(id) = obj
                .get("thread_id")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|v| !v.is_empty())
            {
                obj.insert("id".to_string(), Value::String(id.to_string()));
            }
        }
        if !obj.contains_key("filterReason") {
            let preview = obj
                .get("preview")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty());
            let cwd = obj
                .get("cwd")
                .and_then(Value::as_str)
                .map(str::trim)
                .unwrap_or_default();
            let is_subagent = obj
                .get("isSubagent")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let is_auxiliary = obj
                .get("isAuxiliary")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            if let Some(reason) =
                classify_thread_filter_reason(preview, cwd, is_subagent, is_auxiliary)
            {
                obj.insert(
                    "filterReason".to_string(),
                    Value::String(reason.as_str().to_string()),
                );
            }
        }
    }
}

pub(super) fn merge_items_without_duplicates(
    mut base: Vec<Value>,
    extra: Vec<Value>,
) -> Vec<Value> {
    fn merge_thread_item(base_item: &mut Value, extra_item: &Value) {
        let (Some(base_obj), Some(extra_obj)) = (base_item.as_object_mut(), extra_item.as_object())
        else {
            return;
        };
        let base_updated = base_obj
            .get("updatedAt")
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        let extra_updated = extra_obj
            .get("updatedAt")
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        for key in ["isSubagent", "isAuxiliary", "filterReason"] {
            let base_true = base_obj.get(key).and_then(|v| v.as_bool()).unwrap_or(false);
            let extra_true = extra_obj
                .get(key)
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            if key == "filterReason" {
                let should_replace = !base_obj.contains_key(key) || extra_updated > base_updated;
                if should_replace {
                    if let Some(value) = extra_obj.get(key) {
                        base_obj.insert(key.to_string(), value.clone());
                    }
                }
            } else if !base_true && extra_true {
                base_obj.insert(key.to_string(), Value::Bool(true));
            }
        }
        let base_preview_empty = base_obj
            .get("preview")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .map(|v| v.is_empty())
            .unwrap_or(true);
        let extra_preview = extra_obj
            .get("preview")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|v| !v.is_empty());
        if base_preview_empty || (extra_updated > base_updated && extra_preview.is_some()) {
            if let Some(preview) = extra_preview {
                base_obj.insert("preview".to_string(), Value::String(preview.to_string()));
            }
        }
        for key in ["path", "source", "sessionSource", "workspace", "cwd"] {
            let should_replace = !base_obj.contains_key(key) || extra_updated > base_updated;
            if should_replace {
                if let Some(v) = extra_obj.get(key) {
                    base_obj.insert(key.to_string(), v.clone());
                }
            }
        }
        if extra_updated > base_updated {
            base_obj.insert("updatedAt".to_string(), Value::from(extra_updated));
        }
    }

    let mut seen = std::collections::HashSet::new();
    let mut index_by_id = HashMap::<String, usize>::new();
    for item in &base {
        if let Some(id) = item.get("id").and_then(|v| v.as_str()) {
            seen.insert(id.to_string());
        }
    }
    for (idx, item) in base.iter().enumerate() {
        if let Some(id) = item.get("id").and_then(|v| v.as_str()) {
            index_by_id.insert(id.to_string(), idx);
        }
    }
    for item in extra {
        let Some(id) = item
            .get("id")
            .and_then(|v| v.as_str())
            .map(|v| v.to_string())
        else {
            continue;
        };
        if seen.insert(id.clone()) {
            index_by_id.insert(id, base.len());
            base.push(item);
            continue;
        }
        if let Some(existing_idx) = index_by_id.get(&id).copied() {
            if let Some(existing) = base.get_mut(existing_idx) {
                merge_thread_item(existing, &item);
            }
        }
    }
    base
}

pub(super) fn find_rollout_path_in_items(items: &[Value], thread_id: &str) -> Option<String> {
    let needle = thread_id.trim();
    if needle.is_empty() {
        return None;
    }
    items.iter().find_map(|item| {
        let id = item
            .get("id")
            .or_else(|| item.get("threadId"))
            .and_then(|v| v.as_str())
            .map(str::trim)
            .unwrap_or_default();
        if id != needle {
            return None;
        }
        item.get("path")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(str::to_string)
    })
}

pub(super) fn sort_threads_by_updated_desc(items: &mut [Value]) {
    fn score(item: &Value) -> i64 {
        item.get("updatedAt")
            .and_then(|v| v.as_i64())
            .or_else(|| item.get("createdAt").and_then(|v| v.as_i64()))
            .unwrap_or(0)
    }
    items.sort_by_key(score);
    items.reverse();
}

fn thread_updated_unix_secs(item: &Value) -> i64 {
    let raw = item
        .get("updatedAt")
        .and_then(|v| v.as_i64())
        .or_else(|| item.get("createdAt").and_then(|v| v.as_i64()))
        .unwrap_or(0);
    if raw <= 0 {
        return 0;
    }
    if raw > 1_000_000_000_000 {
        raw / 1000
    } else {
        raw
    }
}

fn filter_threads_within_last_month(items: &mut Vec<Value>) {
    let now_unix_secs = current_unix_secs();
    items.retain(|item| {
        let updated = thread_updated_unix_secs(item);
        if updated <= 0 {
            return true;
        }
        now_unix_secs.saturating_sub(updated) <= THREADS_MAX_AGE_SECS
    });
}

fn filter_auxiliary_threads(items: &mut Vec<Value>) {
    items.retain(thread_item_should_be_visible);
}

#[cfg(test)]
#[allow(clippy::await_holding_lock)]
mod tests {
    use super::{
        build_threads_from_session_dir, clear_history_preview_map_cache_for_test,
        clear_session_file_scan_cache_for_test, collect_jsonl_files,
        fetch_windows_threads_from_sessions, fetch_wsl2_threads_from_sessions,
        filter_auxiliary_threads, find_rollout_path_in_items, has_missing_session_rollout_path,
        merge_items_without_duplicates, overlay_loaded_thread_runtime, parse_history_preview_map,
        parse_wsl_thread_scan_output, parse_wsl_thread_scan_result, rebuild_workspace_thread_items,
        scan_session_file, sort_threads_by_updated_desc, thread_item_should_be_visible,
        wsl_thread_scan_script, ThreadFilterReason, THREADS_MAX_AGE_SECS,
    };
    use crate::codex_app_server;
    use crate::orchestrator::gateway::web_codex_home::WorkspaceTarget;
    use rusqlite::params;
    use serde_json::{json, Value};
    use std::sync::Arc;

    struct EnvGuard {
        key: &'static str,
        prev: Option<String>,
    }

    impl EnvGuard {
        fn set(key: &'static str, value: &str) -> Self {
            let prev = std::env::var(key).ok();
            unsafe {
                std::env::set_var(key, value);
            }
            Self { key, prev }
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            if let Some(prev) = self.prev.as_deref() {
                unsafe {
                    std::env::set_var(self.key, prev);
                }
            } else {
                unsafe {
                    std::env::remove_var(self.key);
                }
            }
        }
    }

    type TestThreadStateRow<'a> = (
        &'a str,
        &'a str,
        &'a str,
        &'a str,
        &'a str,
        &'a str,
        i64,
        i64,
        i64,
    );

    fn write_test_thread_state_db(codex_home: &std::path::Path, rows: &[TestThreadStateRow<'_>]) {
        let state = codex_home.join("state_5.sqlite");
        let conn = rusqlite::Connection::open(&state).expect("open sqlite");
        conn.execute_batch(
            r#"
            CREATE TABLE threads (
                id TEXT PRIMARY KEY,
                rollout_path TEXT,
                created_at_ms INTEGER,
                updated_at_ms INTEGER,
                source TEXT,
                cwd TEXT,
                title TEXT,
                archived INTEGER,
                thread_source TEXT,
                preview TEXT,
                first_user_message TEXT,
                agent_role TEXT
            );
            "#,
        )
        .expect("create threads table");
        for (
            id,
            rollout_path,
            cwd,
            title,
            preview,
            first_user_message,
            archived,
            created_at_ms,
            updated_at_ms,
        ) in rows
        {
            conn.execute(
                r#"
                INSERT INTO threads (
                    id,
                    rollout_path,
                    created_at_ms,
                    updated_at_ms,
                    source,
                    cwd,
                    title,
                    archived,
                    thread_source,
                    preview,
                    first_user_message,
                    agent_role
                ) VALUES (?1, ?2, ?3, ?4, 'vscode', ?5, ?6, ?7, 'user', ?8, ?9, NULL)
                "#,
                params![
                    id,
                    rollout_path,
                    created_at_ms,
                    updated_at_ms,
                    cwd,
                    title,
                    archived,
                    preview,
                    first_user_message
                ],
            )
            .expect("insert thread row");
        }
    }

    #[test]
    fn merge_items_without_duplicates_keeps_newer_metadata() {
        let base = vec![
            json!({
                "id": "a",
                "preview": "",
                "updatedAt": 1,
            }),
            json!({
                "id": "b",
                "preview": "base",
                "updatedAt": 2,
            }),
        ];
        let extra = vec![
            json!({
                "id": "a",
                "preview": "extra",
                "updatedAt": 3,
                "path": "C:\\temp\\a.jsonl",
            }),
            json!({
                "id": "c",
                "preview": "third",
                "updatedAt": 4,
            }),
        ];

        let mut merged = merge_items_without_duplicates(base, extra);
        sort_threads_by_updated_desc(&mut merged);

        assert_eq!(merged.len(), 3);
        assert_eq!(merged[0]["id"], "c");
        assert_eq!(merged[1]["id"], "a");
        assert_eq!(merged[1]["preview"], "extra");
        assert_eq!(merged[1]["updatedAt"], 3);
        assert_eq!(merged[1]["path"], "C:\\temp\\a.jsonl");
    }

    #[test]
    fn merge_items_without_duplicates_replaces_stale_preview_and_path_when_newer() {
        let base = vec![json!({
            "id": "thread-1",
            "preview": "old preview",
            "path": "C:\\old\\rollout.jsonl",
            "cwd": "C:\\old",
            "updatedAt": 10,
        })];
        let extra = vec![json!({
            "id": "thread-1",
            "preview": "new preview",
            "path": "C:\\new\\rollout.jsonl",
            "cwd": "C:\\new",
            "updatedAt": 20,
        })];

        let merged = merge_items_without_duplicates(base, extra);
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0]["preview"], "new preview");
        assert_eq!(merged[0]["path"], "C:\\new\\rollout.jsonl");
        assert_eq!(merged[0]["cwd"], "C:\\new");
        assert_eq!(merged[0]["updatedAt"], 20);
    }

    #[test]
    fn collect_jsonl_files_skips_sessions_older_than_thread_window() {
        let temp = tempfile::tempdir().expect("temp dir");
        let recent = temp.path().join("recent.jsonl");
        let old = temp.path().join("old.jsonl");
        std::fs::write(&recent, "{}\n").expect("write recent");
        std::fs::write(&old, "{}\n").expect("write old");
        let old_secs = std::time::SystemTime::now()
            .checked_sub(std::time::Duration::from_secs(
                (THREADS_MAX_AGE_SECS as u64) + 60,
            ))
            .expect("old timestamp");
        std::fs::OpenOptions::new()
            .write(true)
            .open(&old)
            .expect("open old")
            .set_modified(old_secs)
            .expect("set old modified");

        let mut files = Vec::new();
        collect_jsonl_files(temp.path(), &mut files);

        assert!(files.contains(&recent));
        assert!(!files.contains(&old));
    }

    #[test]
    fn parses_wsl_thread_scan_output_with_wsl_stdout_noise() {
        let items = parse_wsl_thread_scan_output(
            "your 131072x1 screen size is bogus. expect trouble\n[{\"id\":\"thread-1\"}]\n",
        )
        .expect("parse noisy WSL output");

        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["id"], "thread-1");
    }

    #[test]
    fn parses_wsl_thread_scan_output_envelope() {
        let items = parse_wsl_thread_scan_output(
            r#"{"items":[{"id":"thread-1"}],"metrics":{"cacheHitCount":1,"parsedFileCount":0}}"#,
        )
        .expect("parse WSL scan envelope");

        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["id"], "thread-1");
    }

    #[test]
    fn rejects_wsl_thread_scan_output_when_sqlite_probe_failed() {
        let result = parse_wsl_thread_scan_result(
            r#"{"items":[],"metrics":{"indexSource":"sqlite","sqliteError":"database is locked"}}"#,
        );
        let error = match result {
            Ok(_) => panic!("sqlite scan error should be treated as rebuild failure"),
            Err(error) => error,
        };

        assert!(
            error.contains("database is locked"),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn wsl_thread_scan_script_uses_sqlite_index_only() {
        let script = wsl_thread_scan_script();

        assert!(script.contains("import sqlite3"));
        assert!(script.contains("state_5.sqlite"));
        assert!(script.contains("def fetch_sqlite_items(state_path: Path):"));
        assert!(script.contains("\"indexSource\": \"sqlite\""));
        assert!(script.contains("def is_visible_candidate(item):"));
        assert!(script.contains("disabledReason"));
        assert!(!script.contains("rglob(\"*.jsonl\")"));
        assert!(!script.contains("api-router-thread-index-cache-v1.json"));
        assert!(!script.contains("cacheHitCount"));
    }

    #[tokio::test]
    async fn wsl_thread_scan_without_enabled_cli_directory_returns_disabled() {
        let _test_guard = codex_app_server::lock_test_globals();
        let app_data = tempfile::tempdir().expect("app data");
        let _user_data = EnvGuard::set(
            "API_ROUTER_USER_DATA_DIR",
            &app_data.path().to_string_lossy(),
        );
        let _wsl_home = EnvGuard::set("API_ROUTER_WEB_CODEX_WSL_CODEX_HOME", "");

        let result = fetch_wsl2_threads_from_sessions()
            .await
            .expect("disabled WSL scan should be a valid empty result");

        assert!(result.items.is_empty());
        if cfg!(target_os = "windows") {
            assert_eq!(
                result
                    .metrics
                    .as_ref()
                    .and_then(|metrics| metrics.get("disabledReason"))
                    .and_then(Value::as_str),
                Some("wsl-not-configured")
            );
        }
    }

    #[test]
    fn windows_thread_index_uses_default_codex_home_when_web_runtime_is_isolated() {
        clear_session_file_scan_cache_for_test();
        clear_history_preview_map_cache_for_test();
        let _test_guard = codex_app_server::lock_test_globals();
        let user_profile = tempfile::tempdir().expect("user profile temp dir");
        let app_data = tempfile::tempdir().expect("app data temp dir");
        let codex_home = user_profile.path().join(".codex");
        std::fs::create_dir_all(codex_home.join("sessions")).expect("create sessions");
        write_test_thread_state_db(
            &codex_home,
            &[(
                "thread-main",
                r"C:\Users\yiyou\.codex\sessions\2026\04\24\rollout-2026-04-24T04-18-55-thread-main.jsonl",
                r"\\?\C:\Users\yiyou\API-Router",
                "current api router session",
                "current api router session",
                "current api router session",
                0,
                1_780_145_810_000,
                1_780_145_810_957,
            )],
        );

        let _user_profile_guard =
            EnvGuard::set("USERPROFILE", &user_profile.path().to_string_lossy());
        let _app_data_guard = EnvGuard::set(
            "API_ROUTER_USER_DATA_DIR",
            &app_data.path().to_string_lossy(),
        );
        let _web_home_guard = EnvGuard::set("API_ROUTER_WEB_CODEX_CODEX_HOME", "");
        let _codex_home_guard = EnvGuard::set(
            "CODEX_HOME",
            &app_data.path().join("codex-home").to_string_lossy(),
        );

        let items = fetch_windows_threads_from_sessions().expect("windows thread items");

        assert!(items.iter().any(|item| {
            item.get("id").and_then(Value::as_str) == Some("thread-main")
                && item.get("preview").and_then(Value::as_str) == Some("current api router session")
        }));
        assert!(!items.iter().any(|item| {
            item.get("path")
                .and_then(Value::as_str)
                .is_some_and(|path| {
                    path.contains("codex-home") || path.contains("sessions\\imported")
                })
        }));
    }

    #[test]
    fn windows_thread_index_does_not_fallback_to_session_rollout_scan_without_sqlite() {
        clear_session_file_scan_cache_for_test();
        clear_history_preview_map_cache_for_test();
        let _test_guard = codex_app_server::lock_test_globals();
        let user_profile = tempfile::tempdir().expect("user profile temp dir");
        let app_data = tempfile::tempdir().expect("app data temp dir");
        let codex_home = user_profile.path().join(".codex");
        let sessions = codex_home
            .join("sessions")
            .join("2026")
            .join("05")
            .join("30");
        std::fs::create_dir_all(&sessions).expect("create sessions");
        std::fs::write(
            sessions.join("rollout-2026-05-30T20-25-34-thread-main.jsonl"),
            concat!(
                "{\"type\":\"session_meta\",\"payload\":{\"id\":\"thread-main\",\"cwd\":\"C:\\\\Users\\\\you\\\\API-Router\"}}\n",
                "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"should never be scanned for sidebar label\"}]}}\n"
            ),
        )
        .expect("write session");

        let _user_profile_guard =
            EnvGuard::set("USERPROFILE", &user_profile.path().to_string_lossy());
        let _app_data_guard = EnvGuard::set(
            "API_ROUTER_USER_DATA_DIR",
            &app_data.path().to_string_lossy(),
        );
        let _web_home_guard = EnvGuard::set("API_ROUTER_WEB_CODEX_CODEX_HOME", "");
        let _codex_home_guard = EnvGuard::set(
            "CODEX_HOME",
            &app_data.path().join("codex-home").to_string_lossy(),
        );

        let items = fetch_windows_threads_from_sessions().expect("windows thread items");

        assert!(
            items.is_empty(),
            "sidebar index must not scan rollout files without sqlite"
        );
    }

    #[test]
    fn windows_thread_index_prefers_sqlite_title_over_first_user_message() {
        clear_session_file_scan_cache_for_test();
        clear_history_preview_map_cache_for_test();
        let _test_guard = codex_app_server::lock_test_globals();
        let user_profile = tempfile::tempdir().expect("user profile temp dir");
        let app_data = tempfile::tempdir().expect("app data temp dir");
        let codex_home = user_profile.path().join(".codex");
        let sessions = codex_home
            .join("sessions")
            .join("2026")
            .join("05")
            .join("30");
        std::fs::create_dir_all(&sessions).expect("create sessions");
        let rollout = sessions.join("rollout-2026-05-30T20-25-34-thread-main.jsonl");
        std::fs::write(
            &rollout,
            concat!(
                "{\"type\":\"session_meta\",\"payload\":{\"id\":\"thread-main\",\"cwd\":\"C:\\\\Users\\\\yiyou\\\\API-Router\"}}\n",
                "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"very long first user prompt\"}]}}\n"
            ),
        )
        .expect("write session");
        write_test_thread_state_db(
            &codex_home,
            &[(
                "thread-main",
                &rollout.to_string_lossy(),
                r"\\?\C:\Users\yiyou\API-Router",
                "Short sqlite title",
                "Short sqlite title",
                "very long first user prompt",
                0,
                1_780_145_810_000,
                1_780_145_810_957,
            )],
        );

        let _user_profile_guard =
            EnvGuard::set("USERPROFILE", &user_profile.path().to_string_lossy());
        let _app_data_guard = EnvGuard::set(
            "API_ROUTER_USER_DATA_DIR",
            &app_data.path().to_string_lossy(),
        );
        let _web_home_guard = EnvGuard::set("API_ROUTER_WEB_CODEX_CODEX_HOME", "");
        let _codex_home_guard = EnvGuard::set(
            "CODEX_HOME",
            &app_data.path().join("codex-home").to_string_lossy(),
        );

        let items = fetch_windows_threads_from_sessions().expect("windows thread items");
        let item = items
            .iter()
            .find(|item| item.get("id").and_then(Value::as_str) == Some("thread-main"))
            .expect("thread item");
        assert_eq!(
            item.get("title").and_then(Value::as_str),
            Some("Short sqlite title")
        );
        assert_eq!(
            item.get("preview").and_then(Value::as_str),
            Some("Short sqlite title")
        );
    }

    #[test]
    fn windows_thread_index_can_list_sqlite_threads_without_rollout_files() {
        clear_session_file_scan_cache_for_test();
        clear_history_preview_map_cache_for_test();
        let _test_guard = codex_app_server::lock_test_globals();
        let user_profile = tempfile::tempdir().expect("user profile temp dir");
        let app_data = tempfile::tempdir().expect("app data temp dir");
        let codex_home = user_profile.path().join(".codex");
        std::fs::create_dir_all(codex_home.join("sessions")).expect("create sessions root");
        write_test_thread_state_db(
            &codex_home,
            &[(
                "thread-sqlite-only",
                r"C:\Users\yiyou\.codex\sessions\2026\05\30\missing-rollout.jsonl",
                r"\\?\C:\Users\yiyou\API-Router",
                "SQLite-only title",
                "SQLite-only title",
                "fallback first user message",
                0,
                1_780_145_810_000,
                1_780_145_810_957,
            )],
        );

        let _user_profile_guard =
            EnvGuard::set("USERPROFILE", &user_profile.path().to_string_lossy());
        let _app_data_guard = EnvGuard::set(
            "API_ROUTER_USER_DATA_DIR",
            &app_data.path().to_string_lossy(),
        );
        let _web_home_guard = EnvGuard::set("API_ROUTER_WEB_CODEX_CODEX_HOME", "");
        let _codex_home_guard = EnvGuard::set(
            "CODEX_HOME",
            &app_data.path().join("codex-home").to_string_lossy(),
        );

        let items = fetch_windows_threads_from_sessions().expect("windows thread items");
        let item = items
            .iter()
            .find(|item| item.get("id").and_then(Value::as_str) == Some("thread-sqlite-only"))
            .expect("sqlite-only thread item");
        assert_eq!(
            item.get("title").and_then(Value::as_str),
            Some("SQLite-only title")
        );
        assert_eq!(
            item.get("path").and_then(Value::as_str),
            Some(r"C:\Users\yiyou\.codex\sessions\2026\05\30\missing-rollout.jsonl")
        );
    }

    #[tokio::test]
    async fn windows_thread_rebuild_errors_when_sqlite_index_is_invalid() {
        clear_session_file_scan_cache_for_test();
        clear_history_preview_map_cache_for_test();
        let _test_guard = codex_app_server::lock_test_globals();
        let user_profile = tempfile::tempdir().expect("user profile temp dir");
        let app_data = tempfile::tempdir().expect("app data temp dir");
        let codex_home = user_profile.path().join(".codex");
        std::fs::create_dir_all(&codex_home).expect("create codex home");
        std::fs::write(codex_home.join("state_5.sqlite"), "not a sqlite database")
            .expect("write invalid sqlite");

        let _user_profile_guard =
            EnvGuard::set("USERPROFILE", &user_profile.path().to_string_lossy());
        let _app_data_guard = EnvGuard::set(
            "API_ROUTER_USER_DATA_DIR",
            &app_data.path().to_string_lossy(),
        );
        let _web_home_guard = EnvGuard::set("API_ROUTER_WEB_CODEX_CODEX_HOME", "");
        let _codex_home_guard = EnvGuard::set(
            "CODEX_HOME",
            &app_data.path().join("codex-home").to_string_lossy(),
        );

        codex_app_server::_set_test_request_handler(Some(Arc::new(
            move |_home, method, _params| match method {
                "thread/loaded/list" => Ok(serde_json::json!({ "data": [] })),
                other => Err(format!(
                    "{other} should not be called while sqlite rebuild is failing"
                )),
            },
        )))
        .await;
        let result = rebuild_workspace_thread_items(WorkspaceTarget::Windows).await;
        codex_app_server::_set_test_request_handler(None).await;
        let error = match result {
            Ok(_) => panic!("invalid sqlite should fail rebuild"),
            Err(error) => error,
        };

        assert!(
            error.contains("not a database")
                || error.contains("file is not a database")
                || error.contains("malformed"),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn scan_session_file_cache_invalidates_when_file_changes() {
        clear_session_file_scan_cache_for_test();
        let temp = tempfile::tempdir().expect("temp dir");
        let session = temp.path().join("session.jsonl");
        std::fs::write(
            &session,
            concat!(
                "{\"type\":\"session_meta\",\"payload\":{\"id\":\"thread-1\",\"cwd\":\"C:\\\\repo\"}}\n",
                "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"first prompt\"}]}}\n"
            ),
        )
        .expect("write session");

        let first = scan_session_file(&session).expect("first scan");
        assert_eq!(first.preview.as_deref(), Some("first prompt"));

        std::thread::sleep(std::time::Duration::from_millis(10));
        std::fs::write(
            &session,
            concat!(
                "{\"type\":\"session_meta\",\"payload\":{\"id\":\"thread-1\",\"cwd\":\"C:\\\\repo\"}}\n",
                "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"second prompt with more text\"}]}}\n"
            ),
        )
        .expect("rewrite session");

        let second = scan_session_file(&session).expect("second scan");
        assert_eq!(
            second.preview.as_deref(),
            Some("second prompt with more text")
        );
    }

    #[test]
    fn build_threads_from_session_dir_prefers_live_rollout_over_imported_copy_for_same_thread() {
        let temp = tempfile::tempdir().expect("temp dir");
        let sessions_dir = temp.path().join("codex-home").join("sessions");
        let imported_dir = sessions_dir.join("imported");
        let live_dir = sessions_dir.join("2026").join("03").join("20");
        std::fs::create_dir_all(&imported_dir).expect("imported dir");
        std::fs::create_dir_all(&live_dir).expect("live dir");
        let imported = imported_dir.join("thread-1.jsonl");
        let live = live_dir.join("rollout-2026-03-20T10-00-00-thread-1.jsonl");
        let payload =
            "{\"type\":\"session_meta\",\"payload\":{\"id\":\"thread-1\",\"cwd\":\"/home/yiyou/repo\"}}\n";
        std::fs::write(&live, payload).expect("write live");
        std::thread::sleep(std::time::Duration::from_secs(1));
        std::fs::write(&imported, payload).expect("write imported");

        let items = build_threads_from_session_dir(
            &sessions_dir,
            &temp.path().join("history.jsonl"),
            "wsl2",
            "wsl-session-index",
            |path| path.to_string_lossy().to_string(),
        );

        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["id"].as_str(), Some("thread-1"));
        assert_eq!(
            items[0]["path"].as_str(),
            Some(live.to_string_lossy().as_ref())
        );
    }

    #[test]
    fn parse_history_preview_map_prefers_first_non_aux_preview() {
        let temp = tempfile::tempdir().expect("temp dir");
        let history_path = temp.path().join("history.jsonl");
        std::fs::write(
            &history_path,
            concat!(
                "{\"session_id\":\"thread-1\",\"text\":\"old preview\"}\n",
                "{\"session_id\":\"thread-1\",\"text\":\"<permissions instructions>\"}\n",
                "{\"session_id\":\"thread-1\",\"text\":\"new preview\"}\n"
            ),
        )
        .expect("write history");

        let preview_map = parse_history_preview_map(&history_path);
        assert_eq!(
            preview_map.get("thread-1").map(String::as_str),
            Some("old preview")
        );
    }

    #[test]
    fn parse_history_preview_map_cache_invalidates_when_file_changes() {
        clear_history_preview_map_cache_for_test();
        let temp = tempfile::tempdir().expect("temp dir");
        let history_path = temp.path().join("history.jsonl");
        std::fs::write(
            &history_path,
            "{\"session_id\":\"thread-1\",\"text\":\"preview one\"}\n",
        )
        .expect("write history");

        let first = parse_history_preview_map(&history_path);
        assert_eq!(
            first.get("thread-1").map(String::as_str),
            Some("preview one")
        );

        std::thread::sleep(std::time::Duration::from_millis(10));
        std::fs::write(
            &history_path,
            "{\"session_id\":\"thread-1\",\"text\":\"preview two\"}\n",
        )
        .expect("rewrite history");

        let second = parse_history_preview_map(&history_path);
        assert_eq!(
            second.get("thread-1").map(String::as_str),
            Some("preview two")
        );
    }

    #[test]
    fn scan_session_file_prefers_first_non_aux_user_preview() {
        let temp = tempfile::tempdir().expect("temp dir");
        let session_path = temp.path().join("rollout.jsonl");
        std::fs::write(
            &session_path,
            concat!(
                "{\"type\":\"session_meta\",\"payload\":{\"id\":\"thread-1\",\"cwd\":\"/repo\"}}\n",
                "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"# AGENTS.md instructions for /repo\"}]}}\n",
                "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"\\u6628\\u5929\\u7684\\u95ee\\u9898\"}]}}\n",
                "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"\\u6700\\u65b0\\u7684\\u95ee\\u9898\"}]}}\n"
            ),
        )
        .expect("write session");

        let scan = scan_session_file(&session_path).expect("scan session");
        assert_eq!(
            scan.preview.as_deref(),
            Some("\u{6628}\u{5929}\u{7684}\u{95EE}\u{9898}")
        );
        assert_eq!(scan.filter_reason, None);
    }

    #[test]
    fn scan_session_file_marks_auxiliary_only_threads_with_filter_reason() {
        let temp = tempfile::tempdir().expect("temp dir");
        let session_path = temp.path().join("rollout.jsonl");
        std::fs::write(
            &session_path,
            concat!(
                "{\"type\":\"session_meta\",\"payload\":{\"id\":\"thread-1\",\"cwd\":\"/repo\"}}\n",
                "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"# AGENTS.md instructions for /repo\"}]}}\n",
                "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"developer\",\"content\":[{\"type\":\"input_text\",\"text\":\"<permissions instructions>\"}]}}\n"
            ),
        )
        .expect("write session");

        let scan = scan_session_file(&session_path).expect("scan session");
        assert_eq!(
            scan.filter_reason,
            Some(ThreadFilterReason::AuxiliaryPromptOnly)
        );
    }

    #[test]
    fn scan_session_file_treats_environment_context_as_auxiliary() {
        let temp = tempfile::tempdir().expect("temp dir");
        let session_path = temp.path().join("rollout.jsonl");
        std::fs::write(
            &session_path,
            concat!(
                "{\"type\":\"session_meta\",\"payload\":{\"id\":\"thread-env\",\"cwd\":\"C:\\\\Users\\\\yiyou\\\\API-Router-wt-main\"}}\n",
                "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"<environment_context>\\n  <cwd>C:\\\\Users\\\\yiyou\\\\API-Router-wt-main</cwd>\\n  <shell>powershell</shell>\\n</environment_context>\"}]}}\n"
            ),
        )
        .expect("write session");

        let scan = scan_session_file(&session_path).expect("scan session");
        assert_eq!(
            scan.filter_reason,
            Some(ThreadFilterReason::AuxiliaryPromptOnly)
        );
    }

    #[test]
    fn filter_auxiliary_threads_drops_permissions_instruction_preview() {
        let mut items = vec![json!({
            "id": "thread-live",
            "preview": "<permissions instructions>\nFilesystem sandboxing defines which files can be read or written.",
            "filterReason": "auxiliary-prompt-only",
            "updatedAt": 1742269999
        })];
        filter_auxiliary_threads(&mut items);
        assert!(
            items.is_empty(),
            "permissions scaffolding should not appear in sidebar"
        );
    }

    #[test]
    fn filter_auxiliary_threads_drops_test_prompt_and_temp_cwd() {
        let mut items = vec![
            json!({
                "id": "thread-test-preview",
                "preview": "Say OK only.",
                "cwd": r"C:\Users\yiyou\API-Router",
                "filterReason": "synthetic-probe",
                "updatedAt": 1742269999
            }),
            json!({
                "id": "thread-test-cwd",
                "preview": "normal preview",
                "cwd": r"C:\Users\yiyou\API-Router\.tmp-codex-web-real-send-1234",
                "filterReason": "temporary-workspace",
                "updatedAt": 1742269998
            }),
        ];
        filter_auxiliary_threads(&mut items);
        assert!(
            items.is_empty(),
            "test threads should not appear in sidebar"
        );
    }

    #[test]
    fn filter_auxiliary_threads_keeps_allowlisted_session_sources_only() {
        let mut items = vec![
            json!({
                "id": "thread-cli",
                "sessionSource": "cli",
                "updatedAt": 1742269999
            }),
            json!({
                "id": "thread-vscode",
                "sessionSource": "vscode",
                "updatedAt": 1742269998
            }),
            json!({
                "id": "thread-exec",
                "sessionSource": "exec",
                "updatedAt": 1742269997
            }),
            json!({
                "id": "thread-subagent",
                "sessionSource": {
                    "subagent": {
                        "thread_spawn": {
                            "parent_thread_id": "thread-main",
                            "depth": 1
                        }
                    }
                },
                "isSubagent": true,
                "updatedAt": 1742269996
            }),
            json!({
                "id": "thread-unknown",
                "sessionSource": "desktop",
                "updatedAt": 1742269995
            }),
        ];

        filter_auxiliary_threads(&mut items);
        let kept_ids = items
            .iter()
            .filter_map(|item| item.get("id").and_then(Value::as_str))
            .collect::<Vec<_>>();
        assert_eq!(kept_ids, vec!["thread-cli", "thread-vscode", "thread-exec"]);
    }

    #[test]
    fn filter_auxiliary_threads_drops_review_scaffold_and_diagnostic_prompts() {
        let mut items = vec![
            json!({
                "id": "thread-review",
                "preview": "<user_action> <context>User initiated a review task. Here's the full review output from reviewer model.",
                "filterReason": "auxiliary-prompt-only",
                "updatedAt": 1742269999
            }),
            json!({
                "id": "thread-aborted",
                "preview": "<turn_aborted> The user interrupted the previous turn on purpose.",
                "filterReason": "auxiliary-prompt-only",
                "updatedAt": 1742269998
            }),
            json!({
                "id": "thread-shell",
                "preview": "Use the shell to run Get-Content tests/ui/e2e/codex-web/send-turn-live.mjs | Select-String -Pattern \"command failed\"",
                "filterReason": "synthetic-probe",
                "updatedAt": 1742269997
            }),
            json!({
                "id": "thread-reply",
                "preview": "Reply with exactly OK and nothing else.",
                "filterReason": "synthetic-probe",
                "updatedAt": 1742269996
            }),
            json!({
                "id": "thread-marker",
                "preview": "HISTCHK_1773227343258_19514",
                "filterReason": "synthetic-probe",
                "updatedAt": 1742269995
            }),
        ];

        filter_auxiliary_threads(&mut items);
        assert!(
            items.is_empty(),
            "review scaffold and diagnostic prompts should not appear in sidebar"
        );
    }

    #[test]
    fn scan_session_file_skips_auxiliary_review_prompts_for_preview() {
        let temp = tempfile::tempdir().expect("temp dir");
        let session_path = temp.path().join("rollout.jsonl");
        let actual_user_prompt = "actual user issue";
        let actual_user_item = json!({
            "type": "response_item",
            "payload": {
                "type": "message",
                "role": "user",
                "content": [{
                    "type": "input_text",
                    "text": actual_user_prompt
                }]
            }
        });
        std::fs::write(
            &session_path,
            [
                "{\"type\":\"session_meta\",\"payload\":{\"id\":\"thread-1\",\"cwd\":\"/repo\"}}\n"
                    .to_string(),
                "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"<user_action> <context>User initiated a review task.\"}]}}\n"
                    .to_string(),
                "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"Use the shell to run rg -n command failed\"}]}}\n"
                    .to_string(),
                format!("{actual_user_item}\n"),
            ]
            .join(""),
        )
        .expect("write session");

        let scan = scan_session_file(&session_path).expect("scan session");
        assert_eq!(scan.preview.as_deref(), Some(actual_user_prompt));
        assert_eq!(scan.filter_reason, None);
    }

    #[test]
    fn scan_session_file_preserves_subagent_metadata_without_marking_it_visible() {
        let temp = tempfile::tempdir().expect("temp dir");
        let session_path = temp.path().join("rollout-subagent.jsonl");
        std::fs::write(
            &session_path,
            concat!(
                "{\"type\":\"session_meta\",\"payload\":{\"id\":\"agent-thread\",\"cwd\":\"C:\\\\Users\\\\yiyou\\\\API-Router\",\"source\":{\"subagent\":{\"thread_spawn\":{\"parent_thread_id\":\"main-thread\",\"depth\":1}}},\"agent_nickname\":\"Confucius\",\"agent_role\":\"explorer\"}}\n",
                "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"inspect the current branch name\"}]}}\n"
            ),
        )
        .expect("write session");

        let scan = scan_session_file(&session_path).expect("scan session");
        assert!(scan.is_subagent, "subagent metadata should be preserved");
        assert_eq!(
            scan.agent_parent_session_id.as_deref(),
            Some("main-thread"),
            "subagent parent thread id should be preserved from session meta"
        );
        assert_eq!(scan.agent_role.as_deref(), Some("explorer"));
        assert_eq!(
            scan.preview.as_deref(),
            Some("inspect the current branch name")
        );
        assert_eq!(
            scan.filter_reason, None,
            "subagent sessions are filtered by sessionSource allowlist, not filterReason"
        );
        let item = json!({
            "id": "agent-thread",
            "sessionSource": {
                "subagent": {
                    "thread_spawn": {
                        "parent_thread_id": "main-thread",
                        "depth": 1
                    }
                }
            },
            "isSubagent": true,
            "agentRole": "explorer"
        });
        assert!(
            !thread_item_should_be_visible(&item),
            "subagent sessions should be excluded from visible thread list items"
        );
    }

    #[test]
    fn scan_session_file_uses_shared_session_meta_identity_aliases() {
        let temp = tempfile::tempdir().expect("temp dir");
        let session_path = temp.path().join("rollout-subagent-camel.jsonl");
        std::fs::write(
            &session_path,
            concat!(
                "{\"type\":\"session_meta\",\"payload\":{\"sessionId\":\"agent-thread\",\"cwd\":\"C:\\\\Users\\\\yiyou\\\\API-Router\",\"source\":{\"subAgent\":{\"threadSpawn\":{\"parentThreadId\":\"main-thread\",\"depth\":1}}},\"agentNickname\":\"Curie\",\"agentRole\":\"explorer\"}}\n",
                "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"inspect camel aliases\"}]}}\n"
            ),
        )
        .expect("write session");

        let scan = scan_session_file(&session_path).expect("scan session");
        assert_eq!(scan.id, "agent-thread");
        assert!(scan.is_subagent, "camelCase subAgent should mark subagent");
        assert_eq!(scan.agent_parent_session_id.as_deref(), Some("main-thread"));
        assert_eq!(scan.agent_role.as_deref(), Some("explorer"));
    }

    #[test]
    fn parse_wsl_thread_scan_output_accepts_valid_json() {
        let parsed = parse_wsl_thread_scan_output(
            r#"[{"id":"thread-1","cwd":"/home/yiyou/repo","filterReason":"synthetic-probe"}]"#,
        )
        .expect("parse WSL thread scan JSON");
        assert_eq!(parsed.len(), 1);
        assert_eq!(
            parsed[0].get("id").and_then(|value| value.as_str()),
            Some("thread-1")
        );
    }

    #[test]
    fn find_rollout_path_in_items_matches_thread_id() {
        let items = vec![
            json!({ "id": "thread-a", "path": "C:\\temp\\a.jsonl" }),
            json!({ "threadId": "thread-b", "path": "C:\\temp\\b.jsonl" }),
        ];
        assert_eq!(
            find_rollout_path_in_items(&items, "thread-b").as_deref(),
            Some("C:\\temp\\b.jsonl")
        );
        assert!(find_rollout_path_in_items(&items, "missing").is_none());
    }

    #[test]
    fn missing_rollout_check_trusts_wsl_session_index_paths() {
        let items = vec![json!({
            "id": "thread-wsl",
            "source": "wsl-session-index",
            "workspace": "wsl2",
            "path": r"\\wsl.localhost\Ubuntu\home\yiyou\.codex\sessions\missing.jsonl"
        })];

        assert!(
            !has_missing_session_rollout_path(&items),
            "status polling should not probe WSL UNC rollout paths synchronously"
        );
    }

    #[test]
    fn missing_rollout_check_trusts_windows_sqlite_index_paths() {
        let items = vec![json!({
            "id": "thread-win",
            "source": "windows-session-index",
            "workspace": "windows",
            "path": r"C:\Users\yiyou\.codex\sessions\2026\05\30\missing-rollout.jsonl"
        })];

        assert!(
            !has_missing_session_rollout_path(&items),
            "sqlite-backed Windows rows should not force missing-rollout refreshes"
        );
    }

    #[test]
    fn shared_session_scan_includes_new_session_meta_without_history_entry() {
        let temp = tempfile::tempdir().expect("temp dir");
        let sessions_dir = temp
            .path()
            .join("sessions")
            .join("2026")
            .join("03")
            .join("18");
        std::fs::create_dir_all(&sessions_dir).expect("sessions dir");
        let file = sessions_dir
            .join("rollout-2026-03-18T05-10-00-probe-7eb3dd0f-0a17-4531-8790-ea003a47b773.jsonl");
        std::fs::write(
            &file,
            r#"{"type":"session_meta","payload":{"id":"7eb3dd0f-0a17-4531-8790-ea003a47b773","cwd":"/home/yiyou/.tmp-codex-web-live-sync-wsl"}}
"#,
        )
        .expect("write rollout");

        let items = build_threads_from_session_dir(
            &temp.path().join("sessions"),
            &temp.path().join("history.jsonl"),
            "wsl2",
            "wsl-session-index",
            |path| path.to_string_lossy().to_string(),
        );

        let item = items
            .iter()
            .find(|item| {
                item.get("id").and_then(|v| v.as_str())
                    == Some("7eb3dd0f-0a17-4531-8790-ea003a47b773")
            })
            .expect("session item");
        assert_eq!(
            item.get("cwd").and_then(|v| v.as_str()),
            Some("/home/yiyou/.tmp-codex-web-live-sync-wsl")
        );
        assert_eq!(item.get("workspace").and_then(|v| v.as_str()), Some("wsl2"));
        assert_eq!(
            item.get("path").and_then(|v| v.as_str()),
            Some(file.to_string_lossy().as_ref())
        );
        assert_eq!(
            item.get("source").and_then(|v| v.as_str()),
            Some("wsl-session-index")
        );
        assert_eq!(item.get("preview").and_then(|v| v.as_str()), Some(""));
    }

    #[tokio::test]
    async fn loaded_thread_runtime_overlays_session_index_status() {
        let _test_guard = codex_app_server::lock_test_globals();
        let thread_id = "019cf149-11e8-7d61-9277-73546ddc2118";
        let mut items = vec![json!({
            "id": thread_id,
            "cwd": "C:\\repo",
            "workspace": "windows",
            "source": "windows-session-index",
            "status": { "type": "notLoaded" },
            "updatedAt": 1742264469
        })];

        let _guard = EnvGuard::set("API_ROUTER_WEB_CODEX_CODEX_HOME", r"C:\Users\yiyou\.codex");

        codex_app_server::_set_test_request_handler(Some(Arc::new(
            move |_home, method, params| match method {
                "thread/loaded/list" => Ok(json!({ "data": [thread_id] })),
                "thread/read" => {
                    assert_eq!(
                        params.get("threadId").and_then(|value| value.as_str()),
                        Some(thread_id)
                    );
                    Ok(json!({
                        "thread": {
                            "id": thread_id,
                            "cwd": "C:\\repo",
                            "path": "C:\\Users\\yiyou\\.codex\\sessions\\2026\\03\\18\\rollout-2026-03-18T05-10-00-019cf149-11e8-7d61-9277-73546ddc2118.jsonl",
                            "status": { "type": "running" },
                            "updatedAt": 1742269999,
                            "model": "gpt-5.4",
                            "modelProvider": "api_router"
                        }
                    }))
                }
                other => Err(format!("unexpected method: {other}")),
            },
        )))
        .await;

        super::overlay_loaded_thread_runtime(WorkspaceTarget::Windows, &mut items).await;
        codex_app_server::_set_test_request_handler(None).await;

        assert_eq!(items.len(), 1);
        let item = items.first().expect("thread item");
        assert_eq!(
            item.get("status")
                .and_then(serde_json::Value::as_object)
                .and_then(|value| value.get("type"))
                .and_then(serde_json::Value::as_str),
            Some("running")
        );
        assert_eq!(
            item.get("modelProvider")
                .and_then(serde_json::Value::as_str),
            Some("api_router")
        );
        assert_eq!(
            item.get("model").and_then(serde_json::Value::as_str),
            Some("gpt-5.4")
        );
        assert_eq!(
            item.get("updatedAt").and_then(serde_json::Value::as_i64),
            Some(1742269999)
        );
    }

    #[tokio::test]
    async fn loaded_thread_runtime_keeps_live_rollout_path_when_runtime_points_to_imported_copy() {
        let _test_guard = codex_app_server::lock_test_globals();
        let thread_id = "thread-wsl-live";
        codex_app_server::_set_test_request_handler(Some(Arc::new(
            move |_home, method, params| match method {
                "thread/loaded/list" => Ok(json!({ "data": [thread_id] })),
                "thread/read" => {
                    assert_eq!(
                        params.get("threadId").and_then(serde_json::Value::as_str),
                        Some(thread_id)
                    );
                    Ok(json!({
                        "thread": {
                            "id": thread_id,
                            "status": { "type": "idle" },
                            "path": "/home/yiyou/.codex/sessions/imported/thread-wsl-live.jsonl",
                            "cwd": "/home/yiyou",
                            "updatedAt": 10
                        }
                    }))
                }
                other => panic!("unexpected rpc method: {other}"),
            },
        )))
        .await;

        let mut items = vec![json!({
            "id": thread_id,
            "workspace": "wsl2",
            "path": "/home/yiyou/.codex/sessions/2026/03/20/rollout-thread-wsl-live.jsonl",
            "cwd": "/home/yiyou/Automated-Supertrend-Trading",
            "updatedAt": 20,
            "status": { "type": "notLoaded" }
        })];

        overlay_loaded_thread_runtime(WorkspaceTarget::Wsl2, &mut items).await;

        codex_app_server::_set_test_request_handler(None).await;

        assert_eq!(
            items[0]["path"].as_str(),
            Some("/home/yiyou/.codex/sessions/2026/03/20/rollout-thread-wsl-live.jsonl")
        );
        assert_eq!(
            items[0]["cwd"].as_str(),
            Some("/home/yiyou/Automated-Supertrend-Trading")
        );
        assert_eq!(items[0]["updatedAt"].as_i64(), Some(20));
        assert_eq!(items[0]["status"]["type"].as_str(), Some("idle"));
    }

    #[tokio::test]
    async fn wsl_runtime_overlay_uses_workspace_scoped_rpc() {
        let _test_guard = codex_app_server::lock_test_globals();
        let _home = EnvGuard::set("API_ROUTER_WEB_CODEX_WSL_CODEX_HOME", "/home/test/.codex");
        codex_app_server::_set_test_request_handler(Some(Arc::new(
            move |home, method, params| {
                assert!(
                    home.is_some(),
                    "WSL overlay should use workspace-scoped home override"
                );
                match method {
                    "thread/loaded/list" => Ok(json!({ "data": ["thread-wsl"] })),
                    "thread/read" => {
                        assert_eq!(
                            params.get("threadId").and_then(serde_json::Value::as_str),
                            Some("thread-wsl")
                        );
                        Ok(json!({
                            "thread": {
                                "id": "thread-wsl",
                                "cwd": "/home/yiyou/project",
                                "path": "\\\\wsl.localhost\\Ubuntu\\home\\yiyou\\.codex\\sessions\\2026\\03\\20\\rollout-thread-wsl.jsonl",
                                "status": { "type": "running" },
                                "updatedAt": 1742442000,
                                "model": "gpt-5.4-codex",
                                "modelProvider": "openai"
                            }
                        }))
                    }
                    other => Err(format!("unexpected method: {other}")),
                }
            },
        )))
        .await;

        let mut items = vec![json!({
            "id": "thread-wsl",
            "workspace": "wsl2",
            "status": { "type": "notLoaded" }
        })];
        overlay_loaded_thread_runtime(WorkspaceTarget::Wsl2, &mut items).await;
        codex_app_server::_set_test_request_handler(None).await;

        assert_eq!(items.len(), 1);
        assert_eq!(
            items[0].get("id").and_then(serde_json::Value::as_str),
            Some("thread-wsl")
        );
        assert_eq!(
            items[0]
                .get("status")
                .and_then(serde_json::Value::as_object)
                .and_then(|value| value.get("type"))
                .and_then(serde_json::Value::as_str),
            Some("running")
        );
        assert_eq!(
            items[0].get("model").and_then(serde_json::Value::as_str),
            Some("gpt-5.4-codex")
        );
    }
}
