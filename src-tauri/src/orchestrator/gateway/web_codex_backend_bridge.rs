use super::*;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Multipart, Query};
use futures_util::StreamExt;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;

use crate::orchestrator::gateway::web_codex_auth::{
    api_error, api_error_detail, is_codex_ws_authorized, require_codex_auth, WsQuery,
};
use crate::orchestrator::gateway::web_codex_home::parse_workspace_target;
use crate::orchestrator::gateway::web_codex_storage::{
    append_codex_live_trace_entry, codex_attachments_dir, sanitize_name,
};
use crate::platform::git_layout::resolve_git_dir;
use std::path::{Path, PathBuf};

static NEXT_BACKEND_UPLOAD_ID: AtomicU64 = AtomicU64::new(1);
static BACKEND_SHARED_OBJECTS: OnceLock<Mutex<HashMap<String, Value>>> = OnceLock::new();
static BACKEND_SHARED_OBJECT_SUBSCRIPTIONS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
static BACKEND_GLOBAL_STATE: OnceLock<Mutex<HashMap<String, Value>>> = OnceLock::new();
static BACKEND_PERSISTED_ATOMS: OnceLock<Mutex<HashMap<String, Value>>> = OnceLock::new();

#[derive(Serialize)]
struct BackendUploadFile {
    label: String,
    path: String,
    #[serde(rename = "fsPath")]
    fs_path: String,
}

#[derive(Serialize)]
struct BackendUploadResponse {
    files: Vec<BackendUploadFile>,
}

#[derive(Deserialize)]
#[serde(tag = "type")]
enum RendererToMainMessage {
    #[serde(rename = "ipc-renderer-invoke")]
    Invoke {
        #[serde(rename = "requestId")]
        request_id: String,
        channel: String,
        args: Vec<Value>,
    },
    #[serde(rename = "ipc-renderer-send")]
    Send { channel: String, args: Vec<Value> },
    #[serde(rename = "workspace-directory-entries-request")]
    WorkspaceDirectoryEntriesRequest {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "directoryPath")]
        directory_path: Option<String>,
        #[serde(rename = "directoriesOnly")]
        directories_only: bool,
    },
}

#[derive(Serialize, Debug)]
#[serde(tag = "type")]
enum MainToRendererMessage {
    #[serde(rename = "ipc-main-event")]
    IpcMainEvent { channel: String, args: Vec<Value> },
    #[serde(rename = "ipc-renderer-invoke-result")]
    InvokeResult {
        #[serde(rename = "requestId")]
        request_id: String,
        ok: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        result: Option<Value>,
        #[serde(rename = "errorMessage", skip_serializing_if = "Option::is_none")]
        error_message: Option<String>,
    },
    #[serde(rename = "workspace-directory-entries-result")]
    WorkspaceDirectoryEntriesResult {
        #[serde(rename = "requestId")]
        request_id: String,
        ok: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        result: Option<Value>,
        #[serde(rename = "errorMessage", skip_serializing_if = "Option::is_none")]
        error_message: Option<String>,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceDirectoryEntry {
    name: String,
    path: String,
    #[serde(rename = "type")]
    entry_type: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceDirectoryEntries {
    directory_path: String,
    parent_path: Option<String>,
    entries: Vec<WorkspaceDirectoryEntry>,
}

#[derive(Default)]
struct BackendInvokeOutcome {
    result: Value,
    follow_up_events: Vec<MainToRendererMessage>,
}

#[derive(Deserialize)]
#[serde(tag = "type")]
enum ViewToBackendMessage {
    #[serde(rename = "fetch")]
    Fetch {
        #[serde(rename = "requestId")]
        request_id: String,
        method: String,
        url: String,
        headers: Option<HashMap<String, String>>,
        body: Option<String>,
    },
    #[serde(rename = "fetch-stream")]
    FetchStream {
        #[serde(rename = "requestId")]
        request_id: String,
        #[allow(dead_code)]
        method: String,
        url: String,
        #[allow(dead_code)]
        body: Option<String>,
    },
    #[serde(rename = "cancel-fetch")]
    CancelFetch {
        #[serde(rename = "requestId")]
        #[allow(dead_code)]
        request_id: String,
    },
    #[serde(rename = "cancel-fetch-stream")]
    CancelFetchStream {
        #[serde(rename = "requestId")]
        #[allow(dead_code)]
        request_id: String,
    },
    #[serde(rename = "shared-object-set")]
    SharedObjectSet { key: String, value: Value },
    #[serde(rename = "shared-object-subscribe")]
    SharedObjectSubscribe { key: String },
    #[serde(rename = "shared-object-unsubscribe")]
    SharedObjectUnsubscribe { key: String },
    #[serde(rename = "mcp-request")]
    McpRequest {
        #[serde(rename = "hostId")]
        host_id: Option<String>,
        request: Value,
    },
    #[serde(rename = "open-in-browser")]
    OpenInBrowser {
        #[allow(dead_code)]
        url: String,
    },
    #[serde(rename = "log-message")]
    LogMessage,
}

#[derive(Serialize)]
#[serde(tag = "type")]
enum BackendViewEvent {
    #[serde(rename = "fetch-response")]
    FetchResponseSuccess {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "responseType")]
        response_type: &'static str,
        status: u16,
        headers: HashMap<String, String>,
        #[serde(rename = "bodyJsonString")]
        body_json_string: String,
    },
    #[serde(rename = "fetch-response")]
    FetchResponseError {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "responseType")]
        response_type: &'static str,
        status: u16,
        error: String,
    },
    #[serde(rename = "fetch-stream-error")]
    FetchStreamError {
        #[serde(rename = "requestId")]
        request_id: String,
        error: String,
    },
    #[serde(rename = "fetch-stream-event")]
    FetchStreamEvent {
        #[serde(rename = "requestId")]
        request_id: String,
        event: Option<String>,
        data: Value,
    },
    #[serde(rename = "fetch-stream-complete")]
    FetchStreamComplete {
        #[serde(rename = "requestId")]
        request_id: String,
    },
    #[serde(rename = "shared-object-updated")]
    SharedObjectUpdated { key: String, value: Value },
}

pub(super) async fn codex_backend_ipc_ws(
    State(st): State<GatewayState>,
    headers: HeaderMap,
    Query(query): Query<WsQuery>,
    ws: WebSocketUpgrade,
) -> Response {
    if !is_codex_ws_authorized(&st, &headers, &query) {
        return api_error(StatusCode::UNAUTHORIZED, "invalid token");
    }
    ws.on_upgrade(move |socket| codex_backend_ipc_ws_loop(socket, st))
}

async fn codex_backend_ipc_ws_loop(mut socket: WebSocket, st: GatewayState) {
    while let Some(incoming) = socket.next().await {
        let Ok(message) = incoming else {
            return;
        };
        match message {
            Message::Text(text) => {
                let parsed = match serde_json::from_str::<RendererToMainMessage>(&text) {
                    Ok(value) => value,
                    Err(error) => {
                        let _ = socket
                            .send(Message::Text(
                                serde_json::to_string(&MainToRendererMessage::InvokeResult {
                                    request_id: String::new(),
                                    ok: false,
                                    result: None,
                                    error_message: Some(error.to_string()),
                                })
                                .unwrap_or_else(|_| {
                                    "{\"type\":\"ipc-renderer-invoke-result\",\"ok\":false}"
                                        .to_string()
                                }),
                            ))
                            .await;
                        continue;
                    }
                };
                if !handle_backend_ipc_message(&mut socket, &st, parsed).await {
                    return;
                }
            }
            Message::Ping(payload) => {
                if socket.send(Message::Pong(payload)).await.is_err() {
                    return;
                }
            }
            Message::Close(_) => return,
            Message::Binary(_) | Message::Pong(_) => {}
        }
    }
}

