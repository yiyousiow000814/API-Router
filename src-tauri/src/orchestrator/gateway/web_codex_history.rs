use super::web_codex_home::{
    linux_path_to_unc, parse_wsl_unc_to_linux_path, resolve_wsl_identity, WorkspaceTarget,
};
use serde_json::{json, Value};
use std::fs::File;
use std::io::{BufRead, BufReader};
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};

const DEFAULT_HISTORY_PAGE_LIMIT: usize = 120;
const MAX_HISTORY_PAGE_LIMIT: usize = 240;

#[derive(Clone, Debug)]
struct HistoryTurn {
    id: String,
    items: Vec<Value>,
    opened_explicitly: bool,
    saw_compaction: bool,
}

pub(super) struct ThreadHistoryPage {
    pub(super) thread: Value,
    pub(super) page: Value,
}

struct ResolvedRolloutPath {
    local_path: PathBuf,
    linux_path: Option<String>,
}

#[cfg(test)]
type TestHistoryLoader = std::sync::Arc<
    dyn Fn(
            String,
            Option<WorkspaceTarget>,
            Option<String>,
            Option<String>,
            usize,
        ) -> Result<ThreadHistoryPage, String>
        + Send
        + Sync,
>;

#[cfg(test)]
fn test_history_loader() -> &'static std::sync::Mutex<Option<TestHistoryLoader>> {
    static LOADER: std::sync::OnceLock<std::sync::Mutex<Option<TestHistoryLoader>>> =
        std::sync::OnceLock::new();
    LOADER.get_or_init(|| std::sync::Mutex::new(None))
}

#[cfg(test)]
pub(super) fn _set_test_history_loader(loader: Option<TestHistoryLoader>) {
    match test_history_loader().lock() {
        Ok(mut guard) => *guard = loader,
        Err(err) => *err.into_inner() = loader,
    }
}

pub(super) fn default_history_page_limit() -> usize {
    DEFAULT_HISTORY_PAGE_LIMIT
}

pub(super) fn load_thread_history_page(
    thread_id: &str,
    workspace: Option<WorkspaceTarget>,
    rollout_path: Option<&str>,
    before: Option<&str>,
    limit: usize,
) -> Result<ThreadHistoryPage, String> {
    #[cfg(test)]
    if let Some(loader) = match test_history_loader().lock() {
        Ok(guard) => guard.clone(),
        Err(err) => err.into_inner().clone(),
    } {
        return loader(
            thread_id.to_string(),
            workspace,
            rollout_path.map(str::to_string),
            before.map(str::to_string),
            limit,
        );
    }
    load_thread_history_page_impl(thread_id, workspace, rollout_path, before, limit)
}

fn load_thread_history_page_impl(
    thread_id: &str,
    workspace: Option<WorkspaceTarget>,
    rollout_path: Option<&str>,
    before: Option<&str>,
    limit: usize,
) -> Result<ThreadHistoryPage, String> {
    let raw_rollout_path = rollout_path
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "missing rollout path".to_string())?;
    let resolved = resolve_rollout_path(workspace, raw_rollout_path)?;
    let normalized_limit = limit.clamp(1, MAX_HISTORY_PAGE_LIMIT);
    let workspace_value = match workspace {
        Some(WorkspaceTarget::Windows) => Some("windows"),
        Some(WorkspaceTarget::Wsl2) => Some("wsl2"),
        None => None,
    };
    let page = if matches!(workspace, Some(WorkspaceTarget::Wsl2)) {
        if let Some(linux_path) = resolved.linux_path.as_deref() {
            load_thread_history_page_via_wsl(
                thread_id,
                linux_path,
                before,
                normalized_limit,
                workspace_value,
                raw_rollout_path,
            )?
        } else {
            build_thread_history_page(
                thread_id,
                workspace_value,
                raw_rollout_path,
                parse_rollout_turns(&resolved.local_path)?,
                before,
                normalized_limit,
            )?
        }
    } else {
        build_thread_history_page(
            thread_id,
            workspace_value,
            raw_rollout_path,
            parse_rollout_turns(&resolved.local_path)?,
            before,
            normalized_limit,
        )?
    };
    Ok(page)
}

