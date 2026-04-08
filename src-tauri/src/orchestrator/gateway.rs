use std::collections::{HashMap, HashSet};
use std::error::Error;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use axum::body::Body;
use axum::extract::DefaultBodyLimit;
use axum::extract::{FromRequest, FromRequestParts, Json, State};
use axum::http::request::Parts;
use axum::http::Request;
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post};
use axum::Router;
use bytes::Bytes;
use parking_lot::RwLock;
use serde_json::{json, Value};

use super::config::AppConfig;
use super::openai::{
    extract_text_from_responses, input_to_items_preserve_tools, input_to_messages,
    messages_to_responses_input, messages_to_simple_input_list, sse_events_for_text,
};
use super::router::{provider_iteration_order, select_fallback_provider, RouterState};
use super::secrets::SecretStore;
use super::store::{extract_response_model_option, unix_ms, Store};
use super::upstream::UpstreamClient;
use crate::constants::GATEWAY_MODEL_PROVIDER_ID;
use crate::platform::windows_terminal;
use parking_lot::Mutex;
use std::sync::OnceLock;

#[derive(Clone, Copy, Debug)]
struct PeerAddr(SocketAddr);

#[axum::async_trait]
impl<S> FromRequestParts<S> for PeerAddr
where
    S: Send + Sync,
{
    type Rejection = std::convert::Infallible;

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        // In production the server is created with `into_make_service_with_connect_info` so this
        // extension is present. In unit tests (Router::oneshot), it isn't.
        if let Some(ci) = parts
            .extensions
            .get::<axum::extract::ConnectInfo<SocketAddr>>()
        {
            return Ok(PeerAddr(ci.0));
        }
        Ok(PeerAddr(SocketAddr::from(([127, 0, 0, 1], 0))))
    }
}

#[derive(Clone)]
pub struct GatewayState {
    pub cfg: Arc<RwLock<AppConfig>>,
    pub router: Arc<RouterState>,
    pub store: Store,
    pub upstream: UpstreamClient,
    pub secrets: SecretStore,
    pub last_activity_unix_ms: Arc<AtomicU64>,
    pub last_used_by_session: Arc<RwLock<HashMap<String, LastUsedRoute>>>,
    pub usage_base_speed_cache: Arc<RwLock<HashMap<String, UsageBaseSpeedCacheEntry>>>,
    pub prev_id_support_cache: Arc<RwLock<HashMap<String, bool>>>,
    pub client_sessions: Arc<RwLock<HashMap<String, ClientSessionRuntime>>>,
}

static RUNTIME_BOUND_LISTENER_ADDRS: OnceLock<Mutex<HashSet<SocketAddr>>> = OnceLock::new();

fn runtime_bound_listener_addrs() -> &'static Mutex<HashSet<SocketAddr>> {
    RUNTIME_BOUND_LISTENER_ADDRS.get_or_init(|| Mutex::new(HashSet::new()))
}

#[derive(Clone, Debug)]
pub struct LastUsedRoute {
    pub provider: String,
    pub reason: String,
    pub preferred: String,
    pub unix_ms: u64,
}

#[derive(Clone, Debug)]
pub struct ClientSessionRuntime {
    // The stable Codex session id. This is the canonical session identity.
    pub codex_session_id: String,
    // Last observed PID owning the Codex process (best-effort; may be a helper process).
    pub pid: u32,
    // Last observed WT_SESSION for the Codex process (best-effort; discovery-only).
    pub wt_session: Option<String>,
    // Timestamp of last request observed from this session (not just "discovered").
    pub last_request_unix_ms: u64,
    // Timestamp of last time we saw the process in a discovery scan.
    pub last_discovered_unix_ms: u64,
    pub last_reported_model_provider: Option<String>,
    // Last model observed from upstream response payload/events.
    pub last_reported_model: Option<String>,
    pub last_reported_base_url: Option<String>,
    // Parent main session id for agent sub-sessions when known.
    pub agent_parent_session_id: Option<String>,
    // Mark sessions spawned from Codex subagent flows.
    pub is_agent: bool,
    // Subagent subtype marker (currently only review is surfaced in UI).
    pub is_review: bool,
    // Sticky "this session uses our gateway" marker. This prevents sessions from disappearing if
    // the user edits Codex config files while Codex is running (the process keeps the old config
    // in memory, but we may no longer be able to prove it from disk).
    pub confirmed_router: bool,
}

fn update_session_response_model(st: &GatewayState, session_key: &str, response_model: &str) {
    let model = response_model.trim();
    if model.is_empty() {
        return;
    }
    let mut sessions = st.client_sessions.write();
    if let Some(entry) = sessions.get_mut(session_key) {
        entry.last_reported_model = Some(model.to_string());
    }
}

fn maybe_record_model_mismatch(
    st: &GatewayState,
    provider_name: &str,
    session_key: &str,
    requested_model: Option<&str>,
    response_model: &str,
    stream: bool,
) {
    let Some(req) = requested_model.map(str::trim).filter(|s| !s.is_empty()) else {
        return;
    };
    let resp = response_model.trim();
    if resp.is_empty() {
        return;
    }
    // Only emit a warning when the mismatch state changes (or after it was resolved).
    // This keeps the Events feed and daily graphs usable while still surfacing real mismatches.
    if !model_mismatch_should_log_transition(provider_name, session_key, req, resp) {
        return;
    }
    st.store.add_event(
        provider_name,
        "warning",
        "routing.model_mismatch",
        &format!("requested model {req}, upstream returned {resp}"),
        json!({
            "requested_model": req,
            "response_model": resp,
            "session": session_key,
            "stream": stream,
        }),
    );
}

#[derive(Clone, Debug)]
struct ModelMismatchMemo {
    // last observed upstream model for a given (provider, session, requested_model)
    last_response_model_lc: String,
}

static MODEL_MISMATCH_MEMO: OnceLock<Mutex<HashMap<String, ModelMismatchMemo>>> = OnceLock::new();

fn model_mismatch_memo() -> &'static Mutex<HashMap<String, ModelMismatchMemo>> {
    MODEL_MISMATCH_MEMO.get_or_init(|| Mutex::new(HashMap::new()))
}

#[cfg(test)]
fn _clear_model_mismatch_memo_for_test() {
    model_mismatch_memo().lock().clear();
}

fn model_mismatch_key(provider: &str, session: &str, requested_model: &str) -> String {
    format!(
        "{}|{}|{}",
        provider.trim().to_ascii_lowercase(),
        session.trim().to_ascii_lowercase(),
        requested_model.trim().to_ascii_lowercase()
    )
}

