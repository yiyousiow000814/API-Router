use axum::extract::Query;

use self::web_codex_auth::{api_error, api_error_detail, require_codex_auth};

pub(super) const MAX_ATTACHMENT_BYTES: usize = 10 * 1024 * 1024;
const MAX_TERMINAL_COMMAND_LEN: usize = 4000;
const MAX_TERMINAL_OUTPUT_BYTES: usize = 512 * 1024;
const TERMINAL_TIMEOUT_SECS: u64 = 20;
const HISTORY_READ_TIMEOUT_SECS: u64 = 20;
const VERSION_DETECT_TIMEOUT_SECS: u64 = 3;
const VERSION_INFO_CACHE_SECS: i64 = 5 * 60;

type WorkspaceTarget = crate::orchestrator::gateway::web_codex_home::WorkspaceTarget;

static UNSUPPORTED_RPC_METHOD_CACHE: OnceLock<Mutex<HashMap<String, u64>>> = OnceLock::new();

fn unsupported_rpc_method_cache() -> &'static Mutex<HashMap<String, u64>> {
    UNSUPPORTED_RPC_METHOD_CACHE.get_or_init(|| {
        let initial = crate::orchestrator::gateway::web_codex_storage::read_unsupported_rpc_cache()
            .unwrap_or_default();
        Mutex::new(initial)
    })
}

fn unsupported_rpc_cache_key(codex_home: Option<&str>, method: &str) -> String {
    let home = codex_home.unwrap_or_default().trim();
    format!("{home}::{method}")
}

fn unsupported_rpc_cache_now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_millis() as u64)
        .unwrap_or(0)
}

fn unsupported_rpc_cache_ttl_ms() -> u64 {
    6 * 60 * 60 * 1000
}

fn prune_expired_unsupported_rpc_cache(cache: &mut HashMap<String, u64>) -> bool {
    let threshold_ms = unsupported_rpc_cache_now_ms().saturating_sub(unsupported_rpc_cache_ttl_ms());
    let before = cache.len();
    cache.retain(|key, recorded_at_unix_ms| !key.trim().is_empty() && *recorded_at_unix_ms >= threshold_ms);
    cache.len() != before
}

fn is_unsupported_rpc_method_error(error: &str) -> bool {
    let text = error.trim().to_ascii_lowercase();
    text.contains("unknown variant") || text.contains("missing field `method`")
}

fn is_rpc_method_marked_unsupported(codex_home: Option<&str>, method: &str) -> bool {
    let key = unsupported_rpc_cache_key(codex_home, method);
    let mut guard = unsupported_rpc_method_cache().lock();
    let pruned = prune_expired_unsupported_rpc_cache(&mut guard);
    let marked = guard.contains_key(&key);
    if pruned {
        let _ = crate::orchestrator::gateway::web_codex_storage::write_unsupported_rpc_cache(&guard);
    }
    marked
}

fn mark_rpc_method_unsupported(codex_home: Option<&str>, method: &str) {
    let key = unsupported_rpc_cache_key(codex_home, method);
    let mut guard = unsupported_rpc_method_cache().lock();
    prune_expired_unsupported_rpc_cache(&mut guard);
    guard.insert(key, unsupported_rpc_cache_now_ms());
    let _ = crate::orchestrator::gateway::web_codex_storage::write_unsupported_rpc_cache(&guard);
}

fn clear_rpc_method_unsupported(codex_home: Option<&str>, method: &str) {
    let key = unsupported_rpc_cache_key(codex_home, method);
    let mut guard = unsupported_rpc_method_cache().lock();
    let pruned = prune_expired_unsupported_rpc_cache(&mut guard);
    if guard.remove(&key).is_some() || pruned {
        let _ = crate::orchestrator::gateway::web_codex_storage::write_unsupported_rpc_cache(&guard);
    }
}

pub(super) fn workspace_target_from_params(params: &Value) -> Option<WorkspaceTarget> {
    params
        .get("workspace")
        .and_then(|v| v.as_str())
        .and_then(parse_workspace_target)
}

pub(super) async fn codex_rpc_call(method: &str, params: Value) -> Result<Value, Response> {
    let home = crate::orchestrator::gateway::web_codex_home::web_codex_rpc_home_override_for_target(
        workspace_target_from_params(&params),
    );
    crate::codex_app_server::request_in_home(home.as_deref(), method, params)
        .await
        .map_err(|e| {
            api_error_detail(
                StatusCode::BAD_GATEWAY,
                "codex app-server request failed",
                e,
            )
        })
}