fn build_thread_history_page(
    thread_id: &str,
    workspace_value: Option<&str>,
    rollout_path: &str,
    turns: Vec<HistoryTurn>,
    before: Option<&str>,
    normalized_limit: usize,
) -> Result<ThreadHistoryPage, String> {
    let page_end = before
        .and_then(|cursor| {
            turns
                .iter()
                .position(|turn| turn.id == cursor.trim())
                .or_else(|| {
                    turns
                        .iter()
                        .position(|turn| turn.id == format!("history-turn-{}", cursor.trim()))
                })
        })
        .unwrap_or(turns.len());
    let start = page_end.saturating_sub(normalized_limit);
    let page_turns = turns[start..page_end]
        .iter()
        .map(history_turn_to_value)
        .collect::<Vec<_>>();
    let before_cursor = if start > 0 {
        turns
            .get(start)
            .map(|turn| turn.id.clone())
            .map(Value::String)
            .unwrap_or(Value::Null)
    } else {
        Value::Null
    };
    Ok(ThreadHistoryPage {
        thread: json!({
            "id": thread_id,
            "workspace": workspace_value,
            "rolloutPath": rollout_path,
            "turns": page_turns,
        }),
        page: json!({
            "hasMore": start > 0,
            "beforeCursor": before_cursor,
            "limit": normalized_limit,
            "totalTurns": turns.len(),
        }),
    })
}

fn resolve_rollout_path(
    workspace: Option<WorkspaceTarget>,
    rollout_path: &str,
) -> Result<ResolvedRolloutPath, String> {
    let trimmed = rollout_path.trim();
    if trimmed.is_empty() {
        return Err("missing rollout path".to_string());
    }
    match workspace {
        Some(WorkspaceTarget::Wsl2) => {
            if let Some(linux_path) = parse_wsl_unc_to_linux_path(trimmed) {
                return Ok(ResolvedRolloutPath {
                    local_path: Path::new(trimmed).to_path_buf(),
                    linux_path: Some(linux_path),
                });
            }
            let (distro, _) = resolve_wsl_identity()?;
            let linux_path = trimmed.replace('\\', "/");
            Ok(ResolvedRolloutPath {
                local_path: linux_path_to_unc(trimmed, &distro),
                linux_path: Some(linux_path),
            })
        }
        _ => Ok(ResolvedRolloutPath {
            local_path: Path::new(trimmed).to_path_buf(),
            linux_path: None,
        }),
    }
}

#[cfg(target_os = "windows")]
fn wsl_history_python_script() -> &'static str {
    r#"
import json, sys

thread_id, rollout_path, before, limit, workspace, rollout_path_raw = sys.argv[1:7]
before = before.strip()
limit = max(1, min(int(limit), 240))