fn model_mismatch_should_log_transition(
    provider: &str,
    session: &str,
    requested_model: &str,
    response_model: &str,
) -> bool {
    let provider = provider.trim();
    let session = session.trim();
    let req = requested_model.trim();
    let resp = response_model.trim();
    if provider.is_empty() || session.is_empty() || req.is_empty() || resp.is_empty() {
        return false;
    }

    // If mismatch is resolved, clear memo so a future mismatch can log again.
    if req.eq_ignore_ascii_case(resp) {
        let key = model_mismatch_key(provider, session, req);
        model_mismatch_memo().lock().remove(&key);
        return false;
    }

    let key = model_mismatch_key(provider, session, req);
    let resp_lc = resp.to_ascii_lowercase();
    let mut memo = model_mismatch_memo().lock();
    match memo.get(&key) {
        Some(prev) if prev.last_response_model_lc == resp_lc => false,
        _ => {
            memo.insert(
                key,
                ModelMismatchMemo {
                    last_response_model_lc: resp_lc,
                },
            );
            true
        }
    }
}

#[cfg(test)]
mod model_mismatch_tests {
    use super::{_clear_model_mismatch_memo_for_test, model_mismatch_should_log_transition};

    #[test]
    fn model_mismatch_logs_only_on_transition_and_after_resolution() {
        _clear_model_mismatch_memo_for_test();
        // First mismatch logs.
        assert!(model_mismatch_should_log_transition(
            "packycode",
            "s1",
            "gpt-5.2",
            "gpt-5.2-2025-12-11"
        ));
        // Same mismatch again => no log spam.
        assert!(!model_mismatch_should_log_transition(
            "packycode",
            "s1",
            "gpt-5.2",
            "gpt-5.2-2025-12-11"
        ));
        // Different upstream model => logs transition.
        assert!(model_mismatch_should_log_transition(
            "packycode",
            "s1",
            "gpt-5.2",
            "gpt-5.3-codex"
        ));
        // Resolution clears memo (no log).
        assert!(!model_mismatch_should_log_transition(
            "packycode",
            "s1",
            "gpt-5.2",
            "gpt-5.2"
        ));
        // Mismatch again after resolution => logs again.
        assert!(model_mismatch_should_log_transition(
            "packycode",
            "s1",
            "gpt-5.2",
            "gpt-5.2-2025-12-11"
        ));
    }
}

#[derive(Clone, Debug)]
pub struct UsageBaseSpeedCacheEntry {
    pub updated_at_unix_ms: u64,
    pub bases_key: Vec<String>,
    pub ordered_bases: Vec<String>,
}

pub struct LoggedJson<T>(pub T);

#[axum::async_trait]
impl<T> FromRequest<GatewayState> for LoggedJson<T>
where
    T: serde::de::DeserializeOwned + Send,
{
    type Rejection = Response;

    async fn from_request(
        req: Request<Body>,
        state: &GatewayState,
    ) -> Result<Self, Self::Rejection> {
        let method = req.method().to_string();
        let path = req.uri().path().to_string();

        match Json::<T>::from_request(req, state).await {
            Ok(Json(v)) => Ok(Self(v)),
            Err(rej) => {
                let msg = rej.to_string();
                let msg = msg.chars().take(500).collect::<String>();
                let resp = rej.into_response();
                let code = resp.status().as_u16();
                state.store.add_event(
                    "gateway",
                    "error",
                    "gateway.request_parse_error",
                    &format!("{code} {method} {path}: {msg}"),
                    json!({ "http_status": code, "method": method, "path": path }),
                );
                Err(resp)
            }
        }
    }
}

pub(crate) fn should_log_routing_path_event(
    prev: Option<&LastUsedRoute>,
    provider: &str,
    reason: &str,
    preferred: &str,
    is_first_attempt: bool,
) -> bool {
    // Skip routine preferred-path success logs on first attempt.
    if is_first_attempt && reason == "preferred_healthy" {
        return false;
    }
    match prev {
        None => true,
        Some(last) => {
            last.provider != provider || last.reason != reason || last.preferred != preferred
        }
    }
}

pub(crate) fn is_back_to_preferred_transition(
    prev: Option<&LastUsedRoute>,
    provider: &str,
    preferred: &str,
) -> bool {
    prev.is_some_and(|last| {
        last.provider.as_str() != provider
            && last.preferred.as_str() == provider
            && preferred == provider
    })
}

async fn refresh_usage_once_after_first_failure(
    st: &GatewayState,
    provider_name: &str,
    usage_refreshed_after_first_failure: &mut bool,
) {
    if *usage_refreshed_after_first_failure {
        return;
    }
    *usage_refreshed_after_first_failure = true;

    let cfg = st.cfg.read().clone();
    let Some(_provider) = cfg.providers.get(provider_name) else {
        return;
    };

    st.router.require_usage_confirmation(provider_name);
    let snap = super::quota::refresh_quota_for_provider(st, provider_name).await;
    let refresh_ok = snap.updated_at_unix_ms > 0 && snap.last_error.trim().is_empty();
    if !refresh_ok {
        let err = snap.last_error.trim();
        let is_config_gap = err == "missing credentials for quota refresh"
            || err == "missing usage token"
            || err == "missing provider key"
            || err == "missing quota base"
            || err == "missing base_url"
            || err == "usage endpoint not found (set Usage base URL)";
        if is_config_gap {
            // If this provider does not support usage refresh in current config,
            // fall back to normal retry behavior instead of blocking indefinitely.
            st.router
                .clear_usage_confirmation_requirement(provider_name);
        } else {
            st.store.add_event(
                provider_name,
                "warning",
                "routing.usage_refresh_unconfirmed_after_failure",
                "usage refresh failed after first failure; provider kept out of routing until confirmation",
                json!({ "error": snap.last_error }),
            );
        }
        return;
    }

    let quota_snapshots = st.store.list_quota_snapshots();
    let hard_cap = st.secrets.get_provider_quota_hard_cap(provider_name);
    if quota_snapshot_confirms_available(&quota_snapshots, provider_name, &hard_cap) {
        st.router
            .clear_usage_confirmation_requirement(provider_name);
    } else if !provider_has_remaining_quota_with_hard_cap(
        &quota_snapshots,
        provider_name,
        &hard_cap,
    ) {
        st.store.add_event(
            provider_name,
            "warning",
            "routing.closed_after_failure_usage_refresh",
            "provider quota exhausted after first-failure usage refresh",
            Value::Null,
        );
    }
}

const TRANSIENT_UPSTREAM_RETRY_ATTEMPTS: usize = 2;
const TRANSIENT_UPSTREAM_RETRY_DELAY_MS: u64 = 250;

fn upstream_error_code_from_body(body: &str) -> Option<String> {
    serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|json| {
            json.get("error")
                .and_then(|value| value.get("code"))
                .and_then(Value::as_str)
                .map(|value| value.trim().to_ascii_lowercase())
        })
        .filter(|value| !value.is_empty())
}

fn is_retryable_upstream_status(code: u16) -> bool {
    matches!(code, 408 | 409 | 425 | 429) || (500..=599).contains(&code)
}

fn should_retry_upstream_request_error(err: &reqwest::Error) -> bool {
    err.is_timeout() || err.is_connect() || err.is_request() || err.is_body()
}

