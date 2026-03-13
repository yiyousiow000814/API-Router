use super::*;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::Query;
use futures_util::StreamExt;
use parking_lot::Mutex;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;

use self::web_codex_actions::{
    build_turn_start_params, build_turn_start_response, turn_thread_id, TurnStartRequest,
};
use self::web_codex_auth::{api_error, is_codex_ws_authorized, require_codex_auth, WsQuery};
use self::web_codex_home::{
    parse_workspace_target, web_codex_rpc_home_override_for_target, WorkspaceTarget,
};

const BACKEND_LIVE_DEBUG_MAX_EVENTS: usize = 160;

fn is_all_candidate_rpc_methods_unsupported(error: &str) -> bool {
    error
        .trim()
        .eq_ignore_ascii_case("all candidate rpc methods are marked unsupported")
}

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

fn backend_live_debug_subscribe(client_id: u64, last_event_id: u64) {
    let mut guard = backend_live_debug_state().lock();
    guard.subscribed_connections = guard.subscribed_connections.saturating_add(1);
    drop(guard);
    backend_live_debug_push(
        "backend.ws.subscribe",
        json!({ "clientId": client_id, "lastEventId": last_event_id }),
    );
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
        json!({
            "clientId": client_id,
            "method": method,
            "threadId": thread_id,
            "eventId": event_id,
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

fn should_reset_notification_cursor(
    since_event_id: u64,
    first_event_id: Option<u64>,
    last_event_id: Option<u64>,
    gap: bool,
) -> bool {
    if gap {
        return true;
    }
    if since_event_id == 0 {
        return false;
    }
    match (first_event_id, last_event_id) {
        (None, None) => true,
        (_, Some(last)) => since_event_id > last,
        (Some(first), None) => since_event_id < first,
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
    let home = web_codex_rpc_home_override_for_target(workspace_target);
    let result =
        crate::codex_app_server::request_in_home(home.as_deref(), "turn/start", params).await?;
    let completed = json!({
        "type": "completed",
        "reqId": req_id,
        "payload": build_turn_start_response(&thread_id, result)
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
) -> bool {
    let approvals = super::codex_try_request_with_fallback(
        &["bridge/approvals/list", "approvals/list"],
        Value::Null,
    )
    .await
    .unwrap_or_else(|error| {
        if is_all_candidate_rpc_methods_unsupported(&error) {
            json!([])
        } else {
            Value::Null
        }
    });
    let user_inputs = super::codex_try_request_with_fallback(
        &[
            "bridge/userInput/list",
            "userInput/list",
            "request_user_input/list",
        ],
        Value::Null,
    )
    .await
    .unwrap_or_else(|error| {
        if is_all_candidate_rpc_methods_unsupported(&error) {
            json!([])
        } else {
            Value::Null
        }
    });

    *approvals_sig = approvals.to_string();
    *user_input_sig = user_inputs.to_string();
    send_ws_json(
        socket,
        &json!({
            "type": "events.snapshot",
            "reqId": req_id,
            "payload": {
                "approvals": approvals,
                "userInputs": user_inputs
            }
        }),
    )
    .await
}

async fn codex_ws_poll_pending_events(
    socket: &mut WebSocket,
    approvals_sig: &mut String,
    user_input_sig: &mut String,
    notif_cursor: &mut u64,
    client_id: u64,
    workspace_target: Option<WorkspaceTarget>,
) -> bool {
    let approvals = super::codex_try_request_with_fallback(
        &["bridge/approvals/list", "approvals/list"],
        Value::Null,
    )
    .await;
    if let Ok(payload) = approvals {
        let sig = payload.to_string();
        if *approvals_sig != sig {
            *approvals_sig = sig;
            if !send_ws_json(
                socket,
                &json!({
                    "type": "approval.requested",
                    "payload": payload
                }),
            )
            .await
            {
                return false;
            }
        }
    } else if approvals
        .as_ref()
        .err()
        .is_some_and(|error| is_all_candidate_rpc_methods_unsupported(error))
    {
        let payload = json!([]);
        let sig = payload.to_string();
        if *approvals_sig != sig {
            *approvals_sig = sig;
            if !send_ws_json(
                socket,
                &json!({
                    "type": "approval.requested",
                    "payload": payload
                }),
            )
            .await
            {
                return false;
            }
        }
    }

    let user_inputs = super::codex_try_request_with_fallback(
        &[
            "bridge/userInput/list",
            "userInput/list",
            "request_user_input/list",
        ],
        Value::Null,
    )
    .await;
    if let Ok(payload) = user_inputs {
        let sig = payload.to_string();
        if *user_input_sig != sig {
            *user_input_sig = sig;
            if !send_ws_json(
                socket,
                &json!({
                    "type": "user_input.requested",
                    "payload": payload
                }),
            )
            .await
            {
                return false;
            }
        }
    } else if user_inputs
        .as_ref()
        .err()
        .is_some_and(|error| is_all_candidate_rpc_methods_unsupported(error))
    {
        let payload = json!([]);
        let sig = payload.to_string();
        if *user_input_sig != sig {
            *user_input_sig = sig;
            if !send_ws_json(
                socket,
                &json!({
                    "type": "user_input.requested",
                    "payload": payload
                }),
            )
            .await
            {
                return false;
            }
        }
    }

    let home = web_codex_rpc_home_override_for_target(workspace_target);
    if let Err(error) = crate::codex_app_server::ensure_server_in_home(home.as_deref()).await {
        backend_live_debug_push(
            "backend.ws.ensure_home_error",
            json!({
                "clientId": client_id,
                "workspace": match workspace_target {
                    Some(WorkspaceTarget::Wsl2) => "wsl2",
                    Some(WorkspaceTarget::Windows) => "windows",
                    None => "",
                },
                "home": home,
                "message": error,
            }),
        );
    }
    let (mut items, first, last, gap) =
        crate::codex_app_server::replay_notifications_since_in_home(
            home.as_deref(),
            *notif_cursor,
            64,
        )
        .await;
    if gap || !items.is_empty() {
        backend_live_debug_push(
            "backend.ws.poll",
            json!({
                "clientId": client_id,
                "cursor": *notif_cursor,
                "workspace": match workspace_target {
                    Some(WorkspaceTarget::Wsl2) => "wsl2",
                    Some(WorkspaceTarget::Windows) => "windows",
                    None => "",
                },
                "home": home,
                "count": items.len(),
                "firstEventId": first,
                "lastEventId": last,
                "gap": gap,
            }),
        );
    }
    if should_reset_notification_cursor(*notif_cursor, first, last, gap) {
        let _ = send_ws_json(
            socket,
            &json!({
                "type": "events.reset",
                "payload": {
                    "requestedSince": *notif_cursor,
                    "firstEventId": first,
                    "lastEventId": last
                }
            }),
        )
        .await;
        let requested_since = *notif_cursor;
        *notif_cursor = 0;
        let (replayed, _f2, _l2, _gap2) =
            crate::codex_app_server::replay_notifications_since_in_home(home.as_deref(), 0, 64)
                .await;
        items = replayed;
        backend_live_debug_push(
            "backend.ws.events_reset",
            json!({
                "clientId": client_id,
                "requestedSince": requested_since,
                "firstEventId": first,
                "lastEventId": last,
                "replayedCount": items.len(),
            }),
        );
    }
    for notif in items {
        if let Some(id) = notif.get("eventId").and_then(|v| v.as_u64()) {
            *notif_cursor = (*notif_cursor).max(id);
        }
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
    true
}

async fn codex_ws_loop(mut socket: WebSocket) {
    let client_id = next_backend_live_debug_client_id();
    backend_live_debug_connection_open(client_id);
    let mut subscribe_events = false;
    let mut approvals_sig = String::new();
    let mut user_input_sig = String::new();
    let mut notif_cursor: u64 = 0;
    let mut notif_workspace_target: Option<WorkspaceTarget> = None;
    let mut poll_tick = tokio::time::interval(std::time::Duration::from_millis(250));
    let close_reason = loop {
        tokio::select! {
            _ = poll_tick.tick() => {
                if subscribe_events
                    && !codex_ws_poll_pending_events(
                        &mut socket,
                        &mut approvals_sig,
                        &mut user_input_sig,
                        &mut notif_cursor,
                        client_id,
                        notif_workspace_target,
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
                                notif_workspace_target = workspace_target_from_ws_payload(&v);
                                notif_cursor = v
                                    .get("payload")
                                    .and_then(|p| p.get("lastEventId"))
                                    .and_then(|x| x.as_u64())
                                    .unwrap_or(0);
                                backend_live_debug_subscribe(client_id, notif_cursor);
                                let _ = codex_ws_poll_pending_events(
                                    &mut socket,
                                    &mut approvals_sig,
                                    &mut user_input_sig,
                                    &mut notif_cursor,
                                    client_id,
                                    notif_workspace_target,
                                )
                                .await;
                                let _ = codex_ws_emit_event_snapshot(
                                    &mut socket,
                                    &req_id,
                                    &mut approvals_sig,
                                    &mut user_input_sig,
                                )
                                .await;
                                let _ = send_ws_json(&mut socket, &json!({
                                    "type": "subscribed",
                                    "reqId": req_id,
                                    "payload": {
                                        "events": true,
                                        "workspace": match notif_workspace_target {
                                            Some(WorkspaceTarget::Wsl2) => "wsl2",
                                            _ => "windows",
                                        }
                                    }
                                }))
                                .await;
                            }
                            "events.refresh" => {
                                notif_workspace_target =
                                    workspace_target_from_ws_payload(&v).or(notif_workspace_target);
                                let _ = codex_ws_emit_event_snapshot(
                                    &mut socket,
                                    &req_id,
                                    &mut approvals_sig,
                                    &mut user_input_sig,
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
                                let home = crate::orchestrator::gateway::web_codex_home::web_codex_rpc_home_override();
                                let result = crate::codex_app_server::request_in_home(
                                    home.as_deref(),
                                    "turn/interrupt",
                                    json!({ "turnId": turn_id }),
                                )
                                .await;
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
                                let home = crate::orchestrator::gateway::web_codex_home::web_codex_rpc_home_override();
                                let result =
                                    crate::codex_app_server::request_in_home(home.as_deref(), &method, params).await;
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
                                let result = super::codex_try_request_with_fallback(
                                    &["bridge/approvals/resolve", "approvals/resolve"],
                                    json!({ "id": id, "decision": decision }),
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
                                let result = super::codex_try_request_with_fallback(
                                    &[
                                        "bridge/userInput/resolve",
                                        "userInput/resolve",
                                        "request_user_input/resolve",
                                    ],
                                    json!({ "id": id, "answers": answers }),
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
mod tests {
    use super::*;

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
    fn workspace_target_from_ws_payload_reads_workspace_hint() {
        assert_eq!(
            workspace_target_from_ws_payload(&json!({
                "payload": { "workspace": "wsl2" }
            })),
            Some(WorkspaceTarget::Wsl2)
        );
        assert_eq!(
            workspace_target_from_ws_payload(&json!({
                "payload": { "workspace": "windows" }
            })),
            Some(WorkspaceTarget::Windows)
        );
        assert_eq!(
            workspace_target_from_ws_payload(&json!({ "payload": {} })),
            None
        );
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
        assert!(should_reset_notification_cursor(
            14_549,
            Some(1),
            Some(108),
            false
        ));
        assert!(should_reset_notification_cursor(14_549, None, None, false));
        assert!(!should_reset_notification_cursor(
            7,
            Some(1),
            Some(108),
            false
        ));
        assert!(should_reset_notification_cursor(
            7,
            Some(20),
            Some(108),
            true
        ));
    }
}
