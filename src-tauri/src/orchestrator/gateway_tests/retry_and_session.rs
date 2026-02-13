#[tokio::test]
async fn switches_provider_rebuilds_history_without_prev_id() {
    let captured = Arc::new(Mutex::new(None));
    let captured2 = captured.clone();

    let app_ok = Router::new().route(
        "/v1/responses",
        post(move |Json(body): Json<serde_json::Value>| {
            *captured2.lock() = Some(body);
            async move {
                Json(json!({
                    "id": "resp_ok",
                    "output": [{"content": [{"type": "output_text", "text": "ok"}]}]
                }))
            }
        }),
    );
    let ok_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let ok_addr = ok_listener.local_addr().unwrap();
    let ok_base = format!("http://{}:{}/v1", ok_addr.ip(), ok_addr.port());
    tokio::spawn(async move {
        let _ = axum::serve(ok_listener, app_ok).await;
    });

    let app_fail = Router::new().route(
        "/v1/responses",
        post(|| async move {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": "fail"})),
            )
        }),
    );
    let fail_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let fail_addr = fail_listener.local_addr().unwrap();
    let fail_base = format!("http://{}:{}/v1", fail_addr.ip(), fail_addr.port());
    tokio::spawn(async move {
        let _ = axum::serve(fail_listener, app_fail).await;
    });

    let cfg = AppConfig {
        listen: ListenConfig {
            host: "127.0.0.1".to_string(),
            port: 0,
        },
        routing: RoutingConfig {
            preferred_provider: "p1".to_string(),
            session_preferred_providers: std::collections::BTreeMap::new(),
            auto_return_to_preferred: false,
            preferred_stable_seconds: 1,
            failure_threshold: 1,
            cooldown_seconds: 1,
            request_timeout_seconds: 5,
        },
        providers: std::collections::BTreeMap::from([
            (
                "p1".to_string(),
                ProviderConfig {
                    display_name: "P1".to_string(),
                    base_url: fail_base,
                    usage_adapter: String::new(),
                    usage_base_url: None,
                    api_key: String::new(),
                },
            ),
            (
                "p2".to_string(),
                ProviderConfig {
                    display_name: "P2".to_string(),
                    base_url: ok_base,
                    usage_adapter: String::new(),
                    usage_base_url: None,
                    api_key: String::new(),
                },
            ),
        ]),
        provider_order: vec!["p1".to_string(), "p2".to_string()],
    };

    let tmp = tempfile::tempdir().expect("tempdir");
    let store = open_store_dir(tmp.path().join("data")).expect("store");
    let secrets = SecretStore::new(tmp.path().join("secrets.json"));
    let session_id = "session-switch";
    let lines = [
        json!({
            "type": "response_item",
            "payload": {
                "type": "message",
                "role": "user",
                "content": [{"type": "input_text", "text": "first"}]
            }
        }),
        json!({
            "type": "response_item",
            "payload": {
                "type": "message",
                "role": "assistant",
                "content": [{"type": "output_text", "text": "reply"}]
            }
        }),
    ];
    let _guard = setup_codex_session(&tmp, session_id, &lines);
    let router = Arc::new(RouterState::new(&cfg, unix_ms()));
    let state = GatewayState {
        cfg: Arc::new(RwLock::new(cfg)),
        router,
        store: store.clone(),
        upstream: UpstreamClient::new(),
        secrets,
        last_activity_unix_ms: Arc::new(AtomicU64::new(0)),
        last_used_by_session: Arc::new(RwLock::new(HashMap::new())),
        usage_base_speed_cache: Arc::new(RwLock::new(HashMap::new())),
        prev_id_support_cache: Arc::new(RwLock::new(HashMap::new())),
        client_sessions: Arc::new(RwLock::new(HashMap::new())),
    };

    let app = build_router(state);
    let cur_input = json!([{
        "type": "message",
        "role": "user",
        "content": [{"type": "input_text", "text": "second"}]
    }]);
    let body = json!({
        "model": "gpt-test",
        "input": cur_input,
        "previous_response_id": "resp_prev",
        "stream": false
    });

    let resp = app
        .oneshot(
            Request::builder()
                .uri("/v1/responses")
                .method("POST")
                .header("content-type", "application/json")
                .header("session_id", session_id)
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    let captured = captured.lock().clone().expect("captured body");
    assert!(captured.get("previous_response_id").is_none());
    let expected_input = json!([
        {
            "type": "message",
            "role": "user",
            "content": [{"type": "input_text", "text": "first"}]
        },
        {
            "type": "message",
            "role": "assistant",
            "content": [{"type": "output_text", "text": "reply"}]
        },
        {
            "type": "message",
            "role": "user",
            "content": [{"type": "input_text", "text": "second"}]
        }
    ]);
    assert_eq!(captured.get("input").unwrap(), &expected_input);
}

