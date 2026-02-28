use axum::extract::{Path as AxumPath, Query};
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use base64::Engine;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tokio::process::Command;

const WEB_CODEX_INDEX_HTML: &str = include_str!("web_codex_page.html");
const WEB_CODEX_APP_JS: &str = include_str!("web_codex_app.js");
const AO_ICON_PNG: &[u8] = include_bytes!("../../../../public/ao-icon.png");
const MAX_ATTACHMENT_BYTES: usize = 10 * 1024 * 1024;
const MAX_TERMINAL_COMMAND_LEN: usize = 4000;
const MAX_TERMINAL_OUTPUT_BYTES: usize = 512 * 1024;
const TERMINAL_TIMEOUT_SECS: u64 = 20;
const VERSION_TIMEOUT_SECS: u64 = 8;

#[derive(Serialize)]
struct ApiErrorBody<'a> {
    error: ApiErrorMessage<'a>,
}

#[derive(Serialize)]
struct ApiErrorMessage<'a> {
    message: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<String>,
}

fn api_error(code: StatusCode, message: &str) -> Response {
    (
        code,
        Json(ApiErrorBody {
            error: ApiErrorMessage {
                message,
                detail: None,
            },
        }),
    )
        .into_response()
}

fn api_error_detail(code: StatusCode, message: &str, detail: String) -> Response {
    (
        code,
        Json(ApiErrorBody {
            error: ApiErrorMessage {
                message,
                detail: Some(detail),
            },
        }),
    )
        .into_response()
}

fn auth_bearer_token(headers: &HeaderMap) -> Option<&str> {
    let auth = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let auth = auth.trim();
    let prefix = "Bearer ";
    if auth.len() <= prefix.len() || !auth[..prefix.len()].eq_ignore_ascii_case(prefix) {
        return None;
    }
    Some(auth[prefix.len()..].trim())
}

fn require_codex_auth(st: &GatewayState, headers: &HeaderMap) -> Option<Response> {
    let expected = st.secrets.get_gateway_token()?;
    let expected = expected.trim();
    if expected.is_empty() {
        return None;
    }
    let Some(tok) = auth_bearer_token(headers) else {
        return Some(api_error(
            StatusCode::UNAUTHORIZED,
            "missing or invalid Authorization header",
        ));
    };
    if tok != expected {
        return Some(api_error(StatusCode::UNAUTHORIZED, "invalid token"));
    }
    None
}

#[derive(Deserialize)]
struct WsQuery {
    #[serde(default)]
    token: Option<String>,
}

fn is_codex_ws_authorized(st: &GatewayState, headers: &HeaderMap, query: &WsQuery) -> bool {
    let Some(expected) = st.secrets.get_gateway_token() else {
        return true;
    };
    let expected = expected.trim();
    if expected.is_empty() {
        return true;
    }
    if let Some(tok) = auth_bearer_token(headers) {
        return tok == expected;
    }
    query.token.as_deref().map(str::trim) == Some(expected)
}

fn codex_data_dir() -> Result<PathBuf, String> {
    if let Ok(dir) = std::env::var("API_ROUTER_USER_DATA_DIR") {
        let trimmed = dir.trim();
        if !trimmed.is_empty() {
            return Ok(PathBuf::from(trimmed));
        }
    }
    let codex_home = std::env::var("CODEX_HOME").map_err(|_| "CODEX_HOME is not set".to_string())?;
    let base = PathBuf::from(codex_home);
    base.parent()
        .map(|p| p.to_path_buf())
        .ok_or_else(|| "failed to resolve user-data directory".to_string())
}

fn codex_hosts_file_path() -> Result<PathBuf, String> {
    Ok(codex_data_dir()?.join("web-codex.hosts.json"))
}

fn codex_attachments_dir() -> Result<PathBuf, String> {
    Ok(codex_data_dir()?.join("web-codex-attachments"))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct WebCodexHost {
    id: String,
    name: String,
    base_url: String,
    #[serde(default)]
    token_hint: String,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
struct WebCodexHostsFile {
    #[serde(default)]
    items: Vec<WebCodexHost>,
}

fn read_hosts_file() -> Result<WebCodexHostsFile, String> {
    let path = codex_hosts_file_path()?;
    if !path.exists() {
        return Ok(WebCodexHostsFile::default());
    }
    let text = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

fn write_hosts_file(data: &WebCodexHostsFile) -> Result<(), String> {
    let path = codex_hosts_file_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(data).map_err(|e| e.to_string())?;
    std::fs::write(path, text).map_err(|e| e.to_string())
}

fn sanitize_name(value: &str, fallback: &str) -> String {
    let mut out = String::new();
    for ch in value.chars() {
        if ch.is_ascii_alphanumeric() || ch == '.' || ch == '-' || ch == '_' {
            out.push(ch);
        } else {
            out.push('_');
        }
    }
    let trimmed = out.trim_matches('_');
    if trimmed.is_empty() {
        fallback.to_string()
    } else {
        trimmed.to_string()
    }
}

fn truncate_output(value: &[u8]) -> (String, bool) {
    if value.len() <= MAX_TERMINAL_OUTPUT_BYTES {
        return (String::from_utf8_lossy(value).to_string(), false);
    }
    let head = &value[..MAX_TERMINAL_OUTPUT_BYTES];
    (String::from_utf8_lossy(head).to_string(), true)
}

async fn codex_rpc_call(method: &str, params: Value) -> Result<Value, Response> {
    crate::codex_app_server::request(method, params)
        .await
        .map_err(|e| api_error_detail(StatusCode::BAD_GATEWAY, "codex app-server request failed", e))
}

async fn codex_web_index(State(st): State<GatewayState>) -> Response {
    let embedded_token = st.secrets.get_gateway_token().unwrap_or_default();
    let token_json = serde_json::to_string(embedded_token.trim()).unwrap_or_else(|_| "\"\"".to_string());
    let html = WEB_CODEX_INDEX_HTML.replace("\"__WEB_CODEX_EMBEDDED_TOKEN__\"", &token_json);
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
        html,
    )
        .into_response()
}

async fn codex_web_app_js() -> Response {
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "application/javascript; charset=utf-8")],
        WEB_CODEX_APP_JS,
    )
        .into_response()
}

async fn codex_web_logo_png() -> Response {
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "image/png")],
        AO_ICON_PNG,
    )
        .into_response()
}

async fn codex_health(State(st): State<GatewayState>, headers: HeaderMap) -> Response {
    if let Some(resp) = require_codex_auth(&st, &headers) {
        return resp;
    }
    Json(json!({ "ok": true, "service": "web-codex" })).into_response()
}

