use std::sync::atomic::{AtomicUsize, Ordering};
use crate::orchestrator::gateway::provider_has_remaining_quota;

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

#[tokio::test]
async fn e2e_first_failure_refreshes_usage_once_and_closes_provider_before_retry() {
    let p1_hits = Arc::new(AtomicUsize::new(0));
    let p2_hits = Arc::new(AtomicUsize::new(0));
    let usage_hits = Arc::new(AtomicUsize::new(0));

    let p1_app = Router::new().route(
        "/v1/responses",
        post({
            let p1_hits = p1_hits.clone();
            move |_body: axum::extract::Json<serde_json::Value>| {
                p1_hits.fetch_add(1, Ordering::Relaxed);
                async move {
                    (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        Json(json!({"error": "p1 upstream failed"})),
                    )
                }
            }
        }),
    );
    let p1_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let p1_addr = p1_listener.local_addr().unwrap();
    let p1_base = format!("http://{}:{}/v1", p1_addr.ip(), p1_addr.port());
    tokio::spawn(async move {
        let _ = axum::serve(p1_listener, p1_app).await;
    });

    let p2_app = Router::new().route(
        "/v1/responses",
        post({
            let p2_hits = p2_hits.clone();
            move |_body: axum::extract::Json<serde_json::Value>| {
                p2_hits.fetch_add(1, Ordering::Relaxed);
                async move {
                    (
                        StatusCode::OK,
                        Json(json!({
                            "id": "resp_p2",
                            "output": [{"content": [{"type": "output_text", "text": "ok"}]}]
                        })),
                    )
                }
            }
        }),
    );
    let p2_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let p2_addr = p2_listener.local_addr().unwrap();
    let p2_base = format!("http://{}:{}/v1", p2_addr.ip(), p2_addr.port());
    tokio::spawn(async move {
        let _ = axum::serve(p2_listener, p2_app).await;
    });

    let usage_app = Router::new().route(
        "/api/backend/users/info",
        axum::routing::get({
            let usage_hits = usage_hits.clone();
            move || {
                usage_hits.fetch_add(1, Ordering::Relaxed);
                async move {
                    Json(json!({
                        "daily_spent_usd": 120.0,
                        "daily_budget_usd": 120.0,
                        "weekly_spent_usd": 120.0,
                        "weekly_budget_usd": 360.0,
                        "monthly_spent_usd": 120.0,
                        "monthly_budget_usd": 600.0
                    }))
                }
            }
        }),
    );
    let usage_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let usage_addr = usage_listener.local_addr().unwrap();
    let usage_base = format!("http://{}:{}", usage_addr.ip(), usage_addr.port());
    tokio::spawn(async move {
        let _ = axum::serve(usage_listener, usage_app).await;
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
            preferred_stable_seconds: 30,
            failure_threshold: 5,
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
                    usage_adapter: "budget_info".to_string(),
                    usage_base_url: Some(usage_base),
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
        ]),
        provider_order: vec!["p1".to_string(), "p2".to_string()],
    };

    let tmp = tempfile::tempdir().expect("tempdir");
    let store = open_store_dir(tmp.path().join("data")).expect("store");
    store
        .put_quota_snapshot(
            "p1",
            &json!({
                "kind": "budget_info",
                "daily_spent_usd": 1.0,
                "daily_budget_usd": 120.0,
                "weekly_spent_usd": 1.0,
                "weekly_budget_usd": 360.0,
                "monthly_spent_usd": 1.0,
                "monthly_budget_usd": 600.0,
                "updated_at_unix_ms": unix_ms()
            }),
        )
        .expect("seed stale quota");
    let secrets = SecretStore::new(tmp.path().join("secrets.json"));
    secrets
        .set_usage_token("p1", "usage-token-p1")
        .expect("set usage token");
    let router_state = Arc::new(RouterState::new(&cfg, unix_ms()));
    let state = GatewayState {
        cfg: Arc::new(RwLock::new(cfg)),
        router: router_state,
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
                .header("session_id", "sid-first-failure-refresh")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = resp.status();

    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    let body_text = String::from_utf8_lossy(&bytes).to_string();
    assert_eq!(
        status,
        StatusCode::OK,
        "status={status}, body={body_text}, p1_hits={}, p2_hits={}, usage_hits={}",
        p1_hits.load(Ordering::Relaxed),
        p2_hits.load(Ordering::Relaxed),
        usage_hits.load(Ordering::Relaxed)
    );
    let json_resp: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(json_resp.get("id").and_then(|v| v.as_str()), Some("resp_p2"));
    assert_eq!(p1_hits.load(Ordering::Relaxed), 1, "p1 should fail once");
    assert_eq!(p2_hits.load(Ordering::Relaxed), 1, "fallback provider should be used");
    assert_eq!(
        usage_hits.load(Ordering::Relaxed),
        1,
        "usage refresh should run exactly once after first failure"
    );

    let quota_snapshots = store.list_quota_snapshots();
    assert!(
        !provider_has_remaining_quota(&quota_snapshots, "p1"),
        "p1 should be closed after first failure-triggered usage refresh"
    );
}

