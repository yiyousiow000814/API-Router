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
            disabled: false,
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
            disabled: false,
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
            route_mode: crate::orchestrator::config::RouteMode::FollowPreferredAuto,
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
            disabled: false,
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
            disabled: false,
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
            route_mode: crate::orchestrator::config::RouteMode::FollowPreferredAuto,
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
fn decide_provider_balanced_auto_spreads_multi_sessions_deterministically() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let store = open_store_dir(tmp.path().join("data")).expect("store");
    let secrets = SecretStore::new(tmp.path().join("secrets.json"));

    let mut providers = std::collections::BTreeMap::new();
    for name in ["p1", "p2", "p3"] {
        providers.insert(
            name.to_string(),
            ProviderConfig {
                display_name: name.to_uppercase(),
                base_url: "https://example.com".to_string(),
                disabled: false,
                usage_adapter: String::new(),
                usage_base_url: None,
                api_key: String::new(),
            },
        );
    }

    let cfg = AppConfig {
        listen: ListenConfig {
            host: "127.0.0.1".to_string(),
            port: 4000,
        },
        routing: RoutingConfig {
            preferred_provider: "p1".to_string(),
            session_preferred_providers: std::collections::BTreeMap::new(),
            route_mode: crate::orchestrator::config::RouteMode::BalancedAuto,
            auto_return_to_preferred: true,
            preferred_stable_seconds: 30,
            failure_threshold: 2,
            cooldown_seconds: 30,
            request_timeout_seconds: 300,
        },
        providers,
        provider_order: vec!["p1".to_string(), "p2".to_string(), "p3".to_string()],
    };

    let now = unix_ms();
    let mk_runtime = |sid: &str| crate::orchestrator::gateway::ClientSessionRuntime {
        codex_session_id: sid.to_string(),
        pid: 1,
        wt_session: Some("wt-balanced".to_string()),
        last_request_unix_ms: now,
        last_discovered_unix_ms: now,
        last_reported_model_provider: Some(GATEWAY_MODEL_PROVIDER_ID.to_string()),
        last_reported_model: None,
        last_reported_base_url: Some("http://127.0.0.1:4000/v1".to_string()),
        agent_parent_session_id: None,
        is_agent: false,
        is_review: false,
        confirmed_router: true,
    };
    let state = GatewayState {
        cfg: Arc::new(RwLock::new(cfg.clone())),
        router: Arc::new(RouterState::new(&cfg, now)),
        store,
        upstream: UpstreamClient::new(),
        secrets,
        last_activity_unix_ms: Arc::new(AtomicU64::new(0)),
        last_used_by_session: Arc::new(RwLock::new(HashMap::from([
            (
                "session-a".to_string(),
                LastUsedRoute {
                    provider: "p1".to_string(),
                    reason: "preferred_healthy".to_string(),
                    preferred: "p1".to_string(),
                    unix_ms: now,
                },
            ),
            (
                "session-b".to_string(),
                LastUsedRoute {
                    provider: "p2".to_string(),
                    reason: "preferred_unhealthy".to_string(),
                    preferred: "p1".to_string(),
                    unix_ms: now,
                },
            ),
        ]))),
        usage_base_speed_cache: Arc::new(RwLock::new(HashMap::new())),
        prev_id_support_cache: Arc::new(RwLock::new(HashMap::new())),
        client_sessions: Arc::new(RwLock::new(HashMap::from([
            ("session-a".to_string(), mk_runtime("session-a")),
            ("session-b".to_string(), mk_runtime("session-b")),
            ("session-c".to_string(), mk_runtime("session-c")),
        ]))),
    };

    let (a1, r1) = decide_provider(&state, &cfg, "p1", "session-a");
    let (a2, r2) = decide_provider(&state, &cfg, "p1", "session-a");
    assert_eq!(a1, a2, "same session should map stably");
    assert_eq!(r1, "balanced_auto");
    assert_eq!(r2, "balanced_auto");

    let (b1, r3) = decide_provider(&state, &cfg, "p1", "session-b");
    let (b2, r4) = decide_provider(&state, &cfg, "p1", "session-b");
    assert_eq!(b1, b2, "same session should map stably");
    assert_eq!(r3, "balanced_auto");
    assert_eq!(r4, "balanced_auto");

    let (c1, r5) = decide_provider(&state, &cfg, "p1", "session-c");
    assert_eq!(r5, "balanced_auto");

    let unique = std::collections::BTreeSet::from([a1, b1, c1]);
    assert!(
        unique.len() >= 2,
        "balanced mode should avoid routing all active sessions to one provider"
    );
}

