use axum::extract::{Path as AxumPath, Query};
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use base64::Engine;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tokio::process::Command;

const WEB_CODEX_INDEX_HTML: &str = include_str!("../../../../codex-web.html");
const WEB_CODEX_APP_JS: &str = include_str!("../../../../src/ui/codex-web-dev.js");
const WEB_CODEX_ICON_SVG: &str = include_str!("../../../../src/ui/assets/codex-color.svg");
const AO_ICON_PNG: &[u8] = include_bytes!("../../../../public/ao-icon.png");
const MAX_ATTACHMENT_BYTES: usize = 10 * 1024 * 1024;
const MAX_TERMINAL_COMMAND_LEN: usize = 4000;
const MAX_TERMINAL_OUTPUT_BYTES: usize = 512 * 1024;
const TERMINAL_TIMEOUT_SECS: u64 = 20;
const VERSION_DETECT_TIMEOUT_SECS: u64 = 3;
const VERSION_INFO_CACHE_SECS: i64 = 30;

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

fn auth_cookie_token(headers: &HeaderMap) -> Option<&str> {
    let cookie_header = headers.get(header::COOKIE)?.to_str().ok()?;
    for part in cookie_header.split(';') {
        let trimmed = part.trim();
        let (name, value) = trimmed.split_once('=')?;
        if name.trim() == "api_router_gateway_token" {
            let v = value.trim();
            if !v.is_empty() {
                return Some(v);
            }
        }
    }
    None
}

fn require_codex_auth(st: &GatewayState, headers: &HeaderMap) -> Option<Response> {
    let expected = st.secrets.get_gateway_token()?;
    let expected = expected.trim();
    if expected.is_empty() {
        return None;
    }
    let tok = auth_bearer_token(headers).or_else(|| auth_cookie_token(headers));
    let Some(tok) = tok else {
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CliConfigSnapshot {
    #[serde(skip_serializing_if = "Option::is_none")]
    model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reasoning_effort: Option<String>,
}

fn extract_model_and_effort_from_toml(txt: &str) -> CliConfigSnapshot {
    let parsed = toml::from_str::<toml::Value>(txt)
        .unwrap_or(toml::Value::Table(Default::default()));
    let model = parsed
        .get("model")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let reasoning_effort = parsed
        .get("model_reasoning_effort")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    CliConfigSnapshot {
        model,
        reasoning_effort,
    }
}

async fn codex_cli_config(State(st): State<GatewayState>, headers: HeaderMap) -> Response {
    if let Some(resp) = require_codex_auth(&st, &headers) {
        return resp;
    }

    // Best-effort: read the user's actual Windows Codex config.toml (what `codex` CLI uses).
    let windows_cfg = crate::orchestrator::gateway::web_codex_home::default_windows_codex_dir()
        .map(|p| p.join("config.toml"))
        .and_then(|p| std::fs::read_to_string(p).ok())
        .map(|txt| extract_model_and_effort_from_toml(&txt))
        .unwrap_or(CliConfigSnapshot {
            model: None,
            reasoning_effort: None,
        });

    Json(json!({
        "windows": windows_cfg,
        "wsl2": Value::Null
    }))
    .into_response()
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
    if let Some(tok) = auth_cookie_token(headers) {
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
    let home = crate::orchestrator::gateway::web_codex_home::web_codex_rpc_home_override();
    crate::codex_app_server::request_in_home(home.as_deref(), method, params)
        .await
        .map_err(|e| api_error_detail(StatusCode::BAD_GATEWAY, "codex app-server request failed", e))
}

async fn codex_web_index(State(st): State<GatewayState>) -> Response {
    let embedded_token = st.secrets.get_gateway_token().unwrap_or_default();
    let html = WEB_CODEX_INDEX_HTML;
    let cookie = format!(
        "api_router_gateway_token={}; Path=/codex; HttpOnly; SameSite=Strict",
        embedded_token.trim()
    );
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "text/html; charset=utf-8"),
            (header::SET_COOKIE, cookie.as_str()),
        ],
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

async fn codex_web_icon_svg() -> Response {
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "image/svg+xml; charset=utf-8")],
        WEB_CODEX_ICON_SVG,
    )
        .into_response()
}

