use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use axum::body::Body;
use axum::extract::{ConnectInfo, Json, State};
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
use super::wt_session;

#[derive(Clone)]
pub struct GatewayState {
    pub cfg: Arc<RwLock<AppConfig>>,
    pub router: Arc<RouterState>,
    pub store: Store,
    pub upstream: UpstreamClient,
    pub secrets: SecretStore,
    pub last_activity_unix_ms: Arc<AtomicU64>,
    pub last_used_provider: Arc<RwLock<Option<String>>>,
    pub last_used_reason: Arc<RwLock<Option<String>>>,
    pub usage_base_speed_cache: Arc<RwLock<HashMap<String, UsageBaseSpeedCacheEntry>>>,
    pub prev_id_support_cache: Arc<RwLock<HashMap<String, bool>>>,
    pub client_sessions: Arc<RwLock<HashMap<String, ClientSessionRuntime>>>,
}

#[derive(Clone, Debug)]
pub struct ClientSessionRuntime {
    pub pid: u32,
    pub last_seen_unix_ms: u64,
    pub last_codex_session_id: Option<String>,
}

#[derive(Clone, Debug)]
pub struct UsageBaseSpeedCacheEntry {
    pub updated_at_unix_ms: u64,
    pub bases_key: Vec<String>,
    pub ordered_bases: Vec<String>,
}

pub fn build_router(state: GatewayState) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/status", get(status))
        .route("/v1/models", get(models))
        .route("/v1/responses", post(responses))
        .route("/responses", post(responses))
        .with_state(state)
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
        s.push('…');
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