async fn handle_backend_ipc_message(
    socket: &mut WebSocket,
    _st: &GatewayState,
    message: RendererToMainMessage,
) -> bool {
    match message {
        RendererToMainMessage::Invoke {
            request_id,
            channel,
            args,
        } => {
            let outcome = match handle_backend_ipc_invoke(channel.as_str(), &args).await {
                Ok(outcome) => outcome,
                Err(error) => {
                    return send_backend_ipc_json(
                        socket,
                        &MainToRendererMessage::InvokeResult {
                            request_id,
                            ok: false,
                            result: None,
                            error_message: Some(error),
                        },
                    )
                    .await
                }
            };
            let response = MainToRendererMessage::InvokeResult {
                request_id,
                ok: true,
                result: Some(outcome.result),
                error_message: None,
            };
            if !send_backend_ipc_json(socket, &response).await {
                return false;
            }
            for event in outcome.follow_up_events {
                if !send_backend_ipc_json(socket, &event).await {
                    return false;
                }
            }
            true
        }
        RendererToMainMessage::Send { channel, args } => {
            let outcome = match handle_backend_ipc_send(channel.as_str(), &args) {
                Ok(outcome) => outcome,
                Err(error) => {
                    trace_backend_send_error(channel.as_str(), error.as_str());
                    return true;
                }
            };
            for event in outcome.follow_up_events {
                if !send_backend_ipc_json(socket, &event).await {
                    return false;
                }
            }
            true
        }
        RendererToMainMessage::WorkspaceDirectoryEntriesRequest {
            request_id,
            directory_path,
            directories_only,
        } => {
            let response =
                match list_workspace_directory_entries(directory_path.as_deref(), directories_only)
                {
                    Ok(result) => MainToRendererMessage::WorkspaceDirectoryEntriesResult {
                        request_id,
                        ok: true,
                        result: Some(json!(result)),
                        error_message: None,
                    },
                    Err(error) => MainToRendererMessage::WorkspaceDirectoryEntriesResult {
                        request_id,
                        ok: false,
                        result: None,
                        error_message: Some(error),
                    },
                };
            send_backend_ipc_json(socket, &response).await
        }
    }
}

async fn send_backend_ipc_json(socket: &mut WebSocket, message: &MainToRendererMessage) -> bool {
    let Ok(text) = serde_json::to_string(message) else {
        return false;
    };
    socket.send(Message::Text(text)).await.is_ok()
}

async fn handle_backend_ipc_invoke(
    channel: &str,
    args: &[Value],
) -> Result<BackendInvokeOutcome, String> {
    match channel {
        "codex_desktop:message-from-view" => handle_message_from_view(args).await,
        "codex_desktop:show-context-menu" => Ok(BackendInvokeOutcome::default()),
        "codex_desktop:show-application-menu" => Ok(BackendInvokeOutcome::default()),
        "codex_desktop:get-fast-mode-rollout-metrics" => Ok(BackendInvokeOutcome {
            result: json!({
            "enabled": false,
            "sampleRate": 0,
            "bucket": "control"
            }),
            follow_up_events: Vec::new(),
        }),
        "codex_desktop:trigger-sentry-test" => Ok(BackendInvokeOutcome::default()),
        other if other.starts_with("codex_desktop:worker:") && other.ends_with(":from-view") => {
            handle_worker_message_from_view(other, args).await
        }
        other => Err(format!("unsupported ipc channel: {other}")),
    }
}

fn handle_backend_ipc_send(channel: &str, args: &[Value]) -> Result<BackendInvokeOutcome, String> {
    match channel {
        "codex_desktop:message-from-view" => handle_send_message_from_view(args),
        _ => Ok(BackendInvokeOutcome::default()),
    }
}

fn trace_backend_send_error(channel: &str, error: &str) {
    let _ =
        crate::orchestrator::gateway::web_codex_storage::append_codex_live_trace_entry(&json!({
            "source": "codex_backend_ipc",
            "entry": {
                "at": crate::orchestrator::store::unix_ms(),
                "kind": "backend_ipc.send_error",
                "channel": channel,
                "error": error,
            }
        }));
}

fn parse_worker_id_from_channel(channel: &str) -> Option<&str> {
    channel
        .strip_prefix("codex_desktop:worker:")
        .and_then(|value| value.strip_suffix(":from-view"))
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn normalize_worker_root(params: &Value) -> Result<PathBuf, String> {
    let cwd = params
        .get("cwd")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "missing git worker cwd".to_string())?;
    let root = params
        .get("root")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(cwd);
    Ok(PathBuf::from(root))
}

fn git_stable_metadata(params: &Value) -> Result<Value, String> {
    let root = normalize_worker_root(params)?;
    let root = std::fs::canonicalize(&root).unwrap_or(root);
    let git_dir = resolve_git_dir(&root);
    let common_dir = git_dir
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| git_dir.clone());
    Ok(json!({
        "root": root.to_string_lossy().to_string(),
        "commonDir": common_dir.to_string_lossy().to_string(),
        "gitDir": git_dir.to_string_lossy().to_string(),
    }))
}

fn git_worker_response(
    worker_id: &str,
    request: &Value,
    result: Result<Value, String>,
) -> Result<MainToRendererMessage, String> {
    let method = request
        .get("method")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| "missing worker request method".to_string())?;
    let id = request
        .get("id")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| "missing worker request id".to_string())?;
    let response = match result {
        Ok(value) => json!({
            "type": "worker-response",
            "workerId": worker_id,
            "response": {
                "id": id,
                "method": method,
                "result": {
                    "type": "ok",
                    "value": value,
                }
            }
        }),
        Err(error) => json!({
            "type": "worker-response",
            "workerId": worker_id,
            "response": {
                "id": id,
                "method": method,
                "result": {
                    "type": "error",
                    "error": {
                        "message": error,
                    }
                }
            }
        }),
    };
    Ok(MainToRendererMessage::IpcMainEvent {
        channel: "codex_desktop:message-for-view".to_string(),
        args: vec![response],
    })
}

async fn handle_worker_message_from_view(
    channel: &str,
    args: &[Value],
) -> Result<BackendInvokeOutcome, String> {
    let worker_id = parse_worker_id_from_channel(channel)
        .ok_or_else(|| format!("invalid worker bridge channel: {channel}"))?;
    let message = args
        .first()
        .cloned()
        .ok_or_else(|| "missing worker bridge payload".to_string())?;
    let message_type = message
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    match message_type {
        "worker-request-cancel" => Ok(BackendInvokeOutcome::default()),
        "worker-request" => {
            let request = message
                .get("request")
                .cloned()
                .ok_or_else(|| "missing worker request".to_string())?;
            let method = request
                .get("method")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let params = request.get("params").cloned().unwrap_or(Value::Null);
            let result = match (worker_id, method) {
                ("git", "stable-metadata") => git_stable_metadata(&params),
                ("git", "watch-repo") => Ok(json!(null)),
                ("git", "unwatch-repo") => Ok(json!(null)),
                _ => Err(format!("unsupported worker request: {worker_id}/{method}")),
            };
            Ok(BackendInvokeOutcome {
                result: Value::Null,
                follow_up_events: vec![git_worker_response(worker_id, &request, result)?],
            })
        }
        _ => Err(format!("unsupported worker message type: {message_type}")),
    }
}