#[tokio::test]
async fn retries_without_prev_id_when_upstream_rejects_it() {
    let captured = Arc::new(Mutex::new(None));
    let captured2 = captured.clone();
    let app = Router::new().route(
        "/v1/responses",
        post(move |Json(body): Json<serde_json::Value>| {
            let has_prev = body.get("previous_response_id").is_some();
            let captured2 = captured2.clone();
            async move {
                if has_prev {
                    return (
                        StatusCode::BAD_REQUEST,
                        Json(json!({
                            "error": {"message": "Unsupported parameter: previous_response_id"}
                        })),
                    );
                }
                *captured2.lock() = Some(body);
                (
                    StatusCode::OK,
                    Json(json!({
                        "id": "resp_ok",
                        "output": [{"content": [{"type": "output_text", "text": "ok"}]}]
                    })),
                )
            }
        }),
    );

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let base_url = format!("http://{}:{}/v1", addr.ip(), addr.port());
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });

    let cfg = AppConfig {
        listen: ListenConfig {
            host: "127.0.0.1".to_string(),
            port: 0,
        },
        routing: RoutingConfig {
            preferred_provider: "p1".to_string(),
            session_preferred_providers: std::collections::BTreeMap::new(),
            auto_return_to_preferred: true,
            preferred_stable_seconds: 1,
            failure_threshold: 1,
            cooldown_seconds: 1,
            request_timeout_seconds: 5,
        },
        providers: std::collections::BTreeMap::from([(
            "p1".to_string(),
            ProviderConfig {
                display_name: "P1".to_string(),
                base_url,
                usage_adapter: String::new(),
                usage_base_url: None,
                api_key: String::new(),
            },
        )]),
        provider_order: vec!["p1".to_string()],
    };

    let tmp = tempfile::tempdir().expect("tempdir");
    let store = open_store_dir(tmp.path().join("data")).expect("store");

    let session_id = "session-xyz";
    let lines = [
        json!({
            "type": "response_item",
            "payload": {
                "type": "message",
                "role": "user",
                "content": [{"type": "input_text", "text": "first"}]
            }
        }),
        json!({
            "type": "response_item",
            "payload": {
                "type": "message",
                "role": "assistant",
                "content": [{"type": "output_text", "text": "reply"}]
            }
        }),
    ];
    let _guard = setup_codex_session(&tmp, session_id, &lines);
    let secrets = SecretStore::new(tmp.path().join("secrets.json"));
    let router = Arc::new(RouterState::new(&cfg, unix_ms()));
    let state = GatewayState {
        cfg: Arc::new(RwLock::new(cfg)),
        router,
        store,
        upstream: UpstreamClient::new(),
        secrets,
        last_activity_unix_ms: Arc::new(AtomicU64::new(0)),
        last_used_by_session: Arc::new(RwLock::new(HashMap::new())),
        usage_base_speed_cache: Arc::new(RwLock::new(HashMap::new())),
        prev_id_support_cache: Arc::new(RwLock::new(HashMap::new())),
        client_sessions: Arc::new(RwLock::new(HashMap::new())),
    };

    let app = build_router(state);
    let body = json!({
        "model": "gpt-test",
        "input": [{
            "type": "message",
            "role": "user",
            "content": [{"type": "input_text", "text": "second"}]
        }],
        "previous_response_id": "resp_prev",
        "stream": false
    });

    let resp = app
        .oneshot(
            Request::builder()
                .uri("/v1/responses")
                .method("POST")
                .header("content-type", "application/json")
                .header("session_id", session_id)
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    let captured = captured.lock().clone().expect("captured body");
    assert!(captured.get("previous_response_id").is_none());
    let expected_input = json!([
        {
            "type": "message",
            "role": "user",
            "content": [{"type": "input_text", "text": "first"}]
        },
        {
            "type": "message",
            "role": "assistant",
            "content": [{"type": "output_text", "text": "reply"}]
        },
        {
            "type": "message",
            "role": "user",
            "content": [{"type": "input_text", "text": "second"}]
        }
    ]);
    assert_eq!(captured.get("input").unwrap(), &expected_input);
}