class Builder:
    def __init__(self):
        self.turns = []
        self.current = None
        self.next_turn_index = 0
        self.next_item_index = 0

    def next_turn_id(self):
        self.next_turn_index += 1
        return f"history-turn-{self.next_turn_index}"

    def next_item_id(self):
        self.next_item_index += 1
        return f"history-item-{self.next_item_index}"

    def new_turn(self, turn_id=None, opened_explicitly=False):
        return {
            "id": (turn_id or "").strip() or self.next_turn_id(),
            "items": [],
            "opened_explicitly": opened_explicitly,
            "saw_compaction": False,
        }

    def ensure_turn(self):
        if self.current is None:
            self.current = self.new_turn()
        return self.current

    def finish_current_turn(self):
        if self.current is None:
            return
        if self.current["items"]:
            self.turns.append(self.current)
        self.current = None

    def build_user_content(self, payload):
        out = []
        msg = (payload.get("message") or "").strip()
        if msg:
            out.append({"type": "input_text", "text": msg})
        for text in payload.get("text_elements") or []:
            text = str(text).strip()
            if text:
                out.append({"type": "input_text", "text": text})
        return out

    def handle_event(self, payload):
        event_type = payload.get("type") or ""
        if event_type == "turn_started":
            self.finish_current_turn()
            turn_id = payload.get("turn_id")
            self.current = self.new_turn(turn_id, True)
        elif event_type in ("turn_complete", "turn_aborted"):
            self.finish_current_turn()
        elif event_type == "user_message":
            should_finish = self.current is not None and not (
                self.current["opened_explicitly"] or (
                    self.current["saw_compaction"] and not self.current["items"]
                )
            )
            if should_finish:
                self.finish_current_turn()
            content = self.build_user_content(payload)
            if not content:
                return
            self.ensure_turn()["items"].append({
                "type": "userMessage",
                "id": self.next_item_id(),
                "content": content,
            })
        elif event_type == "agent_message":
            message = (payload.get("message") or "").strip()
            if not message:
                return
            self.ensure_turn()["items"].append({
                "type": "agentMessage",
                "id": self.next_item_id(),
                "text": message,
            })
        elif event_type == "context_compacted":
            turn = self.ensure_turn()
            turn["saw_compaction"] = True
        elif event_type == "thread_rolled_back":
            self.finish_current_turn()
            num_turns = payload.get("num_turns")
            try:
                num_turns = int(num_turns)
            except Exception:
                return
            if num_turns <= 0:
                return
            keep = max(0, len(self.turns) - num_turns)
            del self.turns[keep:]

    def finish(self):
        self.finish_current_turn()
        return self.turns

b = Builder()
with open(rollout_path, "r", encoding="utf-8") as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        try:
            value = json.loads(line)
        except Exception:
            continue
        if value.get("type") != "event_msg":
            continue
        payload = value.get("payload") or {}
        if isinstance(payload, dict):
            b.handle_event(payload)

turns = b.finish()
page_end = len(turns)
if before:
    needle = before
    for idx, turn in enumerate(turns):
        turn_id = str(turn.get("id") or "").strip()
        if turn_id == needle or turn_id == f"history-turn-{needle}":
            page_end = idx
            break
start = max(0, page_end - limit)
page_turns = [{"id": turn["id"], "items": turn["items"]} for turn in turns[start:page_end]]
before_cursor = turns[start]["id"] if start > 0 else None
print(json.dumps({
    "thread": {
        "id": thread_id,
        "workspace": workspace or None,
        "rolloutPath": rollout_path_raw,
        "turns": page_turns,
    },
    "page": {
        "hasMore": start > 0,
        "beforeCursor": before_cursor,
        "limit": limit,
        "totalTurns": len(turns),
    },
}, ensure_ascii=False))
"#
}

#[cfg(target_os = "windows")]
fn load_thread_history_page_via_wsl(
    thread_id: &str,
    linux_rollout_path: &str,
    before: Option<&str>,
    limit: usize,
    workspace_value: Option<&str>,
    raw_rollout_path: &str,
) -> Result<ThreadHistoryPage, String> {
    let mut cmd = std::process::Command::new("wsl.exe");
    cmd.creation_flags(0x08000000);
    cmd.arg("-e")
        .arg("python3")
        .arg("-c")
        .arg(wsl_history_python_script())
        .arg(thread_id)
        .arg(linux_rollout_path)
        .arg(before.unwrap_or_default())
        .arg(limit.to_string())
        .arg(workspace_value.unwrap_or_default())
        .arg(raw_rollout_path);
    let output = cmd
        .output()
        .map_err(|e| format!("failed to launch WSL history reader: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "WSL history reader failed".to_string()
        } else {
            stderr
        });
    }
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let value = serde_json::from_str::<Value>(&stdout)
        .map_err(|e| format!("invalid WSL history JSON: {e}"))?;
    Ok(ThreadHistoryPage {
        thread: value.get("thread").cloned().unwrap_or(Value::Null),
        page: value.get("page").cloned().unwrap_or(Value::Null),
    })
}

