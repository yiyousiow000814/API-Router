use crate::orchestrator::gateway::web_codex_home::{
    default_windows_codex_dir, web_codex_rpc_home_override, web_codex_wsl_linux_home_override,
    WorkspaceTarget,
};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use tokio::process::Command;

const THREADS_INDEX_STALE_SECS: i64 = 15;
const THREADS_MAX_AGE_SECS: i64 = 30 * 24 * 60 * 60;
const THREADS_MAX_ITEMS: usize = 600;
const WSL_SCAN_TIMEOUT_SECS: u64 = 5;

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

async fn rebuild_workspace_thread_items(target: WorkspaceTarget) -> Vec<Value> {
    let mut items = match target {
        WorkspaceTarget::Windows => fetch_windows_threads_from_sessions(),
        WorkspaceTarget::Wsl2 => fetch_wsl2_threads_from_sessions().await,
    };
    normalize_thread_items_shape(&mut items);
    hydrate_missing_previews_from_session_files(&mut items);
    filter_auxiliary_threads(&mut items);
    filter_threads_within_last_month(&mut items);
    sort_threads_by_updated_desc(&mut items);
    if items.len() > THREADS_MAX_ITEMS {
        items.truncate(THREADS_MAX_ITEMS);
    }
    items
}

fn normalize_preview_text(raw: &str) -> Option<String> {
    let text = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    let mut out = trimmed.to_string();
    if out.chars().count() > 120 {
        out = out.chars().take(119).collect::<String>() + "…";
    }
    Some(out)
}

fn is_auxiliary_preview(preview: &str) -> bool {
    let text = preview.trim().to_ascii_lowercase();
    text.starts_with("# agents.md instructions")
        || text.starts_with("review the code changes against the base branch")
}

fn is_auxiliary_instruction_text(raw: &str) -> bool {
    let text = raw.trim().to_ascii_lowercase();
    text.contains("# agents.md instructions")
        || text.contains("review the code changes against the base branch")
        || text.contains("another language model started to solve this problem")
}

fn session_file_has_auxiliary_marker(path: &Path) -> bool {
    let file = match File::open(path) {
        Ok(v) => v,
        Err(_) => return false,
    };
    let reader = BufReader::new(file);
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
                let normalized = text.trim();
                if normalized.is_empty() {
                    continue;
                }
                if is_auxiliary_instruction_text(normalized) {
                    saw_aux_user_prompt = true;
                } else {
                    saw_non_aux_user_prompt = true;
                }
                break;
            }
        }
        if saw_non_aux_user_prompt {
            return false;
        }
    }
    saw_aux_user_prompt && !saw_non_aux_user_prompt
}

fn extract_user_preview_from_session_file(path: &Path) -> Option<String> {
    let file = File::open(path).ok()?;
    let reader = BufReader::new(file);
    let mut fallback_event_preview: Option<String> = None;
    let mut first_user_preview: Option<String> = None;
    for line in reader.lines().take(320).map_while(Result::ok) {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };
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
                if let Some(normalized) = normalize_preview_text(text) {
                    if first_user_preview.is_none() {
                        first_user_preview = Some(normalized);
                    }
                }
            }
        }
    }
    first_user_preview.or(fallback_event_preview)
}

fn parse_json_i64(value: &Value) -> Option<i64> {
    if let Some(v) = value.as_i64() {
        return Some(v);
    }
    if let Some(v) = value.as_u64().and_then(|n| i64::try_from(n).ok()) {
        return Some(v);
    }
    value
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .and_then(|s| s.parse::<i64>().ok())
}

fn parse_session_meta(path: &Path) -> Option<(String, String, i64, bool)> {
    let file = File::open(path).ok()?;
    let reader = BufReader::new(file);
    for line in reader.lines().take(40).map_while(Result::ok) {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };
        if v.get("type").and_then(|x| x.as_str()) != Some("session_meta") {
            continue;
        }
        let payload = v.get("payload").and_then(|x| x.as_object())?;
        let id = payload
            .get("id")
            .and_then(|x| x.as_str())
            .or_else(|| payload.get("session_id").and_then(|x| x.as_str()))
            .map(str::trim)
            .unwrap_or_default()
            .to_string();
        if id.is_empty() {
            continue;
        }
        let cwd = payload
            .get("cwd")
            .and_then(|x| x.as_str())
            .map(str::trim)
            .unwrap_or_default()
            .to_string();
        if cwd.is_empty() {
            continue;
        }
        let created_at = payload
            .get("created_at")
            .and_then(parse_json_i64)
            .or_else(|| payload.get("createdAt").and_then(parse_json_i64))
            .unwrap_or(0);
        let has_subagent_source = payload
            .get("source")
            .and_then(|x| x.get("subagent"))
            .is_some();
        let has_agent_role = payload
            .get("agent_role")
            .and_then(|x| x.as_str())
            .map(str::trim)
            .map(|v| !v.is_empty())
            .unwrap_or(false);
        let has_agent_nickname = payload
            .get("agent_nickname")
            .and_then(|x| x.as_str())
            .map(str::trim)
            .map(|v| !v.is_empty())
            .unwrap_or(false);
        return Some((
            id,
            cwd,
            created_at,
            has_subagent_source || has_agent_role || has_agent_nickname,
        ));
    }
    None
}

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

