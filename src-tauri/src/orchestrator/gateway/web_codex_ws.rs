use super::*;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::Query;
use futures_util::StreamExt;
use parking_lot::Mutex;
use serde::Deserialize;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;

use self::web_codex_actions::{
    build_turn_start_params, build_turn_start_response, turn_thread_id, TurnStartRequest,
};
use self::web_codex_auth::{api_error, is_codex_ws_authorized, require_codex_auth, WsQuery};
use self::web_codex_home::{parse_workspace_target, WorkspaceTarget};
use self::web_codex_session_manager::CodexSessionManager;
use crate::app_state::{
    UiWatchdogInvokeResult, UiWatchdogLocalTask, UiWatchdogPageState, UiWatchdogRuntime,
};

const BACKEND_LIVE_DEBUG_MAX_EVENTS: usize = 160;

fn format_ws_read_error(error: &axum::Error) -> String {
    let text = error.to_string().trim().replace('\n', " ");
    if text.is_empty() {
        "socket_read_error".to_string()
    } else {
        format!("socket_read_error:{text}")
    }
}

#[derive(Debug, Default)]
struct BackendLiveDebugState {
    total_connections: u64,
    active_connections: u64,
    subscribed_connections: u64,
    recent: VecDeque<Value>,
}

static BACKEND_LIVE_DEBUG: OnceLock<Mutex<BackendLiveDebugState>> = OnceLock::new();
static BACKEND_LIVE_DEBUG_NEXT_CLIENT_ID: AtomicU64 = AtomicU64::new(1);

fn backend_live_debug_state() -> &'static Mutex<BackendLiveDebugState> {
    BACKEND_LIVE_DEBUG.get_or_init(|| Mutex::new(BackendLiveDebugState::default()))
}

fn next_backend_live_debug_client_id() -> u64 {
    BACKEND_LIVE_DEBUG_NEXT_CLIENT_ID.fetch_add(1, Ordering::Relaxed)
}

fn backend_live_debug_push(kind: &str, payload: Value) {
    let mut guard = backend_live_debug_state().lock();
    let obj = payload.as_object().cloned().unwrap_or_default();
    let mut map = serde_json::Map::with_capacity(obj.len() + 2);
    map.insert("at".to_string(), json!(unix_ms()));
    map.insert("kind".to_string(), json!(kind));
    for (key, value) in obj {
        map.insert(key, value);
    }
    let entry = Value::Object(map);
    guard.recent.push_back(entry.clone());
    while guard.recent.len() > BACKEND_LIVE_DEBUG_MAX_EVENTS {
        guard.recent.pop_front();
    }
    drop(guard);
    let _ = super::web_codex_storage::append_codex_live_trace_entry(&json!({
        "source": "backend.ws",
        "entry": entry,
    }));
}

fn backend_live_debug_connection_open(client_id: u64) {
    let mut guard = backend_live_debug_state().lock();
    guard.total_connections = guard.total_connections.saturating_add(1);
    guard.active_connections = guard.active_connections.saturating_add(1);
    drop(guard);
    backend_live_debug_push("backend.ws.open", json!({ "clientId": client_id }));
}

fn backend_live_debug_connection_close(client_id: u64, subscribed: bool) {
    let mut guard = backend_live_debug_state().lock();
    guard.active_connections = guard.active_connections.saturating_sub(1);
    if subscribed {
        guard.subscribed_connections = guard.subscribed_connections.saturating_sub(1);
    }
    drop(guard);
    backend_live_debug_push(
        "backend.ws.close",
        json!({ "clientId": client_id, "subscribed": subscribed }),
    );
}

fn workspace_target_label(target: WorkspaceTarget) -> &'static str {
    match target {
        WorkspaceTarget::Windows => "windows",
        WorkspaceTarget::Wsl2 => "wsl2",
    }
}

fn backend_live_debug_subscribe(
    client_id: u64,
    last_event_id: u64,
    workspace_targets: &[WorkspaceTarget],
) {
    let mut guard = backend_live_debug_state().lock();
    guard.subscribed_connections = guard.subscribed_connections.saturating_add(1);
    drop(guard);
    let workspaces = workspace_targets
        .iter()
        .map(|target| workspace_target_label(*target))
        .collect::<Vec<_>>();
    backend_live_debug_push(
        "backend.ws.subscribe",
        json!({
            "clientId": client_id,
            "lastEventId": last_event_id,
            "workspace": if workspaces.len() > 1 { "all" } else { workspaces.first().copied().unwrap_or("windows") },
            "workspaces": workspaces,
        }),
    );
    let mut pipeline = crate::diagnostics::codex_web_pipeline::CodexWebPipelineEvent::new(
        "/codex/ws",
        if workspace_targets.len() > 1 {
            "all"
        } else {
            workspace_targets
                .first()
                .map(|target| workspace_target_label(*target))
                .unwrap_or("windows")
        },
        "ws_subscribe",
        0,
    );
    pipeline.source = Some("client-subscribe".to_string());
    pipeline.item_count = Some(workspace_targets.len());
    pipeline.ok = Some(true);
    crate::diagnostics::codex_web_pipeline::append_pipeline_event(pipeline);
}

fn backend_live_debug_push_send(client_id: u64, notif: &Value, delivered: bool) {
    let method = notif
        .get("method")
        .and_then(|value| value.as_str())
        .unwrap_or_default();
    let thread_id = extract_notification_thread_id_for_debug(notif).unwrap_or_default();
    let event_id = notif.get("eventId").and_then(|value| value.as_u64());
    backend_live_debug_push(
        if delivered {
            "backend.ws.notification_sent"
        } else {
            "backend.ws.notification_send_failed"
        },
        Value::Object({
            let mut map = serde_json::Map::from_iter([
                ("clientId".to_string(), Value::from(client_id)),
                ("method".to_string(), Value::String(method.to_string())),
                ("threadId".to_string(), Value::String(thread_id)),
                (
                    "eventId".to_string(),
                    event_id.map(Value::from).unwrap_or(Value::Null),
                ),
            ]);
            if let Some(params) = notif.get("params").and_then(Value::as_object) {
                if let Some(status) = params
                    .get("status")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|text| !text.is_empty())
                {
                    map.insert("status".to_string(), Value::String(status.to_string()));
                }
                if let Some(source) = params
                    .get("source")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|text| !text.is_empty())
                {
                    map.insert("source".to_string(), Value::String(source.to_string()));
                }
                if let Some(message) = params
                    .get("message")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|text| !text.is_empty())
                {
                    map.insert(
                        "message".to_string(),
                        Value::String(message.chars().take(220).collect()),
                    );
                }
            }
            map
        }),
    );
}

fn extract_notification_thread_id_for_debug(notif: &Value) -> Option<String> {
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

    let params = notif
        .get("params")
        .and_then(Value::as_object)
        .or_else(|| notif.get("payload").and_then(Value::as_object));
    let thread_id = params
        .and_then(|map| map.get("threadId").and_then(Value::as_str))
        .or_else(|| params.and_then(|map| map.get("thread_id").and_then(Value::as_str)));
    if let Some(value) = thread_id {
        return Some(value.to_string());
    }
    let item = params
        .and_then(|map| map.get("item"))
        .and_then(Value::as_object)
        .or_else(|| {
            params
                .and_then(|map| map.get("msg"))
                .and_then(Value::as_object)
        });
    item.and_then(|map| {
        map.get("thread_id")
            .and_then(Value::as_str)
            .or_else(|| map.get("threadId").and_then(Value::as_str))
            .map(str::to_string)
    })
    .or_else(|| deep_find_thread_id(notif, 0))
}

fn backend_live_debug_snapshot_value() -> Value {
    let guard = backend_live_debug_state().lock();
    json!({
        "connections": {
            "total": guard.total_connections,
            "active": guard.active_connections,
            "subscribed": guard.subscribed_connections,
        },
        "recent": guard.recent.iter().cloned().collect::<Vec<_>>(),
    })
}

fn workspace_target_from_ws_payload(value: &Value) -> Option<WorkspaceTarget> {
    value
        .get("payload")
        .and_then(|payload| payload.get("workspace"))
        .and_then(Value::as_str)
        .and_then(parse_workspace_target)
}

fn workspace_targets_from_ws_payload(value: &Value) -> Vec<WorkspaceTarget> {
    let Some(payload) = value.get("payload") else {
        return vec![WorkspaceTarget::Windows];
    };
    if let Some(items) = payload.get("workspaces").and_then(Value::as_array) {
        let mut targets = Vec::new();
        for item in items {
            if let Some(target) = item.as_str().and_then(parse_workspace_target) {
                if !targets.contains(&target) {
                    targets.push(target);
                }
            }
        }
        if !targets.is_empty() {
            return targets;
        }
    }
    match payload.get("workspace").and_then(Value::as_str) {
        Some(raw) if raw.eq_ignore_ascii_case("all") => {
            vec![WorkspaceTarget::Windows, WorkspaceTarget::Wsl2]
        }
        Some(raw) => parse_workspace_target(raw)
            .map(|target| vec![target])
            .unwrap_or_else(|| vec![WorkspaceTarget::Windows]),
        None => vec![WorkspaceTarget::Windows],
    }
}

#[derive(Deserialize)]
pub(super) struct AppServerWsQuery {
    #[serde(default)]
    token: Option<String>,
    #[serde(default)]
    workspace: Option<String>,
    #[serde(default)]
    home: Option<String>,
}

fn app_server_initialize_result() -> Value {
    json!({
        "userAgent": format!("api-router/{}", env!("CARGO_PKG_VERSION")),
        "platformFamily": std::env::consts::FAMILY,
        "platformOs": std::env::consts::OS,
    })
}

fn jsonrpc_error_payload(message: &str) -> Value {
    json!({
        "code": -32000,
        "message": message,
    })
}

fn strip_notification_event_id(value: &Value) -> Value {
    let Some(obj) = value.as_object() else {
        return value.clone();
    };
    let mut next = obj.clone();
    next.remove("eventId");
    Value::Object(next)
}

fn normalize_remote_app_server_params(method: &str, params: Value) -> Value {
    let Some(obj) = params.as_object() else {
        return params;
    };
    let mut next = obj.clone();
    if method == "thread/start" {
        next.remove("persistExtendedHistory");
        next.remove("persistFullHistory");
    }
    if method == "turn/start" {
        next.remove("collaborationMode");
        next.remove("collaboration_mode");
        next.remove("collaboration_mode_kind");
    }
    Value::Object(next)
}