fn shared_object_store() -> &'static Mutex<HashMap<String, Value>> {
    BACKEND_SHARED_OBJECTS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn shared_object_subscriptions() -> &'static Mutex<HashSet<String>> {
    BACKEND_SHARED_OBJECT_SUBSCRIPTIONS.get_or_init(|| Mutex::new(HashSet::new()))
}

fn global_state_store() -> &'static Mutex<HashMap<String, Value>> {
    BACKEND_GLOBAL_STATE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn persisted_atom_store() -> &'static Mutex<HashMap<String, Value>> {
    BACKEND_PERSISTED_ATOMS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn parse_view_method(url: &str) -> Result<&str, String> {
    let prefix = "vscode://codex/";
    let trimmed = url.trim();
    trimmed
        .strip_prefix(prefix)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("unsupported vscode bridge url: {url}"))
}

fn is_external_http_url(url: &str) -> bool {
    let trimmed = url.trim();
    trimmed.starts_with("https://") || trimmed.starts_with("http://")
}

fn local_external_fetch_response(url: &str) -> Option<Value> {
    let trimmed = url.trim();
    if trimmed.starts_with("https://ab.chatgpt.com/v1/initialize") {
        return Some(json!({
            "feature_gates": {},
            "dynamic_configs": {},
            "layer_configs": {},
            "param_stores": {},
            "values": {},
            "exposures": {},
            "has_updates": true,
            "time": crate::orchestrator::store::unix_ms()
        }));
    }
    if trimmed.starts_with("https://ab.chatgpt.com/v1/rgstr")
        || trimmed.starts_with("https://chatgpt.com/ces/v1/rgstr")
    {
        return Some(json!({ "success": true }));
    }
    None
}

fn local_bridge_response_for_fetch_url(
    url: &str,
    _params: &Value,
) -> Option<Result<Value, String>> {
    match url.trim() {
        "/wham/accounts/check" => Some(Ok(json!({
            "account_ordering": ["local-account"],
            "accounts": [
                {
                    "id": "local-account",
                    "name": "Local account",
                    "status": "active"
                }
            ]
        }))),
        "/wham/usage" => Some(Ok(json!({}))),
        _ => None,
    }
}

fn parse_view_body(body: Option<&str>) -> Result<Value, String> {
    let Some(body) = body.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(Value::Null);
    };
    serde_json::from_str(body).map_err(|error| error.to_string())
}

fn trace_backend_bridge(kind: &str, entry: Value) {
    let _ = append_codex_live_trace_entry(&json!({
        "source": "web_codex_backend_bridge",
        "entry": {
            "at": crate::orchestrator::store::unix_ms(),
            "kind": kind,
            "data": entry,
        }
    }));
}

fn value_object_keys(value: &Value) -> Vec<String> {
    value
        .as_object()
        .map(|object| object.keys().take(12).cloned().collect())
        .unwrap_or_default()
}

fn local_bridge_response_for_method(
    rpc_method: &str,
    params: &Value,
) -> Option<Result<Value, String>> {
    match rpc_method {
        "ipc-request" => Some(local_ipc_request_response(params)),
        "list-pinned-threads" => Some(Ok(json!({
            "items": [],
        }))),
        "extension-info" => Some(Ok(json!({
            "id": "api-router.codex-web",
            "name": "API Router Codex Web",
            "version": "0.4.0",
        }))),
        "os-info" => Some(Ok(json!({
            "platform": "win32",
            "arch": std::env::consts::ARCH,
            "homedir": std::env::var("USERPROFILE")
                .ok()
                .or_else(|| std::env::var("HOME").ok())
                .unwrap_or_default(),
        }))),
        "is-copilot-api-available" => Some(Ok(json!({
            "available": false,
        }))),
        "get-configuration" => Some(Ok(json!({
            "value": local_configuration_value(params
                .get("key")
                .and_then(Value::as_str)
                .unwrap_or_default()),
        }))),
        "workspace-root-options" => Some(Ok(json!({
            "roots": [current_workspace_root_string()],
            "labels": {},
        }))),
        "active-workspace-roots" => Some(Ok(json!({
            "roots": [current_workspace_root_string()],
        }))),
        "git-origins" => Some(Ok(json!({
            "origins": [],
        }))),
        "codex-home" => Some(Ok(json!({
            "codexHome": codex_home_string(),
        }))),
        "get-global-state" => {
            let key = params
                .get("key")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "missing global state key".to_string());
            Some(key.map(|key| {
                let value = global_state_store()
                    .lock()
                    .get(key)
                    .cloned()
                    .unwrap_or(Value::Null);
                json!({ "value": value })
            }))
        }
        "set-global-state" => {
            let key = params
                .get("key")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "missing global state key".to_string());
            Some(key.map(|key| {
                let value = params.get("value").cloned().unwrap_or(Value::Null);
                global_state_store().lock().insert(key.to_string(), value);
                json!({ "ok": true })
            }))
        }
        _ => None,
    }
}

fn current_workspace_root_string() -> String {
    std::env::current_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .to_string_lossy()
        .to_string()
}

fn codex_home_string() -> String {
    std::env::var("CODEX_HOME")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| {
            let home = std::env::var("USERPROFILE")
                .ok()
                .or_else(|| std::env::var("HOME").ok())
                .unwrap_or_else(current_workspace_root_string);
            PathBuf::from(home)
                .join(".codex")
                .to_string_lossy()
                .to_string()
        })
}

fn local_configuration_value(key: &str) -> Value {
    match key {
        "dictation_dictionary" | "DICTATION_DICTIONARY" => json!([]),
        _ => Value::Null,
    }
}

fn local_ipc_request_response(params: &Value) -> Result<Value, String> {
    let method = params
        .get("method")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "missing ipc request method".to_string())?;
    let result = match method {
        "app-server-connection-state" => json!({
            "state": "connected",
            "error": null,
        }),
        "thread-follower-command-approval-decision"
        | "thread-follower-file-approval-decision"
        | "thread-follower-permissions-request-approval-response"
        | "thread-follower-submit-user-input"
        | "thread-follower-submit-mcp-server-elicitation-response"
        | "thread-follower-set-collaboration-mode" => Value::Null,
        other => {
            trace_backend_bridge(
                "ipc.unsupported",
                json!({
                    "method": other,
                    "paramKeys": value_object_keys(params.get("params").unwrap_or(&Value::Null)),
                }),
            );
            return Ok(json!({
                "requestId": "",
                "type": "response",
                "resultType": "error",
                "error": format!("unsupported ipc request: {other}"),
            }));
        }
    };
    Ok(json!({
        "requestId": "",
        "type": "response",
        "resultType": "success",
        "result": result,
    }))
}

