use super::current_unix_secs;
use crate::orchestrator::gateway::web_codex_home::{
    default_windows_codex_dir, web_codex_rpc_home_override, web_codex_wsl_linux_home_override,
    WorkspaceTarget,
};
use crate::orchestrator::gateway::web_codex_rollout_path::session_candidate_should_replace_existing;
use crate::orchestrator::gateway::web_codex_session_manager::{
    overlay_runtime_thread_item, runtime_thread_payload, CodexSessionManager,
};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use tokio::process::Command;

const THREADS_MAX_AGE_SECS: i64 = 30 * 24 * 60 * 60;
const THREADS_MAX_ITEMS: usize = 600;
const WSL_SCAN_TIMEOUT_SECS: u64 = 5;
const LOADED_THREAD_OVERLAY_MAX_ITEMS: usize = 48;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ThreadFilterReason {
    Subagent,
    TemporaryWorkspace,
    AuxiliaryPromptOnly,
    SyntheticProbe,
}

impl ThreadFilterReason {
    fn as_str(self) -> &'static str {
        match self {
            Self::Subagent => "subagent",
            Self::TemporaryWorkspace => "temporary-workspace",
            Self::AuxiliaryPromptOnly => "auxiliary-prompt-only",
            Self::SyntheticProbe => "synthetic-probe",
        }
    }
}

pub(super) async fn rebuild_workspace_thread_items(
    target: WorkspaceTarget,
) -> Result<Vec<Value>, String> {
    let items = match target {
        WorkspaceTarget::Windows => Ok(fetch_windows_threads_from_sessions()),
        WorkspaceTarget::Wsl2 => fetch_wsl2_threads_from_sessions().await,
    };
    let mut items = items?;
    overlay_loaded_thread_runtime(target, &mut items).await;
    normalize_thread_items_shape(&mut items);
    hydrate_missing_previews_from_session_files(&mut items);
    filter_auxiliary_threads(&mut items);
    filter_threads_within_last_month(&mut items);
    sort_threads_by_updated_desc(&mut items);
    if items.len() > THREADS_MAX_ITEMS {
        items.truncate(THREADS_MAX_ITEMS);
    }
    Ok(items)
}

async fn overlay_loaded_thread_runtime(target: WorkspaceTarget, items: &mut Vec<Value>) {
    let manager = CodexSessionManager::new(Some(target));
    let loaded_threads = match manager
        .loaded_threads(LOADED_THREAD_OVERLAY_MAX_ITEMS)
        .await
    {
        Ok(threads) => threads,
        Err(_) => return,
    };
    if loaded_threads.is_empty() {
        return;
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

fn extract_user_preview_from_session_file(path: &Path) -> Option<String> {
    scan_session_file(path).and_then(|scan| scan.preview)
}

struct SessionFileScan {
    id: String,
    cwd: String,
    created_at: i64,
    is_subagent: bool,
    preview: Option<String>,
    filter_reason: Option<ThreadFilterReason>,
}

fn classify_thread_filter_reason(
    preview: Option<&str>,
    cwd: &str,
    is_subagent: bool,
    auxiliary_prompt_only: bool,
) -> Option<ThreadFilterReason> {
    if is_subagent {
        return Some(ThreadFilterReason::Subagent);
    }
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
    let file = File::open(path).ok()?;
    let reader = BufReader::new(file);
    let mut fallback_event_preview: Option<String> = None;
    let mut first_user_preview: Option<String> = None;
    let mut first_non_aux_user_preview: Option<String> = None;
    let mut meta: Option<(String, String, i64, bool)> = None;
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
            let payload = v.get("payload").and_then(|x| x.as_object())?;
            let id = payload
                .get("id")
                .and_then(|x| x.as_str())
                .or_else(|| payload.get("session_id").and_then(|x| x.as_str()))
                .map(str::trim)
                .unwrap_or_default()
                .to_string();
            let cwd = payload
                .get("cwd")
                .and_then(|x| x.as_str())
                .map(str::trim)
                .unwrap_or_default()
                .to_string();
            if !id.is_empty() && !cwd.is_empty() {
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
                meta = Some((
                    id,
                    cwd,
                    created_at,
                    has_subagent_source || has_agent_role || has_agent_nickname,
                ));
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
    let (id, cwd, created_at, is_subagent) = meta?;
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
        is_subagent,
        preview,
        filter_reason,
    })
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
            if !is_auxiliary_thread_preview_text(&text) {
                map.entry(id.to_string()).or_insert(text);
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
    build_threads_from_session_dir(
        &sessions_dir,
        &codex_dir.join("history.jsonl"),
        "windows",
        "windows-session-index",
        |file| file.to_string_lossy().to_string(),
    )
}

fn parse_wsl_thread_scan_output(text: &str) -> Result<Vec<Value>, String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }
    serde_json::from_str::<Vec<Value>>(trimmed)
        .map_err(|err| format!("invalid WSL thread scan JSON: {err}"))
}

