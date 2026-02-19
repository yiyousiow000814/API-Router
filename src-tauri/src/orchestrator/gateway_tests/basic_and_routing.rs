#[tokio::test]
async fn health_and_status_work_without_upstream() {
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

    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/health")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

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
}

#[test]
fn routing_info_event_only_logs_when_route_state_changes() {
    let last = LastUsedRoute {
        provider: "packycode".to_string(),
        reason: "preferred_unhealthy".to_string(),
        preferred: "openai".to_string(),
        unix_ms: unix_ms(),
    };

    assert!(should_log_routing_path_event(
        None,
        "packycode",
        "preferred_unhealthy",
        "openai",
        true,
    ));
    assert!(!should_log_routing_path_event(
        Some(&last),
        "packycode",
        "preferred_unhealthy",
        "openai",
        true,
    ));
    assert!(!should_log_routing_path_event(
        Some(&last),
        "packycode",
        "preferred_unhealthy",
        "openai",
        false,
    ));
    assert!(should_log_routing_path_event(
        Some(&last),
        "another-provider",
        "preferred_unhealthy",
        "openai",
        true,
    ));

    assert!(!should_log_routing_path_event(
        Some(&last),
        "openai",
        "preferred_healthy",
        "openai",
        true,
    ));
    assert!(is_back_to_preferred_transition(
        Some(&last),
        "openai",
        "openai",
    ));
}

#[test]
fn decide_provider_holds_fallback_during_preferred_stabilizing_window() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let store = open_store_dir(tmp.path().join("data")).expect("store");
    let secrets = SecretStore::new(tmp.path().join("secrets.json"));

    let mut providers = std::collections::BTreeMap::new();
    providers.insert(
        "p1".to_string(),
        ProviderConfig {
            display_name: "P1".to_string(),
            base_url: "https://example.com".to_string(),
            usage_adapter: String::new(),
            usage_base_url: None,
            api_key: String::new(),
        },
    );
    providers.insert(
        "p2".to_string(),
        ProviderConfig {
            display_name: "P2".to_string(),
            base_url: "https://example.com".to_string(),
            usage_adapter: String::new(),
            usage_base_url: None,
            api_key: String::new(),
        },
    );

    let cfg = AppConfig {
        listen: ListenConfig {
            host: "127.0.0.1".to_string(),
            port: 4000,
        },
        routing: RoutingConfig {
            preferred_provider: "p1".to_string(),
            session_preferred_providers: std::collections::BTreeMap::new(),
            auto_return_to_preferred: true,
            // Large window so the test is not time-sensitive.
            preferred_stable_seconds: 3600,
            failure_threshold: 2,
            cooldown_seconds: 30,
            request_timeout_seconds: 300,
        },
        providers,
        provider_order: vec!["p1".to_string(), "p2".to_string()],
    };

    let router = Arc::new(RouterState::new(&cfg, unix_ms()));
    let now = unix_ms();
    router.mark_failure("p1", &cfg, "boom", now);
    let state = GatewayState {
        cfg: Arc::new(RwLock::new(cfg.clone())),
        router,
        store,
        upstream: UpstreamClient::new(),
        secrets,
        last_activity_unix_ms: Arc::new(AtomicU64::new(0)),
        last_used_by_session: Arc::new(RwLock::new(HashMap::from([(
            "s1".to_string(),
            LastUsedRoute {
                provider: "p2".to_string(),
                reason: "preferred_unhealthy".to_string(),
                preferred: "p1".to_string(),
                unix_ms: unix_ms(),
            },
        )]))),
        usage_base_speed_cache: Arc::new(RwLock::new(HashMap::new())),
        prev_id_support_cache: Arc::new(RwLock::new(HashMap::new())),
        client_sessions: Arc::new(RwLock::new(HashMap::new())),
    };

    let (picked, reason) = decide_provider(&state, &cfg, "p1", "s1");
    assert_eq!(picked, "p2");
    assert_eq!(reason, "preferred_stabilizing");
}