fn app_server_compat_result(method: &str) -> Option<Value> {
    match method {
        "get-global-state" => Some(json!({})),
        "list-pinned-threads" => Some(json!({ "items": [] })),
        "extension-info" => Some(json!({
            "name": "api-router",
            "version": env!("CARGO_PKG_VERSION"),
            "windowType": "electron",
        })),
        "os-info" => Some(json!({
            "platform": std::env::consts::OS,
            "platformFamily": std::env::consts::FAMILY,
        })),
        "is-copilot-api-available" => Some(json!(false)),
        _ => None,
    }
}

fn normalize_remote_app_server_method(method: &str) -> &str {
    match method {
        "account-info" => "account/read",
        other => other,
    }
}

pub(super) async fn codex_ws(
    State(st): State<GatewayState>,
    headers: HeaderMap,
    Query(query): Query<WsQuery>,
    ws: WebSocketUpgrade,
) -> Response {
    if !is_codex_ws_authorized(&st, &headers, &query) {
        return api_error(StatusCode::UNAUTHORIZED, "invalid token");
    }
    ws.on_upgrade(codex_ws_loop)
}

pub(super) async fn codex_app_server_ws(
    State(st): State<GatewayState>,
    headers: HeaderMap,
    Query(query): Query<AppServerWsQuery>,
    ws: WebSocketUpgrade,
) -> Response {
    if !is_codex_ws_authorized(
        &st,
        &headers,
        &WsQuery {
            token: query.token.clone(),
        },
    ) {
        return api_error(StatusCode::UNAUTHORIZED, "invalid token");
    }
    let workspace_target = query.workspace.as_deref().and_then(parse_workspace_target);
    let home_override = query
        .home
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    ws.on_upgrade(move |socket| codex_app_server_ws_loop(socket, workspace_target, home_override))
}

async fn codex_app_server_ws_loop(
    mut socket: WebSocket,
    workspace_target: Option<WorkspaceTarget>,
    home_override: Option<String>,
) {
    let manager = CodexSessionManager::new(workspace_target).with_home_override(home_override);
    let mut initialized = false;
    let mut notif_cursor = 0_u64;
    let mut poll_tick = tokio::time::interval(std::time::Duration::from_millis(200));

    loop {
        tokio::select! {
            _ = poll_tick.tick(), if initialized => {
                let batch = manager.replay_notification_batch(notif_cursor, 64, false).await;
                notif_cursor = batch.next_cursor;
                if batch.reset {
                    continue;
                }
                for notif in batch.items {
                    let payload = strip_notification_event_id(&notif);
                    if !send_ws_json(&mut socket, &payload).await {
                        return;
                    }
                }
            }
            incoming = socket.next() => {
                let Some(incoming) = incoming else {
                    return;
                };
                let Ok(message) = incoming else {
                    return;
                };
                match message {
                    Message::Text(text) => {
                        let Ok(value) = serde_json::from_str::<Value>(&text) else {
                            let _ = send_ws_json(&mut socket, &json!({
                                "id": Value::Null,
                                "error": jsonrpc_error_payload("invalid json message"),
                            })).await;
                            continue;
                        };
                        let raw_method = value.get("method").and_then(Value::as_str).unwrap_or_default();
                        let method = normalize_remote_app_server_method(raw_method);
                        let id = value.get("id").cloned();
                        match method {
                            "initialize" => {
                                if let Some(id) = id {
                                    let _ = send_ws_json(&mut socket, &json!({
                                        "id": id,
                                        "result": app_server_initialize_result(),
                                    })).await;
                                }
                            }
                            "initialized" => {
                                initialized = true;
                                let _ = manager.ensure_server().await;
                            }
                            "shutdown" => {
                                if let Some(id) = id {
                                    let _ = send_ws_json(&mut socket, &json!({
                                        "id": id,
                                        "result": {},
                                    })).await;
                                }
                            }
                            "thread/unsubscribe" => {
                                if let Some(id) = id {
                                    let _ = send_ws_json(&mut socket, &json!({
                                        "id": id,
                                        "result": {},
                                    })).await;
                                }
                            }
                            _ => {
                                if !initialized {
                                    if let Some(id) = id {
                                        let _ = send_ws_json(&mut socket, &json!({
                                            "id": id,
                                            "error": jsonrpc_error_payload("Not initialized"),
                                        })).await;
                                    }
                                    continue;
                                }
                                if let Some(result) = app_server_compat_result(method) {
                                    if let Some(id) = id {
                                        if !send_ws_json(&mut socket, &json!({ "id": id, "result": result })).await {
                                            return;
                                        }
                                    }
                                    continue;
                                }
                                let params = normalize_remote_app_server_params(
                                    method,
                                    value.get("params").cloned().unwrap_or_else(|| json!({})),
                                );
                                if method == "thread/start" {
                                    let _ = super::web_codex_storage::append_codex_live_trace_entry(&json!({
                                        "source": "backend.appws",
                                        "entry": {
                                            "kind": "appws.thread_start",
                                            "at": unix_ms(),
                                            "params": params,
                                        }
                                    }));
                                }
                                let Some(id) = id else {
                                    continue;
                                };
                                match manager.request(method, params).await {
                                    Ok(result) => {
                                        if !send_ws_json(&mut socket, &json!({ "id": id, "result": result })).await {
                                            return;
                                        }
                                    }
                                    Err(error) => {
                                        if !send_ws_json(&mut socket, &json!({
                                            "id": id,
                                            "error": jsonrpc_error_payload(&error),
                                        })).await {
                                            return;
                                        }
                                    }
                                }
                            }
                        }
                    }
                    Message::Binary(_) => {}
                    Message::Close(_) => return,
                    Message::Ping(payload) => {
                        if socket.send(Message::Pong(payload)).await.is_err() {
                            return;
                        }
                    }
                    Message::Pong(_) => {}
                }
            }
        }
    }
}

async fn send_ws_json(socket: &mut WebSocket, value: &Value) -> bool {
    socket.send(Message::Text(value.to_string())).await.is_ok()
}

async fn codex_ws_stream_turn(
    socket: &mut WebSocket,
    req_id: &str,
    payload: Value,
) -> Result<(), String> {
    let started = json!({
        "type": "started",
        "reqId": req_id,
    });
    if !send_ws_json(socket, &started).await {
        return Err("ws closed".to_string());
    }
    let request: TurnStartRequest = serde_json::from_value(payload)
        .map_err(|error| format!("invalid turn payload: {error}"))?;
    if request.prompt.trim().is_empty() {
        return Err("prompt is required".to_string());
    }
    let thread_id = turn_thread_id(&request)
        .ok_or_else(|| "invalid turn payload: missing threadId".to_string())?
        .to_string();
    let params = build_turn_start_params(&thread_id, &request);
    let workspace_target = request
        .workspace
        .as_deref()
        .and_then(parse_workspace_target);
    let manager = CodexSessionManager::new(workspace_target);
    let outcome = manager.turn_start(&thread_id, params).await?;
    let completed = json!({
        "type": "completed",
        "reqId": req_id,
        "payload": build_turn_start_response(&thread_id, outcome.result, outcome.rollout_path.as_deref())
    });
    if !send_ws_json(socket, &completed).await {
        return Err("ws closed".to_string());
    }
    Ok(())
}

async fn codex_ws_emit_event_snapshot(
    socket: &mut WebSocket,
    req_id: &str,
    approvals_sig: &mut String,
    user_input_sig: &mut String,
    workspace_targets: &[WorkspaceTarget],
) -> bool {
    let targets = if workspace_targets.is_empty() {
        vec![WorkspaceTarget::Windows]
    } else {
        workspace_targets.to_vec()
    };
    let mut approvals = Vec::new();
    let mut user_inputs = Vec::new();
    for target in targets {
        let snapshot = CodexSessionManager::new(Some(target))
            .pending_events_snapshot()
            .await;
        approvals.extend(snapshot.approvals.as_array().cloned().unwrap_or_default());
        user_inputs.extend(snapshot.user_inputs.as_array().cloned().unwrap_or_default());
    }
    let approvals_payload = Value::Array(approvals);
    let user_inputs_payload = Value::Array(user_inputs);
    *approvals_sig = approvals_payload.to_string();
    *user_input_sig = user_inputs_payload.to_string();
    send_ws_json(
        socket,
        &json!({
            "type": "events.snapshot",
            "reqId": req_id,
            "payload": {
                "approvals": approvals_payload,
                "userInputs": user_inputs_payload
            }
        }),
    )
    .await
}

async fn codex_ws_poll_pending_events(
    socket: &mut WebSocket,
    approvals_sig: &mut String,
    user_input_sig: &mut String,
    notif_cursors: &mut std::collections::HashMap<WorkspaceTarget, u64>,
    client_id: u64,
    workspace_targets: &[WorkspaceTarget],
) -> bool {
    let targets = if workspace_targets.is_empty() {
        vec![WorkspaceTarget::Windows]
    } else {
        workspace_targets.to_vec()
    };
    let mut approvals_items = Vec::new();
    let mut user_inputs_items = Vec::new();
    for target in &targets {
        let snapshot = CodexSessionManager::new(Some(*target))
            .pending_events_snapshot()
            .await;
        approvals_items.extend(snapshot.approvals.as_array().cloned().unwrap_or_default());
        user_inputs_items.extend(snapshot.user_inputs.as_array().cloned().unwrap_or_default());
    }
    let approvals_payload = Value::Array(approvals_items);
    let approvals_next_sig = approvals_payload.to_string();
    if *approvals_sig != approvals_next_sig {
        *approvals_sig = approvals_next_sig;
        if !send_ws_json(
            socket,
            &json!({
                "type": "approval.requested",
                "payload": approvals_payload
            }),
        )
        .await
        {
            return false;
        }
    }
    let user_inputs_payload = Value::Array(user_inputs_items);
    let user_inputs_next_sig = user_inputs_payload.to_string();
    if *user_input_sig != user_inputs_next_sig {
        *user_input_sig = user_inputs_next_sig;
        if !send_ws_json(
            socket,
            &json!({
                "type": "user_input.requested",
                "payload": user_inputs_payload
            }),
        )
        .await
        {
            return false;
        }
    }
    for target in targets {
        let manager = CodexSessionManager::new(Some(target));
        let cursor = notif_cursors.entry(target).or_insert(0);
        let home = manager.home_override().map(str::to_string);
        let batch = manager.replay_notification_batch(*cursor, 64, true).await;
        if batch.reset || !batch.items.is_empty() {
            backend_live_debug_push(
                "backend.ws.poll",
                json!({
                    "clientId": client_id,
                    "cursor": *cursor,
                    "workspace": workspace_target_label(target),
                    "home": home,
                    "count": batch.items.len(),
                    "firstEventId": batch.first_event_id,
                    "lastEventId": batch.last_event_id,
                    "gap": batch.gap,
                }),
            );
        }
        if batch.reset {
            let _ = send_ws_json(
                socket,
                &json!({
                    "type": "events.reset",
                    "payload": {
                        "workspace": workspace_target_label(target),
                        "requestedSince": *cursor,
                        "firstEventId": batch.first_event_id,
                        "lastEventId": batch.last_event_id
                    }
                }),
            )
            .await;
            backend_live_debug_push(
                "backend.ws.events_reset",
                json!({
                    "clientId": client_id,
                    "workspace": workspace_target_label(target),
                    "requestedSince": batch.requested_cursor,
                    "firstEventId": batch.first_event_id,
                    "lastEventId": batch.last_event_id,
                    "replayedCount": batch.items.len(),
                }),
            );
        }
        *cursor = batch.next_cursor;
        for notif in batch.items {
            let delivered = send_ws_json(
                socket,
                &json!({ "type": "rpc.notification", "payload": notif }),
            )
            .await;
            backend_live_debug_push_send(client_id, &notif, delivered);
            if !delivered {
                return false;
            }
        }
    }
    true
}

