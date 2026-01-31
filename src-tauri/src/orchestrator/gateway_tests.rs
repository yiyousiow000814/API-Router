#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::atomic::AtomicU64;
    use std::sync::Arc;

    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use parking_lot::RwLock;
    use tower::ServiceExt;

    use crate::orchestrator::config::{AppConfig, ListenConfig, ProviderConfig, RoutingConfig};
    use crate::orchestrator::gateway::{build_router, open_store_dir, GatewayState};
    use crate::orchestrator::router::RouterState;
    use crate::orchestrator::secrets::SecretStore;
    use crate::orchestrator::store::unix_ms;
    use crate::orchestrator::upstream::UpstreamClient;
    use axum::routing::post;
    use axum::{Json, Router};
    use parking_lot::Mutex;
    use serde_json::json;

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
            last_used_provider: Arc::new(RwLock::new(None)),
            last_used_reason: Arc::new(RwLock::new(None)),
            usage_base_speed_cache: Arc::new(RwLock::new(HashMap::new())),
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
            last_used_provider: Arc::new(RwLock::new(None)),
            last_used_reason: Arc::new(RwLock::new(None)),
            usage_base_speed_cache: Arc::new(RwLock::new(HashMap::new())),
        };

        let app = build_router(state);
        let input = json!({
            "type": "message",
            "role": "user",
            "content": [{
                "type": "tool_output",
                "tool_call_id": "call_1",
                "output": "C:\\\\Users\\\\yiyou\\\\Agent-Orchestrator"
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
            last_used_provider: Arc::new(RwLock::new(None)),
            last_used_reason: Arc::new(RwLock::new(None)),
            usage_base_speed_cache: Arc::new(RwLock::new(HashMap::new())),
        };

        let app = build_router(state);
        let input = json!([{
            "type": "message",
            "role": "user",
            "content": [{
                "type": "tool_output",
                "tool_call_id": "call_1",
                "output": "C:\\\\Users\\\\yiyou\\\\Agent-Orchestrator"
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
            last_used_provider: Arc::new(RwLock::new(None)),
            last_used_reason: Arc::new(RwLock::new(None)),
            usage_base_speed_cache: Arc::new(RwLock::new(HashMap::new())),
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
        let router = Arc::new(RouterState::new(&cfg, unix_ms()));
        let state = GatewayState {
            cfg: Arc::new(RwLock::new(cfg)),
            router,
            store: store.clone(),
            upstream: UpstreamClient::new(),
            secrets,
            last_activity_unix_ms: Arc::new(AtomicU64::new(0)),
            last_used_provider: Arc::new(RwLock::new(None)),
            last_used_reason: Arc::new(RwLock::new(None)),
            usage_base_speed_cache: Arc::new(RwLock::new(HashMap::new())),
        };

        let prev_input = json!([{
            "type": "message",
            "role": "user",
            "content": [{"type": "input_text", "text": "first"}]
        }]);
        let prev_resp = json!({
            "id": "resp_prev",
            "output": [{"content": [{"type": "output_text", "text": "reply"}]}]
        });
        store
            .put_exchange("resp_prev", None, &json!({"input": prev_input}), &prev_resp)
            .unwrap();

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
}
