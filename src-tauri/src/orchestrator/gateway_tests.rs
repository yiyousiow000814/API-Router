#[cfg(test)]
mod tests {
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
}