async fn codex_web_favicon() -> Response {
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "image/svg+xml; charset=utf-8"),
            (header::CACHE_CONTROL, "public, max-age=86400"),
        ],
        WEB_CODEX_ICON_SVG,
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

#[derive(Deserialize)]
struct CodexFileQuery {
    path: String,
}

async fn codex_file(State(st): State<GatewayState>, headers: HeaderMap, Query(q): Query<CodexFileQuery>) -> Response {
    if let Some(resp) = require_codex_auth(&st, &headers) {
        return resp;
    }
    let raw = q.path.trim();
    if raw.is_empty() || raw.len() > 4096 {
        return api_error(StatusCode::BAD_REQUEST, "missing file path");
    }
    let path = PathBuf::from(raw);
    if !path.is_absolute() {
        return api_error(StatusCode::BAD_REQUEST, "path must be absolute");
    }
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    let content_type = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml; charset=utf-8",
        _ => return api_error(StatusCode::UNSUPPORTED_MEDIA_TYPE, "unsupported file type"),
    };

    let meta = match tokio::fs::metadata(&path).await {
        Ok(m) => m,
        Err(e) => {
            return api_error_detail(StatusCode::NOT_FOUND, "file not found", e.to_string());
        }
    };
    if meta.len() as usize > MAX_ATTACHMENT_BYTES {
        return api_error(StatusCode::PAYLOAD_TOO_LARGE, "file too large");
    }
    let bytes = match tokio::fs::read(&path).await {
        Ok(b) => b,
        Err(e) => {
            return api_error_detail(StatusCode::BAD_GATEWAY, "failed to read file", e.to_string());
        }
    };
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, content_type),
            (header::CACHE_CONTROL, "private, max-age=600"),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
        ],
        bytes,
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
    let home = crate::orchestrator::gateway::web_codex_home::web_codex_rpc_home_override();
    for method in methods {
        match crate::codex_app_server::request_in_home(home.as_deref(), method, params.clone())
            .await
        {
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
    notif_cursor: &mut u64,
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

    // Forward codex app-server JSON-RPC notifications with a per-connection cursor.
    // This aligns with clawdex-mobile: multiple clients can reconnect and replay independently,
    // and we avoid draining a global queue (which would drop events for other clients).
    let home = crate::orchestrator::gateway::web_codex_home::web_codex_rpc_home_override();
    let (mut items, first, last, gap) = crate::codex_app_server::replay_notifications_since_in_home(
        home.as_deref(),
        *notif_cursor,
        64,
    )
    .await;
    if gap {
        // Client requested an event id older than our ring buffer; tell it to reset.
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
        let (replayed, _f2, _l2, _gap2) = crate::codex_app_server::replay_notifications_since_in_home(
            home.as_deref(),
            0,
            64,
        )
        .await;
        items = replayed;
    }
    for notif in items {
        if let Some(id) = notif.get("eventId").and_then(|v| v.as_u64()) {
            *notif_cursor = (*notif_cursor).max(id);
        }
        if !send_ws_json(socket, &json!({ "type": "rpc.notification", "payload": notif }))
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
                                // Optional replay cursor from client (last seen event id).
                                notif_cursor = v
                                    .get("payload")
                                    .and_then(|p| p.get("lastEventId"))
                                    .and_then(|x| x.as_u64())
                                    .unwrap_or(0);
                                // Replay any missed notifications immediately.
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
    #[serde(default)]
    force: Option<bool>,
}

type WorkspaceTarget = crate::orchestrator::gateway::web_codex_home::WorkspaceTarget;

fn parse_workspace_target(value: &str) -> Option<WorkspaceTarget> {
    crate::orchestrator::gateway::web_codex_home::parse_workspace_target(value)
}

#[derive(Deserialize)]
struct CodexFoldersQuery {
    #[serde(default)]
    workspace: Option<String>,
    #[serde(default)]
    path: Option<String>,
}

async fn codex_folders_list(
    State(st): State<GatewayState>,
    headers: HeaderMap,
    Query(query): Query<CodexFoldersQuery>,
) -> Response {
    if let Some(resp) = require_codex_auth(&st, &headers) {
        return resp;
    }
    let requested_workspace = query.workspace.unwrap_or_else(|| "windows".to_string());
    let Some(target) =
        crate::orchestrator::gateway::web_codex_home::parse_workspace_target(&requested_workspace)
    else {
        return api_error(StatusCode::BAD_REQUEST, "workspace must be windows or wsl2");
    };

    match target {
        WorkspaceTarget::Windows => {
            let requested_path = query
                .path
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty());
            if requested_path.is_none() {
                let items =
                    crate::orchestrator::gateway::web_codex_home::windows_root_folders();
                return Json(json!({
                    "workspace": "windows",
                    "currentPath": Value::Null,
                    "parentPath": Value::Null,
                    "items": items,
                }))
                .into_response();
            }
            let path_raw = requested_path.unwrap_or_default();
            let path = PathBuf::from(path_raw);
            if !path.is_absolute() {
                return api_error(StatusCode::BAD_REQUEST, "path must be an absolute folder path");
            }
            if !path.is_dir() {
                return api_error(StatusCode::BAD_REQUEST, "path is not a directory");
            }
            let current_path = path.to_string_lossy().to_string();
            let parent_path = path.parent().map(|p| p.to_string_lossy().to_string());
            match crate::orchestrator::gateway::web_codex_home::list_local_subdirectories(&path) {
                Ok(items) => Json(json!({
                    "workspace": "windows",
                    "currentPath": current_path,
                    "parentPath": parent_path,
                    "items": items,
                }))
                .into_response(),
                Err(e) => api_error_detail(StatusCode::BAD_GATEWAY, "failed to list folders", e),
            }
        }
        WorkspaceTarget::Wsl2 => match crate::orchestrator::gateway::web_codex_home::list_wsl_subdirectories(query.path.as_deref()) {
            Ok((current_path, parent_path, items)) => Json(json!({
                "workspace": "wsl2",
                "currentPath": current_path,
                "parentPath": parent_path,
                "items": items,
            }))
            .into_response(),
            Err(e) => api_error_detail(StatusCode::BAD_GATEWAY, "failed to list folders", e),
        },
    }
}

fn current_unix_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|v| v.as_secs() as i64)
        .unwrap_or(0)
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
    import_rollout_file_into_codex_home(thread_id, src_file.as_path())
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
        "python3 - <<'PY'\nfrom pathlib import Path\nimport os\nneedle = '{thread_id}'\nroot = Path.home() / '.codex' / 'sessions'\ndistro = (os.environ.get('WSL_DISTRO_NAME') or '').strip()\nif not root.exists():\n    raise SystemExit(0)\nfor p in root.rglob('*.jsonl'):\n    if needle in p.name:\n        text = str(p)\n        if distro and text.startswith('/'):\n            print('\\\\\\\\wsl.localhost\\\\' + distro + text.replace('/', '\\\\'))\n        else:\n            print(text)\n        break\nPY"
    );
    let mut cmd = std::process::Command::new("wsl.exe");
    cmd.arg("-e").arg("bash").arg("-lc").arg(script);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let output = cmd.output().ok()?;
    if !output.status.success() {
        return None;
    }
    let windows_path = String::from_utf8_lossy(&output.stdout)
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
    import_rollout_file_into_codex_home(thread_id, src_file.as_path())
}