fn collect_jsonl_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let read = match std::fs::read_dir(dir) {
        Ok(v) => v,
        Err(_) => return,
    };
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
            out.push(path);
        }
    }
}

fn parse_history_preview_map(history_path: &Path) -> HashMap<String, String> {
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
            if !map.contains_key(id)
                && !is_auxiliary_preview(&text)
                && !is_auxiliary_instruction_text(&text)
            {
                map.insert(id.to_string(), text);
            }
        }
    }
    map
}

fn fetch_windows_threads_from_sessions() -> Vec<Value> {
    let Some(codex_dir) = web_codex_rpc_home_override()
        .map(PathBuf::from)
        .or_else(default_windows_codex_dir)
    else {
        return Vec::new();
    };
    let sessions_dir = codex_dir.join("sessions");
    if !sessions_dir.exists() {
        return Vec::new();
    }
    let previews = parse_history_preview_map(&codex_dir.join("history.jsonl"));
    let mut files = Vec::new();
    collect_jsonl_files(&sessions_dir, &mut files);

    let mut by_id: HashMap<String, Value> = HashMap::new();
    for file in files {
        let Some((id, cwd, created_at, is_subagent)) = parse_session_meta(&file) else {
            continue;
        };
        let updated_at = file_updated_unix_secs(&file);
        let preview = previews
            .get(&id)
            .and_then(|v| normalize_preview_text(v))
            .or_else(|| extract_user_preview_from_session_file(&file))
            .unwrap_or_default();
        let is_auxiliary = session_file_has_auxiliary_marker(&file);
        let candidate = json!({
            "id": id,
            "cwd": cwd,
            "workspace": "windows",
            "preview": preview,
            "path": file.to_string_lossy().to_string(),
            "source": "windows-session-index",
            "isAuxiliary": is_auxiliary,
            "isSubagent": is_subagent,
            "status": { "type": "notLoaded" },
            "createdAt": if created_at > 0 { created_at } else { updated_at },
            "updatedAt": updated_at,
        });
        let should_replace = by_id
            .get(&id)
            .and_then(|v| v.get("updatedAt").and_then(|x| x.as_i64()))
            .unwrap_or(0)
            < updated_at;
        if should_replace || !by_id.contains_key(&id) {
            by_id.insert(id, candidate);
        }
    }
    by_id.into_values().collect()
}

async fn fetch_wsl2_threads_from_sessions() -> Vec<Value> {
    if !cfg!(target_os = "windows") {
        return Vec::new();
    }
    let export_home = web_codex_wsl_linux_home_override()
        .map(|home| format!("export CODEX_HOME='{}'\n", home.replace('\'', "'\"'\"'")))
        .unwrap_or_default();
    let script = format!(
        r#"{export_home}python3 - <<'PY'
import json
import re
from pathlib import Path
import os

codex_home = (os.environ.get("CODEX_HOME") or "").strip()
root = Path(codex_home) if codex_home else (Path.home() / ".codex")
sessions_dir = root / "sessions"
history_path = root / "history.jsonl"
distro = (os.environ.get("WSL_DISTRO_NAME") or "").strip()

if not sessions_dir.exists():
    print("[]")
    raise SystemExit(0)

preview_map = {{}}
if history_path.exists():
    try:
        with history_path.open("r", encoding="utf-8", errors="ignore") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    row = json.loads(line)
                except Exception:
                    continue
                sid = str(row.get("session_id") or "").strip()
                text = str(row.get("text") or "").strip()
                if sid and text and sid not in preview_map:
                    preview_map[sid] = text
    except Exception:
        pass

items_by_id = {{}}
id_re = re.compile(r"([0-9a-f]{{8}}-[0-9a-f]{{4}}-[0-9a-f]{{4}}-[0-9a-f]{{4}}-[0-9a-f]{{12}})", re.IGNORECASE)

def to_windows_path(path_obj: Path) -> str:
    text = str(path_obj)
    if distro and text.startswith("/"):
        return "\\\\wsl.localhost\\{{}}\\{{}}".format(distro, text.lstrip("/").replace("/", "\\\\"))
    return text

for p in sessions_dir.rglob("*.jsonl"):
    sid = ""
    cwd = ""
    created_at = 0
    is_subagent = False
    updated_at = int(p.stat().st_mtime)
    try:
        with p.open("r", encoding="utf-8", errors="ignore") as fh:
            for _ in range(40):
                line = fh.readline()
                if not line:
                    break
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except Exception:
                    continue
                if obj.get("type") == "session_meta":
                    payload = obj.get("payload") or {{}}
                    sid = str(payload.get("id") or payload.get("session_id") or sid).strip()
                    cwd = str(payload.get("cwd") or cwd).strip()
                    created_raw = payload.get("created_at") or payload.get("createdAt")
                    source = payload.get("source")
                    source_subagent = source.get("subagent") if isinstance(source, dict) else None
                    agent_role = payload.get("agent_role")
                    agent_nickname = payload.get("agent_nickname")
                    has_agent_role = isinstance(agent_role, str) and bool(agent_role.strip())
                    has_agent_nickname = isinstance(agent_nickname, str) and bool(agent_nickname.strip())
                    is_subagent = bool(source_subagent) or has_agent_role or has_agent_nickname
                    try:
                        created_at = int(created_raw or 0)
                    except Exception:
                        created_at = 0
                    break
    except Exception:
        continue

    if not sid:
        m = id_re.search(p.name)
        if m:
            sid = m.group(1)
    if not sid or not cwd:
        continue

    candidate = {{
        "id": sid,
        "cwd": cwd,
        "workspace": "wsl2",
        "preview": preview_map.get(sid, ""),
        "path": to_windows_path(p),
        "source": "wsl-session-index",
        "isSubagent": is_subagent,
        "isAuxiliary": False,
        "status": {{"type": "notLoaded"}},
        "createdAt": created_at or updated_at,
        "updatedAt": updated_at,
    }}
    existing = items_by_id.get(sid)
    if existing is None or int(existing.get("updatedAt", 0)) < updated_at:
        items_by_id[sid] = candidate

items = sorted(items_by_id.values(), key=lambda x: int(x.get("updatedAt", 0)), reverse=True)
print(json.dumps(items[:{THREADS_MAX_ITEMS}], ensure_ascii=False))
PY"#
    );
    let mut cmd = Command::new("wsl.exe");
    cmd.arg("-e").arg("bash").arg("-lc").arg(script);
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::null());
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
        _ => return Vec::new(),
    };
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if text.is_empty() {
        return Vec::new();
    }
    serde_json::from_str::<Vec<Value>>(&text).unwrap_or_default()
}