fn wsl_thread_scan_script() -> String {
    let export_home = web_codex_wsl_linux_home_override()
        .map(|home| format!("export CODEX_HOME='{}'\n", home.replace('\'', "'\"'\"'")))
        .unwrap_or_default();
    format!(
        r###"{export_home}python3 - <<'PY'
import json
import re
from pathlib import Path
import os

MAX_ITEMS = {THREADS_MAX_ITEMS}

def normalize_preview_text(raw):
    text = " ".join(str(raw).split()).strip()
    if not text:
        return None
    return text[:119] + "…" if len(text) > 120 else text

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

def is_imported_session_path(raw):
    path = normalize_session_path_like(raw)
    return "/.codex/sessions/imported/" in path and path.endswith(".jsonl")

def is_live_session_rollout_path(raw):
    path = normalize_session_path_like(raw)
    return (
        "/.codex/sessions/" in path
        and "/rollout-" in path
        and "/.codex/sessions/imported/" not in path
        and path.endswith(".jsonl")
    )

def should_replace_existing_thread(existing, candidate):
    existing_path = existing.get("path") if isinstance(existing, dict) else None
    candidate_path = candidate.get("path") if isinstance(candidate, dict) else None
    if is_live_session_rollout_path(existing_path) and is_imported_session_path(candidate_path):
        return False
    if is_imported_session_path(existing_path) and is_live_session_rollout_path(candidate_path):
        return True
    return int(existing.get("updatedAt", 0)) < int(candidate.get("updatedAt", 0))

def classify_filter_reason(preview, cwd, is_subagent, auxiliary_prompt_only):
    if is_subagent:
        return "subagent"
    if is_filtered_test_thread_cwd(cwd):
        return "temporary-workspace"
    if auxiliary_prompt_only:
        return "auxiliary-prompt-only"
    if preview and is_synthetic_probe_preview(preview):
        return "synthetic-probe"
    return None

codex_home = (os.environ.get("CODEX_HOME") or "").strip()
root = Path(codex_home) if codex_home else (Path.home() / ".codex")
sessions_dir = root / "sessions"
distro = (os.environ.get("WSL_DISTRO_NAME") or "").strip()

if not sessions_dir.exists():
    print("[]")
    raise SystemExit(0)

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
    fallback_preview = None
    first_preview = None
    first_non_aux_preview = None
    saw_aux_prompt = False
    saw_non_aux_prompt = False
    updated_at = int(p.stat().st_mtime)
    try:
        with p.open("r", encoding="utf-8", errors="ignore") as fh:
            for idx, line in enumerate(fh):
                if idx >= 320:
                    break
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except Exception:
                    continue
                if obj.get("type") == "session_meta" and not sid:
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
                    continue
                if obj.get("type") == "event_msg" and fallback_preview is None:
                    message = ((obj.get("payload") or {{}}).get("message"))
                    if isinstance(message, str):
                        fallback_preview = normalize_preview_text(message)
                    continue
                if obj.get("type") != "response_item":
                    continue
                payload = obj.get("payload") or {{}}
                if payload.get("type") != "message" or payload.get("role") != "user":
                    continue
                for item in payload.get("content") or []:
                    text = item.get("text") if isinstance(item, dict) else None
                    if not isinstance(text, str) or not text.strip():
                        continue
                    normalized = normalize_preview_text(text)
                    if normalized:
                        if first_preview is None:
                            first_preview = normalized
                        if not is_auxiliary_instruction_text(text) and first_non_aux_preview is None:
                            first_non_aux_preview = normalized
                    if is_auxiliary_instruction_text(text):
                        saw_aux_prompt = True
                    else:
                        saw_non_aux_prompt = True
                    break
    except Exception:
        continue

    if not sid:
        m = id_re.search(p.name)
        if m:
            sid = m.group(1)
    if not sid or not cwd:
        continue

    preview = first_non_aux_preview or first_preview or fallback_preview or ""
    filter_reason = classify_filter_reason(preview, cwd, is_subagent, saw_aux_prompt and not saw_non_aux_prompt)
    candidate = {{
        "id": sid,
        "cwd": cwd,
        "workspace": "wsl2",
        "preview": preview,
        "path": to_windows_path(p),
        "source": "wsl-session-index",
        "isSubagent": is_subagent,
        "isAuxiliary": filter_reason == "auxiliary-prompt-only",
        "filterReason": filter_reason,
        "status": {{"type": "notLoaded"}},
        "createdAt": created_at or updated_at,
        "updatedAt": updated_at,
    }}
    existing = items_by_id.get(sid)
    if existing is None or should_replace_existing_thread(existing, candidate):
        items_by_id[sid] = candidate

items = sorted(items_by_id.values(), key=lambda x: int(x.get("updatedAt", 0)), reverse=True)
print(json.dumps(items[:MAX_ITEMS], ensure_ascii=False))
PY"###
    )
}

