use super::*;
use axum::extract::{Path as AxumPath, Query};
use serde::Deserialize;
use std::collections::{HashMap, HashSet};

use crate::orchestrator::gateway::web_codex_git::{
    current_branch_for_workspace, detect_git_worktree_for_workspace, switch_branch_for_workspace,
    uncommitted_file_count_for_workspace, visible_branch_options_for_workspace_with_current_branch,
};
use crate::orchestrator::gateway::web_codex_session_manager::{
    merge_runtime_thread_overlay, runtime_thread_path, runtime_thread_payload,
    thread_id_from_response, CodexSessionManager,
};
use crate::orchestrator::gateway::web_codex_thread_options::build_thread_resume_params;

const MAX_CONCURRENT_WORKTREE_PROBES: usize = 4;
type WorktreeProbeOutcome = (Option<String>, String, Result<bool, String>);

#[derive(Deserialize)]
pub(super) struct ThreadsQuery {
    #[serde(default)]
    workspace: Option<String>,
    #[serde(default)]
    force: Option<bool>,
}

#[derive(Deserialize)]
pub(super) struct ThreadCreateRequest {
    #[serde(default)]
    workspace: Option<String>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default, rename = "serviceTier")]
    service_tier: ServiceTierOverride,
    #[serde(default, rename = "approvalPolicy")]
    approval_policy: Option<String>,
    #[serde(default)]
    sandbox: Option<String>,
}

#[derive(Deserialize)]
pub(super) struct ThreadResumeQuery {
    #[serde(default)]
    workspace: Option<String>,
    #[serde(default, rename = "rolloutPath")]
    rollout_path: Option<String>,
    #[serde(default)]
    before: Option<String>,
    #[serde(default)]
    limit: Option<usize>,
    #[serde(default, rename = "serviceTier")]
    service_tier: Option<String>,
    #[serde(default, rename = "approvalPolicy")]
    approval_policy: Option<String>,
    #[serde(default)]
    sandbox: Option<String>,
}

#[derive(Deserialize)]
pub(super) struct ThreadGitQuery {
    #[serde(default)]
    workspace: Option<String>,
}

