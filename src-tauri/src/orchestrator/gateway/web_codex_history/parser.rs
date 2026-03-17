use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::Path;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(super) struct HistoryTurn {
    pub(super) id: String,
    pub(super) items: Vec<Value>,
    pub(super) opened_explicitly: bool,
    pub(super) saw_compaction: bool,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub(super) struct ParsedRolloutHistory {
    pub(super) turns: Vec<HistoryTurn>,
    pub(super) token_usage: Option<Value>,
    pub(super) incomplete: bool,
}

pub(super) fn parse_rollout_history(path: &Path) -> Result<ParsedRolloutHistory, String> {
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
            "response_item" => builder.handle_response_item(payload),
            "compacted" => builder.handle_compacted(),
            _ => {}
        }
    }
    Ok(builder.finish())
}

pub(super) fn history_turn_to_value(turn: &HistoryTurn) -> Value {
    json!({
        "id": turn.id,
        "items": turn.items,
    })
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

fn assistant_phase(payload: &Value) -> Option<String> {
    payload
        .get("phase")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

#[cfg(test)]
fn history_parse_counts_by_path(
) -> &'static std::sync::Mutex<std::collections::HashMap<String, usize>> {
    static COUNTS: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, usize>>> =
        std::sync::OnceLock::new();
    COUNTS.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

#[cfg(test)]
pub(super) fn reset_history_parse_counter() {
    match history_parse_counts_by_path().lock() {
        Ok(mut guard) => guard.clear(),
        Err(err) => err.into_inner().clear(),
    }
}

#[cfg(test)]
pub(super) fn history_parse_count_for_path(path: &Path) -> usize {
    let path_key = path.to_string_lossy().to_string();
    match history_parse_counts_by_path().lock() {
        Ok(guard) => guard.get(&path_key).copied().unwrap_or(0),
        Err(err) => err.into_inner().get(&path_key).copied().unwrap_or(0),
    }
}

#[derive(Clone, Default, Debug)]
struct HistoryTurnBuilder {
    turns: Vec<HistoryTurn>,
    current_turn: Option<HistoryTurn>,
    next_turn_index: usize,
    next_item_index: usize,
    token_usage: Option<Value>,
    pending_tool_calls: HashMap<String, PendingToolCall>,
}

#[derive(Clone, Copy, Debug)]
struct PendingToolCall {
    index: usize,
    kind: PendingToolKind,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum PendingToolKind {
    CommandExecution,
    ToolCall,
}

impl HistoryTurnBuilder {
    fn finish(mut self) -> ParsedRolloutHistory {
        let incomplete = self.current_turn.is_some();
        self.finish_current_turn();
        ParsedRolloutHistory {
            turns: self.turns,
            token_usage: self.token_usage,
            incomplete,
        }
    }

    fn handle_event(&mut self, payload: &Value) {
        let event_type = payload
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        match event_type {
            "turn_started" | "task_started" => self.handle_turn_started(payload),
            "turn_complete" | "task_complete" => self.handle_turn_complete(),
            "turn_aborted" | "task_aborted" => self.handle_turn_aborted(),
            "user_message" => self.handle_user_message(payload),
            "agent_message" => self.handle_agent_message(payload),
            "token_count" => self.handle_token_count(payload),
            "context_compacted" => self.handle_context_compacted(),
            "thread_rolled_back" => self.handle_thread_rollback(payload),
            "item_completed" => self.handle_item_completed(payload),
            _ => {}
        }
    }

    fn handle_response_item(&mut self, payload: &Value) {
        let item_type = payload
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        match item_type {
            "function_call" => self.handle_function_call(payload),
            "function_call_output" => self.handle_function_call_output(payload),
            "custom_tool_call" => self.handle_custom_tool_call(payload),
            "custom_tool_call_output" => self.handle_custom_tool_call_output(payload),
            "web_search_call" => self.handle_web_search_call(payload),
            "message" => self.handle_response_message(payload),
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

    fn handle_turn_complete(&mut self) {
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
        self.push_assistant_text_item("agentMessage", text, assistant_phase(payload));
    }

    fn handle_context_compacted(&mut self) {
        let item_id = self.next_item_id();
        self.ensure_turn().items.push(json!({
            "type": "contextCompaction",
            "id": item_id,
        }));
    }

    fn handle_item_completed(&mut self, payload: &Value) {
        let Some(item) = payload.get("item") else {
            return;
        };
        let Some(value) = canonicalize_history_tool_item(item) else {
            return;
        };
        self.push_turn_item(value);
    }

    fn handle_function_call(&mut self, payload: &Value) {
        let name = payload
            .get("name")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default();
        let item_id = self.next_item_id();
        let call_id = payload
            .get("call_id")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default();
        let value = if is_shell_like_tool_name(name) {
            json!({
                "type": "commandExecution",
                "id": item_id,
                "callId": empty_to_none(call_id),
                "command": read_command_from_tool_arguments(payload.get("arguments")),
                "status": payload.get("status").and_then(Value::as_str),
            })
        } else {
            json!({
                "type": "toolCall",
                "id": item_id,
                "callId": empty_to_none(call_id),
                "tool": empty_to_none(name),
                "arguments": payload.get("arguments").cloned().unwrap_or(Value::Null),
                "status": payload.get("status").and_then(Value::as_str),
            })
        };
        let index = self.push_turn_item(value);
        if !call_id.is_empty() {
            let kind = if is_shell_like_tool_name(name) {
                PendingToolKind::CommandExecution
            } else {
                PendingToolKind::ToolCall
            };
            self.pending_tool_calls
                .insert(call_id.to_string(), PendingToolCall { index, kind });
        }
    }

    fn handle_function_call_output(&mut self, payload: &Value) {
        let call_id = payload
            .get("call_id")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default();
        if call_id.is_empty() {
            return;
        }
        let Some(pending) = self.pending_tool_calls.get(call_id).copied() else {
            return;
        };
        let parsed = parse_embedded_json_value(payload.get("output")).unwrap_or(Value::Null);
        match pending.kind {
            PendingToolKind::CommandExecution => {
                let output = extract_tool_text(&parsed);
                let exit_code = parsed
                    .get("metadata")
                    .and_then(Value::as_object)
                    .and_then(|value| value.get("exit_code"))
                    .and_then(Value::as_i64);
                if let Some(item) = self.turn_item_object_mut(pending.index) {
                    item.insert(
                        "status".to_string(),
                        json!(command_completion_status(exit_code, &parsed)),
                    );
                    if let Some(value) = output {
                        item.insert("output".to_string(), Value::String(value));
                    }
                    if let Some(value) = exit_code {
                        item.insert("exitCode".to_string(), json!(value));
                    }
                }
            }
            PendingToolKind::ToolCall => {
                if let Some(item) = self.turn_item_object_mut(pending.index) {
                    item.insert("status".to_string(), json!(tool_completion_status(&parsed)));
                    if !parsed.is_null() {
                        if let Some(value) = extract_tool_text_value(&parsed) {
                            item.insert("result".to_string(), value);
                        }
                    }
                }
            }
        }
    }

    fn handle_custom_tool_call(&mut self, payload: &Value) {
        let item_id = self.next_item_id();
        let call_id = payload
            .get("call_id")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default();
        let tool = payload
            .get("name")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default();
        let value = json!({
            "type": "toolCall",
            "id": item_id,
            "callId": empty_to_none(call_id),
            "tool": empty_to_none(tool),
            "input": payload.get("input").cloned().unwrap_or(Value::Null),
            "status": payload.get("status").and_then(Value::as_str),
        });
        let index = self.push_turn_item(value);
        if !call_id.is_empty() {
            self.pending_tool_calls.insert(
                call_id.to_string(),
                PendingToolCall {
                    index,
                    kind: PendingToolKind::ToolCall,
                },
            );
        }
    }

    fn handle_custom_tool_call_output(&mut self, payload: &Value) {
        self.handle_function_call_output(payload);
    }

    fn handle_web_search_call(&mut self, payload: &Value) {
        let item_id = self.next_item_id();
        let action = payload.get("action").cloned().unwrap_or(Value::Null);
        let query = action
            .get("query")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        self.push_turn_item(json!({
            "type": "webSearch",
            "id": item_id,
            "status": payload.get("status").and_then(Value::as_str),
            "query": query,
            "action": action,
        }));
    }

    fn handle_response_message(&mut self, payload: &Value) {
        let role = payload
            .get("role")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default();
        if !role.eq_ignore_ascii_case("assistant") {
            return;
        }
        let Some(text) = extract_response_message_text(payload.get("content")) else {
            return;
        };
        self.push_assistant_text_item("assistantMessage", &text, assistant_phase(payload));
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
            self.pending_tool_calls.clear();
        }
        self.current_turn.as_mut().expect("turn exists")
    }

    fn finish_current_turn(&mut self) {
        let Some(turn) = self.current_turn.take() else {
            return;
        };
        self.pending_tool_calls.clear();
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

    fn push_turn_item(&mut self, item: Value) -> usize {
        let turn = self.ensure_turn();
        turn.items.push(item);
        turn.items.len().saturating_sub(1)
    }

    fn push_assistant_text_item(&mut self, item_type: &str, text: &str, phase: Option<String>) {
        let trimmed = text.trim();
        if trimmed.is_empty() {
            return;
        }
        let should_skip_duplicate = self
            .current_turn
            .as_ref()
            .and_then(|turn| turn.items.last())
            .and_then(Value::as_object)
            .is_some_and(|item| {
                let existing_type = item.get("type").and_then(Value::as_str).unwrap_or_default();
                let existing_text = item
                    .get("text")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .unwrap_or_default();
                let existing_phase = item
                    .get("phase")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty());
                let next_phase = phase
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty());
                matches!(existing_type, "agentMessage" | "assistantMessage")
                    && existing_text == trimmed
                    && existing_phase == next_phase
            });
        if should_skip_duplicate {
            return;
        }
        let item_id = self.next_item_id();
        let mut item = json!({
            "type": item_type,
            "id": item_id,
            "text": trimmed,
        });
        if let Some(phase_value) = phase.filter(|value| !value.trim().is_empty()) {
            if let Some(map) = item.as_object_mut() {
                map.insert("phase".to_string(), Value::String(phase_value));
            }
        }
        self.push_turn_item(item);
    }

    fn turn_item_object_mut(
        &mut self,
        index: usize,
    ) -> Option<&mut serde_json::Map<String, Value>> {
        self.current_turn
            .as_mut()
            .and_then(|turn| turn.items.get_mut(index))
            .and_then(Value::as_object_mut)
    }
}

fn empty_to_none(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn normalize_history_item_type(value: &str) -> String {
    value
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn parse_embedded_json_value(value: Option<&Value>) -> Option<Value> {
    let raw = value?;
    match raw {
        Value::Null => None,
        Value::String(text) => serde_json::from_str::<Value>(text).ok().or_else(|| {
            let trimmed = text.trim();
            (!trimmed.is_empty()).then(|| Value::String(trimmed.to_string()))
        }),
        other => Some(other.clone()),
    }
}

fn extract_tool_text(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => {
            let trimmed = text.trim();
            (!trimmed.is_empty()).then(|| trimmed.to_string())
        }
        Value::Object(map) => map
            .get("output")
            .and_then(extract_tool_text)
            .or_else(|| map.get("text").and_then(extract_tool_text)),
        Value::Array(items) => {
            let parts = items
                .iter()
                .filter_map(extract_tool_text)
                .collect::<Vec<_>>();
            (!parts.is_empty()).then(|| parts.join("\n"))
        }
        _ => None,
    }
}

fn extract_tool_text_value(value: &Value) -> Option<Value> {
    if let Some(text) = extract_tool_text(value) {
        return Some(Value::String(text));
    }
    match value {
        Value::Null => None,
        other => Some(other.clone()),
    }
}

fn value_has_failure_marker(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => !*flag,
        Value::String(text) => {
            let trimmed = text.trim().to_ascii_lowercase();
            !trimmed.is_empty()
                && (trimmed.contains("failed")
                    || trimmed.contains("error")
                    || trimmed.contains("denied")
                    || trimmed.contains("timeout"))
        }
        Value::Array(items) => items.iter().any(value_has_failure_marker),
        Value::Object(map) => {
            map.get("success").and_then(Value::as_bool) == Some(false)
                || map.get("ok").and_then(Value::as_bool) == Some(false)
                || map.get("error").is_some_and(|error| {
                    !matches!(error, Value::Null) && value_has_failure_marker(error)
                })
                || map
                    .get("stderr")
                    .and_then(extract_tool_text)
                    .is_some_and(|text| !text.trim().is_empty())
                || map
                    .get("status")
                    .and_then(Value::as_str)
                    .is_some_and(|status| {
                        matches!(
                            status.trim().to_ascii_lowercase().as_str(),
                            "failed" | "error" | "denied" | "cancelled" | "timeout"
                        )
                    })
        }
        _ => false,
    }
}

fn command_completion_status(exit_code: Option<i64>, parsed: &Value) -> &'static str {
    if exit_code.unwrap_or(0) != 0 || value_has_failure_marker(parsed) {
        "failed"
    } else {
        "completed"
    }
}

fn tool_completion_status(parsed: &Value) -> &'static str {
    if value_has_failure_marker(parsed) {
        "failed"
    } else {
        "completed"
    }
}

fn read_command_from_tool_arguments(arguments: Option<&Value>) -> Option<String> {
    let parsed = parse_embedded_json_value(arguments)?;
    let command = parsed
        .get("command")
        .or_else(|| parsed.get("cmd"))
        .or_else(|| parsed.get("args"))?;
    match command {
        Value::String(text) => {
            let trimmed = text.trim();
            (!trimmed.is_empty()).then(|| trimmed.to_string())
        }
        Value::Array(parts) => {
            let joined = parts
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .collect::<Vec<_>>()
                .join(" ");
            (!joined.is_empty()).then_some(joined)
        }
        other => serde_json::to_string(other).ok(),
    }
}

fn is_shell_like_tool_name(name: &str) -> bool {
    let normalized = normalize_history_item_type(name);
    normalized == "shell"
        || normalized == "execcommand"
        || normalized.ends_with("shellcommand")
        || normalized.ends_with("localshell")
        || normalized.ends_with("containerexec")
        || normalized.ends_with("unifiedexec")
}

fn extract_response_message_text(content: Option<&Value>) -> Option<String> {
    let parts = content?.as_array()?;
    let lines = parts
        .iter()
        .filter_map(|part| {
            let part_type = part.get("type").and_then(Value::as_str).unwrap_or_default();
            let normalized = normalize_history_item_type(part_type);
            if normalized != "outputtext" && normalized != "inputtext" && normalized != "text" {
                return None;
            }
            extract_tool_text(part.get("text").unwrap_or(&Value::Null))
        })
        .collect::<Vec<_>>();
    (!lines.is_empty()).then(|| lines.join("\n"))
}

fn canonicalize_history_tool_item(item: &Value) -> Option<Value> {
    let item_type = item.get("type").and_then(Value::as_str).unwrap_or_default();
    let normalized = normalize_history_item_type(item_type);
    let item_id = item.get("id").cloned().unwrap_or(Value::Null);
    match normalized.as_str() {
        "plan" => {
            let text = item.get("text").and_then(Value::as_str)?.trim();
            (!text.is_empty()).then(|| {
                json!({
                    "type": "plan",
                    "id": item_id,
                    "text": text,
                })
            })
        }
        "commandexecution" => {
            let exit_code = item
                .get("exitCode")
                .and_then(Value::as_i64)
                .or_else(|| item.get("exit_code").and_then(Value::as_i64));
            let parsed_output = item.get("output").cloned().unwrap_or(Value::Null);
            Some(json!({
                "type": "commandExecution",
                "id": item_id,
                "command": item.get("command").and_then(Value::as_str),
                "status": command_completion_status(exit_code, &parsed_output),
                "output": extract_tool_text_value(item.get("output").unwrap_or(&Value::Null)),
                "exitCode": exit_code,
            }))
        }
        "mcptoolcall" | "toolcall" => {
            let tool = item
                .get("tool")
                .and_then(Value::as_str)
                .or_else(|| item.get("name").and_then(Value::as_str));
            if is_shell_like_tool_name(tool.unwrap_or_default()) {
                let command = item
                    .get("command")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .or_else(|| read_command_from_tool_arguments(item.get("arguments")))
                    .or_else(|| read_command_from_tool_arguments(item.get("input")));
                Some(json!({
                    "type": "commandExecution",
                    "id": item_id,
                    "command": command,
                    "status": item.get("status").and_then(Value::as_str),
                    "output": extract_tool_text_value(item.get("output").unwrap_or(&Value::Null)).or_else(|| item.get("result").cloned()),
                    "exitCode": item.get("exitCode").and_then(Value::as_i64).or_else(|| item.get("exit_code").and_then(Value::as_i64)),
                }))
            } else {
                let parsed_result = item
                    .get("result")
                    .cloned()
                    .or_else(|| item.get("output").cloned())
                    .unwrap_or(Value::Null);
                Some(json!({
                    "type": "toolCall",
                    "id": item_id,
                    "tool": tool,
                    "server": item.get("server").and_then(Value::as_str),
                    "arguments": item.get("arguments").cloned().unwrap_or(Value::Null),
                    "input": item.get("input").cloned().unwrap_or(Value::Null),
                    "status": tool_completion_status(&parsed_result),
                    "result": item.get("result").cloned().or_else(|| extract_tool_text_value(item.get("output").unwrap_or(&Value::Null))),
                    "error": item.get("error").cloned().unwrap_or(Value::Null),
                }))
            }
        }
        "websearch" => Some(json!({
            "type": "webSearch",
            "id": item_id,
            "status": item.get("status").and_then(Value::as_str),
            "query": item.get("query").and_then(Value::as_str).or_else(|| item.get("action").and_then(|value| value.get("query")).and_then(Value::as_str)),
            "action": item.get("action").cloned().unwrap_or(Value::Null),
        })),
        "filechange" => Some(json!({
            "type": "fileChange",
            "id": item_id,
            "status": item.get("status").and_then(Value::as_str),
            "changes": item.get("changes").cloned().unwrap_or_else(|| json!([])),
        })),
        "enteredreviewmode" => Some(json!({ "type": "enteredReviewMode", "id": item_id })),
        "exitedreviewmode" => Some(json!({ "type": "exitedReviewMode", "id": item_id })),
        "contextcompaction" => Some(json!({ "type": "contextCompaction", "id": item_id })),
        _ => None,
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
    use super::parse_rollout_history;
    use std::io::Write;

    fn write_rollout(lines: &[&str]) -> tempfile::NamedTempFile {
        let mut file = tempfile::NamedTempFile::new().expect("temp rollout");
        for line in lines {
            writeln!(file, "{line}").expect("write rollout line");
        }
        file
    }

    #[test]
    fn parser_dedupes_same_assistant_text_from_event_and_response_item() {
        let rollout = write_rollout(&[
            r#"{"type":"session_meta","payload":{"id":"thread-dup"}}"#,
            r#"{"type":"event_msg","payload":{"type":"turn_started","turn_id":"turn-1"}}"#,
            r#"{"type":"event_msg","payload":{"type":"user_message","message":"hello","images":[],"local_images":[],"text_elements":[]}}"#,
            r#"{"type":"event_msg","payload":{"type":"agent_message","message":"same reply"}}"#,
            r#"{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"same reply"}]}}"#,
            r#"{"type":"event_msg","payload":{"type":"turn_complete"}}"#,
        ]);

        let parsed = parse_rollout_history(rollout.path()).expect("parsed history");
        assert_eq!(parsed.turns.len(), 1);
        let items = &parsed.turns[0].items;
        assert_eq!(items.len(), 2, "duplicate assistant item should be removed");
        assert_eq!(items[0]["type"].as_str(), Some("userMessage"));
        assert_eq!(items[1]["text"].as_str(), Some("same reply"));
    }

    #[test]
    fn parser_preserves_commentary_phase_assistant_messages_for_history_state() {
        let rollout = write_rollout(&[
            r#"{"type":"session_meta","payload":{"id":"thread-commentary"}}"#,
            r#"{"type":"event_msg","payload":{"type":"turn_started","turn_id":"turn-1"}}"#,
            r#"{"type":"event_msg","payload":{"type":"user_message","message":"hello","images":[],"local_images":[],"text_elements":[]}}"#,
            r#"{"type":"event_msg","payload":{"type":"agent_message","message":"working notes","phase":"commentary"}}"#,
            r#"{"type":"response_item","payload":{"type":"message","role":"assistant","phase":"commentary","content":[{"type":"output_text","text":"working notes"}]}}"#,
            r#"{"type":"response_item","payload":{"type":"message","role":"assistant","phase":"final_answer","content":[{"type":"output_text","text":"done"}]}}"#,
            r#"{"type":"event_msg","payload":{"type":"turn_complete"}}"#,
        ]);

        let parsed = parse_rollout_history(rollout.path()).expect("parsed history");
        assert_eq!(parsed.turns.len(), 1);
        let items = &parsed.turns[0].items;
        assert_eq!(
            items.len(),
            3,
            "commentary-phase items should remain in turn history"
        );
        assert_eq!(items[0]["type"].as_str(), Some("userMessage"));
        assert_eq!(items[1]["type"].as_str(), Some("agentMessage"));
        assert_eq!(items[1]["phase"].as_str(), Some("commentary"));
        assert_eq!(items[1]["text"].as_str(), Some("working notes"));
        assert_eq!(items[2]["type"].as_str(), Some("assistantMessage"));
        assert_eq!(items[2]["phase"].as_str(), Some("final_answer"));
        assert_eq!(items[2]["text"].as_str(), Some("done"));
    }

    #[test]
    fn parser_accepts_task_event_aliases_as_turn_boundaries() {
        let rollout = write_rollout(&[
            r#"{"type":"session_meta","payload":{"id":"thread-task-alias"}}"#,
            r#"{"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-1"}}"#,
            r#"{"type":"event_msg","payload":{"type":"user_message","message":"hello","images":[],"local_images":[],"text_elements":[]}}"#,
            r#"{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"first reply"}]}}"#,
            r#"{"type":"event_msg","payload":{"type":"task_complete"}}"#,
            r#"{"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-2"}}"#,
            r#"{"type":"event_msg","payload":{"type":"user_message","message":"again","images":[],"local_images":[],"text_elements":[]}}"#,
            r#"{"type":"event_msg","payload":{"type":"task_aborted"}}"#,
        ]);

        let parsed = parse_rollout_history(rollout.path()).expect("parsed history");
        assert!(
            !parsed.incomplete,
            "task_complete/task_aborted should close the current turn"
        );
        assert_eq!(
            parsed.turns.len(),
            2,
            "task aliases should split rollout into distinct turns"
        );
        assert_eq!(parsed.turns[0].id, "turn-1");
        assert_eq!(parsed.turns[1].id, "turn-2");
        assert_eq!(
            parsed.turns[0].items[0]["type"].as_str(),
            Some("userMessage")
        );
        assert_eq!(
            parsed.turns[0].items[1]["text"].as_str(),
            Some("first reply")
        );
        assert_eq!(
            parsed.turns[1].items[0]["type"].as_str(),
            Some("userMessage")
        );
    }

    #[test]
    fn parser_treats_exec_command_response_items_as_command_execution() {
        let rollout = write_rollout(&[
            r#"{"type":"session_meta","payload":{"id":"thread-exec-command"}}"#,
            r#"{"type":"event_msg","payload":{"type":"turn_started","turn_id":"turn-1"}}"#,
            r#"{"type":"event_msg","payload":{"type":"user_message","message":"inspect","images":[],"local_images":[],"text_elements":[]}}"#,
            r#"{"type":"response_item","payload":{"type":"function_call","name":"exec_command","call_id":"call-1","arguments":"{\"cmd\":\"bash -lc 'ls -la'\",\"workdir\":\"/home/yiyou/project\"}"}}"#,
            r#"{"type":"response_item","payload":{"type":"function_call_output","call_id":"call-1","output":"{\"output\":\"ok\",\"metadata\":{\"exit_code\":0}}"}}"#,
            r#"{"type":"event_msg","payload":{"type":"turn_complete"}}"#,
        ]);

        let parsed = parse_rollout_history(rollout.path()).expect("parsed history");
        assert_eq!(parsed.turns.len(), 1);
        let items = &parsed.turns[0].items;
        assert_eq!(items[1]["type"].as_str(), Some("commandExecution"));
        assert_eq!(items[1]["command"].as_str(), Some("bash -lc 'ls -la'"));
        assert_eq!(items[1]["output"].as_str(), Some("ok"));
        assert_eq!(items[1]["exitCode"].as_i64(), Some(0));
    }

    #[test]
    fn parser_marks_non_zero_exit_code_command_as_failed() {
        let rollout = write_rollout(&[
            r#"{"type":"session_meta","payload":{"id":"thread-exec-failed"}}"#,
            r#"{"type":"event_msg","payload":{"type":"turn_started","turn_id":"turn-1"}}"#,
            r#"{"type":"event_msg","payload":{"type":"user_message","message":"inspect","images":[],"local_images":[],"text_elements":[]}}"#,
            r#"{"type":"response_item","payload":{"type":"function_call","name":"exec_command","call_id":"call-1","arguments":"{\"cmd\":\"npm test\"}"}}"#,
            r#"{"type":"response_item","payload":{"type":"function_call_output","call_id":"call-1","output":"{\"output\":\"boom\",\"metadata\":{\"exit_code\":1}}"}}"#,
            r#"{"type":"event_msg","payload":{"type":"turn_complete"}}"#,
        ]);

        let parsed = parse_rollout_history(rollout.path()).expect("parsed history");
        let items = &parsed.turns[0].items;
        assert_eq!(items[1]["type"].as_str(), Some("commandExecution"));
        assert_eq!(items[1]["status"].as_str(), Some("failed"));
        assert_eq!(items[1]["exitCode"].as_i64(), Some(1));
    }
}