async fn fetch_wsl2_threads_from_sessions() -> Result<Vec<Value>, String> {
    if !cfg!(target_os = "windows") {
        return Ok(Vec::new());
    }
    let script = wsl_thread_scan_script();
    let mut cmd = Command::new("wsl.exe");
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
    parse_wsl_thread_scan_output(&String::from_utf8_lossy(&output.stdout))
}

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
            is_subagent,
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
            "isAuxiliary": matches!(filter_reason, Some(ThreadFilterReason::AuxiliaryPromptOnly)),
            "isSubagent": is_subagent,
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
        for key in ["path", "source", "workspace", "cwd"] {
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
    items.retain(|item| {
        item.get("filterReason")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|reason| !reason.is_empty())
            .is_none()
    });
}

#[cfg(test)]
mod tests {
    use super::{
        build_threads_from_session_dir, filter_auxiliary_threads, find_rollout_path_in_items,
        merge_items_without_duplicates, overlay_loaded_thread_runtime, parse_history_preview_map,
        parse_wsl_thread_scan_output, scan_session_file, sort_threads_by_updated_desc,
        ThreadFilterReason,
    };
    use crate::codex_app_server;
    use crate::orchestrator::gateway::web_codex_home::WorkspaceTarget;
    use serde_json::json;
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
    fn build_threads_from_session_dir_prefers_live_rollout_over_imported_copy_for_same_thread() {
        let temp = tempfile::tempdir().expect("temp dir");
        let sessions_dir = temp.path().join(".codex").join("sessions");
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
    fn scan_session_file_prefers_first_non_aux_user_preview() {
        let temp = tempfile::tempdir().expect("temp dir");
        let session_path = temp.path().join("rollout.jsonl");
        std::fs::write(
            &session_path,
            concat!(
                "{\"type\":\"session_meta\",\"payload\":{\"id\":\"thread-1\",\"cwd\":\"/repo\"}}\n",
                "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"# AGENTS.md instructions for /repo\"}]}}\n",
                "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"昨天的问题\"}]}}\n",
                "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"最新的问题\"}]}}\n"
            ),
        )
        .expect("write session");

        let scan = scan_session_file(&session_path).expect("scan session");
        assert_eq!(scan.preview.as_deref(), Some("昨天的问题"));
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
                "preview": "Use the shell to run Get-Content scripts/codex-web-e2e-send-turn-live.mjs | Select-String -Pattern \"command failed\"",
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
        std::fs::write(
            &session_path,
            concat!(
                "{\"type\":\"session_meta\",\"payload\":{\"id\":\"thread-1\",\"cwd\":\"/repo\"}}\n",
                "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"<user_action> <context>User initiated a review task.\"}]}}\n",
                "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"Use the shell to run rg -n command failed\"}]}}\n",
                "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"真正的用户问题\"}]}}\n"
            ),
        )
        .expect("write session");

        let scan = scan_session_file(&session_path).expect("scan session");
        assert_eq!(scan.preview.as_deref(), Some("真正的用户问题"));
        assert_eq!(scan.filter_reason, None);
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
