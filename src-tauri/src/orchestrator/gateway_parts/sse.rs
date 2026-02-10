fn passthrough_sse_and_persist(
    upstream_resp: reqwest::Response,
    st: GatewayState,
    provider_name: String,
    _parent_id: Option<String>,
    _request_json: Value,
    _session_key: Option<String>,
    idle_timeout_seconds: u64,
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
    let tap3 = tap.clone();
    let stream = async_stream::stream! {
        let mut forwarded_bytes: u64 = 0;
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
            st2.store.record_success(&provider2, &resp_obj);
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

    fn is_completed(&self) -> bool {
        self.completed.is_some()
    }
}