fn import_rollout_file_into_codex_home(thread_id: &str, src_file: &Path) -> Result<bool, String> {
    if !src_file.exists() || !src_file.is_file() {
        return Ok(false);
    }
    let file_name = src_file
        .file_name()
        .and_then(|v| v.to_str())
        .unwrap_or_default();
    let is_jsonl = src_file
        .extension()
        .and_then(|v| v.to_str())
        .map(|v| v.eq_ignore_ascii_case("jsonl"))
        .unwrap_or(false);
    if !is_jsonl || !file_name.contains(thread_id) {
        return Ok(false);
    }
    let dst_dir = codex_home_dir_result()?.join("sessions").join("imported");
    std::fs::create_dir_all(&dst_dir).map_err(|e| e.to_string())?;
    let dst_file = dst_dir.join(format!("{thread_id}.jsonl"));
    if dst_file.exists() {
        let src_meta = std::fs::metadata(src_file).ok();
        let dst_meta = std::fs::metadata(&dst_file).ok();
        if let (Some(src_meta), Some(dst_meta)) = (src_meta, dst_meta) {
            let same_len = src_meta.len() == dst_meta.len();
            let up_to_date = match (src_meta.modified().ok(), dst_meta.modified().ok()) {
                (Some(src_modified), Some(dst_modified)) => dst_modified >= src_modified,
                _ => same_len,
            };
            if same_len && up_to_date {
                return Ok(true);
            }
        }
    }
    std::fs::copy(src_file, dst_file).map_err(|e| e.to_string())?;
    Ok(true)
}

