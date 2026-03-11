use super::*;
use crate::orchestrator::gateway::web_codex_auth::{
    api_error, api_error_detail, require_codex_auth,
};
use crate::orchestrator::gateway::web_codex_storage::{codex_attachments_dir, sanitize_name};
use axum::extract::Path as AxumPath;
use base64::Engine;
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct TurnStartRequest {
    #[serde(default)]
    pub(super) thread_id: Option<String>,
    pub(super) prompt: String,
    #[serde(default)]
    pub(super) workspace: Option<String>,
    #[serde(default)]
    pub(super) cwd: Option<String>,
    #[serde(default)]
    pub(super) model: Option<String>,
    #[serde(default)]
    pub(super) reasoning_effort: Option<String>,
}

pub(super) fn turn_thread_id(req: &TurnStartRequest) -> Option<&str> {
    req.thread_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

pub(super) fn build_turn_start_params(thread_id: &str, req: &TurnStartRequest) -> Value {
    json!({
        "threadId": thread_id,
        "input": [
            {
                "type": "text",
                "text": req.prompt,
                "textElements": []
            }
        ],
        "workspace": req.workspace,
        "cwd": req.cwd,
        "model": req.model,
        "effort": req.reasoning_effort,
    })
}

pub(super) fn build_turn_start_response(thread_id: &str, result: Value) -> Value {
    let turn_id = result
        .get("turn")
        .and_then(|value| value.get("id"))
        .cloned()
        .or_else(|| result.get("turnId").cloned())
        .or_else(|| result.get("turn_id").cloned())
        .unwrap_or(Value::Null);
    json!({
        "threadId": thread_id,
        "turnId": turn_id,
        "result": result,
    })
}

pub(super) async fn codex_turn_start(
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
    let Some(thread_id) = turn_thread_id(&req).map(ToString::to_string) else {
        return api_error(StatusCode::BAD_REQUEST, "threadId is required");
    };
    let params = build_turn_start_params(&thread_id, &req);
    match super::codex_rpc_call("turn/start", params).await {
        Ok(v) => Json(build_turn_start_response(&thread_id, v)).into_response(),
        Err(resp) => resp,
    }
}

fn sse_event(name: &str, value: &Value) -> Bytes {
    let data = value.to_string();
    Bytes::from(format!("event: {name}\ndata: {data}\n\n"))
}

pub(super) async fn codex_turn_stream(
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
    let Some(thread_id) = turn_thread_id(&req).map(ToString::to_string) else {
        return api_error(StatusCode::BAD_REQUEST, "threadId is required");
    };
    let params = build_turn_start_params(&thread_id, &req);
    let started = sse_event("started", &json!({ "ok": true, "threadId": thread_id }));
    let home = crate::orchestrator::gateway::web_codex_home::web_codex_rpc_home_override_for_target(
        req.workspace
            .as_deref()
            .and_then(crate::orchestrator::gateway::web_codex_home::parse_workspace_target),
    );
    let call =
        crate::codex_app_server::request_in_home(home.as_deref(), "turn/start", params).await;
    let stream = async_stream::stream! {
        yield Ok::<Bytes, std::convert::Infallible>(started);
        match call {
            Ok(result) => {
                yield Ok(sse_event("completed", &build_turn_start_response(&thread_id, result)));
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

pub(super) async fn codex_turn_interrupt(
    State(st): State<GatewayState>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
) -> Response {
    if let Some(resp) = require_codex_auth(&st, &headers) {
        return resp;
    }
    match super::codex_rpc_call("turn/interrupt", json!({ "turnId": id })).await {
        Ok(v) => Json(v).into_response(),
        Err(resp) => resp,
    }
}

#[derive(Deserialize)]
pub(super) struct ApprovalResolveRequest {
    decision: String,
}

pub(super) async fn codex_approval_resolve(
    State(st): State<GatewayState>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    LoggedJson(req): LoggedJson<ApprovalResolveRequest>,
) -> Response {
    if let Some(resp) = require_codex_auth(&st, &headers) {
        return resp;
    }
    match super::codex_rpc_call(
        "bridge/approvals/resolve",
        json!({ "id": id, "decision": req.decision }),
    )
    .await
    {
        Ok(v) => Json(v).into_response(),
        Err(resp) => resp,
    }
}

#[derive(Deserialize)]
pub(super) struct UserInputResolveRequest {
    answers: Value,
}

pub(super) async fn codex_user_input_resolve(
    State(st): State<GatewayState>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    LoggedJson(req): LoggedJson<UserInputResolveRequest>,
) -> Response {
    if let Some(resp) = require_codex_auth(&st, &headers) {
        return resp;
    }
    match super::codex_rpc_call(
        "bridge/userInput/resolve",
        json!({ "id": id, "answers": req.answers }),
    )
    .await
    {
        Ok(v) => Json(v).into_response(),
        Err(resp) => resp,
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct UploadRequest {
    thread_id: String,
    file_name: String,
    #[serde(default)]
    mime_type: String,
    base64_data: String,
}

pub(super) async fn codex_attachments_upload(
    State(st): State<GatewayState>,
    headers: HeaderMap,
    LoggedJson(req): LoggedJson<UploadRequest>,
) -> Response {
    if let Some(resp) = require_codex_auth(&st, &headers) {
        return resp;
    }
    if req.thread_id.trim().is_empty() || req.file_name.trim().is_empty() {
        return api_error(
            StatusCode::BAD_REQUEST,
            "threadId and fileName are required",
        );
    }
    let max_base64_len = super::MAX_ATTACHMENT_BYTES.div_ceil(3) * 4 + 8;
    if req.base64_data.len() > max_base64_len {
        return api_error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "attachment too large (max 10 MiB)",
        );
    }
    let bytes = match base64::engine::general_purpose::STANDARD.decode(req.base64_data.as_bytes()) {
        Ok(v) => v,
        Err(e) => {
            return api_error_detail(StatusCode::BAD_REQUEST, "invalid base64Data", e.to_string())
        }
    };
    if bytes.len() > super::MAX_ATTACHMENT_BYTES {
        return api_error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "attachment too large (max 10 MiB)",
        );
    }
    let base_dir = match codex_attachments_dir() {
        Ok(v) => v,
        Err(e) => {
            return api_error_detail(
                StatusCode::INTERNAL_SERVER_ERROR,
                "failed to resolve attachments dir",
                e,
            )
        }
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
        return api_error_detail(
            StatusCode::INTERNAL_SERVER_ERROR,
            "failed to write attachment",
            e.to_string(),
        );
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
pub(super) struct SlashRequest {
    command: String,
    #[serde(default)]
    thread_id: Option<String>,
}

#[derive(Debug)]
pub(super) struct ParsedSlash {
    method: String,
    params: Value,
}

pub(super) fn parse_slash_command(input: &str) -> Option<ParsedSlash> {
    let mut parts = input.split_whitespace();
    match parts.next()? {
        "/help" => Some(ParsedSlash {
            method: "help/read".to_string(),
            params: Value::Null,
        }),
        "/new" => Some(ParsedSlash {
            method: "thread/start".to_string(),
            params: Value::Null,
        }),
        "/status" => Some(ParsedSlash {
            method: "status/read".to_string(),
            params: Value::Null,
        }),
        "/compact" => Some(ParsedSlash {
            method: "thread/compact".to_string(),
            params: Value::Null,
        }),
        "/review" => Some(ParsedSlash {
            method: "review/start".to_string(),
            params: Value::Null,
        }),
        "/fork" => Some(ParsedSlash {
            method: "thread/fork".to_string(),
            params: Value::Null,
        }),
        "/diff" => Some(ParsedSlash {
            method: "thread/diff".to_string(),
            params: Value::Null,
        }),
        "/model" => {
            let model = parts.collect::<Vec<_>>().join(" ");
            if model.trim().is_empty() {
                return None;
            }
            Some(ParsedSlash {
                method: "thread/model/set".to_string(),
                params: json!({ "model": model }),
            })
        }
        "/rename" => {
            let title = parts.collect::<Vec<_>>().join(" ");
            if title.trim().is_empty() {
                return None;
            }
            Some(ParsedSlash {
                method: "thread/rename".to_string(),
                params: json!({ "title": title }),
            })
        }
        "/plan" => {
            let arg = parts.collect::<Vec<_>>().join(" ");
            let mode = arg.trim().to_ascii_lowercase();
            if mode.is_empty() || mode == "on" {
                return Some(ParsedSlash {
                    method: "thread/collaborationMode/set".to_string(),
                    params: json!({ "mode": "plan" }),
                });
            }
            if mode == "off" {
                return Some(ParsedSlash {
                    method: "thread/collaborationMode/set".to_string(),
                    params: json!({ "mode": "default" }),
                });
            }
            Some(ParsedSlash {
                method: "turn/start".to_string(),
                params: json!({ "prompt": arg }),
            })
        }
        _ => None,
    }
}

pub(super) async fn codex_slash_execute(
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
    match super::codex_rpc_call(&parsed.method, params).await {
        Ok(v) => Json(json!({ "ok": true, "method": parsed.method, "result": v })).into_response(),
        Err(resp) => resp,
    }
}

#[derive(Deserialize)]
pub(super) struct RpcProxyRequest {
    method: String,
    #[serde(default)]
    params: Value,
}

pub(super) async fn codex_rpc_proxy(
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
    match super::codex_rpc_call(method, req.params).await {
        Ok(v) => Json(json!({ "result": v })).into_response(),
        Err(resp) => resp,
    }
}

#[cfg(test)]
mod tests {
    use super::{
        build_turn_start_params, build_turn_start_response, parse_slash_command, turn_thread_id,
        TurnStartRequest,
    };
    use serde_json::{json, Value};

    #[test]
    fn turn_start_request_accepts_reasoning_effort() {
        let raw = r#"{"threadId":"t1","prompt":"hi","model":"gpt-5.2","reasoningEffort":"high"}"#;
        let req: TurnStartRequest = serde_json::from_str(raw).expect("deserialize");
        assert_eq!(req.model.as_deref(), Some("gpt-5.2"));
        assert_eq!(req.reasoning_effort.as_deref(), Some("high"));
    }

    #[test]
    fn turn_start_params_omit_collaboration_mode_when_absent() {
        let raw = r#"{"threadId":"t1","prompt":"hi","workspace":"wsl2","model":"gpt-5.2","reasoningEffort":"high"}"#;
        let req: TurnStartRequest = serde_json::from_str(raw).expect("deserialize");
        let params = build_turn_start_params("t1", &req);
        assert_eq!(params.get("collaborationMode"), None);
        assert_eq!(params["threadId"], "t1");
        assert_eq!(params["workspace"], "wsl2");
        assert_eq!(params["input"][0]["type"], "text");
        assert_eq!(params["input"][0]["text"], "hi");
        assert_eq!(params["effort"], "high");
    }

    #[test]
    fn turn_start_params_ignore_legacy_collaboration_mode_field() {
        let raw = r#"{"threadId":"t1","prompt":"hi","collaborationMode":"plan"}"#;
        let req: TurnStartRequest = serde_json::from_str(raw).expect("deserialize");
        let params = build_turn_start_params("t1", &req);
        assert_eq!(params.get("collaborationMode"), None);
    }

    #[test]
    fn turn_thread_id_requires_non_empty_value() {
        let req = TurnStartRequest {
            thread_id: None,
            prompt: "hi".to_string(),
            workspace: None,
            cwd: None,
            model: None,
            reasoning_effort: None,
        };
        assert_eq!(turn_thread_id(&req), None);
    }

    #[test]
    fn turn_start_response_includes_thread_and_turn_ids() {
        let response = build_turn_start_response(
            "thread-1",
            json!({
                "turn": {
                    "id": "turn-1",
                    "items": [],
                    "status": "inProgress",
                    "error": Value::Null
                }
            }),
        );
        assert_eq!(response["threadId"], "thread-1");
        assert_eq!(response["turnId"], "turn-1");
    }

    #[test]
    fn parse_plan_variants() {
        let on = parse_slash_command("/plan on").expect("on");
        assert_eq!(on.method, "thread/collaborationMode/set");
        assert_eq!(on.params["mode"], "plan");

        let prompt = parse_slash_command("/plan add checklist").expect("prompt");
        assert_eq!(prompt.method, "turn/start");
        assert_eq!(prompt.params["prompt"], "add checklist");
        assert!(prompt.params.get("collaborationMode").is_none());
    }

    #[test]
    fn parse_rename_and_model_require_args() {
        assert!(parse_slash_command("/rename").is_none());
        assert!(parse_slash_command("/model").is_none());
        assert!(parse_slash_command("/rename hello").is_some());
        assert!(parse_slash_command("/model gpt-5").is_some());
    }
}