#[tokio::test]
async fn allows_request_without_prev_id_even_if_session_history_missing() {
    let captured = Arc::new(Mutex::new(None));
    let captured2 = captured.clone();
    let app = Router::new().route(
        "/v1/responses",
        post(move |Json(body): Json<serde_json::Value>| {
            *captured2.lock() = Some(body);
            async move {
                Json(json!({
                    "id": "resp_ok",
                    "output": [{"content": [{"type": "output_text", "text": "ok"}]}]
                }))
            }
        }),
    );

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let base_url = format!("http://{}:{}/v1", addr.ip(), addr.port());
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });

    let cfg = AppConfig {
        listen: ListenConfig {
            host: "127.0.0.1".to_string(),
            port: 0,
        },
        routing: RoutingConfig {
            preferred_provider: "p1".to_string(),
            session_preferred_providers: std::collections::BTreeMap::new(),
            auto_return_to_preferred: true,
            preferred_stable_seconds: 1,
            failure_threshold: 1,
            cooldown_seconds: 1,
            request_timeout_seconds: 5,
        },
        providers: std::collections::BTreeMap::from([(
            "p1".to_string(),
            ProviderConfig {
                display_name: "P1".to_string(),
                base_url,
                usage_adapter: String::new(),
                usage_base_url: None,
                api_key: String::new(),
            },
        )]),
        provider_order: vec!["p1".to_string()],
    };

    let tmp = tempfile::tempdir().expect("tempdir");
    let store = open_store_dir(tmp.path().join("data")).expect("store");
    let secrets = SecretStore::new(tmp.path().join("secrets.json"));
    let router = Arc::new(RouterState::new(&cfg, unix_ms()));
    let state = GatewayState {
        cfg: Arc::new(RwLock::new(cfg)),
        router,
        store,
        upstream: UpstreamClient::new(),
        secrets,
        last_activity_unix_ms: Arc::new(AtomicU64::new(0)),
        last_used_by_session: Arc::new(RwLock::new(HashMap::new())),
        usage_base_speed_cache: Arc::new(RwLock::new(HashMap::new())),
        prev_id_support_cache: Arc::new(RwLock::new(HashMap::new())),
        client_sessions: Arc::new(RwLock::new(HashMap::new())),
    };

    let app = build_router(state);
    let input = json!([{
        "type": "message",
        "role": "user",
        "content": [{"type": "input_text", "text": "hi"}]
    }]);
    let body = json!({
        "model": "gpt-test",
        "input": input,
        "stream": false
    });

    let resp = app
        .oneshot(
            Request::builder()
                .uri("/v1/responses")
                .method("POST")
                .header("content-type", "application/json")
                .header("session_id", "session-missing")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    let captured = captured.lock().clone().expect("captured body");
    assert_eq!(captured.get("input").unwrap(), &input);
    assert!(captured.get("previous_response_id").is_none());
}

