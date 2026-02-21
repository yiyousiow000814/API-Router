use std::sync::atomic::{AtomicUsize, Ordering};

async fn spawn_responses_upstream(hit_counter: Arc<AtomicUsize>, response_id: &'static str) -> String {
    let app = Router::new().route(
        "/v1/responses",
        post(move |_body: axum::extract::Json<serde_json::Value>| {
            hit_counter.fetch_add(1, Ordering::Relaxed);
            async move {
                Json(json!({
                    "id": response_id,
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
    base_url
}

async fn assert_closed_provider_not_used_e2e(tag: &str, p2_snapshot: serde_json::Value) {
    let p2_hits = Arc::new(AtomicUsize::new(0));
    let p3_hits = Arc::new(AtomicUsize::new(0));
    let p1_hits = Arc::new(AtomicUsize::new(0));

    let p1_base = spawn_responses_upstream(p1_hits.clone(), "resp_p1").await;
    let p2_base = spawn_responses_upstream(p2_hits.clone(), "resp_p2").await;
    let p3_base = spawn_responses_upstream(p3_hits.clone(), "resp_p3").await;

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
                    base_url: p1_base,
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
                    base_url: p2_base,
                    disabled: false,
                    usage_adapter: String::new(),
                    usage_base_url: None,
                    api_key: String::new(),
                },
            ),
            (
                "p3".to_string(),
                ProviderConfig {
                    display_name: "P3".to_string(),
                    base_url: p3_base,
                    disabled: false,
                    usage_adapter: String::new(),
                    usage_base_url: None,
                    api_key: String::new(),
                },
            ),
        ]),
        provider_order: vec!["p1".to_string(), "p2".to_string(), "p3".to_string()],
    };

    let tmp = tempfile::tempdir().expect("tempdir");
    let store = open_store_dir(tmp.path().join("data")).expect("store");
    store.put_quota_snapshot("p2", &p2_snapshot).expect("quota snapshot");
    let secrets = SecretStore::new(tmp.path().join("secrets.json"));
    let router = Arc::new(RouterState::new(&cfg, unix_ms()));
    // Force preferred p1 into cooldown so fallback selection is exercised.
    router.mark_failure("p1", &cfg, "forced fail for test", unix_ms());
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
    let resp = app
        .oneshot(
            Request::builder()
                .uri("/v1/responses")
                .method("POST")
                .header("content-type", "application/json")
                .header("session_id", format!("sid-{tag}"))
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK, "scenario={tag}");

    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    let json_resp: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(json_resp.get("id").and_then(|v| v.as_str()), Some("resp_p3"), "scenario={tag}");
    assert_eq!(p2_hits.load(Ordering::Relaxed), 0, "scenario={tag}");
    assert_eq!(p3_hits.load(Ordering::Relaxed), 1, "scenario={tag}");
}

#[tokio::test]
async fn e2e_closed_provider_budget_caps_skip_depleted_provider() {
    let scenarios: Vec<(&str, serde_json::Value)> = vec![
        (
            "daily_gt",
            json!({
                "kind": "budget_info",
                "daily_spent_usd": 120.1,
                "daily_budget_usd": 120.0,
                "weekly_spent_usd": 10.0,
                "weekly_budget_usd": 360.0,
                "monthly_spent_usd": 20.0,
                "monthly_budget_usd": 400.0,
                "updated_at_unix_ms": unix_ms()
            }),
        ),
        (
            "daily_eq",
            json!({
                "kind": "budget_info",
                "daily_spent_usd": 120.0,
                "daily_budget_usd": 120.0,
                "weekly_spent_usd": 10.0,
                "weekly_budget_usd": 360.0,
                "monthly_spent_usd": 20.0,
                "monthly_budget_usd": 400.0,
                "updated_at_unix_ms": unix_ms()
            }),
        ),
        (
            "weekly_gt",
            json!({
                "kind": "budget_info",
                "daily_spent_usd": 12.0,
                "daily_budget_usd": 120.0,
                "weekly_spent_usd": 361.0,
                "weekly_budget_usd": 360.0,
                "monthly_spent_usd": 20.0,
                "monthly_budget_usd": 400.0,
                "updated_at_unix_ms": unix_ms()
            }),
        ),
        (
            "weekly_eq",
            json!({
                "kind": "budget_info",
                "daily_spent_usd": 12.0,
                "daily_budget_usd": 120.0,
                "weekly_spent_usd": 360.0,
                "weekly_budget_usd": 360.0,
                "monthly_spent_usd": 20.0,
                "monthly_budget_usd": 400.0,
                "updated_at_unix_ms": unix_ms()
            }),
        ),
        (
            "monthly_gt",
            json!({
                "kind": "budget_info",
                "daily_spent_usd": 12.0,
                "daily_budget_usd": 120.0,
                "weekly_spent_usd": 100.0,
                "weekly_budget_usd": 360.0,
                "monthly_spent_usd": 401.0,
                "monthly_budget_usd": 400.0,
                "updated_at_unix_ms": unix_ms()
            }),
        ),
        (
            "monthly_eq",
            json!({
                "kind": "budget_info",
                "daily_spent_usd": 12.0,
                "daily_budget_usd": 120.0,
                "weekly_spent_usd": 100.0,
                "weekly_budget_usd": 360.0,
                "monthly_spent_usd": 400.0,
                "monthly_budget_usd": 400.0,
                "updated_at_unix_ms": unix_ms()
            }),
        ),
    ];

    for (tag, snapshot) in scenarios {
        assert_closed_provider_not_used_e2e(tag, snapshot).await;
    }
}