#[cfg(not(target_os = "windows"))]
fn load_thread_history_page_via_wsl(
    thread_id: &str,
    _linux_rollout_path: &str,
    before: Option<&str>,
    limit: usize,
    workspace_value: Option<&str>,
    raw_rollout_path: &str,
) -> Result<ThreadHistoryPage, String> {
    build_thread_history_page(
        thread_id,
        workspace_value,
        raw_rollout_path,
        parse_rollout_turns(Path::new(raw_rollout_path))?,
        before,
        limit,
    )
}

fn parse_rollout_turns(path: &Path) -> Result<Vec<HistoryTurn>, String> {
    let file = File::open(path).map_err(|e| e.to_string())?;
    let reader = BufReader::new(file);
    let mut builder = HistoryTurnBuilder::default();
    for line in reader.lines() {
        let line = line.map_err(|e| e.to_string())?;
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let value = serde_json::from_str::<Value>(trimmed).map_err(|e| e.to_string())?;
        let item_type = value
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let payload = value.get("payload").unwrap_or(&Value::Null);
        match item_type {
            "event_msg" => builder.handle_event(payload),
            "compacted" => builder.handle_compacted(),
            _ => {}
        }
    }
    Ok(builder.finish())
}

fn history_turn_to_value(turn: &HistoryTurn) -> Value {
    json!({
        "id": turn.id,
        "items": turn.items,
    })
}

#[derive(Default)]
struct HistoryTurnBuilder {
    turns: Vec<HistoryTurn>,
    current_turn: Option<HistoryTurn>,
    next_turn_index: usize,
    next_item_index: usize,
}

impl HistoryTurnBuilder {
    fn finish(mut self) -> Vec<HistoryTurn> {
        self.finish_current_turn();
        self.turns
    }

    fn handle_event(&mut self, payload: &Value) {
        let event_type = payload
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        match event_type {
            "turn_started" => self.handle_turn_started(payload),
            "turn_complete" => self.handle_turn_complete(payload),
            "turn_aborted" => self.handle_turn_aborted(),
            "user_message" => self.handle_user_message(payload),
            "agent_message" => self.handle_agent_message(payload),
            "context_compacted" => self.handle_context_compacted(),
            "thread_rolled_back" => self.handle_thread_rollback(payload),
            _ => {}
        }
    }

