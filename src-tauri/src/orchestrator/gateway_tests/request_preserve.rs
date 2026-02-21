#[tokio::test]
async fn accepts_large_json_body_over_default_limit() {
    // Axum's default JSON body limit is small (~2 MiB). Our gateway should accept larger
    // Codex requests without returning 413 before the handler runs.
    let tmp = tempfile::tempdir().expect("tempdir");
    let store = open_store_dir(tmp.path().join("data")).expect("store");
    let secrets = SecretStore::new(tmp.path().join("secrets.json"));

    let cfg = AppConfig::default_config();
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

    // 3 MiB string payload -> should not trip the default limit.
    let big = "a".repeat(3 * 1024 * 1024);
    let body = serde_json::json!({
        "input": big,
        "stream": false
    })
    .to_string();

    let resp = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/responses")
                .header("content-type", "application/json")
                .body(Body::from(body))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_ne!(resp.status(), StatusCode::PAYLOAD_TOO_LARGE);
}

#[tokio::test]
async fn logs_pre_handler_json_rejections() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let store = open_store_dir(tmp.path().join("data")).expect("store");
    let secrets = SecretStore::new(tmp.path().join("secrets.json"));

    let cfg = AppConfig::default_config();
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

    // Make the limit tiny so we can trigger 413 reliably in a unit test.
    let app = build_router_with_body_limit(state, 1024);

    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/responses")
                .header("content-type", "application/json")
                .body(Body::from("{not json"))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);

    let resp = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/responses")
                .header("content-type", "application/json")
                .body(Body::from(format!("\"{}\"", "a".repeat(2048))))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::PAYLOAD_TOO_LARGE);

    let events = store.list_events(10);
    assert!(!events.is_empty());
    let joined = events
        .iter()
        .filter_map(|e| e.get("message").and_then(|m| m.as_str()))
        .collect::<Vec<_>>()
        .join("\n");
    assert!(joined.contains("/v1/responses"));
    assert!(joined.contains("413") || joined.contains("400"));
}

#[tokio::test]
async fn preserves_tool_input_and_previous_response_id() {
    let captured = Arc::new(Mutex::new(None));
    let captured2 = captured.clone();
    let app = Router::new().route(
        "/v1/responses",
        post(move |Json(body): Json<serde_json::Value>| {
            *captured2.lock() = Some(body);
            async move {
                Json(json!({
                    "id": "resp_test",
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
                disabled: false,
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
    let input = json!({
        "type": "message",
        "role": "user",
        "content": [{
            "type": "tool_output",
            "tool_call_id": "call_1",
            "output": "C:\\\\work\\\\example-project"
        }]
    });
    let body = json!({
        "model": "gpt-test",
        "input": input,
        "previous_response_id": "resp_prev",
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

    let captured = captured.lock().clone().expect("captured body");
    assert_eq!(captured.get("previous_response_id").unwrap(), "resp_prev");
    assert_eq!(captured.get("input").unwrap(), &input);
}

#[tokio::test]
async fn preserves_tool_input_inside_message_array() {
    let captured = Arc::new(Mutex::new(None));
    let captured2 = captured.clone();
    let app = Router::new().route(
        "/v1/responses",
        post(move |Json(body): Json<serde_json::Value>| {
            *captured2.lock() = Some(body);
            async move {
                Json(json!({
                    "id": "resp_test",
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
                disabled: false,
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
        "content": [{
            "type": "tool_output",
            "tool_call_id": "call_1",
            "output": "C:\\\\work\\\\example-project"
        }]
    }]);
    let body = json!({
        "model": "gpt-test",
        "input": input,
        "previous_response_id": "resp_prev",
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

    let captured = captured.lock().clone().expect("captured body");
    assert_eq!(captured.get("previous_response_id").unwrap(), "resp_prev");
    assert_eq!(captured.get("input").unwrap(), &input);
}

#[tokio::test]
async fn preserves_previous_response_id_for_plain_messages() {
    let captured = Arc::new(Mutex::new(None));
    let captured2 = captured.clone();
    let app = Router::new().route(
        "/v1/responses",
        post(move |Json(body): Json<serde_json::Value>| {
            *captured2.lock() = Some(body);
            async move {
                Json(json!({
                    "id": "resp_test",
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
                disabled: false,
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
        "previous_response_id": "resp_prev",
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

    let captured = captured.lock().clone().expect("captured body");
    assert_eq!(captured.get("previous_response_id").unwrap(), "resp_prev");
    assert_eq!(captured.get("input").unwrap(), &input);
}

