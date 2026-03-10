use super::*;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::Query;
use futures_util::StreamExt;

use self::web_codex_actions::{extract_turn_text, split_stream_chunks};
use self::web_codex_auth::{api_error, is_codex_ws_authorized, require_codex_auth, WsQuery};

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
    let home = crate::orchestrator::gateway::web_codex_home::web_codex_rpc_home_override();
    let result =
        crate::codex_app_server::request_in_home(home.as_deref(), "turn/start", payload).await?;
    let thread_id = result
        .get("threadId")
        .or_else(|| result.get("thread_id"))
        .cloned()
        .unwrap_or(Value::Null);
    let turn_id = result
        .get("turnId")
        .or_else(|| result.get("turn_id"))
        .cloned()
        .unwrap_or(Value::Null);
    let text = extract_turn_text(&result);
    for chunk in split_stream_chunks(&text) {
        let delta = json!({
            "type": "delta",
            "reqId": req_id,
            "payload": {
                "threadId": thread_id,
                "turnId": turn_id,
                "text": chunk
            }
        });
        if !send_ws_json(socket, &delta).await {
            return Err("ws closed".to_string());
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    let completed = json!({
        "type": "completed",
        "reqId": req_id,
        "payload": { "result": result }
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
    .unwrap_or(Value::Null);
    let user_inputs = super::codex_try_request_with_fallback(
        &[
            "bridge/userInput/list",
            "userInput/list",
            "request_user_input/list",
        ],
        Value::Null,
    )
    .await
    .unwrap_or(Value::Null);

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
    }

    let home = crate::orchestrator::gateway::web_codex_home::web_codex_rpc_home_override();
    let (mut items, first, last, gap) =
        crate::codex_app_server::replay_notifications_since_in_home(
            home.as_deref(),
            *notif_cursor,
            64,
        )
        .await;
    if gap {
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
        *notif_cursor = 0;
        let (replayed, _f2, _l2, _gap2) =
            crate::codex_app_server::replay_notifications_since_in_home(home.as_deref(), 0, 64)
                .await;
        items = replayed;
    }
    for notif in items {
        if let Some(id) = notif.get("eventId").and_then(|v| v.as_u64()) {
            *notif_cursor = (*notif_cursor).max(id);
        }
        if !send_ws_json(
            socket,
            &json!({ "type": "rpc.notification", "payload": notif }),
        )
        .await
        {
            return false;
        }
    }
    true
}

async fn codex_ws_loop(mut socket: WebSocket) {
    let mut subscribe_events = false;
    let mut approvals_sig = String::new();
    let mut user_input_sig = String::new();
    let mut notif_cursor: u64 = 0;
    let mut poll_tick = tokio::time::interval(std::time::Duration::from_secs(1));
    loop {
        tokio::select! {
            _ = poll_tick.tick() => {
                if subscribe_events
                    && !codex_ws_poll_pending_events(&mut socket, &mut approvals_sig, &mut user_input_sig, &mut notif_cursor).await
                {
                    break;
                }
            }
            incoming = socket.next() => {
                let Some(incoming) = incoming else {
                    break;
                };
                let Ok(msg) = incoming else {
                    break;
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
                                notif_cursor = v
                                    .get("payload")
                                    .and_then(|p| p.get("lastEventId"))
                                    .and_then(|x| x.as_u64())
                                    .unwrap_or(0);
                                let _ = codex_ws_poll_pending_events(
                                    &mut socket,
                                    &mut approvals_sig,
                                    &mut user_input_sig,
                                    &mut notif_cursor,
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
                                    "payload": { "events": true }
                                }))
                                .await;
                            }
                            "events.refresh" => {
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
                    Message::Close(_) => break,
                    Message::Ping(payload) => {
                        if socket.send(Message::Pong(payload)).await.is_err() {
                            break;
                        }
                    }
                    Message::Pong(_) => {}
                }
            }
        }
    }
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