#[tokio::test]
async fn allows_request_without_session_id_when_no_prev() {
    let app = Router::new().route(
        "/v1/responses",
        post(move |Json(_body): Json<serde_json::Value>| async move {
            Json(json!({
                "id": "resp_test",
                "output": [{"content": [{"type": "output_text", "text": "ok"}]}]
            }))
        }),
    );

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let base_url = format!("http://{}:{}/v1", addr.ip(), addr.port());
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });

    let cfg = AppConfig {
        listen: ListenConfig {
            host: "127.0.0.1".to_string(),
            port: 0,
        },
        routing: RoutingConfig {
            preferred_provider: "p1".to_string(),
            session_preferred_providers: std::collections::BTreeMap::new(),
            auto_return_to_preferred: true,
            preferred_stable_seconds: 1,
            failure_threshold: 1,
            cooldown_seconds: 1,
            request_timeout_seconds: 5,
        },
        providers: std::collections::BTreeMap::from([(
            "p1".to_string(),
            ProviderConfig {
                display_name: "P1".to_string(),
                base_url,
                usage_adapter: String::new(),
                usage_base_url: None,
                api_key: String::new(),
            },
        )]),
        provider_order: vec!["p1".to_string()],
    };

    let tmp = tempfile::tempdir().expect("tempdir");
    let store = open_store_dir(tmp.path().join("data")).expect("store");
    let secrets = SecretStore::new(tmp.path().join("secrets.json"));
    let router = Arc::new(RouterState::new(&cfg, unix_ms()));
    let state = GatewayState {
        cfg: Arc::new(RwLock::new(cfg)),
        router,
        store,
        upstream: UpstreamClient::new(),
        secrets,
        last_activity_unix_ms: Arc::new(AtomicU64::new(0)),
        last_used_by_session: Arc::new(RwLock::new(HashMap::new())),
        usage_base_speed_cache: Arc::new(RwLock::new(HashMap::new())),
        prev_id_support_cache: Arc::new(RwLock::new(HashMap::new())),
        client_sessions: Arc::new(RwLock::new(HashMap::new())),
    };

    let app = build_router(state);
    let input = json!([{
        "type": "message",
        "role": "user",
        "content": [{"type": "input_text", "text": "pwd"}]
    }]);
    let body = json!({
        "model": "gpt-test",
        "input": input,
        "stream": false
    });

    let resp = app
        .oneshot(
            Request::builder()
                .uri("/v1/responses")
                .method("POST")
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
}

#[tokio::test]
async fn gateway_request_sets_session_model_provider_to_api_router() {
    let app = Router::new().route(
        "/v1/responses",
        post(
            move |_body: axum::extract::Json<serde_json::Value>| async move {
                (
                    StatusCode::OK,
                    Json(json!({
                        "id": "resp_ok",
                        "model": "gpt-5.2-2025-12-11",
                        "output": [{"content": [{"type": "output_text", "text": "ok"}]}]
                    })),
                )
            },
        ),
    );

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let base_url = format!("http://{}:{}/v1", addr.ip(), addr.port());
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });

    let cfg = AppConfig {
        listen: ListenConfig {
            host: "127.0.0.1".to_string(),
            port: 0,
        },
        routing: RoutingConfig {
            preferred_provider: "p1".to_string(),
            session_preferred_providers: std::collections::BTreeMap::new(),
            auto_return_to_preferred: true,
            preferred_stable_seconds: 1,
            failure_threshold: 1,
            cooldown_seconds: 1,
            request_timeout_seconds: 5,
        },
        providers: std::collections::BTreeMap::from([(
            "p1".to_string(),
            ProviderConfig {
                display_name: "P1".to_string(),
                base_url,
                usage_adapter: String::new(),
                usage_base_url: None,
                api_key: String::new(),
            },
        )]),
        provider_order: vec!["p1".to_string()],
    };

    let tmp = tempfile::tempdir().expect("tempdir");
    let store = open_store_dir(tmp.path().join("data")).expect("store");
    let secrets = SecretStore::new(tmp.path().join("secrets.json"));
    let router = Arc::new(RouterState::new(&cfg, unix_ms()));
    let client_sessions = Arc::new(RwLock::new(HashMap::new()));
    let state = GatewayState {
        cfg: Arc::new(RwLock::new(cfg)),
        router,
        store,
        upstream: UpstreamClient::new(),
        secrets,
        last_activity_unix_ms: Arc::new(AtomicU64::new(0)),
        last_used_by_session: Arc::new(RwLock::new(HashMap::new())),
        usage_base_speed_cache: Arc::new(RwLock::new(HashMap::new())),
        prev_id_support_cache: Arc::new(RwLock::new(HashMap::new())),
        client_sessions: client_sessions.clone(),
    };

    let app = build_router(state);
    let body = json!({
        "model": "gpt-test",
        "input": [{
            "type": "message",
            "role": "user",
            "content": [{"type": "input_text", "text": "hello"}]
        }],
        "stream": false
    });
    let session_id = "session-provider-check";

    let resp = app
        .oneshot(
            Request::builder()
                .uri("/v1/responses")
                .method("POST")
                .header("content-type", "application/json")
                .header("session_id", session_id)
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    let sessions = client_sessions.read();
    let item = sessions.get(session_id).expect("session runtime");
    assert_eq!(
        item.last_reported_model_provider.as_deref(),
        Some(GATEWAY_MODEL_PROVIDER_ID)
    );
    assert_eq!(
        item.last_reported_model.as_deref(),
        Some("gpt-5.2-2025-12-11")
    );
}

