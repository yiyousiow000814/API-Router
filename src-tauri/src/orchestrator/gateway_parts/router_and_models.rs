use std::collections::HashMap;
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
use axum::routing::{get, post};
use axum::Router;
use bytes::Bytes;
use parking_lot::RwLock;
use serde_json::{json, Value};

use super::config::AppConfig;
use super::openai::{
    extract_text_from_responses, input_to_items_preserve_tools, input_to_messages,
    messages_to_responses_input, messages_to_simple_input_list, sse_events_for_text,
};
use super::router::RouterState;
use super::secrets::SecretStore;
use super::store::{unix_ms, Store};
use super::upstream::UpstreamClient;
use crate::platform::windows_terminal;

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
    pub last_reported_base_url: Option<String>,
    // Sticky "this session uses our gateway" marker. This prevents sessions from disappearing if
    // the user edits Codex config files while Codex is running (the process keeps the old config
    // in memory, but we may no longer be able to prove it from disk).
    pub confirmed_router: bool,
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

pub(crate) fn build_router_with_body_limit(state: GatewayState, max_body_bytes: usize) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/status", get(status))
        .route("/v1/models", get(models))
        .route("/v1/responses", post(responses))
        .route("/responses", post(responses))
        .layer(DefaultBodyLimit::max(max_body_bytes))
        .with_state(state)
}

pub fn build_router(state: GatewayState) -> Router {
    // Codex can send large request bodies (context/tool outputs). Axum's default JSON body limit
    // is small and returns 413 before handlers run. We allow up to 512 MiB.
    const MAX_BODY_BYTES: usize = 512 * 1024 * 1024;
    build_router_with_body_limit(state, MAX_BODY_BYTES)
}

fn prefers_simple_input_list(base_url: &str) -> bool {
    let host = reqwest::Url::parse(base_url)
        .ok()
        .and_then(|u| u.host_str().map(|s| s.to_string()))
        .unwrap_or_default();
    host.ends_with("ppchat.vip")
        || host.ends_with("pumpkinai.vip")
        || host.ends_with("packycode.com")
}

fn input_contains_tools(input: &Value) -> bool {
    contains_tool_value(input)
}

fn summarize_input_for_debug(input: &Value) -> String {
    let mut s = serde_json::to_string(input).unwrap_or_else(|_| "<unserializable>".to_string());
    const LIMIT: usize = 400;
    if s.len() > LIMIT {
        s.truncate(LIMIT);
        s.push_str("...");
    }
    s
}

fn contains_tool_value(value: &Value) -> bool {
    match value {
        Value::Object(map) => {
            if let Some(Value::String(t)) = map.get("type") {
                if t.contains("tool") {
                    return true;
                }
            }
            for v in map.values() {
                if contains_tool_value(v) {
                    return true;
                }
            }
            false
        }
        Value::Array(items) => items.iter().any(contains_tool_value),
        _ => false,
    }
}

fn session_key_from_request(headers: &HeaderMap, body: &Value) -> Option<String> {
    let v = headers.get("session_id")?.to_str().ok()?;
    let v = v.trim();
    if v.is_empty() {
        return None;
    }
    let _ = body;
    Some(v.to_string())
}

fn codex_session_id_for_display(headers: &HeaderMap, body: &Value) -> Option<String> {
    for k in [
        "session_id",
        "x-session-id",
        "x-codex-session",
        "x-codex-session-id",
        "codex-session",
        "codex_session",
    ] {
        if let Some(v) = headers.get(k).and_then(|v| v.to_str().ok()) {
            let v = v.trim();
            if !v.is_empty() {
                return Some(v.to_string());
            }
        }
    }
    for k in [
        "session_id",
        "session",
        "codex_session_id",
        "codexSessionId",
    ] {
        if let Some(v) = body.get(k) {
            if let Some(s) = v.as_str() {
                let s = s.trim();
                if !s.is_empty() {
                    return Some(s.to_string());
                }
            }
        }
    }
    None
}

fn is_prev_id_unsupported_error(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    lower.contains("unsupported parameter: previous_response_id")
        || lower.contains("unsupported parameter: previous_response_id\"")
        || lower.contains("unsupported parameter: previous_response_id\\")
}

fn codex_home_dir() -> Option<PathBuf> {
    if let Ok(v) = std::env::var("CODEX_HOME") {
        if !v.trim().is_empty() {
            return Some(PathBuf::from(v));
        }
    }
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok()?;
    if home.trim().is_empty() {
        return None;
    }
    Some(PathBuf::from(home).join(".codex"))
}

fn find_codex_session_file_in(base: &Path, session_id: &str) -> Option<PathBuf> {
    let sessions_dir = base.join("sessions");
    if !sessions_dir.exists() {
        return None;
    }
    let mut stack = vec![sessions_dir];
    while let Some(dir) = stack.pop() {
        let entries = std::fs::read_dir(&dir).ok()?;
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                if name.contains(session_id) && name.ends_with(".jsonl") {
                    return Some(path);
                }
            }
        }
    }
    None
}