#[test]
fn decide_provider_balanced_auto_single_session_follows_preferred() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let store = open_store_dir(tmp.path().join("data")).expect("store");
    let secrets = SecretStore::new(tmp.path().join("secrets.json"));

    let mut providers = std::collections::BTreeMap::new();
    for name in ["p1", "p2"] {
        providers.insert(
            name.to_string(),
            ProviderConfig {
                display_name: name.to_uppercase(),
                base_url: "https://example.com".to_string(),
                disabled: false,
                usage_adapter: String::new(),
                usage_base_url: None,
                api_key: String::new(),
            },
        );
    }

    let cfg = AppConfig {
        listen: ListenConfig {
            host: "127.0.0.1".to_string(),
            port: 4000,
        },
        routing: RoutingConfig {
            preferred_provider: "p1".to_string(),
            session_preferred_providers: std::collections::BTreeMap::new(),
            route_mode: crate::orchestrator::config::RouteMode::BalancedAuto,
            auto_return_to_preferred: true,
            preferred_stable_seconds: 30,
            failure_threshold: 2,
            cooldown_seconds: 30,
            request_timeout_seconds: 300,
        },
        providers,
        provider_order: vec!["p1".to_string(), "p2".to_string()],
    };

    let state = GatewayState {
        cfg: Arc::new(RwLock::new(cfg.clone())),
        router: Arc::new(RouterState::new(&cfg, unix_ms())),
        store,
        upstream: UpstreamClient::new(),
        secrets,
        last_activity_unix_ms: Arc::new(AtomicU64::new(0)),
        last_used_by_session: Arc::new(RwLock::new(HashMap::new())),
        usage_base_speed_cache: Arc::new(RwLock::new(HashMap::new())),
        prev_id_support_cache: Arc::new(RwLock::new(HashMap::new())),
        client_sessions: Arc::new(RwLock::new(HashMap::new())),
    };

    let (picked, reason) = decide_provider(&state, &cfg, "p1", "session-single");
    assert_eq!(picked, "p1");
    assert_eq!(reason, "preferred_healthy");
}

#[test]
fn decide_provider_balanced_auto_sticks_to_verified_session_assignment_even_if_preferred_changes() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let store = open_store_dir(tmp.path().join("data")).expect("store");
    let secrets = SecretStore::new(tmp.path().join("secrets.json"));

    let mut providers = std::collections::BTreeMap::new();
    for name in ["p1", "p2"] {
        providers.insert(
            name.to_string(),
            ProviderConfig {
                display_name: name.to_uppercase(),
                base_url: format!("https://{name}.example.com"),
                disabled: false,
                usage_adapter: String::new(),
                usage_base_url: None,
                api_key: String::new(),
            },
        );
    }

    let mut cfg = AppConfig {
        listen: ListenConfig {
            host: "127.0.0.1".to_string(),
            port: 4000,
        },
        routing: RoutingConfig {
            preferred_provider: "p1".to_string(),
            session_preferred_providers: std::collections::BTreeMap::new(),
            route_mode: crate::orchestrator::config::RouteMode::BalancedAuto,
            auto_return_to_preferred: true,
            preferred_stable_seconds: 30,
            failure_threshold: 2,
            cooldown_seconds: 30,
            request_timeout_seconds: 300,
        },
        providers,
        provider_order: vec!["p1".to_string(), "p2".to_string()],
    };
    let state = GatewayState {
        cfg: Arc::new(RwLock::new(cfg.clone())),
        router: Arc::new(RouterState::new(&cfg, unix_ms())),
        store,
        upstream: UpstreamClient::new(),
        secrets,
        last_activity_unix_ms: Arc::new(AtomicU64::new(0)),
        last_used_by_session: Arc::new(RwLock::new(HashMap::new())),
        usage_base_speed_cache: Arc::new(RwLock::new(HashMap::new())),
        prev_id_support_cache: Arc::new(RwLock::new(HashMap::new())),
        client_sessions: Arc::new(RwLock::new(HashMap::from([(
            "session-main".to_string(),
            crate::orchestrator::gateway::ClientSessionRuntime {
                codex_session_id: "session-main".to_string(),
                pid: 100,
                wt_session: Some("wt-1".to_string()),
                last_request_unix_ms: unix_ms(),
                last_discovered_unix_ms: unix_ms(),
                last_reported_model_provider: Some(GATEWAY_MODEL_PROVIDER_ID.to_string()),
                last_reported_model: None,
                last_reported_base_url: Some("http://127.0.0.1:4000/v1".to_string()),
                agent_parent_session_id: None,
                is_agent: false,
                is_review: false,
                confirmed_router: true,
            },
        )]))),
    };

    let (first_provider, _) = decide_provider(&state, &cfg, "p1", "session-main");
    assert_eq!(first_provider, "p1");

    cfg.routing.preferred_provider = "p2".to_string();
    let (second_provider, _) = decide_provider(&state, &cfg, "p2", "session-main");
    assert_eq!(second_provider, "p1");
}

