use super::*;
use axum::extract::{Path as AxumPath, Query};
use serde::Deserialize;

use crate::orchestrator::gateway::web_codex_rollout_import::{
    import_rollout_from_known_path, import_windows_rollout_into_codex_home,
    import_wsl_rollout_into_codex_home, resume_import_order,
};

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
}

fn normalize_requested_workspace_label(value: Option<&str>) -> String {
    let requested_workspace = value.unwrap_or_default();
    if requested_workspace.trim().is_empty() {
        "all".to_string()
    } else {
        requested_workspace.trim().to_ascii_lowercase()
    }
}

fn normalize_rollout_query_path(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|raw| !raw.is_empty())
        .map(str::to_string)
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

pub(super) async fn codex_threads_list(
    State(st): State<GatewayState>,
    headers: HeaderMap,
    Query(query): Query<ThreadsQuery>,
) -> Response {
    if let Some(resp) = require_codex_auth(&st, &headers) {
        return resp;
    }
    let started = std::time::Instant::now();
    let requested_workspace = query.workspace.unwrap_or_default();
    let workspace_meta = normalize_requested_workspace_label(Some(&requested_workspace));
    let force = query.force.unwrap_or(false);
    let target = parse_workspace_target(&requested_workspace);
    let snapshot =
        crate::orchestrator::gateway::web_codex_threads::list_threads_snapshot(target, force).await;
    if matches!(target, Some(WorkspaceTarget::Wsl2) | None) {
        crate::orchestrator::gateway::web_codex_history::spawn_wsl_history_prewarm(&snapshot.items);
    }
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

pub(super) async fn codex_threads_create(
    State(st): State<GatewayState>,
    headers: HeaderMap,
    LoggedJson(req): LoggedJson<ThreadCreateRequest>,
) -> Response {
    if let Some(resp) = require_codex_auth(&st, &headers) {
        return resp;
    }
    let params = json!({ "workspace": req.workspace, "title": req.title, "cwd": req.cwd });
    match codex_rpc_call("thread/new", params).await {
        Ok(value) => {
            crate::orchestrator::gateway::web_codex_threads::invalidate_thread_list_cache_all();
            Json(value).into_response()
        }
        Err(resp) => resp,
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
    let rollout_path =
        if let Some(path) = normalize_rollout_query_path(query.rollout_path.as_deref()) {
            Some(path)
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
    let limit = query.limit.unwrap_or_else(
        crate::orchestrator::gateway::web_codex_history::default_history_page_limit,
    );
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
    let home = crate::orchestrator::gateway::web_codex_home::web_codex_rpc_home_override_for_target(
        workspace_hint,
    );
    if let Some(rollout_path) = known_rollout_path.as_deref() {
        match import_rollout_from_known_path(home.as_deref(), &id, workspace_hint, rollout_path) {
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

    let params = json!({ "threadId": id });
    match crate::codex_app_server::request_in_home(home.as_deref(), "thread/resume", params.clone())
        .await
    {
        Ok(value) => Json(value).into_response(),
        Err(first_error) => {
            let lower = first_error.to_ascii_lowercase();
            let missing_rollout = lower.contains("no rollout found") || lower.contains("thread id");
            if missing_rollout {
                if let Some(rollout_path) = known_rollout_path.as_deref() {
                    match import_rollout_from_known_path(
                        home.as_deref(),
                        &id,
                        workspace_hint,
                        rollout_path,
                    ) {
                        Ok(true) => {
                            match crate::codex_app_server::request_in_home(
                                home.as_deref(),
                                "thread/resume",
                                params.clone(),
                            )
                            .await
                            {
                                Ok(value) => {
                                    return Json(value).into_response();
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
                let import_order = resume_import_order(workspace_hint);
                for target in import_order {
                    let import_result = match target {
                        WorkspaceTarget::Windows => {
                            let target_home = crate::orchestrator::gateway::web_codex_home::web_codex_rpc_home_override_for_target(Some(WorkspaceTarget::Windows));
                            import_windows_rollout_into_codex_home(target_home.as_deref(), &id)
                        }
                        WorkspaceTarget::Wsl2 => {
                            let target_home = crate::orchestrator::gateway::web_codex_home::web_codex_rpc_home_override_for_target(Some(WorkspaceTarget::Wsl2));
                            import_wsl_rollout_into_codex_home(target_home.as_deref(), &id)
                        }
                    };
                    match import_result {
                        Ok(true) => {
                            let retry_home = crate::orchestrator::gateway::web_codex_home::web_codex_rpc_home_override_for_target(Some(target));
                            match crate::codex_app_server::request_in_home(
                                retry_home.as_deref(),
                                "thread/resume",
                                params.clone(),
                            )
                            .await
                            {
                                Ok(value) => {
                                    return Json(value).into_response();
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

#[cfg(test)]
mod tests {
    use super::*;

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
}
