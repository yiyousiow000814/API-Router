use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use axum::body::Body;
use axum::extract::{Json, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::Router;
use bytes::Bytes;
use parking_lot::RwLock;
use serde_json::{json, Value};

use super::config::AppConfig;
use super::openai::{
    extract_text_from_responses, input_to_messages, messages_to_plain_text,
    messages_to_responses_input, messages_to_simple_input_list, sse_events_for_text,
};
use super::router::RouterState;
use super::secrets::SecretStore;
use super::store::{unix_ms, Store};
use super::upstream::UpstreamClient;

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

pub async fn serve_in_background(state: GatewayState) -> anyhow::Result<()> {
    let cfg = state.cfg.read().clone();
    let addr: SocketAddr = format!("{}:{}", cfg.listen.host, cfg.listen.port).parse()?;

    let app = build_router(state);
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}

pub fn open_store_dir(base: PathBuf) -> anyhow::Result<Store> {
    std::fs::create_dir_all(&base)?;
    let path = base.join("sled");
    std::fs::create_dir_all(&path)?;
    Ok(Store::open(&path)?)
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

async fn models(State(st): State<GatewayState>, headers: HeaderMap) -> impl IntoResponse {
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
    headers: HeaderMap,
    Json(mut body): Json<Value>,
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

    let previous_response_id = body
        .get("previous_response_id")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    // Build server-side message history for continuity across upstreams.
    let mut messages: Vec<Value> = Vec::new();
    if let Some(prev) = previous_response_id.clone() {
        messages.extend(load_history_as_messages(&st, &prev));
    }
    let input = body.get("input").cloned().unwrap_or(Value::Null);
    messages.extend(input_to_messages(&input));

    // Try providers in order: chosen, then fallbacks.
    let mut tried = Vec::new();
    let mut last_err = String::new();

    for _ in 0..cfg.providers.len().max(1) {
        let (provider_name, reason) = st.router.decide(&cfg);
        if tried.contains(&provider_name) {
            break;
        }
        tried.push(provider_name.clone());
        let p = match cfg.providers.get(&provider_name) {
            Some(p) => p.clone(),
            None => break,
        };

        // Avoid upstream rejecting our server-side continuity ids.
        body.as_object_mut()
            .map(|m| m.remove("previous_response_id"));
        body.as_object_mut()
            .map(|m| {
                let input = if prefers_simple_input_list(&p.base_url) {
                    messages_to_simple_input_list(&messages)
                } else {
                    messages_to_responses_input(&messages)
                };
                m.insert("input".to_string(), input)
            });

        let timeout = cfg.routing.request_timeout_seconds;

        // Stream mode (best-effort): if upstream supports Responses streaming, we pass it through
        // and tap the stream to persist the final response for continuity.
        if want_stream {
            body.as_object_mut()
                .map(|m| m.insert("stream".to_string(), Value::Bool(true)));
            let api_key = st.secrets.get_provider_key(&provider_name);
            match st
                .upstream
                .post_sse(
                    &p,
                    "/v1/responses",
                    &body,
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
                        body.clone(),
                    );
                }
                Ok(resp) => {
                    let code = resp.status().as_u16();
                    let txt = resp.text().await.unwrap_or_default();
                    last_err = format!(
                        "upstream {provider_name} returned {code} (responses stream): {txt}"
                    );
                    st.router
                        .mark_failure(&provider_name, &cfg, &last_err, unix_ms());
                    st.store.add_event(&provider_name, "error", &last_err);
                    continue;
                }
                Err(e) => {
                    last_err = format!("upstream {provider_name} error (responses stream): {e}");
                    st.router
                        .mark_failure(&provider_name, &cfg, &last_err, unix_ms());
                    st.store.add_event(&provider_name, "error", &last_err);
                    continue;
                }
            }
        }

        // Non-stream mode: call upstream without streaming.
        body.as_object_mut()
            .map(|m| m.insert("stream".to_string(), Value::Bool(false)));

        let api_key = st.secrets.get_provider_key(&provider_name);
        let upstream_result = st
            .upstream
            .post_json(
                &p,
                "/v1/responses",
                &body,
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
                let _ = st.store.put_exchange(
                    &response_id,
                    previous_response_id.as_deref(),
                    &body,
                    &response_obj,
                );
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
                last_err = format!(
                    "upstream {provider_name} returned {code}: {}",
                    upstream_json
                );
                st.router
                    .mark_failure(&provider_name, &cfg, &last_err, unix_ms());
                st.store.record_failure(&provider_name);
                st.store.add_event(&provider_name, "error", &last_err);
            }
            Err(e) => {
                last_err = format!("upstream {provider_name} error: {e}");
                st.router
                    .mark_failure(&provider_name, &cfg, &last_err, unix_ms());
                st.store.record_failure(&provider_name);
                st.store.add_event(&provider_name, "error", &last_err);
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
        return Some((StatusCode::UNAUTHORIZED, Json(json!({"error":{"message":"invalid Authorization format","type":"unauthorized"}}))).into_response());
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
    parent_id: Option<String>,
    request_json: Value,
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
            let _ = st2.store.put_exchange(&rid, parent_id.as_deref(), &request_json, &resp_obj);
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

fn load_history_as_messages(st: &GatewayState, last_response_id: &str) -> Vec<Value> {
    let mut out = Vec::new();
    let mut cur = Some(last_response_id.to_string());
    let mut safety = 0;

    // Build chronological chain by collecting then reversing.
    let mut chain = Vec::new();
    while let Some(id) = cur {
        safety += 1;
        if safety > 200 {
            break;
        }
        if let Some(ex) = st.store.get_exchange(&id) {
            chain.push(ex);
            cur = st.store.get_parent(&id);
        } else {
            break;
        }
    }
    chain.reverse();

    for ex in chain {
        let req = ex.get("request").cloned().unwrap_or(Value::Null);
        let resp = ex.get("response").cloned().unwrap_or(Value::Null);

        if let Some(input) = req.get("input") {
            out.extend(input_to_messages(input));
        }
        let assistant = extract_text_from_responses(&resp);
        if !assistant.is_empty() {
            out.push(json!({"role":"assistant","content": assistant}));
        }
    }

    out
}