#[test]
fn decide_provider_balanced_auto_agent_session_follows_parent_assignment() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let store = open_store_dir(tmp.path().join("data")).expect("store");
    let secrets = SecretStore::new(tmp.path().join("secrets.json"));

    let mut providers = std::collections::BTreeMap::new();
    for name in ["p1", "p2"] {
        providers.insert(
            name.to_string(),
            ProviderConfig {
                display_name: name.to_uppercase(),
                base_url: format!("https://{name}.example.com"),
                disabled: false,
                usage_adapter: String::new(),
                usage_base_url: None,
                api_key: String::new(),
            },
        );
    }

    let mut cfg = AppConfig {
        listen: ListenConfig {
            host: "127.0.0.1".to_string(),
            port: 4000,
        },
        routing: RoutingConfig {
            preferred_provider: "p1".to_string(),
            session_preferred_providers: std::collections::BTreeMap::new(),
            route_mode: crate::orchestrator::config::RouteMode::BalancedAuto,
            auto_return_to_preferred: true,
            preferred_stable_seconds: 30,
            failure_threshold: 2,
            cooldown_seconds: 30,
            request_timeout_seconds: 300,
        },
        providers,
        provider_order: vec!["p1".to_string(), "p2".to_string()],
    };
    let now = unix_ms();
    let state = GatewayState {
        cfg: Arc::new(RwLock::new(cfg.clone())),
        router: Arc::new(RouterState::new(&cfg, now)),
        store,
        upstream: UpstreamClient::new(),
        secrets,
        last_activity_unix_ms: Arc::new(AtomicU64::new(0)),
        last_used_by_session: Arc::new(RwLock::new(HashMap::new())),
        usage_base_speed_cache: Arc::new(RwLock::new(HashMap::new())),
        prev_id_support_cache: Arc::new(RwLock::new(HashMap::new())),
        client_sessions: Arc::new(RwLock::new(HashMap::from([
            (
                "main-session".to_string(),
                crate::orchestrator::gateway::ClientSessionRuntime {
                    codex_session_id: "main-session".to_string(),
                    pid: 42,
                    wt_session: Some("wt-main".to_string()),
                    last_request_unix_ms: now,
                    last_discovered_unix_ms: now,
                    last_reported_model_provider: Some(GATEWAY_MODEL_PROVIDER_ID.to_string()),
                    last_reported_model: None,
                    last_reported_base_url: Some("http://127.0.0.1:4000/v1".to_string()),
                    agent_parent_session_id: None,
                    is_agent: false,
                    is_review: false,
                    confirmed_router: true,
                },
            ),
            (
                "agent-session".to_string(),
                crate::orchestrator::gateway::ClientSessionRuntime {
                    codex_session_id: "agent-session".to_string(),
                    pid: 43,
                    wt_session: Some("wt-main".to_string()),
                    last_request_unix_ms: now,
                    last_discovered_unix_ms: now,
                    last_reported_model_provider: Some(GATEWAY_MODEL_PROVIDER_ID.to_string()),
                    last_reported_model: None,
                    last_reported_base_url: Some("http://127.0.0.1:4000/v1".to_string()),
                    agent_parent_session_id: Some("main-session".to_string()),
                    is_agent: true,
                    is_review: false,
                    confirmed_router: true,
                },
            ),
        ]))),
    };

    let (main_provider, _) = decide_provider(&state, &cfg, "p1", "main-session");
    assert_eq!(main_provider, "p1");

    cfg.routing.preferred_provider = "p2".to_string();
    let (agent_provider, _) = decide_provider(&state, &cfg, "p2", "agent-session");
    assert_eq!(agent_provider, "p1");
}

