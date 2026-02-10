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

    let codex_session_key = session_key_from_request(&headers, &body);
    let codex_session_display = codex_session_id_for_display(&headers, &body);
    let session_key = codex_session_display
        .as_deref()
        .or(codex_session_key.as_deref())
        .map(|s| s.to_string())
        .unwrap_or_else(|| format!("peer:{peer}"));
    let client_session = windows_terminal::infer_wt_session(peer, cfg.listen.port);
    let routing_session_fields = {
        let wt = client_session.as_ref().map(|s| s.wt_session.clone());
        let pid = client_session.as_ref().map(|s| s.pid);
        // Prefer the human-facing codex session id if present; fall back to session key.
        let codex = (!session_key.starts_with("peer:")).then_some(session_key.clone());
        json!({
            "wt_session": wt,
            "pid": pid,
            "codex_session_id": codex,
        })
    };
    // Record requests against the canonical Codex session identity (from headers/body), not WT_SESSION.
    // WT_SESSION is window-scoped and can be shared across tabs; additionally, some network calls may
    // be owned by helper processes.
    if !session_key.starts_with("peer:") {
        let mut map = st.client_sessions.write();
        let entry = map
            .entry(session_key.clone())
            .or_insert_with(|| ClientSessionRuntime {
                codex_session_id: session_key.clone(),
                pid: client_session.as_ref().map(|s| s.pid).unwrap_or(0),
                wt_session: client_session.as_ref().map(|s| s.wt_session.clone()),
                last_request_unix_ms: 0,
                last_discovered_unix_ms: 0,
                last_reported_model_provider: None,
                last_reported_base_url: None,
                confirmed_router: true,
            });
        if let Some(inferred) = client_session.as_ref() {
            entry.pid = inferred.pid;
            entry.wt_session = Some(inferred.wt_session.clone());
        }
        entry.last_request_unix_ms = unix_ms();
        entry.confirmed_router = true;
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
                        // Avoid spamming the event log for routine successful requests; only
                        // surface interesting routing outcomes (failover / non-preferred).
                        if !is_first_attempt || reason != "preferred_healthy" {
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
                        } else if prev.as_ref().is_some_and(|p| {
                            p.provider.as_str() != provider_name
                                && p.preferred.as_str() == provider_name
                                && preferred == provider_name
                        }) {
                            // Only log "back to preferred" when we were previously using a
                            // different provider.
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
                            previous_response_id.clone(),
                            body_for_provider.clone(),
                            codex_session_key.clone(),
                            timeout,
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
                            retried_without_prev = true;
                            continue;
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
                        break;
                    }
                    Err(e) => {
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

                    // Persist the exchange so we can keep continuity if provider changes later.
                    st.store.record_success(&provider_name, &response_obj);

                    // Avoid spamming the event log for routine successful requests; only surface
                    // interesting routing outcomes (failover / non-preferred).
                    if !is_first_attempt || reason != "preferred_healthy" {
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
                    } else if prev.as_ref().is_some_and(|p| {
                        p.provider.as_str() != provider_name
                            && p.preferred.as_str() == provider_name
                            && preferred == provider_name
                    }) {
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
                        retried_without_prev = true;
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