fn local_app_server_response_for_method(
    method: &str,
    params: &Value,
) -> Option<Result<Value, String>> {
    match method {
        "config/read" => Some(Ok(json!({
            "config": {
                "model": null,
                "model_reasoning_effort": null,
                "profile": null,
                "profiles": {},
                "projects": {},
                "model_providers": {},
                "approval_policy": null,
                "sandbox_mode": null,
                "disable_response_storage": false,
                "notify": [],
                "mcp_servers": {},
                "tools": {},
                "hide_agent_reasoning": false,
                "show_raw_agent_reasoning": false,
                "model_supports_reasoning_summaries": true
            }
        }))),
        "configRequirements/read" => Some(Ok(json!({
            "requirements": []
        }))),
        "thread/list" => Some(Ok(json!({
            "data": [],
            "nextCursor": null
        }))),
        "model/list" => Some(Ok(json!({
            "data": [
                {
                    "model": "gpt-5.3-codex",
                    "displayName": "GPT-5.3 Codex",
                    "provider": "openai",
                    "hidden": false,
                    "isDefault": true,
                    "defaultReasoningEffort": "medium",
                    "supportedReasoningEfforts": [
                        { "reasoningEffort": "low", "description": "Low reasoning" },
                        { "reasoningEffort": "medium", "description": "Medium reasoning" },
                        { "reasoningEffort": "high", "description": "High reasoning" },
                        { "reasoningEffort": "xhigh", "description": "Extra high reasoning" }
                    ]
                }
            ],
            "nextCursor": null
        }))),
        "collaborationMode/list" => Some(Ok(json!({
            "items": []
        }))),
        "mcpServerStatus/list" => Some(Ok(json!({
            "items": []
        }))),
        "plugin/list" => Some(Ok(json!({
            "items": []
        }))),
        "app/list" => Some(Ok(json!({
            "data": []
        }))),
        "experimentalFeature/list" => Some(Ok(json!({
            "features": []
        }))),
        "skills/list" => Some(Ok(json!({
            "data": []
        }))),
        _ => {
            let _ = params;
            None
        }
    }
}

fn mcp_response_event(
    host_id: Option<String>,
    request_id: String,
    result: Value,
) -> MainToRendererMessage {
    backend_view_message_event(json!({
        "type": "mcp-response",
        "hostId": host_id.unwrap_or_else(|| "local".to_string()),
        "message": {
            "id": request_id,
            "result": result,
        }
    }))
}

fn mcp_error_event(
    host_id: Option<String>,
    request_id: String,
    error: String,
) -> MainToRendererMessage {
    backend_view_message_event(json!({
        "type": "mcp-response",
        "hostId": host_id.unwrap_or_else(|| "local".to_string()),
        "message": {
            "id": request_id,
            "error": error,
        }
    }))
}

fn backend_view_event_message(event: BackendViewEvent) -> Result<MainToRendererMessage, String> {
    let payload = serde_json::to_value(event).map_err(|error| error.to_string())?;
    Ok(MainToRendererMessage::IpcMainEvent {
        channel: "codex_desktop:message-for-view".to_string(),
        args: vec![payload],
    })
}

fn backend_fetch_success_event(
    request_id: String,
    body: Value,
) -> Result<MainToRendererMessage, String> {
    let mut headers = HashMap::new();
    headers.insert("content-type".to_string(), "application/json".to_string());
    backend_view_event_message(BackendViewEvent::FetchResponseSuccess {
        request_id,
        response_type: "success",
        status: 200,
        headers,
        body_json_string: serde_json::to_string(&body).map_err(|error| error.to_string())?,
    })
}

fn backend_fetch_error_event(
    request_id: String,
    status: u16,
    error: String,
) -> Result<MainToRendererMessage, String> {
    backend_view_event_message(BackendViewEvent::FetchResponseError {
        request_id,
        response_type: "error",
        status,
        error,
    })
}

async fn proxy_external_fetch(
    request_id: String,
    method: String,
    url: String,
    headers: Option<HashMap<String, String>>,
    body: Option<String>,
) -> Result<BackendInvokeOutcome, String> {
    if let Some(body) = local_external_fetch_response(&url) {
        return Ok(BackendInvokeOutcome {
            result: Value::Null,
            follow_up_events: vec![backend_fetch_success_event(request_id, body)?],
        });
    }
    let method = reqwest::Method::from_bytes(method.trim().as_bytes())
        .map_err(|error| format!("invalid fetch method: {error}"))?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(12))
        .build()
        .map_err(|error| error.to_string())?;
    let mut request = client.request(method, url.trim());
    if let Some(headers) = headers {
        for (name, value) in headers {
            if let Ok(header_name) = reqwest::header::HeaderName::from_bytes(name.as_bytes()) {
                if let Ok(header_value) = reqwest::header::HeaderValue::from_str(&value) {
                    request = request.header(header_name, header_value);
                }
            }
        }
    }
    if let Some(body) = body {
        request = request.body(body);
    }
    let response = match request.send().await {
        Ok(response) => response,
        Err(error) => {
            return Ok(BackendInvokeOutcome {
                result: Value::Null,
                follow_up_events: vec![backend_fetch_error_event(
                    request_id,
                    502,
                    error.to_string(),
                )?],
            })
        }
    };
    let status = response.status().as_u16();
    let mut response_headers = HashMap::new();
    for (name, value) in response.headers() {
        if let Ok(value) = value.to_str() {
            response_headers.insert(name.as_str().to_string(), value.to_string());
        }
    }
    let text = response.text().await.map_err(|error| error.to_string())?;
    let body = serde_json::from_str::<Value>(&text).unwrap_or(Value::String(text));
    Ok(BackendInvokeOutcome {
        result: Value::Null,
        follow_up_events: vec![backend_view_event_message(
            BackendViewEvent::FetchResponseSuccess {
                request_id,
                response_type: "success",
                status,
                headers: response_headers,
                body_json_string: serde_json::to_string(&body)
                    .map_err(|error| error.to_string())?,
            },
        )?],
    })
}

fn backend_shared_object_updated_event(
    key: String,
    value: Value,
) -> Result<MainToRendererMessage, String> {
    backend_view_event_message(BackendViewEvent::SharedObjectUpdated { key, value })
}

fn backend_view_message_event(payload: Value) -> MainToRendererMessage {
    MainToRendererMessage::IpcMainEvent {
        channel: "codex_desktop:message-for-view".to_string(),
        args: vec![payload],
    }
}

fn persisted_atom_sync_event() -> MainToRendererMessage {
    let state = persisted_atom_store().lock().clone();
    backend_view_message_event(json!({
        "type": "persisted-atom-sync",
        "state": state,
    }))
}

fn persisted_atom_updated_event(key: String, value: Value, deleted: bool) -> MainToRendererMessage {
    backend_view_message_event(json!({
        "type": "persisted-atom-updated",
        "key": key,
        "value": value,
        "deleted": deleted,
    }))
}

fn backend_fetch_stream_event(
    request_id: String,
    event: Option<String>,
    data: Value,
) -> Result<MainToRendererMessage, String> {
    backend_view_event_message(BackendViewEvent::FetchStreamEvent {
        request_id,
        event,
        data,
    })
}

fn backend_fetch_stream_complete_event(
    request_id: String,
) -> Result<MainToRendererMessage, String> {
    backend_view_event_message(BackendViewEvent::FetchStreamComplete { request_id })
}

fn parse_sse_event_block(block: &str) -> Result<Option<(Option<String>, Value)>, String> {
    let trimmed = block.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    let mut event_name: Option<String> = None;
    let mut data_lines = Vec::new();
    for line in trimmed.lines() {
        if let Some(rest) = line.strip_prefix("event:") {
            let value = rest.trim();
            if !value.is_empty() {
                event_name = Some(value.to_string());
            }
            continue;
        }
        if let Some(rest) = line.strip_prefix("data:") {
            data_lines.push(rest.trim().to_string());
        }
    }
    if data_lines.is_empty() {
        return Ok(None);
    }
    let joined = data_lines.join("\n");
    let data = serde_json::from_str(&joined).unwrap_or(Value::String(joined));
    Ok(Some((event_name, data)))
}