#[test]
fn decide_provider_balanced_auto_persists_assignment_across_restart() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let data_dir = tmp.path().join("data");

    let mut providers = std::collections::BTreeMap::new();
    for name in ["p1", "p2"] {
        providers.insert(
            name.to_string(),
            ProviderConfig {
                display_name: name.to_uppercase(),
                base_url: format!("https://{name}.example.com"),
                disabled: false,
                usage_adapter: String::new(),
                usage_base_url: None,
                api_key: String::new(),
            },
        );
    }

    let mut cfg1 = AppConfig {
        listen: ListenConfig {
            host: "127.0.0.1".to_string(),
            port: 4000,
        },
        routing: RoutingConfig {
            preferred_provider: "p1".to_string(),
            session_preferred_providers: std::collections::BTreeMap::new(),
            route_mode: crate::orchestrator::config::RouteMode::BalancedAuto,
            auto_return_to_preferred: true,
            preferred_stable_seconds: 30,
            failure_threshold: 2,
            cooldown_seconds: 30,
            request_timeout_seconds: 300,
        },
        providers: providers.clone(),
        provider_order: vec!["p1".to_string(), "p2".to_string()],
    };
    let now = unix_ms();
    let session_runtime = crate::orchestrator::gateway::ClientSessionRuntime {
        codex_session_id: "session-main".to_string(),
        pid: 123,
        wt_session: Some("wt-main".to_string()),
        last_request_unix_ms: now,
        last_discovered_unix_ms: now,
        last_reported_model_provider: Some(GATEWAY_MODEL_PROVIDER_ID.to_string()),
        last_reported_model: None,
        last_reported_base_url: Some("http://127.0.0.1:4000/v1".to_string()),
        agent_parent_session_id: None,
        is_agent: false,
        is_review: false,
        confirmed_router: true,
    };

    let state1 = GatewayState {
        cfg: Arc::new(RwLock::new(cfg1.clone())),
        router: Arc::new(RouterState::new(&cfg1, now)),
        store: open_store_dir(data_dir.clone()).expect("store"),
        upstream: UpstreamClient::new(),
        secrets: SecretStore::new(tmp.path().join("secrets-1.json")),
        last_activity_unix_ms: Arc::new(AtomicU64::new(0)),
        last_used_by_session: Arc::new(RwLock::new(HashMap::new())),
        usage_base_speed_cache: Arc::new(RwLock::new(HashMap::new())),
        prev_id_support_cache: Arc::new(RwLock::new(HashMap::new())),
        client_sessions: Arc::new(RwLock::new(HashMap::from([(
            "session-main".to_string(),
            session_runtime.clone(),
        )]))),
    };

    let (first_provider, _) = decide_provider(&state1, &cfg1, "p1", "session-main");
    assert_eq!(first_provider, "p1");

    cfg1.routing.preferred_provider = "p2".to_string();
    let state2 = GatewayState {
        cfg: Arc::new(RwLock::new(cfg1.clone())),
        router: Arc::new(RouterState::new(&cfg1, now.saturating_add(5_000))),
        store: open_store_dir(data_dir).expect("store"),
        upstream: UpstreamClient::new(),
        secrets: SecretStore::new(tmp.path().join("secrets-2.json")),
        last_activity_unix_ms: Arc::new(AtomicU64::new(0)),
        last_used_by_session: Arc::new(RwLock::new(HashMap::new())),
        usage_base_speed_cache: Arc::new(RwLock::new(HashMap::new())),
        prev_id_support_cache: Arc::new(RwLock::new(HashMap::new())),
        client_sessions: Arc::new(RwLock::new(HashMap::from([(
            "session-main".to_string(),
            session_runtime,
        )]))),
    };
    let (second_provider, _) = decide_provider(&state2, &cfg1, "p2", "session-main");
    assert_eq!(second_provider, "p1");
}

