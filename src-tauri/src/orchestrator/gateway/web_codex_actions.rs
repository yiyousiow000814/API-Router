use super::*;
use crate::orchestrator::gateway::web_codex_auth::{
    api_error, api_error_detail, require_codex_auth,
};
use crate::orchestrator::gateway::web_codex_git::{
    current_branch_for_workspace, local_branches_for_workspace, run_git_command_for_workspace,
};
use crate::orchestrator::gateway::web_codex_home::parse_workspace_target;
use crate::orchestrator::gateway::web_codex_session_manager::CodexSessionManager;
use crate::orchestrator::gateway::web_codex_storage::{codex_attachments_dir, sanitize_name};
use axum::extract::{Path as AxumPath, Query};
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::io::BufRead;

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
    #[serde(default)]
    pub(super) collaboration_mode: Option<String>,
    #[serde(default)]
    pub(super) service_tier: ServiceTierOverride,
    #[serde(default)]
    pub(super) approval_policy: Option<String>,
    #[serde(default)]
    pub(super) sandbox_policy: Option<Value>,
}

pub(super) fn turn_thread_id(req: &TurnStartRequest) -> Option<&str> {
    req.thread_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

const PLAN_PROTOCOL_INSTRUCTION: &str = "If you present an implementation plan for approval in Plan mode, wrap only the plan body in <proposed_plan>...</proposed_plan>. Keep any follow-up confirmation prompt outside those tags.";

fn prompt_with_plan_protocol(prompt: &str, collaboration_mode: Option<&str>) -> String {
    let normalized_prompt = prompt.trim();
    if normalized_prompt.is_empty() {
        return String::new();
    }
    let is_plan_mode = collaboration_mode
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .is_some_and(|value| value.eq_ignore_ascii_case("plan"));
    if !is_plan_mode {
        return normalized_prompt.to_string();
    }
    if normalized_prompt
        .to_ascii_lowercase()
        .contains("<proposed_plan>")
    {
        return normalized_prompt.to_string();
    }
    format!("{normalized_prompt}\n\n{PLAN_PROTOCOL_INSTRUCTION}")
}

pub(super) fn build_turn_start_params(thread_id: &str, req: &TurnStartRequest) -> Value {
    let prompt = prompt_with_plan_protocol(&req.prompt, req.collaboration_mode.as_deref());
    let mut params = serde_json::Map::from_iter([
        ("threadId".to_string(), Value::String(thread_id.to_string())),
        (
            "input".to_string(),
            json!([
                {
                    "type": "text",
                    "text": prompt,
                    "textElements": []
                }
            ]),
        ),
        ("workspace".to_string(), json!(req.workspace)),
        ("cwd".to_string(), json!(req.cwd)),
        ("model".to_string(), json!(req.model)),
        ("effort".to_string(), json!(req.reasoning_effort)),
    ]);
    if let Some(collaboration_mode) = req
        .collaboration_mode
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        params.insert(
            "collaborationMode".to_string(),
            Value::String(collaboration_mode.to_ascii_lowercase()),
        );
    }
    if let Some(service_tier) = service_tier_override_json(&req.service_tier) {
        params.insert("serviceTier".to_string(), service_tier);
    }
    if let Some(approval_policy) = runtime_approval_policy_json(req.approval_policy.as_deref()) {
        params.insert("approvalPolicy".to_string(), approval_policy);
    }
    if let Some(sandbox_policy) = runtime_turn_sandbox_policy_json(req.sandbox_policy.as_ref()) {
        params.insert("sandboxPolicy".to_string(), sandbox_policy);
    }
    Value::Object(params)
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(untagged)]
pub(super) enum ServiceTierOverride {
    String(String),
    Null(()),
    #[default]
    Missing,
}

fn service_tier_override_json(service_tier: &ServiceTierOverride) -> Option<Value> {
    match service_tier {
        ServiceTierOverride::String(value) => {
            Some(Value::String(value.trim().to_ascii_lowercase()))
        }
        ServiceTierOverride::Null(_) => Some(Value::Null),
        ServiceTierOverride::Missing => None,
    }
}

fn runtime_approval_policy_json(value: Option<&str>) -> Option<Value> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| Value::String(value.to_string()))
}

fn runtime_thread_sandbox_json(value: Option<&str>) -> Option<Value> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| Value::String(value.to_string()))
}

fn runtime_turn_sandbox_policy_json(value: Option<&Value>) -> Option<Value> {
    value.cloned()
}

fn terminal_session_turn_options(
    req: &TurnStartRequest,
) -> crate::platform::codex_terminal_session::TerminalSessionTurnOptions {
    crate::platform::codex_terminal_session::TerminalSessionTurnOptions {
        model: req.model.clone(),
        plan_mode: match req
            .collaboration_mode
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| value.eq_ignore_ascii_case("plan"))
        {
            Some(true) => crate::platform::codex_terminal_session::TerminalToggleOverride::Enabled,
            Some(false) | None => {
                crate::platform::codex_terminal_session::TerminalToggleOverride::Disabled
            }
        },
        fast_mode: match &req.service_tier {
            ServiceTierOverride::String(value) if value.trim().eq_ignore_ascii_case("fast") => {
                crate::platform::codex_terminal_session::TerminalToggleOverride::Enabled
            }
            ServiceTierOverride::String(_) | ServiceTierOverride::Null(_) => {
                crate::platform::codex_terminal_session::TerminalToggleOverride::Disabled
            }
            ServiceTierOverride::Missing => {
                crate::platform::codex_terminal_session::TerminalToggleOverride::Missing
            }
        },
        approval_policy: req.approval_policy.clone(),
        sandbox_policy: req.sandbox_policy.clone(),
    }
}