fn parse_sse_events(body: &str) -> Result<Vec<(Option<String>, Value)>, String> {
    let normalized = body.replace("\r\n", "\n");
    let mut events = Vec::new();
    for block in normalized.split("\n\n") {
        if let Some(event) = parse_sse_event_block(block)? {
            events.push(event);
        }
    }
    Ok(events)
}

fn encode_sse_event(name: &str, value: &Value) -> String {
    format!("event: {name}\ndata: {}\n\n", value)
}

async fn handle_message_from_view(args: &[Value]) -> Result<BackendInvokeOutcome, String> {
    let payload = args
        .first()
        .cloned()
        .ok_or_else(|| "missing message-from-view payload".to_string())?;
    let message: ViewToBackendMessage =
        serde_json::from_value(payload).map_err(|error| error.to_string())?;
    match message {
        ViewToBackendMessage::Fetch {
            request_id,
            method,
            url,
            headers,
            body,
        } => {
            trace_backend_bridge(
                "fetch.request",
                json!({
                    "requestId": &request_id,
                    "method": &method,
                    "url": &url,
                }),
            );
            if is_external_http_url(&url) {
                return proxy_external_fetch(request_id, method, url, headers, body).await;
            }
            let params = parse_view_body(body.as_deref())?;
            if let Some(result) = local_bridge_response_for_fetch_url(&url, &params) {
                return match result {
                    Ok(value) => {
                        trace_backend_bridge(
                            "fetch.local_response",
                            json!({
                                "requestId": &request_id,
                                "url": &url,
                                "resultKeys": value_object_keys(&value),
                            }),
                        );
                        Ok(BackendInvokeOutcome {
                            result: Value::Null,
                            follow_up_events: vec![backend_fetch_success_event(request_id, value)?],
                        })
                    }
                    Err(error) => Ok(BackendInvokeOutcome {
                        result: Value::Null,
                        follow_up_events: vec![backend_fetch_error_event(request_id, 400, error)?],
                    }),
                };
            }
            let rpc_method = parse_view_method(&url)?;
            if let Some(result) = local_bridge_response_for_method(rpc_method, &params) {
                return match result {
                    Ok(value) => {
                        trace_backend_bridge(
                            "fetch.local_response",
                            json!({
                                "requestId": &request_id,
                                "rpcMethod": rpc_method,
                                "resultKeys": value_object_keys(&value),
                            }),
                        );
                        Ok(BackendInvokeOutcome {
                            result: Value::Null,
                            follow_up_events: vec![backend_fetch_success_event(request_id, value)?],
                        })
                    }
                    Err(error) => Ok(BackendInvokeOutcome {
                        result: Value::Null,
                        follow_up_events: vec![backend_fetch_error_event(request_id, 400, error)?],
                    }),
                };
            }
            let workspace_target = params
                .get("workspace")
                .and_then(Value::as_str)
                .and_then(parse_workspace_target);
            let home = crate::orchestrator::gateway::web_codex_home::web_codex_rpc_home_override_for_target(workspace_target);
            match crate::codex_app_server::request_in_home(home.as_deref(), rpc_method, params)
                .await
            {
                Ok(result) => {
                    trace_backend_bridge(
                        "fetch.app_server_response",
                        json!({
                            "requestId": &request_id,
                            "rpcMethod": rpc_method,
                            "resultKeys": value_object_keys(&result),
                        }),
                    );
                    Ok(BackendInvokeOutcome {
                        result: Value::Null,
                        follow_up_events: vec![backend_fetch_success_event(request_id, result)?],
                    })
                }
                Err(error) => Ok(BackendInvokeOutcome {
                    result: Value::Null,
                    follow_up_events: vec![backend_fetch_error_event(request_id, 502, error)?],
                }),
            }
        }
        ViewToBackendMessage::FetchStream {
            request_id,
            method,
            url,
            body,
        } => {
            let rpc_method = parse_view_method(&url)?;
            if rpc_method != "turn/stream" {
                return Ok(BackendInvokeOutcome {
                    result: Value::Null,
                    follow_up_events: vec![backend_view_event_message(
                        BackendViewEvent::FetchStreamError {
                            request_id,
                            error: format!("stream bridge not implemented for {url}"),
                        },
                    )?],
                });
            }
            if !method.eq_ignore_ascii_case("POST") {
                return Ok(BackendInvokeOutcome {
                    result: Value::Null,
                    follow_up_events: vec![backend_view_event_message(
                        BackendViewEvent::FetchStreamError {
                            request_id,
                            error: format!("unsupported stream method: {method}"),
                        },
                    )?],
                });
            }
            let payload = parse_view_body(body.as_deref())?;
            let req: crate::orchestrator::gateway::web_codex_actions::TurnStartRequest =
                serde_json::from_value(payload).map_err(|error| error.to_string())?;
            let thread_id = crate::orchestrator::gateway::web_codex_actions::turn_thread_id(&req)
                .ok_or_else(|| "threadId is required".to_string())?
                .to_string();
            let workspace_target = req.workspace.as_deref().and_then(parse_workspace_target);
            let params = crate::orchestrator::gateway::web_codex_actions::build_turn_start_params(
                &thread_id, &req,
            );
            let manager =
                crate::orchestrator::gateway::web_codex_session_manager::CodexSessionManager::new(
                    workspace_target,
                );
            let response = manager
                .turn_start(&thread_id, params)
                .await
                .map(|outcome| {
                    crate::orchestrator::gateway::web_codex_actions::build_turn_start_response(
                        &thread_id,
                        outcome.result,
                        outcome.rollout_path.as_deref(),
                    )
                })
                .map_err(|error| error.to_string())?;

            let sse_body = format!(
                "{}{}",
                encode_sse_event("started", &json!({ "ok": true, "threadId": thread_id })),
                encode_sse_event("completed", &response)
            );
            let mut follow_up_events = Vec::new();
            for (event, data) in parse_sse_events(&sse_body)? {
                follow_up_events.push(backend_fetch_stream_event(request_id.clone(), event, data)?);
            }
            follow_up_events.push(backend_fetch_stream_complete_event(request_id)?);
            Ok(BackendInvokeOutcome {
                result: Value::Null,
                follow_up_events,
            })
        }
        ViewToBackendMessage::CancelFetch { request_id: _ } => Ok(BackendInvokeOutcome::default()),
        ViewToBackendMessage::CancelFetchStream { request_id: _ } => {
            Ok(BackendInvokeOutcome::default())
        }
        ViewToBackendMessage::SharedObjectSet { key, value } => {
            shared_object_store()
                .lock()
                .insert(key.clone(), value.clone());
            let subscribed = shared_object_subscriptions().lock().contains(&key);
            Ok(BackendInvokeOutcome {
                result: Value::Null,
                follow_up_events: if subscribed {
                    vec![backend_shared_object_updated_event(key, value)?]
                } else {
                    Vec::new()
                },
            })
        }
        ViewToBackendMessage::SharedObjectSubscribe { key } => {
            shared_object_subscriptions().lock().insert(key.clone());
            let existing = shared_object_store().lock().get(&key).cloned();
            Ok(BackendInvokeOutcome {
                result: Value::Null,
                follow_up_events: existing
                    .map(|value| backend_shared_object_updated_event(key, value))
                    .transpose()?
                    .into_iter()
                    .collect(),
            })
        }
        ViewToBackendMessage::SharedObjectUnsubscribe { key } => {
            shared_object_subscriptions().lock().remove(&key);
            Ok(BackendInvokeOutcome::default())
        }
        ViewToBackendMessage::McpRequest { host_id, request } => {
            let request_id = request
                .get("id")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "missing mcp request id".to_string())?
                .to_string();
            let method = request
                .get("method")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "missing mcp request method".to_string())?;
            let params = request.get("params").cloned().unwrap_or(Value::Null);
            trace_backend_bridge(
                "mcp.request",
                json!({
                    "hostId": &host_id,
                    "requestId": &request_id,
                    "method": method,
                    "paramKeys": value_object_keys(&params),
                }),
            );
            if let Some(result) = local_app_server_response_for_method(method, &params) {
                return Ok(BackendInvokeOutcome {
                    result: Value::Null,
                    follow_up_events: vec![match result {
                        Ok(value) => {
                            trace_backend_bridge(
                                "mcp.local_response",
                                json!({
                                    "requestId": &request_id,
                                    "method": method,
                                    "resultKeys": value_object_keys(&value),
                                }),
                            );
                            mcp_response_event(host_id, request_id, value)
                        }
                        Err(error) => mcp_error_event(host_id, request_id, error),
                    }],
                });
            }
            let workspace_target = params
                .get("workspace")
                .and_then(Value::as_str)
                .and_then(parse_workspace_target);
            let home = crate::orchestrator::gateway::web_codex_home::web_codex_rpc_home_override_for_target(workspace_target);
            let event =
                match crate::codex_app_server::request_in_home(home.as_deref(), method, params)
                    .await
                {
                    Ok(result) => {
                        trace_backend_bridge(
                            "mcp.app_server_response",
                            json!({
                                "requestId": &request_id,
                                "method": method,
                                "resultKeys": value_object_keys(&result),
                            }),
                        );
                        mcp_response_event(host_id, request_id, result)
                    }
                    Err(error) => mcp_error_event(host_id, request_id, error.to_string()),
                };
            Ok(BackendInvokeOutcome {
                result: Value::Null,
                follow_up_events: vec![event],
            })
        }
        ViewToBackendMessage::OpenInBrowser { url: _ } => Ok(BackendInvokeOutcome::default()),
        ViewToBackendMessage::LogMessage => Ok(BackendInvokeOutcome::default()),
    }
}