async fn status(State(st): State<GatewayState>) -> impl IntoResponse {
    let cfg = st.cfg.read().clone();
    let now = unix_ms();
    let providers = st.router.snapshot(now);
    let manual_override = st.router.manual_override.read().clone();

    let recent_events = st.store.list_events(50);
    let metrics = st.store.get_metrics();
    let quota = st.store.list_quota_snapshots();
    let ledgers = st.store.list_ledgers();
    let last_activity = st.last_activity_unix_ms.load(Ordering::Relaxed);
    let active_recent = last_activity > 0 && now.saturating_sub(last_activity) < 2 * 60 * 1000;
    let active_provider = if active_recent {
        st.last_used_provider.read().clone()
    } else {
        None
    };
    let active_reason = if active_recent {
        st.last_used_reason.read().clone()
    } else {
        None
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
    State(st): State<GatewayState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> impl IntoResponse {
    if let Some(resp) = require_gateway_auth(&st, &headers) {
        return resp;
    }
    st.last_activity_unix_ms.store(unix_ms(), Ordering::Relaxed);
    let cfg = st.cfg.read().clone();
    let (provider_name, reason) = st.router.decide(&cfg);
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

    if let Some(inferred) = wt_session::infer_wt_session(peer, cfg.listen.port) {
        let mut map = st.client_sessions.write();
        map.insert(
            inferred.wt_session.clone(),
            ClientSessionRuntime {
                pid: inferred.pid,
                last_seen_unix_ms: unix_ms(),
                last_codex_session_id: None,
            },
        );
    }

    let timeout = cfg.routing.request_timeout_seconds;
    match st
        .upstream
        .get_json(&p, "/v1/models", api_key.as_deref(), client_auth, timeout)
        .await
    {
        Ok((code, j)) if (200..300).contains(&code) => {
            *st.last_used_provider.write() = Some(provider_name);
            *st.last_used_reason.write() = Some(reason.to_string());
            (StatusCode::OK, Json(j)).into_response()
        }
        _ => (StatusCode::OK, Json(json!({"object":"list","data":[]}))).into_response(),
    }
}

async fn responses(
    State(st): State<GatewayState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<Value>,
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

    let codex_session_key = session_key_from_request(&headers, &body);
    let codex_session_display = codex_session_id_for_display(&headers, &body);
    let client_session = wt_session::infer_wt_session(peer, cfg.listen.port);
    if let Some(inferred) = client_session.as_ref() {
        let mut map = st.client_sessions.write();
        let entry = map
            .entry(inferred.wt_session.clone())
            .or_insert(ClientSessionRuntime {
                pid: inferred.pid,
                last_seen_unix_ms: 0,
                last_codex_session_id: None,
            });
        entry.pid = inferred.pid;
        entry.last_seen_unix_ms = unix_ms();
        if let Some(cid) = codex_session_display
            .as_deref()
            .or(codex_session_key.as_deref())
        {
            entry.last_codex_session_id = Some(cid.to_string());
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
            &format!("previous_response_id present (tools={input_has_tools}); input={summary}"),
        );
    }

    // Try providers in order: chosen, then fallbacks.
    let mut tried = Vec::new();
    let mut last_err = String::new();

    let mut session_messages: Option<Vec<Value>> = None;
    for _ in 0..cfg.providers.len().max(1) {
        let is_first_attempt = tried.is_empty();
        let preferred = client_session
            .as_ref()
            .map(|s| s.wt_session.as_str())
            .and_then(|id| cfg.routing.session_preferred_providers.get(id))
            .filter(|p| cfg.providers.contains_key(*p))
            .map(|s| s.as_str())
            .unwrap_or(cfg.routing.preferred_provider.as_str());
        let (provider_name, reason) = st.router.decide_with_preferred(&cfg, preferred);
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
        let mut retried_without_prev = false;
        let timeout = cfg.routing.request_timeout_seconds;

        for _ in 0..2 {
            let switching_provider = has_prev && !is_first_attempt;
            let use_prev_id =
                has_prev && provider_supports_prev && !switching_provider && !retried_without_prev;

            let mut body_for_provider = base_body.clone();
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
                    let Some(session_id) = codex_session_key.as_deref() else {
                        return (
                            StatusCode::BAD_REQUEST,
                            Json(json!({
                                "error": {
                                    "message": "missing session_id header for codex session history",
                                    "type": "invalid_request_error"
                                }
                            })),
                        )
                            .into_response();
                    };
                    if session_messages.is_none() {
                        session_messages = load_codex_session_messages(session_id);
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
                        *st.last_used_provider.write() = Some(provider_name.clone());
                        *st.last_used_reason.write() = Some(reason.to_string());
                        st.router.mark_success(&provider_name, unix_ms());
                        st.store.add_event(
                            &provider_name,
                            "info",
                            &format!("stream via {provider_name} ({reason})"),
                        );
                        return passthrough_sse_and_persist(
                            resp,
                            st.clone(),
                            provider_name,
                            previous_response_id.clone(),
                            body_for_provider.clone(),
                            codex_session_key.clone(),
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
                                "retrying without previous_response_id",
                            );
                            retried_without_prev = true;
                            continue;
                        }
                        last_err = format!(
                            "upstream {provider_name} returned {code} (responses stream): {txt}"
                        );
                        st.router
                            .mark_failure(&provider_name, &cfg, &last_err, unix_ms());
                        st.store.add_event(&provider_name, "error", &last_err);
                        break;
                    }
                    Err(e) => {
                        last_err =
                            format!("upstream {provider_name} error (responses stream): {e}");
                        st.router
                            .mark_failure(&provider_name, &cfg, &last_err, unix_ms());
                        st.store.add_event(&provider_name, "error", &last_err);
                        break;
                    }
                }
            }

            // Non-stream mode: call upstream without streaming.
            body_for_provider
                .as_object_mut()
                .map(|m| m.insert("stream".to_string(), Value::Bool(false)));

            let api_key = st.secrets.get_provider_key(&provider_name);
            let upstream_result = st
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

            match upstream_result {
                Ok((code, upstream_json)) if (200..300).contains(&code) => {
                    *st.last_used_provider.write() = Some(provider_name.clone());
                    *st.last_used_reason.write() = Some(reason.to_string());
                    st.router.mark_success(&provider_name, unix_ms());

                    // Keep the upstream response object (and id) so the client can continue the chain.
                    let response_id = upstream_json
                        .get("id")
                        .and_then(|v| v.as_str())
                        .unwrap_or("resp_unknown")
                        .to_string();
                    let text = extract_text_from_responses(&upstream_json);
                    let response_obj = upstream_json;

                    // Persist the exchange so we can keep continuity if provider changes later.
                    st.store.record_success(&provider_name, &response_obj);

                    st.store.add_event(
                        &provider_name,
                        "info",
                        &format!("ok via {provider_name} ({reason})"),
                    );

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
                            "retrying without previous_response_id",
                        );
                        retried_without_prev = true;
                        continue;
                    }
                    last_err = format!("upstream {provider_name} returned {code}: {msg}");
                    st.router
                        .mark_failure(&provider_name, &cfg, &last_err, unix_ms());
                    st.store.record_failure(&provider_name);
                    st.store.add_event(&provider_name, "error", &last_err);
                    break;
                }
                Err(e) => {
                    last_err = format!("upstream {provider_name} error: {e}");
                    st.router
                        .mark_failure(&provider_name, &cfg, &last_err, unix_ms());
                    st.store.record_failure(&provider_name);
                    st.store.add_event(&provider_name, "error", &last_err);
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

fn sse_response(response_id: &str, response_obj: &Value, text: &str) -> Response {
    let events = sse_events_for_text(response_id, response_obj, text);
    let stream =
        futures_util::stream::iter(events.into_iter().map(Ok::<_, std::convert::Infallible>));
    let body = Body::from_stream(stream);

    let mut resp = Response::new(body);
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
    headers.insert(
        header::HeaderName::from_static("x-response-id"),
        header::HeaderValue::from_str(response_id).unwrap(),
    );
    resp
}

fn bearer_token(auth: &str) -> Option<&str> {
    let s = auth.trim();
    let prefix = "Bearer ";
    if s.len() > prefix.len() && s[..prefix.len()].eq_ignore_ascii_case(prefix) {
        return Some(s[prefix.len()..].trim());
    }
    None
}

fn require_gateway_auth(st: &GatewayState, headers: &HeaderMap) -> Option<Response> {
    let Some(expected) = st.secrets.get_gateway_token() else {
        // No token configured: allow for local dev.
        return None;
    };
    let expected = expected.trim();
    if expected.is_empty() {
        return None;
    }
    let Some(auth) = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
    else {
        return Some(
            (
                StatusCode::UNAUTHORIZED,
                Json(json!({"error": {"message":"missing Authorization (set OPENAI_API_KEY in .codex/auth.json to the gateway token)","type":"unauthorized"}})),
            )
                .into_response(),
        );
    };
    let Some(tok) = bearer_token(auth) else {
        return Some(
            (
                StatusCode::UNAUTHORIZED,
                Json(json!({"error":{"message":"invalid Authorization format","type":"unauthorized"}})),
            )
                .into_response(),
        );
    };
    if tok != expected {
        return Some(
            (
                StatusCode::UNAUTHORIZED,
                Json(json!({"error": {"message":"invalid gateway token","type":"unauthorized"}})),
            )
                .into_response(),
        );
    }
    None
}

fn upstream_auth<'a>(st: &GatewayState, client_auth: Option<&'a str>) -> Option<&'a str> {
    let auth = client_auth?;
    // Never forward the local gateway token upstream.
    if let (Some(tok), Some(b)) = (st.secrets.get_gateway_token(), bearer_token(auth)) {
        if !tok.trim().is_empty() && b == tok.trim() {
            return None;
        }
    }
    Some(auth)
}

