use serde_json::Value;
use std::borrow::Cow;
use std::collections::HashMap;
use std::collections::HashSet;
use std::collections::VecDeque;
use std::hash::{Hash, Hasher};
use std::path::Path;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::OnceLock;
use std::time::{Duration, Instant, SystemTime};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::oneshot;
use tokio::sync::Mutex;

#[cfg(target_os = "windows")]
use crate::orchestrator::gateway::web_codex_home::{
    linux_path_to_unc, normalize_wsl_linux_path, parse_wsl_unc_to_linux_path, resolve_wsl_identity,
};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const NOTIFICATION_QUEUE_CAP: usize = 2048;
const DEBUG_EVENT_CAP: usize = 160;
const ROLLOUT_LIVE_SYNC_POLL_BYTES: u64 = 64 * 1024;
const ROLLOUT_LIVE_SYNC_MAX_TRACKED_FILES: usize = 64;
const ROLLOUT_LIVE_SYNC_MAX_FILE_AGE: Duration = Duration::from_secs(60 * 60 * 24 * 2);
const ROLLOUT_LIVE_SYNC_DEDUP_CAPACITY: usize = 8_192;
const ROLLOUT_LIVE_SYNC_DISCOVERY_INTERVAL: Duration = Duration::from_millis(1_500);
const ROLLOUT_LIVE_SYNC_POLL_INTERVAL: Duration = Duration::from_millis(250);

// Keyed by CODEX_HOME override ("" means inherit parent env / default process CODEX_HOME).
// Value is per-home server mutex so different homes can run concurrently without global lock blocking.
static APP_SERVERS: OnceLock<Mutex<HashMap<String, std::sync::Arc<Mutex<AppServer>>>>> =
    OnceLock::new();
static NOTIFICATION_STATE: OnceLock<Mutex<HashMap<String, NotificationState>>> = OnceLock::new();
static DEBUG_EVENTS: OnceLock<Mutex<VecDeque<Value>>> = OnceLock::new();
static ROLLOUT_LIVE_SYNC: OnceLock<Mutex<HashMap<String, RolloutLiveSyncState>>> = OnceLock::new();

#[cfg(test)]
static TEST_REQUEST_HANDLER: OnceLock<
    Mutex<
        Option<
            std::sync::Arc<
                dyn Fn(Option<&str>, &str, Value) -> Result<Value, String> + Send + Sync,
            >,
        >,
    >,
> = OnceLock::new();

#[cfg(test)]
static TEST_GLOBAL_LOCK: OnceLock<std::sync::Mutex<()>> = OnceLock::new();

#[cfg(test)]
pub(crate) fn lock_test_globals() -> std::sync::MutexGuard<'static, ()> {
    match TEST_GLOBAL_LOCK
        .get_or_init(|| std::sync::Mutex::new(()))
        .lock()
    {
        Ok(guard) => guard,
        Err(err) => err.into_inner(),
    }
}

#[cfg(test)]
pub async fn _set_test_request_handler(
    handler: Option<
        std::sync::Arc<dyn Fn(Option<&str>, &str, Value) -> Result<Value, String> + Send + Sync>,
    >,
) {
    let lock = TEST_REQUEST_HANDLER.get_or_init(|| Mutex::new(None));
    let mut guard = lock.lock().await;
    *guard = handler;
}

#[cfg(test)]
async fn maybe_handle_test_request(
    codex_home: Option<&str>,
    method: &str,
    params: &Value,
) -> Option<Result<Value, String>> {
    let lock = TEST_REQUEST_HANDLER.get_or_init(|| Mutex::new(None));
    let guard = lock.lock().await;
    let Some(handler) = guard.as_ref() else {
        return None;
    };
    Some(handler(codex_home, method, params.clone()))
}

struct NotificationState {
    next_event_id: u64,
    items: VecDeque<(u64, Value)>,
}

impl Default for NotificationState {
    fn default() -> Self {
        Self {
            next_event_id: 1,
            items: VecDeque::new(),
        }
    }
}

fn push_notification_into_state(
    st: &mut NotificationState,
    value: Value,
) -> (u64, usize, Option<(u64, Value)>) {
    let event_id = st.next_event_id;
    st.next_event_id = st.next_event_id.saturating_add(1);
    st.items.push_back((event_id, value));
    let mut dropped = None;
    while st.items.len() > NOTIFICATION_QUEUE_CAP {
        dropped = st.items.pop_front();
    }
    (event_id, st.items.len(), dropped)
}

fn replay_notification_state(
    st: &NotificationState,
    since_event_id: u64,
    max: usize,
) -> (Vec<Value>, Option<u64>, Option<u64>, bool) {
    let cap = max.clamp(1, NOTIFICATION_QUEUE_CAP);
    let first = st.items.front().map(|(id, _)| *id);
    let last = st.items.back().map(|(id, _)| *id);
    let gap = first
        .map(|first_id| since_event_id + 1 < first_id)
        .unwrap_or(false);
    let mut out = Vec::new();
    for (event_id, value) in st.items.iter() {
        if *event_id <= since_event_id {
            continue;
        }
        out.push(with_event_id(value.clone(), *event_id));
        if out.len() >= cap {
            break;
        }
    }
    (out, first, last, gap)
}

#[derive(Default)]
struct RolloutLiveSyncState {
    files: HashMap<PathBuf, RolloutTrackedFile>,
    last_discovery_at: Option<Instant>,
    last_poll_at: Option<Instant>,
}

struct RolloutTrackedFile {
    path: PathBuf,
    offset: u64,
    partial_line: String,
    drop_first_partial_line: bool,
    source_timestamp: Option<Value>,
    thread_id: Option<String>,
    cwd: Option<String>,
    pending_calls: HashMap<String, RolloutPendingCall>,
    last_seen: Instant,
    recent_line_hashes: VecDeque<u64>,
    recent_line_hash_set: HashSet<u64>,
}

#[derive(Clone)]
struct RolloutPendingCall {
    item: Value,
    kind: RolloutPendingCallKind,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum RolloutPendingCallKind {
    CommandExecution,
    ToolCall,
}

fn normalize_home_key(codex_home: Option<&str>) -> Cow<'static, str> {
    let Some(home) = codex_home else {
        return Cow::Borrowed("");
    };
    let trimmed = home.trim();
    if trimmed.is_empty() {
        Cow::Borrowed("")
    } else {
        Cow::Owned(trimmed.to_string())
    }
}

fn notification_state_map() -> &'static Mutex<HashMap<String, NotificationState>> {
    NOTIFICATION_STATE.get_or_init(|| Mutex::new(HashMap::new()))
}

async fn ensure_notification_home_state(codex_home: Option<&str>) {
    let key = normalize_home_key(codex_home).to_string();
    let map = notification_state_map();
    let mut guard = map.lock().await;
    guard.entry(key).or_insert_with(NotificationState::default);
}

fn debug_event_queue() -> &'static Mutex<VecDeque<Value>> {
    DEBUG_EVENTS.get_or_init(|| Mutex::new(VecDeque::new()))
}

fn deep_find_thread_id(value: &Value, depth: usize) -> Option<String> {
    if depth > 6 {
        return None;
    }
    match value {
        Value::Object(map) => {
            for key in [
                "threadId",
                "thread_id",
                "conversationId",
                "conversation_id",
                "sessionId",
                "session_id",
                "parentThreadId",
                "parent_thread_id",
            ] {
                if let Some(found) = map
                    .get(key)
                    .and_then(Value::as_str)
                    .filter(|text| !text.is_empty())
                {
                    return Some(found.to_string());
                }
            }
            for child in map.values() {
                if let Some(found) = deep_find_thread_id(child, depth + 1) {
                    return Some(found);
                }
            }
            None
        }
        Value::Array(items) => items
            .iter()
            .take(40)
            .find_map(|child| deep_find_thread_id(child, depth + 1)),
        _ => None,
    }
}

async fn push_debug_event(kind: &str, payload: Value) {
    let mut guard = debug_event_queue().lock().await;
    let obj = payload.as_object().cloned().unwrap_or_default();
    let mut map = serde_json::Map::with_capacity(obj.len() + 2);
    map.insert(
        "at".to_string(),
        serde_json::json!(crate::orchestrator::store::unix_ms()),
    );
    map.insert("kind".to_string(), Value::from(kind));
    for (key, value) in obj {
        map.insert(key, value);
    }
    let entry = Value::Object(map);
    guard.push_back(entry.clone());
    while guard.len() > DEBUG_EVENT_CAP {
        guard.pop_front();
    }
    drop(guard);
    let _ = crate::orchestrator::gateway::web_codex_storage::append_codex_live_trace_entry(
        &serde_json::json!({
            "source": "backend.app",
            "entry": entry,
        }),
    );
}