#[test]
fn decide_provider_keeps_fallback_when_last_reason_already_preferred_stabilizing() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let store = open_store_dir(tmp.path().join("data")).expect("store");
    let secrets = SecretStore::new(tmp.path().join("secrets.json"));

    let mut providers = std::collections::BTreeMap::new();
    providers.insert(
        "p1".to_string(),
        ProviderConfig {
            display_name: "P1".to_string(),
            base_url: "https://example.com".to_string(),
            usage_adapter: String::new(),
            usage_base_url: None,
            api_key: String::new(),
        },
    );
    providers.insert(
        "p2".to_string(),
        ProviderConfig {
            display_name: "P2".to_string(),
            base_url: "https://example.com".to_string(),
            usage_adapter: String::new(),
            usage_base_url: None,
            api_key: String::new(),
        },
    );

    let cfg = AppConfig {
        listen: ListenConfig {
            host: "127.0.0.1".to_string(),
            port: 4000,
        },
        routing: RoutingConfig {
            preferred_provider: "p1".to_string(),
            session_preferred_providers: std::collections::BTreeMap::new(),
            auto_return_to_preferred: true,
            preferred_stable_seconds: 3600,
            failure_threshold: 2,
            cooldown_seconds: 30,
            request_timeout_seconds: 300,
        },
        providers,
        provider_order: vec!["p1".to_string(), "p2".to_string()],
    };

    let router = Arc::new(RouterState::new(&cfg, unix_ms()));
    let now = unix_ms();
    router.mark_failure("p1", &cfg, "boom", now);
    let state = GatewayState {
        cfg: Arc::new(RwLock::new(cfg.clone())),
        router,
        store,
        upstream: UpstreamClient::new(),
        secrets,
        last_activity_unix_ms: Arc::new(AtomicU64::new(0)),
        last_used_by_session: Arc::new(RwLock::new(HashMap::from([(
            "s1".to_string(),
            LastUsedRoute {
                provider: "p2".to_string(),
                reason: "preferred_stabilizing".to_string(),
                preferred: "p1".to_string(),
                unix_ms: unix_ms(),
            },
        )]))),
        usage_base_speed_cache: Arc::new(RwLock::new(HashMap::new())),
        prev_id_support_cache: Arc::new(RwLock::new(HashMap::new())),
        client_sessions: Arc::new(RwLock::new(HashMap::new())),
    };

    let (picked, reason) = decide_provider(&state, &cfg, "p1", "s1");
    assert_eq!(picked, "p2");
    assert_eq!(reason, "preferred_stabilizing");
}

#[test]
fn decide_provider_skips_fallback_with_no_remaining_quota() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let store = open_store_dir(tmp.path().join("data")).expect("store");
    let secrets = SecretStore::new(tmp.path().join("secrets.json"));

    let mut providers = std::collections::BTreeMap::new();
    providers.insert(
        "p1".to_string(),
        ProviderConfig {
            display_name: "P1".to_string(),
            base_url: "https://p1.example.com".to_string(),
            usage_adapter: String::new(),
            usage_base_url: None,
            api_key: String::new(),
        },
    );
    providers.insert(
        "p2".to_string(),
        ProviderConfig {
            display_name: "P2".to_string(),
            base_url: "https://p2.example.com".to_string(),
            usage_adapter: String::new(),
            usage_base_url: None,
            api_key: String::new(),
        },
    );
    providers.insert(
        "p3".to_string(),
        ProviderConfig {
            display_name: "P3".to_string(),
            base_url: "https://p3.example.com".to_string(),
            usage_adapter: String::new(),
            usage_base_url: None,
            api_key: String::new(),
        },
    );

    let cfg = AppConfig {
        listen: ListenConfig {
            host: "127.0.0.1".to_string(),
            port: 4000,
        },
        routing: RoutingConfig {
            preferred_provider: "p1".to_string(),
            session_preferred_providers: std::collections::BTreeMap::new(),
            auto_return_to_preferred: true,
            preferred_stable_seconds: 3600,
            failure_threshold: 1,
            cooldown_seconds: 30,
            request_timeout_seconds: 300,
        },
        providers,
        provider_order: vec!["p1".to_string(), "p2".to_string(), "p3".to_string()],
    };

    let router = Arc::new(RouterState::new(&cfg, unix_ms()));
    router.mark_failure("p1", &cfg, "boom", unix_ms());

    store
        .put_quota_snapshot(
            "p2",
            &json!({
                "kind": "token_stats",
                "remaining": 0.0,
                "today_used": 15000.0,
                "today_added": 15000.0,
                "updated_at_unix_ms": unix_ms()
            }),
        )
        .expect("quota snapshot");

    let state = GatewayState {
        cfg: Arc::new(RwLock::new(cfg.clone())),
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

    let (picked, reason) = decide_provider(&state, &cfg, "p1", "s1");
    assert_eq!(picked, "p3");
    assert_eq!(reason, "preferred_unhealthy");
}