fn passthrough_sse_and_persist(
    upstream_resp: reqwest::Response,
    st: GatewayState,
    provider_name: String,
    _parent_id: Option<String>,
    _request_json: Value,
    _session_key: Option<String>,
) -> Response {
    use futures_util::StreamExt;

    let tap = std::sync::Arc::new(parking_lot::Mutex::new(SseTap::new()));
    let tap2 = tap.clone();
    let st_err = st.clone();
    let provider_err = provider_name.clone();

    let bytes_stream = upstream_resp.bytes_stream().map(move |item| match item {
        Ok(b) => {
            tap2.lock().feed(&b);
            Ok::<Bytes, std::convert::Infallible>(b)
        }
        Err(e) => {
            st_err
                .store
                .add_event(&provider_err, "error", &format!("stream read error: {e}"));
            Ok::<Bytes, std::convert::Infallible>(Bytes::new())
        }
    });

    // Persist on drop isn't guaranteed; do it after stream completes by wrapping with async-stream.
    let st2 = st.clone();
    let provider2 = provider_name.clone();
    let tap3 = tap.clone();
    let stream = async_stream::stream! {
        futures_util::pin_mut!(bytes_stream);
        while let Some(item) = bytes_stream.next().await {
            yield item;
        }
        if let Some((rid, resp_obj)) = tap3.lock().take_completed() {
            st2.store.record_success(&provider2, &resp_obj);
            st2.store.add_event(&provider2, "info", &format!("persisted streamed response {rid}"));
        }
    };

    let body = Body::from_stream(stream);
    let mut resp = Response::new(body);
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

struct SseTap {
    buf: String,
    completed: Option<(String, Value)>,
}

impl SseTap {
    fn new() -> Self {
        Self {
            buf: String::new(),
            completed: None,
        }
    }

    fn feed(&mut self, chunk: &Bytes) {
        if self.completed.is_some() {
            return;
        }
        if let Ok(s) = std::str::from_utf8(chunk) {
            self.buf.push_str(s);
            while let Some(idx) = self.buf.find("\n\n") {
                let msg = self.buf[..idx].to_string();
                self.buf = self.buf[idx + 2..].to_string();
                self.consume_message(&msg);
                if self.completed.is_some() {
                    break;
                }
            }
        }
    }

    fn consume_message(&mut self, msg: &str) {
        for line in msg.lines() {
            let Some(rest) = line.strip_prefix("data:") else {
                continue;
            };
            let data = rest.trim();
            if data == "[DONE]" {
                return;
            }
            let Ok(v) = serde_json::from_str::<Value>(data) else {
                continue;
            };
            if v.get("type").and_then(|x| x.as_str()) == Some("response.completed") {
                if let Some(resp) = v.get("response") {
                    if let Some(id) = resp.get("id").and_then(|x| x.as_str()) {
                        self.completed = Some((id.to_string(), resp.clone()));
                        return;
                    }
                }
            }
        }
    }

    fn take_completed(&mut self) -> Option<(String, Value)> {
        self.completed.take()
    }
}
