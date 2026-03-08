use super::web_codex_home::{
    linux_path_to_unc, parse_wsl_unc_to_linux_path, resolve_wsl_identity, WorkspaceTarget,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

mod cache;
mod wsl_index;

use self::cache::load_cached_rollout_history;
use self::wsl_index::load_wsl_history_page;

const DEFAULT_HISTORY_PAGE_LIMIT: usize = 60;
const MAX_HISTORY_PAGE_LIMIT: usize = 240;

#[derive(Clone, Debug, Serialize, Deserialize)]
struct HistoryTurn {
    id: String,
    items: Vec<Value>,
    opened_explicitly: bool,
    saw_compaction: bool,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct ParsedRolloutHistory {
    turns: Vec<HistoryTurn>,
    token_usage: Option<Value>,
}

pub(super) struct ThreadHistoryPage {
    pub(super) thread: Value,
    pub(super) page: Value,
}

struct ResolvedRolloutPath {
    local_path: PathBuf,
    #[cfg_attr(not(test), allow(dead_code))]
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

pub(super) fn spawn_wsl_history_prewarm(items: &[Value]) {
    self::wsl_index::spawn_wsl_history_prewarm(items);
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
    if matches!(workspace, Some(WorkspaceTarget::Wsl2)) {
        if let Some(linux_rollout_path) = resolved.linux_path.as_deref() {
            return load_wsl_history_page(
                thread_id,
                workspace_value,
                raw_rollout_path,
                &resolved.local_path,
                linux_rollout_path,
                before,
                normalized_limit,
            );
        }
    }
    let parsed = load_cached_rollout_history(&resolved.local_path)?;
    let page = build_thread_history_page(
        thread_id,
        workspace_value,
        raw_rollout_path,
        parsed.turns.as_slice(),
        parsed.token_usage.as_ref(),
        before,
        normalized_limit,
    )?;
    Ok(page)
}

fn build_thread_history_page(
    thread_id: &str,
    workspace_value: Option<&str>,
    rollout_path: &str,
    turns: &[HistoryTurn],
    token_usage: Option<&Value>,
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
            "tokenUsage": token_usage.cloned().unwrap_or(Value::Null),
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

fn parse_rollout_history(path: &Path) -> Result<ParsedRolloutHistory, String> {
    #[cfg(test)]
    {
        let path_key = path.to_string_lossy().to_string();
        let mut counts = match history_parse_counts_by_path().lock() {
            Ok(guard) => guard,
            Err(err) => err.into_inner(),
        };
        *counts.entry(path_key).or_insert(0) += 1;
    }
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

fn normalize_token_usage_stats(value: &Value) -> Option<Value> {
    let total_tokens = value.get("total_tokens").and_then(Value::as_u64);
    let input_tokens = value.get("input_tokens").and_then(Value::as_u64);
    let cached_input_tokens = value.get("cached_input_tokens").and_then(Value::as_u64);
    let output_tokens = value.get("output_tokens").and_then(Value::as_u64);
    let reasoning_output_tokens = value.get("reasoning_output_tokens").and_then(Value::as_u64);
    if total_tokens.is_none()
        && input_tokens.is_none()
        && cached_input_tokens.is_none()
        && output_tokens.is_none()
        && reasoning_output_tokens.is_none()
    {
        return None;
    }
    Some(json!({
        "totalTokens": total_tokens,
        "inputTokens": input_tokens,
        "cachedInputTokens": cached_input_tokens,
        "outputTokens": output_tokens,
        "reasoningOutputTokens": reasoning_output_tokens,
    }))
}

fn normalize_token_usage_info(info: &Value) -> Option<Value> {
    let total = info
        .get("total_token_usage")
        .and_then(normalize_token_usage_stats);
    let last = info
        .get("last_token_usage")
        .and_then(normalize_token_usage_stats);
    let model_context_window = info.get("model_context_window").and_then(Value::as_u64);
    if total.is_none() && last.is_none() && model_context_window.is_none() {
        return None;
    }
    Some(json!({
        "total": total,
        "last": last,
        "modelContextWindow": model_context_window,
    }))
}

#[cfg(test)]
fn history_parse_counts_by_path(
) -> &'static std::sync::Mutex<std::collections::HashMap<String, usize>> {
    static COUNTS: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, usize>>> =
        std::sync::OnceLock::new();
    COUNTS.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

#[cfg(test)]
fn reset_history_parse_counter() {
    match history_parse_counts_by_path().lock() {
        Ok(mut guard) => guard.clear(),
        Err(err) => err.into_inner().clear(),
    }
}

#[cfg(test)]
fn history_parse_count_for_path(path: &Path) -> usize {
    let path_key = path.to_string_lossy().to_string();
    match history_parse_counts_by_path().lock() {
        Ok(guard) => guard.get(&path_key).copied().unwrap_or(0),
        Err(err) => err.into_inner().get(&path_key).copied().unwrap_or(0),
    }
}

fn history_turn_to_value(turn: &HistoryTurn) -> Value {
    json!({
        "id": turn.id,
        "items": turn.items,
    })
}

#[derive(Clone, Default, Serialize, Deserialize, Debug)]
struct HistoryTurnBuilder {
    turns: Vec<HistoryTurn>,
    current_turn: Option<HistoryTurn>,
    next_turn_index: usize,
    next_item_index: usize,
    token_usage: Option<Value>,
}

impl HistoryTurnBuilder {
    fn finish(mut self) -> ParsedRolloutHistory {
        self.finish_current_turn();
        ParsedRolloutHistory {
            turns: self.turns,
            token_usage: self.token_usage,
        }
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
            "token_count" => self.handle_token_count(payload),
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

    fn handle_token_count(&mut self, payload: &Value) {
        let Some(info) = payload.get("info") else {
            return;
        };
        if let Some(token_usage) = normalize_token_usage_info(info) {
            self.token_usage = Some(token_usage);
        }
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
    use super::cache::_clear_history_turns_cache_for_test;
    use super::history_parse_count_for_path;
    use super::load_thread_history_page;
    use super::reset_history_parse_counter;
    use super::resolve_rollout_path;
    use super::wsl_index::_set_test_wsl_history_loader;
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
    fn history_page_includes_latest_token_usage_snapshot() {
        _clear_history_turns_cache_for_test();
        let rollout = write_rollout(&[
            r#"{"type":"session_meta","payload":{"id":"thread-token-usage"}}"#,
            r#"{"type":"event_msg","payload":{"type":"token_count","info":null}}"#,
            r#"{"type":"event_msg","payload":{"type":"user_message","message":"hello","images":[],"local_images":[],"text_elements":[]}}"#,
            r#"{"type":"event_msg","payload":{"type":"agent_message","message":"world"}}"#,
            r#"{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":2048,"cached_input_tokens":512,"output_tokens":128,"reasoning_output_tokens":64,"total_tokens":2176},"last_token_usage":{"input_tokens":48,"cached_input_tokens":0,"output_tokens":16,"reasoning_output_tokens":8,"total_tokens":64},"model_context_window":32768}}}"#,
        ]);
        let result = load_thread_history_page(
            "thread-token-usage",
            Some(WorkspaceTarget::Windows),
            Some(&rollout.path().to_string_lossy()),
            None,
            10,
        )
        .expect("history page");
        assert_eq!(
            result.thread["tokenUsage"]["total"]["totalTokens"].as_u64(),
            Some(2176)
        );
        assert_eq!(
            result.thread["tokenUsage"]["last"]["totalTokens"].as_u64(),
            Some(64)
        );
        assert_eq!(
            result.thread["tokenUsage"]["modelContextWindow"].as_u64(),
            Some(32768)
        );
    }

    #[test]
    fn history_page_cache_reuses_parsed_turns_across_pages() {
        _clear_history_turns_cache_for_test();
        reset_history_parse_counter();
        let rollout = write_rollout(&[
            r#"{"type":"session_meta","payload":{"id":"thread-cache"}}"#,
            r#"{"type":"event_msg","payload":{"type":"user_message","message":"one","images":[],"local_images":[],"text_elements":[]}}"#,
            r#"{"type":"event_msg","payload":{"type":"agent_message","message":"reply one"}}"#,
            r#"{"type":"event_msg","payload":{"type":"user_message","message":"two","images":[],"local_images":[],"text_elements":[]}}"#,
            r#"{"type":"event_msg","payload":{"type":"agent_message","message":"reply two"}}"#,
            r#"{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":1024,"cached_input_tokens":0,"output_tokens":32,"reasoning_output_tokens":16,"total_tokens":1056},"last_token_usage":{"input_tokens":32,"cached_input_tokens":0,"output_tokens":8,"reasoning_output_tokens":4,"total_tokens":40},"model_context_window":8192}}}"#,
            r#"{"type":"event_msg","payload":{"type":"user_message","message":"three","images":[],"local_images":[],"text_elements":[]}}"#,
            r#"{"type":"event_msg","payload":{"type":"agent_message","message":"reply three"}}"#,
        ]);
        let first = load_thread_history_page(
            "thread-cache",
            Some(WorkspaceTarget::Windows),
            Some(&rollout.path().to_string_lossy()),
            None,
            1,
        )
        .expect("first page");
        assert_eq!(
            history_parse_count_for_path(rollout.path()),
            1,
            "first page should parse rollout once"
        );
        assert_eq!(
            first.thread["tokenUsage"]["total"]["totalTokens"].as_u64(),
            Some(1056)
        );
        let before = first.page["beforeCursor"].as_str().expect("before cursor");
        let older = load_thread_history_page(
            "thread-cache",
            Some(WorkspaceTarget::Windows),
            Some(&rollout.path().to_string_lossy()),
            Some(before),
            1,
        )
        .expect("older page");
        assert_eq!(
            history_parse_count_for_path(rollout.path()),
            1,
            "older page should reuse cached parsed turns instead of reparsing"
        );
        assert_eq!(
            older.thread["tokenUsage"]["modelContextWindow"].as_u64(),
            Some(8192)
        );
        let older_turns = older.thread["turns"].as_array().expect("older turns");
        assert_eq!(older_turns.len(), 1);
        assert_eq!(
            older_turns[0]["items"][0]["content"][0]["text"].as_str(),
            Some("two")
        );
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

    #[test]
    fn wsl_history_uses_linux_loader_instead_of_unc_file_reads() {
        let _home = EnvGuard::set("API_ROUTER_WEB_CODEX_WSL_CODEX_HOME", "/home/test/.codex");
        let seen = std::sync::Arc::new(std::sync::Mutex::new(None::<String>));
        let seen_clone = seen.clone();
        _set_test_wsl_history_loader(Some(std::sync::Arc::new(
            move |_thread_id,
                  _workspace,
                  _raw_rollout_path,
                  linux_rollout_path,
                  _before,
                  _limit| {
                match seen_clone.lock() {
                    Ok(mut guard) => *guard = Some(linux_rollout_path),
                    Err(err) => *err.into_inner() = Some(String::new()),
                }
                Ok(super::ThreadHistoryPage {
                    thread: serde_json::json!({
                        "id": "thread-wsl",
                        "workspace": "wsl2",
                        "rolloutPath": "/home/test/.codex/sessions/2026/03/07/rollout.jsonl",
                        "turns": [],
                    }),
                    page: serde_json::json!({
                        "hasMore": false,
                        "beforeCursor": serde_json::Value::Null,
                        "limit": 1,
                        "totalTurns": 0,
                    }),
                })
            },
        )));
        let result = load_thread_history_page(
            "thread-wsl",
            Some(WorkspaceTarget::Wsl2),
            Some("/home/test/.codex/sessions/2026/03/07/rollout.jsonl"),
            None,
            1,
        )
        .expect("wsl history page");
        _set_test_wsl_history_loader(None);
        let linux_rollout_path = match seen.lock() {
            Ok(guard) => guard.clone(),
            Err(err) => err.into_inner().clone(),
        };
        assert_eq!(
            linux_rollout_path.as_deref(),
            Some("/home/test/.codex/sessions/2026/03/07/rollout.jsonl")
        );
        assert_eq!(result.thread["workspace"].as_str(), Some("wsl2"));
    }
}