fn load_codex_session_messages_from_file(path: &PathBuf) -> Vec<Value> {
    let file = match File::open(path) {
        Ok(f) => f,
        Err(_) => return Vec::new(),
    };
    let reader = BufReader::new(file);
    let mut out = Vec::new();
    for line in reader.lines().map_while(Result::ok) {
        let Ok(v) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if v.get("type").and_then(|t| t.as_str()) != Some("response_item") {
            continue;
        }
        let Some(payload) = v.get("payload") else {
            continue;
        };
        if payload.get("type").and_then(|t| t.as_str()) != Some("message") {
            continue;
        }
        out.push(payload.clone());
    }
    out
}

fn load_codex_session_messages(session_id: &str) -> Option<Vec<Value>> {
    let base = codex_home_dir()?;
    let path = find_codex_session_file_in(&base, session_id)?;
    let items = load_codex_session_messages_from_file(&path);
    if items.is_empty() {
        return None;
    }
    Some(items)
}

fn ends_with_items(haystack: &[Value], needle: &[Value]) -> bool {
    if needle.is_empty() {
        return true;
    }
    if haystack.len() < needle.len() {
        return false;
    }
    let start = haystack.len() - needle.len();
    haystack[start..] == *needle
}

pub async fn serve_in_background(state: GatewayState) -> anyhow::Result<()> {
    let cfg = state.cfg.read().clone();
    let addr: SocketAddr = format!("{}:{}", cfg.listen.host, cfg.listen.port).parse()?;

    let app = build_router(state);
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await?;
    Ok(())
}

pub fn open_store_dir(base: PathBuf) -> anyhow::Result<Store> {
    std::fs::create_dir_all(&base)?;
    let path = base.join("sled");
    std::fs::create_dir_all(&path)?;
    // Best-effort maintenance: remove unexpected keys and optionally compact to prevent unbounded growth.
    // Runs before opening the DB to avoid Windows file locking issues.
    //
    // IMPORTANT: sled may panic if the on-disk database is corrupted (e.g. user manually deletes blobs).
    // Do not let that crash the whole app. If maintenance/open panics or errors, move the broken store
    // out of the way and recreate a fresh one.
    fn open_or_recover(path: &Path) -> anyhow::Result<Store> {
        let attempt = std::panic::catch_unwind(|| {
            if let Err(e) = super::store::maintain_store_dir(path) {
                log::warn!("store maintenance skipped: {e}");
            }
            Store::open(path)
        });

        match attempt {
            Ok(Ok(store)) => Ok(store),
            Ok(Err(e)) => {
                log::warn!("store open failed, recreating DB: {e}");
                let recovered = recover_store_dir(path);
                if let Err(e2) = recovered {
                    log::warn!("store recovery failed: {e2}");
                    return Err(e2);
                }
                reopen_after_recovery(path)
            }
            Err(_) => {
                log::warn!("store open panicked, recreating DB");
                let recovered = recover_store_dir(path);
                if let Err(e2) = recovered {
                    log::warn!("store recovery failed: {e2}");
                    return Err(e2);
                }
                reopen_after_recovery(path)
            }
        }
    }

    fn recover_store_dir(path: &Path) -> anyhow::Result<()> {
        // Move aside (best-effort) so we don't lose evidence for debugging,
        // and so file locks don't cause partial deletes.
        let parent = path.parent().unwrap_or_else(|| Path::new("."));
        let backup = parent.join(format!("sled.corrupt.{}", unix_ms()));
        if backup.exists() {
            let _ = std::fs::remove_dir_all(&backup);
        }
        if path.exists() {
            if let Err(e) = std::fs::rename(path, &backup) {
                // If rename fails (e.g. cross-device), fall back to delete.
                log::warn!(
                    "failed to move corrupted store to {}: {e}",
                    backup.display()
                );
                if let Err(e2) = std::fs::remove_dir_all(path) {
                    return Err(anyhow::anyhow!(
                        "failed to remove corrupted store dir: {e2}"
                    ));
                }
            }
        }
        std::fs::create_dir_all(path)?;
        Ok(())
    }

    fn reopen_after_recovery(path: &Path) -> anyhow::Result<Store> {
        // On Windows, file locks can make recovery partially fail in practice.
        // Be defensive and avoid crashing if sled panics again.
        let attempt = std::panic::catch_unwind(|| Store::open(path));
        match attempt {
            Ok(Ok(store)) => Ok(store),
            Ok(Err(e)) => Err(e.into()),
            Err(_) => Err(anyhow::anyhow!(
                "sled panicked when opening recovered store"
            )),
        }
    }

    open_or_recover(&path)
}

