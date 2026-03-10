use axum::extract::Query;

use self::web_codex_auth::{api_error, api_error_detail, require_codex_auth};

pub(super) const MAX_ATTACHMENT_BYTES: usize = 10 * 1024 * 1024;
const MAX_TERMINAL_COMMAND_LEN: usize = 4000;
const MAX_TERMINAL_OUTPUT_BYTES: usize = 512 * 1024;
const TERMINAL_TIMEOUT_SECS: u64 = 20;
const HISTORY_READ_TIMEOUT_SECS: u64 = 20;
const VERSION_DETECT_TIMEOUT_SECS: u64 = 3;
const VERSION_INFO_CACHE_SECS: i64 = 30;

type WorkspaceTarget = crate::orchestrator::gateway::web_codex_home::WorkspaceTarget;

pub(super) fn workspace_target_from_params(params: &Value) -> Option<WorkspaceTarget> {
    params
        .get("workspace")
        .and_then(|v| v.as_str())
        .and_then(parse_workspace_target)
}

pub(super) async fn codex_rpc_call(method: &str, params: Value) -> Result<Value, Response> {
    let home =
        crate::orchestrator::gateway::web_codex_home::web_codex_rpc_home_override_for_target(
            workspace_target_from_params(&params),
        );
    crate::codex_app_server::request_in_home(home.as_deref(), method, params)
        .await
        .map_err(|e| api_error_detail(StatusCode::BAD_GATEWAY, "codex app-server request failed", e))
}

pub(super) async fn codex_try_request_with_fallback(
    methods: &[&str],
    params: Value,
) -> Result<Value, String> {
    let mut last_err = String::new();
    let home = crate::orchestrator::gateway::web_codex_home::web_codex_rpc_home_override();
    for method in methods {
        match crate::codex_app_server::request_in_home(home.as_deref(), method, params.clone())
            .await
        {
            Ok(value) => return Ok(value),
            Err(error) => last_err = error,
        }
    }
    Err(last_err)
}

fn parse_workspace_target(value: &str) -> Option<WorkspaceTarget> {
    crate::orchestrator::gateway::web_codex_home::parse_workspace_target(value)
}

fn current_unix_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|v| v.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod web_codex_tests {
    use super::MAX_TERMINAL_OUTPUT_BYTES;
    use crate::orchestrator::gateway::web_codex_runtime::truncate_output;

    #[test]
    fn truncate_output_marks_cutoff() {
        let input = vec![b'a'; MAX_TERMINAL_OUTPUT_BYTES + 8];
        let (text, truncated) = truncate_output(&input);
        assert!(truncated);
        assert_eq!(text.len(), MAX_TERMINAL_OUTPUT_BYTES);
    }
}