#[test]
fn decide_provider_balanced_auto_keeps_provider_when_alternative_shares_same_api_key() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let store = open_store_dir(tmp.path().join("data")).expect("store");
    let secrets = SecretStore::new(tmp.path().join("secrets.json"));
    secrets.set_provider_key("p1", "same-key").expect("set key p1");
    secrets.set_provider_key("p2", "same-key").expect("set key p2");
    secrets
        .set_provider_key("p3", "another-key")
        .expect("set key p3");

    let mut providers = std::collections::BTreeMap::new();
    for name in ["p1", "p2", "p3"] {
        providers.insert(
            name.to_string(),
            ProviderConfig {
                display_name: name.to_uppercase(),
                base_url: format!("https://{name}.example.com"),
                disabled: false,
                usage_adapter: String::new(),
                usage_base_url: None,
                api_key: String::new(),
            },
        );
    }

    let mut cfg = AppConfig {
        listen: ListenConfig {
            host: "127.0.0.1".to_string(),
            port: 4000,
        },
        routing: RoutingConfig {
            preferred_provider: "p1".to_string(),
            session_preferred_providers: std::collections::BTreeMap::new(),
            route_mode: crate::orchestrator::config::RouteMode::BalancedAuto,
            auto_return_to_preferred: true,
            preferred_stable_seconds: 30,
            failure_threshold: 2,
            cooldown_seconds: 30,
            request_timeout_seconds: 300,
        },
        providers,
        provider_order: vec!["p1".to_string(), "p2".to_string(), "p3".to_string()],
    };
    let now = unix_ms();
    let state = GatewayState {
        cfg: Arc::new(RwLock::new(cfg.clone())),
        router: Arc::new(RouterState::new(&cfg, now)),
        store,
        upstream: UpstreamClient::new(),
        secrets,
        last_activity_unix_ms: Arc::new(AtomicU64::new(0)),
        last_used_by_session: Arc::new(RwLock::new(HashMap::new())),
        usage_base_speed_cache: Arc::new(RwLock::new(HashMap::new())),
        prev_id_support_cache: Arc::new(RwLock::new(HashMap::new())),
        client_sessions: Arc::new(RwLock::new(HashMap::from([(
            "session-main".to_string(),
            crate::orchestrator::gateway::ClientSessionRuntime {
                codex_session_id: "session-main".to_string(),
                pid: 1,
                wt_session: Some("wt-main".to_string()),
                last_request_unix_ms: now,
                last_discovered_unix_ms: now,
                last_reported_model_provider: Some(GATEWAY_MODEL_PROVIDER_ID.to_string()),
                last_reported_model: None,
                last_reported_base_url: Some("http://127.0.0.1:4000/v1".to_string()),
                agent_parent_session_id: None,
                is_agent: false,
                is_review: false,
                confirmed_router: true,
            },
        )]))),
    };

    state.store.put_session_route_assignment(
        "session-main",
        "p1",
        now.saturating_sub(24 * 60 * 60 * 1000 + 60_000),
    );
    cfg.routing.preferred_provider = "p2".to_string();
    let (picked, _) = decide_provider(&state, &cfg, "p2", "session-main");
    assert_eq!(picked, "p1");
}