#[derive(Deserialize)]
pub(super) struct GitMetaQuery {
    #[serde(default)]
    workspace: Option<String>,
    #[serde(default)]
    cwd: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ThreadBranchSwitchRequest {
    #[serde(default)]
    workspace: Option<String>,
    branch: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct GitBranchSwitchRequest {
    #[serde(default)]
    workspace: Option<String>,
    cwd: String,
    branch: String,
}

fn normalize_requested_workspace_label(value: Option<&str>) -> String {
    let requested_workspace = value.unwrap_or_default();
    if requested_workspace.trim().is_empty() {
        "all".to_string()
    } else {
        requested_workspace.trim().to_ascii_lowercase()
    }
}

fn workspace_label_for_target(target: WorkspaceTarget) -> &'static str {
    match target {
        WorkspaceTarget::Windows => "windows",
        WorkspaceTarget::Wsl2 => "wsl2",
    }
}

fn workspace_option_for_item(item: &Value) -> Option<String> {
    item.get("workspace")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn workspace_label_is_wsl2(value: &str) -> bool {
    value.trim().eq_ignore_ascii_case("wsl2")
}

fn worktree_probe_request_for_item(
    item: &Value,
    workspace_hint: Option<&str>,
) -> Option<(Option<String>, String)> {
    let cwd = item
        .get("cwd")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or_default()
        .to_string();
    if cwd.is_empty() {
        return None;
    }
    let workspace = workspace_hint
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
        .or_else(|| workspace_option_for_item(item));
    if workspace
        .as_deref()
        .map(workspace_label_is_wsl2)
        .unwrap_or(false)
    {
        return None;
    }
    Some((workspace, cwd))
}

fn collect_worktree_probe_requests(
    items: &[Value],
    workspace_hint: Option<&str>,
) -> Vec<(Option<String>, String)> {
    let mut seen = HashSet::new();
    let mut requests = Vec::new();
    for item in items {
        let Some((workspace, cwd)) = worktree_probe_request_for_item(item, workspace_hint) else {
            continue;
        };
        let key = (
            workspace
                .as_deref()
                .map(str::trim)
                .unwrap_or_default()
                .to_ascii_lowercase(),
            cwd.clone(),
        );
        if seen.insert(key) {
            requests.push((workspace, cwd));
        }
    }
    requests
}

fn worktree_probe_result_key(workspace: Option<&str>, cwd: &str) -> (String, String) {
    (
        workspace
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or_default()
            .to_ascii_lowercase(),
        cwd.trim().to_string(),
    )
}

fn drain_completed_worktree_probe(
    results: &mut HashMap<(String, String), bool>,
    joined: Result<WorktreeProbeOutcome, tokio::task::JoinError>,
) {
    let Ok((workspace, cwd, result)) = joined else {
        return;
    };
    if let Ok(is_worktree) = result {
        results.insert(
            worktree_probe_result_key(workspace.as_deref(), &cwd),
            is_worktree,
        );
    }
}

async fn apply_worktree_flag_to_item(
    item: &mut Value,
    workspace_hint: Option<&str>,
) -> Result<(), String> {
    let Some((workspace, cwd)) = worktree_probe_request_for_item(item, workspace_hint) else {
        return Ok(());
    };
    let is_worktree = detect_git_worktree_for_workspace(workspace.as_deref(), &cwd).await?;
    if let Some(obj) = item.as_object_mut() {
        obj.insert("isWorktree".to_string(), Value::Bool(is_worktree));
    }
    Ok(())
}

async fn apply_worktree_flags_to_items(
    items: &mut Vec<Value>,
    workspace_hint: Option<&str>,
) -> Result<(), String> {
    let requests = collect_worktree_probe_requests(items, workspace_hint);
    let mut probes = tokio::task::JoinSet::new();
    let mut results = HashMap::new();
    for (workspace, cwd) in requests {
        probes.spawn(async move {
            let result = detect_git_worktree_for_workspace(workspace.as_deref(), &cwd).await;
            (workspace, cwd, result)
        });
        if probes.len() >= MAX_CONCURRENT_WORKTREE_PROBES {
            if let Some(joined) = probes.join_next().await {
                drain_completed_worktree_probe(&mut results, joined);
            }
        }
    }

    while let Some(joined) = probes.join_next().await {
        drain_completed_worktree_probe(&mut results, joined);
    }

    for item in items {
        let Some((workspace, cwd)) = worktree_probe_request_for_item(item, workspace_hint) else {
            continue;
        };
        let key = worktree_probe_result_key(workspace.as_deref(), &cwd);
        if let Some(is_worktree) = results.get(&key).copied() {
            if let Some(obj) = item.as_object_mut() {
                obj.insert("isWorktree".to_string(), Value::Bool(is_worktree));
            }
        }
    }
    Ok(())
}

async fn resolve_thread_cwd(
    workspace_target: WorkspaceTarget,
    thread_id: &str,
) -> Result<String, String> {
    let manager = CodexSessionManager::new(Some(workspace_target));
    if let Ok(runtime) = manager.read_thread(thread_id, false).await {
        if let Some(cwd) = runtime_thread_payload(&runtime)
            .and_then(Value::as_object)
            .and_then(|thread| thread.get("cwd"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            return Ok(cwd.to_string());
        }
    }
    let snapshot = crate::orchestrator::gateway::web_codex_threads::list_threads_snapshot(
        Some(workspace_target),
        false,
    )
    .await;
    snapshot
        .items
        .into_iter()
        .find(|item| {
            item.get("id")
                .and_then(Value::as_str)
                .map(str::trim)
                .is_some_and(|value| value == thread_id)
        })
        .and_then(|item| {
            item.get("cwd")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        })
        .ok_or_else(|| "thread cwd not found".to_string())
}

async fn thread_git_meta_payload(
    workspace_target: WorkspaceTarget,
    thread_id: &str,
) -> Result<Value, String> {
    let cwd = resolve_thread_cwd(workspace_target, thread_id).await?;
    git_meta_payload_for_cwd(workspace_target, Some(thread_id), &cwd).await
}

async fn git_meta_payload_for_cwd(
    workspace_target: WorkspaceTarget,
    thread_id: Option<&str>,
    cwd: &str,
) -> Result<Value, String> {
    let cwd = cwd.trim();
    if cwd.is_empty() {
        return Err("cwd is required".to_string());
    }
    let workspace = workspace_label_for_target(workspace_target);
    let (current_branch, is_worktree, uncommitted_file_count) = tokio::try_join!(
        current_branch_for_workspace(Some(workspace), cwd),
        detect_git_worktree_for_workspace(Some(workspace), cwd),
        uncommitted_file_count_for_workspace(Some(workspace), cwd)
    )?;
    let branches = visible_branch_options_for_workspace_with_current_branch(
        Some(workspace),
        cwd,
        &current_branch,
    )
    .await?;
    let mut payload = json!({
        "workspace": workspace,
        "cwd": cwd,
        "currentBranch": current_branch,
        "branches": branches,
        "isWorktree": is_worktree,
        "uncommittedFileCount": uncommitted_file_count,
    });
    if let Some(thread_id) = thread_id {
        if let Some(obj) = payload.as_object_mut() {
            obj.insert("threadId".to_string(), Value::String(thread_id.to_string()));
        }
    }
    Ok(payload)
}

fn normalize_rollout_query_path(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|raw| !raw.is_empty())
        .map(str::to_string)
}

fn preferred_rollout_path_for_history(
    query_rollout_path: Option<String>,
    known_rollout_path: Option<String>,
) -> Option<String> {
    let query = query_rollout_path
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let known = known_rollout_path
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    match (query, known) {
        (Some(query), Some(known)) => {
            if std::path::Path::new(&known).exists() {
                Some(known)
            } else if std::path::Path::new(&query).exists() {
                Some(query)
            } else {
                Some(known)
            }
        }
        (Some(query), None) => Some(query),
        (None, Some(known)) => Some(known),
        (None, None) => None,
    }
}

fn normalize_service_tier_query(value: Option<&str>) -> Option<Option<String>> {
    match value.map(str::trim) {
        Some("") | None => None,
        Some("none") | Some("null") | Some("off") => Some(None),
        Some(raw) => Some(Some(raw.to_ascii_lowercase())),
    }
}

fn history_error_allows_runtime_fallback(detail: &str) -> bool {
    let lower = detail.to_ascii_lowercase();
    lower.contains("missing rollout path")
        || lower.contains("os error 2")
        || lower.contains("cannot find the file")
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(untagged)]
enum ServiceTierOverride {
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

fn build_thread_start_params(req: &ThreadCreateRequest) -> Value {
    let mut params = serde_json::Map::from_iter([
        ("workspace".to_string(), json!(req.workspace)),
        ("title".to_string(), json!(req.title)),
        ("cwd".to_string(), json!(req.cwd)),
    ]);
    if let Some(service_tier) = service_tier_override_json(&req.service_tier) {
        params.insert("serviceTier".to_string(), service_tier);
    }
    if let Some(approval_policy) = req
        .approval_policy
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        params.insert(
            "approvalPolicy".to_string(),
            Value::String(approval_policy.to_string()),
        );
    }
    if let Some(sandbox) = req
        .sandbox
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        params.insert("sandbox".to_string(), Value::String(sandbox.to_string()));
    }
    Value::Object(params)
}

pub(super) fn should_try_known_wsl_rollout_path(
    workspace_hint: Option<WorkspaceTarget>,
    rollout_path: Option<&str>,
) -> bool {
    if !matches!(workspace_hint, Some(WorkspaceTarget::Wsl2)) {
        return false;
    }
    rollout_path
        .map(str::trim)
        .map(|value| !value.is_empty())
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

fn attach_rollout_path_to_create_response(mut value: Value, rollout_path: Option<&str>) -> Value {
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

fn synthesize_thread_list_item(
    workspace_target: WorkspaceTarget,
    create_response: &Value,
    runtime_response: Option<&Value>,
) -> Option<Value> {
    let thread_id = thread_id_from_response(create_response)?;
    let runtime_thread = runtime_response.and_then(runtime_thread_payload);
    let path = runtime_thread_path(runtime_response.unwrap_or(create_response))
        .or_else(|| {
            create_response
                .get("path")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|path| !path.is_empty())
                .map(str::to_string)
        })
        .or_else(|| {
            create_response
                .get("thread")
                .and_then(Value::as_object)
                .and_then(|thread| thread.get("path"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|path| !path.is_empty())
                .map(str::to_string)
        });
    let cwd = runtime_thread
        .and_then(Value::as_object)
        .and_then(|thread| thread.get("cwd").and_then(Value::as_str))
        .or_else(|| create_response.get("cwd").and_then(Value::as_str))
        .map(str::trim)
        .unwrap_or_default()
        .to_string();
    let updated_at = runtime_thread
        .and_then(Value::as_object)
        .and_then(|thread| thread.get("updatedAt"))
        .cloned()
        .unwrap_or_else(|| {
            Value::from(
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|value| value.as_secs() as i64)
                    .unwrap_or(0),
            )
        });
    let created_at = runtime_thread
        .and_then(Value::as_object)
        .and_then(|thread| thread.get("createdAt"))
        .cloned()
        .unwrap_or_else(|| updated_at.clone());
    let preview = create_response
        .get("title")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_default();
    let mut item = json!({
        "id": thread_id,
        "workspace": match workspace_target {
            WorkspaceTarget::Windows => "windows",
            WorkspaceTarget::Wsl2 => "wsl2",
        },
        "source": "app-server-thread-start",
        "preview": preview,
        "cwd": cwd,
        "status": { "type": "notLoaded" },
        "updatedAt": updated_at,
        "createdAt": created_at,
    });
    if let Some(path) = path {
        if let Some(obj) = item.as_object_mut() {
            obj.insert("path".to_string(), Value::String(path));
        }
    }
    if let Some(runtime_value) = runtime_response {
        merge_runtime_thread_overlay(&mut item, runtime_value);
    }
    Some(item)
}

pub(super) async fn codex_threads_list(
    State(st): State<GatewayState>,
    headers: HeaderMap,
    Query(query): Query<ThreadsQuery>,
) -> Response {
    if let Some(resp) = require_codex_auth(&st, &headers) {
        return resp;
    }
    let started = std::time::Instant::now();
    let requested_workspace = query.workspace.clone().unwrap_or_default();
    let workspace_meta = normalize_requested_workspace_label(Some(&requested_workspace));
    let force = query.force.unwrap_or(false);
    let target = parse_workspace_target(&requested_workspace);
    let snapshot =
        crate::orchestrator::gateway::web_codex_threads::list_threads_snapshot(target, force).await;
    let mut items = snapshot.items;
    let _ = apply_worktree_flags_to_items(&mut items, query.workspace.as_deref()).await;
    if matches!(target, Some(WorkspaceTarget::Wsl2) | None) {
        crate::orchestrator::gateway::web_codex_history::spawn_wsl_history_prewarm(&items);
    }
    let total_ms = i64::try_from(started.elapsed().as_millis()).unwrap_or(i64::MAX);
    build_threads_response_with_meta(
        items,
        json!({
            "workspace": workspace_meta,
            "cacheHit": snapshot.cache_hit,
            "refreshing": snapshot.refreshing,
            "source": "session-index",
            "rebuildMs": snapshot.rebuild_ms,
            "totalMs": total_ms
        }),
    )
}

pub(super) async fn codex_threads_create(
    State(st): State<GatewayState>,
    headers: HeaderMap,
    LoggedJson(req): LoggedJson<ThreadCreateRequest>,
) -> Response {
    if let Some(resp) = require_codex_auth(&st, &headers) {
        return resp;
    }
    let params = build_thread_start_params(&req);
    let workspace_target = req.workspace.as_deref().and_then(parse_workspace_target);
    let gateway_token = st.secrets.get_gateway_token().unwrap_or_default();
    let manager = CodexSessionManager::new(workspace_target).with_terminal_bridge(
        st.cfg.read().listen.port,
        (!gateway_token.trim().is_empty()).then_some(gateway_token),
    );
    match manager.thread_start(params).await {
        Ok(outcome) => {
            crate::orchestrator::gateway::web_codex_threads::invalidate_thread_list_cache_all();
            let runtime_response = outcome.runtime_response;
            if let Some(target) = workspace_target {
                if let Some(mut item) =
                    synthesize_thread_list_item(target, &outcome.result, runtime_response.as_ref())
                {
                    let _ = apply_worktree_flag_to_item(
                        &mut item,
                        Some(workspace_label_for_target(target)),
                    )
                    .await;
                    crate::orchestrator::gateway::web_codex_threads::upsert_thread_item_hint(
                        target, item,
                    );
                }
            }
            Json(attach_rollout_path_to_create_response(
                outcome.result,
                outcome.rollout_path.as_deref(),
            ))
            .into_response()
        }
        Err(error) => api_error_detail(
            StatusCode::BAD_GATEWAY,
            "codex app-server request failed",
            error,
        ),
    }
}

pub(super) async fn codex_thread_git_meta(
    State(st): State<GatewayState>,
    headers: HeaderMap,
    Query(query): Query<ThreadGitQuery>,
    AxumPath(id): AxumPath<String>,
) -> Response {
    if let Some(resp) = require_codex_auth(&st, &headers) {
        return resp;
    }
    let Some(workspace_target) = query.workspace.as_deref().and_then(parse_workspace_target) else {
        return api_error(StatusCode::BAD_REQUEST, "workspace is required");
    };
    match thread_git_meta_payload(workspace_target, &id).await {
        Ok(value) => Json(value).into_response(),
        Err(error) => api_error_detail(
            StatusCode::BAD_REQUEST,
            "failed to read thread git metadata",
            error,
        ),
    }
}

pub(super) async fn codex_git_meta(
    State(st): State<GatewayState>,
    headers: HeaderMap,
    Query(query): Query<GitMetaQuery>,
) -> Response {
    if let Some(resp) = require_codex_auth(&st, &headers) {
        return resp;
    }
    let Some(workspace_target) = query.workspace.as_deref().and_then(parse_workspace_target) else {
        return api_error(StatusCode::BAD_REQUEST, "workspace is required");
    };
    let Some(cwd) = query
        .cwd
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return api_error(StatusCode::BAD_REQUEST, "cwd is required");
    };
    match git_meta_payload_for_cwd(workspace_target, None, cwd).await {
        Ok(value) => Json(value).into_response(),
        Err(error) => api_error_detail(
            StatusCode::BAD_REQUEST,
            "failed to read git metadata",
            error,
        ),
    }
}

pub(super) async fn codex_thread_branch_switch(
    State(st): State<GatewayState>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    LoggedJson(req): LoggedJson<ThreadBranchSwitchRequest>,
) -> Response {
    if let Some(resp) = require_codex_auth(&st, &headers) {
        return resp;
    }
    let Some(workspace_target) = req.workspace.as_deref().and_then(parse_workspace_target) else {
        return api_error(StatusCode::BAD_REQUEST, "workspace is required");
    };
    let workspace = workspace_label_for_target(workspace_target);
    let cwd = match resolve_thread_cwd(workspace_target, &id).await {
        Ok(cwd) => cwd,
        Err(error) => {
            return api_error_detail(
                StatusCode::BAD_REQUEST,
                "failed to resolve thread cwd",
                error,
            )
        }
    };
    match switch_branch_for_workspace(Some(workspace), &cwd, &req.branch).await {
        Ok(_) => match thread_git_meta_payload(workspace_target, &id).await {
            Ok(value) => Json(value).into_response(),
            Err(error) => api_error_detail(
                StatusCode::BAD_REQUEST,
                "branch switched but failed to reload thread git metadata",
                error,
            ),
        },
        Err(error) => api_error_detail(StatusCode::BAD_REQUEST, "failed to switch branch", error),
    }
}

pub(super) async fn codex_git_branch_switch(
    State(st): State<GatewayState>,
    headers: HeaderMap,
    LoggedJson(req): LoggedJson<GitBranchSwitchRequest>,
) -> Response {
    if let Some(resp) = require_codex_auth(&st, &headers) {
        return resp;
    }
    let Some(workspace_target) = req.workspace.as_deref().and_then(parse_workspace_target) else {
        return api_error(StatusCode::BAD_REQUEST, "workspace is required");
    };
    let cwd = req.cwd.trim();
    if cwd.is_empty() {
        return api_error(StatusCode::BAD_REQUEST, "cwd is required");
    }
    let workspace = workspace_label_for_target(workspace_target);
    match switch_branch_for_workspace(Some(workspace), cwd, &req.branch).await {
        Ok(_) => match git_meta_payload_for_cwd(workspace_target, None, cwd).await {
            Ok(value) => Json(value).into_response(),
            Err(error) => api_error_detail(
                StatusCode::BAD_REQUEST,
                "branch switched but failed to reload git metadata",
                error,
            ),
        },
        Err(error) => api_error_detail(StatusCode::BAD_REQUEST, "failed to switch branch", error),
    }
}

pub(super) async fn codex_thread_history(
    State(st): State<GatewayState>,
    headers: HeaderMap,
    Query(query): Query<ThreadResumeQuery>,
    AxumPath(id): AxumPath<String>,
) -> Response {
    if let Some(resp) = require_codex_auth(&st, &headers) {
        return resp;
    }
    let workspace_hint = query.workspace.as_deref().and_then(parse_workspace_target);
    let query_rollout_path = normalize_rollout_query_path(query.rollout_path.as_deref());
    let known_rollout_path = match workspace_hint {
        Some(target) => {
            crate::orchestrator::gateway::web_codex_threads::known_rollout_path_for_thread(
                target, &id,
            )
            .await
        }
        None => None,
    };
    let rollout_path = preferred_rollout_path_for_history(query_rollout_path, known_rollout_path);
    let limit = query.limit.unwrap_or_else(
        crate::orchestrator::gateway::web_codex_history::default_history_page_limit,
    );
    let runtime_manager = CodexSessionManager::new(workspace_hint);
    let id_for_read = id.clone();
    let before = query.before.clone();
    let history_read = tokio::task::spawn_blocking(move || {
        crate::orchestrator::gateway::web_codex_history::load_thread_history_page(
            &id_for_read,
            workspace_hint,
            rollout_path.as_deref(),
            before.as_deref(),
            limit,
        )
    });
    match tokio::time::timeout(
        std::time::Duration::from_secs(HISTORY_READ_TIMEOUT_SECS),
        history_read,
    )
    .await
    {
        Ok(Ok(Ok(mut page))) => {
            let _ = crate::codex_app_server::sanitize_failed_turn_thread_payload_in_home(
                runtime_manager.home_override(),
                &id,
                &mut page.thread,
            )
            .await;
            if let Some(snapshot) = crate::orchestrator::gateway::web_codex_session_manager::workspace_thread_runtime_snapshot_for_home(
                runtime_manager.home_override(),
                &id,
            ) {
                if snapshot.status.as_deref() == Some("failed") {
                    if let Some(turn_id) = snapshot.last_turn_id.as_deref() {
                        let _ = crate::codex_app_server::sanitize_failed_turn_thread_payload(
                            &mut page.thread,
                            turn_id,
                        );
                    }
                }
            }
            if workspace_hint.is_some() {
                let _ = runtime_manager
                    .overlay_runtime_thread(&id, &mut page.thread)
                    .await;
            }
            Json(json!({ "thread": page.thread, "page": page.page })).into_response()
        }
        Ok(Ok(Err(detail))) => {
            match runtime_manager
                .read_thread_history_page_from_runtime(
                    &id,
                    query.before.as_deref(),
                    limit,
                    history_error_allows_runtime_fallback(&detail),
                )
                .await
            {
                Ok(mut page) => {
                    let _ = crate::codex_app_server::sanitize_failed_turn_thread_payload_in_home(
                        runtime_manager.home_override(),
                        &id,
                        &mut page.thread,
                    )
                    .await;
                    if let Some(snapshot) = crate::orchestrator::gateway::web_codex_session_manager::workspace_thread_runtime_snapshot_for_home(
                        runtime_manager.home_override(),
                        &id,
                    ) {
                        if snapshot.status.as_deref() == Some("failed") {
                            if let Some(turn_id) = snapshot.last_turn_id.as_deref() {
                                let _ = crate::codex_app_server::sanitize_failed_turn_thread_payload(
                                    &mut page.thread,
                                    turn_id,
                                );
                            }
                        }
                    }
                    Json(json!({ "thread": page.thread, "page": page.page })).into_response()
                }
                Err(runtime_error) => api_error_detail(
                    StatusCode::BAD_GATEWAY,
                    "failed to read thread",
                    format!("{detail}; runtime fallback failed: {runtime_error}"),
                ),
            }
        }
        Ok(Err(join_error)) => api_error_detail(
            StatusCode::BAD_GATEWAY,
            "failed to read thread",
            join_error.to_string(),
        ),
        Err(_) => api_error(StatusCode::GATEWAY_TIMEOUT, "thread history read timed out"),
    }
}

#[cfg(test)]
pub(super) async fn codex_test_block_history() -> Response {
    let history_read = tokio::task::spawn_blocking(move || {
        crate::orchestrator::gateway::web_codex_history::load_thread_history_page(
            "test-thread",
            None,
            Some("C:\\temp\\test.jsonl"),
            None,
            1,
        )
    });
    match tokio::time::timeout(
        std::time::Duration::from_secs(HISTORY_READ_TIMEOUT_SECS),
        history_read,
    )
    .await
    {
        Ok(Ok(Ok(page))) => {
            Json(json!({ "thread": page.thread, "page": page.page })).into_response()
        }
        Ok(Ok(Err(detail))) => {
            api_error_detail(StatusCode::BAD_GATEWAY, "failed to read thread", detail)
        }
        Ok(Err(join_error)) => api_error_detail(
            StatusCode::BAD_GATEWAY,
            "failed to read thread",
            join_error.to_string(),
        ),
        Err(_) => api_error(StatusCode::GATEWAY_TIMEOUT, "thread history read timed out"),
    }
}

pub(super) async fn codex_thread_resume(
    State(st): State<GatewayState>,
    headers: HeaderMap,
    Query(query): Query<ThreadResumeQuery>,
    AxumPath(id): AxumPath<String>,
) -> Response {
    if let Some(resp) = require_codex_auth(&st, &headers) {
        return resp;
    }
    let workspace_hint = query.workspace.as_deref().and_then(parse_workspace_target);
    let rollout_hint =
        if should_try_known_wsl_rollout_path(workspace_hint, query.rollout_path.as_deref()) {
            normalize_rollout_query_path(query.rollout_path.as_deref())
        } else {
            None
        };
    let known_rollout_path = if rollout_hint.is_some() {
        rollout_hint.clone()
    } else {
        match workspace_hint {
            Some(target) => {
                crate::orchestrator::gateway::web_codex_threads::known_rollout_path_for_thread(
                    target, &id,
                )
                .await
            }
            None => None,
        }
    };
    let service_tier = normalize_service_tier_query(query.service_tier.as_deref());
    let params = build_thread_resume_params(
        &id,
        service_tier,
        query.approval_policy.clone(),
        query.sandbox.clone(),
    );
    let manager = CodexSessionManager::new(workspace_hint);
    match manager
        .resume_thread(&id, params, known_rollout_path.as_deref())
        .await
    {
        Ok(value) => Json(value).into_response(),
        Err(error) => api_error_detail(StatusCode::BAD_GATEWAY, "failed to resume thread", error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::orchestrator::gateway::web_codex_session_manager::{
        merge_runtime_thread_overlay, runtime_thread_response_to_history_page,
    };

    #[test]
    fn normalize_requested_workspace_label_defaults_to_all() {
        assert_eq!(normalize_requested_workspace_label(None), "all");
        assert_eq!(normalize_requested_workspace_label(Some("   ")), "all");
        assert_eq!(
            normalize_requested_workspace_label(Some("  WSL2  ")),
            "wsl2"
        );
    }

    #[test]
    fn normalize_rollout_query_path_trims_and_filters_empty_values() {
        assert_eq!(
            normalize_rollout_query_path(Some("  C:\\temp\\a.jsonl  ")),
            Some("C:\\temp\\a.jsonl".to_string())
        );
        assert_eq!(normalize_rollout_query_path(Some("   ")), None);
        assert_eq!(normalize_rollout_query_path(None), None);
    }

    #[test]
    fn preferred_rollout_path_for_history_falls_back_to_known_existing_path() {
        let temp = tempfile::tempdir().expect("temp dir");
        let known = temp.path().join("rollout.jsonl");
        std::fs::write(&known, "").expect("write rollout");
        let preferred = preferred_rollout_path_for_history(
            Some(
                temp.path()
                    .join("missing.jsonl")
                    .to_string_lossy()
                    .to_string(),
            ),
            Some(known.to_string_lossy().to_string()),
        );
        assert_eq!(preferred.as_deref(), Some(known.to_string_lossy().as_ref()));
    }

    #[test]
    fn preferred_rollout_path_for_history_prefers_known_existing_path_over_query() {
        let temp = tempfile::tempdir().expect("temp dir");
        let known = temp.path().join("known.jsonl");
        let query = temp.path().join("query.jsonl");
        std::fs::write(&known, "").expect("write known rollout");
        std::fs::write(&query, "").expect("write query rollout");

        let preferred = preferred_rollout_path_for_history(
            Some(query.to_string_lossy().to_string()),
            Some(known.to_string_lossy().to_string()),
        );

        assert_eq!(preferred.as_deref(), Some(known.to_string_lossy().as_ref()));
    }

    #[test]
    fn normalize_service_tier_query_supports_fast_and_explicit_off() {
        assert_eq!(
            normalize_service_tier_query(Some(" FAST ")),
            Some(Some("fast".to_string()))
        );
        assert_eq!(normalize_service_tier_query(Some("off")), Some(None));
        assert_eq!(normalize_service_tier_query(Some("null")), Some(None));
        assert_eq!(normalize_service_tier_query(None), None);
    }

    #[test]
    fn history_error_allows_runtime_fallback_for_missing_rollout_files() {
        assert!(history_error_allows_runtime_fallback(
            "missing rollout path"
        ));
        assert!(history_error_allows_runtime_fallback(
            "The system cannot find the file specified. (os error 2)"
        ));
        assert!(!history_error_allows_runtime_fallback("permission denied"));
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
        assert!(!should_try_known_wsl_rollout_path(
            None,
            Some("C:\\\\tmp\\\\a.jsonl")
        ));
    }

    #[test]
    fn attach_rollout_path_to_create_response_keeps_existing_shape() {
        let value = json!({
            "threadId": "thread-1",
            "thread": { "id": "thread-1" }
        });
        let next = attach_rollout_path_to_create_response(value, Some("C:\\temp\\rollout.jsonl"));
        assert_eq!(
            next.get("path").and_then(Value::as_str),
            Some("C:\\temp\\rollout.jsonl")
        );
        assert_eq!(
            next.get("thread")
                .and_then(Value::as_object)
                .and_then(|thread| thread.get("path"))
                .and_then(Value::as_str),
            Some("C:\\temp\\rollout.jsonl")
        );
        assert_eq!(thread_id_from_response(&next).as_deref(), Some("thread-1"));
    }

    #[test]
    fn build_thread_start_params_preserve_explicit_service_tier_override() {
        let params = build_thread_start_params(&ThreadCreateRequest {
            workspace: Some("windows".to_string()),
            title: None,
            cwd: Some("C:\\repo".to_string()),
            service_tier: ServiceTierOverride::String("fast".to_string()),
            approval_policy: None,
            sandbox: None,
        });
        assert_eq!(params["workspace"], "windows");
        assert_eq!(params["cwd"], "C:\\repo");
        assert_eq!(params["serviceTier"], "fast");
    }

    #[test]
    fn build_thread_start_params_include_runtime_permission_overrides() {
        let params = build_thread_start_params(&ThreadCreateRequest {
            workspace: Some("windows".to_string()),
            title: None,
            cwd: Some("C:\\repo".to_string()),
            service_tier: ServiceTierOverride::Missing,
            approval_policy: Some("on-request".to_string()),
            sandbox: Some("workspaceWrite".to_string()),
        });
        assert_eq!(params["approvalPolicy"], "on-request");
        assert_eq!(params["sandbox"], "workspaceWrite");
    }

    #[test]
    fn build_thread_resume_params_preserve_explicit_null_service_tier_override() {
        let params = build_thread_resume_params(
            "thread-1",
            Some(None),
            Some("never".to_string()),
            Some("dangerFullAccess".to_string()),
        );
        assert_eq!(params["threadId"], "thread-1");
        assert!(params.get("serviceTier").is_some());
        assert!(params["serviceTier"].is_null());
        assert_eq!(params["approvalPolicy"], "never");
        assert_eq!(params["sandbox"], "dangerFullAccess");
    }

    #[test]
    fn merge_thread_runtime_overlay_keeps_live_rollout_metadata_when_runtime_is_imported_copy() {
        let mut thread = json!({
            "id": "thread-1",
            "path": "/home/yiyou/.codex/sessions/2026/03/20/rollout-thread-1.jsonl",
            "cwd": "/home/yiyou/Automated-Supertrend-Trading",
            "updatedAt": 20,
            "status": { "type": "notLoaded" }
        });
        let runtime = json!({
            "id": "thread-1",
            "path": "/home/yiyou/.codex/sessions/imported/thread-1.jsonl",
            "cwd": "/home/yiyou",
            "updatedAt": 10,
            "status": { "type": "idle" }
        });

        merge_runtime_thread_overlay(&mut thread, &runtime);

        assert_eq!(
            thread["path"].as_str(),
            Some("/home/yiyou/.codex/sessions/2026/03/20/rollout-thread-1.jsonl")
        );
        assert_eq!(
            thread["cwd"].as_str(),
            Some("/home/yiyou/Automated-Supertrend-Trading")
        );
        assert_eq!(thread["updatedAt"].as_i64(), Some(20));
        assert_eq!(thread["status"]["type"].as_str(), Some("idle"));
    }

    #[test]
    fn merge_thread_runtime_overlay_prefers_app_server_runtime_fields() {
        let mut thread = json!({
            "id": "thread-1",
            "status": { "type": "notLoaded" },
            "path": "C:\\temp\\old.jsonl",
            "updatedAt": 1
        });
        let runtime = json!({
            "id": "thread-1",
            "status": { "type": "running" },
            "path": "C:\\temp\\live.jsonl",
            "updatedAt": 2,
            "modelProvider": "api_router",
            "model": "gpt-5.4"
        });
        merge_runtime_thread_overlay(&mut thread, &runtime);
        assert_eq!(
            thread
                .get("status")
                .and_then(Value::as_object)
                .and_then(|status| status.get("type"))
                .and_then(Value::as_str),
            Some("running")
        );
        assert_eq!(
            thread.get("path").and_then(Value::as_str),
            Some("C:\\temp\\live.jsonl")
        );
        assert_eq!(thread.get("updatedAt").and_then(Value::as_i64), Some(2));
        assert_eq!(
            thread.get("modelProvider").and_then(Value::as_str),
            Some("api_router")
        );
    }

    #[test]
    fn runtime_thread_response_to_history_page_falls_back_to_runtime_turns() {
        let runtime = json!({
            "thread": {
                "id": "thread-1",
                "path": "C:\\temp\\rollout.jsonl",
                "status": { "type": "running" },
                "tokenUsage": { "total": { "totalTokens": 42 } },
                "turns": [
                    { "id": "turn-1", "items": [{ "type": "userMessage", "text": "one" }] },
                    { "id": "turn-2", "items": [{ "type": "assistantMessage", "text": "two" }] }
                ]
            }
        });

        let page = runtime_thread_response_to_history_page(&runtime, None, 1)
            .expect("runtime history fallback");
        let turns = page.thread["turns"].as_array().expect("turns array");
        assert_eq!(turns.len(), 1);
        assert_eq!(turns[0]["id"].as_str(), Some("turn-2"));
        assert_eq!(
            page.thread["rolloutPath"].as_str(),
            Some("C:\\temp\\rollout.jsonl")
        );
        assert_eq!(page.page["hasMore"].as_bool(), Some(true));
        assert_eq!(page.page["incomplete"].as_bool(), Some(true));
    }

    #[test]
    fn synthesize_thread_list_item_uses_runtime_path_and_status() {
        let create = json!({
            "threadId": "thread-1",
            "title": "Plan next step"
        });
        let runtime = json!({
            "thread": {
                "id": "thread-1",
                "cwd": "C:\\repo",
                "path": "C:\\repo\\.codex\\sessions\\rollout.jsonl",
                "status": { "type": "running" },
                "updatedAt": 1742270000
            }
        });

        let item = synthesize_thread_list_item(WorkspaceTarget::Windows, &create, Some(&runtime))
            .expect("thread list item");
        assert_eq!(item["id"].as_str(), Some("thread-1"));
        assert_eq!(
            item["path"].as_str(),
            Some("C:\\repo\\.codex\\sessions\\rollout.jsonl")
        );
        assert_eq!(item["cwd"].as_str(), Some("C:\\repo"));
        assert_eq!(item["preview"].as_str(), Some("Plan next step"));
        assert_eq!(item["status"]["type"].as_str(), Some("running"));
    }

    #[test]
    fn collect_worktree_probe_requests_deduplicates_workspace_and_cwd() {
        let items = vec![
            json!({ "workspace": "windows", "cwd": "C:\\repo-a" }),
            json!({ "workspace": "windows", "cwd": "C:\\repo-a" }),
            json!({ "workspace": "wsl2", "cwd": "/repo-b" }),
            json!({ "workspace": "wsl2", "cwd": "/repo-b" }),
            json!({ "workspace": "windows", "cwd": "   " }),
        ];

        let requests = collect_worktree_probe_requests(&items, None);

        assert_eq!(
            requests,
            vec![(Some("windows".to_string()), "C:\\repo-a".to_string())]
        );
    }

    #[test]
    fn collect_worktree_probe_requests_skips_wsl2_without_explicit_workspace_hint() {
        let items = vec![json!({ "workspace": "wsl2", "cwd": "/repo-b" })];

        let requests = collect_worktree_probe_requests(&items, None);

        assert!(requests.is_empty());
    }

    #[test]
    fn collect_worktree_probe_requests_prefers_workspace_hint() {
        let items = vec![
            json!({ "workspace": "windows", "cwd": "C:\\repo-a" }),
            json!({ "workspace": "wsl2", "cwd": "C:\\repo-a" }),
        ];

        let requests = collect_worktree_probe_requests(&items, Some("windows"));

        assert_eq!(
            requests,
            vec![(Some("windows".to_string()), "C:\\repo-a".to_string())]
        );
    }

    #[test]
    fn collect_worktree_probe_requests_skips_wsl2_even_with_explicit_workspace_hint() {
        let items = vec![json!({ "workspace": "wsl2", "cwd": "/repo-b" })];

        let requests = collect_worktree_probe_requests(&items, Some("wsl2"));

        assert!(requests.is_empty());
    }

    #[test]
    fn worktree_probe_concurrency_limit_prevents_subprocess_bursts() {
        assert_eq!(MAX_CONCURRENT_WORKTREE_PROBES, 4);
    }

    #[test]
    fn worktree_probe_result_key_normalizes_workspace_case() {
        assert_eq!(
            worktree_probe_result_key(Some("Windows"), "C:\\repo-a"),
            worktree_probe_result_key(Some("windows"), "C:\\repo-a")
        );
    }
}