fn normalize_thread_path(raw: &str) -> PathBuf {
    let normalized = raw
        .trim()
        .replace("\\\\?\\UNC\\", "\\\\")
        .replace("\\\\?\\", "");
    PathBuf::from(normalized)
}

fn hydrate_missing_previews_from_session_files(items: &mut [Value]) {
    for item in items {
        let has_preview = item
            .get("preview")
            .and_then(|x| x.as_str())
            .map(str::trim)
            .map(|s| !s.is_empty())
            .unwrap_or(false);
        if has_preview {
            continue;
        }
        let Some(path_raw) = item.get("path").and_then(|x| x.as_str()) else {
            continue;
        };
        let path = normalize_thread_path(path_raw);
        if !path.exists() {
            continue;
        }
        let Some(preview) = extract_user_preview_from_session_file(&path) else {
            continue;
        };
        if let Some(obj) = item.as_object_mut() {
            obj.insert("preview".to_string(), Value::String(preview));
        }
    }
}

fn normalize_thread_items_shape(items: &mut [Value]) {
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
    }
}

fn merge_items_without_duplicates(mut base: Vec<Value>, extra: Vec<Value>) -> Vec<Value> {
    fn merge_thread_item(base_item: &mut Value, extra_item: &Value) {
        let (Some(base_obj), Some(extra_obj)) = (base_item.as_object_mut(), extra_item.as_object())
        else {
            return;
        };
        let base_preview_empty = base_obj
            .get("preview")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .map(|v| v.is_empty())
            .unwrap_or(true);
        if base_preview_empty {
            if let Some(preview) = extra_obj.get("preview").and_then(|v| v.as_str()) {
                if !preview.trim().is_empty() {
                    base_obj.insert("preview".to_string(), Value::String(preview.to_string()));
                }
            }
        }
        for key in ["path", "source", "workspace", "cwd"] {
            if !base_obj.contains_key(key) {
                if let Some(v) = extra_obj.get(key) {
                    base_obj.insert(key.to_string(), v.clone());
                }
            }
        }
        for key in ["isSubagent", "isAuxiliary"] {
            let base_true = base_obj.get(key).and_then(|v| v.as_bool()).unwrap_or(false);
            let extra_true = extra_obj
                .get(key)
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            if !base_true && extra_true {
                base_obj.insert(key.to_string(), Value::Bool(true));
            }
        }
        let base_updated = base_obj
            .get("updatedAt")
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        let extra_updated = extra_obj
            .get("updatedAt")
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
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

fn find_rollout_path_in_items(items: &[Value], thread_id: &str) -> Option<String> {
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

fn sort_threads_by_updated_desc(items: &mut [Value]) {
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
    items.retain(|item| {
        let is_subagent = item
            .get("isSubagent")
            .and_then(|x| x.as_bool())
            .unwrap_or(false);
        if is_subagent {
            return false;
        }
        let is_auxiliary = item
            .get("isAuxiliary")
            .and_then(|x| x.as_bool())
            .unwrap_or(false);
        if is_auxiliary {
            return false;
        }
        let preview = item
            .get("preview")
            .and_then(|x| x.as_str())
            .map(str::trim)
            .unwrap_or_default();
        !is_auxiliary_preview(preview)
    });
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