#[test]
fn decide_provider_balanced_auto_rebalances_after_24h_when_assignment_is_skewed() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let store = open_store_dir(tmp.path().join("data")).expect("store");
    let secrets = SecretStore::new(tmp.path().join("secrets.json"));
    secrets.set_provider_key("p1", "k1").expect("set key p1");
    secrets.set_provider_key("p2", "k2").expect("set key p2");

    let mut providers = std::collections::BTreeMap::new();
    for name in ["p1", "p2"] {
        providers.insert(
            name.to_string(),
            ProviderConfig {
                display_name: name.to_uppercase(),
                base_url: format!("https://{name}.example.com"),
                disabled: false,
                usage_adapter: String::new(),
                usage_base_url: None,
                api_key: String::new(),
            },
        );
    }

    let cfg = AppConfig {
        listen: ListenConfig {
            host: "127.0.0.1".to_string(),
            port: 4000,
        },
        routing: RoutingConfig {
            preferred_provider: "p1".to_string(),
            session_preferred_providers: std::collections::BTreeMap::new(),
            route_mode: crate::orchestrator::config::RouteMode::BalancedAuto,
            auto_return_to_preferred: true,
            preferred_stable_seconds: 30,
            failure_threshold: 2,
            cooldown_seconds: 30,
            request_timeout_seconds: 300,
        },
        providers,
        provider_order: vec!["p1".to_string(), "p2".to_string()],
    };
    let now = unix_ms();
    let state = GatewayState {
        cfg: Arc::new(RwLock::new(cfg.clone())),
        router: Arc::new(RouterState::new(&cfg, now)),
        store,
        upstream: UpstreamClient::new(),
        secrets,
        last_activity_unix_ms: Arc::new(AtomicU64::new(0)),
        last_used_by_session: Arc::new(RwLock::new(HashMap::new())),
        usage_base_speed_cache: Arc::new(RwLock::new(HashMap::new())),
        prev_id_support_cache: Arc::new(RwLock::new(HashMap::new())),
        client_sessions: Arc::new(RwLock::new(HashMap::from([(
            "session-main".to_string(),
            crate::orchestrator::gateway::ClientSessionRuntime {
                codex_session_id: "session-main".to_string(),
                pid: 1,
                wt_session: Some("wt-main".to_string()),
                last_request_unix_ms: now,
                last_discovered_unix_ms: now,
                last_reported_model_provider: Some(GATEWAY_MODEL_PROVIDER_ID.to_string()),
                last_reported_model: None,
                last_reported_base_url: Some("http://127.0.0.1:4000/v1".to_string()),
                agent_parent_session_id: None,
                is_agent: false,
                is_review: false,
                confirmed_router: true,
            },
        )]))),
    };

    let stale_ms = now.saturating_sub(24 * 60 * 60 * 1000 + 60_000);
    state
        .store
        .put_session_route_assignment("session-main", "p1", stale_ms);
    state
        .store
        .put_session_route_assignment("session-a", "p1", now);
    state
        .store
        .put_session_route_assignment("session-b", "p1", now);
    state
        .store
        .put_session_route_assignment("session-c", "p1", now);

    let (picked, _) = decide_provider(&state, &cfg, "p1", "session-main");
    assert_eq!(picked, "p2");
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
            disabled: false,
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
            disabled: false,
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
            disabled: false,
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
            route_mode: crate::orchestrator::config::RouteMode::FollowPreferredAuto,
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
fn decide_provider_skips_fallback_when_daily_budget_exhausted() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let store = open_store_dir(tmp.path().join("data")).expect("store");
    let secrets = SecretStore::new(tmp.path().join("secrets.json"));

    let mut providers = std::collections::BTreeMap::new();
    providers.insert(
        "p1".to_string(),
        ProviderConfig {
            display_name: "P1".to_string(),
            base_url: "https://p1.example.com".to_string(),
            disabled: false,
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
            disabled: false,
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
            disabled: false,
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
            route_mode: crate::orchestrator::config::RouteMode::FollowPreferredAuto,
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
                "kind": "budget_info",
                "daily_spent_usd": 120.181,
                "daily_budget_usd": 120.0,
                "weekly_spent_usd": 198.776,
                "weekly_budget_usd": 360.0,
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

fn decide_with_budget_snapshot_for_p2(snapshot: serde_json::Value) -> (String, &'static str) {
    let tmp = tempfile::tempdir().expect("tempdir");
    let store = open_store_dir(tmp.path().join("data")).expect("store");
    let secrets = SecretStore::new(tmp.path().join("secrets.json"));

    let mut providers = std::collections::BTreeMap::new();
    providers.insert(
        "p1".to_string(),
        ProviderConfig {
            display_name: "P1".to_string(),
            base_url: "https://p1.example.com".to_string(),
            disabled: false,
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
            disabled: false,
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
            disabled: false,
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
            route_mode: crate::orchestrator::config::RouteMode::FollowPreferredAuto,
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

    store.put_quota_snapshot("p2", &snapshot).expect("quota snapshot");

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

    decide_provider(&state, &cfg, "p1", "s1")
}

#[test]
fn decide_provider_skips_fallback_when_daily_budget_equals_limit() {
    let (picked, reason) = decide_with_budget_snapshot_for_p2(json!({
        "kind": "budget_info",
        "daily_spent_usd": 120.0,
        "daily_budget_usd": 120.0,
        "weekly_spent_usd": 10.0,
        "weekly_budget_usd": 360.0,
        "monthly_spent_usd": 20.0,
        "monthly_budget_usd": 400.0,
        "updated_at_unix_ms": unix_ms()
    }));
    assert_eq!(picked, "p3");
    assert_eq!(reason, "preferred_unhealthy");
}

#[test]
fn decide_provider_skips_fallback_when_weekly_budget_exhausted() {
    let (picked, reason) = decide_with_budget_snapshot_for_p2(json!({
        "kind": "budget_info",
        "daily_spent_usd": 12.0,
        "daily_budget_usd": 120.0,
        "weekly_spent_usd": 361.0,
        "weekly_budget_usd": 360.0,
        "monthly_spent_usd": 20.0,
        "monthly_budget_usd": 400.0,
        "updated_at_unix_ms": unix_ms()
    }));
    assert_eq!(picked, "p3");
    assert_eq!(reason, "preferred_unhealthy");
}

#[test]
fn decide_provider_skips_fallback_when_monthly_budget_exhausted() {
    let (picked, reason) = decide_with_budget_snapshot_for_p2(json!({
        "kind": "budget_info",
        "daily_spent_usd": 12.0,
        "daily_budget_usd": 120.0,
        "weekly_spent_usd": 100.0,
        "weekly_budget_usd": 360.0,
        "monthly_spent_usd": 401.0,
        "monthly_budget_usd": 400.0,
        "updated_at_unix_ms": unix_ms()
    }));
    assert_eq!(picked, "p3");
    assert_eq!(reason, "preferred_unhealthy");
}

#[test]
fn decide_provider_budget_cap_wins_over_positive_remaining_field() {
    let (picked, reason) = decide_with_budget_snapshot_for_p2(json!({
        "kind": "budget_info",
        "remaining": 999.0,
        "daily_spent_usd": 120.1,
        "daily_budget_usd": 120.0,
        "weekly_spent_usd": 180.0,
        "weekly_budget_usd": 360.0,
        "monthly_spent_usd": 200.0,
        "monthly_budget_usd": 400.0,
        "updated_at_unix_ms": unix_ms()
    }));
    assert_eq!(picked, "p3");
    assert_eq!(reason, "preferred_unhealthy");
}

#[test]
fn decide_provider_with_budget_fields_still_closes_when_remaining_is_zero() {
    let (picked, reason) = decide_with_budget_snapshot_for_p2(json!({
        "kind": "budget_info",
        "remaining": 0.0,
        "daily_spent_usd": 20.0,
        "daily_budget_usd": 120.0,
        "weekly_spent_usd": 80.0,
        "weekly_budget_usd": 360.0,
        "monthly_spent_usd": 100.0,
        "monthly_budget_usd": 400.0,
        "updated_at_unix_ms": unix_ms()
    }));
    assert_eq!(picked, "p3");
    assert_eq!(reason, "preferred_unhealthy");
}

#[test]
fn decide_provider_manual_override_falls_back_when_daily_budget_exhausted() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let store = open_store_dir(tmp.path().join("data")).expect("store");
    let secrets = SecretStore::new(tmp.path().join("secrets.json"));

    let mut providers = std::collections::BTreeMap::new();
    providers.insert(
        "p1".to_string(),
        ProviderConfig {
            display_name: "P1".to_string(),
            base_url: "https://p1.example.com".to_string(),
            disabled: false,
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
            disabled: false,
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
            route_mode: crate::orchestrator::config::RouteMode::FollowPreferredAuto,
            auto_return_to_preferred: true,
            preferred_stable_seconds: 3600,
            failure_threshold: 1,
            cooldown_seconds: 30,
            request_timeout_seconds: 300,
        },
        providers,
        provider_order: vec!["p1".to_string(), "p2".to_string()],
    };

    let router = Arc::new(RouterState::new(&cfg, unix_ms()));
    router.set_manual_override(Some("p2".to_string()));

    store
        .put_quota_snapshot(
            "p2",
            &json!({
                "kind": "budget_info",
                "daily_spent_usd": 120.181,
                "daily_budget_usd": 120.0,
                "weekly_spent_usd": 198.776,
                "weekly_budget_usd": 360.0,
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
    assert_eq!(picked, "p1");
    assert_eq!(reason, "manual_override_unhealthy");
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
            disabled: false,
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
            disabled: false,
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
            disabled: false,
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
            route_mode: crate::orchestrator::config::RouteMode::FollowPreferredAuto,
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
            disabled: false,
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
            disabled: false,
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
            disabled: false,
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
            route_mode: crate::orchestrator::config::RouteMode::FollowPreferredAuto,
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