pub(super) fn build_turn_start_response(
    thread_id: &str,
    result: Value,
    rollout_path: Option<&str>,
) -> Value {
    let turn_id = result
        .get("turn")
        .and_then(|value| value.get("id"))
        .cloned()
        .or_else(|| result.get("turnId").cloned())
        .or_else(|| result.get("turn_id").cloned())
        .unwrap_or(Value::Null);
    let mut response = json!({
        "threadId": thread_id,
        "turnId": turn_id,
        "result": result,
    });
    if let Some(path) = rollout_path.map(str::trim).filter(|path| !path.is_empty()) {
        if let Some(obj) = response.as_object_mut() {
            obj.insert("rolloutPath".to_string(), Value::String(path.to_string()));
        }
    }
    response
}

async fn try_terminal_turn_start(
    st: &GatewayState,
    req: &TurnStartRequest,
    thread_id: &str,
    workspace_target: Option<WorkspaceTarget>,
) -> Result<Option<Value>, String> {
    let gateway_token = st.secrets.get_gateway_token().unwrap_or_default();
    let expected_gateway_token =
        (!gateway_token.trim().is_empty()).then_some(gateway_token.as_str());
    let server_port = { st.cfg.read().listen.port };
    let options = terminal_session_turn_options(req);
    let ack = crate::platform::codex_terminal_session::try_start_turn_in_live_session(
        server_port,
        expected_gateway_token,
        workspace_target,
        thread_id,
        &prompt_with_plan_protocol(&req.prompt, req.collaboration_mode.as_deref()),
        &options,
    )
    .await?;
    let Some(ack) = ack else {
        return Ok(None);
    };
    let rollout_path = match workspace_target {
        Some(target) => {
            crate::orchestrator::gateway::web_codex_threads::known_rollout_path_for_thread(
                target, thread_id,
            )
            .await
        }
        None => None,
    };
    Ok(Some(build_turn_start_response(
        thread_id,
        ack.payload,
        rollout_path.as_deref(),
    )))
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
    let workspace_target = req.workspace.as_deref().and_then(parse_workspace_target);
    match try_terminal_turn_start(&st, &req, &thread_id, workspace_target).await {
        Ok(Some(response)) => return Json(response).into_response(),
        Ok(None) => {}
        Err(error) => {
            return api_error_detail(
                StatusCode::BAD_GATEWAY,
                "terminal session transport failed",
                error,
            )
        }
    }
    let params = build_turn_start_params(&thread_id, &req);
    let manager = CodexSessionManager::new(workspace_target);
    match manager.turn_start(&thread_id, params).await {
        Ok(outcome) => Json(build_turn_start_response(
            &thread_id,
            outcome.result,
            outcome.rollout_path.as_deref(),
        ))
        .into_response(),
        Err(error) => api_error_detail(
            StatusCode::BAD_GATEWAY,
            "codex app-server request failed",
            error,
        ),
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
    let started = sse_event("started", &json!({ "ok": true, "threadId": thread_id }));
    let workspace_target = req.workspace.as_deref().and_then(parse_workspace_target);
    let terminal_attempt = try_terminal_turn_start(&st, &req, &thread_id, workspace_target).await;
    let params = build_turn_start_params(&thread_id, &req);
    let manager = CodexSessionManager::new(workspace_target);
    let call = async move {
        match terminal_attempt {
            Ok(Some(response)) => Ok(response),
            Ok(None) => manager.turn_start(&thread_id, params).await.map(|outcome| {
                build_turn_start_response(
                    &thread_id,
                    outcome.result,
                    outcome.rollout_path.as_deref(),
                )
            }),
            Err(error) => Err(error),
        }
    }
    .await;
    let stream = async_stream::stream! {
        yield Ok::<Bytes, std::convert::Infallible>(started);
        match call {
            Ok(response) => {
                yield Ok(sse_event("completed", &response));
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
    LoggedJson(req): LoggedJson<TurnInterruptRequest>,
) -> Response {
    if let Some(resp) = require_codex_auth(&st, &headers) {
        return resp;
    }
    let thread_id = req.thread_id.trim();
    if thread_id.is_empty() {
        return api_error(StatusCode::BAD_REQUEST, "threadId is required");
    }
    let manager = CodexSessionManager::new(None);
    match manager.interrupt_turn(thread_id, &id).await {
        Ok(v) => Json(v).into_response(),
        Err(error) => api_error_detail(
            StatusCode::BAD_GATEWAY,
            "codex app-server request failed",
            error,
        ),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct TurnInterruptRequest {
    #[serde(default)]
    pub(super) thread_id: String,
}

#[derive(Deserialize)]
pub(super) struct ThreadInterruptQuery {
    #[serde(default)]
    workspace: Option<String>,
}

#[derive(Deserialize)]
pub(super) struct ThreadTransportQuery {
    #[serde(default)]
    workspace: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ManagedTerminalRequest {
    #[serde(default)]
    workspace: Option<String>,
    #[serde(default)]
    cwd: Option<String>,
}

pub(super) async fn codex_thread_transport(
    State(st): State<GatewayState>,
    headers: HeaderMap,
    Query(query): Query<ThreadTransportQuery>,
    AxumPath(id): AxumPath<String>,
) -> Response {
    if let Some(resp) = require_codex_auth(&st, &headers) {
        return resp;
    }
    let workspace_target = query.workspace.as_deref().and_then(parse_workspace_target);
    let gateway_token = st.secrets.get_gateway_token().unwrap_or_default();
    let expected_gateway_token =
        (!gateway_token.trim().is_empty()).then_some(gateway_token.as_str());
    let server_port = { st.cfg.read().listen.port };
    match crate::platform::codex_terminal_session::lookup_live_session_by_thread(
        server_port,
        expected_gateway_token,
        workspace_target,
        &id,
    )
    .await
    {
        Ok(Some(attached)) => Json(json!({
            "ok": true,
            "threadId": attached.thread_id,
            "transport": "terminal-session",
            "attached": true,
            "cwd": attached.cwd,
            "path": attached.rollout_path
        }))
        .into_response(),
        Ok(None) => Json(json!({
            "ok": true,
            "threadId": id,
            "transport": Value::Null,
            "attached": false
        }))
        .into_response(),
        Err(error) => api_error_detail(
            StatusCode::BAD_GATEWAY,
            "terminal session transport lookup failed",
            error,
        ),
    }
}

pub(super) async fn codex_thread_open_managed_terminal(
    State(st): State<GatewayState>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    LoggedJson(req): LoggedJson<ManagedTerminalRequest>,
) -> Response {
    if let Some(resp) = require_codex_auth(&st, &headers) {
        return resp;
    }
    let Some(workspace_target) = req.workspace.as_deref().and_then(parse_workspace_target) else {
        return api_error(StatusCode::BAD_REQUEST, "workspace is required");
    };
    let gateway_token = st.secrets.get_gateway_token().unwrap_or_default();
    let manager = CodexSessionManager::new(Some(workspace_target)).with_terminal_bridge(
        st.cfg.read().listen.port,
        (!gateway_token.trim().is_empty()).then_some(gateway_token),
    );
    match manager
        .open_managed_terminal_surface(&id, req.cwd.as_deref())
        .await
    {
        Ok(attached) => Json(json!({
            "ok": true,
            "threadId": attached.thread_id,
            "transport": "terminal-session",
            "attached": true,
            "cwd": attached.cwd,
            "path": attached.rollout_path
        }))
        .into_response(),
        Err(error) => api_error_detail(
            StatusCode::BAD_GATEWAY,
            "managed terminal launch failed",
            error,
        ),
    }
}

pub(super) async fn codex_thread_interrupt(
    State(st): State<GatewayState>,
    headers: HeaderMap,
    Query(query): Query<ThreadInterruptQuery>,
    AxumPath(id): AxumPath<String>,
) -> Response {
    if let Some(resp) = require_codex_auth(&st, &headers) {
        return resp;
    }
    let workspace_target = query.workspace.as_deref().and_then(parse_workspace_target);
    let codex_home =
        crate::orchestrator::gateway::web_codex_home::web_codex_rpc_home_override_for_target(
            workspace_target,
        );
    let gateway_token = st.secrets.get_gateway_token().unwrap_or_default();
    let expected_gateway_token =
        (!gateway_token.trim().is_empty()).then_some(gateway_token.as_str());
    let server_port = { st.cfg.read().listen.port };
    match crate::platform::codex_terminal_session::try_interrupt_live_session(
        server_port,
        expected_gateway_token,
        workspace_target,
        &id,
    )
    .await
    {
        Ok(true) => {
            crate::codex_app_server::push_terminal_interrupt_notifications(
                codex_home.as_deref(),
                &id,
            )
            .await;
            Json(json!({ "ok": true, "transport": "terminal-session", "threadId": id }))
                .into_response()
        }
        Ok(false) => api_error(
            StatusCode::BAD_REQUEST,
            "no live terminal session for thread",
        ),
        Err(error) => api_error_detail(
            StatusCode::BAD_GATEWAY,
            "terminal session transport failed",
            error,
        ),
    }
}

#[derive(Deserialize)]
pub(super) struct ApprovalResolveRequest {
    decision: String,
    #[serde(default)]
    workspace: Option<String>,
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
        json!({ "id": id, "decision": req.decision, "workspace": req.workspace }),
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
    #[serde(default)]
    workspace: Option<String>,
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
        json!({ "id": id, "answers": req.answers, "workspace": req.workspace }),
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
    #[serde(default)]
    workspace: Option<String>,
    #[serde(default)]
    service_tier: ServiceTierOverride,
    #[serde(default)]
    approval_policy: Option<String>,
    #[serde(default)]
    sandbox: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub(super) struct SlashCommandsQuery {
    workspace: Option<String>,
    rollout_path: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub(super) struct SlashReviewQuery {
    workspace: Option<String>,
    cwd: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SlashReviewOption {
    value: String,
    label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    search_value: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SlashCommandDescriptor {
    command: &'static str,
    usage: &'static str,
    insert_text: &'static str,
    description: &'static str,
    #[serde(skip_serializing_if = "std::ops::Not::not", default)]
    active: bool,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    children: Vec<SlashCommandDescriptor>,
}

#[derive(Debug)]
pub(super) struct ParsedSlash {
    method: String,
    params: Value,
}

async fn review_branch_options(
    workspace: Option<&str>,
    cwd: &str,
) -> Result<Vec<SlashReviewOption>, String> {
    let current_branch = current_branch_for_workspace(workspace, cwd)
        .await
        .unwrap_or_default();
    let current_branch = if current_branch.trim().is_empty() {
        "(detached HEAD)".to_string()
    } else {
        current_branch
    };
    let mut items: Vec<SlashReviewOption> = local_branches_for_workspace(workspace, cwd)
        .await?
        .into_iter()
        .map(|branch| SlashReviewOption {
            value: branch.to_string(),
            label: format!("{current_branch} -> {branch}"),
            description: None,
            search_value: Some(branch.to_string()),
        })
        .collect();
    items.sort_by_key(|item| {
        let branch = item.value.trim().to_ascii_lowercase();
        if branch == "main" {
            0usize
        } else {
            1usize
        }
    });
    Ok(items)
}

async fn review_commit_options(
    workspace: Option<&str>,
    cwd: &str,
) -> Result<Vec<SlashReviewOption>, String> {
    let commits = run_git_command_for_workspace(
        workspace,
        cwd,
        &["log", "--pretty=format:%H\t%s", "-n", "100"],
    )
    .await?;
    Ok(commits
        .lines()
        .filter_map(|line| {
            let mut parts = line.splitn(2, '\t');
            let sha = parts.next()?.trim();
            let subject = parts.next().unwrap_or("").trim();
            if sha.is_empty() || subject.is_empty() {
                return None;
            }
            Some(SlashReviewOption {
                value: sha.to_string(),
                label: subject.to_string(),
                description: None,
                search_value: Some(format!("{subject} {sha}")),
            })
        })
        .collect())
}

fn permission_children_for_workspace(workspace: Option<&str>) -> Vec<SlashCommandDescriptor> {
    let is_wsl2 = matches!(
        workspace
            .map(str::trim)
            .map(|value| value.to_ascii_lowercase())
            .as_deref(),
        Some("wsl2")
    );
    let mut children = Vec::new();
    if !is_wsl2 {
        children.push(SlashCommandDescriptor {
            command: "/permission read-only",
            usage: "/permission read-only",
            insert_text: "/permission read-only",
            description: "Require approval and keep shell access read-only.",
            active: false,
            children: Vec::new(),
        });
    }
    children.push(SlashCommandDescriptor {
        command: "/permission auto",
        usage: "/permission auto",
        insert_text: "/permission auto",
        description: "Allow workspace-write with on-request approvals.",
        active: false,
        children: Vec::new(),
    });
    children.push(SlashCommandDescriptor {
        command: "/permission full-access",
        usage: "/permission full-access",
        insert_text: "/permission full-access",
        description: "Use danger-full-access with no approvals.",
        active: false,
        children: Vec::new(),
    });
    children
}

fn read_plan_mode_from_rollout_path(rollout_path: Option<&str>) -> Option<bool> {
    let path = rollout_path
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(std::path::PathBuf::from)?;
    let file = std::fs::File::open(path).ok()?;
    let reader = std::io::BufReader::new(file);
    let mut latest: Option<bool> = None;
    for line in reader.lines() {
        let line = line.ok()?;
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let value = serde_json::from_str::<Value>(trimmed).ok()?;
        let item_type = value
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if item_type != "event_msg" {
            continue;
        }
        let payload = value.get("payload")?;
        let event_type = payload
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if event_type != "turn_started" && event_type != "task_started" {
            continue;
        }
        let mode = payload
            .get("collaboration_mode_kind")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default()
            .to_ascii_lowercase();
        if mode.is_empty() {
            continue;
        }
        latest = Some(mode == "plan");
    }
    latest
}

pub(super) fn supported_slash_commands(
    workspace: Option<&str>,
    rollout_path: Option<&str>,
) -> Vec<SlashCommandDescriptor> {
    let plan_mode_enabled = read_plan_mode_from_rollout_path(rollout_path).unwrap_or(false);
    vec![
        SlashCommandDescriptor {
            command: "/fast",
            usage: "/fast",
            insert_text: "/fast",
            description: "Toggle Fast mode.",
            active: false,
            children: vec![
                SlashCommandDescriptor {
                    command: "/fast on",
                    usage: "/fast on",
                    insert_text: "/fast on",
                    description: "Enable Fast mode.",
                    active: false,
                    children: Vec::new(),
                },
                SlashCommandDescriptor {
                    command: "/fast off",
                    usage: "/fast off",
                    insert_text: "/fast off",
                    description: "Disable Fast mode.",
                    active: false,
                    children: Vec::new(),
                },
            ],
        },
        SlashCommandDescriptor {
            command: "/permission",
            usage: "/permission",
            insert_text: "/permission",
            description: "Open permission presets.",
            active: false,
            children: permission_children_for_workspace(workspace),
        },
        SlashCommandDescriptor {
            command: "/review",
            usage: "/review",
            insert_text: "/review",
            description: "Open review actions.",
            active: false,
            children: Vec::new(),
        },
        SlashCommandDescriptor {
            command: "/compact",
            usage: "/compact",
            insert_text: "/compact",
            description: "Compact the current thread context.",
            active: false,
            children: Vec::new(),
        },
        SlashCommandDescriptor {
            command: "/plan",
            usage: "/plan",
            insert_text: "/plan",
            description: "Open plan mode actions.",
            active: false,
            children: vec![
                SlashCommandDescriptor {
                    command: "/plan on",
                    usage: "/plan on",
                    insert_text: "/plan on",
                    description: "Enable plan mode.",
                    active: plan_mode_enabled,
                    children: Vec::new(),
                },
                SlashCommandDescriptor {
                    command: "/plan off",
                    usage: "/plan off",
                    insert_text: "/plan off",
                    description: "Disable plan mode.",
                    active: !plan_mode_enabled,
                    children: Vec::new(),
                },
            ],
        },
        SlashCommandDescriptor {
            command: "/diff",
            usage: "/diff",
            insert_text: "/diff",
            description: "Show the current thread diff.",
            active: false,
            children: Vec::new(),
        },
        SlashCommandDescriptor {
            command: "/help",
            usage: "/help",
            insert_text: "/help",
            description: "Show slash command help from Codex.",
            active: false,
            children: Vec::new(),
        },
    ]
}

fn permission_preset_runtime_result(
    workspace: Option<&str>,
    command: &str,
) -> Result<Value, String> {
    let is_wsl2 = matches!(
        workspace
            .map(str::trim)
            .map(|value| value.to_ascii_lowercase())
            .as_deref(),
        Some("wsl2")
    );
    let (preset, approval_policy, sandbox) = match command.trim().to_ascii_lowercase().as_str() {
        "/permission read-only" if is_wsl2 => {
            return Err("read-only preset is not available for wsl2".to_string())
        }
        "/permission read-only" => ("read-only", "untrusted", "readOnly"),
        "/permission auto" => ("auto", "on-request", "workspaceWrite"),
        "/permission full-access" => ("full-access", "never", "dangerFullAccess"),
        _ => return Err("unsupported slash command".to_string()),
    };
    Ok(json!({
        "preset": preset,
        "approvalPolicy": approval_policy,
        "sandbox": sandbox,
        "sandboxPolicy": { "type": sandbox },
        "workspace": workspace.unwrap_or("windows"),
    }))
}

fn fast_mode_result(workspace: Option<&str>, enabled: bool) -> Value {
    json!({
        "enabled": enabled,
        "serviceTier": if enabled { Value::String("fast".to_string()) } else { Value::Null },
        "workspace": workspace.unwrap_or("windows"),
    })
}

fn plan_mode_result(mode: &str) -> Value {
    json!({
        "mode": mode,
    })
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
        "/review" => {
            let mode = parts.next()?.trim().to_ascii_lowercase();
            match mode.as_str() {
                "uncommitted" => Some(ParsedSlash {
                    method: "review/start".to_string(),
                    params: json!({
                        "target": { "type": "uncommittedChanges" }
                    }),
                }),
                "base-branch" => {
                    let branch = parts.collect::<Vec<_>>().join(" ").trim().to_string();
                    if branch.is_empty() {
                        return None;
                    }
                    Some(ParsedSlash {
                        method: "review/start".to_string(),
                        params: json!({
                            "target": { "type": "baseBranch", "branch": branch }
                        }),
                    })
                }
                "commit" => {
                    let sha = parts.next()?.trim().to_string();
                    if sha.is_empty() {
                        return None;
                    }
                    Some(ParsedSlash {
                        method: "review/start".to_string(),
                        params: json!({
                            "target": { "type": "commit", "sha": sha, "title": Value::Null }
                        }),
                    })
                }
                "custom" => {
                    let instructions = parts.collect::<Vec<_>>().join(" ").trim().to_string();
                    if instructions.is_empty() {
                        return None;
                    }
                    Some(ParsedSlash {
                        method: "review/start".to_string(),
                        params: json!({
                            "target": { "type": "custom", "instructions": instructions }
                        }),
                    })
                }
                _ => None,
            }
        }
        "/fast" => {
            let mode = parts.next()?.trim().to_ascii_lowercase();
            let enabled = match mode.as_str() {
                "on" => true,
                "off" => false,
                _ => return None,
            };
            if parts.next().is_some() {
                return None;
            }
            Some(ParsedSlash {
                method: "thread/fastMode/set".to_string(),
                params: json!({ "enabled": enabled }),
            })
        }
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
            if mode == "on" {
                return Some(ParsedSlash {
                    method: "web/planMode/set".to_string(),
                    params: json!({ "mode": "plan" }),
                });
            }
            if mode == "off" {
                return Some(ParsedSlash {
                    method: "web/planMode/set".to_string(),
                    params: json!({ "mode": "default" }),
                });
            }
            None
        }
        "/permission" => {
            let mode = parts.collect::<Vec<_>>().join(" ");
            let preset = mode.trim().to_ascii_lowercase();
            if !matches!(preset.as_str(), "read-only" | "auto" | "full-access") {
                return None;
            }
            Some(ParsedSlash {
                method: "thread/permission/set".to_string(),
                params: json!({ "preset": preset }),
            })
        }
        _ => None,
    }
}

pub(super) async fn codex_slash_commands(
    State(st): State<GatewayState>,
    headers: HeaderMap,
    Query(query): Query<SlashCommandsQuery>,
) -> Response {
    if let Some(resp) = require_codex_auth(&st, &headers) {
        return resp;
    }
    let rollout_path = query
        .rollout_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    Json(json!({
        "commands": supported_slash_commands(query.workspace.as_deref(), rollout_path)
    }))
    .into_response()
}

pub(super) async fn codex_slash_review_branches(
    State(st): State<GatewayState>,
    headers: HeaderMap,
    Query(query): Query<SlashReviewQuery>,
) -> Response {
    if let Some(resp) = require_codex_auth(&st, &headers) {
        return resp;
    }
    let cwd = match query
        .cwd
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(value) => value,
        None => return api_error(StatusCode::BAD_REQUEST, "cwd is required"),
    };
    match review_branch_options(query.workspace.as_deref(), cwd).await {
        Ok(items) => Json(json!({ "items": items })).into_response(),
        Err(err) => api_error_detail(StatusCode::BAD_REQUEST, "failed to list git branches", err),
    }
}

pub(super) async fn codex_slash_review_commits(
    State(st): State<GatewayState>,
    headers: HeaderMap,
    Query(query): Query<SlashReviewQuery>,
) -> Response {
    if let Some(resp) = require_codex_auth(&st, &headers) {
        return resp;
    }
    let cwd = match query
        .cwd
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(value) => value,
        None => return api_error(StatusCode::BAD_REQUEST, "cwd is required"),
    };
    match review_commit_options(query.workspace.as_deref(), cwd).await {
        Ok(items) => Json(json!({ "items": items })).into_response(),
        Err(err) => api_error_detail(StatusCode::BAD_REQUEST, "failed to list git commits", err),
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
    if parsed.method == "thread/fastMode/set" {
        let enabled = parsed
            .params
            .get("enabled")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        return Json(json!({
            "ok": true,
            "method": parsed.method,
            "result": fast_mode_result(req.workspace.as_deref(), enabled),
        }))
        .into_response();
    }
    if parsed.method == "web/planMode/set" {
        let mode = parsed
            .params
            .get("mode")
            .and_then(Value::as_str)
            .unwrap_or("default");
        return Json(json!({
            "ok": true,
            "method": parsed.method,
            "result": plan_mode_result(mode),
        }))
        .into_response();
    }
    if parsed.method == "thread/permission/set" {
        match permission_preset_runtime_result(req.workspace.as_deref(), command) {
            Ok(result) => {
                return Json(json!({
                    "ok": true,
                    "method": parsed.method,
                    "result": result,
                }))
                .into_response()
            }
            Err(err) => {
                return api_error_detail(
                    StatusCode::BAD_GATEWAY,
                    "failed to update permission preset",
                    err,
                )
            }
        }
    }
    let mut params = parsed.params;
    if parsed.method == "thread/start" {
        if let Some(service_tier) = service_tier_override_json(&req.service_tier) {
            if let Some(obj) = params.as_object_mut() {
                obj.insert("serviceTier".to_string(), service_tier);
            } else {
                params = json!({ "serviceTier": service_tier });
            }
        }
        if let Some(approval_policy) = runtime_approval_policy_json(req.approval_policy.as_deref())
        {
            if let Some(obj) = params.as_object_mut() {
                obj.insert("approvalPolicy".to_string(), approval_policy);
            } else {
                params = json!({ "approvalPolicy": approval_policy });
            }
        }
        if let Some(sandbox) = runtime_thread_sandbox_json(req.sandbox.as_deref()) {
            if let Some(obj) = params.as_object_mut() {
                obj.insert("sandbox".to_string(), sandbox);
            } else {
                params = json!({ "sandbox": sandbox });
            }
        }
    }
    if let Some(thread_id) = req.thread_id {
        if let Some(obj) = params.as_object_mut() {
            obj.insert("threadId".to_string(), Value::String(thread_id));
        }
    }
    if parsed.method == "thread/start" {
        let workspace_target = params
            .get("workspace")
            .and_then(Value::as_str)
            .and_then(parse_workspace_target);
        let gateway_token = st.secrets.get_gateway_token().unwrap_or_default();
        let manager = CodexSessionManager::new(workspace_target).with_terminal_bridge(
            st.cfg.read().listen.port,
            (!gateway_token.trim().is_empty()).then_some(gateway_token),
        );
        return match manager.thread_start(params).await {
            Ok(outcome) => Json(json!({
                "ok": true,
                "method": parsed.method,
                "result": attach_rollout_path_to_thread_start_result(outcome.result, outcome.rollout_path.as_deref()),
            }))
            .into_response(),
            Err(error) => api_error_detail(
                StatusCode::BAD_GATEWAY,
                "codex app-server request failed",
                error,
            ),
        };
    }
    match super::codex_rpc_call(&parsed.method, params).await {
        Ok(v) => Json(json!({ "ok": true, "method": parsed.method, "result": v })).into_response(),
        Err(resp) => resp,
    }
}

fn attach_rollout_path_to_thread_start_result(
    mut value: Value,
    rollout_path: Option<&str>,
) -> Value {
    let Some(path) = rollout_path.map(str::trim).filter(|path| !path.is_empty()) else {
        return value;
    };
    if let Some(obj) = value.as_object_mut() {
        obj.entry("path".to_string())
            .or_insert_with(|| Value::String(path.to_string()));
        match obj.get_mut("thread") {
            Some(Value::Object(thread)) => {
                thread
                    .entry("path".to_string())
                    .or_insert_with(|| Value::String(path.to_string()));
            }
            _ => {
                obj.insert("thread".to_string(), json!({ "path": path }));
            }
        }
    }
    value
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
#[allow(clippy::await_holding_lock)]
mod tests {
    use super::{
        build_turn_start_params, build_turn_start_response, parse_slash_command,
        prompt_with_plan_protocol, service_tier_override_json, supported_slash_commands,
        turn_thread_id, ServiceTierOverride, TurnStartRequest,
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
    fn turn_start_params_preserve_service_tier_override() {
        let raw = r#"{"threadId":"t1","prompt":"hi","serviceTier":"fast"}"#;
        let req: TurnStartRequest = serde_json::from_str(raw).expect("deserialize");
        let params = build_turn_start_params("t1", &req);
        assert_eq!(params["serviceTier"], "fast");
    }

    #[test]
    fn turn_start_params_preserve_explicit_null_service_tier_override() {
        let raw = r#"{"threadId":"t1","prompt":"hi","serviceTier":null}"#;
        let req: TurnStartRequest = serde_json::from_str(raw).expect("deserialize");
        let params = build_turn_start_params("t1", &req);
        assert!(params.get("serviceTier").is_some());
        assert!(params["serviceTier"].is_null());
    }

    #[test]
    fn turn_start_params_include_runtime_permission_overrides() {
        let raw = r#"{"threadId":"t1","prompt":"hi","approvalPolicy":"never","sandboxPolicy":{"type":"dangerFullAccess"}}"#;
        let req: TurnStartRequest = serde_json::from_str(raw).expect("deserialize");
        let params = build_turn_start_params("t1", &req);
        assert_eq!(params["approvalPolicy"], "never");
        assert_eq!(params["sandboxPolicy"]["type"], "dangerFullAccess");
    }

    #[test]
    fn turn_start_params_preserve_collaboration_mode_field() {
        let raw = r#"{"threadId":"t1","prompt":"hi","collaborationMode":"plan"}"#;
        let req: TurnStartRequest = serde_json::from_str(raw).expect("deserialize");
        let params = build_turn_start_params("t1", &req);
        assert_eq!(params["collaborationMode"], "plan");
        assert!(params["input"][0]["text"]
            .as_str()
            .is_some_and(|value| value.contains("<proposed_plan>...</proposed_plan>")));
    }

    #[test]
    fn prompt_with_plan_protocol_only_wraps_plan_mode_prompts() {
        let plain = prompt_with_plan_protocol("hi", None);
        assert_eq!(plain, "hi");

        let plan = prompt_with_plan_protocol("Draft the migration plan.", Some("plan"));
        assert!(plan.starts_with("Draft the migration plan."));
        assert!(plan.contains("<proposed_plan>...</proposed_plan>"));

        let already_wrapped =
            prompt_with_plan_protocol("Return <proposed_plan>body</proposed_plan>", Some("plan"));
        assert_eq!(
            already_wrapped,
            "Return <proposed_plan>body</proposed_plan>"
        );
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
            collaboration_mode: None,
            service_tier: ServiceTierOverride::Missing,
            approval_policy: None,
            sandbox_policy: None,
        };
        assert_eq!(turn_thread_id(&req), None);
    }

    #[test]
    fn service_tier_override_json_preserves_absent_string_and_null() {
        assert_eq!(
            service_tier_override_json(&ServiceTierOverride::Missing),
            None
        );
        assert_eq!(
            service_tier_override_json(&ServiceTierOverride::String("FAST".to_string())),
            Some(Value::String("fast".to_string()))
        );
        assert_eq!(
            service_tier_override_json(&ServiceTierOverride::Null(())),
            Some(Value::Null)
        );
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
            Some("C:\\temp\\rollout.jsonl"),
        );
        assert_eq!(response["threadId"], "thread-1");
        assert_eq!(response["turnId"], "turn-1");
        assert_eq!(response["rolloutPath"], "C:\\temp\\rollout.jsonl");
    }

    #[tokio::test]
    async fn terminal_interrupt_notifications_are_enqueued_for_workspace_home() {
        let _guard = crate::codex_app_server::lock_test_globals();
        crate::codex_app_server::_clear_notifications_for_test().await;
        let home = "test-terminal-interrupt-home";

        crate::codex_app_server::push_terminal_interrupt_notifications(
            Some(home),
            "thread-terminal",
        )
        .await;

        let (items, first, last, gap) =
            crate::codex_app_server::replay_notifications_since_in_home(Some(home), 0, 8).await;
        assert!(!gap);
        assert_eq!(first, Some(1));
        assert_eq!(last, Some(2));
        assert_eq!(items.len(), 2);
        assert_eq!(items[0]["method"], "turn/cancelled");
        assert_eq!(items[0]["params"]["threadId"], "thread-terminal");
        assert_eq!(items[0]["params"]["status"], "interrupted");
        assert_eq!(items[0]["params"]["source"], "terminal_session_interrupt");
        assert_eq!(items[1]["method"], "thread/status/changed");
        assert_eq!(items[1]["params"]["threadId"], "thread-terminal");
        assert_eq!(items[1]["params"]["status"], "interrupted");
    }

    #[test]
    fn parse_plan_variants() {
        let on = parse_slash_command("/plan on").expect("on");
        assert_eq!(on.method, "web/planMode/set");
        assert_eq!(on.params["mode"], "plan");

        let off = parse_slash_command("/plan off").expect("off");
        assert_eq!(off.method, "web/planMode/set");
        assert_eq!(off.params["mode"], "default");

        assert!(parse_slash_command("/plan").is_none());
        assert!(parse_slash_command("/plan add checklist").is_none());
    }

    #[test]
    fn parse_fast_and_permission_variants() {
        let fast = parse_slash_command("/fast on").expect("fast");
        assert_eq!(fast.method, "thread/fastMode/set");
        assert_eq!(fast.params["enabled"], true);

        let permission = parse_slash_command("/permission auto").expect("permission");
        assert_eq!(permission.method, "thread/permission/set");
        assert_eq!(permission.params["preset"], "auto");
        assert!(parse_slash_command("/permission read-only").is_some());

        let review = parse_slash_command("/review uncommitted").expect("review target");
        assert_eq!(review.method, "review/start");
        assert_eq!(review.params["target"]["type"], "uncommittedChanges");
    }

    #[test]
    fn parse_review_variants() {
        let base_branch = parse_slash_command("/review base-branch main").expect("base branch");
        assert_eq!(base_branch.method, "review/start");
        assert_eq!(base_branch.params["target"]["type"], "baseBranch");
        assert_eq!(base_branch.params["target"]["branch"], "main");

        let commit = parse_slash_command("/review commit abc123").expect("commit");
        assert_eq!(commit.params["target"]["type"], "commit");
        assert_eq!(commit.params["target"]["sha"], "abc123");

        let custom = parse_slash_command("/review custom check api behavior").expect("custom");
        assert_eq!(custom.params["target"]["type"], "custom");
        assert_eq!(
            custom.params["target"]["instructions"],
            "check api behavior"
        );

        assert!(parse_slash_command("/review").is_none());
        assert!(parse_slash_command("/review base-branch").is_none());
        assert!(parse_slash_command("/review custom").is_none());
    }

    #[test]
    fn parse_rename_and_model_require_args() {
        assert!(parse_slash_command("/rename").is_none());
        assert!(parse_slash_command("/model").is_none());
        assert!(parse_slash_command("/rename hello").is_some());
        assert!(parse_slash_command("/model gpt-5").is_some());
    }

    #[test]
    fn slash_command_catalog_exposes_supported_entries() {
        let commands = supported_slash_commands(None, None);
        assert!(commands.iter().any(|entry| entry.command == "/help"));
        assert!(commands.iter().any(|entry| entry.command == "/compact"));
        assert!(commands.iter().any(|entry| entry.command == "/review"));
        assert!(commands.iter().any(|entry| entry.command == "/diff"));
        assert!(commands.iter().any(|entry| entry.command == "/plan"));
        assert!(commands.iter().any(|entry| entry.command == "/fast"));
        assert!(commands.iter().any(|entry| entry.command == "/permission"));
        assert!(!commands.iter().any(|entry| entry.command == "/new"));
        assert!(!commands.iter().any(|entry| entry.command == "/status"));
        assert!(!commands.iter().any(|entry| entry.command == "/model"));
        assert!(!commands.iter().any(|entry| entry.command == "/fork"));
        assert!(!commands.iter().any(|entry| entry.command == "/rename"));
        let plan = commands
            .iter()
            .find(|entry| entry.command == "/plan")
            .expect("plan command");
        assert!(plan
            .children
            .iter()
            .any(|child| child.command == "/plan on"));
        assert!(plan
            .children
            .iter()
            .any(|child| child.command == "/plan off"));
    }

    #[test]
    fn slash_command_catalog_filters_workspace_specific_permission_entries() {
        let windows = supported_slash_commands(Some("windows"), None);
        let wsl2 = supported_slash_commands(Some("wsl2"), None);
        let windows_permission = windows
            .iter()
            .find(|entry| entry.command == "/permission")
            .expect("windows permission");
        let wsl_permission = wsl2
            .iter()
            .find(|entry| entry.command == "/permission")
            .expect("wsl permission");

        assert!(windows_permission
            .children
            .iter()
            .any(|child| child.command == "/permission read-only"));
        assert!(!wsl_permission
            .children
            .iter()
            .any(|child| child.command == "/permission read-only"));
    }

    #[test]
    fn slash_command_catalog_leaves_fast_mode_to_client_state() {
        let commands = supported_slash_commands(Some("windows"), None);
        let fast = commands
            .iter()
            .find(|entry| entry.command == "/fast")
            .expect("fast command");
        assert!(fast.children.iter().all(|child| !child.active));
    }

    #[test]
    fn slash_command_catalog_marks_plan_mode_from_rollout() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let rollout_path = tmp.path().join("rollout.jsonl");
        std::fs::write(
            &rollout_path,
            concat!(
                "{\"type\":\"event_msg\",\"payload\":{\"type\":\"turn_started\",\"turn_id\":\"turn-1\",\"collaboration_mode_kind\":\"default\"}}\n",
                "{\"type\":\"event_msg\",\"payload\":{\"type\":\"turn_started\",\"turn_id\":\"turn-2\",\"collaboration_mode_kind\":\"plan\"}}\n"
            ),
        )
        .expect("write rollout");
        let commands =
            supported_slash_commands(None, Some(rollout_path.to_string_lossy().as_ref()));
        let plan = commands
            .iter()
            .find(|entry| entry.command == "/plan")
            .expect("plan command");
        assert!(plan
            .children
            .iter()
            .any(|child| child.command == "/plan on" && child.active));
        assert!(!plan
            .children
            .iter()
            .any(|child| child.command == "/plan off" && child.active));
    }
}
