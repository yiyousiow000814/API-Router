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

fn api_key_ref_from_raw(key: Option<&str>) -> String {
    let raw = key.unwrap_or("").trim();
    if raw.is_empty() {
        return "-".to_string();
    }
    let chars: Vec<char> = raw.chars().collect();
    if chars.len() < 10 {
        return "set".to_string();
    }
    let start_len = std::cmp::min(6, chars.len().saturating_sub(4));
    let start: String = chars.iter().take(start_len).collect();
    let end: String = chars
        .iter()
        .rev()
        .take(4)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    format!("{start}******{end}")
}

fn redact_url_for_logs(url: &reqwest::Url) -> String {
    // Avoid logging secrets in query strings. Keep only scheme://host[:port]/path.
    let scheme = url.scheme();
    let host = url.host_str().unwrap_or("<unknown>");
    let port = url.port().map(|p| format!(":{p}")).unwrap_or_default();
    format!("{scheme}://{host}{port}{}", url.path())
}

fn format_reqwest_error_for_logs(e: &reqwest::Error) -> String {
    let kind = if e.is_timeout() {
        "timeout"
    } else if e.is_connect() {
        "connect"
    } else {
        "request"
    };

    let mut parts: Vec<String> = vec![format!("request error ({kind})")];
    if let Some(url) = e.url() {
        parts.push(format!("url={}", redact_url_for_logs(url)));
    }

    // Try to include a couple root causes (often includes OS error codes / EOF / reset).
    let mut src: Option<&(dyn Error + 'static)> = e.source();
    let mut causes: Vec<String> = Vec::new();
    while let Some(err) = src {
        let s = err.to_string();
        if !s.is_empty() && !causes.contains(&s) {
            causes.push(s);
        }
        if causes.len() >= 2 {
            break;
        }
        src = err.source();
    }
    if !causes.is_empty() {
        parts.push(format!("cause={}", causes.join(" | ")));
    }
    parts.join("; ")
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
    api_key_ref: String,
    idle_timeout_seconds: u64,
    session_key: String,
    requested_model: Option<String>,
    request_origin: String,
) -> Response {
    use futures_util::StreamExt;

    let tap = std::sync::Arc::new(parking_lot::Mutex::new(SseTap::new()));
    let st_err = st.clone();
    let provider_err = provider_name.clone();

    let upstream_status = upstream_resp.status().as_u16();
    let upstream_url = upstream_resp.url().clone();
    let upstream_headers = upstream_resp.headers().clone();
    let mut bytes_stream = upstream_resp.bytes_stream();

    // Persist on drop isn't guaranteed; do it after stream completes.
    let st2 = st.clone();
    let provider2 = provider_name.clone();
    let api_key_ref2 = api_key_ref.clone();
    let session_key2 = session_key.clone();
    let requested_model2 = requested_model.clone();
    let request_origin2 = request_origin.clone();
    let tap3 = tap.clone();
    let stream = async_stream::stream! {
        let mut forwarded_bytes: u64 = 0;
        let mut mismatch_logged = false;
        let mut created_model_for_usage: Option<String> = None;
        loop {
            let item = match tokio::time::timeout(
                std::time::Duration::from_secs(idle_timeout_seconds),
                bytes_stream.next(),
            )
            .await
            {
                Ok(v) => v,
                Err(_) => {
                    let completed = tap.lock().is_completed();
                    let note = if completed {
                        "after completion"
                    } else {
                        "before completion; downstream output may be incomplete"
                    };
                    st_err.store.add_event(
                        &provider_err,
                        "error",
                        "stream.idle_timeout",
                        &format!(
                            "stream idle timeout ({note}); completed={completed}; forwarded_bytes={forwarded_bytes}; upstream_status={upstream_status}; url={}",
                            redact_url_for_logs(&upstream_url)
                        ),
                        json!({
                            "completed": completed,
                            "forwarded_bytes": forwarded_bytes,
                            "upstream_status": upstream_status,
                            "url": redact_url_for_logs(&upstream_url),
                        }),
                    );
                    break;
                }
            };

            let Some(item) = item else {
                break;
            };

            match item {
                Ok(b) => {
                    tap.lock().feed(&b);
                    if let Some(model) = tap.lock().take_created_model() {
                        created_model_for_usage = Some(model.clone());
                        update_session_response_model(&st2, &session_key2, &model);
                        if !mismatch_logged {
                            let req = requested_model2.as_deref().map(str::trim).filter(|s| !s.is_empty());
                            if req.is_some_and(|r| !r.eq_ignore_ascii_case(model.trim())) {
                                maybe_record_model_mismatch(
                                    &st2,
                                    &provider2,
                                    &session_key2,
                                    requested_model2.as_deref(),
                                    &model,
                                    true,
                                );
                                mismatch_logged = true;
                            }
                        }
                    }
                    forwarded_bytes = forwarded_bytes.saturating_add(b.len() as u64);
                    yield Ok::<Bytes, std::convert::Infallible>(b);
                }
                Err(e) => {
                    // Only log once and stop the stream to avoid spamming identical errors.
                    let enc = upstream_headers
                        .get(header::CONTENT_ENCODING)
                        .and_then(|v| v.to_str().ok())
                        .unwrap_or("-");
                    let transfer = upstream_headers
                        .get(header::TRANSFER_ENCODING)
                        .and_then(|v| v.to_str().ok())
                        .unwrap_or("-");
                    let ct = upstream_headers
                        .get(header::CONTENT_TYPE)
                        .and_then(|v| v.to_str().ok())
                        .unwrap_or("-");
                    let completed = tap.lock().is_completed();
                    let note = if completed {
                        "after completion"
                    } else {
                        "before completion; downstream output may be incomplete"
                    };
                    let err = format_reqwest_error_for_logs(&e);
                    st_err.store.add_event(
                        &provider_err,
                        "error",
                        "stream.read_error",
                        &format!(
                            "stream read error ({note}); completed={completed}; forwarded_bytes={forwarded_bytes}; upstream_status={upstream_status}; url={}; content_type={ct}; content_encoding={enc}; transfer_encoding={transfer}; {err}",
                            redact_url_for_logs(&upstream_url)
                        ),
                        json!({
                            "completed": completed,
                            "forwarded_bytes": forwarded_bytes,
                            "upstream_status": upstream_status,
                            "url": redact_url_for_logs(&upstream_url),
                            "content_type": ct,
                            "content_encoding": enc,
                            "transfer_encoding": transfer,
                            "error": err,
                        }),
                    );
                    break;
                }
            }
        }
        if let Some((_rid, resp_obj)) = tap3.lock().take_completed() {
            if created_model_for_usage.is_none() {
                if let Some(model) = extract_response_model_option(&resp_obj) {
                    created_model_for_usage = Some(model.clone());
                    update_session_response_model(&st2, &session_key2, &model);
                    if !mismatch_logged {
                        let req = requested_model2.as_deref().map(str::trim).filter(|s| !s.is_empty());
                        if req.is_some_and(|r| !r.eq_ignore_ascii_case(model.trim())) {
                            maybe_record_model_mismatch(
                                &st2,
                                &provider2,
                                &session_key2,
                                requested_model2.as_deref(),
                                &model,
                                true,
                            );
                        }
                    }
                }
            }
            st2.store
                .record_success_with_model(
                    &provider2,
                    &resp_obj,
                    Some(&api_key_ref2),
                    created_model_for_usage.as_deref(),
                    &request_origin2,
                );
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
    created_model: Option<String>,
    completed: Option<(String, Value)>,
}

impl SseTap {
    fn new() -> Self {
        Self {
            buf: String::new(),
            created_model: None,
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
            if v.get("type").and_then(|x| x.as_str()) == Some("response.created") {
                if let Some(resp) = v.get("response") {
                    if let Some(model) = extract_response_model_option(resp) {
                        self.created_model = Some(model);
                    }
                }
            }
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
        let out = self.completed.take();
        if out.is_some() {
            self.created_model = None;
        }
        out
    }

    fn take_created_model(&mut self) -> Option<String> {
        self.created_model.take()
    }

    fn is_completed(&self) -> bool {
        self.completed.is_some()
    }
}