pub(super) async fn codex_try_request_with_fallback_in_home(
    codex_home: Option<&str>,
    methods: &[&str],
    params: Value,
) -> Result<Value, String> {
    let mut last_err = String::new();
    let mut attempted_any = false;
    for method in methods {
        if is_rpc_method_marked_unsupported(codex_home, method) {
            continue;
        }
        attempted_any = true;
        match crate::codex_app_server::request_in_home(codex_home, method, params.clone()).await {
            Ok(value) => {
                clear_rpc_method_unsupported(codex_home, method);
                return Ok(value);
            }
            Err(error) => {
                if is_unsupported_rpc_method_error(&error) {
                    mark_rpc_method_unsupported(codex_home, method);
                }
                last_err = error;
            }
        }
    }
    if !attempted_any {
        return Err("all candidate rpc methods are marked unsupported".to_string());
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
#[allow(clippy::await_holding_lock)]
mod web_codex_tests {
    use super::MAX_TERMINAL_OUTPUT_BYTES;
    use super::{
        codex_try_request_with_fallback_in_home, unsupported_rpc_method_cache,
    };
    use crate::orchestrator::gateway::web_codex_runtime::truncate_output;
    use serde_json::Value;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };

    #[test]
    fn truncate_output_marks_cutoff() {
        let input = vec![b'a'; MAX_TERMINAL_OUTPUT_BYTES + 8];
        let (text, truncated) = truncate_output(&input);
        assert!(truncated);
        assert_eq!(text.len(), MAX_TERMINAL_OUTPUT_BYTES);
    }

    #[tokio::test]
    async fn fallback_skips_rpc_methods_marked_unsupported() {
        let _guard = crate::codex_app_server::lock_test_globals();
        unsupported_rpc_method_cache().lock().clear();
        let calls = Arc::new(AtomicUsize::new(0));
        let calls_ref = calls.clone();
        crate::codex_app_server::_set_test_request_handler(Some(Arc::new(
            move |_home, method, _params| {
                calls_ref.fetch_add(1, Ordering::SeqCst);
                if method == "unsupported/list" {
                    return Err("Invalid request: unknown variant `unsupported/list`".to_string());
                }
                Ok(Value::Array(vec![]))
            },
        )))
        .await;

        let _ =
            codex_try_request_with_fallback_in_home(None, &["unsupported/list"], Value::Null).await;
        let first_calls = calls.load(Ordering::SeqCst);
        let _ =
            codex_try_request_with_fallback_in_home(None, &["unsupported/list"], Value::Null).await;
        let second_calls = calls.load(Ordering::SeqCst);

        assert_eq!(first_calls, 1);
        assert_eq!(second_calls, 1);

        crate::codex_app_server::_set_test_request_handler(None).await;
        unsupported_rpc_method_cache().lock().clear();
    }

    #[tokio::test]
    async fn fallback_marks_unsupported_per_home() {
        let _guard = crate::codex_app_server::lock_test_globals();
        unsupported_rpc_method_cache().lock().clear();
        let calls = Arc::new(AtomicUsize::new(0));
        let calls_ref = calls.clone();
        crate::codex_app_server::_set_test_request_handler(Some(Arc::new(
            move |_home, method, _params| {
                if method == "unsupported/list" {
                    calls_ref.fetch_add(1, Ordering::SeqCst);
                    return Err("Invalid request: unknown variant `unsupported/list`".to_string());
                }
                Ok(Value::Array(vec![]))
            },
        )))
        .await;

        let _ = codex_try_request_with_fallback_in_home(Some("home-a"), &["unsupported/list"], Value::Null).await;
        let after_home_a = calls.load(Ordering::SeqCst);
        let _ = codex_try_request_with_fallback_in_home(Some("home-b"), &["unsupported/list"], Value::Null).await;
        let after_home_b = calls.load(Ordering::SeqCst);
        let _ = codex_try_request_with_fallback_in_home(Some("home-a"), &["unsupported/list"], Value::Null).await;
        let after_home_a_repeat = calls.load(Ordering::SeqCst);

        assert_eq!(after_home_a, 1);
        assert_eq!(after_home_b, 2);
        assert_eq!(after_home_a_repeat, 2);

        crate::codex_app_server::_set_test_request_handler(None).await;
        unsupported_rpc_method_cache().lock().clear();
    }
}