async fn codex_ws_loop(mut socket: WebSocket) {
    let client_id = next_backend_live_debug_client_id();
    backend_live_debug_connection_open(client_id);
    let mut subscribe_events = false;
    let mut approvals_sig = String::new();
    let mut user_input_sig = String::new();
    let mut notif_cursors: std::collections::HashMap<WorkspaceTarget, u64> =
        std::collections::HashMap::new();
    let mut notif_workspace_targets = vec![WorkspaceTarget::Windows];
    let mut poll_tick = tokio::time::interval(std::time::Duration::from_millis(250));
    let close_reason = loop {
        tokio::select! {
            _ = poll_tick.tick() => {
                if subscribe_events
                    && !codex_ws_poll_pending_events(
                        &mut socket,
                        &mut approvals_sig,
                        &mut user_input_sig,
                        &mut notif_cursors,
                        client_id,
                        &notif_workspace_targets,
                    ).await
                {
                    break "poll_send_failed".to_string();
                }
            }
            incoming = socket.next() => {
                let Some(incoming) = incoming else {
                    break "socket_stream_ended".to_string();
                };
                let Ok(msg) = incoming else {
                    let error = incoming.err().map(|err| format_ws_read_error(&err)).unwrap_or_else(|| "socket_read_error".to_string());
                    break error;
                };
                match msg {
                    Message::Text(text) => {
                        let parsed = serde_json::from_str::<Value>(&text);
                        let Ok(v) = parsed else {
                            let _ = send_ws_json(
                                &mut socket,
                                &json!({ "type": "error", "message": "invalid json message" }),
                            )
                            .await;
                            continue;
                        };
                        let msg_type = v.get("type").and_then(|x| x.as_str()).unwrap_or_default();
                        let req_id = v
                            .get("reqId")
                            .and_then(|x| x.as_str())
                            .unwrap_or("no-req-id")
                            .to_string();
                        match msg_type {
                            "ping" => {
                                let _ = send_ws_json(
                                    &mut socket,
                                    &json!({ "type": "pong", "reqId": req_id }),
                                )
                                .await;
                            }
                            "subscribe.events" => {
                                subscribe_events = true;
                                notif_workspace_targets = workspace_targets_from_ws_payload(&v);
                                let last_event_id = v
                                    .get("payload")
                                    .and_then(|p| p.get("lastEventId"))
                                    .and_then(|x| x.as_u64())
                                    .unwrap_or(0);
                                notif_cursors.clear();
                                for target in &notif_workspace_targets {
                                    notif_cursors.insert(*target, last_event_id);
                                }
                                backend_live_debug_subscribe(
                                    client_id,
                                    last_event_id,
                                    &notif_workspace_targets,
                                );
                                let _ = send_ws_json(&mut socket, &json!({
                                    "type": "subscribed",
                                    "reqId": req_id,
                                    "payload": {
                                        "events": true,
                                        "workspace": if notif_workspace_targets.len() > 1 { "all" } else { workspace_target_label(*notif_workspace_targets.first().unwrap_or(&WorkspaceTarget::Windows)) },
                                        "workspaces": notif_workspace_targets.iter().map(|target| workspace_target_label(*target)).collect::<Vec<_>>()
                                    }
                                }))
                                .await;
                                let _ = codex_ws_poll_pending_events(
                                    &mut socket,
                                    &mut approvals_sig,
                                    &mut user_input_sig,
                                    &mut notif_cursors,
                                    client_id,
                                    &notif_workspace_targets,
                                )
                                .await;
                                let _ = codex_ws_emit_event_snapshot(
                                    &mut socket,
                                    &req_id,
                                    &mut approvals_sig,
                                    &mut user_input_sig,
                                    &notif_workspace_targets,
                                )
                                .await;
                            }
                            "events.refresh" => {
                                notif_workspace_targets = workspace_targets_from_ws_payload(&v);
                                let _ = codex_ws_emit_event_snapshot(
                                    &mut socket,
                                    &req_id,
                                    &mut approvals_sig,
                                    &mut user_input_sig,
                                    &notif_workspace_targets,
                                )
                                .await;
                            }
                            "turn.stream" => {
                                let payload = v.get("payload").cloned().unwrap_or(Value::Null);
                                if let Err(e) = codex_ws_stream_turn(&mut socket, &req_id, payload).await {
                                    let _ = send_ws_json(
                                        &mut socket,
                                        &json!({ "type": "error", "reqId": req_id, "message": e }),
                                    )
                                    .await;
                                }
                            }
                            "interrupt" => {
                                let turn_id = v
                                    .get("payload")
                                    .and_then(|p| p.get("turnId"))
                                    .and_then(|x| x.as_str())
                                    .unwrap_or_default()
                                    .to_string();
                                let thread_id = v
                                    .get("payload")
                                    .and_then(|p| p.get("threadId").or_else(|| p.get("thread_id")))
                                    .and_then(|x| x.as_str())
                                    .unwrap_or_default()
                                    .to_string();
                                if thread_id.trim().is_empty() {
                                    let _ = send_ws_json(
                                        &mut socket,
                                        &json!({ "type": "error", "reqId": req_id, "message": "missing threadId" }),
                                    )
                                    .await;
                                    continue;
                                }
                                let manager = CodexSessionManager::new(None);
                                let result = manager.interrupt_turn(&thread_id, &turn_id).await;
                                match result {
                                    Ok(ok) => {
                                        let _ = send_ws_json(
                                            &mut socket,
                                            &json!({ "type": "interrupt.completed", "reqId": req_id, "payload": ok }),
                                        )
                                        .await;
                                    }
                                    Err(e) => {
                                        let _ = send_ws_json(
                                            &mut socket,
                                            &json!({ "type": "error", "reqId": req_id, "message": e }),
                                        )
                                        .await;
                                    }
                                }
                            }
                            "rpc" => {
                                let method = v
                                    .get("payload")
                                    .and_then(|p| p.get("method"))
                                    .and_then(|x| x.as_str())
                                    .unwrap_or_default()
                                    .to_string();
                                let params = v
                                    .get("payload")
                                    .and_then(|p| p.get("params"))
                                    .cloned()
                                    .unwrap_or(Value::Null);
                                if method.trim().is_empty() {
                                    let _ = send_ws_json(
                                        &mut socket,
                                        &json!({ "type": "error", "reqId": req_id, "message": "missing method" }),
                                    )
                                    .await;
                                    continue;
                                }
                                let manager = CodexSessionManager::new(None);
                                let result = manager.request(&method, params).await;
                                match result {
                                    Ok(ok) => {
                                        let _ = send_ws_json(
                                            &mut socket,
                                            &json!({ "type": "rpc.result", "reqId": req_id, "payload": ok }),
                                        )
                                        .await;
                                    }
                                    Err(e) => {
                                        let _ = send_ws_json(
                                            &mut socket,
                                            &json!({ "type": "error", "reqId": req_id, "message": e }),
                                        )
                                        .await;
                                    }
                                }
                            }
                            "approval.resolve" => {
                                let id = v
                                    .get("payload")
                                    .and_then(|p| p.get("id"))
                                    .and_then(|x| x.as_str())
                                    .unwrap_or_default()
                                    .to_string();
                                let decision = v
                                    .get("payload")
                                    .and_then(|p| p.get("decision"))
                                    .and_then(|x| x.as_str())
                                    .unwrap_or_default()
                                    .to_string();
                                let home = crate::orchestrator::gateway::web_codex_home::web_codex_rpc_home_override_for_target(
                                    workspace_target_from_ws_payload(&v),
                                );
                                let result = super::codex_try_request_with_fallback_in_home(
                                    home.as_deref(),
                                    &["bridge/approvals/resolve", "approvals/resolve"],
                                    json!({
                                        "id": id,
                                        "decision": decision,
                                        "workspace": v
                                            .get("payload")
                                            .and_then(|p| p.get("workspace"))
                                            .cloned()
                                            .unwrap_or(Value::Null)
                                    }),
                                )
                                .await;
                                match result {
                                    Ok(ok) => {
                                        let _ = send_ws_json(
                                            &mut socket,
                                            &json!({ "type": "approval.resolved", "reqId": req_id, "payload": ok }),
                                        )
                                        .await;
                                    }
                                    Err(e) => {
                                        let _ = send_ws_json(
                                            &mut socket,
                                            &json!({ "type": "error", "reqId": req_id, "message": e }),
                                        )
                                        .await;
                                    }
                                }
                            }
                            "user_input.resolve" => {
                                let id = v
                                    .get("payload")
                                    .and_then(|p| p.get("id"))
                                    .and_then(|x| x.as_str())
                                    .unwrap_or_default()
                                    .to_string();
                                let answers = v
                                    .get("payload")
                                    .and_then(|p| p.get("answers"))
                                    .cloned()
                                    .unwrap_or(Value::Null);
                                let home = crate::orchestrator::gateway::web_codex_home::web_codex_rpc_home_override_for_target(
                                    workspace_target_from_ws_payload(&v),
                                );
                                let result = super::codex_try_request_with_fallback_in_home(
                                    home.as_deref(),
                                    &[
                                        "bridge/userInput/resolve",
                                        "userInput/resolve",
                                        "request_user_input/resolve",
                                    ],
                                    json!({
                                        "id": id,
                                        "answers": answers,
                                        "workspace": v
                                            .get("payload")
                                            .and_then(|p| p.get("workspace"))
                                            .cloned()
                                            .unwrap_or(Value::Null)
                                    }),
                                )
                                .await;
                                match result {
                                    Ok(ok) => {
                                        let _ = send_ws_json(
                                            &mut socket,
                                            &json!({ "type": "user_input.resolved", "reqId": req_id, "payload": ok }),
                                        )
                                        .await;
                                    }
                                    Err(e) => {
                                        let _ = send_ws_json(
                                            &mut socket,
                                            &json!({ "type": "error", "reqId": req_id, "message": e }),
                                        )
                                        .await;
                                    }
                                }
                            }
                            _ => {
                                let _ = send_ws_json(
                                    &mut socket,
                                    &json!({ "type": "error", "reqId": req_id, "message": "unsupported ws message type" }),
                                )
                                .await;
                            }
                        }
                    }
                    Message::Binary(_) => {}
                    Message::Close(frame) => {
                        break match frame {
                            Some(frame) => format!("client_close:{}:{}", frame.code, frame.reason),
                            None => "client_close".to_string(),
                        }
                    },
                    Message::Ping(payload) => {
                        if socket.send(Message::Pong(payload)).await.is_err() {
                            break "pong_send_failed".to_string();
                        }
                    }
                    Message::Pong(_) => {}
                }
            }
        }
    };
    backend_live_debug_push(
        "backend.ws.loop_exit",
        json!({
            "clientId": client_id,
            "reason": close_reason,
            "subscribed": subscribe_events,
        }),
    );
    backend_live_debug_connection_close(client_id, subscribe_events);
}