#[tokio::test]
async fn e2e_failure_usage_refresh_only_runs_once_per_request() {
    let p1_hits = Arc::new(AtomicUsize::new(0));
    let p2_hits = Arc::new(AtomicUsize::new(0));
    let usage_hits = Arc::new(AtomicUsize::new(0));

    let p1_app = Router::new().route(
        "/v1/responses",
        post({
            let p1_hits = p1_hits.clone();
            move |_body: axum::extract::Json<serde_json::Value>| {
                p1_hits.fetch_add(1, Ordering::Relaxed);
                async move {
                    (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        Json(json!({"error": "p1 upstream failed"})),
                    )
                }
            }
        }),
    );
    let p1_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let p1_addr = p1_listener.local_addr().unwrap();
    let p1_base = format!("http://{}:{}/v1", p1_addr.ip(), p1_addr.port());
    tokio::spawn(async move {
        let _ = axum::serve(p1_listener, p1_app).await;
    });

    let p2_app = Router::new().route(
        "/v1/responses",
        post({
            let p2_hits = p2_hits.clone();
            move |_body: axum::extract::Json<serde_json::Value>| {
                p2_hits.fetch_add(1, Ordering::Relaxed);
                async move {
                    (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        Json(json!({"error": "p2 upstream failed"})),
                    )
                }
            }
        }),
    );
    let p2_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let p2_addr = p2_listener.local_addr().unwrap();
    let p2_base = format!("http://{}:{}/v1", p2_addr.ip(), p2_addr.port());
    tokio::spawn(async move {
        let _ = axum::serve(p2_listener, p2_app).await;
    });

    let usage_app = Router::new().route(
        "/api/backend/users/info",
        axum::routing::get({
            let usage_hits = usage_hits.clone();
            move |headers: axum::http::HeaderMap| {
                usage_hits.fetch_add(1, Ordering::Relaxed);
                async move {
                    let auth = headers
                        .get("authorization")
                        .and_then(|v| v.to_str().ok())
                        .unwrap_or_default();
                    let exhausted = auth.contains("usage-token-p1");
                    Json(json!({
                        "daily_spent_usd": if exhausted { 120.0 } else { 1.0 },
                        "daily_budget_usd": 120.0,
                        "weekly_spent_usd": 1.0,
                        "weekly_budget_usd": 360.0,
                        "monthly_spent_usd": 1.0,
                        "monthly_budget_usd": 600.0
                    }))
                }
            }
        }),
    );
    let usage_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let usage_addr = usage_listener.local_addr().unwrap();
    let usage_base = format!("http://{}:{}", usage_addr.ip(), usage_addr.port());
    tokio::spawn(async move {
        let _ = axum::serve(usage_listener, usage_app).await;
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
            preferred_stable_seconds: 30,
            failure_threshold: 5,
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
                    usage_adapter: "budget_info".to_string(),
                    usage_base_url: Some(usage_base.clone()),
                    api_key: String::new(),
                },
            ),
            (
                "p2".to_string(),
                ProviderConfig {
                    display_name: "P2".to_string(),
                    base_url: p2_base,
                    disabled: false,
                    usage_adapter: "budget_info".to_string(),
                    usage_base_url: Some(usage_base),
                    api_key: String::new(),
                },
            ),
        ]),
        provider_order: vec!["p1".to_string(), "p2".to_string()],
    };

    let tmp = tempfile::tempdir().expect("tempdir");
    let store = open_store_dir(tmp.path().join("data")).expect("store");
    let secrets = SecretStore::new(tmp.path().join("secrets.json"));
    secrets
        .set_usage_token("p1", "usage-token-p1")
        .expect("set usage token p1");
    secrets
        .set_usage_token("p2", "usage-token-p2")
        .expect("set usage token p2");
    let router_state = Arc::new(RouterState::new(&cfg, unix_ms()));
    let state = GatewayState {
        cfg: Arc::new(RwLock::new(cfg)),
        router: router_state,
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
                .header("session_id", "sid-refresh-once")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::BAD_GATEWAY);
    assert_eq!(p1_hits.load(Ordering::Relaxed), 1, "p1 should fail once");
    assert_eq!(p2_hits.load(Ordering::Relaxed), 1, "p2 should fail once");
    assert_eq!(
        usage_hits.load(Ordering::Relaxed),
        1,
        "usage refresh should run only once for first failure"
    );
}