pub async fn debug_snapshot() -> Value {
    let homes = {
        let guard = notification_state_map().lock().await;
        let mut homes = Vec::with_capacity(guard.len());
        for (home, state) in guard.iter() {
            let first_event_id = state.items.front().map(|(id, _)| *id);
            let last = state.items.back();
            let last_event_id = last.map(|(id, _)| *id);
            let last_method = last
                .and_then(|(_, value)| value.get("method"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let last_thread_id = last
                .and_then(|(_, value)| extract_thread_id_for_debug(value))
                .unwrap_or_default();
            homes.push(serde_json::json!({
                "home": home,
                "queueLen": state.items.len(),
                "nextEventId": state.next_event_id,
                "firstEventId": first_event_id,
                "lastEventId": last_event_id,
                "lastMethod": last_method,
                "lastThreadId": last_thread_id,
            }));
        }
        homes
    };
    let recent = {
        let guard = debug_event_queue().lock().await;
        guard.iter().cloned().collect::<Vec<_>>()
    };
    serde_json::json!({
        "homes": homes,
        "recent": recent,
    })
}

impl RolloutTrackedFile {
    fn new(path: PathBuf) -> Result<Self, String> {
        let metadata = std::fs::metadata(&path).map_err(|error| error.to_string())?;
        let offset = metadata.len().saturating_sub(ROLLOUT_LIVE_SYNC_POLL_BYTES);
        Ok(Self {
            path,
            offset,
            partial_line: String::new(),
            drop_first_partial_line: offset > 0,
            source_timestamp: None,
            thread_id: None,
            cwd: None,
            pending_calls: HashMap::new(),
            last_seen: Instant::now(),
            recent_line_hashes: VecDeque::new(),
            recent_line_hash_set: HashSet::new(),
        })
    }

    fn remember_line_hash(&mut self, line_hash: u64) -> bool {
        if self.recent_line_hash_set.contains(&line_hash) {
            return false;
        }
        self.recent_line_hash_set.insert(line_hash);
        self.recent_line_hashes.push_back(line_hash);
        while self.recent_line_hashes.len() > ROLLOUT_LIVE_SYNC_DEDUP_CAPACITY {
            if let Some(oldest) = self.recent_line_hashes.pop_front() {
                self.recent_line_hash_set.remove(&oldest);
            }
        }
        true
    }

    fn poll_notifications(&mut self) -> Result<Vec<Value>, String> {
        let mut file = std::fs::File::open(&self.path).map_err(|error| error.to_string())?;
        let metadata = file.metadata().map_err(|error| error.to_string())?;
        let len = metadata.len();
        if len < self.offset {
            self.offset = 0;
            self.partial_line.clear();
            self.drop_first_partial_line = false;
            self.source_timestamp = None;
            self.cwd = None;
            self.pending_calls.clear();
            self.recent_line_hashes.clear();
            self.recent_line_hash_set.clear();
        }
        if len == self.offset {
            return Ok(Vec::new());
        }
        use std::io::{Read, Seek, SeekFrom};
        file.seek(SeekFrom::Start(self.offset))
            .map_err(|error| error.to_string())?;
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)
            .map_err(|error| error.to_string())?;
        self.offset = len;
        self.last_seen = Instant::now();
        if bytes.is_empty() {
            return Ok(Vec::new());
        }
        let chunk = String::from_utf8_lossy(&bytes);
        let mut combined = String::with_capacity(self.partial_line.len() + chunk.len());
        combined.push_str(&self.partial_line);
        combined.push_str(&chunk);
        self.partial_line.clear();

        if self.drop_first_partial_line {
            if let Some(index) = combined.find('\n') {
                combined = combined[(index + 1)..].to_string();
                self.drop_first_partial_line = false;
            } else {
                self.partial_line = combined;
                return Ok(Vec::new());
            }
        }

        let has_trailing_newline = combined.ends_with('\n');
        let mut lines = combined.split('\n').map(str::to_string).collect::<Vec<_>>();
        if !has_trailing_newline {
            self.partial_line = lines.pop().unwrap_or_default();
        }

        let mut notifications = Vec::new();
        for line in lines {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let line_hash = hash_rollout_line(trimmed);
            if !self.remember_line_hash(line_hash) {
                continue;
            }
            notifications.extend(self.line_to_notifications(trimmed));
        }
        Ok(notifications)
    }

    fn line_to_notifications(&mut self, line: &str) -> Vec<Value> {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            return Vec::new();
        };
        let Some(object) = value.as_object() else {
            return Vec::new();
        };
        let record_type = object
            .get("type")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default();
        let Some(payload) = object.get("payload").and_then(Value::as_object) else {
            return Vec::new();
        };
        self.source_timestamp = object
            .get("timestamp")
            .cloned()
            .or_else(|| payload.get("timestamp").cloned());
        match record_type {
            "session_meta" => {
                self.thread_id = payload
                    .get("id")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string);
                self.cwd = payload
                    .get("cwd")
                    .and_then(Value::as_str)
                    .or_else(|| payload.get("working_directory").and_then(Value::as_str))
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string);
                Vec::new()
            }
            "event_msg" => self.map_event_msg(payload),
            "response_item" => self.map_response_item(payload),
            _ => Vec::new(),
        }
    }

    fn enrich_rollout_notification(&self, notification: &mut Value) {
        let Some(root) = notification.as_object_mut() else {
            return;
        };
        if let Some(timestamp) = self.source_timestamp.as_ref() {
            root.entry("timestamp".to_string())
                .or_insert_with(|| timestamp.clone());
        }
        let params = if let Some(params) = root.get_mut("params").and_then(Value::as_object_mut) {
            Some(params)
        } else {
            root.get_mut("payload").and_then(Value::as_object_mut)
        };
        let Some(params) = params else {
            return;
        };
        let rollout_path = self.path.to_string_lossy().to_string();
        params
            .entry("rolloutPath".to_string())
            .or_insert_with(|| Value::String(rollout_path.clone()));
        params
            .entry("rollout_path".to_string())
            .or_insert_with(|| Value::String(rollout_path.clone()));
        params
            .entry("path".to_string())
            .or_insert_with(|| Value::String(rollout_path));
        if let Some(timestamp) = self.source_timestamp.as_ref() {
            params
                .entry("timestamp".to_string())
                .or_insert_with(|| timestamp.clone());
        }
        if let Some(cwd) = self.cwd.as_deref() {
            params
                .entry("cwd".to_string())
                .or_insert_with(|| Value::String(cwd.to_string()));
        }
    }

    fn map_event_msg(&mut self, payload: &serde_json::Map<String, Value>) -> Vec<Value> {
        let event_type = payload
            .get("type")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default();
        let thread_id = payload
            .get("thread_id")
            .and_then(Value::as_str)
            .or(self.thread_id.as_deref())
            .unwrap_or_default()
            .trim()
            .to_string();
        if thread_id.is_empty() {
            return Vec::new();
        }
        self.thread_id = Some(thread_id.clone());
        let mut out = Vec::new();
        match event_type.to_ascii_lowercase().as_str() {
            "turn_started" | "task_started" | "taskstarted" => {
                out.push(rollout_turn_notification(
                    "turn/started",
                    &thread_id,
                    payload,
                ));
                out.push(rollout_status_notification(&thread_id, "running"));
            }
            "turn_complete" | "task_complete" | "taskcomplete" => {
                out.push(rollout_turn_notification(
                    "turn/completed",
                    &thread_id,
                    payload,
                ));
                out.push(rollout_status_notification(&thread_id, "completed"));
            }
            "turn_failed" | "task_failed" | "taskfailed" => {
                out.push(rollout_turn_notification(
                    "turn/failed",
                    &thread_id,
                    payload,
                ));
                out.push(rollout_status_notification(&thread_id, "failed"));
            }
            "turn_aborted" | "task_interrupted" | "taskinterrupted" => {
                out.push(rollout_turn_notification(
                    "turn/cancelled",
                    &thread_id,
                    payload,
                ));
                out.push(rollout_status_notification(&thread_id, "interrupted"));
            }
            _ => {
                let mut normalized_payload = payload.clone();
                normalize_rollout_item_thread(&mut normalized_payload, &thread_id);
                if let Some(notification) = normalize_stdout_notification(&serde_json::json!({
                    "type": "event_msg",
                    "payload": Value::Object(normalized_payload),
                })) {
                    out.push(notification);
                }
            }
        }
        for notification in &mut out {
            self.enrich_rollout_notification(notification);
        }
        out
    }

    fn map_response_item(&mut self, payload: &serde_json::Map<String, Value>) -> Vec<Value> {
        let item_type = payload
            .get("type")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default();
        let thread_id = payload
            .get("thread_id")
            .and_then(Value::as_str)
            .or(self.thread_id.as_deref())
            .unwrap_or_default()
            .trim()
            .to_string();
        if thread_id.is_empty() {
            return Vec::new();
        }
        self.thread_id = Some(thread_id.clone());
        let mut out = match item_type {
            "function_call" => self.map_function_call(payload, &thread_id),
            "function_call_output" => self.map_function_call_output(payload, &thread_id),
            "custom_tool_call" => self.map_custom_tool_call(payload, &thread_id),
            "custom_tool_call_output" => self.map_function_call_output(payload, &thread_id),
            "web_search_call" => self.map_web_search_call(payload, &thread_id),
            "message" => {
                let mut normalized_payload = payload.clone();
                normalize_rollout_item_thread(&mut normalized_payload, &thread_id);
                normalize_stdout_notification(&serde_json::json!({
                    "type": "response_item",
                    "payload": Value::Object(normalized_payload),
                }))
                .into_iter()
                .collect()
            }
            _ => Vec::new(),
        };
        for notification in &mut out {
            self.enrich_rollout_notification(notification);
        }
        out
    }

    fn map_function_call(
        &mut self,
        payload: &serde_json::Map<String, Value>,
        thread_id: &str,
    ) -> Vec<Value> {
        let name = payload
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let call_id = payload
            .get("call_id")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default()
            .to_string();
        let item = if is_shell_like_tool_name(name) {
            serde_json::json!({
                "type": "commandExecution",
                "id": empty_to_none(&call_id),
                "callId": empty_to_none(&call_id),
                "threadId": thread_id,
                "thread_id": thread_id,
                "command": read_command_from_tool_arguments(payload.get("arguments")),
                "status": "running",
            })
        } else {
            serde_json::json!({
                "type": "toolCall",
                "id": empty_to_none(&call_id),
                "callId": empty_to_none(&call_id),
                "threadId": thread_id,
                "thread_id": thread_id,
                "tool": empty_to_none(name),
                "arguments": payload.get("arguments").cloned().unwrap_or(Value::Null),
                "status": "running",
            })
        };
        if !call_id.is_empty() {
            self.pending_calls.insert(
                call_id.clone(),
                RolloutPendingCall {
                    item: item.clone(),
                    kind: if is_shell_like_tool_name(name) {
                        RolloutPendingCallKind::CommandExecution
                    } else {
                        RolloutPendingCallKind::ToolCall
                    },
                },
            );
        }
        vec![serde_json::json!({
            "method": "item/started",
            "params": {
                "threadId": thread_id,
                "thread_id": thread_id,
                "item": item,
            }
        })]
    }

    fn map_custom_tool_call(
        &mut self,
        payload: &serde_json::Map<String, Value>,
        thread_id: &str,
    ) -> Vec<Value> {
        let call_id = payload
            .get("call_id")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default()
            .to_string();
        let item = serde_json::json!({
            "type": "toolCall",
            "id": empty_to_none(&call_id),
            "callId": empty_to_none(&call_id),
            "threadId": thread_id,
            "thread_id": thread_id,
            "tool": payload.get("name").and_then(Value::as_str),
            "input": payload.get("input").cloned().unwrap_or(Value::Null),
            "status": "running",
        });
        if !call_id.is_empty() {
            self.pending_calls.insert(
                call_id.clone(),
                RolloutPendingCall {
                    item: item.clone(),
                    kind: RolloutPendingCallKind::ToolCall,
                },
            );
        }
        vec![serde_json::json!({
            "method": "item/started",
            "params": {
                "threadId": thread_id,
                "thread_id": thread_id,
                "item": item,
            }
        })]
    }

    fn map_function_call_output(
        &mut self,
        payload: &serde_json::Map<String, Value>,
        thread_id: &str,
    ) -> Vec<Value> {
        let call_id = payload
            .get("call_id")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default();
        let Some(mut pending) = self.pending_calls.remove(call_id) else {
            return Vec::new();
        };
        let parsed = parse_embedded_json_value(payload.get("output")).unwrap_or(Value::Null);
        let Some(item) = pending.item.as_object_mut() else {
            return Vec::new();
        };
        match pending.kind {
            RolloutPendingCallKind::CommandExecution => {
                let output = extract_tool_text(&parsed);
                let exit_code = parsed
                    .get("metadata")
                    .and_then(Value::as_object)
                    .and_then(|value| value.get("exit_code"))
                    .and_then(Value::as_i64);
                item.insert(
                    "status".to_string(),
                    Value::String(command_completion_status(exit_code, &parsed).to_string()),
                );
                if let Some(value) = output {
                    item.insert("output".to_string(), Value::String(value));
                }
                if let Some(value) = exit_code {
                    item.insert("exitCode".to_string(), Value::from(value));
                }
            }
            RolloutPendingCallKind::ToolCall => {
                item.insert(
                    "status".to_string(),
                    Value::String(tool_completion_status(&parsed).to_string()),
                );
                if let Some(result) = extract_tool_text_value(&parsed) {
                    item.insert("result".to_string(), result);
                }
            }
        }
        vec![serde_json::json!({
            "method": "item/completed",
            "params": {
                "threadId": thread_id,
                "thread_id": thread_id,
                "item": Value::Object(item.clone()),
            }
        })]
    }

    fn map_web_search_call(
        &mut self,
        payload: &serde_json::Map<String, Value>,
        thread_id: &str,
    ) -> Vec<Value> {
        let action = payload.get("action").cloned().unwrap_or(Value::Null);
        let query = action
            .get("query")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        let item = serde_json::json!({
            "type": "webSearch",
            "threadId": thread_id,
            "thread_id": thread_id,
            "status": payload.get("status").and_then(Value::as_str).unwrap_or("completed"),
            "query": query,
            "action": action,
        });
        vec![serde_json::json!({
            "method": "item/completed",
            "params": {
                "threadId": thread_id,
                "thread_id": thread_id,
                "item": item,
            }
        })]
    }
}