fn linux_wsl_path_to_windows_path(path: &str) -> Option<PathBuf> {
    if !cfg!(target_os = "windows") {
        return None;
    }
    let trimmed = path.trim();
    if !trimmed.starts_with('/') {
        return None;
    }
    let mut cmd = std::process::Command::new("wsl.exe");
    cmd.arg("-e").arg("wslpath").arg("-w").arg(trimmed);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let output = cmd.output().ok()?;
    if !output.status.success() {
        return None;
    }
    let windows_path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if windows_path.is_empty() {
        None
    } else {
        Some(PathBuf::from(windows_path))
    }
}

fn import_wsl_rollout_from_known_path(thread_id: &str, rollout_path: &str) -> Result<bool, String> {
    if !cfg!(target_os = "windows") || !is_safe_thread_id(thread_id) {
        return Ok(false);
    }
    let trimmed = rollout_path.trim();
    if trimmed.is_empty() {
        return Ok(false);
    }
    let src_path = linux_wsl_path_to_windows_path(trimmed)
        .unwrap_or_else(|| PathBuf::from(trimmed));
    import_rollout_file_into_codex_home(thread_id, src_path.as_path())
}

fn resume_import_order(workspace_hint: Option<WorkspaceTarget>) -> Vec<WorkspaceTarget> {
    match workspace_hint {
        Some(target) => vec![target],
        None => vec![WorkspaceTarget::Windows, WorkspaceTarget::Wsl2],
    }
}

fn should_try_known_wsl_rollout_path(
    workspace_hint: Option<WorkspaceTarget>,
    rollout_path: Option<&str>,
) -> bool {
    if !matches!(workspace_hint, Some(WorkspaceTarget::Wsl2)) {
        return false;
    }
    rollout_path
        .map(str::trim)
        .map(|v| !v.is_empty())
        .unwrap_or(false)
}