#[tokio::test]
async fn stream_usage_prefers_response_created_model_not_unknown() {
    let app = Router::new().route(
        "/v1/responses",
        post(move |_body: axum::extract::Json<serde_json::Value>| async move {
            let sse = concat!(
                "data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_stream_1\",\"model\":\"gpt-5.2-2025-12-11\"}}\n\n",
                "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_stream_1\",\"model\":\"gpt-5.3-codex\",\"usage\":{\"input_tokens\":11,\"output_tokens\":7,\"total_tokens\":18}}}\n\n",
                "data: [DONE]\n\n"
            );
            let stream = futures_util::stream::iter(vec![Ok::<_, std::convert::Infallible>(
                bytes::Bytes::from(sse.as_bytes().to_vec()),
            )]);
            let body = Body::from_stream(stream);
            let mut resp = axum::response::Response::new(body);
            *resp.status_mut() = StatusCode::OK;
            resp.headers_mut().insert(
                axum::http::header::CONTENT_TYPE,
                axum::http::HeaderValue::from_static("text/event-stream"),
            );
            resp
        }),
    );

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let base_url = format!("http://{}:{}/v1", addr.ip(), addr.port());
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });

    let cfg = AppConfig {
        listen: ListenConfig {
            host: "127.0.0.1".to_string(),
            port: 0,
        },
        routing: RoutingConfig {
            preferred_provider: "p1".to_string(),
            session_preferred_providers: std::collections::BTreeMap::new(),
            auto_return_to_preferred: true,
            preferred_stable_seconds: 1,
            failure_threshold: 1,
            cooldown_seconds: 1,
            request_timeout_seconds: 5,
        },
        providers: std::collections::BTreeMap::from([(
            "p1".to_string(),
            ProviderConfig {
                display_name: "P1".to_string(),
                base_url,
                usage_adapter: String::new(),
                usage_base_url: None,
                api_key: String::new(),
            },
        )]),
        provider_order: vec!["p1".to_string()],
    };

    let tmp = tempfile::tempdir().expect("tempdir");
    let store = open_store_dir(tmp.path().join("data")).expect("store");
    let secrets = SecretStore::new(tmp.path().join("secrets.json"));
    let router = Arc::new(RouterState::new(&cfg, unix_ms()));
    let client_sessions = Arc::new(RwLock::new(HashMap::new()));
    let state = GatewayState {
        cfg: Arc::new(RwLock::new(cfg)),
        router,
        store: store.clone(),
        upstream: UpstreamClient::new(),
        secrets,
        last_activity_unix_ms: Arc::new(AtomicU64::new(0)),
        last_used_by_session: Arc::new(RwLock::new(HashMap::new())),
        usage_base_speed_cache: Arc::new(RwLock::new(HashMap::new())),
        prev_id_support_cache: Arc::new(RwLock::new(HashMap::new())),
        client_sessions: client_sessions.clone(),
    };

    let app = build_router(state);
    let body = json!({
        "model": "gpt-5.3-codex",
        "input": [{
            "type": "message",
            "role": "user",
            "content": [{"type": "input_text", "text": "hello"}]
        }],
        "stream": true
    });

    let resp = app
        .oneshot(
            Request::builder()
                .uri("/v1/responses")
                .method("POST")
                .header("content-type", "application/json")
                .header("session_id", "session-stream-model")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    // Consume stream so persistence callback runs.
    let _ = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();

    let usage = store.list_usage_requests(20);
    let row = usage
        .iter()
        .find(|v| v.get("provider").and_then(|x| x.as_str()) == Some("p1"))
        .expect("usage row");
    assert_eq!(
        row.get("model").and_then(|x| x.as_str()),
        Some("gpt-5.2-2025-12-11")
    );
    assert_ne!(row.get("model").and_then(|x| x.as_str()), Some("unknown"));

    let sessions = client_sessions.read();
    let session = sessions.get("session-stream-model").expect("session row");
    assert_eq!(
        session.last_reported_model.as_deref(),
        Some("gpt-5.2-2025-12-11")
    );
}