#[tokio::test]
async fn e2e_provider_stays_skipped_until_usage_refresh_confirms_available() {
    let p1_hits = Arc::new(AtomicUsize::new(0));
    let p2_hits = Arc::new(AtomicUsize::new(0));
    let usage_hits = Arc::new(AtomicUsize::new(0));
    let p1_should_succeed = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let usage_should_succeed = Arc::new(std::sync::atomic::AtomicBool::new(false));

    let p1_app = Router::new().route(
        "/v1/responses",
        post({
            let p1_hits = p1_hits.clone();
            let p1_should_succeed = p1_should_succeed.clone();
            move |_body: axum::extract::Json<serde_json::Value>| {
                p1_hits.fetch_add(1, Ordering::Relaxed);
                let ok = p1_should_succeed.load(Ordering::Relaxed);
                async move {
                    if ok {
                        (
                            StatusCode::OK,
                            Json(json!({
                                "id": "resp_p1",
                                "output": [{"content": [{"type": "output_text", "text": "ok"}]}]
                            })),
                        )
                    } else {
                        (
                            StatusCode::INTERNAL_SERVER_ERROR,
                            Json(json!({"error": "p1 upstream failed"})),
                        )
                    }
                }
            }
        }),
    );
    let p1_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let p1_addr = p1_listener.local_addr().unwrap();
    let p1_base = format!("http://{}:{}/v1", p1_addr.ip(), p1_addr.port());
    tokio::spawn(async move {
        let _ = axum::serve(p1_listener, p1_app).await;
    });

    let p2_app = Router::new().route(
        "/v1/responses",
        post({
            let p2_hits = p2_hits.clone();
            move |_body: axum::extract::Json<serde_json::Value>| {
                p2_hits.fetch_add(1, Ordering::Relaxed);
                async move {
                    (
                        StatusCode::OK,
                        Json(json!({
                            "id": "resp_p2",
                            "output": [{"content": [{"type": "output_text", "text": "ok"}]}]
                        })),
                    )
                }
            }
        }),
    );
    let p2_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let p2_addr = p2_listener.local_addr().unwrap();
    let p2_base = format!("http://{}:{}/v1", p2_addr.ip(), p2_addr.port());
    tokio::spawn(async move {
        let _ = axum::serve(p2_listener, p2_app).await;
    });

    let usage_app = Router::new().route(
        "/api/backend/users/info",
        axum::routing::get({
            let usage_hits = usage_hits.clone();
            let usage_should_succeed = usage_should_succeed.clone();
            move || {
                usage_hits.fetch_add(1, Ordering::Relaxed);
                let ok = usage_should_succeed.load(Ordering::Relaxed);
                async move {
                    if ok {
                        (
                            StatusCode::OK,
                            Json(json!({
                                "daily_spent_usd": 1.0,
                                "daily_budget_usd": 120.0,
                                "weekly_spent_usd": 1.0,
                                "weekly_budget_usd": 360.0,
                                "monthly_spent_usd": 1.0,
                                "monthly_budget_usd": 600.0
                            })),
                        )
                    } else {
                        (
                            StatusCode::INTERNAL_SERVER_ERROR,
                            Json(json!({"error": "usage backend down"})),
                        )
                    }
                }
            }
        }),
    );
    let usage_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let usage_addr = usage_listener.local_addr().unwrap();
    let usage_base = format!("http://{}:{}", usage_addr.ip(), usage_addr.port());
    tokio::spawn(async move {
        let _ = axum::serve(usage_listener, usage_app).await;
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
            preferred_stable_seconds: 30,
            failure_threshold: 5,
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
                    usage_adapter: "budget_info".to_string(),
                    usage_base_url: Some(usage_base),
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
        ]),
        provider_order: vec!["p1".to_string(), "p2".to_string()],
    };

    let tmp = tempfile::tempdir().expect("tempdir");
    let store = open_store_dir(tmp.path().join("data")).expect("store");
    let secrets = SecretStore::new(tmp.path().join("secrets.json"));
    secrets
        .set_usage_token("p1", "usage-token-p1")
        .expect("set usage token");
    let router_state = Arc::new(RouterState::new(&cfg, unix_ms()));
    let state = GatewayState {
        cfg: Arc::new(RwLock::new(cfg)),
        router: router_state,
        store: store.clone(),
        upstream: UpstreamClient::new(),
        secrets,
        last_activity_unix_ms: Arc::new(AtomicU64::new(0)),
        last_used_by_session: Arc::new(RwLock::new(HashMap::new())),
        usage_base_speed_cache: Arc::new(RwLock::new(HashMap::new())),
        prev_id_support_cache: Arc::new(RwLock::new(HashMap::new())),
        client_sessions: Arc::new(RwLock::new(HashMap::new())),
    };

    let app = build_router(state.clone());
    let body = json!({
        "model": "gpt-test",
        "input": [{
            "type": "message",
            "role": "user",
            "content": [{"type": "input_text", "text": "hello"}]
        }],
        "stream": false
    });

    // First request: p1 fails, usage refresh fails, then fallback to p2.
    let resp1 = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/v1/responses")
                .method("POST")
                .header("content-type", "application/json")
                .header("session_id", "sid-usage-gate-1")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp1.status(), StatusCode::OK);
    assert_eq!(p1_hits.load(Ordering::Relaxed), 1);
    assert_eq!(p2_hits.load(Ordering::Relaxed), 1);
    assert_eq!(usage_hits.load(Ordering::Relaxed), 1);

    // Second request: p1 should still be skipped until usage is confirmed.
    let resp2 = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/v1/responses")
                .method("POST")
                .header("content-type", "application/json")
                .header("session_id", "sid-usage-gate-2")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp2.status(), StatusCode::OK);
    assert_eq!(
        p1_hits.load(Ordering::Relaxed),
        1,
        "p1 should remain skipped while usage confirmation is pending"
    );
    assert_eq!(p2_hits.load(Ordering::Relaxed), 2);
    assert_eq!(
        usage_hits.load(Ordering::Relaxed),
        1,
        "no extra auto usage refresh should happen while p1 is skipped"
    );

    // Confirm usage is healthy, then p1 can be routed again.
    usage_should_succeed.store(true, Ordering::Relaxed);
    let refreshed = crate::orchestrator::quota::refresh_quota_for_provider(&state, "p1").await;
    assert!(
        refreshed.last_error.is_empty() && refreshed.updated_at_unix_ms > 0,
        "manual refresh should succeed before reopening provider"
    );
    p1_should_succeed.store(true, Ordering::Relaxed);

    let resp3 = app
        .oneshot(
            Request::builder()
                .uri("/v1/responses")
                .method("POST")
                .header("content-type", "application/json")
                .header("session_id", "sid-usage-gate-3")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp3.status(), StatusCode::OK);
    assert_eq!(
        p1_hits.load(Ordering::Relaxed),
        2,
        "p1 should be retried only after usage confirms available"
    );
    assert_eq!(usage_hits.load(Ordering::Relaxed), 2);
}