    fn handle_turn_started(&mut self, payload: &Value) {
        self.finish_current_turn();
        let turn_id = payload
            .get("turn_id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        self.current_turn = Some(self.new_turn(turn_id, true));
    }

    fn handle_turn_complete(&mut self, _payload: &Value) {
        self.finish_current_turn();
    }

    fn handle_turn_aborted(&mut self) {
        self.finish_current_turn();
    }

    fn handle_user_message(&mut self, payload: &Value) {
        let should_finish = self.current_turn.as_ref().is_some_and(|turn| {
            !(turn.opened_explicitly || turn.saw_compaction && turn.items.is_empty())
        });
        if should_finish {
            self.finish_current_turn();
        }
        let item_id = self.next_item_id();
        let content = build_user_content(payload);
        if content.is_empty() {
            return;
        }
        self.ensure_turn().items.push(json!({
            "type": "userMessage",
            "id": item_id,
            "content": content,
        }));
    }

    fn handle_agent_message(&mut self, payload: &Value) {
        let text = payload
            .get("message")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default();
        if text.is_empty() {
            return;
        }
        let item_id = self.next_item_id();
        self.ensure_turn().items.push(json!({
            "type": "agentMessage",
            "id": item_id,
            "text": text,
        }));
    }

    fn handle_context_compacted(&mut self) {
        let item_id = self.next_item_id();
        self.ensure_turn().items.push(json!({
            "type": "contextCompaction",
            "id": item_id,
        }));
    }

    fn handle_compacted(&mut self) {
        self.ensure_turn().saw_compaction = true;
    }

    fn handle_thread_rollback(&mut self, payload: &Value) {
        self.finish_current_turn();
        let num_turns = payload
            .get("num_turns")
            .and_then(Value::as_u64)
            .unwrap_or(0) as usize;
        if num_turns >= self.turns.len() {
            self.turns.clear();
        } else {
            let new_len = self.turns.len().saturating_sub(num_turns);
            self.turns.truncate(new_len);
        }
    }

    fn ensure_turn(&mut self) -> &mut HistoryTurn {
        if self.current_turn.is_none() {
            self.current_turn = Some(self.new_turn(None, false));
        }
        self.current_turn.as_mut().expect("turn exists")
    }

    fn finish_current_turn(&mut self) {
        let Some(turn) = self.current_turn.take() else {
            return;
        };
        if turn.items.is_empty() && !turn.saw_compaction {
            return;
        }
        self.turns.push(turn);
    }

    fn new_turn(&mut self, turn_id: Option<String>, opened_explicitly: bool) -> HistoryTurn {
        self.next_turn_index += 1;
        HistoryTurn {
            id: turn_id.unwrap_or_else(|| format!("history-turn-{}", self.next_turn_index)),
            items: Vec::new(),
            opened_explicitly,
            saw_compaction: false,
        }
    }

    fn next_item_id(&mut self) -> String {
        self.next_item_index += 1;
        format!("history-item-{}", self.next_item_index)
    }
}

fn build_user_content(payload: &Value) -> Vec<Value> {
    let mut content = Vec::new();
    let text = payload
        .get("message")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default();
    if !text.is_empty() {
        content.push(json!({
            "type": "input_text",
            "text": text,
        }));
    }
    if let Some(images) = payload.get("images").and_then(Value::as_array) {
        for image in images {
            let url = image.as_str().map(str::trim).unwrap_or_default();
            if url.is_empty() {
                continue;
            }
            content.push(json!({
                "type": "input_image",
                "image_url": url,
            }));
        }
    }
    if let Some(images) = payload.get("local_images").and_then(Value::as_array) {
        for image in images {
            let path = image.as_str().map(str::trim).unwrap_or_default();
            if path.is_empty() {
                continue;
            }
            content.push(json!({
                "type": "local_image",
                "path": path,
            }));
        }
    }
    content
}

#[cfg(test)]
mod tests {
    use super::load_thread_history_page;
    use super::resolve_rollout_path;
    use crate::orchestrator::gateway::web_codex_home::WorkspaceTarget;
    use std::io::Write;

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

    fn write_rollout(lines: &[&str]) -> tempfile::NamedTempFile {
        let mut file = tempfile::NamedTempFile::new().expect("temp rollout");
        for line in lines {
            writeln!(file, "{line}").expect("write rollout line");
        }
        file
    }

    #[test]
    fn history_page_keeps_assistant_messages_after_compaction() {
        let rollout = write_rollout(&[
            r#"{"type":"session_meta","payload":{"id":"thread-1"}}"#,
            r#"{"type":"event_msg","payload":{"type":"user_message","message":"hello","images":[],"local_images":[],"text_elements":[]}}"#,
            r#"{"type":"event_msg","payload":{"type":"agent_message","message":"hi there"}}"#,
            r#"{"type":"compacted","payload":{"message":"summary only","replacement_history":[{"type":"message","role":"user","content":[{"type":"input_text","text":"summary user only"}]}]}}"#,
            r#"{"type":"event_msg","payload":{"type":"context_compacted"}}"#,
            r#"{"type":"event_msg","payload":{"type":"user_message","message":"next","images":[],"local_images":[],"text_elements":[]}}"#,
            r#"{"type":"event_msg","payload":{"type":"agent_message","message":"done"}}"#,
        ]);
        let result = load_thread_history_page(
            "thread-1",
            Some(WorkspaceTarget::Windows),
            Some(&rollout.path().to_string_lossy()),
            None,
            10,
        )
        .expect("history page");

        let turns = result
            .thread
            .get("turns")
            .and_then(|v| v.as_array())
            .expect("turns array");
        assert_eq!(turns.len(), 2);
        assert_eq!(
            turns[0]["items"][1]["text"].as_str(),
            Some("hi there"),
            "compaction must not erase earlier assistant turns"
        );
        assert_eq!(result.page["hasMore"].as_bool(), Some(false));
    }