fn handle_send_message_from_view(args: &[Value]) -> Result<BackendInvokeOutcome, String> {
    let payload = args
        .first()
        .cloned()
        .ok_or_else(|| "missing send message-from-view payload".to_string())?;
    let message_type = payload
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    match message_type {
        "persisted-atom-sync-request" => Ok(BackendInvokeOutcome {
            result: Value::Null,
            follow_up_events: vec![persisted_atom_sync_event()],
        }),
        "persisted-atom-update" => {
            let key = payload
                .get("key")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "missing persisted atom key".to_string())?
                .to_string();
            let deleted = payload
                .get("deleted")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let value = payload.get("value").cloned().unwrap_or(Value::Null);
            if deleted {
                persisted_atom_store().lock().remove(&key);
            } else {
                persisted_atom_store()
                    .lock()
                    .insert(key.clone(), value.clone());
            }
            Ok(BackendInvokeOutcome {
                result: Value::Null,
                follow_up_events: vec![persisted_atom_updated_event(key, value, deleted)],
            })
        }
        "ready" | "view-focused" | "log-message" => Ok(BackendInvokeOutcome::default()),
        _ => Ok(BackendInvokeOutcome::default()),
    }
}

fn list_workspace_directory_entries(
    directory_path: Option<&str>,
    directories_only: bool,
) -> Result<WorkspaceDirectoryEntries, String> {
    let requested = directory_path
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .unwrap_or_else(default_workspace_directory);
    let resolved = std::fs::canonicalize(&requested).map_err(|error| error.to_string())?;
    let metadata = std::fs::metadata(&resolved).map_err(|error| error.to_string())?;
    if !metadata.is_dir() {
        return Err(format!("directory not found: {requested}"));
    }
    let mut entries = Vec::new();
    let read_dir = std::fs::read_dir(&resolved).map_err(|error| error.to_string())?;
    for item in read_dir {
        let item = item.map_err(|error| error.to_string())?;
        let file_type = item.file_type().map_err(|error| error.to_string())?;
        let entry_type = if file_type.is_dir() {
            "directory"
        } else {
            "file"
        };
        if directories_only && entry_type != "directory" {
            continue;
        }
        entries.push(WorkspaceDirectoryEntry {
            name: item.file_name().to_string_lossy().to_string(),
            path: item.path().to_string_lossy().to_string(),
            entry_type,
        });
    }
    entries.sort_by(|left, right| {
        let left_rank = if left.entry_type == "directory" { 0 } else { 1 };
        let right_rank = if right.entry_type == "directory" {
            0
        } else {
            1
        };
        left_rank
            .cmp(&right_rank)
            .then_with(|| left.name.starts_with('.').cmp(&right.name.starts_with('.')))
            .then_with(|| {
                left.name
                    .to_ascii_lowercase()
                    .cmp(&right.name.to_ascii_lowercase())
            })
    });
    let parent_path = resolved
        .parent()
        .map(|value| value.to_string_lossy().to_string());
    Ok(WorkspaceDirectoryEntries {
        directory_path: resolved.to_string_lossy().to_string(),
        parent_path,
        entries,
    })
}

fn default_workspace_directory() -> String {
    std::env::var("USERPROFILE")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            std::env::var("HOME")
                .ok()
                .filter(|value| !value.trim().is_empty())
        })
        .unwrap_or_else(|| ".".to_string())
}

