async fn spawn_fail_once_then_ok_upstream(hit_counter: Arc<AtomicUsize>) -> String {
    let app = Router::new().route(
        "/v1/responses",
        post(move |_body: axum::extract::Json<serde_json::Value>| {
            let idx = hit_counter.fetch_add(1, Ordering::Relaxed);
            async move {
                if idx == 0 {
                    (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        Json(json!({
                            "error": {
                                "message": "boom_once"
                            }
                        })),
                    )
                } else {
                    (
                        StatusCode::OK,
                        Json(json!({
                            "id": "resp_ok_after_fail",
                            "output": [{"content": [{"type": "output_text", "text": "ok"}]}]
                        })),
                    )
                }
            }
        }),
    );

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let base_url = format!("http://{}:{}/v1", addr.ip(), addr.port());
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    base_url
}

#[tokio::test]
async fn e2e_status_closed_provider_keeps_failure_fields() {
    let cfg = AppConfig {
        listen: ListenConfig {
            host: "127.0.0.1".to_string(),
            port: 0,
        },
        routing: RoutingConfig {
            preferred_provider: "p1".to_string(),
            session_preferred_providers: std::collections::BTreeMap::new(),
            auto_return_to_preferred: true,
            preferred_stable_seconds: 30,
            failure_threshold: 1,
            cooldown_seconds: 120,
            request_timeout_seconds: 5,
        },
        providers: std::collections::BTreeMap::from([
            (
                "p1".to_string(),
                ProviderConfig {
                    display_name: "P1".to_string(),
                    base_url: "https://example.com/v1".to_string(),
                    disabled: false,
                    usage_adapter: String::new(),
                    usage_base_url: None,
                    api_key: String::new(),
                },
            ),
            (
                "p2".to_string(),
                ProviderConfig {
                    display_name: "P2".to_string(),
                    base_url: "https://example.com/v1".to_string(),
                    disabled: false,
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
    store
        .put_quota_snapshot(
            "p2",
            &json!({
                "kind": "budget_info",
                "daily_spent_usd": 120.0,
                "daily_budget_usd": 120.0,
                "weekly_spent_usd": 10.0,
                "weekly_budget_usd": 360.0,
                "monthly_spent_usd": 20.0,
                "monthly_budget_usd": 400.0,
                "updated_at_unix_ms": unix_ms()
            }),
        )
        .expect("quota snapshot");
    let secrets = SecretStore::new(tmp.path().join("secrets.json"));
    let router = Arc::new(RouterState::new(&cfg, unix_ms()));
    let failure_message = "forced fail for closed-status test";
    router.mark_failure("p2", &cfg, failure_message, unix_ms());

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
    let resp = app
        .oneshot(
            Request::builder()
                .uri("/status")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    let payload: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let p2 = payload
        .get("providers")
        .and_then(|providers| providers.get("p2"))
        .cloned()
        .expect("providers.p2");

    assert_eq!(p2.get("status").and_then(|v| v.as_str()), Some("closed"));
    assert_eq!(
        p2.get("consecutive_failures").and_then(|v| v.as_u64()),
        Some(1)
    );
    assert_eq!(
        p2.get("cooldown_until_unix_ms").and_then(|v| v.as_u64()),
        Some(0)
    );
    assert_eq!(
        p2.get("last_error").and_then(|v| v.as_str()),
        Some(failure_message)
    );
}

#[tokio::test]
async fn e2e_recovery_success_resets_failures_but_keeps_last_error() {
    let hit_counter = Arc::new(AtomicUsize::new(0));
    let p1_base = spawn_fail_once_then_ok_upstream(hit_counter.clone()).await;
    let cfg = AppConfig {
        listen: ListenConfig {
            host: "127.0.0.1".to_string(),
            port: 0,
        },
        routing: RoutingConfig {
            preferred_provider: "p1".to_string(),
            session_preferred_providers: std::collections::BTreeMap::new(),
            auto_return_to_preferred: true,
            preferred_stable_seconds: 30,
            failure_threshold: 1,
            cooldown_seconds: 120,
            request_timeout_seconds: 5,
        },
        providers: std::collections::BTreeMap::from([(
            "p1".to_string(),
            ProviderConfig {
                display_name: "P1".to_string(),
                base_url: p1_base,
                disabled: false,
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
    let body = json!({
        "model": "gpt-test",
        "input": [{
            "type": "message",
            "role": "user",
            "content": [{"type": "input_text", "text": "hello"}]
        }],
        "stream": false
    });

    let first = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/v1/responses")
                .method("POST")
                .header("content-type", "application/json")
                .header("session_id", "sid-e2e-recovery")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(first.status(), StatusCode::BAD_GATEWAY);

    let second = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/v1/responses")
                .method("POST")
                .header("content-type", "application/json")
                .header("session_id", "sid-e2e-recovery")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(second.status(), StatusCode::OK);
    assert_eq!(hit_counter.load(Ordering::Relaxed), 2);

    let status_resp = app
        .oneshot(
            Request::builder()
                .uri("/status")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(status_resp.status(), StatusCode::OK);

    let status_body = axum::body::to_bytes(status_resp.into_body(), usize::MAX)
        .await
        .unwrap();
    let payload: serde_json::Value = serde_json::from_slice(&status_body).unwrap();
    let p1 = payload
        .get("providers")
        .and_then(|providers| providers.get("p1"))
        .cloned()
        .expect("providers.p1");

    assert_eq!(p1.get("status").and_then(|v| v.as_str()), Some("healthy"));
    assert_eq!(
        p1.get("consecutive_failures").and_then(|v| v.as_u64()),
        Some(0)
    );
    assert_eq!(
        p1.get("cooldown_until_unix_ms").and_then(|v| v.as_u64()),
        Some(0)
    );
    let last_error = p1
        .get("last_error")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    assert!(
        last_error.contains("upstream p1 returned 500"),
        "unexpected last_error: {last_error}"
    );
    assert!(
        p1.get("last_ok_at_unix_ms")
            .and_then(|v| v.as_u64())
            .unwrap_or(0)
            > 0
    );
}