fn should_fallback_stream_response_to_non_stream(code: u16, body: &str) -> bool {
    if is_retryable_upstream_status(code) {
        return true;
    }
    code == 401
        && upstream_error_code_from_body(body)
            .is_some_and(|err_code| err_code == "token_invalidated")
}

fn log_upstream_retry_event(
    st: &GatewayState,
    provider_name: &str,
    kind: &str,
    detail: &str,
    attempt: usize,
    max_attempts: usize,
    stream: bool,
) {
    let cfg = st.cfg.read().clone();
    st.router
        .mark_transient_warning(provider_name, &cfg, detail, unix_ms());
    st.store.add_event(
        provider_name,
        "warning",
        "gateway.upstream_retry",
        detail,
        json!({
            "kind": kind,
            "attempt": attempt,
            "max_attempts": max_attempts,
            "stream": stream,
        }),
    );
}

#[cfg(test)]
mod upstream_retry_tests {
    use super::{
        is_retryable_upstream_status, should_fallback_stream_response_to_non_stream,
        upstream_error_code_from_body,
    };

    #[test]
    fn retryable_upstream_status_matches_transient_codes() {
        assert!(is_retryable_upstream_status(429));
        assert!(is_retryable_upstream_status(500));
        assert!(!is_retryable_upstream_status(401));
    }

    #[test]
    fn stream_fallback_treats_token_invalidated_as_suspicious() {
        let body = r#"{"error":{"code":"token_invalidated","type":"invalid_request_error","message":"bad token"}}"#;
        assert_eq!(
            upstream_error_code_from_body(body).as_deref(),
            Some("token_invalidated")
        );
        assert!(should_fallback_stream_response_to_non_stream(401, body));
    }
}

pub(crate) fn build_router_with_body_limit(state: GatewayState, max_body_bytes: usize) -> Router {
    let router = Router::new()
        .route("/health", get(health))
        .route("/status", get(status))
        .route(
            "/lan-sync/usage",
            post(crate::lan_sync::lan_sync_usage_http),
        )
        .route("/lan-sync/edit", post(crate::lan_sync::lan_sync_edit_http))
        .route(
            "/lan-sync/provider-definitions",
            post(crate::lan_sync::lan_sync_provider_definitions_http),
        )
        .route(
            "/lan-sync/remote-update",
            post(crate::lan_sync::lan_sync_remote_update_http),
        )
        .route(
            "/lan-sync/debug/tracked-spend-history",
            post(crate::lan_sync::lan_sync_tracked_spend_history_debug_http),
        )
        .route(
            "/lan-sync/debug/remote-update",
            post(crate::lan_sync::lan_sync_remote_update_debug_http),
        )
        .route("/v1/models", get(models))
        .route("/v1/responses", post(responses))
        .route("/responses", post(responses))
        .route("/", get(codex_app_server_ws))
        .route("/codex-web", get(codex_web_index))
        .route("/codex-web/app.js", get(codex_web_app_js))
        .route("/codex-web/modules/*path", get(codex_web_module_js))
        .route("/codex-web/codex-icon.svg", get(codex_web_icon_svg))
        .route("/favicon.ico", get(codex_web_favicon))
        .route("/ao-icon.png", get(codex_web_logo_png))
        .route("/codex/health", get(codex_health))
        .route("/codex/ws", get(codex_ws))
        .route("/codex/app-server/ws", get(codex_app_server_ws))
        .route("/codex/auth/verify", post(codex_auth_verify))
        .route("/codex/debug/live", get(codex_live_debug))
        .route("/codex/debug/live/client", post(codex_live_debug_client))
        .route(
            "/codex/hosts",
            get(codex_hosts_list).post(codex_hosts_create),
        )
        .route(
            "/codex/hosts/:id",
            patch(codex_hosts_update).delete(codex_hosts_delete),
        )
        .route("/codex/models", get(codex_models))
        .route("/codex/cli-config", get(codex_cli_config))
        .route("/codex/file", get(codex_file))
        .route("/codex/folders", get(codex_folders_list))
        .route("/codex/approvals/pending", get(codex_pending_approvals))
        .route("/codex/user-input/pending", get(codex_pending_user_inputs))
        .route(
            "/codex/threads",
            get(codex_threads_list).post(codex_threads_create),
        )
        .route("/codex/threads/:id/history", get(codex_thread_history))
        .route("/codex/threads/:id/transport", get(codex_thread_transport))
        .route(
            "/codex/threads/:id/managed-terminal",
            post(codex_thread_open_managed_terminal),
        )
        .route("/codex/threads/:id/interrupt", post(codex_thread_interrupt))
        .route("/codex/threads/:id/resume", post(codex_thread_resume))
        .route("/codex/turns/start", post(codex_turn_start))
        .route("/codex/turns/stream", post(codex_turn_stream))
        .route("/codex/turns/:id/interrupt", post(codex_turn_interrupt))
        .route("/codex/approvals/:id/resolve", post(codex_approval_resolve))
        .route(
            "/codex/user-input/:id/resolve",
            post(codex_user_input_resolve),
        )
        .route("/codex/attachments/upload", post(codex_attachments_upload))
        .route("/codex/slash/commands", get(codex_slash_commands))
        .route(
            "/codex/slash/review/branches",
            get(codex_slash_review_branches),
        )
        .route(
            "/codex/slash/review/commits",
            get(codex_slash_review_commits),
        )
        .route("/codex/slash/execute", post(codex_slash_execute))
        .route("/codex/terminal/exec", post(codex_terminal_exec))
        .route("/codex/runtime/state", get(codex_runtime_state))
        .route("/codex/version-info", get(codex_version_info))
        .route("/codex/rpc", post(codex_rpc_proxy))
        .layer(DefaultBodyLimit::max(max_body_bytes))
        .with_state(state);
    #[cfg(test)]
    let router = router.route("/__test/block-history", get(codex_test_block_history));
    router
}

pub fn build_router(state: GatewayState) -> Router {
    // Codex can send large request bodies (context/tool outputs). Axum's default JSON body limit
    // is small and returns 413 before handlers run. We allow up to 512 MiB.
    const MAX_BODY_BYTES: usize = 512 * 1024 * 1024;
    build_router_with_body_limit(state, MAX_BODY_BYTES)
}

fn gateway_startup_diag_path() -> Option<PathBuf> {
    let user_data_dir = std::env::var("API_ROUTER_USER_DATA_DIR").ok()?;
    let trimmed = user_data_dir.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(PathBuf::from(trimmed).join("gateway-startup.json"))
}

fn write_gateway_startup_diag(stage: &str, addr: Option<SocketAddr>, detail: Option<&str>) {
    let Some(path) = gateway_startup_diag_path() else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let payload = json!({
        "stage": stage,
        "addr": addr.map(|v| v.to_string()),
        "detail": detail,
        "updatedAtUnixMs": unix_ms(),
    });
    let _ = std::fs::write(
        path,
        serde_json::to_vec_pretty(&payload).unwrap_or_default(),
    );
}