async fn codex_pending_approvals(State(st): State<GatewayState>, headers: HeaderMap) -> Response {
    if let Some(resp) = require_codex_auth(&st, &headers) {
        return resp;
    }
    match codex_try_request_with_fallback(&["bridge/approvals/list", "approvals/list"], Value::Null).await {
        Ok(v) => Json(json!({ "items": v.get("items").cloned().unwrap_or(v) })).into_response(),
        Err(e) => api_error_detail(
            StatusCode::BAD_GATEWAY,
            "failed to list pending approvals",
            e,
        ),
    }
}

async fn codex_pending_user_inputs(State(st): State<GatewayState>, headers: HeaderMap) -> Response {
    if let Some(resp) = require_codex_auth(&st, &headers) {
        return resp;
    }
    match codex_try_request_with_fallback(
        &["bridge/userInput/list", "userInput/list", "request_user_input/list"],
        Value::Null,
    )
    .await
    {
        Ok(v) => Json(json!({ "items": v.get("items").cloned().unwrap_or(v) })).into_response(),
        Err(e) => api_error_detail(
            StatusCode::BAD_GATEWAY,
            "failed to list pending user inputs",
            e,
        ),
    }
}

async fn codex_ws(
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
    let result = crate::codex_app_server::request("turn/start", payload).await?;
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
    let approvals = codex_try_request_with_fallback(
        &["bridge/approvals/list", "approvals/list"],
        Value::Null,
    )
    .await
    .unwrap_or(Value::Null);
    let user_inputs = codex_try_request_with_fallback(
        &["bridge/userInput/list", "userInput/list", "request_user_input/list"],
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

async fn codex_try_request_with_fallback(methods: &[&str], params: Value) -> Result<Value, String> {
    let mut last_err = String::new();
    for method in methods {
        match crate::codex_app_server::request(method, params.clone()).await {
            Ok(v) => return Ok(v),
            Err(e) => last_err = e,
        }
    }
    Err(last_err)
}

async fn codex_ws_poll_pending_events(
    socket: &mut WebSocket,
    approvals_sig: &mut String,
    user_input_sig: &mut String,
) -> bool {
    let approvals = codex_try_request_with_fallback(
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

    let user_inputs = codex_try_request_with_fallback(
        &["bridge/userInput/list", "userInput/list", "request_user_input/list"],
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
    true
}

async fn codex_ws_loop(mut socket: WebSocket) {
    let mut subscribe_events = false;
    let mut approvals_sig = String::new();
    let mut user_input_sig = String::new();
    let mut poll_tick = tokio::time::interval(std::time::Duration::from_secs(1));
    loop {
        tokio::select! {
            _ = poll_tick.tick() => {
                if subscribe_events
                    && !codex_ws_poll_pending_events(&mut socket, &mut approvals_sig, &mut user_input_sig).await
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
                                let result = crate::codex_app_server::request(
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
                                let result = crate::codex_app_server::request(&method, params).await;
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
                                let result = codex_try_request_with_fallback(
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
                                let result = codex_try_request_with_fallback(
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

async fn codex_auth_verify(State(st): State<GatewayState>, headers: HeaderMap) -> Response {
    if let Some(resp) = require_codex_auth(&st, &headers) {
        return resp;
    }
    Json(json!({ "ok": true })).into_response()
}

async fn codex_hosts_list(State(st): State<GatewayState>, headers: HeaderMap) -> Response {
    if let Some(resp) = require_codex_auth(&st, &headers) {
        return resp;
    }
    match read_hosts_file() {
        Ok(data) => Json(json!({ "items": data.items })).into_response(),
        Err(e) => api_error_detail(StatusCode::INTERNAL_SERVER_ERROR, "failed to read hosts", e),
    }
}

#[derive(Deserialize)]
struct HostCreateRequest {
    name: String,
    base_url: String,
    #[serde(default)]
    token_hint: String,
}

async fn codex_hosts_create(
    State(st): State<GatewayState>,
    headers: HeaderMap,
    LoggedJson(req): LoggedJson<HostCreateRequest>,
) -> Response {
    if let Some(resp) = require_codex_auth(&st, &headers) {
        return resp;
    }
    let name = req.name.trim();
    let base_url = req.base_url.trim();
    if name.is_empty() || base_url.is_empty() {
        return api_error(StatusCode::BAD_REQUEST, "name and baseUrl are required");
    }
    let mut file = match read_hosts_file() {
        Ok(v) => v,
        Err(e) => return api_error_detail(StatusCode::INTERNAL_SERVER_ERROR, "failed to read hosts", e),
    };
    let host = WebCodexHost {
        id: format!("h_{}", uuid::Uuid::new_v4().simple()),
        name: name.to_string(),
        base_url: base_url.to_string(),
        token_hint: req.token_hint.trim().to_string(),
    };
    file.items.push(host.clone());
    if let Err(e) = write_hosts_file(&file) {
        return api_error_detail(StatusCode::INTERNAL_SERVER_ERROR, "failed to write hosts", e);
    }
    Json(json!({ "item": host })).into_response()
}

#[derive(Deserialize)]
struct HostUpdateRequest {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    base_url: Option<String>,
    #[serde(default)]
    token_hint: Option<String>,
}

async fn codex_hosts_update(
    State(st): State<GatewayState>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    LoggedJson(req): LoggedJson<HostUpdateRequest>,
) -> Response {
    if let Some(resp) = require_codex_auth(&st, &headers) {
        return resp;
    }
    let mut file = match read_hosts_file() {
        Ok(v) => v,
        Err(e) => return api_error_detail(StatusCode::INTERNAL_SERVER_ERROR, "failed to read hosts", e),
    };
    let Some(idx) = file.items.iter().position(|h| h.id == id) else {
        return api_error(StatusCode::NOT_FOUND, "host not found");
    };
    let item = &mut file.items[idx];
    if let Some(v) = req.name {
        let next = v.trim();
        if next.is_empty() {
            return api_error(StatusCode::BAD_REQUEST, "name cannot be empty");
        }
        item.name = next.to_string();
    }
    if let Some(v) = req.base_url {
        let next = v.trim();
        if next.is_empty() {
            return api_error(StatusCode::BAD_REQUEST, "baseUrl cannot be empty");
        }
        item.base_url = next.to_string();
    }
    if let Some(v) = req.token_hint {
        item.token_hint = v.trim().to_string();
    }
    if let Err(e) = write_hosts_file(&file) {
        return api_error_detail(StatusCode::INTERNAL_SERVER_ERROR, "failed to write hosts", e);
    }
    let updated = file.items[idx].clone();
    Json(json!({ "item": updated })).into_response()
}

async fn codex_hosts_delete(
    State(st): State<GatewayState>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
) -> Response {
    if let Some(resp) = require_codex_auth(&st, &headers) {
        return resp;
    }
    let mut file = match read_hosts_file() {
        Ok(v) => v,
        Err(e) => return api_error_detail(StatusCode::INTERNAL_SERVER_ERROR, "failed to read hosts", e),
    };
    let before = file.items.len();
    file.items.retain(|x| x.id != id);
    if before == file.items.len() {
        return api_error(StatusCode::NOT_FOUND, "host not found");
    }
    if let Err(e) = write_hosts_file(&file) {
        return api_error_detail(StatusCode::INTERNAL_SERVER_ERROR, "failed to write hosts", e);
    }
    Json(json!({ "ok": true })).into_response()
}

#[derive(Deserialize)]
struct ThreadsQuery {
    #[serde(default)]
    workspace: Option<String>,
}

fn workspace_is_wsl2(value: &str) -> bool {
    value.trim().eq_ignore_ascii_case("wsl2")
}

fn workspace_is_windows(value: &str) -> bool {
    value.trim().eq_ignore_ascii_case("windows")
}

fn thread_is_wsl2(thread: &Value) -> bool {
    let cwd = thread
        .get("cwd")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    !cwd.is_empty()
        && (cwd.starts_with('/')
            || cwd.starts_with("\\\\wsl$\\")
            || cwd.starts_with("\\\\wsl.localhost\\")
            || cwd.contains("\\\\wsl$\\")
            || cwd.contains("\\\\wsl.localhost\\")
            || cwd.contains("/mnt/"))
}

fn extract_items_array(value: &Value) -> Vec<Value> {
    if let Some(arr) = value.as_array() {
        return arr.clone();
    }
    if let Some(arr) = value
        .get("items")
        .and_then(|v| v.get("data"))
        .and_then(|v| v.as_array())
    {
        return arr.clone();
    }
    if let Some(arr) = value.get("items").and_then(|v| v.as_array()) {
        return arr.clone();
    }
    if let Some(arr) = value.get("data").and_then(|v| v.as_array()) {
        return arr.clone();
    }
    Vec::new()
}

fn merge_items_without_duplicates(mut base: Vec<Value>, extra: Vec<Value>) -> Vec<Value> {
    fn merge_thread_item(base_item: &mut Value, extra_item: &Value) {
        let (Some(base_obj), Some(extra_obj)) = (base_item.as_object_mut(), extra_item.as_object()) else {
            return;
        };

        let base_preview_empty = base_obj
            .get("preview")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .map(|v| v.is_empty())
            .unwrap_or(true);
        if base_preview_empty {
            if let Some(preview) = extra_obj.get("preview").and_then(|v| v.as_str()) {
                if !preview.trim().is_empty() {
                    base_obj.insert("preview".to_string(), Value::String(preview.to_string()));
                }
            }
        }

        for key in ["path", "source", "workspace", "cwd"] {
            if !base_obj.contains_key(key) {
                if let Some(v) = extra_obj.get(key) {
                    base_obj.insert(key.to_string(), v.clone());
                }
            }
        }

        for key in ["isSubagent", "isAuxiliary"] {
            let base_true = base_obj.get(key).and_then(|v| v.as_bool()).unwrap_or(false);
            let extra_true = extra_obj.get(key).and_then(|v| v.as_bool()).unwrap_or(false);
            if !base_true && extra_true {
                base_obj.insert(key.to_string(), Value::Bool(true));
            }
        }

        let base_updated = base_obj.get("updatedAt").and_then(|v| v.as_i64()).unwrap_or(0);
        let extra_updated = extra_obj.get("updatedAt").and_then(|v| v.as_i64()).unwrap_or(0);
        if extra_updated > base_updated {
            base_obj.insert("updatedAt".to_string(), Value::from(extra_updated));
        }

        let base_created = base_obj.get("createdAt").and_then(|v| v.as_i64()).unwrap_or(0);
        let extra_created = extra_obj.get("createdAt").and_then(|v| v.as_i64()).unwrap_or(0);
        if base_created == 0 && extra_created > 0 {
            base_obj.insert("createdAt".to_string(), Value::from(extra_created));
        }
    }

    let mut seen = std::collections::HashSet::new();
    let mut index_by_id = std::collections::HashMap::<String, usize>::new();
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

fn sort_threads_by_updated_desc(items: &mut [Value]) {
    fn score(item: &Value) -> i64 {
        item.get("updatedAt")
            .and_then(|v| v.as_i64())
            .or_else(|| item.get("createdAt").and_then(|v| v.as_i64()))
            .unwrap_or(0)
    }
    items.sort_by_key(score);
    items.reverse();
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
        || text.starts_with("review the code changes against the base branch")
}

fn is_auxiliary_instruction_text(raw: &str) -> bool {
    let text = raw.trim().to_ascii_lowercase();
    text.contains("# agents.md instructions")
        || text.contains("review the code changes against the base branch")
        || text.contains("another language model started to solve this problem")
}

fn session_file_has_auxiliary_marker(path: &Path) -> bool {
    let file = match File::open(path) {
        Ok(v) => v,
        Err(_) => return false,
    };
    let reader = BufReader::new(file);
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
                let normalized = text.trim();
                if normalized.is_empty() {
                    continue;
                }
                if is_auxiliary_instruction_text(normalized) {
                    saw_aux_user_prompt = true;
                } else {
                    saw_non_aux_user_prompt = true;
                }
                break;
            }
        }
        if saw_non_aux_user_prompt {
            return false;
        }
    }
    saw_aux_user_prompt && !saw_non_aux_user_prompt
}

fn filter_auxiliary_threads(items: &mut Vec<Value>) {
    items.retain(|item| {
        let is_subagent = item
            .get("isSubagent")
            .and_then(|x| x.as_bool())
            .unwrap_or(false);
        if is_subagent {
            return false;
        }
        let is_auxiliary = item
            .get("isAuxiliary")
            .and_then(|x| x.as_bool())
            .unwrap_or(false);
        if is_auxiliary {
            return false;
        }
        let preview = item
            .get("preview")
            .and_then(|x| x.as_str())
            .map(str::trim)
            .unwrap_or_default();
        !is_auxiliary_preview(preview)
    });
}

fn extract_user_preview_from_session_file(path: &Path) -> Option<String> {
    let file = File::open(path).ok()?;
    let reader = BufReader::new(file);
    let mut fallback_event_preview: Option<String> = None;
    let mut first_user_preview: Option<String> = None;
    for line in reader.lines().take(320).map_while(Result::ok) {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };
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
                if let Some(normalized) = normalize_preview_text(text) {
                    if first_user_preview.is_none() {
                        first_user_preview = Some(normalized);
                    }
                }
            }
        }
    }
    first_user_preview.or(fallback_event_preview)
}

fn normalize_thread_path(raw: &str) -> PathBuf {
    let normalized = raw
        .trim()
        .replace("\\\\?\\UNC\\", "\\\\")
        .replace("\\\\?\\", "");
    PathBuf::from(normalized)
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

fn thread_is_windows(thread: &Value) -> bool {
    !thread_is_wsl2(thread)
}

fn default_windows_codex_dir() -> Option<PathBuf> {
    if !cfg!(target_os = "windows") {
        return None;
    }
    let user_profile = std::env::var("USERPROFILE").ok()?;
    let path = PathBuf::from(user_profile).join(".codex");
    if path.exists() {
        Some(path)
    } else {
        None
    }
}

fn codex_home_dir_result() -> Result<PathBuf, String> {
    let home = std::env::var("CODEX_HOME").map_err(|_| "CODEX_HOME is not set".to_string())?;
    Ok(PathBuf::from(home))
}

fn find_rollout_file_by_thread_id(dir: &Path, thread_id: &str) -> Option<PathBuf> {
    let read = std::fs::read_dir(dir).ok()?;
    for entry in read.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if let Some(found) = find_rollout_file_by_thread_id(&path, thread_id) {
                return Some(found);
            }
            continue;
        }
        let file_name = path.file_name().and_then(|v| v.to_str()).unwrap_or_default();
        let is_jsonl = path
            .extension()
            .and_then(|v| v.to_str())
            .map(|v| v.eq_ignore_ascii_case("jsonl"))
            .unwrap_or(false);
        if is_jsonl && file_name.contains(thread_id) {
            return Some(path);
        }
    }
    None
}

fn import_windows_rollout_into_codex_home(thread_id: &str) -> Result<bool, String> {
    let Some(src_root) = default_windows_codex_dir().map(|p| p.join("sessions")) else {
        return Ok(false);
    };
    if !src_root.exists() {
        return Ok(false);
    }
    let Some(src_file) = find_rollout_file_by_thread_id(&src_root, thread_id) else {
        return Ok(false);
    };
    let dst_dir = codex_home_dir_result()?.join("sessions").join("imported");
    std::fs::create_dir_all(&dst_dir).map_err(|e| e.to_string())?;
    let dst_file = dst_dir.join(format!("{thread_id}.jsonl"));
    std::fs::copy(src_file, dst_file).map_err(|e| e.to_string())?;
    Ok(true)
}

fn is_safe_thread_id(thread_id: &str) -> bool {
    !thread_id.trim().is_empty()
        && thread_id
            .chars()
            .all(|c| c.is_ascii_hexdigit() || c == '-')
}

fn find_wsl_rollout_file_by_thread_id(thread_id: &str) -> Option<PathBuf> {
    if !cfg!(target_os = "windows") || !is_safe_thread_id(thread_id) {
        return None;
    }
    let script = format!(
        "python3 - <<'PY'\nfrom pathlib import Path\nneedle = '{thread_id}'\nroot = Path.home() / '.codex' / 'sessions'\nif not root.exists():\n    raise SystemExit(0)\nfor p in root.rglob('*.jsonl'):\n    if needle in p.name:\n        print(str(p))\n        break\nPY"
    );
    let output = std::process::Command::new("wsl.exe")
        .arg("-e")
        .arg("bash")
        .arg("-lc")
        .arg(script)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let linux_path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if linux_path.is_empty() {
        return None;
    }
    let windows_path_output = std::process::Command::new("wsl.exe")
        .arg("-e")
        .arg("wslpath")
        .arg("-w")
        .arg(linux_path)
        .output()
        .ok()?;
    if !windows_path_output.status.success() {
        return None;
    }
    let windows_path = String::from_utf8_lossy(&windows_path_output.stdout)
        .trim()
        .to_string();
    if windows_path.is_empty() {
        None
    } else {
        Some(PathBuf::from(windows_path))
    }
}

fn import_wsl_rollout_into_codex_home(thread_id: &str) -> Result<bool, String> {
    let Some(src_file) = find_wsl_rollout_file_by_thread_id(thread_id) else {
        return Ok(false);
    };
    if !src_file.exists() {
        return Ok(false);
    }
    let dst_dir = codex_home_dir_result()?.join("sessions").join("imported");
    std::fs::create_dir_all(&dst_dir).map_err(|e| e.to_string())?;
    let dst_file = dst_dir.join(format!("{thread_id}.jsonl"));
    std::fs::copy(src_file, dst_file).map_err(|e| e.to_string())?;
    Ok(true)
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
            if !map.contains_key(id)
                && !is_auxiliary_preview(&text)
                && !is_auxiliary_instruction_text(&text)
            {
                map.insert(id.to_string(), text);
            }
        }
    }
    map
}

fn parse_session_meta(path: &Path) -> Option<(String, String, i64, bool)> {
    let file = File::open(path).ok()?;
    let reader = BufReader::new(file);
    for line in reader.lines().take(40).map_while(Result::ok) {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };
        if v.get("type").and_then(|x| x.as_str()) != Some("session_meta") {
            continue;
        }
        let payload = v.get("payload").and_then(|x| x.as_object())?;
        let id = payload
            .get("id")
            .and_then(|x| x.as_str())
            .or_else(|| payload.get("session_id").and_then(|x| x.as_str()))
            .map(str::trim)
            .unwrap_or_default()
            .to_string();
        if id.is_empty() {
            continue;
        }
        let cwd = payload
            .get("cwd")
            .and_then(|x| x.as_str())
            .map(str::trim)
            .unwrap_or_default()
            .to_string();
        if cwd.is_empty() {
            continue;
        }
        let created_at = payload
            .get("created_at")
            .and_then(|x| x.as_i64())
            .or_else(|| payload.get("createdAt").and_then(|x| x.as_i64()))
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
        return Some((
            id,
            cwd,
            created_at,
            has_subagent_source || has_agent_role || has_agent_nickname,
        ));
    }
    None
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

fn fetch_windows_threads_fallback() -> Vec<Value> {
    let Some(codex_dir) = default_windows_codex_dir() else {
        return Vec::new();
    };
    let sessions_dir = codex_dir.join("sessions");
    if !sessions_dir.exists() {
        return Vec::new();
    }
    let previews = parse_history_preview_map(&codex_dir.join("history.jsonl"));
    let mut files = Vec::new();
    collect_jsonl_files(&sessions_dir, &mut files);

    let mut by_id: HashMap<String, Value> = HashMap::new();
    for file in files {
        let Some((id, cwd, created_at, is_subagent)) = parse_session_meta(&file) else {
            continue;
        };
        let updated_at = file_updated_unix_secs(&file);
        let preview = previews
            .get(&id)
            .and_then(|v| normalize_preview_text(v))
            .or_else(|| extract_user_preview_from_session_file(&file))
            .unwrap_or_default();
        let is_auxiliary = session_file_has_auxiliary_marker(&file);
        let candidate = json!({
            "id": id,
            "cwd": cwd,
            "workspace": "windows",
            "preview": preview,
            "path": file.to_string_lossy().to_string(),
            "source": "windows-fallback",
            "isAuxiliary": is_auxiliary,
            "isSubagent": is_subagent,
            "status": { "type": "notLoaded" },
            "createdAt": if created_at > 0 { created_at } else { updated_at },
            "updatedAt": updated_at,
        });
        let should_replace = by_id
            .get(&id)
            .and_then(|v| v.get("updatedAt").and_then(|x| x.as_i64()))
            .unwrap_or(0)
            < updated_at;
        if should_replace || !by_id.contains_key(&id) {
            by_id.insert(id, candidate);
        }
    }
    let mut items: Vec<Value> = by_id.into_values().collect();
    sort_threads_by_updated_desc(&mut items);
    if items.len() > 600 {
        items.truncate(600);
    }
    items
}

async fn fetch_wsl2_threads_fallback() -> Vec<Value> {
    if !cfg!(target_os = "windows") {
        return Vec::new();
    }
    let script = r#"python3 - <<'PY'
import json
import re
from pathlib import Path

root = Path.home() / ".codex"
sessions_dir = root / "sessions"
history_path = root / "history.jsonl"

if not sessions_dir.exists():
    print("[]")
    raise SystemExit(0)

preview_map = {}
if history_path.exists():
    try:
        with history_path.open("r", encoding="utf-8", errors="ignore") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    row = json.loads(line)
                except Exception:
                    continue
                sid = str(row.get("session_id") or "").strip()
                text = str(row.get("text") or "").strip()
                if sid and text and sid not in preview_map:
                    preview_map[sid] = text
    except Exception:
        pass

items_by_id = {}
id_re = re.compile(r"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})", re.IGNORECASE)

for p in sessions_dir.rglob("*.jsonl"):
    sid = ""
    cwd = ""
    created_at = 0
    is_subagent = False
    updated_at = int(p.stat().st_mtime)
    try:
        with p.open("r", encoding="utf-8", errors="ignore") as fh:
            for _ in range(40):
                line = fh.readline()
                if not line:
                    break
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except Exception:
                    continue
                if obj.get("type") == "session_meta":
                    payload = obj.get("payload") or {}
                    sid = str(payload.get("id") or payload.get("session_id") or sid).strip()
                    cwd = str(payload.get("cwd") or cwd).strip()
                    created_raw = payload.get("created_at") or payload.get("createdAt")
                    source = payload.get("source") or {}
                    source_subagent = source.get("subagent")
                    has_agent_role = bool(str(payload.get("agent_role") or "").strip())
                    has_agent_nickname = bool(str(payload.get("agent_nickname") or "").strip())
                    is_subagent = bool(source_subagent) or has_agent_role or has_agent_nickname
                    try:
                        created_at = int(created_raw or 0)
                    except Exception:
                        created_at = 0
                    break
    except Exception:
        continue

    if not sid:
        m = id_re.search(p.name)
        if m:
            sid = m.group(1)
    if not sid:
        continue
    if not cwd:
        continue

    candidate = {
        "id": sid,
        "cwd": cwd,
        "workspace": "wsl2",
        "preview": preview_map.get(sid, ""),
        "path": str(p),
        "source": "wsl-fallback",
        "isSubagent": is_subagent,
        "isAuxiliary": False,
        "status": {"type": "notLoaded"},
        "createdAt": created_at or updated_at,
        "updatedAt": updated_at,
    }
    existing = items_by_id.get(sid)
    if existing is None or int(existing.get("updatedAt", 0)) < updated_at:
        items_by_id[sid] = candidate

items = sorted(items_by_id.values(), key=lambda x: int(x.get("updatedAt", 0)), reverse=True)
print(json.dumps(items[:300], ensure_ascii=False))
PY"#;

    let mut cmd = Command::new("wsl.exe");
    cmd.arg("-e").arg("bash").arg("-lc").arg(script);
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::null());
    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW

    let output = match tokio::time::timeout(
        std::time::Duration::from_secs(VERSION_TIMEOUT_SECS),
        cmd.output(),
    )
    .await
    {
        Ok(Ok(v)) if v.status.success() => v,
        _ => return Vec::new(),
    };
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if text.is_empty() {
        return Vec::new();
    }
    serde_json::from_str::<Vec<Value>>(&text).unwrap_or_default()
}

fn build_threads_response(items: Vec<Value>) -> Response {
    Json(json!({
        "items": {
            "data": items,
            "nextCursor": Value::Null
        }
    }))
    .into_response()
}

async fn codex_models(State(st): State<GatewayState>, headers: HeaderMap) -> Response {
    if let Some(resp) = require_codex_auth(&st, &headers) {
        return resp;
    }
    match codex_rpc_call("model/list", Value::Null).await {
        Ok(v) => Json(json!({ "items": v.get("items").cloned().unwrap_or(v) })).into_response(),
        Err(resp) => resp,
    }
}

async fn codex_threads_list(
    State(st): State<GatewayState>,
    headers: HeaderMap,
    Query(query): Query<ThreadsQuery>,
) -> Response {
    if let Some(resp) = require_codex_auth(&st, &headers) {
        return resp;
    }
    let requested_workspace = query.workspace.unwrap_or_default();
    let params = json!({ "workspace": requested_workspace.clone() });
    match codex_rpc_call("thread/list", params).await {
        Ok(v) => {
            let mut base_items = extract_items_array(&v);
            if workspace_is_wsl2(&requested_workspace) {
                base_items.retain(thread_is_wsl2);
            } else if workspace_is_windows(&requested_workspace) {
                base_items.retain(thread_is_windows);
            }
            let should_try_windows_fallback = !workspace_is_wsl2(&requested_workspace);
            if should_try_windows_fallback {
                let windows_fallback = fetch_windows_threads_fallback();
                if workspace_is_windows(&requested_workspace) {
                    base_items = merge_items_without_duplicates(Vec::new(), windows_fallback);
                } else {
                    base_items = merge_items_without_duplicates(base_items, windows_fallback);
                }
            }
            let should_try_wsl_fallback = !workspace_is_windows(&requested_workspace)
                && (!workspace_is_wsl2(&requested_workspace)
                    || base_items.is_empty()
                    || !base_items.iter().any(thread_is_wsl2));
            if should_try_wsl_fallback {
                let fallback_items = fetch_wsl2_threads_fallback().await;
                if workspace_is_wsl2(&requested_workspace) {
                    base_items = merge_items_without_duplicates(Vec::new(), fallback_items);
                } else {
                    base_items = merge_items_without_duplicates(base_items, fallback_items);
                }
            }
            hydrate_missing_previews_from_session_files(&mut base_items);
            filter_auxiliary_threads(&mut base_items);
            sort_threads_by_updated_desc(&mut base_items);
            build_threads_response(base_items)
        }
        Err(resp) => resp,
    }
}

#[derive(Deserialize)]
struct ThreadCreateRequest {
    #[serde(default)]
    workspace: Option<String>,
    #[serde(default)]
    title: Option<String>,
}

async fn codex_threads_create(
    State(st): State<GatewayState>,
    headers: HeaderMap,
    LoggedJson(req): LoggedJson<ThreadCreateRequest>,
) -> Response {
    if let Some(resp) = require_codex_auth(&st, &headers) {
        return resp;
    }
    let params = json!({ "workspace": req.workspace, "title": req.title });
    match codex_rpc_call("thread/new", params).await {
        Ok(v) => Json(v).into_response(),
        Err(resp) => resp,
    }
}

async fn codex_thread_resume(
    State(st): State<GatewayState>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
) -> Response {
    if let Some(resp) = require_codex_auth(&st, &headers) {
        return resp;
    }
    let params = json!({ "threadId": id });
    match crate::codex_app_server::request("thread/resume", params.clone()).await {
        Ok(v) => Json(v).into_response(),
        Err(first_error) => {
            let lower = first_error.to_ascii_lowercase();
            let missing_rollout =
                lower.contains("no rollout found") || lower.contains("thread id");
            if missing_rollout {
                match import_windows_rollout_into_codex_home(&id) {
                    Ok(true) => {
                        match crate::codex_app_server::request("thread/resume", params).await {
                            Ok(v) => Json(v).into_response(),
                            Err(second_error) => api_error_detail(
                                StatusCode::BAD_GATEWAY,
                                "failed to resume thread",
                                second_error,
                            ),
                        }
                    }
                    Ok(false) => match import_wsl_rollout_into_codex_home(&id) {
                        Ok(true) => {
                            match crate::codex_app_server::request("thread/resume", params).await {
                                Ok(v) => Json(v).into_response(),
                                Err(second_error) => api_error_detail(
                                    StatusCode::BAD_GATEWAY,
                                    "failed to resume thread",
                                    second_error,
                                ),
                            }
                        }
                        Ok(false) => api_error_detail(
                            StatusCode::BAD_GATEWAY,
                            "failed to resume thread",
                            first_error,
                        ),
                        Err(import_error) => api_error_detail(
                            StatusCode::BAD_GATEWAY,
                            "failed to resume thread",
                            format!("{first_error}; import failed: {import_error}"),
                        ),
                    },
                    Err(import_error) => api_error_detail(
                        StatusCode::BAD_GATEWAY,
                        "failed to resume thread",
                        format!("{first_error}; import failed: {import_error}"),
                    ),
                }
            } else {
                api_error_detail(
                    StatusCode::BAD_GATEWAY,
                    "failed to resume thread",
                    first_error,
                )
            }
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TurnStartRequest {
    #[serde(default)]
    thread_id: Option<String>,
    prompt: String,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    collaboration_mode: Option<String>,
}

async fn codex_turn_start(
    State(st): State<GatewayState>,
    headers: HeaderMap,
    LoggedJson(req): LoggedJson<TurnStartRequest>,
) -> Response {
    if let Some(resp) = require_codex_auth(&st, &headers) {
        return resp;
    }
    if req.prompt.trim().is_empty() {
        return api_error(StatusCode::BAD_REQUEST, "prompt is required");
    }
    let params = json!({
        "threadId": req.thread_id,
        "prompt": req.prompt,
        "model": req.model,
        "collaborationMode": req.collaboration_mode.unwrap_or_else(|| "default".to_string()),
    });
    match codex_rpc_call("turn/start", params).await {
        Ok(v) => Json(v).into_response(),
        Err(resp) => resp,
    }
}

fn split_stream_chunks(text: &str) -> Vec<String> {
    let mut chunks = Vec::new();
    let mut current = String::new();
    for part in text.split_whitespace() {
        if !current.is_empty() {
            current.push(' ');
        }
        current.push_str(part);
        if current.len() >= 80 {
            chunks.push(std::mem::take(&mut current));
        }
    }
    if !current.is_empty() {
        chunks.push(current);
    }
    if chunks.is_empty() {
        chunks.push(String::new());
    }
    chunks
}

fn sse_event(name: &str, value: &Value) -> Bytes {
    let data = value.to_string();
    Bytes::from(format!("event: {name}\ndata: {data}\n\n"))
}

fn extract_turn_text(result: &Value) -> String {
    if let Some(text) = result.get("output_text").and_then(|v| v.as_str()) {
        return text.to_string();
    }
    if let Some(text) = result.get("text").and_then(|v| v.as_str()) {
        return text.to_string();
    }
    if let Some(arr) = result.get("output_text").and_then(|v| v.as_array()) {
        let joined = arr
            .iter()
            .filter_map(|v| v.as_str())
            .collect::<Vec<_>>()
            .join("\n");
        if !joined.trim().is_empty() {
            return joined;
        }
    }
    serde_json::to_string_pretty(result).unwrap_or_else(|_| "{}".to_string())
}

async fn codex_turn_stream(
    State(st): State<GatewayState>,
    headers: HeaderMap,
    LoggedJson(req): LoggedJson<TurnStartRequest>,
) -> Response {
    if let Some(resp) = require_codex_auth(&st, &headers) {
        return resp;
    }
    if req.prompt.trim().is_empty() {
        return api_error(StatusCode::BAD_REQUEST, "prompt is required");
    }
    let params = json!({
        "threadId": req.thread_id,
        "prompt": req.prompt,
        "model": req.model,
        "collaborationMode": req.collaboration_mode.unwrap_or_else(|| "default".to_string()),
    });
    let started = sse_event("started", &json!({ "ok": true }));
    let call = crate::codex_app_server::request("turn/start", params).await;
    let stream = async_stream::stream! {
        yield Ok::<Bytes, std::convert::Infallible>(started);
        match call {
            Ok(result) => {
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
                    let event = sse_event(
                        "delta",
                        &json!({
                            "threadId": thread_id,
                            "turnId": turn_id,
                            "text": chunk,
                        }),
                    );
                    yield Ok(event);
                    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                }
                yield Ok(sse_event("completed", &json!({ "result": result })));
            }
            Err(err) => {
                yield Ok(sse_event("error", &json!({ "message": err.to_string() })));
            }
        }
    };

    let mut resp = Response::new(Body::from_stream(stream));
    *resp.status_mut() = StatusCode::OK;
    let headers = resp.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        header::HeaderValue::from_static("text/event-stream"),
    );
    headers.insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("no-cache"),
    );
    headers.insert(
        header::CONNECTION,
        header::HeaderValue::from_static("keep-alive"),
    );
    resp
}

async fn codex_turn_interrupt(
    State(st): State<GatewayState>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
) -> Response {
    if let Some(resp) = require_codex_auth(&st, &headers) {
        return resp;
    }
    match codex_rpc_call("turn/interrupt", json!({ "turnId": id })).await {
        Ok(v) => Json(v).into_response(),
        Err(resp) => resp,
    }
}

#[derive(Deserialize)]
struct ApprovalResolveRequest {
    decision: String,
}

async fn codex_approval_resolve(
    State(st): State<GatewayState>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    LoggedJson(req): LoggedJson<ApprovalResolveRequest>,
) -> Response {
    if let Some(resp) = require_codex_auth(&st, &headers) {
        return resp;
    }
    match codex_rpc_call("bridge/approvals/resolve", json!({ "id": id, "decision": req.decision })).await
    {
        Ok(v) => Json(v).into_response(),
        Err(resp) => resp,
    }
}

#[derive(Deserialize)]
struct UserInputResolveRequest {
    answers: Value,
}

async fn codex_user_input_resolve(
    State(st): State<GatewayState>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    LoggedJson(req): LoggedJson<UserInputResolveRequest>,
) -> Response {
    if let Some(resp) = require_codex_auth(&st, &headers) {
        return resp;
    }
    match codex_rpc_call("bridge/userInput/resolve", json!({ "id": id, "answers": req.answers })).await {
        Ok(v) => Json(v).into_response(),
        Err(resp) => resp,
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UploadRequest {
    thread_id: String,
    file_name: String,
    #[serde(default)]
    mime_type: String,
    base64_data: String,
}

async fn codex_attachments_upload(
    State(st): State<GatewayState>,
    headers: HeaderMap,
    LoggedJson(req): LoggedJson<UploadRequest>,
) -> Response {
    if let Some(resp) = require_codex_auth(&st, &headers) {
        return resp;
    }
    if req.thread_id.trim().is_empty() || req.file_name.trim().is_empty() {
        return api_error(StatusCode::BAD_REQUEST, "threadId and fileName are required");
    }
    let max_base64_len = MAX_ATTACHMENT_BYTES.div_ceil(3) * 4 + 8;
    if req.base64_data.len() > max_base64_len {
        return api_error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "attachment too large (max 10 MiB)",
        );
    }
    let bytes = match base64::engine::general_purpose::STANDARD.decode(req.base64_data.as_bytes()) {
        Ok(v) => v,
        Err(e) => return api_error_detail(StatusCode::BAD_REQUEST, "invalid base64Data", e.to_string()),
    };
    if bytes.len() > MAX_ATTACHMENT_BYTES {
        return api_error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "attachment too large (max 10 MiB)",
        );
    }
    let base_dir = match codex_attachments_dir() {
        Ok(v) => v,
        Err(e) => return api_error_detail(StatusCode::INTERNAL_SERVER_ERROR, "failed to resolve attachments dir", e),
    };
    let thread_dir = base_dir.join(sanitize_name(&req.thread_id, "unassigned"));
    if let Err(e) = std::fs::create_dir_all(&thread_dir) {
        return api_error_detail(
            StatusCode::INTERNAL_SERVER_ERROR,
            "failed to prepare attachment dir",
            e.to_string(),
        );
    }
    let safe_name = sanitize_name(&req.file_name, "attachment.bin");
    let path = thread_dir.join(&safe_name);
    if let Err(e) = std::fs::write(&path, bytes) {
        return api_error_detail(StatusCode::INTERNAL_SERVER_ERROR, "failed to write attachment", e.to_string());
    }
    Json(json!({
        "ok": true,
        "threadId": req.thread_id,
        "fileName": safe_name,
        "mimeType": req.mime_type,
        "path": path.to_string_lossy(),
    }))
    .into_response()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SlashRequest {
    command: String,
    #[serde(default)]
    thread_id: Option<String>,
}

#[derive(Debug)]
struct ParsedSlash {
    method: String,
    params: Value,
}

fn parse_slash_command(input: &str) -> Option<ParsedSlash> {
    let mut parts = input.split_whitespace();
    match parts.next()? {
        "/help" => Some(ParsedSlash { method: "help/read".to_string(), params: Value::Null }),
        "/new" => Some(ParsedSlash { method: "thread/new".to_string(), params: Value::Null }),
        "/status" => Some(ParsedSlash { method: "status/read".to_string(), params: Value::Null }),
        "/compact" => Some(ParsedSlash { method: "thread/compact".to_string(), params: Value::Null }),
        "/review" => Some(ParsedSlash { method: "review/start".to_string(), params: Value::Null }),
        "/fork" => Some(ParsedSlash { method: "thread/fork".to_string(), params: Value::Null }),
        "/diff" => Some(ParsedSlash { method: "thread/diff".to_string(), params: Value::Null }),
        "/model" => {
            let model = parts.collect::<Vec<_>>().join(" ");
            if model.trim().is_empty() {
                return None;
            }
            Some(ParsedSlash { method: "thread/model/set".to_string(), params: json!({ "model": model }) })
        }
        "/rename" => {
            let title = parts.collect::<Vec<_>>().join(" ");
            if title.trim().is_empty() {
                return None;
            }
            Some(ParsedSlash { method: "thread/rename".to_string(), params: json!({ "title": title }) })
        }
        "/plan" => {
            let arg = parts.collect::<Vec<_>>().join(" ");
            let mode = arg.trim().to_ascii_lowercase();
            if mode.is_empty() || mode == "on" {
                return Some(ParsedSlash { method: "thread/collaborationMode/set".to_string(), params: json!({ "mode": "plan" }) });
            }
            if mode == "off" {
                return Some(ParsedSlash { method: "thread/collaborationMode/set".to_string(), params: json!({ "mode": "default" }) });
            }
            Some(ParsedSlash {
                method: "turn/start".to_string(),
                params: json!({ "prompt": arg, "collaborationMode": "plan" }),
            })
        }
        _ => None,
    }
}

async fn codex_slash_execute(
    State(st): State<GatewayState>,
    headers: HeaderMap,
    LoggedJson(req): LoggedJson<SlashRequest>,
) -> Response {
    if let Some(resp) = require_codex_auth(&st, &headers) {
        return resp;
    }
    let command = req.command.trim();
    if command.is_empty() {
        return api_error(StatusCode::BAD_REQUEST, "command is required");
    }
    let parsed = match parse_slash_command(command) {
        Some(v) => v,
        None => return api_error(StatusCode::BAD_REQUEST, "unsupported slash command"),
    };
    let mut params = parsed.params;
    if let Some(thread_id) = req.thread_id {
        if let Some(obj) = params.as_object_mut() {
            obj.insert("threadId".to_string(), Value::String(thread_id));
        }
    }
    match codex_rpc_call(&parsed.method, params).await {
        Ok(v) => Json(json!({ "ok": true, "method": parsed.method, "result": v })).into_response(),
        Err(resp) => resp,
    }
}

#[derive(Deserialize)]
struct TerminalExecRequest {
    command: String,
    #[serde(default)]
    cwd: Option<String>,
}

#[derive(Serialize)]
struct CodexVersionInfo {
    windows: String,
    wsl2: String,
    #[serde(rename = "windowsInstalled")]
    windows_installed: bool,
    #[serde(rename = "wsl2Installed")]
    wsl2_installed: bool,
}

async fn run_version_cmd(mut cmd: Command) -> Option<String> {
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::null());
    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    let timed = tokio::time::timeout(
        std::time::Duration::from_secs(VERSION_TIMEOUT_SECS),
        cmd.output(),
    )
    .await
    .ok()?;
    let output = timed.ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    stdout
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(|line| line.to_string())
}

async fn detect_windows_codex_version() -> String {
    let mut cmd = Command::new("cmd.exe");
    cmd.arg("/C").arg("codex --version");
    if let Some(found) = run_version_cmd(cmd).await {
        return found;
    }

    if let Ok(appdata) = std::env::var("APPDATA") {
        let candidate = PathBuf::from(appdata).join("npm").join("codex.cmd");
        if candidate.exists() {
            let mut cmd = Command::new("cmd.exe");
            cmd.arg("/C").arg(candidate).arg("--version");
            if let Some(found) = run_version_cmd(cmd).await {
                return found;
            }
        }
    }
    "Not installed".to_string()
}

async fn detect_wsl_codex_version() -> String {
    let mut cmd = Command::new("wsl.exe");
    cmd.arg("-e").arg("bash").arg("-lc").arg("codex --version");
    if let Some(found) = run_version_cmd(cmd).await {
        return found;
    }
    "Not installed".to_string()
}

async fn codex_version_info(
    State(st): State<GatewayState>,
    headers: HeaderMap,
) -> Response {
    if let Some(resp) = require_codex_auth(&st, &headers) {
        return resp;
    }
    let windows = detect_windows_codex_version().await;
    let wsl2 = detect_wsl_codex_version().await;
    Json(CodexVersionInfo {
        windows_installed: windows != "Not installed",
        wsl2_installed: wsl2 != "Not installed",
        windows,
        wsl2,
    })
    .into_response()
}

async fn codex_terminal_exec(
    State(st): State<GatewayState>,
    headers: HeaderMap,
    LoggedJson(req): LoggedJson<TerminalExecRequest>,
) -> Response {
    if let Some(resp) = require_codex_auth(&st, &headers) {
        return resp;
    }
    let command = req.command.trim();
    if command.is_empty() {
        return api_error(StatusCode::BAD_REQUEST, "command is required");
    }
    if command.len() > MAX_TERMINAL_COMMAND_LEN {
        return api_error(StatusCode::BAD_REQUEST, "command exceeds max length");
    }
    let mut cmd = if cfg!(windows) {
        let mut c = Command::new("cmd.exe");
        c.arg("/C").arg(command);
        c
    } else {
        let mut c = Command::new("sh");
        c.arg("-lc").arg(command);
        c
    };
    cmd.kill_on_drop(true);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW

    if let Some(cwd) = req.cwd {
        let path = PathBuf::from(cwd);
        if path.exists() && path.is_dir() {
            cmd.current_dir(path);
        }
    }

    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    let child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return api_error_detail(StatusCode::BAD_REQUEST, "failed to spawn command", e.to_string()),
    };
    let timed = tokio::time::timeout(
        std::time::Duration::from_secs(TERMINAL_TIMEOUT_SECS),
        child.wait_with_output(),
    )
    .await;
    let output = match timed {
        Ok(Ok(v)) => v,
        Ok(Err(e)) => return api_error_detail(StatusCode::INTERNAL_SERVER_ERROR, "failed to wait command", e.to_string()),
        Err(_) => {
            return api_error(
                StatusCode::REQUEST_TIMEOUT,
                "terminal command timed out (20s)",
            );
        }
    };
    let (stdout, stdout_truncated) = truncate_output(&output.stdout);
    let (stderr, stderr_truncated) = truncate_output(&output.stderr);
    Json(json!({
        "ok": output.status.success(),
        "exitCode": output.status.code(),
        "stdout": stdout,
        "stderr": stderr,
        "stdoutTruncated": stdout_truncated,
        "stderrTruncated": stderr_truncated,
    }))
    .into_response()
}

#[derive(Deserialize)]
struct RpcProxyRequest {
    method: String,
    #[serde(default)]
    params: Value,
}

async fn codex_rpc_proxy(
    State(st): State<GatewayState>,
    headers: HeaderMap,
    LoggedJson(req): LoggedJson<RpcProxyRequest>,
) -> Response {
    if let Some(resp) = require_codex_auth(&st, &headers) {
        return resp;
    }
    let method = req.method.trim();
    if method.is_empty() {
        return api_error(StatusCode::BAD_REQUEST, "method is required");
    }
    match codex_rpc_call(method, req.params).await {
        Ok(v) => Json(json!({ "result": v })).into_response(),
        Err(resp) => resp,
    }
}

#[cfg(test)]
mod web_codex_tests {
    use super::{parse_slash_command, split_stream_chunks, truncate_output, MAX_TERMINAL_OUTPUT_BYTES};

    #[test]
    fn parse_plan_variants() {
        let on = parse_slash_command("/plan on").expect("on");
        assert_eq!(on.method, "thread/collaborationMode/set");
        assert_eq!(on.params["mode"], "plan");

        let prompt = parse_slash_command("/plan add checklist").expect("prompt");
        assert_eq!(prompt.method, "turn/start");
        assert_eq!(prompt.params["collaborationMode"], "plan");
    }

    #[test]
    fn parse_rename_and_model_require_args() {
        assert!(parse_slash_command("/rename").is_none());
        assert!(parse_slash_command("/model").is_none());
        assert!(parse_slash_command("/rename hello").is_some());
        assert!(parse_slash_command("/model gpt-5").is_some());
    }

    #[test]
    fn split_stream_chunks_keeps_order() {
        let joined = "one two three four five six seven eight nine ten";
        let chunks = split_stream_chunks(joined);
        assert!(!chunks.is_empty());
        assert_eq!(chunks.join(" "), joined);
    }

    #[test]
    fn truncate_output_marks_cutoff() {
        let input = vec![b'a'; MAX_TERMINAL_OUTPUT_BYTES + 8];
        let (text, truncated) = truncate_output(&input);
        assert!(truncated);
        assert_eq!(text.len(), MAX_TERMINAL_OUTPUT_BYTES);
    }
}