    #[test]
    fn history_page_applies_thread_rollback_before_paging() {
        let rollout = write_rollout(&[
            r#"{"type":"session_meta","payload":{"id":"thread-2"}}"#,
            r#"{"type":"event_msg","payload":{"type":"user_message","message":"one","images":[],"local_images":[],"text_elements":[]}}"#,
            r#"{"type":"event_msg","payload":{"type":"agent_message","message":"reply one"}}"#,
            r#"{"type":"event_msg","payload":{"type":"user_message","message":"two","images":[],"local_images":[],"text_elements":[]}}"#,
            r#"{"type":"event_msg","payload":{"type":"agent_message","message":"reply two"}}"#,
            r#"{"type":"event_msg","payload":{"type":"thread_rolled_back","num_turns":1}}"#,
            r#"{"type":"event_msg","payload":{"type":"user_message","message":"three","images":[],"local_images":[],"text_elements":[]}}"#,
            r#"{"type":"event_msg","payload":{"type":"agent_message","message":"reply three"}}"#,
        ]);
        let result = load_thread_history_page(
            "thread-2",
            Some(WorkspaceTarget::Windows),
            Some(&rollout.path().to_string_lossy()),
            None,
            1,
        )
        .expect("history page");
        let turns = result
            .thread
            .get("turns")
            .and_then(|v| v.as_array())
            .expect("turns array");
        assert_eq!(turns.len(), 1);
        assert_eq!(
            turns[0]["items"][0]["content"][0]["text"].as_str(),
            Some("three")
        );
        assert_eq!(result.page["hasMore"].as_bool(), Some(true));
        let before = result.page["beforeCursor"].as_str().expect("before cursor");
        let older = load_thread_history_page(
            "thread-2",
            Some(WorkspaceTarget::Windows),
            Some(&rollout.path().to_string_lossy()),
            Some(before),
            1,
        )
        .expect("older page");
        let older_turns = older
            .thread
            .get("turns")
            .and_then(|v| v.as_array())
            .expect("older turns");
        assert_eq!(older_turns.len(), 1);
        assert_eq!(
            older_turns[0]["items"][0]["content"][0]["text"].as_str(),
            Some("one")
        );
        assert_eq!(older.page["hasMore"].as_bool(), Some(false));
    }

    #[test]
    fn wsl_rollout_path_resolves_to_unc() {
        let _home = EnvGuard::set("API_ROUTER_WEB_CODEX_WSL_CODEX_HOME", "/home/test/.codex");
        let path = resolve_rollout_path(
            Some(WorkspaceTarget::Wsl2),
            "/home/test/.codex/sessions/2026/03/07/rollout.jsonl",
        )
        .expect("resolve wsl rollout path");
        let text = path.local_path.to_string_lossy().replace('/', "\\");
        assert!(
            text.starts_with(r"\\wsl.localhost\") || text.starts_with(r"\\wsl$\"),
            "expected WSL UNC path, got {text}"
        );
        assert_eq!(
            path.linux_path.as_deref(),
            Some("/home/test/.codex/sessions/2026/03/07/rollout.jsonl")
        );
    }

    #[test]
    fn wsl_unc_rollout_path_is_preserved() {
        let path = resolve_rollout_path(
            Some(WorkspaceTarget::Wsl2),
            r"\\wsl.localhost\Ubuntu\home\test\.codex\sessions\2026\03\07\rollout.jsonl",
        )
        .expect("resolve unc rollout path");
        assert_eq!(
            path.local_path,
            std::path::PathBuf::from(
                r"\\wsl.localhost\Ubuntu\home\test\.codex\sessions\2026\03\07\rollout.jsonl"
            )
        );
        assert_eq!(
            path.linux_path.as_deref(),
            Some("/home/test/.codex/sessions/2026/03/07/rollout.jsonl")
        );
    }
}