pub(super) async fn codex_backend_upload(
    State(st): State<GatewayState>,
    headers: HeaderMap,
    mut multipart: Multipart,
) -> Response {
    if let Some(resp) = require_codex_auth(&st, &headers) {
        return resp;
    }
    let base_dir = match codex_attachments_dir() {
        Ok(path) => path,
        Err(error) => {
            return api_error_detail(
                StatusCode::INTERNAL_SERVER_ERROR,
                "failed to resolve attachments dir",
                error,
            )
        }
    };
    let mut files = Vec::new();
    while let Some(field) = match multipart.next_field().await {
        Ok(field) => field,
        Err(error) => {
            return api_error_detail(
                StatusCode::BAD_REQUEST,
                "invalid multipart upload body",
                error.to_string(),
            )
        }
    } {
        let label = field
            .file_name()
            .map(|value| value.trim())
            .filter(|value: &&str| !value.is_empty())
            .unwrap_or("upload")
            .to_string();
        let bytes: bytes::Bytes = match field.bytes().await {
            Ok(bytes) => bytes,
            Err(error) => {
                return api_error_detail(
                    StatusCode::BAD_REQUEST,
                    "failed to read upload body",
                    error.to_string(),
                )
            }
        };
        if bytes.len() > super::MAX_ATTACHMENT_BYTES {
            return api_error(
                StatusCode::PAYLOAD_TOO_LARGE,
                "attachment too large (max 10 MiB)",
            );
        }
        let file_id = NEXT_BACKEND_UPLOAD_ID.fetch_add(1, Ordering::Relaxed);
        let stored_name = format!("{file_id}_{}", sanitize_name(&label, "upload"));
        let stored_path = base_dir.join(stored_name);
        if let Err(error) = std::fs::write(&stored_path, &bytes) {
            return api_error_detail(
                StatusCode::INTERNAL_SERVER_ERROR,
                "failed to persist uploaded file",
                error.to_string(),
            );
        }
        let stored_path_text = stored_path.to_string_lossy().to_string();
        files.push(BackendUploadFile {
            label,
            path: stored_path_text.clone(),
            fs_path: stored_path_text,
        });
    }
    Json(BackendUploadResponse { files }).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex as StdMutex;

    static PERSISTED_ATOM_TEST_LOCK: StdMutex<()> = StdMutex::new(());

    #[test]
    fn lists_existing_directory_entries() {
        let result = list_workspace_directory_entries(Some("C:\\Users\\yiyou"), true);
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn backend_ipc_handles_known_invoke_channels() {
        let response =
            handle_backend_ipc_invoke("codex_desktop:get-fast-mode-rollout-metrics", &[]).await;
        assert!(response.is_ok());
        assert_eq!(response.expect("result").result["enabled"], false);
    }

    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn backend_ipc_fetch_bridge_returns_fetch_response_event() {
        let _guard = crate::codex_app_server::lock_test_globals();
        crate::codex_app_server::_set_test_request_handler(Some(std::sync::Arc::new(
            move |_home, method, params| {
                assert_eq!(method, "threads/list");
                assert_eq!(params["workspace"], "windows");
                Ok(json!({ "items": [] }))
            },
        )))
        .await;

        let response = handle_backend_ipc_invoke(
            "codex_desktop:message-from-view",
            &[json!({
                "type": "fetch",
                "requestId": "req_1",
                "method": "POST",
                "url": "vscode://codex/threads/list",
                "body": "{\"workspace\":\"windows\"}"
            })],
        )
        .await
        .expect("fetch bridge");

        assert_eq!(response.result, Value::Null);
        assert_eq!(response.follow_up_events.len(), 1);
        let event = serde_json::to_value(&response.follow_up_events[0]).expect("event json");
        assert_eq!(event["type"], "ipc-main-event");
        assert_eq!(event["channel"], "codex_desktop:message-for-view");
        assert_eq!(event["args"][0]["type"], "fetch-response");
        assert_eq!(event["args"][0]["responseType"], "success");
        assert_eq!(event["args"][0]["requestId"], "req_1");

        crate::codex_app_server::_set_test_request_handler(None).await;
    }

    #[tokio::test]
    async fn backend_ipc_fetch_handles_app_server_connection_state_ipc_request() {
        let response = handle_backend_ipc_invoke(
            "codex_desktop:message-from-view",
            &[json!({
                "type": "fetch",
                "requestId": "req_ipc_1",
                "method": "POST",
                "url": "vscode://codex/ipc-request",
                "body": "{\"method\":\"app-server-connection-state\",\"params\":{\"hostId\":\"local\"}}"
            })],
        )
        .await
        .expect("ipc request bridge");

        assert_eq!(response.result, Value::Null);
        assert_eq!(response.follow_up_events.len(), 1);
        let event = serde_json::to_value(&response.follow_up_events[0]).expect("event json");
        assert_eq!(event["args"][0]["type"], "fetch-response");
        let body: Value = serde_json::from_str(
            event["args"][0]["bodyJsonString"]
                .as_str()
                .expect("body json string"),
        )
        .expect("body json");
        assert_eq!(body["resultType"], "success");
        assert_eq!(body["result"]["state"], "connected");
    }

    #[tokio::test]
    async fn backend_ipc_fetch_handles_codex_web_host_queries_locally() {
        for (request_id, url, expected_key) in [
            ("req_config", "vscode://codex/get-configuration", "value"),
            (
                "req_roots",
                "vscode://codex/workspace-root-options",
                "roots",
            ),
            (
                "req_active_roots",
                "vscode://codex/active-workspace-roots",
                "roots",
            ),
            ("req_git", "vscode://codex/git-origins", "origins"),
            ("req_home", "vscode://codex/codex-home", "codexHome"),
        ] {
            let response = handle_backend_ipc_invoke(
                "codex_desktop:message-from-view",
                &[json!({
                    "type": "fetch",
                    "requestId": request_id,
                    "method": "POST",
                    "url": url,
                    "body": "{}"
                })],
            )
            .await
            .expect("host query bridge");

            assert_eq!(response.result, Value::Null);
            assert_eq!(response.follow_up_events.len(), 1);
            let event = serde_json::to_value(&response.follow_up_events[0]).expect("event json");
            assert_eq!(event["args"][0]["type"], "fetch-response");
            assert_eq!(event["args"][0]["responseType"], "success");
            let body: Value = serde_json::from_str(
                event["args"][0]["bodyJsonString"]
                    .as_str()
                    .expect("body json string"),
            )
            .expect("body json");
            assert!(
                body.get(expected_key).is_some(),
                "{url} should return {expected_key}, got {body}"
            );
        }
    }

    #[tokio::test]
    async fn backend_ipc_fetch_handles_wham_account_check_locally() {
        let response = handle_backend_ipc_invoke(
            "codex_desktop:message-from-view",
            &[json!({
                "type": "fetch",
                "requestId": "req_wham_account_check",
                "method": "GET",
                "url": "/wham/accounts/check"
            })],
        )
        .await
        .expect("wham account check bridge");

        assert_eq!(response.result, Value::Null);
        assert_eq!(response.follow_up_events.len(), 1);
        let event = serde_json::to_value(&response.follow_up_events[0]).expect("event json");
        assert_eq!(event["args"][0]["type"], "fetch-response");
        assert_eq!(event["args"][0]["responseType"], "success");

        let body: Value = serde_json::from_str(
            event["args"][0]["bodyJsonString"]
                .as_str()
                .expect("body json string"),
        )
        .expect("body json");
        assert_eq!(body["account_ordering"][0], "local-account");
        assert_eq!(body["accounts"][0]["id"], "local-account");
    }

    #[tokio::test]
    async fn backend_ipc_shared_object_set_notifies_active_subscribers() {
        shared_object_store().lock().clear();
        shared_object_subscriptions().lock().clear();

        let subscribe = handle_backend_ipc_invoke(
            "codex_desktop:message-from-view",
            &[json!({
                "type": "shared-object-subscribe",
                "key": "remote_connections"
            })],
        )
        .await
        .expect("subscribe");
        assert!(subscribe.follow_up_events.is_empty());

        let update = handle_backend_ipc_invoke(
            "codex_desktop:message-from-view",
            &[json!({
                "type": "shared-object-set",
                "key": "remote_connections",
                "value": [{"hostId":"local"}]
            })],
        )
        .await
        .expect("set");

        assert_eq!(update.follow_up_events.len(), 1);
        let event = serde_json::to_value(&update.follow_up_events[0]).expect("event json");
        assert_eq!(event["args"][0]["type"], "shared-object-updated");
        assert_eq!(event["args"][0]["key"], "remote_connections");
    }

    #[tokio::test]
    async fn backend_ipc_git_worker_returns_stable_metadata() {
        let repo_root = std::env::current_dir().expect("repo root");
        let response = handle_backend_ipc_invoke(
            "codex_desktop:worker:git:from-view",
            &[json!({
                "type": "worker-request",
                "workerId": "git",
                "request": {
                    "id": "req_git_1",
                    "method": "stable-metadata",
                    "params": {
                        "cwd": repo_root.to_string_lossy().to_string(),
                        "root": repo_root.to_string_lossy().to_string()
                    }
                }
            })],
        )
        .await
        .expect("worker response");

        assert_eq!(response.result, Value::Null);
        assert_eq!(response.follow_up_events.len(), 1);
        let event = serde_json::to_value(&response.follow_up_events[0]).expect("event json");
        assert_eq!(event["type"], "ipc-main-event");
        assert_eq!(event["channel"], "codex_desktop:message-for-view");
        assert_eq!(event["args"][0]["type"], "worker-response");
        assert_eq!(event["args"][0]["workerId"], "git");
        assert_eq!(event["args"][0]["response"]["id"], "req_git_1");
        assert_eq!(event["args"][0]["response"]["method"], "stable-metadata");
        assert_eq!(event["args"][0]["response"]["result"]["type"], "ok");
        assert!(event["args"][0]["response"]["result"]["value"]["root"]
            .as_str()
            .is_some());
        assert!(event["args"][0]["response"]["result"]["value"]["commonDir"]
            .as_str()
            .is_some());
    }

    #[tokio::test]
    async fn backend_ipc_send_returns_persisted_atom_sync() {
        let _guard = PERSISTED_ATOM_TEST_LOCK
            .lock()
            .expect("persisted atom test lock");
        persisted_atom_store().lock().clear();
        persisted_atom_store()
            .lock()
            .insert("composer-mode".to_string(), json!("agent"));

        let response = handle_backend_ipc_send(
            "codex_desktop:message-from-view",
            &[json!({
                "type": "persisted-atom-sync-request"
            })],
        )
        .expect("persisted atom sync response");

        assert_eq!(response.result, Value::Null);
        assert_eq!(response.follow_up_events.len(), 1);
        let event = serde_json::to_value(&response.follow_up_events[0]).expect("event json");
        assert_eq!(event["type"], "ipc-main-event");
        assert_eq!(event["channel"], "codex_desktop:message-for-view");
        assert_eq!(event["args"][0]["type"], "persisted-atom-sync");
        assert_eq!(event["args"][0]["state"]["composer-mode"], "agent");
    }

    #[tokio::test]
    async fn backend_ipc_mcp_request_returns_local_config_read_response() {
        let response = handle_backend_ipc_invoke(
            "codex_desktop:message-from-view",
            &[json!({
                "type": "mcp-request",
                "hostId": "local",
                "request": {
                    "id": "req_1",
                    "method": "config/read",
                    "params": {
                        "cwd": null,
                        "includeLayers": false
                    }
                }
            })],
        )
        .await
        .expect("mcp request");

        assert_eq!(response.result, Value::Null);
        assert_eq!(response.follow_up_events.len(), 1);
        let event = serde_json::to_value(&response.follow_up_events[0]).expect("event json");
        assert_eq!(event["type"], "ipc-main-event");
        assert_eq!(event["channel"], "codex_desktop:message-for-view");
        assert_eq!(event["args"][0]["type"], "mcp-response");
        assert_eq!(event["args"][0]["hostId"], "local");
        assert_eq!(event["args"][0]["message"]["id"], "req_1");
        assert!(event["args"][0]["message"]["result"]["config"].is_object());
    }

    #[tokio::test]
    async fn backend_ipc_mcp_model_list_returns_upstream_model_data_shape() {
        let response = handle_backend_ipc_invoke(
            "codex_desktop:message-from-view",
            &[json!({
                "type": "mcp-request",
                "hostId": "local",
                "request": {
                    "id": "req_models_1",
                    "method": "model/list",
                    "params": {
                        "cursor": null,
                        "includeHidden": true,
                        "limit": 100
                    }
                }
            })],
        )
        .await
        .expect("model list request");

        assert_eq!(response.follow_up_events.len(), 1);
        let event = serde_json::to_value(&response.follow_up_events[0]).expect("event json");
        let result = &event["args"][0]["message"]["result"];
        assert!(result["data"].is_array());
        assert_eq!(result["data"][0]["model"], "gpt-5.3-codex");
        assert_eq!(result["data"][0]["isDefault"], true);
        assert!(result["data"][0]["supportedReasoningEfforts"].is_array());
        assert_eq!(result["nextCursor"], Value::Null);
    }

    #[tokio::test]
    async fn backend_ipc_send_persists_atom_updates() {
        let _guard = PERSISTED_ATOM_TEST_LOCK
            .lock()
            .expect("persisted atom test lock");
        persisted_atom_store().lock().clear();

        let response = handle_backend_ipc_send(
            "codex_desktop:message-from-view",
            &[json!({
                "type": "persisted-atom-update",
                "key": "has-seen-welcome",
                "value": true,
                "deleted": false
            })],
        )
        .expect("persisted atom update response");

        assert_eq!(
            persisted_atom_store()
                .lock()
                .get("has-seen-welcome")
                .cloned(),
            Some(json!(true))
        );
        assert_eq!(response.follow_up_events.len(), 1);
        let event = serde_json::to_value(&response.follow_up_events[0]).expect("event json");
        assert_eq!(event["args"][0]["type"], "persisted-atom-updated");
        assert_eq!(event["args"][0]["key"], "has-seen-welcome");
        assert_eq!(event["args"][0]["value"], true);
        assert_eq!(event["args"][0]["deleted"], false);
    }

    #[tokio::test]
    async fn backend_ipc_fetch_stream_returns_validation_error_for_invalid_turn_stream_body() {
        let response = handle_backend_ipc_invoke(
            "codex_desktop:message-from-view",
            &[json!({
                "type": "fetch-stream",
                "requestId": "stream_1",
                "method": "POST",
                "url": "vscode://codex/turn/stream",
                "body": "{\"threadId\":\"t_1\"}"
            })],
        )
        .await;

        match response {
            Ok(_) => panic!("invalid stream request should fail"),
            Err(error) => assert!(error.contains("missing field `prompt`")),
        }
    }

    #[test]
    fn parses_sse_event_blocks_into_event_payloads() {
        let events = parse_sse_events(
            "event: started\ndata: {\"ok\":true}\n\nevent: completed\ndata: {\"done\":true}\n\n",
        )
        .expect("sse parse");
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].0.as_deref(), Some("started"));
        assert_eq!(events[0].1["ok"], true);
        assert_eq!(events[1].0.as_deref(), Some("completed"));
        assert_eq!(events[1].1["done"], true);
    }

    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn backend_ipc_turn_stream_returns_stream_events_and_complete() {
        let _guard = crate::codex_app_server::lock_test_globals();
        crate::codex_app_server::_set_test_request_handler(Some(std::sync::Arc::new(
            move |_home, method, params| {
                assert_eq!(method, "turn/start");
                assert_eq!(params["threadId"], "thread-stream-1");
                Ok(json!({
                    "turn": { "id": "turn-1" },
                    "status": "running"
                }))
            },
        )))
        .await;

        let response = handle_backend_ipc_invoke(
            "codex_desktop:message-from-view",
            &[json!({
                "type": "fetch-stream",
                "requestId": "stream_ok_1",
                "method": "POST",
                "url": "vscode://codex/turn/stream",
                "body": "{\"threadId\":\"thread-stream-1\",\"prompt\":\"hello\"}"
            })],
        )
        .await
        .expect("stream bridge");

        assert_eq!(response.result, Value::Null);
        assert_eq!(response.follow_up_events.len(), 3);
        let first = serde_json::to_value(&response.follow_up_events[0]).expect("first");
        let second = serde_json::to_value(&response.follow_up_events[1]).expect("second");
        let third = serde_json::to_value(&response.follow_up_events[2]).expect("third");
        assert_eq!(first["args"][0]["type"], "fetch-stream-event");
        assert_eq!(first["args"][0]["event"], "started");
        assert_eq!(second["args"][0]["type"], "fetch-stream-event");
        assert_eq!(second["args"][0]["event"], "completed");
        assert_eq!(third["args"][0]["type"], "fetch-stream-complete");

        crate::codex_app_server::_set_test_request_handler(None).await;
    }
}