include!("gateway/request_helpers.rs");
mod web_codex_actions;
mod web_codex_assets;
mod web_codex_auth;
mod web_codex_history;
pub(crate) mod web_codex_home;
mod web_codex_hosts;
mod web_codex_meta;
mod web_codex_rollout_import;
mod web_codex_rollout_path;
mod web_codex_runtime;
mod web_codex_session_manager;
mod web_codex_session_runtime;
pub(crate) mod web_codex_storage;
mod web_codex_thread_options;
mod web_codex_thread_routes;
mod web_codex_threads;
mod web_codex_ws;
include!("gateway/web_codex.rs");
use self::web_codex_actions::{
    codex_approval_resolve, codex_attachments_upload, codex_rpc_proxy, codex_slash_commands,
    codex_slash_execute, codex_slash_review_branches, codex_slash_review_commits,
    codex_thread_interrupt, codex_thread_open_managed_terminal, codex_thread_transport,
    codex_turn_interrupt, codex_turn_start, codex_turn_stream, codex_user_input_resolve,
};
use self::web_codex_assets::{
    codex_web_app_js, codex_web_favicon, codex_web_icon_svg, codex_web_index, codex_web_logo_png,
    codex_web_module_js,
};
use self::web_codex_hosts::{
    codex_hosts_create, codex_hosts_delete, codex_hosts_list, codex_hosts_update,
};
use self::web_codex_meta::{
    codex_cli_config, codex_file, codex_folders_list, codex_health, codex_models,
    codex_pending_approvals, codex_pending_user_inputs,
};
use self::web_codex_runtime::{codex_runtime_state, codex_terminal_exec, codex_version_info};
#[cfg(test)]
use self::web_codex_thread_routes::codex_test_block_history;
use self::web_codex_thread_routes::{
    codex_thread_history, codex_thread_resume, codex_threads_create, codex_threads_list,
};
use self::web_codex_ws::{
    codex_app_server_ws, codex_auth_verify, codex_live_debug, codex_live_debug_client, codex_ws,
};
const SESSION_HISTORY_FLUSH_RETRY_DELAY_MS: u64 = 120;

#[cfg(test)]
pub(crate) fn _set_test_web_codex_history_loader(
    loader: Option<
        std::sync::Arc<
            dyn Fn() -> Result<(serde_json::Value, serde_json::Value), String> + Send + Sync,
        >,
    >,
) {
    web_codex_history::_set_test_history_loader(loader.map(|loader| {
        std::sync::Arc::new(
            move |_thread_id, _workspace, _rollout_path, _before, _limit| {
                loader().map(|(thread, page)| web_codex_history::ThreadHistoryPage { thread, page })
            },
        ) as _
    }));
}

