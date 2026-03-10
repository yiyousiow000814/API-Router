use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
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
            "turn_complete" => self.handle_turn_complete(),
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
