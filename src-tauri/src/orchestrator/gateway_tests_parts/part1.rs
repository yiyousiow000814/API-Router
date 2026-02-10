    use std::collections::HashMap;
    use std::sync::atomic::AtomicU64;
    use std::sync::Arc;

    use std::sync::Mutex as StdMutex;
    use std::sync::MutexGuard as StdMutexGuard;

    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use parking_lot::RwLock;
    use tower::ServiceExt;

    use crate::orchestrator::config::{AppConfig, ListenConfig, ProviderConfig, RoutingConfig};
    use crate::orchestrator::gateway::{
        build_router, build_router_with_body_limit, decide_provider, open_store_dir, GatewayState,
        LastUsedRoute,
    };
    use crate::orchestrator::router::RouterState;
    use crate::orchestrator::secrets::SecretStore;
    use crate::orchestrator::store::unix_ms;
    use crate::orchestrator::upstream::UpstreamClient;
    use axum::routing::post;
    use axum::{Json, Router};
    use parking_lot::Mutex;
    use serde_json::json;

    static CODEX_ENV_LOCK: StdMutex<()> = StdMutex::new(());

    struct CodexSessionGuard<'a> {
        _lock: StdMutexGuard<'a, ()>,
        prev_env: Option<String>,
    }

    impl<'a> CodexSessionGuard<'a> {
        fn new(lock: StdMutexGuard<'a, ()>) -> Self {
            let prev_env = std::env::var("CODEX_HOME").ok();
            Self {
                _lock: lock,
                prev_env,
            }
        }
    }

    impl Drop for CodexSessionGuard<'_> {
        fn drop(&mut self) {
            if let Some(prev_env) = self.prev_env.take() {
                std::env::set_var("CODEX_HOME", prev_env);
            } else {
                std::env::remove_var("CODEX_HOME");
            }
        }
    }

    fn setup_codex_session(
        tmp: &tempfile::TempDir,
        session_id: &str,
        lines: &[serde_json::Value],
    ) -> CodexSessionGuard<'static> {
        let guard = CodexSessionGuard::new(CODEX_ENV_LOCK.lock().unwrap());
        std::env::set_var("CODEX_HOME", tmp.path());
        let sessions_dir = tmp
            .path()
            .join("sessions")
            .join("2026")
            .join("01")
            .join("31");
        std::fs::create_dir_all(&sessions_dir).unwrap();
        let session_file =
            sessions_dir.join(format!("rollout-2026-01-31T00-00-00-{session_id}.jsonl"));
        let mut body_txt = String::new();
        for line in lines {
            body_txt.push_str(&line.to_string());
            body_txt.push('\n');
        }
        std::fs::write(&session_file, body_txt).unwrap();
        guard
    }

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