fn build_threads_response_with_meta(items: Vec<Value>, meta: Value) -> Response {
    Json(json!({
        "items": {
            "data": items,
            "nextCursor": Value::Null
        },
        "meta": meta,
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

#[cfg(test)]
mod cli_config_tests {
    use super::extract_model_and_effort_from_toml;

    #[test]
    fn parses_model_and_effort() {
        let txt = r#"
model = "gpt-5.2"
model_reasoning_effort = "medium"
"#;
        let snap = extract_model_and_effort_from_toml(txt);
        assert_eq!(snap.model.as_deref(), Some("gpt-5.2"));
        assert_eq!(snap.reasoning_effort.as_deref(), Some("medium"));
    }

    #[test]
    fn ignores_empty_values() {
        let txt = r#"
model = ""
model_reasoning_effort = "   "
"#;
        let snap = extract_model_and_effort_from_toml(txt);
        assert_eq!(snap.model.as_deref(), None);
        assert_eq!(snap.reasoning_effort.as_deref(), None);
    }
}

#[cfg(test)]
mod turn_start_request_tests {
    use super::TurnStartRequest;

    #[test]
    fn turn_start_request_accepts_reasoning_effort() {
        let raw = r#"{"threadId":"t1","prompt":"hi","model":"gpt-5.2","reasoningEffort":"high","collaborationMode":"default"}"#;
        let req: TurnStartRequest = serde_json::from_str(raw).expect("deserialize");
        assert_eq!(req.model.as_deref(), Some("gpt-5.2"));
        assert_eq!(req.reasoning_effort.as_deref(), Some("high"));
    }
}

#[cfg(test)]
mod split_stream_chunks_tests {
    use super::split_stream_chunks;

    #[test]
    fn chunks_split_on_newlines_and_length() {
        let txt = "line1\nline2\n".to_string() + &"x".repeat(120);
        let chunks = split_stream_chunks(&txt);
        assert!(chunks.len() >= 4, "expected multiple chunks, got {}", chunks.len());
        assert!(chunks.iter().any(|c| c.contains('\n')), "expected newline-preserving chunks");
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
    let started = std::time::Instant::now();
    let requested_workspace = query.workspace.unwrap_or_default();
    let workspace_meta = if requested_workspace.trim().is_empty() {
        "all".to_string()
    } else {
        requested_workspace.trim().to_ascii_lowercase()
    };
    let force = query.force.unwrap_or(false);
    let target = parse_workspace_target(&requested_workspace);
    let snapshot =
        crate::orchestrator::gateway::web_codex_threads::list_threads_snapshot(target, force)
            .await;
    let total_ms = i64::try_from(started.elapsed().as_millis()).unwrap_or(i64::MAX);
    build_threads_response_with_meta(
        snapshot.items,
        json!({
            "workspace": workspace_meta,
            "cacheHit": snapshot.cache_hit,
            "source": "session-index",
            "rebuildMs": snapshot.rebuild_ms,
            "totalMs": total_ms
        }),
    )
}

#[derive(Deserialize)]
struct ThreadCreateRequest {
    #[serde(default)]
    workspace: Option<String>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    cwd: Option<String>,
}

async fn codex_threads_create(
    State(st): State<GatewayState>,
    headers: HeaderMap,
    LoggedJson(req): LoggedJson<ThreadCreateRequest>,
) -> Response {
    if let Some(resp) = require_codex_auth(&st, &headers) {
        return resp;
    }
    let params = json!({ "workspace": req.workspace, "title": req.title, "cwd": req.cwd });
    match codex_rpc_call("thread/new", params).await {
        Ok(v) => {
            crate::orchestrator::gateway::web_codex_threads::invalidate_thread_list_cache_all();
            Json(v).into_response()
        }
        Err(resp) => resp,
    }
}

async fn codex_thread_history(
    State(st): State<GatewayState>,
    headers: HeaderMap,
    Query(_query): Query<ThreadResumeQuery>,
    AxumPath(id): AxumPath<String>,
) -> Response {
    if let Some(resp) = require_codex_auth(&st, &headers) {
        return resp;
    }
    // clawdex-mobile uses thread/read (structured API). This avoids leaking bootstrap/system prompt
    // text from local JSONL and keeps the UI aligned with Codex app-server behavior.
    let params = json!({
        "threadId": id,
        "includeTurns": true,
    });
    let home = crate::orchestrator::gateway::web_codex_home::web_codex_rpc_home_override();
    match crate::codex_app_server::request_in_home(home.as_deref(), "thread/read", params).await {
        Ok(v) => {
            let thread = v.get("thread").cloned().unwrap_or(v);
            Json(json!({ "thread": thread })).into_response()
        }
        Err(first_error) => {
            // Match clawdex: if includeTurns materialization isn't available, fall back to summary.
            let lower = first_error.to_ascii_lowercase();
            let is_materialization_gap =
                lower.contains("includeturns") && (lower.contains("material") || lower.contains("materialis"));
            if is_materialization_gap {
                let fallback = json!({
                    "threadId": id,
                    "includeTurns": false,
                });
                match crate::codex_app_server::request_in_home(home.as_deref(), "thread/read", fallback).await {
                    Ok(v) => {
                        let thread = v.get("thread").cloned().unwrap_or(v);
                        Json(json!({ "thread": thread })).into_response()
                    }
                    Err(_) => api_error_detail(
                        StatusCode::BAD_GATEWAY,
                        "failed to read thread",
                        first_error,
                    ),
                }
            } else {
                api_error_detail(
                    StatusCode::BAD_GATEWAY,
                    "failed to read thread",
                    first_error,
                )
            }
        }
    }
}

async fn codex_thread_resume(
    State(st): State<GatewayState>,
    headers: HeaderMap,
    Query(query): Query<ThreadResumeQuery>,
    AxumPath(id): AxumPath<String>,
) -> Response {
    if let Some(resp) = require_codex_auth(&st, &headers) {
        return resp;
    }
    let workspace_hint = query.workspace.as_deref().and_then(parse_workspace_target);
    let rollout_hint = if matches!(workspace_hint, Some(WorkspaceTarget::Wsl2)) {
        query
            .rollout_path
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    } else {
        None
    };
    if should_try_known_wsl_rollout_path(workspace_hint, rollout_hint.as_deref()) {
        if let Some(rollout_path) = rollout_hint.as_deref() {
            match import_wsl_rollout_from_known_path(&id, rollout_path) {
                Ok(_) => {}
                Err(import_error) => {
                    return api_error_detail(
                        StatusCode::BAD_GATEWAY,
                        "failed to resume thread",
                        format!("import failed: {import_error}"),
                    );
                }
            }
        }
    }

    let params = json!({ "threadId": id });
    let home = crate::orchestrator::gateway::web_codex_home::web_codex_rpc_home_override();
    match crate::codex_app_server::request_in_home(home.as_deref(), "thread/resume", params.clone()).await {
        Ok(v) => {
            Json(v).into_response()
        }
        Err(first_error) => {
            let lower = first_error.to_ascii_lowercase();
            let missing_rollout =
                lower.contains("no rollout found") || lower.contains("thread id");
            if missing_rollout {
                if should_try_known_wsl_rollout_path(workspace_hint, rollout_hint.as_deref()) {
                    if let Some(rollout_path) = rollout_hint.as_deref() {
                        match import_wsl_rollout_from_known_path(&id, rollout_path) {
                            Ok(true) => {
                                match crate::codex_app_server::request_in_home(home.as_deref(), "thread/resume", params.clone()).await {
                                    Ok(v) => {
                                        return Json(v).into_response();
                                    }
                                    Err(second_error) => {
                                        return api_error_detail(
                                            StatusCode::BAD_GATEWAY,
                                            "failed to resume thread",
                                            second_error,
                                        );
                                    }
                                }
                            }
                            Ok(false) => {}
                            Err(import_error) => {
                                return api_error_detail(
                                    StatusCode::BAD_GATEWAY,
                                    "failed to resume thread",
                                    format!("{first_error}; import failed: {import_error}"),
                                );
                            }
                        }
                    }
                }
                let import_order = resume_import_order(workspace_hint);
                for target in import_order {
                    let import_result = match target {
                        WorkspaceTarget::Windows => import_windows_rollout_into_codex_home(&id),
                        WorkspaceTarget::Wsl2 => import_wsl_rollout_into_codex_home(&id),
                    };
                    match import_result {
                        Ok(true) => match crate::codex_app_server::request_in_home(home.as_deref(), "thread/resume", params.clone()).await {
                            Ok(v) => {
                                return Json(v).into_response();
                            }
                            Err(second_error) => {
                                return api_error_detail(
                                    StatusCode::BAD_GATEWAY,
                                    "failed to resume thread",
                                    second_error,
                                );
                            }
                        },
                        Ok(false) => continue,
                        Err(import_error) => {
                            return api_error_detail(
                                StatusCode::BAD_GATEWAY,
                                "failed to resume thread",
                                format!("{first_error}; import failed: {import_error}"),
                            );
                        }
                    }
                }
                api_error_detail(
                    StatusCode::BAD_GATEWAY,
                    "failed to resume thread",
                    first_error,
                )
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
struct ThreadResumeQuery {
    #[serde(default)]
    workspace: Option<String>,
    #[serde(default, rename = "rolloutPath")]
    rollout_path: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TurnStartRequest {
    #[serde(default)]
    thread_id: Option<String>,
    prompt: String,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    reasoning_effort: Option<String>,
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
        "cwd": req.cwd,
        "model": req.model,
        "reasoningEffort": req.reasoning_effort,
        "collaborationMode": req.collaboration_mode.unwrap_or_else(|| "default".to_string()),
    });
    match codex_rpc_call("turn/start", params).await {
        Ok(v) => {
            Json(v).into_response()
        }
        Err(resp) => resp,
    }
}

fn split_stream_chunks(text: &str) -> Vec<String> {
    // Visual-friendly chunking for the web UI "live" animation:
    // - Prefer splitting on newline boundaries when present.
    // - Otherwise, split into small-ish character chunks so `.streamChunk` animations are visible.
    let mut out: Vec<String> = Vec::new();
    let mut cur = String::new();

    let push_cur = |out: &mut Vec<String>, cur: &mut String| {
        let trimmed = cur.trim_matches(' ');
        if !trimmed.is_empty() {
            out.push(trimmed.to_string());
        }
        cur.clear();
    };

    // Keep the existing "collapse whitespace" semantics (matches legacy tests) while preserving
    // newline boundaries as explicit chunk separators.
    let lines: Vec<&str> = text.split('\n').collect();
    for (idx, line) in lines.iter().enumerate() {
        for word in line.split_whitespace() {
            if cur.is_empty() {
                cur.push_str(word);
            } else {
                // Avoid mid-word splits: only split on word boundaries.
                if cur.len().saturating_add(1).saturating_add(word.len()) >= 44 {
                    push_cur(&mut out, &mut cur);
                    cur.push_str(word);
                } else {
                    cur.push(' ');
                    cur.push_str(word);
                }
            }
        }
        // Preserve explicit newlines between lines.
        if idx + 1 < lines.len() {
            push_cur(&mut out, &mut cur);
            out.push("\n".to_string());
        }
    }
    push_cur(&mut out, &mut cur);
    if out.is_empty() {
        out.push(String::new());
    }
    out
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
        "cwd": req.cwd,
        "model": req.model,
        "reasoningEffort": req.reasoning_effort,
        "collaborationMode": req.collaboration_mode.unwrap_or_else(|| "default".to_string()),
    });
    let started = sse_event("started", &json!({ "ok": true }));
    let home = crate::orchestrator::gateway::web_codex_home::web_codex_rpc_home_override();
    let call = crate::codex_app_server::request_in_home(home.as_deref(), "turn/start", params).await;
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

#[derive(Clone, Serialize)]
struct CodexVersionInfo {
    windows: String,
    wsl2: String,
    #[serde(rename = "windowsInstalled")]
    windows_installed: bool,
    #[serde(rename = "wsl2Installed")]
    wsl2_installed: bool,
    #[serde(rename = "appVersion")]
    app_version: String,
    #[serde(rename = "buildGitSha")]
    build_git_sha: String,
    #[serde(rename = "buildGitShortSha")]
    build_git_short_sha: String,
    #[serde(rename = "repoGitSha")]
    repo_git_sha: Option<String>,
    #[serde(rename = "repoGitShortSha")]
    repo_git_short_sha: Option<String>,
    #[serde(rename = "buildStale")]
    build_stale: bool,
}

#[derive(Clone)]
struct CodexVersionInfoCache {
    value: CodexVersionInfo,
    updated_at_unix_secs: i64,
}

fn codex_version_info_cache() -> &'static std::sync::Mutex<Option<CodexVersionInfoCache>> {
    static CACHE: std::sync::OnceLock<std::sync::Mutex<Option<CodexVersionInfoCache>>> =
        std::sync::OnceLock::new();
    CACHE.get_or_init(|| std::sync::Mutex::new(None))
}

fn lock_codex_version_info_cache(
) -> std::sync::MutexGuard<'static, Option<CodexVersionInfoCache>> {
    match codex_version_info_cache().lock() {
        Ok(v) => v,
        Err(err) => err.into_inner(),
    }
}

async fn run_version_cmd(mut cmd: Command) -> Option<String> {
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::null());
    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    let timed = tokio::time::timeout(
        std::time::Duration::from_secs(VERSION_DETECT_TIMEOUT_SECS),
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

fn resolve_repo_root_for_git() -> Option<PathBuf> {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let candidate = dir.to_path_buf();
            if candidate.join(".git").exists() {
                return Some(candidate);
            }
        }
    }
    let cwd = std::env::current_dir().ok()?;
    if cwd.join(".git").exists() {
        Some(cwd)
    } else {
        None
    }
}

fn detect_repo_git_sha() -> Option<String> {
    let repo_root = resolve_repo_root_for_git()?;
    let mut cmd = std::process::Command::new("git");
    cmd.arg("-C").arg(repo_root).arg("rev-parse").arg("HEAD");
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let output = cmd.output().ok()?;
    if !output.status.success() {
        return None;
    }
    let sha = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if sha.is_empty() {
        None
    } else {
        Some(sha)
    }
}

async fn codex_version_info(
    State(st): State<GatewayState>,
    headers: HeaderMap,
) -> Response {
    if let Some(resp) = require_codex_auth(&st, &headers) {
        return resp;
    }
    let now = current_unix_secs();
    if let Some(cached) = lock_codex_version_info_cache().clone() {
        if now.saturating_sub(cached.updated_at_unix_secs) < VERSION_INFO_CACHE_SECS {
            return Json(cached.value).into_response();
        }
    }

    let (windows, wsl2) = tokio::join!(detect_windows_codex_version(), detect_wsl_codex_version());
    let build_git_sha = option_env!("API_ROUTER_BUILD_GIT_SHA")
        .unwrap_or("unknown")
        .to_string();
    let build_git_short_sha = option_env!("API_ROUTER_BUILD_GIT_SHORT_SHA")
        .unwrap_or("unknown")
        .to_string();
    let repo_git_sha = detect_repo_git_sha();
    let repo_git_short_sha = repo_git_sha.as_deref().map(|sha| {
        if sha.len() > 8 {
            sha[..8].to_string()
        } else {
            sha.to_string()
        }
    });
    let build_stale = repo_git_sha
        .as_deref()
        .is_some_and(|repo| !build_git_sha.eq_ignore_ascii_case(repo));
    let payload = CodexVersionInfo {
        windows_installed: windows != "Not installed",
        wsl2_installed: wsl2 != "Not installed",
        windows,
        wsl2,
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        build_git_sha,
        build_git_short_sha,
        repo_git_sha,
        repo_git_short_sha,
        build_stale,
    };
    {
        let mut cache = lock_codex_version_info_cache();
        *cache = Some(CodexVersionInfoCache {
            value: payload.clone(),
            updated_at_unix_secs: now,
        });
    }
    Json(payload).into_response()
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
    use super::{
        parse_slash_command, resume_import_order, should_try_known_wsl_rollout_path,
        split_stream_chunks, truncate_output, WorkspaceTarget, MAX_TERMINAL_OUTPUT_BYTES,
    };

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

    #[test]
    fn resume_import_order_respects_workspace_hint() {
        let default_order = resume_import_order(None);
        assert_eq!(
            default_order,
            vec![WorkspaceTarget::Windows, WorkspaceTarget::Wsl2]
        );

        let wsl_order = resume_import_order(Some(WorkspaceTarget::Wsl2));
        assert_eq!(wsl_order, vec![WorkspaceTarget::Wsl2]);

        let windows_order = resume_import_order(Some(WorkspaceTarget::Windows));
        assert_eq!(windows_order, vec![WorkspaceTarget::Windows]);
    }

    #[test]
    fn known_wsl_rollout_path_only_applies_to_wsl_with_path() {
        assert!(should_try_known_wsl_rollout_path(
            Some(WorkspaceTarget::Wsl2),
            Some("C:\\\\tmp\\\\a.jsonl")
        ));
        assert!(!should_try_known_wsl_rollout_path(
            Some(WorkspaceTarget::Wsl2),
            Some("   ")
        ));
        assert!(!should_try_known_wsl_rollout_path(
            Some(WorkspaceTarget::Windows),
            Some("C:\\\\tmp\\\\a.jsonl")
        ));
        assert!(!should_try_known_wsl_rollout_path(None, Some("C:\\\\tmp\\\\a.jsonl")));
    }

}