async fn health() -> impl IntoResponse {
    Json(json!({"ok": true}))
}

pub(crate) fn decide_provider(
    st: &GatewayState,
    cfg: &AppConfig,
    preferred: &str,
    session_key: &str,
) -> (String, &'static str) {
    // Manual override always wins (and is handled by RouterState).
    if st.router.manual_override.read().is_some() {
        return st.router.decide_with_preferred(cfg, preferred);
    }

    if cfg.routing.auto_return_to_preferred {
        let last_provider = st
            .last_used_by_session
            .read()
            .get(session_key)
            .map(|v| v.provider.clone());

        // If we recently failed over away from preferred, keep using the last successful
        // fallback for a short stabilization window to avoid flapping.
        if last_provider.as_deref().is_some_and(|p| p != preferred)
            && st
                .router
                .should_suppress_preferred(preferred, cfg, unix_ms())
        {
            if let Some(p) = last_provider {
                if st.router.is_provider_routable(&p) {
                    return (p, "preferred_stabilizing");
                }
            }
            return (st.router.fallback(cfg, preferred), "preferred_stabilizing");
        }
    }

    st.router.decide_with_preferred(cfg, preferred)
}

async fn status(State(st): State<GatewayState>) -> impl IntoResponse {
    let cfg = st.cfg.read().clone();
    let now = unix_ms();
    let providers = st.router.snapshot(now);
    let manual_override = st.router.manual_override.read().clone();

    let recent_events = st.store.list_events_split(5, 5);
    let metrics = st.store.get_metrics();
    let quota = st.store.list_quota_snapshots();
    let ledgers = st.store.list_ledgers();
    let last_activity = st.last_activity_unix_ms.load(Ordering::Relaxed);
    let active_recent = last_activity > 0 && now.saturating_sub(last_activity) < 2 * 60 * 1000;
    let (active_provider, active_reason) = if active_recent {
        let last = st
            .last_used_by_session
            .read()
            .values()
            .max_by_key(|v| v.unix_ms)
            .cloned();
        (
            last.as_ref().map(|v| v.provider.clone()),
            last.map(|v| v.reason),
        )
    } else {
        (None, None)
    };

    Json(json!({
        "listen": { "host": cfg.listen.host, "port": cfg.listen.port },
        "preferred_provider": cfg.routing.preferred_provider,
        "manual_override": manual_override,
        "providers": providers,
        "metrics": metrics,
        "recent_events": recent_events,
        "active_provider": active_provider,
        "active_reason": active_reason,
        "quota": quota,
        "ledgers": ledgers,
        "last_activity_unix_ms": last_activity
    }))
}

async fn models(
    PeerAddr(peer): PeerAddr,
    State(st): State<GatewayState>,
    headers: HeaderMap,
) -> impl IntoResponse {
    if let Some(resp) = require_gateway_auth(&st, &headers) {
        return resp;
    }
    st.last_activity_unix_ms.store(unix_ms(), Ordering::Relaxed);
    let cfg = st.cfg.read().clone();

    // Respect per-session preferred providers (keyed by Codex session id). Fall back to the global
    // preferred provider.
    let session_key = session_key_from_request(&headers, &Value::Null)
        .or_else(|| codex_session_id_for_display(&headers, &Value::Null))
        .unwrap_or_else(|| format!("peer:{peer}"));

    let preferred = cfg
        .routing
        .session_preferred_providers
        .get(&session_key)
        .filter(|p| cfg.providers.contains_key(*p))
        .map(|s| s.as_str())
        .unwrap_or(cfg.routing.preferred_provider.as_str());

    let (provider_name, _reason) = decide_provider(&st, &cfg, preferred, &session_key);
    let p = match cfg.providers.get(&provider_name) {
        Some(p) => p.clone(),
        None => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error":"no provider"})),
            )
                .into_response()
        }
    };

    let client_auth = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok());
    let api_key = st.secrets.get_provider_key(&provider_name);
    let client_auth = upstream_auth(&st, client_auth);

    // Do not update `client_sessions` for `/v1/models`.
    // Codex may call it opportunistically, and it may not carry a stable Codex session id.

    let timeout = cfg.routing.request_timeout_seconds;
    match st
        .upstream
        .get_json(&p, "/v1/models", api_key.as_deref(), client_auth, timeout)
        .await
    {
        Ok((code, j)) if (200..300).contains(&code) => {
            // Do not update `last_used_by_session` for `/v1/models` since Codex may call it
            // opportunistically. We only want to track actual routing decisions for user
            // requests (/v1/responses) to keep "back to preferred" semantics stable.
            st.router.mark_success(&provider_name, unix_ms());
            (StatusCode::OK, Json(j)).into_response()
        }
        _ => (StatusCode::OK, Json(json!({"object":"list","data":[]}))).into_response(),
    }
}

