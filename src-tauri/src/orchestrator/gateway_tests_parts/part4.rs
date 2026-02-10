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