fn extract_thread_id_for_debug(value: &Value) -> Option<String> {
    let params = value
        .get("params")
        .and_then(Value::as_object)
        .or_else(|| value.get("payload").and_then(Value::as_object));
    let direct = params
        .and_then(|map| map.get("threadId").and_then(Value::as_str))
        .or_else(|| params.and_then(|map| map.get("thread_id").and_then(Value::as_str)));
    if let Some(thread_id) = direct {
        return Some(thread_id.to_string());
    }
    let item = params
        .and_then(|map| map.get("item").and_then(Value::as_object))
        .or_else(|| params.and_then(|map| map.get("msg").and_then(Value::as_object)));
    item.and_then(|map| {
        map.get("threadId")
            .and_then(Value::as_str)
            .or_else(|| map.get("thread_id").and_then(Value::as_str))
            .map(str::to_string)
    })
    .or_else(|| deep_find_thread_id(value, 0))
}

fn normalize_stdout_notification(value: &Value) -> Option<Value> {
    if value.get("method").and_then(Value::as_str).is_some() {
        return Some(value.clone());
    }
    let record_type = value.get("type").and_then(Value::as_str)?;
    let payload = value.get("payload")?.clone();
    match record_type {
        "event_msg" => {
            let event_type = payload
                .get("type")
                .and_then(Value::as_str)
                .filter(|text| !text.trim().is_empty())
                .unwrap_or("event_msg");
            Some(serde_json::json!({
                "method": format!("codex/event/{event_type}"),
                "params": {
                    "payload": payload,
                },
            }))
        }
        "response_item" => Some(serde_json::json!({
            "method": "codex/event/response_item",
            "params": {
                "payload": payload,
            },
        })),
        _ => None,
    }
}

fn rollout_live_sync_map() -> &'static Mutex<HashMap<String, RolloutLiveSyncState>> {
    ROLLOUT_LIVE_SYNC.get_or_init(|| Mutex::new(HashMap::new()))
}