pub(super) async fn codex_auth_verify(
    State(st): State<GatewayState>,
    headers: HeaderMap,
) -> Response {
    if let Some(resp) = require_codex_auth(&st, &headers) {
        return resp;
    }
    Json(json!({ "ok": true })).into_response()
}

#[derive(Debug, Deserialize)]
pub(super) struct WebTransportEventRecordRequest {
    #[serde(rename = "eventType")]
    pub event_type: String,
    pub detail: Option<String>,
}

pub(super) async fn codex_record_web_transport_event(
    State(st): State<GatewayState>,
    headers: HeaderMap,
    Json(payload): Json<WebTransportEventRecordRequest>,
) -> Response {
    if let Some(resp) = require_codex_auth(&st, &headers) {
        return resp;
    }
    let event_type = payload.event_type.trim();
    if event_type.is_empty() {
        return api_error(StatusCode::BAD_REQUEST, "eventType is required");
    }
    crate::diagnostics::codex_web_transport::record_web_transport_event(event_type, payload.detail);
    Json(json!({ "ok": true })).into_response()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct WebCodexUiDiagnosticsRequest {
    pub heartbeat: Option<WebCodexUiHeartbeatRecord>,
    #[serde(default)]
    pub traces: Vec<WebCodexUiTraceRecord>,
    #[serde(default)]
    pub invoke_results: Vec<WebCodexUiInvokeResultRecord>,
    #[serde(default)]
    pub local_tasks: Vec<WebCodexUiLocalTaskRecord>,
    #[serde(default)]
    pub long_tasks: Vec<WebCodexUiLongTaskRecord>,
    #[serde(default)]
    pub frame_stalls: Vec<WebCodexUiFrameStallRecord>,
    #[serde(default)]
    pub frontend_errors: Vec<WebCodexUiFrontendErrorRecord>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct WebCodexUiHeartbeatRecord {
    pub active_page: Option<String>,
    pub visible: Option<bool>,
    pub status_in_flight: Option<bool>,
    pub config_in_flight: Option<bool>,
    pub provider_switch_in_flight: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct WebCodexUiTraceRecord {
    pub kind: String,
    pub active_page: Option<String>,
    pub visible: Option<bool>,
    #[serde(default)]
    pub fields: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct WebCodexUiInvokeResultRecord {
    pub command: String,
    pub elapsed_ms: u64,
    pub ok: bool,
    pub error_message: Option<String>,
    pub active_page: Option<String>,
    pub visible: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct WebCodexUiLocalTaskRecord {
    pub command: String,
    pub elapsed_ms: u64,
    #[serde(default)]
    pub fields: Value,
    pub active_page: Option<String>,
    pub visible: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct WebCodexUiLongTaskRecord {
    pub elapsed_ms: u64,
    pub active_page: Option<String>,
    pub visible: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct WebCodexUiFrameStallRecord {
    pub elapsed_ms: u64,
    pub monitor_kind: Option<String>,
    pub active_page: Option<String>,
    pub visible: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct WebCodexUiFrontendErrorRecord {
    pub kind: Option<String>,
    pub message: String,
    pub active_page: Option<String>,
    pub visible: Option<bool>,
}

fn normalize_web_codex_page(value: Option<&str>) -> String {
    let page = value.unwrap_or_default().trim();
    if page.is_empty() {
        "codex-web".to_string()
    } else if page.starts_with("codex-web") {
        page.to_string()
    } else {
        format!("codex-web:{page}")
    }
}

pub(super) async fn codex_ui_diagnostics(
    State(st): State<GatewayState>,
    headers: HeaderMap,
    Json(payload): Json<WebCodexUiDiagnosticsRequest>,
) -> Response {
    if let Some(resp) = require_codex_auth(&st, &headers) {
        return resp;
    }
    let listen_port = st.cfg.read().listen.port;
    let Some(watchdog) = crate::lan_sync::current_ui_watchdog_state(listen_port) else {
        return api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "ui watchdog is not registered",
        );
    };
    let diagnostics_dir = crate::diagnostics::current_diagnostics_dir()
        .unwrap_or_else(|| std::env::temp_dir().join("api-router-diagnostics"));
    let runtime = UiWatchdogRuntime {
        store: &st.store,
        diagnostics_dir: &diagnostics_dir,
    };
    let now = unix_ms();
    let mut accepted = 0usize;

    if let Some(heartbeat) = payload.heartbeat {
        let active_page = normalize_web_codex_page(heartbeat.active_page.as_deref());
        watchdog.record_heartbeat(
            &active_page,
            heartbeat.visible.unwrap_or(true),
            heartbeat.status_in_flight.unwrap_or(false),
            heartbeat.config_in_flight.unwrap_or(false),
            heartbeat.provider_switch_in_flight.unwrap_or(false),
            now,
        );
        accepted = accepted.saturating_add(1);
    }

    for trace in payload.traces.into_iter().take(256) {
        let kind = trace.kind.trim();
        if kind.is_empty() {
            continue;
        }
        watchdog.record_trace(
            kind,
            json!({
                "active_page": normalize_web_codex_page(trace.active_page.as_deref()),
                "visible": trace.visible.unwrap_or(true),
                "fields": trace.fields,
            }),
            now,
        );
        accepted = accepted.saturating_add(1);
    }

    for item in payload.invoke_results.into_iter().take(256) {
        let command = item.command.trim().to_string();
        if command.is_empty() {
            continue;
        }
        let active_page = normalize_web_codex_page(item.active_page.as_deref());
        watchdog.record_invoke_result(
            UiWatchdogRuntime {
                store: runtime.store,
                diagnostics_dir: runtime.diagnostics_dir,
            },
            UiWatchdogInvokeResult {
                command: &command,
                elapsed_ms: item.elapsed_ms,
                ok: item.ok,
                error_message: item.error_message.as_deref(),
            },
            UiWatchdogPageState {
                active_page: &active_page,
                visible: item.visible.unwrap_or(true),
            },
            now,
        );
        accepted = accepted.saturating_add(1);
    }

    for item in payload.local_tasks.into_iter().take(128) {
        let command = item.command.trim().to_string();
        if command.is_empty() {
            continue;
        }
        let active_page = normalize_web_codex_page(item.active_page.as_deref());
        watchdog.record_local_task(
            UiWatchdogRuntime {
                store: runtime.store,
                diagnostics_dir: runtime.diagnostics_dir,
            },
            UiWatchdogLocalTask {
                command: &command,
                elapsed_ms: item.elapsed_ms,
                fields: item.fields,
            },
            UiWatchdogPageState {
                active_page: &active_page,
                visible: item.visible.unwrap_or(true),
            },
            now,
        );
        accepted = accepted.saturating_add(1);
    }

    for item in payload.long_tasks.into_iter().take(64) {
        let active_page = normalize_web_codex_page(item.active_page.as_deref());
        watchdog.record_long_task(
            UiWatchdogRuntime {
                store: runtime.store,
                diagnostics_dir: runtime.diagnostics_dir,
            },
            item.elapsed_ms,
            UiWatchdogPageState {
                active_page: &active_page,
                visible: item.visible.unwrap_or(true),
            },
            now,
        );
        accepted = accepted.saturating_add(1);
    }

    for item in payload.frame_stalls.into_iter().take(64) {
        let active_page = normalize_web_codex_page(item.active_page.as_deref());
        let monitor_kind = item.monitor_kind.unwrap_or_else(|| "unknown".to_string());
        watchdog.record_frame_stall(
            UiWatchdogRuntime {
                store: runtime.store,
                diagnostics_dir: runtime.diagnostics_dir,
            },
            item.elapsed_ms,
            &monitor_kind,
            UiWatchdogPageState {
                active_page: &active_page,
                visible: item.visible.unwrap_or(true),
            },
            now,
        );
        accepted = accepted.saturating_add(1);
    }

    for item in payload.frontend_errors.into_iter().take(64) {
        let message = item.message.trim().to_string();
        if message.is_empty() {
            continue;
        }
        let active_page = normalize_web_codex_page(item.active_page.as_deref());
        let kind = item.kind.unwrap_or_else(|| "error".to_string());
        watchdog.record_frontend_error(
            UiWatchdogRuntime {
                store: runtime.store,
                diagnostics_dir: runtime.diagnostics_dir,
            },
            &kind,
            &message,
            UiWatchdogPageState {
                active_page: &active_page,
                visible: item.visible.unwrap_or(true),
            },
            now,
        );
        accepted = accepted.saturating_add(1);
    }

    Json(json!({ "ok": true, "accepted": accepted })).into_response()
}

pub(super) async fn codex_live_debug(
    State(st): State<GatewayState>,
    headers: HeaderMap,
) -> Response {
    if let Some(resp) = require_codex_auth(&st, &headers) {
        return resp;
    }
    Json(json!({
        "backend": backend_live_debug_snapshot_value(),
        "app": crate::codex_app_server::debug_snapshot().await,
        "traceFile": super::web_codex_storage::codex_live_trace_file_path()
            .ok()
            .map(|path| path.display().to_string())
            .unwrap_or_default(),
    }))
    .into_response()
}

pub(super) async fn codex_live_debug_client(
    State(st): State<GatewayState>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> Response {
    if let Some(resp) = require_codex_auth(&st, &headers) {
        return resp;
    }
    let events = payload
        .get("events")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let session_id = payload
        .get("sessionId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let page = payload
        .get("page")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let accepted = events.len();
    for value in events {
        let _ = super::web_codex_storage::append_codex_live_trace_entry(&json!({
            "source": "client.ui",
            "sessionId": session_id,
            "page": page,
            "entry": value,
        }));
    }
    Json(json!({ "ok": true, "accepted": accepted })).into_response()
}

#[cfg(test)]
#[allow(clippy::await_holding_lock)]
mod tests {
    use super::*;
    use crate::codex_home_env::CodexHomeEnvGuard;
    use crate::orchestrator::config::AppConfig;
    use crate::orchestrator::router::RouterState;
    use crate::orchestrator::secrets::SecretStore;
    use crate::orchestrator::store::unix_ms;
    use crate::orchestrator::upstream::UpstreamClient;
    use futures_util::SinkExt;
    use parking_lot::RwLock;
    use std::collections::HashMap;
    use std::io::Write;
    use std::sync::atomic::AtomicU64;
    use std::sync::Arc;
    use tokio::net::TcpListener;
    use tokio::time::{Duration, Instant};
    use tokio_tungstenite::connect_async;
    use tokio_tungstenite::tungstenite::Message as WsMessage;

    fn build_test_gateway_state(tmp: &tempfile::TempDir) -> GatewayState {
        let store = open_store_dir(tmp.path().join("data")).expect("store");
        let secrets = SecretStore::new(tmp.path().join("secrets.json"));
        secrets
            .set_gateway_token("test-token")
            .expect("set gateway token");
        let cfg = AppConfig::default_config();
        let router = Arc::new(RouterState::new(&cfg, unix_ms()));
        GatewayState {
            cfg: Arc::new(RwLock::new(cfg)),
            router,
            store,
            upstream: UpstreamClient::new(),
            secrets,
            last_activity_unix_ms: Arc::new(AtomicU64::new(0)),
            last_used_by_session: Arc::new(RwLock::new(HashMap::new())),
            usage_base_speed_cache: Arc::new(RwLock::new(HashMap::new())),
            prev_id_support_cache: Arc::new(RwLock::new(HashMap::new())),
            client_sessions: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    fn append_rollout_line(path: &std::path::Path, value: Value) {
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(path)
            .expect("open rollout");
        writeln!(file, "{value}").expect("append rollout line");
        file.flush().expect("flush rollout");
    }

    #[tokio::test]
    async fn codex_ui_diagnostics_records_web_codex_watchdog_heartbeat() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let state = build_test_gateway_state(&tmp);
        let listen_port = state.cfg.read().listen.port;
        crate::lan_sync::register_ui_watchdog_state(
            listen_port,
            crate::app_state::UiWatchdogState::default(),
        );
        let mut headers = HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            "Bearer test-token".parse().expect("auth header"),
        );

        let response = codex_ui_diagnostics(
            State(state),
            headers,
            Json(WebCodexUiDiagnosticsRequest {
                heartbeat: Some(WebCodexUiHeartbeatRecord {
                    active_page: Some("settings".to_string()),
                    visible: Some(true),
                    status_in_flight: Some(false),
                    config_in_flight: Some(false),
                    provider_switch_in_flight: Some(true),
                }),
                traces: vec![],
                invoke_results: vec![WebCodexUiInvokeResultRecord {
                    command: "GET /codex/provider-switchboard".to_string(),
                    elapsed_ms: 42,
                    ok: true,
                    error_message: None,
                    active_page: Some("settings".to_string()),
                    visible: Some(true),
                }],
                local_tasks: vec![],
                long_tasks: vec![],
                frame_stalls: vec![],
                frontend_errors: vec![],
            }),
        )
        .await;

        assert_eq!(response.status(), StatusCode::OK);
        let snapshot = crate::lan_sync::current_ui_watchdog_live_snapshot(listen_port, unix_ms())
            .expect("watchdog snapshot");
        assert_eq!(snapshot.frontend.active_page, "codex-web:settings");
        assert!(snapshot.frontend.provider_switch_in_flight);
        assert!(!snapshot.frontend.stalled);
    }

    async fn recv_ws_json(
        socket: &mut tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
    ) -> Value {
        loop {
            let next = tokio::time::timeout(Duration::from_secs(5), socket.next())
                .await
                .expect("ws receive timeout")
                .expect("ws closed")
                .expect("ws message");
            match next {
                WsMessage::Text(text) => {
                    return serde_json::from_str(&text).expect("valid ws json");
                }
                WsMessage::Binary(bytes) => {
                    return serde_json::from_slice(&bytes).expect("valid ws binary json");
                }
                WsMessage::Ping(_) | WsMessage::Pong(_) => continue,
                WsMessage::Close(frame) => panic!("unexpected websocket close: {frame:?}"),
                other => panic!("unexpected websocket message: {other:?}"),
            }
        }
    }

    async fn recv_matching_ws_json(
        socket: &mut tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
        expected_id: serde_json::Value,
    ) -> Value {
        loop {
            let value = recv_ws_json(socket).await;
            if value.get("id") == Some(&expected_id) {
                return value;
            }
        }
    }

    #[test]
    fn backend_live_debug_keeps_recent_events_bounded() {
        {
            let mut guard = backend_live_debug_state().lock();
            guard.recent.clear();
            guard.active_connections = 0;
            guard.subscribed_connections = 0;
            guard.total_connections = 0;
        }
        for index in 0..(BACKEND_LIVE_DEBUG_MAX_EVENTS + 8) {
            backend_live_debug_push("test.event", json!({ "index": index }));
        }
        let snapshot = backend_live_debug_snapshot_value();
        let recent = snapshot
            .get("recent")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        assert_eq!(recent.len(), BACKEND_LIVE_DEBUG_MAX_EVENTS);
        assert_eq!(
            recent
                .first()
                .and_then(|value| value.get("index"))
                .and_then(Value::as_u64),
            Some(8)
        );
    }

    #[test]
    fn workspace_targets_from_ws_payload_reads_workspace_hints() {
        assert_eq!(
            workspace_targets_from_ws_payload(&json!({
                "payload": { "workspace": "wsl2" }
            })),
            vec![WorkspaceTarget::Wsl2]
        );
        assert_eq!(
            workspace_targets_from_ws_payload(&json!({
                "payload": { "workspace": "windows" }
            })),
            vec![WorkspaceTarget::Windows]
        );
        assert_eq!(
            workspace_targets_from_ws_payload(&json!({
                "payload": { "workspace": "all" }
            })),
            vec![WorkspaceTarget::Windows, WorkspaceTarget::Wsl2]
        );
        assert_eq!(
            workspace_targets_from_ws_payload(&json!({
                "payload": { "workspaces": ["wsl2", "windows", "wsl2"] }
            })),
            vec![WorkspaceTarget::Wsl2, WorkspaceTarget::Windows]
        );
        assert_eq!(
            workspace_targets_from_ws_payload(&json!({ "payload": {} })),
            vec![WorkspaceTarget::Windows]
        );
    }

    #[cfg(target_os = "windows")]
    #[tokio::test]
    async fn websocket_subscription_replays_dual_workspace_notifications() {
        let _guard = crate::codex_app_server::lock_test_globals();
        crate::codex_app_server::_clear_notifications_for_test().await;
        crate::codex_app_server::_set_test_request_handler(Some(Arc::new(
            |_home, method, _params| match method {
                "bridge/approvals/list"
                | "approvals/list"
                | "bridge/userInput/list"
                | "userInput/list"
                | "request_user_input/list" => Ok(json!([])),
                other => Err(format!("unsupported test rpc method: {other}")),
            },
        )))
        .await;
        crate::codex_wsl_bridge::_set_test_replay_handler(Some(Arc::new(
            |_codex_home, since_event_id, max| {
                let mut items = Vec::new();
                if since_event_id < 1 {
                    items.push(json!({
                        "eventId": 1,
                        "method": "turn/started",
                        "params": { "threadId": "thread-wsl-dual" }
                    }));
                }
                if since_event_id < 2 {
                    items.push(json!({
                        "eventId": 2,
                        "method": "codex/event/response_item",
                        "params": {
                            "payload": {
                                "type": "message",
                                "thread_id": "thread-wsl-dual",
                                "phase": "final_answer",
                                "content": [{ "type": "output_text", "text": "wsl dual final" }]
                            }
                        }
                    }));
                }
                if since_event_id < 3 {
                    items.push(json!({
                        "eventId": 3,
                        "method": "turn/completed",
                        "params": { "threadId": "thread-wsl-dual" }
                    }));
                }
                items.truncate(max);
                let first = items
                    .first()
                    .and_then(|value| value.get("eventId"))
                    .and_then(Value::as_u64);
                let last = items
                    .last()
                    .and_then(|value| value.get("eventId"))
                    .and_then(Value::as_u64);
                (items, first, last, false)
            },
        )))
        .await;

        let tmp = tempfile::tempdir().expect("tempdir");
        let win_home = tmp.path().join("codex-home");
        let sessions_dir = win_home.join("sessions").join("2026").join("03").join("20");
        std::fs::create_dir_all(&sessions_dir).expect("create windows sessions dir");
        let rollout_path = sessions_dir.join("rollout-2026-03-20T00-00-00-thread-dual.jsonl");
        std::fs::write(
            &rollout_path,
            "{\"type\":\"session_meta\",\"payload\":{\"id\":\"thread-win-dual\",\"cwd\":\"C:/repo\"}}\n",
        )
        .expect("seed windows rollout");
        let prev_win_home = std::env::var("API_ROUTER_WEB_CODEX_CODEX_HOME").ok();
        let prev_wsl_home = std::env::var("API_ROUTER_WEB_CODEX_WSL_CODEX_HOME").ok();
        unsafe {
            std::env::set_var("API_ROUTER_WEB_CODEX_CODEX_HOME", &win_home);
            std::env::set_var("API_ROUTER_WEB_CODEX_WSL_CODEX_HOME", "/home/test/.codex");
        }

        let state = build_test_gateway_state(&tmp);
        let app = build_router(state);
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind listener");
        let addr = listener.local_addr().expect("listener addr");
        let server = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        let test_result = tokio::time::timeout(Duration::from_secs(10), async {
            let ws_url = format!("ws://127.0.0.1:{}/codex/ws?token=test-token", addr.port());
            let (mut socket, _) = connect_async(&ws_url).await.expect("connect ws");
            socket
                .send(WsMessage::Text(
                    json!({
                        "type": "subscribe.events",
                        "reqId": "sub-dual",
                        "payload": {
                            "workspace": "all",
                            "workspaces": ["windows", "wsl2"],
                            "lastEventId": 0
                        }
                    })
                    .to_string(),
                ))
                .await
                .expect("send subscribe");

            let mut saw_subscribed = false;
            let subscribe_deadline = Instant::now() + Duration::from_secs(5);
            while !saw_subscribed && Instant::now() < subscribe_deadline {
                let value = recv_ws_json(&mut socket).await;
                match value.get("type").and_then(Value::as_str) {
                    Some("subscribed") => {
                        saw_subscribed = true;
                        assert_eq!(
                            value
                                .get("payload")
                                .and_then(|payload| payload.get("workspace"))
                                .and_then(Value::as_str),
                            Some("all")
                        );
                    }
                    Some("events.snapshot")
                    | Some("rpc.notification")
                    | Some("approval.requested")
                    | Some("user_input.requested") => {}
                    other => panic!("unexpected subscribe ws message: {other:?}"),
                }
            }
            assert!(saw_subscribed, "expected dual subscribed ack");

            append_rollout_line(
                &rollout_path,
                json!({
                    "type": "event_msg",
                    "payload": {
                        "type": "turn_started",
                        "thread_id": "thread-win-dual",
                        "turn_id": "turn-win-dual-1"
                    }
                }),
            );
            append_rollout_line(
                &rollout_path,
                json!({
                    "type": "response_item",
                    "payload": {
                        "type": "message",
                        "id": "final-win-dual-1",
                        "role": "assistant",
                        "thread_id": "thread-win-dual",
                        "phase": "final_answer",
                        "content": [
                            { "type": "output_text", "text": "windows dual final" }
                        ]
                    }
                }),
            );
            append_rollout_line(
                &rollout_path,
                json!({
                    "type": "event_msg",
                    "payload": {
                        "type": "turn_complete",
                        "thread_id": "thread-win-dual",
                        "turn_id": "turn-win-dual-1"
                    }
                }),
            );

            let deadline = Instant::now() + Duration::from_secs(6);
            let mut payloads = Vec::new();
            let mut saw_thread_win = false;
            let mut saw_thread_wsl = false;
            let mut saw_workspace_win = false;
            let mut saw_workspace_wsl = false;
            while Instant::now() < deadline
                && !(saw_thread_win && saw_thread_wsl && saw_workspace_win && saw_workspace_wsl)
            {
                let value = recv_ws_json(&mut socket).await;
                if value.get("type").and_then(Value::as_str) != Some("rpc.notification") {
                    continue;
                }
                let payload = value.get("payload").cloned().unwrap_or(Value::Null);
                let payload_text =
                    serde_json::to_string(&payload).expect("serialize notification payload");
                saw_thread_win |= payload_text.contains("thread-win-dual");
                saw_thread_wsl |= payload_text.contains("thread-wsl-dual");
                saw_workspace_win |= payload_text.contains("\"workspace\":\"windows\"");
                saw_workspace_wsl |= payload_text.contains("\"workspace\":\"wsl2\"");
                payloads.push(payload);
            }

            let payload_text = serde_json::to_string(&payloads).expect("serialize payloads");
            assert!(
                saw_thread_win,
                "missing windows thread notification: {payload_text}"
            );
            assert!(
                saw_thread_wsl,
                "missing wsl thread notification: {payload_text}"
            );
            assert!(
                saw_workspace_win,
                "missing windows workspace notification: {payload_text}"
            );
            assert!(
                saw_workspace_wsl,
                "missing wsl workspace notification: {payload_text}"
            );

            drop(socket);
        })
        .await;

        server.abort();
        crate::codex_app_server::_set_test_request_handler(None).await;
        crate::codex_wsl_bridge::_set_test_replay_handler(None).await;
        crate::codex_app_server::_clear_notifications_for_test().await;
        if let Some(prev) = prev_win_home {
            unsafe {
                std::env::set_var("API_ROUTER_WEB_CODEX_CODEX_HOME", prev);
            }
        } else {
            unsafe {
                std::env::remove_var("API_ROUTER_WEB_CODEX_CODEX_HOME");
            }
        }
        if let Some(prev) = prev_wsl_home {
            unsafe {
                std::env::set_var("API_ROUTER_WEB_CODEX_WSL_CODEX_HOME", prev);
            }
        } else {
            unsafe {
                std::env::remove_var("API_ROUTER_WEB_CODEX_WSL_CODEX_HOME");
            }
        }
        test_result.expect("dual workspace websocket integration timed out");
    }

    #[test]
    fn extract_notification_thread_id_for_debug_reads_wrapped_payload() {
        let thread_id = extract_notification_thread_id_for_debug(&json!({
            "method": "codex/event/agent_message",
            "params": {
                "payload": {
                    "type": "agent_message",
                    "thread_id": "thread-1",
                    "phase": "commentary",
                    "message": "thinking"
                }
            }
        }));
        assert_eq!(thread_id.as_deref(), Some("thread-1"));
    }

    #[test]
    fn reset_notification_cursor_when_client_cursor_is_ahead_of_backend_queue() {
        assert!(crate::orchestrator::gateway::web_codex_session_manager::should_reset_notification_cursor(
            14_549,
            Some(1),
            Some(108),
            false
        ));
        assert!(crate::orchestrator::gateway::web_codex_session_manager::should_reset_notification_cursor(14_549, None, None, false));
        assert!(!crate::orchestrator::gateway::web_codex_session_manager::should_reset_notification_cursor(
            7,
            Some(1),
            Some(108),
            false
        ));
        assert!(crate::orchestrator::gateway::web_codex_session_manager::should_reset_notification_cursor(
            7,
            Some(20),
            Some(108),
            true
        ));
    }

    #[tokio::test]
    #[ignore = "process-global Codex home and ws rollout integration"]
    async fn websocket_subscription_replays_external_rollout_notifications_in_terminal_order() {
        let _guard = crate::codex_app_server::lock_test_globals();
        crate::codex_app_server::_clear_notifications_for_test().await;
        crate::codex_app_server::_set_test_request_handler(Some(Arc::new(
            |_home, method, _params| match method {
                "bridge/approvals/list"
                | "approvals/list"
                | "bridge/userInput/list"
                | "userInput/list"
                | "request_user_input/list" => Ok(json!([])),
                other => Err(format!("unsupported test rpc method: {other}")),
            },
        )))
        .await;
        let tmp = tempfile::tempdir().expect("tempdir");
        let _codex_home = CodexHomeEnvGuard::set(tmp.path());
        let prev_web_home = std::env::var("API_ROUTER_WEB_CODEX_CODEX_HOME").ok();
        std::env::set_var("API_ROUTER_WEB_CODEX_CODEX_HOME", tmp.path());
        let sessions_dir = tmp
            .path()
            .join("sessions")
            .join("2026")
            .join("03")
            .join("17");
        std::fs::create_dir_all(&sessions_dir).expect("create sessions dir");
        let rollout_path = sessions_dir.join("rollout-2026-03-17T00-00-00-thread-seq.jsonl");
        std::fs::write(
            &rollout_path,
            "{\"type\":\"session_meta\",\"payload\":{\"id\":\"thread-seq\",\"cwd\":\"C:/repo\"}}\n",
        )
        .expect("seed rollout");

        let state = build_test_gateway_state(&tmp);
        let app = build_router(state);
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind listener");
        let addr = listener.local_addr().expect("listener addr");
        let server = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        let test_result = tokio::time::timeout(Duration::from_secs(20), async {
            let ws_url = format!("ws://127.0.0.1:{}/codex/ws?token=test-token", addr.port());
            let (mut socket, _) = connect_async(&ws_url).await.expect("connect ws");
            socket
                .send(WsMessage::Text(
                    json!({
                        "type": "subscribe.events",
                        "reqId": "sub-1",
                        "payload": {
                            "workspace": "windows",
                            "lastEventId": 0
                        }
                    })
                    .to_string(),
                ))
                .await
                .expect("send subscribe");

            let mut saw_snapshot = false;
            let mut saw_subscribed = false;
            let subscribe_deadline = Instant::now() + Duration::from_secs(5);
            while !(saw_snapshot && saw_subscribed) && Instant::now() < subscribe_deadline {
                let value = recv_ws_json(&mut socket).await;
                match value.get("type").and_then(Value::as_str) {
                    Some("events.snapshot") => saw_snapshot = true,
                    Some("subscribed") => saw_subscribed = true,
                    Some("approval.requested") | Some("user_input.requested") => {}
                    other => panic!("unexpected pre-notification ws message: {other:?}"),
                }
            }
            assert!(saw_snapshot, "expected initial events.snapshot");
            assert!(saw_subscribed, "expected subscribed ack");

            append_rollout_line(
                &rollout_path,
                json!({
                    "type": "event_msg",
                    "payload": {
                        "type": "turn_started",
                        "thread_id": "thread-seq",
                        "turn_id": "turn-seq-1"
                    }
                }),
            );
            append_rollout_line(
                &rollout_path,
                json!({
                    "type": "response_item",
                    "payload": {
                        "type": "message",
                        "id": "reasoning-1",
                        "role": "assistant",
                        "thread_id": "thread-seq",
                        "phase": "commentary",
                        "content": [
                            { "type": "output_text", "text": "Inspecting workspace state" }
                        ]
                    }
                }),
            );
            append_rollout_line(
                &rollout_path,
                json!({
                    "type": "response_item",
                    "payload": {
                        "type": "function_call",
                        "call_id": "call-1",
                        "thread_id": "thread-seq",
                        "name": "shell_command",
                        "arguments": "{\"command\":\"pwd\"}"
                    }
                }),
            );
            append_rollout_line(
                &rollout_path,
                json!({
                    "type": "response_item",
                    "payload": {
                        "type": "message",
                        "id": "final-1",
                        "role": "assistant",
                        "thread_id": "thread-seq",
                        "phase": "final_answer",
                        "content": [
                            { "type": "output_text", "text": "Done." }
                        ]
                    }
                }),
            );
            append_rollout_line(
                &rollout_path,
                json!({
                    "type": "response_item",
                    "payload": {
                        "type": "function_call_output",
                        "thread_id": "thread-seq",
                        "call_id": "call-1",
                        "output": "{\"output\":\"C:/repo\",\"metadata\":{\"exit_code\":0}}"
                    }
                }),
            );
            append_rollout_line(
                &rollout_path,
                json!({
                    "type": "event_msg",
                    "payload": {
                        "type": "turn_complete",
                        "thread_id": "thread-seq",
                        "turn_id": "turn-seq-1"
                    }
                }),
            );

            let deadline = Instant::now() + Duration::from_secs(6);
            let mut methods = Vec::new();
            let mut payloads = Vec::new();
            while methods.len() < 8 && Instant::now() < deadline {
                let value = recv_ws_json(&mut socket).await;
                if value.get("type").and_then(Value::as_str) != Some("rpc.notification") {
                    continue;
                }
                let payload = value.get("payload").cloned().unwrap_or(Value::Null);
                let method = payload
                    .get("method")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                methods.push(method);
                payloads.push(payload);
            }

            assert_eq!(
                methods,
                vec![
                    "turn/started",
                    "thread/status/changed",
                    "codex/event/response_item",
                    "item/started",
                    "codex/event/response_item",
                    "item/completed",
                    "turn/completed",
                    "thread/status/changed",
                ]
            );
            assert_eq!(
                payloads[0]
                    .get("params")
                    .and_then(|value| value.get("thread_id"))
                    .and_then(Value::as_str),
                Some("thread-seq")
            );
            assert_eq!(
                payloads[2]
                    .get("params")
                    .and_then(|value| value.get("payload"))
                    .and_then(|value| value.get("phase"))
                    .and_then(Value::as_str),
                Some("commentary")
            );
            assert_eq!(
                payloads[3]
                    .get("params")
                    .and_then(|value| value.get("item"))
                    .and_then(|value| value.get("command"))
                    .and_then(Value::as_str),
                Some("pwd")
            );
            assert_eq!(
                payloads[4]
                    .get("params")
                    .and_then(|value| value.get("payload"))
                    .and_then(|value| value.get("phase"))
                    .and_then(Value::as_str),
                Some("final_answer")
            );
            assert_eq!(
                payloads[5]
                    .get("params")
                    .and_then(|value| value.get("item"))
                    .and_then(|value| value.get("status"))
                    .and_then(Value::as_str),
                Some("completed")
            );

            drop(socket);
        })
        .await;

        server.abort();
        crate::codex_app_server::_set_test_request_handler(None).await;
        crate::codex_app_server::_clear_notifications_for_test().await;
        if let Some(prev) = prev_web_home {
            std::env::set_var("API_ROUTER_WEB_CODEX_CODEX_HOME", prev);
        } else {
            std::env::remove_var("API_ROUTER_WEB_CODEX_CODEX_HOME");
        }
        test_result.expect("websocket rollout integration timed out");
    }

    #[cfg(target_os = "windows")]
    #[tokio::test]
    #[ignore = "requires local WSL filesystem and ws rollout integration"]
    async fn websocket_subscription_replays_wsl_rollout_notifications_from_linux_home() {
        let _guard = crate::codex_app_server::lock_test_globals();
        crate::codex_app_server::_clear_notifications_for_test().await;
        crate::codex_app_server::_set_test_request_handler(Some(Arc::new(
            |_home, method, _params| match method {
                "bridge/approvals/list"
                | "approvals/list"
                | "bridge/userInput/list"
                | "userInput/list"
                | "request_user_input/list" => Ok(json!([])),
                other => Err(format!("unsupported test rpc method: {other}")),
            },
        )))
        .await;

        let (distro, linux_home) =
            crate::orchestrator::gateway::web_codex_home::resolve_wsl_identity()
                .expect("resolve wsl identity");
        let prev_wsl_home = std::env::var("API_ROUTER_WEB_CODEX_WSL_CODEX_HOME").ok();
        unsafe {
            std::env::set_var("API_ROUTER_WEB_CODEX_WSL_CODEX_HOME", &linux_home);
        }
        let sessions_dir = crate::orchestrator::gateway::web_codex_home::linux_path_to_unc(
            &format!("{linux_home}/sessions/2026/03/18"),
            &distro,
        );
        std::fs::create_dir_all(&sessions_dir).expect("create wsl sessions dir");
        let rollout_path = sessions_dir.join(format!(
            "rollout-2026-03-18T00-00-00-wsl-live-{}.jsonl",
            uuid::Uuid::new_v4()
        ));
        std::fs::write(
            &rollout_path,
            "{\"type\":\"session_meta\",\"payload\":{\"id\":\"thread-wsl-seq\",\"cwd\":\"/home/yiyou/project\"}}\n",
        )
        .expect("seed wsl rollout");

        let tmp = tempfile::tempdir().expect("tempdir");
        let state = build_test_gateway_state(&tmp);
        let app = build_router(state);
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind listener");
        let addr = listener.local_addr().expect("listener addr");
        let server = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        let test_result = tokio::time::timeout(Duration::from_secs(20), async {
            let ws_url = format!("ws://127.0.0.1:{}/codex/ws?token=test-token", addr.port());
            let (mut socket, _) = connect_async(&ws_url).await.expect("connect ws");
            socket
                .send(WsMessage::Text(
                    json!({
                        "type": "subscribe.events",
                        "reqId": "sub-wsl",
                        "payload": {
                            "workspace": "wsl2",
                            "lastEventId": 0
                        }
                    })
                    .to_string(),
                ))
                .await
                .expect("send subscribe");

            let mut saw_snapshot = false;
            let mut saw_subscribed = false;
            let subscribe_deadline = Instant::now() + Duration::from_secs(5);
            while !(saw_snapshot && saw_subscribed) && Instant::now() < subscribe_deadline {
                let value = recv_ws_json(&mut socket).await;
                match value.get("type").and_then(Value::as_str) {
                    Some("events.snapshot") => saw_snapshot = true,
                    Some("subscribed") => {
                        saw_subscribed = true;
                        assert_eq!(
                            value
                                .get("payload")
                                .and_then(|payload| payload.get("workspace"))
                                .and_then(Value::as_str),
                            Some("wsl2")
                        );
                    }
                    Some("rpc.notification") => {}
                    Some("approval.requested") | Some("user_input.requested") => {}
                    other => panic!("unexpected pre-notification ws message: {other:?}"),
                }
            }
            assert!(saw_snapshot, "expected initial events.snapshot");
            assert!(saw_subscribed, "expected subscribed ack");

            append_rollout_line(
                &rollout_path,
                json!({
                    "type": "event_msg",
                    "payload": {
                        "type": "turn_started",
                        "thread_id": "thread-wsl-seq",
                        "turn_id": "turn-wsl-1"
                    }
                }),
            );
            append_rollout_line(
                &rollout_path,
                json!({
                    "type": "response_item",
                    "payload": {
                        "type": "message",
                        "id": "final-wsl-1",
                        "role": "assistant",
                        "thread_id": "thread-wsl-seq",
                        "phase": "final_answer",
                        "content": [
                            { "type": "output_text", "text": "wsl live final" }
                        ]
                    }
                }),
            );
            append_rollout_line(
                &rollout_path,
                json!({
                    "type": "event_msg",
                    "payload": {
                        "type": "turn_complete",
                        "thread_id": "thread-wsl-seq",
                        "turn_id": "turn-wsl-1"
                    }
                }),
            );

            let deadline = Instant::now() + Duration::from_secs(6);
            let mut methods = Vec::new();
            while methods.len() < 5 && Instant::now() < deadline {
                let value = recv_ws_json(&mut socket).await;
                if value.get("type").and_then(Value::as_str) != Some("rpc.notification") {
                    continue;
                }
                let payload = value.get("payload").cloned().unwrap_or(Value::Null);
                methods.push(
                    payload
                        .get("method")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                );
            }

            assert_eq!(
                methods,
                vec![
                    "turn/started",
                    "thread/status/changed",
                    "codex/event/response_item",
                    "turn/completed",
                    "thread/status/changed",
                ]
            );
        })
        .await;

        server.abort();
        let _ = std::fs::remove_file(&rollout_path);
        crate::codex_app_server::_set_test_request_handler(None).await;
        crate::codex_app_server::_clear_notifications_for_test().await;
        if let Some(prev) = prev_wsl_home {
            unsafe {
                std::env::set_var("API_ROUTER_WEB_CODEX_WSL_CODEX_HOME", prev);
            }
        } else {
            unsafe {
                std::env::remove_var("API_ROUTER_WEB_CODEX_WSL_CODEX_HOME");
            }
        }
        test_result.expect("wsl websocket rollout integration timed out");
    }

    #[tokio::test]
    async fn app_server_websocket_proxy_forwards_requests_and_replays_notifications() {
        let _guard = crate::codex_app_server::lock_test_globals();
        crate::codex_app_server::_clear_notifications_for_test().await;
        let tmp = tempfile::tempdir().expect("tempdir");
        let home = tmp.path().join("codex-home");
        std::fs::create_dir_all(&home).expect("create codex home");
        let home_text = home.to_string_lossy().to_string();
        crate::codex_app_server::_set_test_request_handler(Some(Arc::new({
            let home_text = home_text.clone();
            move |codex_home, method, params| match method {
                "thread/read" => {
                    assert_eq!(codex_home, Some(home_text.as_str()));
                    assert_eq!(params.get("id").and_then(Value::as_str), Some("thread-1"));
                    Ok(json!({ "thread": { "id": "thread-1" } }))
                }
                other => Err(format!("unsupported test rpc method: {other}")),
            }
        })))
        .await;
        let state = build_test_gateway_state(&tmp);
        let app = build_router(state);
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind listener");
        let addr = listener.local_addr().expect("listener addr");
        let server = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        let test_result = tokio::time::timeout(Duration::from_secs(10), async {
            let home_query = urlencoding::encode(&home_text);
            let ws_url = format!(
                "ws://127.0.0.1:{}/codex/app-server/ws?token=test-token&home={}",
                addr.port(),
                home_query
            );
            let (mut socket, _) = connect_async(&ws_url).await.expect("connect ws");

            socket
                .send(WsMessage::Text(
                    json!({
                        "id": 1,
                        "method": "initialize",
                        "params": {
                            "clientInfo": {
                                "name": "codex-tui",
                                "version": "test"
                            }
                        }
                    })
                    .to_string(),
                ))
                .await
                .expect("send initialize");
            let init = recv_matching_ws_json(&mut socket, json!(1)).await;
            assert_eq!(
                init.get("result")
                    .and_then(|value| value.get("platformOs"))
                    .and_then(Value::as_str),
                Some(std::env::consts::OS)
            );

            socket
                .send(WsMessage::Text(
                    json!({
                        "method": "initialized",
                        "params": {}
                    })
                    .to_string(),
                ))
                .await
                .expect("send initialized");

            crate::codex_app_server::_push_notification_for_test(
                Some(&home_text),
                json!({
                    "method": "turn/started",
                    "params": {
                        "threadId": "thread-1"
                    }
                }),
            )
            .await;
            let notif = recv_ws_json(&mut socket).await;
            assert_eq!(
                notif.get("method").and_then(Value::as_str),
                Some("turn/started")
            );
            assert!(notif.get("eventId").is_none());

            socket
                .send(WsMessage::Text(
                    json!({
                        "id": 2,
                        "method": "thread/read",
                        "params": {
                            "id": "thread-1"
                        }
                    })
                    .to_string(),
                ))
                .await
                .expect("send thread/read");
            let response = recv_matching_ws_json(&mut socket, json!(2)).await;
            assert_eq!(
                response
                    .get("result")
                    .and_then(|value| value.get("thread"))
                    .and_then(|value| value.get("id"))
                    .and_then(Value::as_str),
                Some("thread-1")
            );

            drop(socket);
        })
        .await;

        server.abort();
        crate::codex_app_server::_set_test_request_handler(None).await;
        crate::codex_app_server::_clear_notifications_for_test().await;
        test_result.expect("app-server websocket proxy timed out");
    }

    #[tokio::test]
    async fn app_server_websocket_root_route_forwards_requests_and_replays_notifications() {
        let _guard = crate::codex_app_server::lock_test_globals();
        crate::codex_app_server::_clear_notifications_for_test().await;
        let tmp = tempfile::tempdir().expect("tempdir");
        let home = tmp.path().join("codex-home");
        std::fs::create_dir_all(&home).expect("create codex home");
        let home_text = home.to_string_lossy().to_string();
        crate::codex_app_server::_set_test_request_handler(Some(Arc::new({
            let home_text = home_text.clone();
            move |codex_home, method, params| match method {
                "thread/read" => {
                    assert_eq!(codex_home, Some(home_text.as_str()));
                    assert_eq!(params.get("id").and_then(Value::as_str), Some("thread-1"));
                    Ok(json!({ "thread": { "id": "thread-1" } }))
                }
                other => Err(format!("unsupported test rpc method: {other}")),
            }
        })))
        .await;
        let state = build_test_gateway_state(&tmp);
        let app = build_router(state);
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind listener");
        let addr = listener.local_addr().expect("listener addr");
        let server = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        let test_result = tokio::time::timeout(Duration::from_secs(10), async {
            let home_query = urlencoding::encode(&home_text);
            let ws_url = format!(
                "ws://127.0.0.1:{}/?token=test-token&home={}",
                addr.port(),
                home_query
            );
            let (mut socket, _) = connect_async(&ws_url).await.expect("connect ws");

            socket
                .send(WsMessage::Text(
                    json!({
                        "id": 1,
                        "method": "initialize",
                        "params": {
                            "clientInfo": {
                                "name": "codex-tui",
                                "version": "test"
                            }
                        }
                    })
                    .to_string(),
                ))
                .await
                .expect("send initialize");
            let init = recv_matching_ws_json(&mut socket, json!(1)).await;
            assert_eq!(
                init.get("result")
                    .and_then(|value| value.get("platformOs"))
                    .and_then(Value::as_str),
                Some(std::env::consts::OS)
            );

            socket
                .send(WsMessage::Text(
                    json!({
                        "method": "initialized",
                        "params": {}
                    })
                    .to_string(),
                ))
                .await
                .expect("send initialized");

            crate::codex_app_server::_push_notification_for_test(
                Some(&home_text),
                json!({
                    "method": "turn/started",
                    "params": {
                        "threadId": "thread-1"
                    }
                }),
            )
            .await;
            let notif = recv_ws_json(&mut socket).await;
            assert_eq!(
                notif.get("method").and_then(Value::as_str),
                Some("turn/started")
            );
            assert!(notif.get("eventId").is_none());

            socket
                .send(WsMessage::Text(
                    json!({
                        "id": 2,
                        "method": "thread/read",
                        "params": {
                            "id": "thread-1"
                        }
                    })
                    .to_string(),
                ))
                .await
                .expect("send thread/read");
            let response = recv_matching_ws_json(&mut socket, json!(2)).await;
            assert_eq!(
                response
                    .get("result")
                    .and_then(|value| value.get("thread"))
                    .and_then(|value| value.get("id"))
                    .and_then(Value::as_str),
                Some("thread-1")
            );

            drop(socket);
        })
        .await;

        server.abort();
        crate::codex_app_server::_set_test_request_handler(None).await;
        crate::codex_app_server::_clear_notifications_for_test().await;
        test_result.expect("app-server root route timed out");
    }

    #[tokio::test]
    async fn app_server_websocket_thread_start_strips_extended_history_flags() {
        let _guard = crate::codex_app_server::lock_test_globals();
        crate::codex_app_server::_clear_notifications_for_test().await;
        crate::codex_app_server::_set_test_request_handler(Some(Arc::new(
            move |_codex_home, method, params| match method {
                "thread/start" => {
                    assert!(params.get("persistExtendedHistory").is_none());
                    assert!(params.get("persistFullHistory").is_none());
                    assert_eq!(params.get("model").and_then(Value::as_str), Some("gpt-5.4"));
                    Ok(json!({ "thread": { "id": "thread-1" } }))
                }
                other => Err(format!("unsupported test rpc method: {other}")),
            },
        )))
        .await;
        let tmp = tempfile::tempdir().expect("tempdir");
        let state = build_test_gateway_state(&tmp);
        let app = build_router(state);
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind listener");
        let addr = listener.local_addr().expect("listener addr");
        let server = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        let test_result = tokio::time::timeout(Duration::from_secs(10), async {
            let ws_url = format!("ws://127.0.0.1:{}/?token=test-token", addr.port());
            let (mut socket, _) = connect_async(&ws_url).await.expect("connect ws");

            socket
                .send(WsMessage::Text(
                    json!({
                        "id": 1,
                        "method": "initialize",
                        "params": {
                            "clientInfo": {
                                "name": "codex-tui",
                                "version": "test"
                            }
                        }
                    })
                    .to_string(),
                ))
                .await
                .expect("send initialize");
            let _ = recv_matching_ws_json(&mut socket, json!(1)).await;

            socket
                .send(WsMessage::Text(
                    json!({
                        "method": "initialized",
                        "params": {}
                    })
                    .to_string(),
                ))
                .await
                .expect("send initialized");

            socket
                .send(WsMessage::Text(
                    json!({
                        "id": 2,
                        "method": "thread/start",
                        "params": {
                            "model": "gpt-5.4",
                            "persistExtendedHistory": true,
                            "persistFullHistory": true
                        }
                    })
                    .to_string(),
                ))
                .await
                .expect("send thread/start");
            let response = recv_matching_ws_json(&mut socket, json!(2)).await;
            assert_eq!(
                response
                    .get("result")
                    .and_then(|value| value.get("thread"))
                    .and_then(|value| value.get("id"))
                    .and_then(Value::as_str),
                Some("thread-1")
            );

            drop(socket);
        })
        .await;

        server.abort();
        crate::codex_app_server::_set_test_request_handler(None).await;
        crate::codex_app_server::_clear_notifications_for_test().await;
        test_result.expect("app-server thread/start strip timed out");
    }

    #[tokio::test]
    async fn app_server_websocket_turn_start_strips_collaboration_mode() {
        let _guard = crate::codex_app_server::lock_test_globals();
        crate::codex_app_server::_clear_notifications_for_test().await;
        crate::codex_app_server::_set_test_request_handler(Some(Arc::new(
            move |_codex_home, method, params| match method {
                "turn/start" => {
                    assert!(params.get("collaborationMode").is_none());
                    assert!(params.get("collaboration_mode").is_none());
                    assert!(params.get("collaboration_mode_kind").is_none());
                    assert_eq!(
                        params.get("threadId").and_then(Value::as_str),
                        Some("thread-1")
                    );
                    Ok(json!({ "turn": { "id": "turn-1" } }))
                }
                other => Err(format!("unsupported test rpc method: {other}")),
            },
        )))
        .await;
        let tmp = tempfile::tempdir().expect("tempdir");
        let state = build_test_gateway_state(&tmp);
        let app = build_router(state);
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind listener");
        let addr = listener.local_addr().expect("listener addr");
        let server = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        let test_result = tokio::time::timeout(Duration::from_secs(10), async {
            let ws_url = format!("ws://127.0.0.1:{}/?token=test-token", addr.port());
            let (mut socket, _) = connect_async(&ws_url).await.expect("connect ws");

            socket
                .send(WsMessage::Text(
                    json!({
                        "id": 1,
                        "method": "initialize",
                        "params": {
                            "clientInfo": {
                                "name": "codex-tui",
                                "version": "test"
                            }
                        }
                    })
                    .to_string(),
                ))
                .await
                .expect("send initialize");
            let _ = recv_matching_ws_json(&mut socket, json!(1)).await;

            socket
                .send(WsMessage::Text(
                    json!({
                        "method": "initialized",
                        "params": {}
                    })
                    .to_string(),
                ))
                .await
                .expect("send initialized");

            socket
                .send(WsMessage::Text(
                    json!({
                        "id": 2,
                        "method": "turn/start",
                        "params": {
                            "threadId": "thread-1",
                            "collaborationMode": "plan",
                            "collaboration_mode_kind": "plan"
                        }
                    })
                    .to_string(),
                ))
                .await
                .expect("send turn/start");
            let response = recv_matching_ws_json(&mut socket, json!(2)).await;
            assert_eq!(
                response
                    .get("result")
                    .and_then(|value| value.get("turn"))
                    .and_then(|value| value.get("id"))
                    .and_then(Value::as_str),
                Some("turn-1")
            );

            drop(socket);
        })
        .await;

        server.abort();
        crate::codex_app_server::_set_test_request_handler(None).await;
        crate::codex_app_server::_clear_notifications_for_test().await;
        test_result.expect("app-server turn/start strip timed out");
    }

    #[test]
    fn normalizes_account_info_method_alias() {
        assert_eq!(
            normalize_remote_app_server_method("account-info"),
            "account/read"
        );
        assert_eq!(
            normalize_remote_app_server_method("account/read"),
            "account/read"
        );
    }
}