pub async fn serve_in_background(
    state: GatewayState,
    prepared: crate::orchestrator::gateway_bootstrap::PreparedGatewayListeners,
) -> anyhow::Result<()> {
    let diag_addr = prepared.listeners.first().map(|(addr, _)| *addr);
    let diag_binding = prepared
        .listeners
        .iter()
        .map(|(addr, _)| addr.to_string())
        .collect::<Vec<_>>()
        .join(", ");
    {
        state.cfg.write().listen.port = prepared.listen_port;
        let mut bound_listener_addrs = runtime_bound_listener_addrs().lock();
        for (addr, _) in &prepared.listeners {
            bound_listener_addrs.insert(*addr);
        }
    }
    write_gateway_startup_diag("binding", diag_addr, Some(&diag_binding));

    let app = build_router(state);
    write_gateway_startup_diag("listening", diag_addr, Some(&diag_binding));
    web_codex_threads::spawn_thread_index_prewarm();
    let mut servers = tokio::task::JoinSet::new();
    for (addr, listener) in prepared.listeners {
        let listener = tokio::net::TcpListener::from_std(listener)?;
        let app_for_addr = app.clone();
        servers.spawn(async move {
            axum::serve(
                listener,
                app_for_addr.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await
            .map_err(|err| (addr, err))
        });
    }
    while let Some(result) = servers.join_next().await {
        match result {
            Ok(Ok(())) => {}
            Ok(Err((addr, err))) => {
                write_gateway_startup_diag("serve_failed", Some(addr), Some(&err.to_string()));
                return Err(anyhow::Error::from(err));
            }
            Err(err) => {
                let detail = err.to_string();
                write_gateway_startup_diag("serve_failed", diag_addr, Some(&detail));
                return Err(anyhow::Error::msg(detail));
            }
        }
    }
    Ok(())
}

#[cfg(windows)]
pub(crate) fn ensure_runtime_gateway_listener_bindings(
    state: GatewayState,
    addrs: &[SocketAddr],
) -> anyhow::Result<Vec<SocketAddr>> {
    let mut pending = Vec::new();
    let mut newly_bound = Vec::new();
    {
        let bound_listener_addrs = runtime_bound_listener_addrs().lock();
        for addr in addrs {
            if bound_listener_addrs.contains(addr) {
                continue;
            }
            let listener = match std::net::TcpListener::bind(addr) {
                Ok(listener) => listener,
                Err(err) => {
                    state.gateway_event_optional_overlay_bind_skip(*addr, &err.to_string());
                    continue;
                }
            };
            listener.set_nonblocking(true)?;
            pending.push((*addr, listener));
        }
    }

    if pending.is_empty() {
        return Ok(Vec::new());
    }

    write_gateway_startup_diag(
        "runtime_listener_bound",
        pending.first().map(|(addr, _)| *addr),
        Some(
            &pending
                .iter()
                .map(|(addr, _)| addr.to_string())
                .collect::<Vec<_>>()
                .join(", "),
        ),
    );
    let app = build_router(state.clone());
    for (addr, listener) in pending {
        let listener = tokio::net::TcpListener::from_std(listener)?;
        runtime_bound_listener_addrs().lock().insert(addr);
        newly_bound.push(addr);
        let app_for_addr = app.clone();
        let state_for_addr = state.clone();
        tauri::async_runtime::spawn(async move {
            let result = axum::serve(
                listener,
                app_for_addr.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await;
            runtime_bound_listener_addrs().lock().remove(&addr);
            if let Err(err) = result {
                write_gateway_startup_diag(
                    "runtime_listener_failed",
                    Some(addr),
                    Some(&err.to_string()),
                );
                state_for_addr.store.add_event(
                    "gateway",
                    "warning",
                    "gateway.runtime_listener_failed",
                    &format!("runtime gateway listener exited on {addr}: {err}"),
                    json!({ "listen_addr": addr.to_string() }),
                );
            }
        });
    }

    Ok(newly_bound)
}

#[cfg(windows)]
trait GatewayRuntimeListenerEventExt {
    fn gateway_event_optional_overlay_bind_skip(&self, addr: SocketAddr, detail: &str);
}

#[cfg(windows)]
impl GatewayRuntimeListenerEventExt for GatewayState {
    fn gateway_event_optional_overlay_bind_skip(&self, addr: SocketAddr, detail: &str) {
        write_gateway_startup_diag("runtime_listener_skipped", Some(addr), Some(detail));
        self.store.add_event(
            "gateway",
            "info",
            "gateway.runtime_listener_skipped",
            &format!("Skipped runtime gateway listener bind for {addr}: {detail}"),
            json!({ "listen_addr": addr.to_string(), "detail": detail }),
        );
    }
}

include!("gateway/store_recovery.rs");
include!("gateway/routing_and_status.rs");
async fn responses(
    PeerAddr(peer): PeerAddr,
    State(st): State<GatewayState>,
    headers: HeaderMap,
    LoggedJson(body): LoggedJson<Value>,
) -> Response {
    if let Some(resp) = require_gateway_auth(&st, &headers) {
        return resp;
    }
    st.last_activity_unix_ms.store(unix_ms(), Ordering::Relaxed);
    let cfg = st.cfg.read().clone();
    let client_auth = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok());
    let client_auth = upstream_auth(&st, client_auth);

    let want_stream = body
        .get("stream")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let codex_session_id = codex_session_id_from_request(&headers, &body);
    let requested_model = body
        .get("model")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(|v| v.to_string());
    let session_key = codex_session_id
        .as_deref()
        .map(|s| s.to_string())
        .unwrap_or_else(|| format!("peer:{peer}"));
    let client_session = windows_terminal::infer_wt_session(peer, cfg.listen.port);
    let request_base_url = request_base_url_hint(&headers, cfg.listen.port);
    let request_origin = usage_origin_from_base_url(request_base_url.as_deref());
    let request_is_wsl = request_origin == crate::constants::USAGE_ORIGIN_WSL2;
    let inferred_wt_marker = client_session.as_ref().map(|s| {
        let wt = s
            .wt_session
            .trim()
            .trim_start_matches("wsl:")
            .trim_start_matches("WSL:")
            .trim();
        if request_is_wsl {
            format!("wsl:{wt}")
        } else {
            wt.to_string()
        }
    });
    let agent_request = request_is_agent(&headers, &body);
    let review_request = request_is_review(&headers, &body);
    let agent_parent_session_id = body_agent_parent_session_id(&body);
    let routing_session_fields = {
        let wt = inferred_wt_marker.clone();
        let pid = client_session.as_ref().map(|s| s.pid);
        // Prefer the human-facing codex session id if present; fall back to session key.
        let codex = (!session_key.starts_with("peer:")).then_some(session_key.clone());
        json!({
            "wt_session": wt,
            "pid": pid,
            "codex_session_id": codex,
            "is_agent": agent_request,
        })
    };
    // Record requests against the canonical Codex session identity (from headers/body), not WT_SESSION.
    // WT_SESSION is window-scoped and can be shared across tabs; additionally, some network calls may
    // be owned by helper processes.
    if !session_key.starts_with("peer:") {
        let now_unix_ms = unix_ms();
        let is_review_session = review_request;
        let mut map = st.client_sessions.write();
        let entry = map
            .entry(session_key.clone())
            .or_insert_with(|| ClientSessionRuntime {
                codex_session_id: session_key.clone(),
                pid: if is_review_session {
                    0
                } else {
                    client_session.as_ref().map(|s| s.pid).unwrap_or(0)
                },
                wt_session: if is_review_session {
                    None
                } else {
                    inferred_wt_marker
                        .as_deref()
                        .and_then(|wt| windows_terminal::merge_wt_session_marker(None, wt))
                },
                last_request_unix_ms: 0,
                last_discovered_unix_ms: 0,
                last_reported_model_provider: None,
                last_reported_model: None,
                last_reported_base_url: None,
                agent_parent_session_id: None,
                is_agent: agent_request || client_session.as_ref().is_some_and(|s| s.is_agent),
                is_review: false,
                confirmed_router: true,
            });
        if is_review_session {
            entry.pid = 0;
            entry.wt_session = None;
        } else if let Some(inferred) = client_session.as_ref() {
            entry.pid = inferred.pid;
            if let Some(observed_wt) = inferred_wt_marker.as_deref() {
                entry.wt_session = windows_terminal::merge_wt_session_marker(
                    entry.wt_session.as_deref(),
                    observed_wt,
                );
            }
        }
        if let Some(inferred) = client_session.as_ref() {
            if inferred.is_agent {
                entry.is_agent = true;
            }
            if inferred.is_review {
                entry.is_review = true;
            }
        }
        if request_is_wsl && !is_review_session {
            if let Some(existing_wt) = entry.wt_session.as_deref() {
                let forced_wsl = format!(
                    "wsl:{}",
                    existing_wt
                        .trim()
                        .trim_start_matches("wsl:")
                        .trim_start_matches("WSL:")
                        .trim()
                );
                entry.wt_session = windows_terminal::merge_wt_session_marker(
                    entry.wt_session.as_deref(),
                    &forced_wsl,
                );
            }
        }
        if agent_request {
            entry.is_agent = true;
        }
        if review_request {
            entry.is_review = true;
            entry.is_agent = true;
        }
        if let Some(parent_sid) = agent_parent_session_id.as_deref() {
            entry.agent_parent_session_id = Some(parent_sid.to_string());
        }
        if let Some(base_url) = request_base_url.as_deref() {
            entry.last_reported_base_url = Some(base_url.to_string());
        }
        // Keep codex provider deterministic once the session is proven to route through gateway.
        entry.last_reported_model_provider = Some(GATEWAY_MODEL_PROVIDER_ID.to_string());
        entry.last_request_unix_ms = now_unix_ms;
        entry.confirmed_router = true;

        if let Some(parent_sid) = agent_parent_session_id.as_deref() {
            if parent_sid != session_key {
                let parent_entry =
                    map.entry(parent_sid.to_string())
                        .or_insert_with(|| ClientSessionRuntime {
                            codex_session_id: parent_sid.to_string(),
                            pid: client_session.as_ref().map(|s| s.pid).unwrap_or(0),
                            wt_session: inferred_wt_marker
                                .as_deref()
                                .and_then(|wt| windows_terminal::merge_wt_session_marker(None, wt)),
                            last_request_unix_ms: 0,
                            last_discovered_unix_ms: now_unix_ms,
                            last_reported_model_provider: Some(
                                GATEWAY_MODEL_PROVIDER_ID.to_string(),
                            ),
                            last_reported_model: None,
                            last_reported_base_url: None,
                            agent_parent_session_id: None,
                            is_agent: false,
                            is_review: false,
                            confirmed_router: true,
                        });
                if let Some(inferred) = client_session.as_ref() {
                    if inferred.pid != 0 {
                        parent_entry.pid = inferred.pid;
                    }
                }
                if let Some(observed_wt) = inferred_wt_marker.as_deref() {
                    parent_entry.wt_session = windows_terminal::merge_wt_session_marker(
                        parent_entry.wt_session.as_deref(),
                        observed_wt,
                    );
                }
                if let Some(base_url) = request_base_url.as_deref() {
                    parent_entry.last_reported_base_url = Some(base_url.to_string());
                }
                parent_entry.last_discovered_unix_ms =
                    parent_entry.last_discovered_unix_ms.max(now_unix_ms);
                parent_entry.last_reported_model_provider =
                    Some(GATEWAY_MODEL_PROVIDER_ID.to_string());
                parent_entry.confirmed_router = true;
            }
        }
    }

    let previous_response_id = body
        .get("previous_response_id")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let base_body = body.clone();

    // Build messages from the current input only; Codex maintains session history.
    let mut messages: Vec<Value> = Vec::new();
    let input = body.get("input").cloned().unwrap_or(Value::Null);
    let input_has_tools = input_contains_tools(&input);
    let has_prev = previous_response_id.is_some();
    messages.extend(input_to_messages(&input));
    let current_items = input_to_items_preserve_tools(&input);

    if has_prev {
        let summary = summarize_input_for_debug(&input);
        st.store.add_event(
            "gateway",
            "debug",
            "gateway.previous_response_id_present",
            &format!("previous_response_id present (tools={input_has_tools}); input={summary}"),
            json!({ "tools": input_has_tools }),
        );
    }

    // Try providers in order: chosen, then fallbacks.
    let mut tried = Vec::new();
    let mut last_err = String::new();
    let mut usage_refreshed_after_first_failure = false;

    let mut session_messages: Option<Vec<Value>> = None;
    for _ in 0..cfg.providers.len().max(1) {
        let is_first_attempt = tried.is_empty();
        let preferred = cfg
            .routing
            .session_preferred_providers
            .get(&session_key)
            .filter(|p| cfg.providers.contains_key(*p))
            .map(|s| s.as_str())
            .unwrap_or(cfg.routing.preferred_provider.as_str());
        let (provider_name, reason) = decide_provider(&st, &cfg, preferred, &session_key);
        if tried.contains(&provider_name) {
            break;
        }
        tried.push(provider_name.clone());
        let p = match cfg.providers.get(&provider_name) {
            Some(p) => p.clone(),
            None => break,
        };
        let mut provider_supports_prev = st
            .prev_id_support_cache
            .read()
            .get(&provider_name)
            .cloned()
            .unwrap_or(true);
        let timeout = cfg.routing.request_timeout_seconds;

        for _ in 0..2 {
            let switching_provider = has_prev && !is_first_attempt;
            let use_prev_id = has_prev && provider_supports_prev && !switching_provider;

            let mut body_for_provider = base_body.clone();
            scrub_session_id_aliases_from_body(&mut body_for_provider);
            if !use_prev_id {
                body_for_provider
                    .as_object_mut()
                    .map(|m| m.remove("previous_response_id"));
            }
            let input_value = if switching_provider || !use_prev_id {
                if !has_prev {
                    // No previous response id to reconstruct; pass only the current input.
                    Value::Array(current_items.clone())
                } else {
                    let Some(session_id) = codex_session_id.as_deref() else {
                        return (
                            StatusCode::BAD_REQUEST,
                            Json(json!({
                                "error": {
                                    "message": "missing codex session id for session history",
                                    "type": "invalid_request_error"
                                }
                            })),
                        )
                            .into_response();
                    };
                    if session_messages.is_none() {
                        let initial_messages = load_codex_session_messages(session_id);
                        // Codex may flush session jsonl slightly after the previous response is visible.
                        // Only on provider-switch path, retry once when the snapshot looks
                        // empty/incomplete to reduce stale-history reuse without adding
                        // latency on first-attempt request paths.
                        let should_retry = if switching_provider {
                            match initial_messages.as_deref() {
                                None => true,
                                Some(items) => session_history_snapshot_looks_incomplete(items),
                            }
                        } else {
                            false
                        };
                        let retried_messages = if should_retry {
                            tokio::time::sleep(std::time::Duration::from_millis(
                                SESSION_HISTORY_FLUSH_RETRY_DELAY_MS,
                            ))
                            .await;
                            load_codex_session_messages(session_id)
                        } else {
                            None
                        };
                        session_messages =
                            prefer_newer_session_messages(initial_messages, retried_messages);
                    }
                    let Some(mut items) = session_messages.clone() else {
                        return (
                            StatusCode::BAD_REQUEST,
                            Json(json!({
                                "error": {
                                    "message": "missing codex session history for session_id",
                                    "type": "invalid_request_error"
                                }
                            })),
                        )
                            .into_response();
                    };
                    if !ends_with_items(&items, &current_items) {
                        items.extend(current_items.clone());
                    }
                    Value::Array(items)
                }
            } else if has_prev || input_has_tools {
                input.clone()
            } else if prefers_simple_input_list(&p.base_url) {
                messages_to_simple_input_list(&messages)
            } else {
                messages_to_responses_input(&messages)
            };
            body_for_provider
                .as_object_mut()
                .map(|m| m.insert("input".to_string(), input_value));

            // Stream mode (best-effort): if upstream supports Responses streaming, we pass it through
            // and tap the stream to persist the final response for continuity.
            if want_stream {
                body_for_provider
                    .as_object_mut()
                    .map(|m| m.insert("stream".to_string(), Value::Bool(true)));
                let api_key = st.secrets.get_provider_key(&provider_name);
                let mut should_fallback_to_non_stream = false;
                for attempt in 1..=TRANSIENT_UPSTREAM_RETRY_ATTEMPTS {
                    match st
                        .upstream
                        .post_sse(
                            &p,
                            "/v1/responses",
                            &body_for_provider,
                            api_key.as_deref(),
                            client_auth,
                            timeout,
                        )
                        .await
                    {
                        Ok(resp) if resp.status().is_success() => {
                            let prev = st.last_used_by_session.read().get(&session_key).cloned();
                            st.last_used_by_session.write().insert(
                                session_key.clone(),
                                LastUsedRoute {
                                    provider: provider_name.clone(),
                                    reason: reason.to_string(),
                                    preferred: preferred.to_string(),
                                    unix_ms: unix_ms(),
                                },
                            );
                            st.router.mark_success(&provider_name, unix_ms());
                            if should_log_routing_path_event(
                                prev.as_ref(),
                                &provider_name,
                                reason,
                                preferred,
                                is_first_attempt,
                            ) {
                                st.store.add_event(
                                    &provider_name,
                                    "info",
                                    "routing.stream",
                                    &format!("Streaming via {provider_name} ({reason})"),
                                    json!({
                                        "provider": provider_name,
                                        "reason": reason,
                                        "wt_session": routing_session_fields.get("wt_session").cloned().unwrap_or(Value::Null),
                                        "pid": routing_session_fields.get("pid").cloned().unwrap_or(Value::Null),
                                        "codex_session_id": routing_session_fields.get("codex_session_id").cloned().unwrap_or(Value::Null),
                                    }),
                                );
                            } else if is_back_to_preferred_transition(
                                prev.as_ref(),
                                &provider_name,
                                preferred,
                            ) {
                                st.store.add_event(
                                    &provider_name,
                                    "info",
                                    "routing.back_to_preferred",
                                    &format!(
                                        "Back to preferred: {provider_name} (from {})",
                                        prev.as_ref()
                                            .map(|p| p.provider.as_str())
                                            .unwrap_or("unknown")
                                    ),
                                    json!({
                                        "provider": provider_name,
                                        "from_provider": prev.as_ref().map(|p| p.provider.clone()),
                                        "from_reason": prev.as_ref().map(|p| p.reason.clone()),
                                        "from_preferred": prev.as_ref().map(|p| p.preferred.clone()),
                                        "preferred": preferred,
                                        "wt_session": routing_session_fields.get("wt_session").cloned().unwrap_or(Value::Null),
                                        "pid": routing_session_fields.get("pid").cloned().unwrap_or(Value::Null),
                                        "codex_session_id": routing_session_fields.get("codex_session_id").cloned().unwrap_or(Value::Null),
                                    }),
                                );
                            }
                            return passthrough_sse_and_persist(
                                resp,
                                st.clone(),
                                provider_name,
                                timeout,
                                SsePersistContext {
                                    api_key_ref: api_key_ref_from_raw(api_key.as_deref()),
                                    session_key: session_key.clone(),
                                    requested_model: requested_model.clone(),
                                    request_origin: request_origin.to_string(),
                                },
                            );
                        }
                        Ok(resp) => {
                            let code = resp.status().as_u16();
                            let txt = resp.text().await.unwrap_or_default();
                            if use_prev_id && is_prev_id_unsupported_error(&txt) {
                                provider_supports_prev = false;
                                st.prev_id_support_cache
                                    .write()
                                    .insert(provider_name.clone(), false);
                                st.store.add_event(
                                    &provider_name,
                                    "info",
                                    "gateway.retry_without_prev_id",
                                    "retrying without previous_response_id",
                                    Value::Null,
                                );
                                continue;
                            }
                            let can_retry = attempt < TRANSIENT_UPSTREAM_RETRY_ATTEMPTS
                                && is_retryable_upstream_status(code);
                            let can_fallback =
                                should_fallback_stream_response_to_non_stream(code, &txt);
                            if can_retry {
                                log_upstream_retry_event(
                                    &st,
                                    &provider_name,
                                    "http_status",
                                    &format!(
                                        "retrying upstream stream after http {code} from {provider_name}"
                                    ),
                                    attempt,
                                    TRANSIENT_UPSTREAM_RETRY_ATTEMPTS,
                                    true,
                                );
                                tokio::time::sleep(std::time::Duration::from_millis(
                                    TRANSIENT_UPSTREAM_RETRY_DELAY_MS,
                                ))
                                .await;
                                continue;
                            }
                            if can_fallback {
                                should_fallback_to_non_stream = true;
                                last_err = format!(
                                    "upstream {provider_name} returned {code} (responses stream): {txt}"
                                );
                                st.store.add_event(
                                    &provider_name,
                                    "warning",
                                    "gateway.stream_fallback_to_non_stream",
                                    "streaming failed; retrying once with non-stream responses",
                                    json!({
                                        "http_status": code,
                                        "endpoint": "/v1/responses",
                                        "stream": true
                                    }),
                                );
                                st.router.mark_transient_warning(
                                    &provider_name,
                                    &cfg,
                                    &last_err,
                                    unix_ms(),
                                );
                                break;
                            }
                            last_err = format!(
                                "upstream {provider_name} returned {code} (responses stream): {txt}"
                            );
                            st.router
                                .mark_failure(&provider_name, &cfg, &last_err, unix_ms());
                            st.store.add_event(
                                &provider_name,
                                "error",
                                "upstream.http_error",
                                &last_err,
                                json!({
                                    "http_status": code,
                                    "endpoint": "/v1/responses",
                                    "stream": true
                                }),
                            );
                            refresh_usage_once_after_first_failure(
                                &st,
                                &provider_name,
                                &mut usage_refreshed_after_first_failure,
                            )
                            .await;
                            break;
                        }
                        Err(e) => {
                            let can_retry = attempt < TRANSIENT_UPSTREAM_RETRY_ATTEMPTS
                                && should_retry_upstream_request_error(&e);
                            if can_retry {
                                log_upstream_retry_event(
                                    &st,
                                    &provider_name,
                                    "request_error",
                                    &format!(
                                        "retrying upstream stream after request error from {provider_name}: {e}"
                                    ),
                                    attempt,
                                    TRANSIENT_UPSTREAM_RETRY_ATTEMPTS,
                                    true,
                                );
                                tokio::time::sleep(std::time::Duration::from_millis(
                                    TRANSIENT_UPSTREAM_RETRY_DELAY_MS,
                                ))
                                .await;
                                continue;
                            }
                            if should_retry_upstream_request_error(&e) {
                                should_fallback_to_non_stream = true;
                                last_err = format!(
                                    "upstream {provider_name} error (responses stream): {e}"
                                );
                                st.store.add_event(
                                    &provider_name,
                                    "warning",
                                    "gateway.stream_fallback_to_non_stream",
                                    "streaming request failed; retrying once with non-stream responses",
                                    json!({ "endpoint": "/v1/responses", "stream": true }),
                                );
                                st.router.mark_transient_warning(
                                    &provider_name,
                                    &cfg,
                                    &last_err,
                                    unix_ms(),
                                );
                                break;
                            }
                            last_err =
                                format!("upstream {provider_name} error (responses stream): {e}");
                            st.router
                                .mark_failure(&provider_name, &cfg, &last_err, unix_ms());
                            st.store.add_event(
                                &provider_name,
                                "error",
                                "upstream.request_error",
                                &last_err,
                                json!({ "endpoint": "/v1/responses", "stream": true }),
                            );
                            refresh_usage_once_after_first_failure(
                                &st,
                                &provider_name,
                                &mut usage_refreshed_after_first_failure,
                            )
                            .await;
                            break;
                        }
                    }
                }
                if !should_fallback_to_non_stream && !last_err.is_empty() {
                    break;
                }
            }

            // Non-stream mode: call upstream without streaming.
            body_for_provider
                .as_object_mut()
                .map(|m| m.insert("stream".to_string(), Value::Bool(false)));

            let api_key = st.secrets.get_provider_key(&provider_name);
            let mut upstream_result = None;
            for attempt in 1..=TRANSIENT_UPSTREAM_RETRY_ATTEMPTS {
                let result = st
                    .upstream
                    .post_json(
                        &p,
                        "/v1/responses",
                        &body_for_provider,
                        api_key.as_deref(),
                        client_auth,
                        timeout,
                    )
                    .await;
                let should_retry = match &result {
                    Ok((code, _)) => {
                        is_retryable_upstream_status(*code)
                            && attempt < TRANSIENT_UPSTREAM_RETRY_ATTEMPTS
                    }
                    Err(e) => {
                        should_retry_upstream_request_error(e)
                            && attempt < TRANSIENT_UPSTREAM_RETRY_ATTEMPTS
                    }
                };
                if should_retry {
                    let detail = match &result {
                        Ok((code, _)) => format!(
                            "retrying upstream non-stream after http {code} from {provider_name}"
                        ),
                        Err(e) => format!(
                            "retrying upstream non-stream after request error from {provider_name}: {e}"
                        ),
                    };
                    let kind = if result.is_ok() {
                        "http_status"
                    } else {
                        "request_error"
                    };
                    log_upstream_retry_event(
                        &st,
                        &provider_name,
                        kind,
                        &detail,
                        attempt,
                        TRANSIENT_UPSTREAM_RETRY_ATTEMPTS,
                        false,
                    );
                    tokio::time::sleep(std::time::Duration::from_millis(
                        TRANSIENT_UPSTREAM_RETRY_DELAY_MS,
                    ))
                    .await;
                    continue;
                }
                upstream_result = Some(result);
                break;
            }

            match upstream_result.expect("non-stream attempt result") {
                Ok((code, upstream_json)) if (200..300).contains(&code) => {
                    let prev = st.last_used_by_session.read().get(&session_key).cloned();
                    st.last_used_by_session.write().insert(
                        session_key.clone(),
                        LastUsedRoute {
                            provider: provider_name.clone(),
                            reason: reason.to_string(),
                            preferred: preferred.to_string(),
                            unix_ms: unix_ms(),
                        },
                    );
                    st.router.mark_success(&provider_name, unix_ms());

                    // Keep the upstream response object (and id) so the client can continue the chain.
                    let response_id = upstream_json
                        .get("id")
                        .and_then(|v| v.as_str())
                        .unwrap_or("resp_unknown")
                        .to_string();
                    let text = extract_text_from_responses(&upstream_json);
                    let response_obj = upstream_json;
                    if let Some(response_model) = extract_response_model_option(&response_obj) {
                        update_session_response_model(&st, &session_key, &response_model);
                        maybe_record_model_mismatch(
                            &st,
                            &provider_name,
                            &session_key,
                            requested_model.as_deref(),
                            &response_model,
                            false,
                        );
                    }
                    let api_key_ref = api_key_ref_from_raw(api_key.as_deref());
                    let local_node = st.secrets.get_lan_node_identity();

                    // Persist the exchange so we can keep continuity if provider changes later.
                    st.store.record_success(
                        &provider_name,
                        &response_obj,
                        crate::orchestrator::store::UsageRequestContext {
                            api_key_ref: Some(&api_key_ref),
                            origin: request_origin,
                            session_id: Some(session_key.as_str()),
                            node_id: local_node.as_ref().map(|value| value.node_id.as_str()),
                            node_name: local_node.as_ref().map(|value| value.node_name.as_str()),
                        },
                    );

                    // Avoid spamming the event log for routine successful requests; only surface
                    // interesting routing outcomes (failover / non-preferred).
                    if should_log_routing_path_event(
                        prev.as_ref(),
                        &provider_name,
                        reason,
                        preferred,
                        is_first_attempt,
                    ) {
                        st.store.add_event(
                            &provider_name,
                            "info",
                            "routing.route",
                            &format!("Routed via {provider_name} ({reason})"),
                            json!({
                                "provider": provider_name,
                                "reason": reason,
                                "wt_session": routing_session_fields.get("wt_session").cloned().unwrap_or(Value::Null),
                                "pid": routing_session_fields.get("pid").cloned().unwrap_or(Value::Null),
                                "codex_session_id": routing_session_fields.get("codex_session_id").cloned().unwrap_or(Value::Null),
                            }),
                        );
                    } else if is_back_to_preferred_transition(
                        prev.as_ref(),
                        &provider_name,
                        preferred,
                    ) {
                        st.store.add_event(
                            &provider_name,
                            "info",
                            "routing.back_to_preferred",
                            &format!(
                                "Back to preferred: {provider_name} (from {})",
                                prev.as_ref()
                                    .map(|p| p.provider.as_str())
                                    .unwrap_or("unknown")
                            ),
                            json!({
                                "provider": provider_name,
                                "from_provider": prev.as_ref().map(|p| p.provider.clone()),
                                "from_reason": prev.as_ref().map(|p| p.reason.clone()),
                                "from_preferred": prev.as_ref().map(|p| p.preferred.clone()),
                                "preferred": preferred,
                                "wt_session": routing_session_fields.get("wt_session").cloned().unwrap_or(Value::Null),
                                "pid": routing_session_fields.get("pid").cloned().unwrap_or(Value::Null),
                                "codex_session_id": routing_session_fields.get("codex_session_id").cloned().unwrap_or(Value::Null),
                            }),
                        );
                    }

                    if want_stream {
                        // If the client asked for stream but upstream call was non-streaming, simulate SSE.
                        return sse_response(&response_id, &response_obj, &text);
                    }
                    return (StatusCode::OK, Json(response_obj)).into_response();
                }
                Ok((code, upstream_json)) => {
                    let msg = upstream_json.to_string();
                    if use_prev_id && is_prev_id_unsupported_error(&msg) {
                        provider_supports_prev = false;
                        st.prev_id_support_cache
                            .write()
                            .insert(provider_name.clone(), false);
                        st.store.add_event(
                            &provider_name,
                            "info",
                            "gateway.retry_without_prev_id",
                            "retrying without previous_response_id",
                            Value::Null,
                        );
                        continue;
                    }
                    last_err = format!("upstream {provider_name} returned {code}: {msg}");
                    st.router
                        .mark_failure(&provider_name, &cfg, &last_err, unix_ms());
                    st.store.record_failure(&provider_name);
                    st.store.add_event(
                        &provider_name,
                        "error",
                        "upstream.http_error",
                        &last_err,
                        json!({ "http_status": code, "endpoint": "/v1/responses", "stream": false }),
                    );
                    refresh_usage_once_after_first_failure(
                        &st,
                        &provider_name,
                        &mut usage_refreshed_after_first_failure,
                    )
                    .await;
                    break;
                }
                Err(e) => {
                    last_err = format!("upstream {provider_name} error: {e}");
                    st.router
                        .mark_failure(&provider_name, &cfg, &last_err, unix_ms());
                    st.store.record_failure(&provider_name);
                    st.store.add_event(
                        &provider_name,
                        "error",
                        "upstream.request_error",
                        &last_err,
                        json!({ "endpoint": "/v1/responses", "stream": false }),
                    );
                    refresh_usage_once_after_first_failure(
                        &st,
                        &provider_name,
                        &mut usage_refreshed_after_first_failure,
                    )
                    .await;
                    break;
                }
            }
        }
    }

    (
        StatusCode::BAD_GATEWAY,
        Json(json!({
            "error": {
                "message": if last_err.is_empty() { "all providers failed" } else { &last_err },
                "type": "gateway_error"
            }
        })),
    )
        .into_response()
}

include!("gateway/response_io.rs");