fn value_has_failure_marker(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => !*flag,
        Value::String(_) => false,
        Value::Array(items) => items.iter().any(value_has_failure_marker),
        Value::Object(map) => {
            map.get("success").and_then(Value::as_bool) == Some(false)
                || map.get("ok").and_then(Value::as_bool) == Some(false)
                || map.get("error").is_some_and(|error| {
                    if matches!(error, Value::Null) {
                        return false;
                    }
                    if let Some(text) = error.as_str() {
                        return !text.trim().is_empty();
                    }
                    error_object_has_failure_marker(error)
                })
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

fn error_object_has_failure_marker(value: &Value) -> bool {
    match value {
        Value::Object(map) => {
            map.get("message")
                .and_then(Value::as_str)
                .is_some_and(|message| !message.trim().is_empty())
                || value_has_failure_marker(value)
        }
        _ => value_has_failure_marker(value),
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

fn parse_embedded_json_value(value: Option<&Value>) -> Option<Value> {
    let raw = value?;
    match raw {
        Value::String(text) => serde_json::from_str::<Value>(text).ok(),
        Value::Object(_) | Value::Array(_) => Some(raw.clone()),
        _ => None,
    }
}

fn extract_tool_text(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(text.clone()),
        Value::Object(map) => map
            .get("output")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| map.get("text").and_then(Value::as_str).map(str::to_string))
            .or_else(|| {
                map.get("message")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .or_else(|| {
                map.get("result")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            }),
        _ => None,
    }
}

fn extract_tool_text_value(value: &Value) -> Option<Value> {
    extract_tool_text(value).map(Value::String).or_else(|| {
        if value.is_null() {
            None
        } else {
            Some(value.clone())
        }
    })
}

fn empty_to_none(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn normalize_tool_name(value: &str) -> String {
    value.trim().to_ascii_lowercase().replace(['-', '_'], "")
}

fn is_shell_like_tool_name(value: &str) -> bool {
    matches!(
        normalize_tool_name(value).as_str(),
        "execcommand" | "shell" | "shellcommand" | "commandexecution"
    )
}

fn read_command_from_tool_arguments(arguments: Option<&Value>) -> Option<String> {
    let parsed = parse_embedded_json_value(arguments)?;
    let object = parsed.as_object()?;
    let command = [
        "cmd",
        "command",
        "shell_command",
        "shellCommand",
        "raw_command",
    ]
    .iter()
    .find_map(|key| object.get(*key))?;
    let raw = match command {
        Value::String(text) => Some(text.trim().to_string()),
        Value::Array(parts) => {
            let values = parts
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
                .collect::<Vec<_>>();
            if values.is_empty() {
                None
            } else if let Some(unwrapped) = unwrap_shell_wrapper_parts(&values) {
                Some(unwrapped)
            } else {
                Some(values.join(" "))
            }
        }
        other => serde_json::to_string(other).ok(),
    }?;
    normalize_wrapped_command_string(&raw).or_else(|| {
        let trimmed = raw.trim();
        (!trimmed.is_empty()).then(|| trimmed.to_string())
    })
}

fn normalize_wrapped_command_string(raw: &str) -> Option<String> {
    let mut text = raw.trim();
    if text.is_empty() {
        return None;
    }
    if (text.starts_with('"') && text.ends_with('"'))
        || (text.starts_with('\'') && text.ends_with('\''))
    {
        text = text[1..text.len() - 1].trim();
    }
    extract_wrapped_command_body(text).or_else(|| Some(text.to_string()))
}

fn unwrap_shell_wrapper_parts(parts: &[String]) -> Option<String> {
    let first = parts.first()?;
    let exe = command_basename(first);
    let flags = if matches!(
        exe.as_str(),
        "powershell.exe" | "powershell" | "pwsh.exe" | "pwsh"
    ) {
        &["-command", "-c"][..]
    } else if matches!(exe.as_str(), "cmd.exe" | "cmd") {
        &["/c"][..]
    } else {
        return None;
    };
    for index in 1..parts.len().saturating_sub(1) {
        let lower = parts[index].trim().to_ascii_lowercase();
        if flags.iter().any(|flag| lower == *flag) {
            let candidate = parts[index + 1].trim();
            if candidate.is_empty() {
                continue;
            }
            return normalize_wrapped_command_string(candidate)
                .or_else(|| Some(candidate.to_string()));
        }
    }
    None
}

fn command_basename(value: &str) -> String {
    value
        .trim()
        .trim_matches(|ch| ch == '"' || ch == '\'')
        .rsplit(['\\', '/'])
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase()
}

fn extract_wrapped_command_body(text: &str) -> Option<String> {
    let trimmed = text.trim();
    let lowered = trimmed.to_ascii_lowercase();
    if !(lowered.contains("powershell")
        || lowered.contains("pwsh")
        || lowered.contains("cmd.exe")
        || lowered.contains("cmd "))
    {
        return None;
    }
    extract_flag_argument(trimmed, &["-command", "-c"])
        .or_else(|| extract_flag_argument(trimmed, &["/c"]))
}

fn extract_flag_argument(text: &str, flags: &[&str]) -> Option<String> {
    let lowered = text.to_ascii_lowercase();
    for flag in flags {
        let marker = format!(" {flag} ");
        let start = if let Some(index) = lowered.find(&marker) {
            index + marker.len()
        } else if lowered.starts_with(&format!("{flag} ")) {
            flag.len() + 1
        } else {
            continue;
        };
        let candidate = text[start..].trim();
        if candidate.is_empty() {
            continue;
        }
        let normalized = candidate
            .strip_prefix('"')
            .and_then(|value| value.strip_suffix('"'))
            .or_else(|| {
                candidate
                    .strip_prefix('\'')
                    .and_then(|value| value.strip_suffix('\''))
            })
            .unwrap_or(candidate)
            .trim();
        if !normalized.is_empty() {
            return Some(normalized.to_string());
        }
    }
    None
}

fn normalize_rollout_item_thread(item: &mut serde_json::Map<String, Value>, thread_id: &str) {
    item.entry("threadId".to_string())
        .or_insert_with(|| Value::String(thread_id.to_string()));
    item.entry("thread_id".to_string())
        .or_insert_with(|| Value::String(thread_id.to_string()));
}

fn rollout_status_notification(thread_id: &str, status: &str) -> Value {
    serde_json::json!({
        "method": "thread/status/changed",
        "params": {
            "threadId": thread_id,
            "thread_id": thread_id,
            "status": status,
            "source": "rollout_live_sync",
        }
    })
}

fn rollout_turn_notification(
    method: &str,
    thread_id: &str,
    payload: &serde_json::Map<String, Value>,
) -> Value {
    let mut params = payload.clone();
    normalize_rollout_item_thread(&mut params, thread_id);
    serde_json::json!({
        "method": method,
        "params": Value::Object(params),
    })
}

pub async fn push_terminal_interrupt_notifications(codex_home: Option<&str>, thread_id: &str) {
    let normalized_thread_id = thread_id.trim();
    if normalized_thread_id.is_empty() {
        return;
    }
    let payload = serde_json::Map::from_iter([
        (
            "threadId".to_string(),
            Value::String(normalized_thread_id.to_string()),
        ),
        (
            "thread_id".to_string(),
            Value::String(normalized_thread_id.to_string()),
        ),
        (
            "status".to_string(),
            Value::String("interrupted".to_string()),
        ),
        (
            "source".to_string(),
            Value::String("terminal_session_interrupt".to_string()),
        ),
    ]);
    push_notification(
        codex_home,
        rollout_turn_notification("turn/cancelled", normalized_thread_id, &payload),
    )
    .await;
    push_notification(
        codex_home,
        rollout_status_notification(normalized_thread_id, "interrupted"),
    )
    .await;
}

fn resolve_default_codex_home() -> Option<PathBuf> {
    std::env::var("CODEX_HOME")
        .ok()
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
        .or_else(|| {
            std::env::var("USERPROFILE")
                .ok()
                .map(|value| PathBuf::from(value).join(".codex"))
        })
        .or_else(|| {
            std::env::var("HOME")
                .ok()
                .map(|value| PathBuf::from(value).join(".codex"))
        })
}

#[cfg(target_os = "windows")]
fn resolve_windows_accessible_codex_home(codex_home: Option<&str>) -> Option<PathBuf> {
    let raw = codex_home?.trim();
    if raw.is_empty() {
        return None;
    }
    if parse_wsl_unc_codex_home(raw).is_some() {
        return Some(PathBuf::from(raw));
    }
    let linux_home = normalize_wsl_linux_path(raw)
        .or_else(|| parse_wsl_unc_to_linux_path(raw))
        .filter(|value| value != "/")?;
    let (distro, _) = resolve_wsl_identity().ok()?;
    Some(linux_path_to_unc(&linux_home, &distro))
}

fn resolve_rollout_sessions_root(codex_home: Option<&str>) -> Option<PathBuf> {
    let root = {
        #[cfg(target_os = "windows")]
        {
            resolve_windows_accessible_codex_home(codex_home)
                .or_else(|| {
                    codex_home
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .map(PathBuf::from)
                })
                .or_else(resolve_default_codex_home)
        }
        #[cfg(not(target_os = "windows"))]
        {
            codex_home
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
                .or_else(resolve_default_codex_home)
        }
    }?;
    let sessions = root.join("sessions");
    if sessions.is_dir() {
        Some(sessions)
    } else {
        None
    }
}

fn is_rollout_file_path(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.starts_with("rollout-") && name.ends_with(".jsonl"))
}

fn file_modified_at(metadata: &std::fs::Metadata) -> Option<SystemTime> {
    metadata.modified().ok()
}

fn discover_recent_rollout_files(root: &Path) -> Vec<PathBuf> {
    let mut found = Vec::new();
    let mut dirs = vec![root.to_path_buf()];
    let now = SystemTime::now();
    while let Some(dir) = dirs.pop() {
        let Ok(read_dir) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in read_dir.flatten() {
            let path = entry.path();
            let Ok(metadata) = entry.metadata() else {
                continue;
            };
            if metadata.is_dir() {
                dirs.push(path);
                continue;
            }
            if !metadata.is_file() || !is_rollout_file_path(&path) {
                continue;
            }
            let recent_enough = file_modified_at(&metadata)
                .and_then(|modified| now.duration_since(modified).ok())
                .map(|age| age <= ROLLOUT_LIVE_SYNC_MAX_FILE_AGE)
                .unwrap_or(true);
            if recent_enough {
                found.push(path);
            }
        }
    }
    found.sort_by(|a, b| b.cmp(a));
    if found.len() > ROLLOUT_LIVE_SYNC_MAX_TRACKED_FILES {
        found.truncate(ROLLOUT_LIVE_SYNC_MAX_TRACKED_FILES);
    }
    found
}

fn hash_rollout_line(line: &str) -> u64 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    line.hash(&mut hasher);
    hasher.finish()
}

fn should_run_live_sync_pass(
    last_run_at: Option<Instant>,
    now: Instant,
    min_interval: Duration,
) -> bool {
    match last_run_at {
        None => true,
        Some(previous) => now.duration_since(previous) >= min_interval,
    }
}

async fn push_notification(codex_home: Option<&str>, value: Value) {
    let key = normalize_home_key(codex_home);
    let map = notification_state_map();
    let mut guard = map.lock().await;
    let st = guard
        .entry(key.to_string())
        .or_insert_with(|| NotificationState {
            next_event_id: 1,
            items: VecDeque::new(),
        });
    let method = value
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let thread_id = extract_thread_id_for_debug(&value).unwrap_or_default();
    let (event_id, queue_len, dropped) = push_notification_into_state(st, value);
    drop(guard);
    if let Some((dropped_event_id, dropped_value)) = dropped {
        push_debug_event(
            "app.notification.drop.overflow",
            serde_json::json!({
                "home": key.as_ref(),
                "droppedEventId": dropped_event_id,
                "droppedMethod": dropped_value.get("method").and_then(Value::as_str).unwrap_or_default(),
                "droppedThreadId": extract_thread_id_for_debug(&dropped_value).unwrap_or_default(),
                "queueLen": queue_len,
            }),
        )
        .await;
    }
    push_debug_event(
        "app.notification.push",
        serde_json::json!({
            "home": key.as_ref(),
            "eventId": event_id,
            "method": method,
            "threadId": thread_id,
            "queueLen": queue_len,
        }),
    )
    .await;
}

async fn poll_rollout_live_sync_in_home(
    codex_home: Option<&str>,
    force_discovery: bool,
    force_poll_tracked: bool,
) {
    let Some(sessions_root) = resolve_rollout_sessions_root(codex_home) else {
        return;
    };
    let key = normalize_home_key(codex_home).to_string();
    let now = Instant::now();
    let (run_discovery, run_poll) = {
        let mut guard = rollout_live_sync_map().lock().await;
        let state = guard.entry(key.clone()).or_default();
        let run_discovery = force_discovery
            || should_run_live_sync_pass(
                state.last_discovery_at,
                now,
                ROLLOUT_LIVE_SYNC_DISCOVERY_INTERVAL,
            );
        if run_discovery {
            state.last_discovery_at = Some(now);
        }
        let run_poll = force_poll_tracked
            || run_discovery
            || should_run_live_sync_pass(state.last_poll_at, now, ROLLOUT_LIVE_SYNC_POLL_INTERVAL);
        if run_poll {
            state.last_poll_at = Some(now);
        }
        (run_discovery, run_poll)
    };
    if !run_poll {
        return;
    }

    let discovered = if run_discovery {
        discover_recent_rollout_files(&sessions_root)
    } else {
        Vec::new()
    };
    let mut drained = Vec::new();
    let mut debug_errors = Vec::new();
    {
        let mut guard = rollout_live_sync_map().lock().await;
        let state = guard.entry(key.clone()).or_default();
        if run_discovery {
            let discovered_set = discovered.iter().cloned().collect::<HashSet<_>>();
            for path in discovered {
                if !state.files.contains_key(&path) {
                    match RolloutTrackedFile::new(path.clone()) {
                        Ok(tracked) => {
                            state.files.insert(path.clone(), tracked);
                        }
                        Err(error) => {
                            debug_errors.push(("rollout.live_sync.track_error", path, error));
                        }
                    }
                }
            }
            state.files.retain(|path, tracked| {
                discovered_set.contains(path)
                    || tracked.last_seen.elapsed() < ROLLOUT_LIVE_SYNC_MAX_FILE_AGE
            });
        }
        let tracked_paths = state.files.keys().cloned().collect::<Vec<_>>();
        for path in tracked_paths {
            let Some(tracked) = state.files.get_mut(&path) else {
                continue;
            };
            match tracked.poll_notifications() {
                Ok(notifications) => drained.extend(notifications),
                Err(error) => debug_errors.push(("rollout.live_sync.poll_error", path, error)),
            }
        }
    }
    for (kind, path, error) in debug_errors {
        push_debug_event(
            kind,
            serde_json::json!({
                "home": key,
                "path": path,
                "message": error,
            }),
        )
        .await;
    }
    for notification in drained {
        push_notification(codex_home, notification).await;
    }
}

fn with_event_id(mut value: Value, event_id: u64) -> Value {
    // Prefer preserving the original notification shape (method/params/etc) and attach eventId.
    if let Value::Object(map) = &mut value {
        map.insert("eventId".to_string(), Value::from(event_id));
        return value;
    }
    serde_json::json!({ "eventId": event_id, "payload": value })
}

/// Replay notifications newer than `since_event_id` (exclusive).
///
/// This does NOT drain the global queue so multiple clients can replay independently.
/// Returns: (items, first_event_id_in_buffer, last_event_id_in_buffer, gap)
/// - `gap=true` means some events older than requested have been dropped due to buffer cap.
pub async fn replay_notifications_since_in_home(
    codex_home: Option<&str>,
    since_event_id: u64,
    max: usize,
) -> (Vec<Value>, Option<u64>, Option<u64>, bool) {
    let has_local_rollout_root = resolve_rollout_sessions_root(codex_home).is_some();
    // Replay is a hot path for websocket subscriptions. Keep live sync opportunistic
    // and let the poll interval decide when rollout files need to be touched instead
    // of forcing a filesystem scan on every replay request.
    // Replay should immediately drain already-tracked rollout files so freshly appended
    // terminal events stay visible, but directory discovery can remain throttled.
    poll_rollout_live_sync_in_home(codex_home, false, true).await;
    if !has_local_rollout_root {
        if let Some(result) = crate::codex_wsl_bridge::try_replay_notifications_since_in_home(
            codex_home,
            since_event_id,
            max,
        )
        .await
        {
            push_debug_event(
                "app.notification.replay.bridge",
                serde_json::json!({
                    "home": normalize_home_key(codex_home).as_ref(),
                    "sinceEventId": since_event_id,
                    "max": max,
                    "count": result.0.len(),
                    "firstEventId": result.1,
                    "lastEventId": result.2,
                    "gap": result.3,
                }),
            )
            .await;
            return result;
        }
    }
    let cap = max.clamp(1, NOTIFICATION_QUEUE_CAP);
    let key = normalize_home_key(codex_home);
    let map = notification_state_map();
    let guard = map.lock().await;
    let Some(st) = guard.get(key.as_ref()) else {
        drop(guard);
        return (Vec::new(), None, None, false);
    };
    let (out, first, last, gap) = replay_notification_state(st, since_event_id, cap);
    let out_len = out.len();
    drop(guard);
    if out_len > 0 || gap {
        push_debug_event(
            "app.notification.replay",
            serde_json::json!({
                "home": key.as_ref(),
                "sinceEventId": since_event_id,
                "max": cap,
                "count": out_len,
                "firstEventId": first,
                "lastEventId": last,
                "gap": gap,
            }),
        )
        .await;
    }
    (out, first, last, gap)
}

pub async fn ensure_server_in_home(codex_home: Option<&str>) -> Result<(), String> {
    ensure_notification_home_state(codex_home).await;

    #[cfg(test)]
    {
        let lock = TEST_REQUEST_HANDLER.get_or_init(|| Mutex::new(None));
        if lock.lock().await.is_some() {
            push_debug_event(
                "app.server.ensure.test",
                serde_json::json!({
                    "home": normalize_home_key(codex_home).as_ref(),
                }),
            )
            .await;
            return Ok(());
        }
    }

    let key = normalize_home_key(codex_home).to_string();
    let lock = APP_SERVERS.get_or_init(|| Mutex::new(HashMap::new()));

    loop {
        let existing = {
            let guard = lock.lock().await;
            guard.get(&key).cloned()
        };

        if let Some(server) = existing {
            let dead = {
                let mut srv = server.lock().await;
                srv.is_dead().unwrap_or(true)
            };
            if !dead {
                return Ok(());
            }
            let mut guard = lock.lock().await;
            if guard
                .get(&key)
                .is_some_and(|current| std::sync::Arc::ptr_eq(current, &server))
            {
                guard.remove(&key);
            }
            continue;
        }

        push_debug_event(
            "app.server.ensure.spawn_requested",
            serde_json::json!({
                "home": key,
            }),
        )
        .await;

        let spawned = AppServer::spawn(if key.is_empty() {
            None
        } else {
            Some(key.as_str())
        })
        .await?;
        let spawned_arc = std::sync::Arc::new(Mutex::new(spawned));
        let mut guard = lock.lock().await;
        guard
            .entry(key.clone())
            .or_insert_with(|| spawned_arc.clone());
        return Ok(());
    }
}

fn resolve_codex_cmd() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        if let Ok(appdata) = std::env::var("APPDATA") {
            let candidate = PathBuf::from(appdata).join("npm").join("codex.cmd");
            if candidate.exists() {
                return Some(candidate);
            }
        }
    }
    None
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum LaunchSpec {
    Native {
        codex_home: Option<String>,
    },
    #[cfg(any(test, target_os = "windows"))]
    Wsl {
        distro: Option<String>,
        codex_home_linux: Option<String>,
    },
}

#[cfg(any(test, target_os = "windows"))]
fn shell_single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

#[cfg(any(test, target_os = "windows"))]
fn parse_wsl_unc_codex_home(value: &str) -> Option<(String, String)> {
    let mut text = value.trim().replace('/', "\\");
    if let Some(stripped) = text.strip_prefix(r"\\?\UNC\") {
        text = format!(r"\\{stripped}");
    }
    let stripped = text
        .strip_prefix(r"\\wsl.localhost\")
        .or_else(|| text.strip_prefix(r"\\wsl$\\"))?;
    let mut parts = stripped.split('\\').filter(|part| !part.is_empty());
    let distro = parts.next()?.trim().to_string();
    if distro.is_empty() {
        return None;
    }
    let rest = parts.collect::<Vec<_>>();
    let linux_path = if rest.is_empty() {
        "/".to_string()
    } else {
        format!("/{}", rest.join("/"))
    };
    Some((distro, linux_path))
}

fn resolve_launch_spec(codex_home: Option<&str>) -> LaunchSpec {
    let home = codex_home
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string());
    #[cfg(any(test, target_os = "windows"))]
    {
        if let Some(ref value) = home {
            if let Some((distro, linux_path)) = parse_wsl_unc_codex_home(value) {
                return LaunchSpec::Wsl {
                    distro: Some(distro),
                    codex_home_linux: Some(linux_path),
                };
            }
            #[cfg(target_os = "windows")]
            if value.starts_with('/') {
                return LaunchSpec::Wsl {
                    distro: None,
                    codex_home_linux: Some(value.clone()),
                };
            }
        }
    }
    LaunchSpec::Native { codex_home: home }
}

fn build_codex_command(codex_home: Option<&str>) -> Command {
    match resolve_launch_spec(codex_home) {
        LaunchSpec::Native { codex_home } => {
            if let Some(path) = resolve_codex_cmd() {
                let mut cmd = Command::new("cmd.exe");
                cmd.arg("/c").arg(path).arg("app-server");
                if let Some(home) = codex_home.as_deref() {
                    cmd.env("CODEX_HOME", home);
                }
                #[cfg(target_os = "windows")]
                cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
                return cmd;
            }
            let mut cmd = Command::new("codex");
            cmd.arg("app-server");
            if let Some(home) = codex_home.as_deref() {
                cmd.env("CODEX_HOME", home);
            }
            #[cfg(target_os = "windows")]
            cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
            cmd
        }
        #[cfg(any(test, target_os = "windows"))]
        LaunchSpec::Wsl {
            distro,
            codex_home_linux,
        } => {
            let mut cmd = Command::new("wsl.exe");
            if let Some(distro) = distro.as_deref() {
                cmd.arg("-d").arg(distro);
            }
            cmd.arg("-e").arg("sh").arg("-lc");
            let script = if let Some(home) = codex_home_linux.as_deref() {
                format!(
                    "export CODEX_HOME={}; exec codex app-server",
                    shell_single_quote(home)
                )
            } else {
                "exec codex app-server".to_string()
            };
            cmd.arg(script);
            #[cfg(target_os = "windows")]
            cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
            cmd
        }
    }
}

#[cfg(test)]
pub async fn _clear_notifications_for_test() {
    let map = notification_state_map();
    let mut guard = map.lock().await;
    guard.clear();
    drop(guard);
    let mut live_sync = rollout_live_sync_map().lock().await;
    live_sync.clear();
    drop(live_sync);
    let mut debug = debug_event_queue().lock().await;
    debug.clear();
}

#[cfg(test)]
pub async fn _push_notification_for_test(codex_home: Option<&str>, value: Value) {
    push_notification(codex_home, value).await;
}

async fn write_json_line(
    stdin: &mut tokio::process::ChildStdin,
    value: &serde_json::Value,
) -> Result<(), String> {
    let line = value.to_string();
    stdin
        .write_all(line.as_bytes())
        .await
        .map_err(|e| e.to_string())?;
    stdin.write_all(b"\n").await.map_err(|e| e.to_string())?;
    stdin.flush().await.map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Default)]
struct PendingRouter {
    pending: Mutex<HashMap<i64, oneshot::Sender<Value>>>,
}

impl PendingRouter {
    async fn register(&self, id: i64) -> oneshot::Receiver<Value> {
        let (tx, rx) = oneshot::channel();
        let mut guard = self.pending.lock().await;
        guard.insert(id, tx);
        rx
    }

    async fn deliver(&self, id: i64, value: Value) -> bool {
        let tx = {
            let mut guard = self.pending.lock().await;
            guard.remove(&id)
        };
        if let Some(tx) = tx {
            let _ = tx.send(value);
            return true;
        }
        false
    }
}

async fn route_stdout_lines(
    stdout: tokio::process::ChildStdout,
    router: std::sync::Arc<PendingRouter>,
    codex_home: Option<String>,
) {
    let mut reader = BufReader::new(stdout).lines();
    loop {
        match reader.next_line().await {
            Ok(Some(line)) => {
                if line.trim().is_empty() {
                    continue;
                }
                let Ok(value) = serde_json::from_str::<Value>(&line) else {
                    push_debug_event(
                        "app.stdout.drop.invalid_json",
                        serde_json::json!({
                            "home": codex_home.as_deref().unwrap_or(""),
                            "raw": line.chars().take(180).collect::<String>(),
                        }),
                    )
                    .await;
                    continue;
                };
                if let Some(id) = value.get("id").and_then(|v| v.as_i64()) {
                    push_debug_event(
                        "app.stdout.response",
                        serde_json::json!({
                            "home": codex_home.as_deref().unwrap_or(""),
                            "requestId": id,
                            "hasResult": value.get("result").is_some(),
                            "hasError": value.get("error").is_some(),
                        }),
                    )
                    .await;
                    let _ = router.deliver(id, value).await;
                    continue;
                }
                if let Some(notification) = normalize_stdout_notification(&value) {
                    push_notification(codex_home.as_deref(), notification).await;
                    continue;
                }
                push_debug_event(
                    "app.stdout.drop.ignored_shape",
                    serde_json::json!({
                        "home": codex_home.as_deref().unwrap_or(""),
                        "hasId": value.get("id").is_some(),
                        "hasMethod": value.get("method").is_some(),
                        "keys": value.as_object().map(|obj| obj.keys().cloned().collect::<Vec<_>>()).unwrap_or_default(),
                    }),
                )
                .await;
            }
            Ok(None) => {
                push_debug_event(
                    "app.stdout.eof",
                    serde_json::json!({
                        "home": codex_home.as_deref().unwrap_or(""),
                    }),
                )
                .await;
                break;
            }
            Err(error) => {
                push_debug_event(
                    "app.stdout.read_error",
                    serde_json::json!({
                        "home": codex_home.as_deref().unwrap_or(""),
                        "message": error.to_string(),
                    }),
                )
                .await;
                break;
            }
        }
    }
}

struct AppServer {
    child: tokio::process::Child,
    stdin: tokio::process::ChildStdin,
    router: std::sync::Arc<PendingRouter>,
    _stdout_task: tokio::task::JoinHandle<()>,
    next_id: i64,
}

impl AppServer {
    async fn spawn(codex_home: Option<&str>) -> Result<Self, String> {
        let home = normalize_home_key(codex_home).to_string();
        push_debug_event(
            "app.server.spawn.start",
            serde_json::json!({
                "home": home,
            }),
        )
        .await;
        let mut cmd = build_codex_command(codex_home);

        let mut child = match cmd
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
        {
            Ok(child) => child,
            Err(error) => {
                push_debug_event(
                    "app.server.spawn.error",
                    serde_json::json!({
                        "home": home,
                        "message": error.to_string(),
                    }),
                )
                .await;
                return Err(format!("failed to start codex app-server: {error}"));
            }
        };

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "failed to open codex stdin".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "failed to open codex stdout".to_string())?;

        let router = std::sync::Arc::new(PendingRouter::default());
        let router_for_task = router.clone();
        let home_for_task = codex_home
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let stdout_task = tokio::spawn(async move {
            route_stdout_lines(stdout, router_for_task, home_for_task).await;
        });

        // Initialize via normal request path so notifications can be captured concurrently.
        let mut server = Self {
            child,
            stdin,
            router,
            _stdout_task: stdout_task,
            next_id: 1,
        };
        let _ = server
            .request(
                "initialize",
                serde_json::json!({
                    "clientInfo": {
                        "name": "API Router",
                        "version": env!("CARGO_PKG_VERSION")
                    }
                }),
            )
            .await?;

        let initialized = serde_json::json!({
            "method": "initialized",
            "params": {}
        });
        write_json_line(&mut server.stdin, &initialized).await?;

        server.next_id = 2;
        push_debug_event(
            "app.server.spawn.ok",
            serde_json::json!({
                "home": normalize_home_key(codex_home).as_ref(),
            }),
        )
        .await;
        Ok(server)
    }

    fn is_dead(&mut self) -> Result<bool, String> {
        match self.child.try_wait() {
            Ok(Some(_)) => Ok(true),
            Ok(None) => Ok(false),
            Err(e) => Err(e.to_string()),
        }
    }

    async fn request(&mut self, method: &str, params: Value) -> Result<Value, String> {
        if self.is_dead()? {
            return Err("codex app-server exited".to_string());
        }

        let params = if params.is_null() {
            Value::Object(serde_json::Map::new())
        } else {
            params
        };
        let request_id = self.next_id;
        self.next_id = self.next_id.saturating_add(1);
        let request = serde_json::json!({
            "id": request_id,
            "method": method,
            "params": params
        });
        let rx = self.router.register(request_id).await;
        write_json_line(&mut self.stdin, &request).await?;

        let response = tokio::time::timeout(REQUEST_TIMEOUT, rx)
            .await
            .map_err(|_| "codex app-server timed out".to_string())?
            .map_err(|_| "codex app-server closed before responding".to_string())?;

        if let Some(err) = response.get("error") {
            if let Some(msg) = err.get("message").and_then(|v| v.as_str()) {
                return Err(msg.to_string());
            }
            return Err("codex app-server error".to_string());
        }

        response
            .get("result")
            .cloned()
            .ok_or_else(|| "codex app-server response missing result".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncWriteExt;

    // codex_app_server uses global singletons (notification ring buffer + event id counter).
    // These tests must run serially to avoid cross-test interference.
    fn lock_tests() -> std::sync::MutexGuard<'static, ()> {
        lock_test_globals()
    }

    struct TestCodexHomeGuard {
        previous: Option<String>,
    }

    impl Drop for TestCodexHomeGuard {
        fn drop(&mut self) {
            if let Some(previous) = self.previous.take() {
                unsafe {
                    std::env::set_var("CODEX_HOME", previous);
                }
            } else {
                unsafe {
                    std::env::remove_var("CODEX_HOME");
                }
            }
        }
    }

    fn isolate_default_codex_home() -> TestCodexHomeGuard {
        let previous = std::env::var("CODEX_HOME").ok();
        let temp = tempfile::tempdir().expect("temp codex home");
        let temp_path = temp.keep();
        let sessions = temp_path.join("sessions");
        std::fs::create_dir_all(&sessions).expect("sessions dir");
        unsafe {
            std::env::set_var("CODEX_HOME", &temp_path);
        }
        TestCodexHomeGuard { previous }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn stdout_router_captures_notifications_and_delivers_responses() {
        let _guard = lock_tests();
        let _home = isolate_default_codex_home();
        _clear_notifications_for_test().await;

        let (mut w, r) = tokio::io::duplex(8 * 1024);
        // duplex gives us AsyncRead/Write; wrap the reader side into the same route function
        // by faking a ChildStdout via a pipe-like approach is not possible, so we test the core
        // logic by writing into a BufReader<DuplexStream> here.
        //
        // We keep this test close to production behavior: parse JSON lines and route by id.
        let router = std::sync::Arc::new(PendingRouter::default());

        let router_for_task = router.clone();
        let read_task = tokio::spawn(async move {
            let mut reader = BufReader::new(r).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                if line.trim().is_empty() {
                    continue;
                }
                let Ok(value) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                if let Some(id) = value.get("id").and_then(|v| v.as_i64()) {
                    let _ = router_for_task.deliver(id, value).await;
                    continue;
                }
                if let Some(notification) = normalize_stdout_notification(&value) {
                    push_notification(None, notification).await;
                }
            }
        });

        // Register a pending request and send a notification + response lines.
        let rx = router.register(99).await;
        let notif = serde_json::json!({"method":"turn/status","params":{"thread_id":"t1","status":"running"}});
        let commentary = serde_json::json!({
            "type":"event_msg",
            "payload":{"type":"agent_message","thread_id":"t1","phase":"commentary","message":"thinking"}
        });
        let final_item = serde_json::json!({
            "type":"response_item",
            "payload":{"type":"message","role":"assistant","thread_id":"t1","phase":"final_answer","content":[{"type":"output_text","text":"done"}]}
        });
        let resp = serde_json::json!({"id":99,"result":{"ok":true}});
        w.write_all(notif.to_string().as_bytes()).await.unwrap();
        w.write_all(b"\n").await.unwrap();
        w.write_all(commentary.to_string().as_bytes())
            .await
            .unwrap();
        w.write_all(b"\n").await.unwrap();
        w.write_all(final_item.to_string().as_bytes())
            .await
            .unwrap();
        w.write_all(b"\n").await.unwrap();
        w.write_all(resp.to_string().as_bytes()).await.unwrap();
        w.write_all(b"\n").await.unwrap();
        w.shutdown().await.unwrap();

        let got = tokio::time::timeout(Duration::from_millis(800), rx)
            .await
            .expect("response timeout")
            .expect("oneshot dropped");
        assert_eq!(got.get("id").and_then(|v| v.as_i64()), Some(99));

        let (drained, _first, _last, _gap) = replay_notifications_since_in_home(None, 0, 8).await;
        assert_eq!(drained.len(), 3);
        assert_eq!(
            drained[0].get("method").and_then(|v| v.as_str()),
            Some("turn/status")
        );
        assert_eq!(
            drained[1].get("method").and_then(|v| v.as_str()),
            Some("codex/event/agent_message")
        );
        assert_eq!(
            drained[2].get("method").and_then(|v| v.as_str()),
            Some("codex/event/response_item")
        );
        assert_eq!(drained[0].get("eventId").and_then(|v| v.as_u64()), Some(1));
        assert_eq!(drained[1].get("eventId").and_then(|v| v.as_u64()), Some(2));
        assert_eq!(drained[2].get("eventId").and_then(|v| v.as_u64()), Some(3));

        let _ = read_task.await;
    }

    #[test]
    fn normalize_stdout_notification_wraps_commentary_shapes() {
        let event_msg = serde_json::json!({
            "type":"event_msg",
            "payload":{"type":"agent_message","thread_id":"thread-1","phase":"commentary","message":"thinking"}
        });
        let response_item = serde_json::json!({
            "type":"response_item",
            "payload":{"type":"message","role":"assistant","thread_id":"thread-1","phase":"final_answer","content":[{"type":"output_text","text":"done"}]}
        });

        let wrapped_event = normalize_stdout_notification(&event_msg).expect("wrapped event_msg");
        let wrapped_item =
            normalize_stdout_notification(&response_item).expect("wrapped response_item");

        assert_eq!(
            wrapped_event.get("method").and_then(Value::as_str),
            Some("codex/event/agent_message")
        );
        assert_eq!(
            wrapped_item.get("method").and_then(Value::as_str),
            Some("codex/event/response_item")
        );
        assert_eq!(
            extract_thread_id_for_debug(&wrapped_event).as_deref(),
            Some("thread-1")
        );
        assert_eq!(
            extract_thread_id_for_debug(&wrapped_item).as_deref(),
            Some("thread-1")
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn replay_notifications_since_includes_event_ids_and_gaps() {
        let _guard = lock_tests();
        let _home = isolate_default_codex_home();
        _clear_notifications_for_test().await;
        push_notification(None, serde_json::json!({"method":"a","params":{}})).await;
        push_notification(None, serde_json::json!({"method":"b","params":{}})).await;

        let (all, first, last, gap) = replay_notifications_since_in_home(None, 0, 10).await;
        assert_eq!(first, Some(1));
        assert_eq!(last, Some(2));
        assert!(!gap);
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].get("eventId").and_then(|v| v.as_u64()), Some(1));
        assert_eq!(all[1].get("eventId").and_then(|v| v.as_u64()), Some(2));

        let (only_b, _f2, _l2, gap2) = replay_notifications_since_in_home(None, 1, 10).await;
        assert!(!gap2);
        assert_eq!(only_b.len(), 1);
        assert_eq!(only_b[0].get("method").and_then(|v| v.as_str()), Some("b"));
        assert_eq!(only_b[0].get("eventId").and_then(|v| v.as_u64()), Some(2));

        // If the buffer is empty, first/last are None.
        _clear_notifications_for_test().await;
        let (empty, f3, l3, gap3) = replay_notifications_since_in_home(None, 0, 10).await;
        assert!(empty.is_empty());
        assert_eq!(f3, None);
        assert_eq!(l3, None);
        assert!(!gap3);
    }
    #[test]
    fn replay_gap_flag_when_since_is_older_than_ring_buffer() {
        let _guard = lock_tests();
        let mut state = NotificationState::default();
        for i in 0..(NOTIFICATION_QUEUE_CAP + 2) {
            let value = serde_json::json!({"method":"m","params":{"i":i}});
            let _ = push_notification_into_state(&mut state, value);
        }
        let (items, first, last, gap) = replay_notification_state(&state, 0, 5);
        assert!(
            gap,
            "expected gap=true when since is older than retained buffer"
        );
        assert!(first.is_some());
        assert!(last.is_some());
        assert!(!items.is_empty());
        assert!(first.unwrap() > 1);
    }
    #[test]
    fn notification_overflow_emits_debug_event() {
        let _guard = lock_tests();
        let mut state = NotificationState::default();
        let mut dropped = None;
        for i in 0..=NOTIFICATION_QUEUE_CAP {
            let value = serde_json::json!({
                "method": "turn/status",
                "params": { "thread_id": format!("thread-{i}") }
            });
            let (_, queue_len, maybe_dropped) = push_notification_into_state(&mut state, value);
            if i < NOTIFICATION_QUEUE_CAP {
                assert!(maybe_dropped.is_none());
                assert_eq!(queue_len, i + 1);
            } else {
                dropped = maybe_dropped.map(|(event_id, value)| (event_id, value, queue_len));
            }
        }

        let (dropped_event_id, dropped_value, queue_len) = dropped
            .expect("overflow should drop the oldest notification once capacity is exceeded");
        assert_eq!(dropped_event_id, 1);
        assert_eq!(queue_len, NOTIFICATION_QUEUE_CAP);
        assert_eq!(
            dropped_value.get("method").and_then(Value::as_str),
            Some("turn/status")
        );
        assert_eq!(
            extract_thread_id_for_debug(&dropped_value).as_deref(),
            Some("thread-0")
        );
        assert_eq!(state.items.len(), NOTIFICATION_QUEUE_CAP);
        assert_eq!(state.items.front().map(|(event_id, _)| *event_id), Some(2));
    }
    #[tokio::test(flavor = "current_thread")]
    async fn replay_notifications_skip_debug_trace_for_empty_polls() {
        let _guard = lock_tests();
        let _home = isolate_default_codex_home();
        _clear_notifications_for_test().await;

        let (items, first, last, gap) = replay_notifications_since_in_home(None, 0, 10).await;
        assert!(items.is_empty());
        assert_eq!(first, None);
        assert_eq!(last, None);
        assert!(!gap);

        let snapshot = debug_snapshot().await;
        let recent = snapshot
            .get("recent")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        assert!(
            recent.iter().all(|entry| {
                entry.get("kind").and_then(Value::as_str) != Some("app.notification.replay")
                    && entry.get("kind").and_then(Value::as_str)
                        != Some("app.notification.replay.empty_home")
            }),
            "empty replay polls should not emit debug trace entries"
        );
    }

    #[cfg(target_os = "windows")]
    #[tokio::test(flavor = "current_thread")]
    async fn wsl_homes_route_requests_through_bridge_transport() {
        let _guard = lock_tests();
        _clear_notifications_for_test().await;
        crate::codex_wsl_bridge::_set_test_rpc_handler(Some(std::sync::Arc::new(
            |codex_home, method, params| {
                assert_eq!(codex_home, Some("/home/me/.codex"));
                assert_eq!(method, "thread/read");
                assert_eq!(params.get("id").and_then(|v| v.as_str()), Some("thread-1"));
                Ok(serde_json::json!({ "via": "bridge" }))
            },
        )))
        .await;

        let result = request_in_home(
            Some(r"\\wsl.localhost\Ubuntu\home\me\.codex"),
            "thread/read",
            serde_json::json!({ "id": "thread-1" }),
        )
        .await
        .expect("bridge result");

        crate::codex_wsl_bridge::_set_test_rpc_handler(None).await;
        assert_eq!(result.get("via").and_then(|v| v.as_str()), Some("bridge"));
    }

    #[cfg(target_os = "windows")]
    #[tokio::test(flavor = "current_thread")]
    async fn wsl_homes_route_notification_replay_through_bridge_transport() {
        let _guard = lock_tests();
        _clear_notifications_for_test().await;
        crate::codex_wsl_bridge::_set_test_replay_handler(Some(std::sync::Arc::new(
            |codex_home, since_event_id, max| {
                assert_eq!(codex_home, Some("/home/me/.codex"));
                assert_eq!(since_event_id, 4);
                assert_eq!(max, 2);
                (
                    vec![serde_json::json!({
                        "eventId": 5,
                        "method": "turn/status",
                        "params": { "status": "running" }
                    })],
                    Some(5),
                    Some(5),
                    false,
                )
            },
        )))
        .await;

        let (items, first, last, gap) = replay_notifications_since_in_home(
            Some(r"\\wsl.localhost\Ubuntu\home\me\.codex"),
            4,
            2,
        )
        .await;

        crate::codex_wsl_bridge::_set_test_replay_handler(None).await;
        assert_eq!(first, Some(5));
        assert_eq!(last, Some(5));
        assert!(!gap);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].get("eventId").and_then(|v| v.as_u64()), Some(5));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn ensure_server_in_home_initializes_notification_ring_for_selected_home() {
        let _guard = lock_tests();
        _clear_notifications_for_test().await;
        _set_test_request_handler(Some(std::sync::Arc::new(
            |_codex_home, _method, _params| Ok(serde_json::json!({ "ok": true })),
        )))
        .await;

        ensure_server_in_home(Some(r"C:\Users\yiyou\.codex"))
            .await
            .expect("ensure server");

        let snapshot = debug_snapshot().await;
        let homes = snapshot
            .get("homes")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        assert!(homes.iter().any(|entry| {
            entry.get("home").and_then(Value::as_str) == Some(r"C:\Users\yiyou\.codex")
        }));

        _set_test_request_handler(None).await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn notification_home_state_starts_event_ids_at_one() {
        let _guard = lock_tests();
        let _home = isolate_default_codex_home();
        _clear_notifications_for_test().await;

        let codex_home = std::env::var("CODEX_HOME").expect("isolated codex home");
        ensure_notification_home_state(Some(codex_home.as_str())).await;
        push_notification(
            Some(codex_home.as_str()),
            serde_json::json!({
                "method": "thread/status/changed",
                "params": { "threadId": "thread-1" }
            }),
        )
        .await;

        let (items, first, last, gap) =
            replay_notifications_since_in_home(Some(codex_home.as_str()), 0, 8).await;
        assert!(!gap);
        assert_eq!(first, Some(1));
        assert_eq!(last, Some(1));
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].get("eventId").and_then(Value::as_u64), Some(1));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn replay_notifications_tail_rollout_turn_status_and_reasoning() {
        let _guard = lock_tests();
        _clear_notifications_for_test().await;

        let temp = tempfile::tempdir().expect("temp dir");
        let codex_home = temp.path().join(".codex");
        let sessions = codex_home
            .join("sessions")
            .join("2026")
            .join("03")
            .join("17");
        std::fs::create_dir_all(&sessions).expect("sessions dir");
        let rollout = sessions.join("rollout-2026-03-17T12-00-00-thread-live.jsonl");
        std::fs::write(
            &rollout,
            concat!(
                "{\"timestamp\":\"2026-03-17T12:00:00Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"thread-live\"}}\n",
                "{\"timestamp\":\"2026-03-17T12:00:01Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"turn_started\",\"thread_id\":\"thread-live\",\"turn_id\":\"turn-1\"}}\n",
                "{\"timestamp\":\"2026-03-17T12:00:02Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"agent_reasoning\",\"thread_id\":\"thread-live\",\"text\":\"thinking live\"}}\n",
                "{\"timestamp\":\"2026-03-17T12:00:03Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"turn_complete\",\"thread_id\":\"thread-live\",\"turn_id\":\"turn-1\"}}\n"
            ),
        )
        .expect("write rollout");

        let (items, first, last, gap) =
            replay_notifications_since_in_home(Some(codex_home.to_string_lossy().as_ref()), 0, 16)
                .await;

        assert!(!gap);
        assert_eq!(first, Some(1));
        assert_eq!(last, Some(5));
        assert_eq!(items.len(), 5);
        assert_eq!(
            items[0].get("method").and_then(Value::as_str),
            Some("turn/started")
        );
        assert_eq!(
            items[1].get("method").and_then(Value::as_str),
            Some("thread/status/changed")
        );
        assert_eq!(
            items[2].get("method").and_then(Value::as_str),
            Some("codex/event/agent_reasoning")
        );
        assert_eq!(
            items[0].get("timestamp").and_then(Value::as_str),
            Some("2026-03-17T12:00:01Z")
        );
        assert_eq!(
            items[0]
                .get("params")
                .and_then(|value| value.get("timestamp"))
                .and_then(Value::as_str),
            Some("2026-03-17T12:00:01Z")
        );
        assert_eq!(
            items[3].get("method").and_then(Value::as_str),
            Some("turn/completed")
        );
        assert_eq!(
            items[4].get("method").and_then(Value::as_str),
            Some("thread/status/changed")
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn replay_notifications_tail_rollout_command_begin_and_failure() {
        let _guard = lock_tests();
        _clear_notifications_for_test().await;

        let temp = tempfile::tempdir().expect("temp dir");
        let codex_home = temp.path().join(".codex");
        let sessions = codex_home.join("sessions");
        std::fs::create_dir_all(&sessions).expect("sessions dir");
        let rollout = sessions.join("rollout-2026-03-17T12-10-00-thread-cmd.jsonl");
        std::fs::write(
            &rollout,
            concat!(
                "{\"type\":\"session_meta\",\"payload\":{\"id\":\"thread-cmd\"}}\n",
                "{\"type\":\"response_item\",\"payload\":{\"type\":\"function_call\",\"thread_id\":\"thread-cmd\",\"name\":\"exec_command\",\"call_id\":\"call-1\",\"arguments\":\"{\\\"cmd\\\":\\\"npm test\\\"}\"}}\n",
                "{\"type\":\"response_item\",\"payload\":{\"type\":\"function_call_output\",\"thread_id\":\"thread-cmd\",\"call_id\":\"call-1\",\"output\":\"{\\\"output\\\":\\\"boom\\\",\\\"metadata\\\":{\\\"exit_code\\\":1}}\"}}\n"
            ),
        )
        .expect("write rollout");

        let (items, _first, _last, _gap) =
            replay_notifications_since_in_home(Some(codex_home.to_string_lossy().as_ref()), 0, 16)
                .await;

        assert_eq!(items.len(), 2);
        assert_eq!(
            items[0].get("method").and_then(Value::as_str),
            Some("item/started")
        );
        assert_eq!(
            items[0]
                .get("params")
                .and_then(|value| value.get("item"))
                .and_then(|value| value.get("type"))
                .and_then(Value::as_str),
            Some("commandExecution")
        );
        assert_eq!(
            items[1].get("method").and_then(Value::as_str),
            Some("item/completed")
        );
        assert_eq!(
            items[1]
                .get("params")
                .and_then(|value| value.get("item"))
                .and_then(|value| value.get("status"))
                .and_then(Value::as_str),
            Some("failed")
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn replay_notifications_tail_rollout_command_keeps_success_with_stderr_warning() {
        let _guard = lock_tests();
        _clear_notifications_for_test().await;

        let temp = tempfile::tempdir().expect("temp dir");
        let codex_home = temp.path().join(".codex");
        let sessions = codex_home.join("sessions");
        std::fs::create_dir_all(&sessions).expect("sessions dir");
        let rollout = sessions.join("rollout-2026-03-17T12-12-00-thread-warn.jsonl");
        std::fs::write(
            &rollout,
            concat!(
                "{\"type\":\"session_meta\",\"payload\":{\"id\":\"thread-warn\"}}\n",
                "{\"type\":\"response_item\",\"payload\":{\"type\":\"function_call\",\"thread_id\":\"thread-warn\",\"name\":\"exec_command\",\"call_id\":\"call-1\",\"arguments\":\"{\\\"cmd\\\":\\\"Get-Content file.txt\\\"}\"}}\n",
                "{\"type\":\"response_item\",\"payload\":{\"type\":\"function_call_output\",\"thread_id\":\"thread-warn\",\"call_id\":\"call-1\",\"output\":\"{\\\"output\\\":\\\"ok\\\",\\\"stderr\\\":\\\"warning only\\\",\\\"metadata\\\":{\\\"exit_code\\\":0}}\"}}\n"
            ),
        )
        .expect("write rollout");

        let (items, _first, _last, _gap) =
            replay_notifications_since_in_home(Some(codex_home.to_string_lossy().as_ref()), 0, 16)
                .await;

        assert_eq!(items.len(), 2);
        assert_eq!(
            items[1]
                .get("params")
                .and_then(|value| value.get("item"))
                .and_then(|value| value.get("status"))
                .and_then(Value::as_str),
            Some("completed")
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn replay_notifications_tail_rollout_unwraps_windows_shell_wrapper_arrays() {
        let _guard = lock_tests();
        _clear_notifications_for_test().await;

        let temp = tempfile::tempdir().expect("temp dir");
        let codex_home = temp.path().join(".codex");
        let sessions = codex_home.join("sessions");
        std::fs::create_dir_all(&sessions).expect("sessions dir");
        let rollout = sessions.join("rollout-2026-03-17T12-13-00-thread-wrapper.jsonl");
        let wrapped_arguments = serde_json::to_string(&serde_json::json!({
            "command": [
                "C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
                "-Command",
                "git status --short"
            ]
        }))
        .expect("wrapped arguments");
        std::fs::write(
            &rollout,
            format!(
                "{}\n",
                [
                r#"{"type":"session_meta","payload":{"id":"thread-wrapper"}}"#.to_string(),
                serde_json::json!({
                    "type": "response_item",
                    "payload": {
                        "type": "function_call",
                        "thread_id": "thread-wrapper",
                        "name": "shell_command",
                        "call_id": "call-1",
                        "arguments": wrapped_arguments
                    }
                })
                .to_string(),
                r#"{"type":"response_item","payload":{"type":"function_call_output","thread_id":"thread-wrapper","call_id":"call-1","output":"{\"output\":\"M file.txt\",\"metadata\":{\"exit_code\":0}}"}}"#.to_string(),
            ]
            .join("\n")
            ),
        )
        .expect("write rollout");

        let (items, _first, _last, _gap) =
            replay_notifications_since_in_home(Some(codex_home.to_string_lossy().as_ref()), 0, 16)
                .await;

        assert_eq!(items.len(), 2);
        assert_eq!(
            items[0]
                .get("params")
                .and_then(|value| value.get("item"))
                .and_then(|value| value.get("command"))
                .and_then(Value::as_str),
            Some("git status --short")
        );
        assert_eq!(
            items[1]
                .get("params")
                .and_then(|value| value.get("item"))
                .and_then(|value| value.get("command"))
                .and_then(Value::as_str),
            Some("git status --short")
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn replay_notifications_tail_rollout_incrementally_in_terminal_order() {
        let _guard = lock_tests();
        _clear_notifications_for_test().await;

        let temp = tempfile::tempdir().expect("temp dir");
        let codex_home = temp.path().join(".codex");
        let sessions = codex_home.join("sessions");
        std::fs::create_dir_all(&sessions).expect("sessions dir");
        let rollout = sessions.join("rollout-2026-03-17T12-30-00-thread-seq.jsonl");
        std::fs::write(
            &rollout,
            "{\"type\":\"session_meta\",\"payload\":{\"id\":\"thread-seq\"}}\n",
        )
        .expect("write rollout");

        let mut cursor = 0;

        {
            let mut file = std::fs::OpenOptions::new()
                .append(true)
                .open(&rollout)
                .expect("append rollout");
            use std::io::Write;
            writeln!(
                file,
                "{}",
                r#"{"type":"event_msg","payload":{"type":"turn_started","thread_id":"thread-seq","turn_id":"turn-1"}}"#
            )
            .expect("append turn started");
        }
        let (batch1, _, _, _) = replay_notifications_since_in_home(
            Some(codex_home.to_string_lossy().as_ref()),
            cursor,
            16,
        )
        .await;
        assert_eq!(
            batch1
                .iter()
                .map(|item| item
                    .get("method")
                    .and_then(Value::as_str)
                    .unwrap_or_default())
                .collect::<Vec<_>>(),
            vec!["turn/started", "thread/status/changed"]
        );
        cursor = batch1
            .last()
            .and_then(|item| item.get("eventId"))
            .and_then(Value::as_u64)
            .unwrap_or(0);

        {
            let mut file = std::fs::OpenOptions::new()
                .append(true)
                .open(&rollout)
                .expect("append rollout");
            use std::io::Write;
            writeln!(
                file,
                "{}",
                r#"{"type":"event_msg","payload":{"type":"agent_reasoning","thread_id":"thread-seq","text":"thinking step"}}"#
            )
            .expect("append reasoning");
            writeln!(
                file,
                "{}",
                r#"{"type":"response_item","payload":{"type":"function_call","thread_id":"thread-seq","name":"exec_command","call_id":"call-1","arguments":"{\"cmd\":\"npm test\"}"}}"#
            )
            .expect("append command start");
        }
        let (batch2, _, _, _) = replay_notifications_since_in_home(
            Some(codex_home.to_string_lossy().as_ref()),
            cursor,
            16,
        )
        .await;
        assert_eq!(
            batch2
                .iter()
                .map(|item| item
                    .get("method")
                    .and_then(Value::as_str)
                    .unwrap_or_default())
                .collect::<Vec<_>>(),
            vec!["codex/event/agent_reasoning", "item/started"]
        );
        cursor = batch2
            .last()
            .and_then(|item| item.get("eventId"))
            .and_then(Value::as_u64)
            .unwrap_or(cursor);

        {
            let mut file = std::fs::OpenOptions::new()
                .append(true)
                .open(&rollout)
                .expect("append rollout");
            use std::io::Write;
            writeln!(
                file,
                "{}",
                r#"{"type":"response_item","payload":{"type":"message","role":"assistant","thread_id":"thread-seq","phase":"final_answer","content":[{"type":"output_text","text":"final from terminal"}]}}"#
            )
            .expect("append final");
            writeln!(
                file,
                "{}",
                r#"{"type":"response_item","payload":{"type":"function_call_output","thread_id":"thread-seq","call_id":"call-1","output":"{\"output\":\"ok\",\"metadata\":{\"exit_code\":0}}"}}"#
            )
            .expect("append command end");
            writeln!(
                file,
                "{}",
                r#"{"type":"event_msg","payload":{"type":"turn_complete","thread_id":"thread-seq","turn_id":"turn-1"}}"#
            )
            .expect("append turn complete");
        }
        let (batch3, _, _, _) = replay_notifications_since_in_home(
            Some(codex_home.to_string_lossy().as_ref()),
            cursor,
            16,
        )
        .await;
        assert_eq!(
            batch3
                .iter()
                .map(|item| item
                    .get("method")
                    .and_then(Value::as_str)
                    .unwrap_or_default())
                .collect::<Vec<_>>(),
            vec![
                "codex/event/response_item",
                "item/completed",
                "turn/completed",
                "thread/status/changed"
            ]
        );
    }

    #[test]
    fn live_sync_pass_runs_immediately_then_waits_for_interval() {
        let now = Instant::now();
        assert!(should_run_live_sync_pass(
            None,
            now,
            Duration::from_millis(250)
        ));
        assert!(!should_run_live_sync_pass(
            Some(now),
            now + Duration::from_millis(249),
            Duration::from_millis(250)
        ));
        assert!(should_run_live_sync_pass(
            Some(now),
            now + Duration::from_millis(250),
            Duration::from_millis(250)
        ));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn replay_notifications_live_sync_throttles_directory_rescans() {
        let _guard = lock_tests();
        _clear_notifications_for_test().await;

        let temp = tempfile::tempdir().expect("temp dir");
        let codex_home = temp.path().join(".codex");
        let sessions = codex_home.join("sessions");
        std::fs::create_dir_all(&sessions).expect("sessions dir");
        let first_rollout = sessions.join("rollout-2026-03-18T00-00-00-thread-a.jsonl");
        std::fs::write(
            &first_rollout,
            concat!(
                "{\"type\":\"session_meta\",\"payload\":{\"id\":\"thread-a\"}}\n",
                "{\"type\":\"event_msg\",\"payload\":{\"type\":\"turn_started\",\"thread_id\":\"thread-a\",\"turn_id\":\"turn-a-1\"}}\n"
            ),
        )
        .expect("write first rollout");

        let home_text = codex_home.to_string_lossy().to_string();
        let (initial_items, _, initial_last, _) =
            replay_notifications_since_in_home(Some(home_text.as_str()), 0, 16).await;
        assert_eq!(initial_items.len(), 2);
        let cursor = initial_last.expect("initial cursor");

        let second_rollout = sessions.join("rollout-2026-03-18T00-00-01-thread-b.jsonl");
        std::fs::write(
            &second_rollout,
            concat!(
                "{\"type\":\"session_meta\",\"payload\":{\"id\":\"thread-b\"}}\n",
                "{\"type\":\"event_msg\",\"payload\":{\"type\":\"turn_started\",\"thread_id\":\"thread-b\",\"turn_id\":\"turn-b-1\"}}\n"
            ),
        )
        .expect("write second rollout");

        let (throttled_items, _, _, _) =
            replay_notifications_since_in_home(Some(home_text.as_str()), cursor, 16).await;
        assert!(throttled_items.is_empty());

        {
            let key = normalize_home_key(Some(home_text.as_str())).to_string();
            let mut live_sync = rollout_live_sync_map().lock().await;
            let state = live_sync.get_mut(&key).expect("live sync state");
            state.last_discovery_at = Some(Instant::now() - ROLLOUT_LIVE_SYNC_DISCOVERY_INTERVAL);
        }

        let (rescanned_items, _, _, _) =
            replay_notifications_since_in_home(Some(home_text.as_str()), cursor, 16).await;
        assert_eq!(rescanned_items.len(), 2);
        assert!(rescanned_items.iter().any(|item| {
            item.get("params")
                .and_then(|value| value.get("threadId"))
                .and_then(Value::as_str)
                == Some("thread-b")
        }));
    }

    #[test]
    fn resolves_native_launcher_for_windows_home() {
        let spec = resolve_launch_spec(Some(r"C:\Users\yiyou\.codex"));
        assert_eq!(
            spec,
            LaunchSpec::Native {
                codex_home: Some(r"C:\Users\yiyou\.codex".to_string())
            }
        );
    }

    #[test]
    fn resolves_wsl_launcher_for_unc_home() {
        let spec = resolve_launch_spec(Some(r"\\?\UNC\wsl.localhost\Ubuntu\home\yiyou\.codex"));
        assert_eq!(
            spec,
            LaunchSpec::Wsl {
                distro: Some("Ubuntu".to_string()),
                codex_home_linux: Some("/home/yiyou/.codex".to_string())
            }
        );
    }

    #[test]
    fn resolves_wsl_launcher_for_linux_home() {
        let spec = resolve_launch_spec(Some("/home/yiyou/.codex"));
        #[cfg(target_os = "windows")]
        assert_eq!(
            spec,
            LaunchSpec::Wsl {
                distro: None,
                codex_home_linux: Some("/home/yiyou/.codex".to_string())
            }
        );
        #[cfg(not(target_os = "windows"))]
        assert_eq!(
            spec,
            LaunchSpec::Native {
                codex_home: Some("/home/yiyou/.codex".to_string())
            }
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn resolves_windows_accessible_wsl_codex_home_from_linux_path() {
        let _guard = lock_tests();
        let mut cache = crate::orchestrator::gateway::web_codex_home::lock_wsl_identity_cache();
        let previous = cache.clone();
        *cache = Some(
            crate::orchestrator::gateway::web_codex_home::WslIdentityCache {
                distro: "Ubuntu".to_string(),
                home: "/home/yiyou".to_string(),
                updated_at_unix_secs: i64::MAX,
            },
        );
        drop(cache);

        let mapped = resolve_windows_accessible_codex_home(Some("/home/yiyou/.codex"))
            .expect("mapped unc home");

        let mut cache = crate::orchestrator::gateway::web_codex_home::lock_wsl_identity_cache();
        *cache = previous;
        drop(cache);

        assert_eq!(
            mapped,
            PathBuf::from(r"\\wsl.localhost\Ubuntu\home\yiyou\.codex")
        );
    }

    #[test]
    fn command_completion_status_ignores_failure_words_in_successful_output() {
        let parsed = serde_json::json!({
            "output": "const note = \"command failed\";",
            "metadata": {
                "exit_code": 0
            }
        });
        assert_eq!(command_completion_status(Some(0), &parsed), "completed");
    }

    #[test]
    fn tool_completion_status_uses_structured_error_fields_only() {
        let parsed = serde_json::json!({
            "result": "search failed keyword appears in a document snippet"
        });
        assert_eq!(tool_completion_status(&parsed), "completed");

        let failed = serde_json::json!({
            "error": {
                "message": "backend denied request"
            }
        });
        assert_eq!(tool_completion_status(&failed), "failed");
    }
}

pub async fn request_in_home(
    codex_home: Option<&str>,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    #[cfg(test)]
    if let Some(result) = maybe_handle_test_request(codex_home, method, &params).await {
        return result;
    }

    let home = normalize_home_key(codex_home).to_string();
    ensure_notification_home_state(codex_home).await;
    let thread_id = extract_thread_id_for_debug(&serde_json::json!({
        "params": params.clone(),
    }))
    .unwrap_or_default();
    push_debug_event(
        "app.request.start",
        serde_json::json!({
            "home": home,
            "method": method,
            "threadId": thread_id,
        }),
    )
    .await;

    if let Some(result) =
        crate::codex_wsl_bridge::try_request_in_home(codex_home, method, params.clone()).await
    {
        let is_ok = result.is_ok();
        push_debug_event(
            if is_ok {
                "app.request.bridge.ok"
            } else {
                "app.request.bridge.error"
            },
            serde_json::json!({
                "home": home,
                "method": method,
                "threadId": thread_id,
                "message": result.as_ref().err().cloned().unwrap_or_default(),
            }),
        )
        .await;
        return result;
    }

    let key = home.clone();
    let lock = APP_SERVERS.get_or_init(|| Mutex::new(HashMap::new()));

    let server_arc = loop {
        let existing = {
            let guard = lock.lock().await;
            guard.get(&key).cloned()
        };

        if let Some(server) = existing {
            let dead = {
                let mut srv = server.lock().await;
                srv.is_dead().unwrap_or(true)
            };
            if !dead {
                break server;
            }
            let mut guard = lock.lock().await;
            if guard
                .get(&key)
                .is_some_and(|current| std::sync::Arc::ptr_eq(current, &server))
            {
                guard.remove(&key);
            }
            continue;
        }

        push_debug_event(
            "app.server.spawn.requested",
            serde_json::json!({
                "home": key,
                "method": method,
                "threadId": thread_id,
            }),
        )
        .await;
        let spawned = AppServer::spawn(if key.is_empty() {
            None
        } else {
            Some(key.as_str())
        })
        .await?;
        let spawned_arc = std::sync::Arc::new(Mutex::new(spawned));
        let mut guard = lock.lock().await;
        let entry = guard
            .entry(key.clone())
            .or_insert_with(|| spawned_arc.clone())
            .clone();
        break entry;
    };

    let mut server = server_arc.lock().await;
    match server.request(method, params).await {
        Ok(result) => {
            push_debug_event(
                "app.request.ok",
                serde_json::json!({
                    "home": home,
                    "method": method,
                    "threadId": thread_id,
                }),
            )
            .await;
            Ok(result)
        }
        Err(e) => {
            let lower = e.to_ascii_lowercase();
            let should_respawn = lower.contains("closed")
                || lower.contains("exited")
                || lower.contains("missing result")
                || lower.contains("failed to open codex stdin")
                || lower.contains("failed to open codex stdout");
            if should_respawn {
                let mut guard = lock.lock().await;
                if guard
                    .get(&key)
                    .is_some_and(|current| std::sync::Arc::ptr_eq(current, &server_arc))
                {
                    guard.remove(&key);
                }
            }
            push_debug_event(
                "app.request.error",
                serde_json::json!({
                    "home": home,
                    "method": method,
                    "threadId": thread_id,
                    "message": e.clone(),
                    "respawn": should_respawn,
                }),
            )
            .await;
            Err(e)
        }
    }
}

pub async fn request(method: &str, params: Value) -> Result<Value, String> {
    request_in_home(None, method, params).await
}

pub fn open_external_url(url: &str) -> Result<(), String> {
    open::that(url).map_err(|e| e.to_string())
}