#[test]
fn decide_provider_stabilizing_skips_last_provider_with_no_remaining_quota() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let store = open_store_dir(tmp.path().join("data")).expect("store");
    let secrets = SecretStore::new(tmp.path().join("secrets.json"));

    let mut providers = std::collections::BTreeMap::new();
    providers.insert(
        "p1".to_string(),
        ProviderConfig {
            display_name: "P1".to_string(),
            base_url: "https://p1.example.com".to_string(),
            usage_adapter: String::new(),
            usage_base_url: None,
            api_key: String::new(),
        },
    );
    providers.insert(
        "p2".to_string(),
        ProviderConfig {
            display_name: "P2".to_string(),
            base_url: "https://p2.example.com".to_string(),
            usage_adapter: String::new(),
            usage_base_url: None,
            api_key: String::new(),
        },
    );
    providers.insert(
        "p3".to_string(),
        ProviderConfig {
            display_name: "P3".to_string(),
            base_url: "https://p3.example.com".to_string(),
            usage_adapter: String::new(),
            usage_base_url: None,
            api_key: String::new(),
        },
    );

    let cfg = AppConfig {
        listen: ListenConfig {
            host: "127.0.0.1".to_string(),
            port: 4000,
        },
        routing: RoutingConfig {
            preferred_provider: "p1".to_string(),
            session_preferred_providers: std::collections::BTreeMap::new(),
            auto_return_to_preferred: true,
            preferred_stable_seconds: 3600,
            failure_threshold: 1,
            cooldown_seconds: 30,
            request_timeout_seconds: 300,
        },
        providers,
        provider_order: vec!["p1".to_string(), "p2".to_string(), "p3".to_string()],
    };

    let router = Arc::new(RouterState::new(&cfg, unix_ms()));
    router.mark_failure("p1", &cfg, "boom", unix_ms());

    store
        .put_quota_snapshot(
            "p2",
            &json!({
                "kind": "token_stats",
                "remaining": 0.0,
                "today_used": 15000.0,
                "today_added": 15000.0,
                "updated_at_unix_ms": unix_ms()
            }),
        )
        .expect("quota snapshot");

    let state = GatewayState {
        cfg: Arc::new(RwLock::new(cfg.clone())),
        router,
        store,
        upstream: UpstreamClient::new(),
        secrets,
        last_activity_unix_ms: Arc::new(AtomicU64::new(0)),
        last_used_by_session: Arc::new(RwLock::new(HashMap::from([(
            "s1".to_string(),
            LastUsedRoute {
                provider: "p2".to_string(),
                reason: "preferred_unhealthy".to_string(),
                preferred: "p1".to_string(),
                unix_ms: unix_ms(),
            },
        )]))),
        usage_base_speed_cache: Arc::new(RwLock::new(HashMap::new())),
        prev_id_support_cache: Arc::new(RwLock::new(HashMap::new())),
        client_sessions: Arc::new(RwLock::new(HashMap::new())),
    };

    let (picked, reason) = decide_provider(&state, &cfg, "p1", "s1");
    assert_eq!(picked, "p3");
    assert_eq!(reason, "preferred_stabilizing");
}

#[test]
fn decide_provider_respects_provider_order_for_fallback() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let store = open_store_dir(tmp.path().join("data")).expect("store");
    let secrets = SecretStore::new(tmp.path().join("secrets.json"));

    let mut providers = std::collections::BTreeMap::new();
    providers.insert(
        "alpha".to_string(),
        ProviderConfig {
            display_name: "Alpha".to_string(),
            base_url: "https://alpha.example.com".to_string(),
            usage_adapter: String::new(),
            usage_base_url: None,
            api_key: String::new(),
        },
    );
    providers.insert(
        "beta".to_string(),
        ProviderConfig {
            display_name: "Beta".to_string(),
            base_url: "https://beta.example.com".to_string(),
            usage_adapter: String::new(),
            usage_base_url: None,
            api_key: String::new(),
        },
    );
    providers.insert(
        "zeta".to_string(),
        ProviderConfig {
            display_name: "Zeta".to_string(),
            base_url: "https://zeta.example.com".to_string(),
            usage_adapter: String::new(),
            usage_base_url: None,
            api_key: String::new(),
        },
    );

    let cfg = AppConfig {
        listen: ListenConfig {
            host: "127.0.0.1".to_string(),
            port: 4000,
        },
        routing: RoutingConfig {
            preferred_provider: "alpha".to_string(),
            session_preferred_providers: std::collections::BTreeMap::new(),
            auto_return_to_preferred: false,
            preferred_stable_seconds: 3600,
            failure_threshold: 1,
            cooldown_seconds: 30,
            request_timeout_seconds: 300,
        },
        providers,
        // Non-alphabetical order: fallback should pick zeta first.
        provider_order: vec!["zeta".to_string(), "beta".to_string(), "alpha".to_string()],
    };

    let router = Arc::new(RouterState::new(&cfg, unix_ms()));
    router.mark_failure("alpha", &cfg, "boom", unix_ms());

    let state = GatewayState {
        cfg: Arc::new(RwLock::new(cfg.clone())),
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

    let (picked, reason) = decide_provider(&state, &cfg, "alpha", "s1");
    assert_eq!(picked, "zeta");
    assert_eq!(reason, "preferred_unhealthy");
}
