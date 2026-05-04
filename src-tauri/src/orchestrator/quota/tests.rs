#[cfg(test)]
mod tests {
    use super::*;
    use crate::orchestrator::config::{AppConfig, ListenConfig, RoutingConfig};
    use crate::orchestrator::gateway::open_store_dir;
    use crate::orchestrator::router::RouterState;
    use crate::orchestrator::secrets::SecretStore;
    use crate::orchestrator::upstream::UpstreamClient;
    use crate::orchestrator::quota::SharedQuotaOwnerStatus;
    use parking_lot::RwLock;
    use std::sync::atomic::AtomicU64;
    use std::sync::{Arc, OnceLock};

    fn usage_base_gate_test_lock() -> &'static tokio::sync::Mutex<()> {
        static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
    }

    fn mk_lan_sync() -> crate::lan_sync::LanSyncRuntime {
        crate::lan_sync::LanSyncRuntime::new(crate::lan_sync::LanNodeIdentity {
            node_id: "node-self".to_string(),
            node_name: "self".to_string(),
        })
    }

    async fn start_mock_server(token_stats_ok: bool) -> (String, tokio::task::JoinHandle<()>) {
        use axum::http::StatusCode;
        use axum::routing::get;
        use axum::{Json, Router};

        let app = Router::new()
            .route(
                "/api/token-stats",
                get(move || async move {
                    if !token_stats_ok {
                        return (StatusCode::NOT_FOUND, Json(serde_json::json!({})));
                    }
                    (
                        StatusCode::OK,
                        Json(serde_json::json!({
                          "data": {
                            "info": { "remain_quota_display": 12.3 },
                            "stats": { "today_stats": { "used_quota": 1.0, "added_quota": 2.0 } }
                          }
                        })),
                    )
                }),
            )
            .route(
                "/api/backend/subscriptions",
                get(|| async move {
                    (
                        StatusCode::OK,
                        Json(serde_json::json!({
                          "data": [
                            {
                              "status": "canceled",
                              "current_period_end": 1990000000
                            },
                            {
                              "status": "active",
                              "current_period_end": "2028-01-01T00:00:00Z"
                            },
                            {
                              "status": "active",
                              "current_period_end": 1900000000
                            }
                          ]
                        })),
                    )
                }),
            )
            .route(
                "/api/backend/users/info",
                get(|| async move {
                    (
                        StatusCode::OK,
                        Json(serde_json::json!({
                          "daily_spent_usd": "0.5",
                          "daily_budget_usd": 1,
                          "monthly_spent_usd": 2,
                          "monthly_budget_usd": 10,
                          "remaining_quota": 123
                        })),
                    )
                }),
            );

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let url = format!("http://{}:{}", addr.ip(), addr.port());
        let h = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        (url, h)
    }

    async fn start_mock_server_budget_plan_expiry_only() -> (String, tokio::task::JoinHandle<()>) {
        use axum::http::StatusCode;
        use axum::routing::get;
        use axum::{Json, Router};

        let app = Router::new()
            .route(
                "/api/token-stats",
                get(|| async move { (StatusCode::NOT_FOUND, Json(serde_json::json!({}))) }),
            )
            .route(
                "/api/backend/users/info",
                get(|| async move {
                    (
                        StatusCode::OK,
                        Json(serde_json::json!({
                          "daily_spent_usd": "0.5",
                          "daily_budget_usd": 1,
                          "monthly_spent_usd": 2,
                          "monthly_budget_usd": 10,
                          "remaining_quota": 123,
                          "plan_expires_at": "2026-03-01T14:50:39.044332+08:00"
                        })),
                    )
                }),
            )
            .route(
                "/api/backend/subscriptions",
                get(|| async move { (StatusCode::UNAUTHORIZED, Json(serde_json::json!({}))) }),
            );

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let url = format!("http://{}:{}", addr.ip(), addr.port());
        let h = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        (url, h)
    }

    async fn start_codex_for_me_mock_server() -> (String, tokio::task::JoinHandle<()>) {
        use axum::extract::State;
        use axum::http::{HeaderMap, StatusCode};
        use axum::routing::{get, post};
        use axum::{Json, Router};
        use std::sync::Arc;

        #[derive(Clone)]
        struct MockState {
            token: Arc<String>,
        }

        let state = MockState {
            token: Arc::new("codex-for-me-jwt".to_string()),
        };
        let app = Router::new()
            .route(
                "/web/api/v1/users/login",
                post({
                    let state = state.clone();
                    move |State(_state): State<MockState>, Json(payload): Json<Value>| async move {
                        let username = payload
                            .get("user_name")
                            .and_then(Value::as_str)
                            .unwrap_or_default();
                        let password = payload
                            .get("password")
                            .and_then(Value::as_str)
                            .unwrap_or_default();
                        if username != "alice" || password != "secret" {
                            return (
                                StatusCode::UNAUTHORIZED,
                                Json(serde_json::json!({ "message": "bad credentials" })),
                            );
                        }
                        (
                            StatusCode::OK,
                            Json(serde_json::json!({ "token": state.token.as_ref() })),
                        )
                    }
                }),
            )
            .route(
                "/web/api/v1/users/summary",
                get({
                    let state = state.clone();
                    move |State(_state): State<MockState>, headers: HeaderMap| async move {
                        let auth = headers
                            .get(axum::http::header::AUTHORIZATION)
                            .and_then(|value| value.to_str().ok())
                            .unwrap_or_default();
                        if auth != format!("Bearer {}", state.token.as_ref()) {
                            return (
                                StatusCode::UNAUTHORIZED,
                                Json(serde_json::json!({ "message": "invalid token" })),
                            );
                        }
                        (
                            StatusCode::OK,
                            Json(serde_json::json!({
                                "data": {
                                    "card_balance": "49.95",
                                    "card_expire_date": "2099-01-01 00:00:00",
                                    "card_name": "codex-jfioejg",
                                    "card_daily_limit": "373.33",
                                    "today_spent_amount": "26.03",
                                    "card_total_spent_amount": "40.92",
                                    "plan_cards": [
                                        {
                                            "name": "codex-jfioejg",
                                            "activation_time": "2026-01-01 00:00:00",
                                            "expiration_time": "2099-01-01 00:00:00",
                                            "daily_limit": "373.33",
                                            "balance": "137.66",
                                            "state": "active"
                                        },
                                        {
                                            "name": "50-ewjofi",
                                            "activation_time": "2026-05-03 14:44:35",
                                            "expiration_time": "2056-04-25 14:44:35",
                                            "daily_limit": "50.00",
                                            "balance": "49.95",
                                            "state": "active"
                                        },
                                        {
                                            "name": "50-ewjofi",
                                            "activation_time": "2026-05-03 14:44:47",
                                            "expiration_time": "2056-04-25 14:44:47",
                                            "daily_limit": "50.00",
                                            "balance": "50.00",
                                            "state": "pending"
                                        },
                                        {
                                            "name": "50-ewjofi",
                                            "activation_time": "2026-05-03 14:44:53",
                                            "expiration_time": "2056-04-25 14:44:53",
                                            "daily_limit": "50.00",
                                            "balance": "50.00",
                                            "state": "pending"
                                        },
                                        {
                                            "name": "ignored-expired-card",
                                            "activation_time": "2025-01-01 00:00:00",
                                            "expiration_time": "2025-02-01 00:00:00",
                                            "daily_limit": "999.00",
                                            "balance": "999.00",
                                            "state": "expired"
                                        }
                                    ]
                                }
                            })),
                        )
                    }
                }),
            )
            .with_state(state);

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let url = format!("http://{}:{}", addr.ip(), addr.port());
        let h = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        (url, h)
    }

    async fn start_subscription_login_mock_server() -> (String, tokio::task::JoinHandle<()>) {
        use axum::http::{HeaderMap, StatusCode};
        use axum::response::IntoResponse;
        use axum::routing::{get, post};
        use axum::{Json, Router};

        let app = Router::new()
            .route(
                "/api/user/login",
                post(|Json(payload): Json<Value>| async move {
                    let username = payload
                        .get("username")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    let password = payload
                        .get("password")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    if username != "alice" || password != "secret" {
                        return (
                            StatusCode::UNAUTHORIZED,
                            Json(serde_json::json!({ "success": false, "message": "bad credentials" })),
                        )
                            .into_response();
                    }
                    (
                        StatusCode::OK,
                        [(
                            axum::http::header::SET_COOKIE,
                            "subscription-session=session-123; Path=/; HttpOnly",
                        )],
                        Json(serde_json::json!({
                            "success": true,
                            "data": {
                                "id": 42,
                                "username": "alice"
                            }
                        })),
                    )
                        .into_response()
                }),
            )
            .route(
                "/api/status",
                get(|| async move {
                    Json(serde_json::json!({
                        "success": true,
                        "data": {
                            "quota_per_unit": 500000
                        }
                    }))
                }),
            )
            .route(
                "/api/subscription/self",
                get(|headers: HeaderMap| async move {
                    let cookie = headers
                        .get(axum::http::header::COOKIE)
                        .and_then(|value| value.to_str().ok())
                        .unwrap_or_default();
                    let user = headers
                        .get("New-Api-User")
                        .and_then(|value| value.to_str().ok())
                        .unwrap_or_default();
                    if !cookie.contains("subscription-session=session-123") || user != "42" {
                        return (
                            StatusCode::UNAUTHORIZED,
                            Json(serde_json::json!({ "success": false, "message": "unauthorized" })),
                        );
                    }
                    (
                        StatusCode::OK,
                        Json(serde_json::json!({
                            "success": true,
                            "data": {
                                "billing_preference": "subscription_first",
                                "subscriptions": [
                                    {
                                        "subscription": {
                                            "id": 165,
                                            "plan_id": 7,
                                            "status": "active",
                                            "start_time": 1777449600_u64,
                                            "end_time": 1779945600_u64,
                                            "amount_total": 45000000,
                                            "amount_used": 1250000,
                                            "last_reset_time": 1777449600_u64,
                                            "next_reset_time": 1777536000_u64
                                        }
                                    }
                                ],
                                "all_subscriptions": []
                            }
                        })),
                    )
                }),
            );

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let url = format!("http://{}:{}", addr.ip(), addr.port());
        let h = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        (url, h)
    }

    async fn start_quan2go_codexusage_mock_server() -> (String, tokio::task::JoinHandle<()>) {
        use axum::http::{HeaderMap, StatusCode};
        use axum::routing::{get, post};
        use axum::{Json, Router};

        let app = Router::new()
            .route(
                "/api/users/card-login",
                post(|Json(payload): Json<Value>| async move {
                    let card = payload
                        .get("card")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    let agent = payload
                        .get("agent")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    if card != "card-123" || agent != "main" {
                        return (
                            StatusCode::UNAUTHORIZED,
                            Json(serde_json::json!({ "message": "bad credentials" })),
                        );
                    }
                    (
                        StatusCode::OK,
                        Json(serde_json::json!({
                            "code": 0,
                            "data": { "token": "user:81406/mock-token" }
                        })),
                    )
                }),
            )
            .route(
                "/api/users/whoami",
                get(|headers: HeaderMap| async move {
                    let auth = headers
                        .get("x-auth-token")
                        .and_then(|value| value.to_str().ok())
                        .unwrap_or_default();
                    if auth != "user:81406/mock-token" {
                        return (
                            StatusCode::UNAUTHORIZED,
                            Json(serde_json::json!({ "message": "invalid token" })),
                        );
                    }
                    (
                        StatusCode::OK,
                        Json(serde_json::json!({
                            "code": 0,
                            "data": {
                                "id": 81406,
                                "score_used": 12.5,
                                "day_score_used": 2.75,
                                "vip": {
                                    "product": "codex",
                                    "score": 200.0,
                                    "day_score": 45.0,
                                    "expire_at": 1779036712763u64
                                }
                            }
                        })),
                    )
                }),
            );

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let url = format!("http://{}:{}", addr.ip(), addr.port());
        let h = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        (url, h)
    }

    #[test]
    fn failed_refresh_preserves_previous_budget_snapshot_kind() {
        let provider_name = "codex-for.me";
        let cfg = AppConfig {
            listen: ListenConfig {
                host: "127.0.0.1".to_string(),
                port: 0,
            },
            routing: RoutingConfig {
                preferred_provider: provider_name.to_string(),
                session_preferred_providers: std::collections::BTreeMap::new(),
                route_mode: crate::orchestrator::config::RouteMode::FollowPreferredAuto,
                auto_return_to_preferred: true,
                preferred_stable_seconds: 1,
                failure_threshold: 1,
                cooldown_seconds: 1,
                request_timeout_seconds: 5,
            },
            providers: std::collections::BTreeMap::from([(
                provider_name.to_string(),
                ProviderConfig {
                    display_name: "Codex For Me".to_string(),
                    base_url: "https://codex-for.me/v1".to_string(),
                    usage_adapter: String::new(),
                    usage_base_url: None,
                    group: None,
                    disabled: false,
                    supports_websockets: false,
                    api_key: String::new(),
                },
            )]),
            provider_order: vec![provider_name.to_string()],
        };

        let tmp = tempfile::tempdir().expect("tempdir");
        let store = open_store_dir(tmp.path().join("data")).expect("store");
        let router = Arc::new(RouterState::new(&cfg, unix_ms()));
        let st = GatewayState {
            cfg: Arc::new(RwLock::new(cfg)),
            router,
            store,
            upstream: UpstreamClient::new(),
            secrets: SecretStore::new(tmp.path().join("secrets.json")),
            last_activity_unix_ms: Arc::new(AtomicU64::new(0)),
            last_used_by_session: Arc::new(RwLock::new(HashMap::new())),
            usage_base_speed_cache: Arc::new(RwLock::new(HashMap::new())),
            prev_id_support_cache: Arc::new(RwLock::new(HashMap::new())),
            client_sessions: Arc::new(RwLock::new(HashMap::new())),
        };
        crate::lan_sync::register_gateway_status_runtime(crate::lan_sync::LanSyncRuntime::new(
            crate::lan_sync::LanNodeIdentity {
                node_id: "node-self".to_string(),
                node_name: "self".to_string(),
            },
        ));

        let previous = QuotaSnapshot {
            kind: UsageKind::BudgetInfo,
            updated_at_unix_ms: 1_000,
            remaining: Some(3_402.19),
            today_used: None,
            today_added: None,
            daily_spent_usd: Some(25.93),
            daily_budget_usd: Some(200.0),
            weekly_spent_usd: None,
            weekly_budget_usd: None,
            monthly_spent_usd: Some(2_597.81),
            monthly_budget_usd: Some(6_000.0),
            package_expires_at_unix_ms: Some(1_900_000_000_000),
            last_error: String::new(),
            effective_usage_base: Some("https://codex-for.me".to_string()),
            effective_usage_source: Some("codex_for_me_balance".to_string()),
            producer_node_id: Some("node-owner".to_string()),
            producer_node_name: Some("owner".to_string()),
            applied_from_node_id: Some("node-owner".to_string()),
            applied_from_node_name: Some("owner".to_string()),
            applied_at_unix_ms: 1_000,
        };
        store_quota_snapshot(&st, provider_name, &previous);

        let failed_refresh = QuotaSnapshot {
            kind: UsageKind::BalanceInfo,
            updated_at_unix_ms: 0,
            remaining: None,
            today_used: None,
            today_added: None,
            daily_spent_usd: None,
            daily_budget_usd: None,
            weekly_spent_usd: None,
            weekly_budget_usd: None,
            monthly_spent_usd: None,
            monthly_budget_usd: None,
            package_expires_at_unix_ms: None,
            last_error: "http 500 from https://codex-for.me".to_string(),
            effective_usage_base: None,
            effective_usage_source: None,
            producer_node_id: None,
            producer_node_name: None,
            applied_from_node_id: None,
            applied_from_node_name: None,
            applied_at_unix_ms: 0,
        };

        let preserved = preserved_quota_snapshot_for_storage(&st, provider_name, &failed_refresh);
        assert_eq!(preserved.kind, UsageKind::BudgetInfo);
        assert_eq!(preserved.remaining, previous.remaining);
        assert_eq!(preserved.daily_spent_usd, previous.daily_spent_usd);
        assert_eq!(preserved.monthly_spent_usd, previous.monthly_spent_usd);
        assert_eq!(preserved.producer_node_id.as_deref(), Some("node-self"));
        assert_eq!(preserved.applied_from_node_id.as_deref(), Some("node-self"));
        assert_eq!(preserved.last_error, failed_refresh.last_error);
    }

    async fn start_yunyi_me_mock_server() -> (String, tokio::task::JoinHandle<()>) {
        use axum::http::{HeaderMap, StatusCode};
        use axum::routing::get;
        use axum::{Json, Router};

        let app = Router::new().route(
            "/user/api/v1/me",
            get(|headers: HeaderMap| async move {
                let auth = headers
                    .get(axum::http::header::AUTHORIZATION)
                    .and_then(|value| value.to_str().ok())
                    .unwrap_or_default();
                if auth != "Bearer provider-key" {
                    return (
                        StatusCode::UNAUTHORIZED,
                        Json(serde_json::json!({ "message": "invalid token" })),
                    );
                }
                (
                    StatusCode::OK,
                    Json(serde_json::json!({
                        "quota": {
                            "daily_quota": 4500,
                            "daily_spent": 28,
                            "daily_remaining": 4472
                        },
                        "usage": {
                            "total_spent": 28
                        },
                        "timestamps": {
                            "expires_at": "2026-04-04T14:57:44.674Z"
                        }
                    })),
                )
            }),
        );

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let url = format!("http://{}:{}", addr.ip(), addr.port());
        let h = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        (url, h)
    }

    fn mk_state(base_url: String, secrets: SecretStore) -> GatewayState {
        let explicit_usage_base = derive_origin(&base_url);
        mk_state_with_providers(
            std::collections::BTreeMap::from([(
                "p1".to_string(),
                ProviderConfig {
                    display_name: "P1".to_string(),
                    base_url,
                    usage_adapter: String::new(),
                    usage_base_url: explicit_usage_base,
                    group: None,
                    disabled: false,
                    supports_websockets: false,
                    api_key: String::new(),
                },
            )]),
            vec!["p1".to_string()],
            secrets,
        )
    }

    fn mk_state_with_providers(
        providers: std::collections::BTreeMap<String, ProviderConfig>,
        provider_order: Vec<String>,
        secrets: SecretStore,
    ) -> GatewayState {
        let preferred_provider = provider_order
            .first()
            .cloned()
            .unwrap_or_else(|| "p1".to_string());
        let cfg = AppConfig {
            listen: ListenConfig {
                host: "127.0.0.1".to_string(),
                port: 0,
            },
            routing: RoutingConfig {
                preferred_provider,
                session_preferred_providers: std::collections::BTreeMap::new(),
                route_mode: crate::orchestrator::config::RouteMode::FollowPreferredAuto,
                auto_return_to_preferred: true,
                preferred_stable_seconds: 1,
                failure_threshold: 1,
                cooldown_seconds: 1,
                request_timeout_seconds: 5,
            },
            providers,
            provider_order,
        };

        // Keep the sled directory alive for the test duration.
        let tmp = tempfile::tempdir().unwrap();
        let base = tmp.keep();
        let store = open_store_dir(base).unwrap();
        let router = Arc::new(RouterState::new(&cfg, unix_ms()));
        GatewayState {
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
        }
    }

    #[tokio::test]
    async fn derive_origin_drops_path_and_query() {
        let origin = derive_origin("http://example.com:123/v1?x=y").unwrap();
        assert_eq!(origin, "http://example.com:123");
    }

    #[tokio::test]
    async fn candidate_quota_bases_keeps_generic_provider_empty_without_explicit_base() {
        let p = ProviderConfig {
            display_name: "P".to_string(),
            base_url: "http://codex-api.example.com/v1".to_string(),
            group: None,
            disabled: false,
            supports_websockets: false,
            usage_adapter: String::new(),
            usage_base_url: None,
            api_key: String::new(),
        };
        let bases = resolve_quota_profile(&p).candidate_bases;
        assert!(bases.is_empty());
    }

    #[tokio::test]
    async fn candidate_quota_bases_keeps_only_explicit_for_generic_provider() {
        let p = ProviderConfig {
            display_name: "P".to_string(),
            base_url: "http://codex-api.example.com/v1".to_string(),
            group: None,
            disabled: false,
            supports_websockets: false,
            usage_adapter: String::new(),
            usage_base_url: Some("https://explicit.example.com/".to_string()),
            api_key: String::new(),
        };
        let bases = resolve_quota_profile(&p).candidate_bases;
        assert_eq!(bases, vec!["https://explicit.example.com".to_string()]);
    }

    #[tokio::test]
    async fn candidate_quota_bases_canonicalizes_packycode_to_codex_host_only() {
        let p = ProviderConfig {
            display_name: "P".to_string(),
            base_url: "https://codex-api.packycode.com/v1".to_string(),
            group: None,
            disabled: false,
            supports_websockets: false,
            usage_adapter: String::new(),
            usage_base_url: None,
            api_key: String::new(),
        };
        let bases = resolve_quota_profile(&p).candidate_bases;
        assert_eq!(bases, vec!["https://codex.packycode.com".to_string()]);
    }

    #[tokio::test]
    async fn candidate_quota_bases_ignores_packycode_explicit_non_canonical_usage_host() {
        let p = ProviderConfig {
            display_name: "P".to_string(),
            base_url: "https://codex-api.packycode.com/v1".to_string(),
            group: None,
            disabled: false,
            supports_websockets: false,
            usage_adapter: String::new(),
            usage_base_url: Some("https://www.packycode.com".to_string()),
            api_key: String::new(),
        };
        let bases = resolve_quota_profile(&p).candidate_bases;
        assert_eq!(bases, vec!["https://codex.packycode.com".to_string()]);
    }

    #[tokio::test]
    async fn subscription_login_url_uses_configured_endpoint() {
        assert_eq!(
            build_subscription_login_url("https://yfy.zhouyang168.top", "api/user/login").as_deref(),
            Some("https://yfy.zhouyang168.top/api/user/login")
        );
        assert_eq!(
            build_subscription_login_url("https://example.com/root", "/v2/subscription/self")
                .as_deref(),
            Some("https://example.com/root/v2/subscription/self")
        );
    }

    #[tokio::test]
    async fn budget_info_invalid_shape_reports_base_in_error() {
        use axum::http::StatusCode;
        use axum::routing::get;
        use axum::{Json, Router};

        let app = Router::new().route(
            "/api/backend/users/info",
            get(|| async move { (StatusCode::OK, Json(serde_json::json!({ "ok": true }))) }),
        );

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let base = format!("http://{}:{}", addr.ip(), addr.port());
        let handle = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        let st = mk_state(format!("{base}/v1"), SecretStore::new(tempfile::tempdir().unwrap().path().join("secrets.json")));
        let snap = fetch_budget_info_any(
            &st,
            "p1",
            std::slice::from_ref(&base),
            Some("test-token"),
            "usage token",
            crate::orchestrator::providers::default_budget_info_mapping(),
            PackageExpiryStrategy::None,
        )
        .await;
        handle.abort();

        assert!(snap.updated_at_unix_ms == 0);
        assert!(snap.last_error.contains("unexpected response"));
        assert!(snap.last_error.contains(&base));
    }

    #[test]
    fn usage_request_key_normalizes_bases_order() {
        let provider = ProviderConfig {
            display_name: "Test".to_string(),
            base_url: "https://usage-router.example/v1".to_string(),
            group: None,
            disabled: false,
            usage_adapter: String::new(),
            usage_base_url: None,
            supports_websockets: false,
            api_key: String::new(),
        };
        let bases_a = vec![
            "https://code.ppchat.vip".to_string(),
            "https://code.pumpkinai.vip".to_string(),
        ];
        let bases_b = vec![
            "https://code.pumpkinai.vip/".to_string(),
            "https://code.ppchat.vip/".to_string(),
        ];
        let key_a = usage_request_key(
            &provider,
            &bases_a,
            &Some("sk-test".to_string()),
            &None,
            &None,
            UsageKind::TokenStats,
        );
        let key_b = usage_request_key(
            &provider,
            &bases_b,
            &Some("sk-test".to_string()),
            &None,
            &None,
            UsageKind::TokenStats,
        );
        assert_eq!(key_a, key_b);
    }

    #[test]
    fn shared_key_groups_by_primary_usage_base_only() {
        // ppchat/pumpkinai have different origins, but share the same history/usage base.
        let pp = ProviderConfig {
            display_name: "PP".to_string(),
            base_url: "https://code.ppchat.vip/v1".to_string(),
            group: None,
            disabled: false,
            supports_websockets: false,
            usage_adapter: String::new(),
            usage_base_url: None,
            api_key: String::new(),
        };
        let pumpkin = ProviderConfig {
            display_name: "Pumpkin".to_string(),
            base_url: "https://code.pumpkinai.vip/v1".to_string(),
            group: None,
            disabled: false,
            supports_websockets: false,
            usage_adapter: String::new(),
            usage_base_url: None,
            api_key: String::new(),
        };

        let bases_pp = resolve_quota_profile(&pp).candidate_bases;
        let bases_pumpkin = resolve_quota_profile(&pumpkin).candidate_bases;
        assert_eq!(bases_pp, bases_pumpkin);
        assert_eq!(bases_pp.first().unwrap(), "https://his.ppchat.vip");
        assert_eq!(bases_pumpkin.first().unwrap(), "https://his.ppchat.vip");

        let k1 = usage_shared_key(
            &pp,
            bases_pp.first().unwrap(),
            &Some("k".to_string()),
            &None,
            &None,
        );
        let k2 = usage_shared_key(
            &pumpkin,
            bases_pumpkin.first().unwrap(),
            &Some("k".to_string()),
            &None,
            &None,
        );
        assert_eq!(k1, k2);
    }

    #[tokio::test]
    async fn candidate_quota_bases_infers_codex_for_me_origin() {
        let p = ProviderConfig {
            display_name: "Codex For Me".to_string(),
            base_url: "https://api-vip.codex-for.me/v1".to_string(),
            group: None,
            disabled: false,
            supports_websockets: false,
            usage_adapter: String::new(),
            usage_base_url: None,
            api_key: String::new(),
        };
        let bases = resolve_quota_profile(&p).candidate_bases;
        assert_eq!(bases, vec!["https://api-vip.codex-for.me".to_string()]);
    }

    #[tokio::test]
    async fn candidate_quota_bases_infers_codex_for_host_origin() {
        let p = ProviderConfig {
            display_name: "Codex For".to_string(),
            base_url: "https://api-vip.codex-for.vip/v1".to_string(),
            group: None,
            disabled: false,
            supports_websockets: false,
            usage_adapter: String::new(),
            usage_base_url: None,
            api_key: String::new(),
        };
        let bases = resolve_quota_profile(&p).candidate_bases;
        assert_eq!(bases, vec!["https://api-vip.codex-for.vip".to_string()]);
    }

    #[test]
    fn explicit_usage_endpoint_url_detects_direct_endpoint_only() {
        let mut provider = ProviderConfig {
            display_name: "P".to_string(),
            base_url: "https://yunyi.rdzhvip.com/codex".to_string(),
            group: None,
            disabled: false,
            supports_websockets: false,
            usage_adapter: String::new(),
            usage_base_url: None,
            api_key: String::new(),
        };
        assert_eq!(
            explicit_usage_endpoint_url(&provider).as_deref(),
            Some("https://yunyi.rdzhvip.com/user/api/v1/me")
        );

        provider.usage_base_url = Some("https://yunyi.rdzhvip.com/user/api/v1/me".to_string());
        assert_eq!(
            explicit_usage_endpoint_url(&provider).as_deref(),
            Some("https://yunyi.rdzhvip.com/user/api/v1/me")
        );

        provider.usage_base_url = Some("https://yunyi.rdzhvip.com/user/api/v1".to_string());
        assert_eq!(
            explicit_usage_endpoint_url(&provider).as_deref(),
            Some("https://yunyi.rdzhvip.com/user/api/v1/me")
        );
    }

    #[test]
    fn explicit_usage_endpoint_url_infers_aigateway_usage_endpoint() {
        let provider = ProviderConfig {
            display_name: "AI Gateway".to_string(),
            base_url: "https://aigateway.chat/v1".to_string(),
            group: None,
            disabled: false,
            supports_websockets: false,
            usage_adapter: String::new(),
            usage_base_url: None,
            api_key: String::new(),
        };

        assert_eq!(
            explicit_usage_endpoint_url(&provider).as_deref(),
            Some("https://aigateway.chat/v1/usage")
        );
    }

    #[test]
    fn explicit_usage_endpoint_url_ignores_invalid_explicit_url_for_aigateway() {
        let provider = ProviderConfig {
            display_name: "AI Gateway".to_string(),
            base_url: "https://aigateway.chat/v1".to_string(),
            group: None,
            disabled: false,
            supports_websockets: false,
            usage_adapter: String::new(),
            usage_base_url: Some("not-a-url".to_string()),
            api_key: String::new(),
        };

        assert_eq!(
            explicit_usage_endpoint_url(&provider).as_deref(),
            Some("https://aigateway.chat/v1/usage")
        );
    }

    #[test]
    fn explicit_usage_endpoint_payload_reads_aigateway_usage_shape() {
        let payload = serde_json::json!({
            "isValid": true,
            "mode": "unrestricted",
            "planName": "\u{8f7b}\u{4eab}\u{5361} 3\u{5929}",
            "remaining": 200,
            "subscription": {
                "daily_limit_usd": 200,
                "daily_usage_usd": 0,
                "expires_at": "2026-04-02T14:02:27.679994+08:00"
            },
            "unit": "USD",
            "usage": {
                "today": {
                    "actual_cost": 0,
                    "requests": 0,
                    "total_tokens": 0
                }
            }
        });

        let snap = map_snapshot_from_usage_payload(
            &payload,
            explicit_usage_mapping("https://aigateway.chat/v1/usage"),
            "https://aigateway.chat/v1/usage",
            "usage_base",
            1_700_000_000_000,
        )
        .expect("aigateway usage payload should parse");

        assert_eq!(snap.kind, UsageKind::BudgetInfo);
        assert_eq!(snap.remaining, None);
        assert_eq!(snap.daily_budget_usd, Some(200.0));
        assert_eq!(snap.daily_spent_usd, Some(0.0));
        assert_eq!(snap.package_expires_at_unix_ms, Some(1_775_109_747_679));
        assert_eq!(
            snap.effective_usage_base.as_deref(),
            Some("https://aigateway.chat/v1/usage")
        );
    }

    #[test]
    fn explicit_usage_endpoint_prefers_aigateway_today_actual_cost_when_remaining_is_depleted() {
        let payload = serde_json::json!({
            "isValid": true,
            "mode": "unrestricted",
            "planName": "\u{5b63}\u{5361} 90\u{5929}",
            "remaining": 0,
            "subscription": {
                "daily_limit_usd": 300,
                "daily_usage_usd": 300.043385,
                "expires_at": "2026-10-04T09:29:39.391714+08:00"
            },
            "unit": "USD",
            "usage": {
                "today": {
                    "actual_cost": 0,
                    "cost": 0,
                    "requests": 0,
                    "total_tokens": 0
                }
            }
        });

        let snap = map_snapshot_from_usage_payload(
            &payload,
            explicit_usage_mapping("https://aigateway.chat/v1/usage"),
            "https://aigateway.chat/v1/usage",
            "usage_base",
            1_700_000_000_000,
        )
        .expect("aigateway usage payload should parse");

        assert_eq!(snap.daily_budget_usd, Some(300.0));
        assert_eq!(snap.remaining, None);
        assert_eq!(
            snap.daily_spent_usd,
            Some(0.0),
            "aigateway snapshots should trust usage.today.actual_cost instead of stale remaining or subscription daily usage"
        );
    }

    #[tokio::test]
    async fn explicit_usage_endpoint_fetches_yunyi_budget_info_via_provider_key() {
        let (base, handle) = start_yunyi_me_mock_server().await;
        let endpoint = format!("{base}/user/api/v1/me");
        let tmp = tempfile::tempdir().unwrap();
        let secrets = SecretStore::new(tmp.path().join("secrets.json"));
        secrets.set_provider_key("p1", "provider-key").unwrap();
        let st = mk_state("https://yunyi.rdzhvip.com/codex".to_string(), secrets);
        {
            let mut cfg = st.cfg.write();
            if let Some(provider) = cfg.providers.get_mut("p1") {
                provider.base_url = "https://yunyi.rdzhvip.com/codex".to_string();
                provider.usage_base_url = Some(endpoint.clone());
            }
        }

        let snap = refresh_quota_for_provider(&st, "p1").await;
        handle.abort();

        assert!(snap.last_error.is_empty(), "unexpected refresh error: {}", snap.last_error);
        assert_eq!(snap.kind, UsageKind::BudgetInfo);
        assert_eq!(snap.remaining, Some(44.72));
        assert_eq!(snap.daily_budget_usd, Some(45.0));
        assert_eq!(snap.daily_spent_usd, Some(0.28));
        assert_eq!(snap.monthly_spent_usd, None);
        assert_eq!(snap.package_expires_at_unix_ms, Some(1_775_314_664_674));
        assert_eq!(snap.effective_usage_base.as_deref(), Some(endpoint.as_str()));
    }

    #[tokio::test]
    async fn explicit_usage_endpoint_falls_back_from_stale_usage_token_to_provider_key() {
        let (base, handle) = start_yunyi_me_mock_server().await;
        let endpoint = format!("{base}/user/api/v1/me");
        let tmp = tempfile::tempdir().unwrap();
        let secrets = SecretStore::new(tmp.path().join("secrets.json"));
        secrets.set_provider_key("p1", "provider-key").unwrap();
        secrets.set_usage_token("p1", "stale-usage-token").unwrap();
        let st = mk_state("https://yunyi.rdzhvip.com/codex".to_string(), secrets);
        {
            let mut cfg = st.cfg.write();
            if let Some(provider) = cfg.providers.get_mut("p1") {
                provider.base_url = "https://yunyi.rdzhvip.com/codex".to_string();
                provider.usage_base_url = Some(endpoint.clone());
            }
        }

        let snap = refresh_quota_for_provider(&st, "p1").await;
        handle.abort();

        assert!(snap.last_error.is_empty(), "unexpected refresh error: {}", snap.last_error);
        assert_eq!(snap.kind, UsageKind::BudgetInfo);
        assert_eq!(snap.daily_spent_usd, Some(0.28));
        assert_eq!(snap.daily_budget_usd, Some(45.0));
    }

    #[tokio::test]
    async fn codex_for_me_login_fetches_dashboard_usage_snapshot() {
        let (base, handle) = start_codex_for_me_mock_server().await;
        let tmp = tempfile::tempdir().unwrap();
        let secrets = SecretStore::new(tmp.path().join("secrets.json"));
        secrets.set_usage_login("p1", "alice", "secret").unwrap();
        let st = mk_state(format!("{base}/v1"), secrets);
        {
            let mut cfg = st.cfg.write();
            if let Some(provider) = cfg.providers.get_mut("p1") {
                provider.base_url = "https://api-vip.codex-for.me/v1".to_string();
                provider.usage_base_url = Some(base.clone());
            }
        }

        let snap = refresh_quota_for_provider(&st, "p1").await;
        handle.abort();

        assert!(snap.last_error.is_empty());
        assert_eq!(snap.kind, UsageKind::BudgetInfo);
        assert_eq!(snap.remaining, Some(187.61));
        assert_eq!(snap.today_added, Some(423.33));
        assert_eq!(snap.today_used, Some(26.03));
        assert_eq!(snap.daily_budget_usd, Some(423.33));
        assert_eq!(snap.daily_spent_usd, Some(26.03));
        assert_eq!(snap.monthly_spent_usd, None);
        assert_eq!(snap.monthly_budget_usd, None);
        assert_eq!(snap.package_expires_at_unix_ms, Some(4_070_908_800_000));
        assert_eq!(snap.effective_usage_base.as_deref(), Some(base.as_str()));
    }

    #[tokio::test]
    async fn yfy_host_login_fetches_subscription_snapshot() {
        let (base, handle) = start_subscription_login_mock_server().await;
        let tmp = tempfile::tempdir().unwrap();
        let secrets = SecretStore::new(tmp.path().join("secrets.json"));
        secrets.set_usage_login("p1", "alice", "secret").unwrap();
        let st = mk_state(format!("{base}/v1"), secrets);
        {
            let mut cfg = st.cfg.write();
            if let Some(provider) = cfg.providers.get_mut("p1") {
                provider.base_url = "https://yfy.zhouyang168.top/v1".to_string();
                provider.usage_base_url = Some(base.clone());
            }
        }

        let snap = refresh_quota_for_provider(&st, "p1").await;
        handle.abort();

        assert!(snap.last_error.is_empty(), "{}", snap.last_error);
        assert_eq!(snap.kind, UsageKind::BudgetInfo);
        assert_eq!(snap.daily_budget_usd, Some(90.0));
        assert_eq!(snap.daily_spent_usd, Some(2.5));
        assert_eq!(snap.remaining, Some(87.5));
        assert_eq!(snap.package_expires_at_unix_ms, Some(1_779_945_600_000));
        assert_eq!(snap.effective_usage_base.as_deref(), Some(base.as_str()));
        assert_eq!(
            snap.effective_usage_source.as_deref(),
            Some("subscription_login")
        );
    }

    #[tokio::test]
    async fn subscription_login_without_reset_period_fails_normalization() {
        let tmp = tempfile::tempdir().unwrap();
        let secrets = SecretStore::new(tmp.path().join("secrets.json"));
        let st = mk_state("https://yfy.zhouyang168.top/v1".to_string(), secrets);
        let cfg = st.cfg.read().clone();
        let provider = cfg.providers.get("p1").unwrap();
        let profile = resolve_quota_profile(provider);
        let subscription_login = profile.subscription_login.as_ref().unwrap();
        let payload = serde_json::json!({
            "success": true,
            "data": {
                "subscriptions": [{
                    "subscription": {
                        "status": "active",
                        "end_time": 1779945600_u64,
                        "amount_total": 45000000,
                        "amount_used": 1250000
                    }
                }]
            }
        });

        assert!(normalize_subscription_login_payload(&payload, 500000.0, subscription_login).is_none());
    }

    #[tokio::test]
    async fn quan2go_provider_definition_fetches_usage_via_card_login_summary() {
        let (base, handle) = start_quan2go_codexusage_mock_server().await;
        let tmp = tempfile::tempdir().unwrap();
        let secrets = SecretStore::new(tmp.path().join("secrets.json"));
        secrets.set_provider_key("p1", "card-123").unwrap();
        let st = mk_state_with_providers(
            std::collections::BTreeMap::from([(
                "p1".to_string(),
                ProviderConfig {
                    display_name: "Quan2go".to_string(),
                    base_url: "https://capi.quan2go.com/openai".to_string(),
                    usage_adapter: String::new(),
                    usage_base_url: Some(base.clone()),
                    group: None,
                    disabled: false,
                    supports_websockets: false,
                    api_key: String::new(),
                },
            )]),
            vec!["p1".to_string()],
            secrets,
        );
        let mut profile = {
            let cfg = st.cfg.read().clone();
            resolve_quota_profile(cfg.providers.get("p1").unwrap())
        };
        profile.candidate_bases = vec![base.clone()];

        let snap = compute_quota_snapshot(
            &st,
            "p1",
            &profile,
            &profile.candidate_bases,
            QuotaCredentials {
                provider_key: Some("card-123"),
                usage_token: None,
                usage_login: None,
            },
            profile.package_expiry_strategy,
        )
        .await;
        handle.abort();

        assert!(snap.last_error.is_empty(), "{}", snap.last_error);
        assert_eq!(snap.kind, UsageKind::BudgetInfo);
        assert_eq!(snap.daily_spent_usd, None);
        assert_eq!(snap.daily_budget_usd, None);
        assert_eq!(snap.monthly_spent_usd, Some(12.5));
        assert_eq!(snap.monthly_budget_usd, Some(200.0));
        assert_eq!(snap.package_expires_at_unix_ms, Some(1_779_036_712_763));
        assert_eq!(snap.effective_usage_base.as_deref(), Some(base.as_str()));
        assert_eq!(
            snap.effective_usage_source.as_deref(),
            Some("provider_key_card_login_summary")
        );
    }

    #[tokio::test]
    async fn usage_login_only_allows_quota_refresh_for_codex_for_me_provider() {
        let tmp = tempfile::tempdir().unwrap();
        let secrets = SecretStore::new(tmp.path().join("secrets.json"));
        secrets.set_usage_login("p1", "alice", "secret").unwrap();
        let st = mk_state("https://api-vip.codex-for.me/v1".to_string(), secrets);
        let cfg = st.cfg.read().clone();
        let provider = cfg.providers.get("p1").unwrap();
        assert!(can_refresh_quota_for_provider(&st, "p1", provider));
    }

    #[tokio::test]
    async fn usage_login_allows_quota_refresh_for_codex_for_host() {
        let tmp = tempfile::tempdir().unwrap();
        let secrets = SecretStore::new(tmp.path().join("secrets.json"));
        secrets.set_usage_login("p1", "alice", "secret").unwrap();
        let st = mk_state("https://api-vip.codex-for.vip/v1".to_string(), secrets);
        let cfg = st.cfg.read().clone();
        let provider = cfg.providers.get("p1").unwrap();
        assert!(can_refresh_quota_for_provider(&st, "p1", provider));
    }

    #[tokio::test]
    async fn usage_login_allows_quota_refresh_for_yfy_host() {
        let tmp = tempfile::tempdir().unwrap();
        let secrets = SecretStore::new(tmp.path().join("secrets.json"));
        secrets.set_usage_login("p1", "alice", "secret").unwrap();
        let st = mk_state("https://yfy.zhouyang168.top/v1".to_string(), secrets);
        let cfg = st.cfg.read().clone();
        let provider = cfg.providers.get("p1").unwrap();
        assert!(can_refresh_quota_for_provider(&st, "p1", provider));
    }

    #[tokio::test]
    async fn packycode_quota_refresh_requires_provider_key() {
        let tmp = tempfile::tempdir().unwrap();
        let secrets = SecretStore::new(tmp.path().join("secrets.json"));
        secrets.set_provider_key("p1", "api-key").unwrap();
        let st = mk_state("https://codex.packycode.com/v1".to_string(), secrets);
        let cfg = st.cfg.read().clone();
        let provider = cfg.providers.get("p1").unwrap();
        assert!(can_refresh_quota_for_provider(&st, "p1", provider));
    }

    #[tokio::test]
    async fn packycode_usage_login_without_provider_key_is_not_refreshable() {
        let tmp = tempfile::tempdir().unwrap();
        let secrets = SecretStore::new(tmp.path().join("secrets.json"));
        secrets.set_usage_login("p1", "alice", "secret").unwrap();
        let st = mk_state("https://codex.packycode.com/v1".to_string(), secrets);
        let cfg = st.cfg.read().clone();
        let provider = cfg.providers.get("p1").unwrap();
        assert!(!can_refresh_quota_for_provider(&st, "p1", provider));
    }

    #[tokio::test]
    async fn packycode_budget_info_without_provider_key_reports_missing_provider_key() {
        let tmp = tempfile::tempdir().unwrap();
        let secrets = SecretStore::new(tmp.path().join("secrets.json"));
        let st = mk_state("https://codex.packycode.com/v1".to_string(), secrets);

        let snap = refresh_quota_for_provider(&st, "p1").await;

        assert_eq!(snap.last_error, "missing provider key");
    }

    #[tokio::test]
    async fn auto_probe_prefers_token_stats_when_key_present() {
        let (base, _h) = start_mock_server(true).await;
        let tmp = tempfile::tempdir().unwrap();
        let secrets = SecretStore::new(tmp.path().join("secrets.json"));
        secrets.set_provider_key("p1", "k1").unwrap();
        secrets.set_usage_token("p1", "jwt-token").unwrap();
        let st = mk_state(format!("{base}/v1"), secrets);

        let snap = refresh_quota_for_provider(&st, "p1").await;
        assert!(snap.last_error.is_empty());
        assert_eq!(snap.kind.as_str(), "token_stats");
        assert_eq!(snap.remaining.unwrap_or(0.0), 12.3);
    }

    #[tokio::test]
    async fn successful_quota_refresh_promotes_unknown_provider_to_healthy() {
        let (base, _h) = start_mock_server(true).await;
        let tmp = tempfile::tempdir().unwrap();
        let secrets = SecretStore::new(tmp.path().join("secrets.json"));
        secrets.set_provider_key("p1", "k1").unwrap();
        secrets.set_usage_token("p1", "jwt-token").unwrap();
        let st = mk_state(format!("{base}/v1"), secrets);

        let before = st.router.snapshot(unix_ms());
        assert_eq!(
            before.get("p1").map(|snapshot| snapshot.status.as_str()),
            Some("unknown")
        );

        let snap = refresh_quota_for_provider(&st, "p1").await;
        assert!(snap.last_error.is_empty());
        assert!(snap.updated_at_unix_ms > 0);

        let after = st.router.snapshot(unix_ms());
        let health = after.get("p1").expect("provider health snapshot");
        assert_eq!(health.status, "healthy");
        assert_eq!(health.consecutive_failures, 0);
        assert_eq!(health.last_ok_at_unix_ms, snap.updated_at_unix_ms);
    }

    #[tokio::test]
    async fn token_stats_keeps_package_expiry_empty_for_non_packycode_sources() {
        let (base, _h) = start_mock_server(true).await;
        let tmp = tempfile::tempdir().unwrap();
        let secrets = SecretStore::new(tmp.path().join("secrets.json"));
        secrets.set_provider_key("p1", "k1").unwrap();
        secrets.set_usage_token("p1", "t1").unwrap();
        let st = mk_state(format!("{base}/v1"), secrets);

        let snap = refresh_quota_for_provider(&st, "p1").await;
        assert!(snap.last_error.is_empty());
        assert_eq!(snap.kind.as_str(), "token_stats");
        assert_eq!(snap.package_expires_at_unix_ms, None);
    }

    #[tokio::test]
    async fn token_stats_reads_package_expiry_for_packycode_sources() {
        let (base, _h) = start_mock_server(true).await;
        let tmp = tempfile::tempdir().unwrap();
        let secrets = SecretStore::new(tmp.path().join("secrets.json"));
        secrets.set_provider_key("p1", "k1").unwrap();
        let st = mk_state(format!("{base}/v1"), secrets);
        {
            let mut cfg = st.cfg.write();
            if let Some(p) = cfg.providers.get_mut("p1") {
                p.base_url = "https://codex-api.packycode.com/v1".to_string();
                p.usage_base_url = Some(base.to_string());
            }
        }

        let snap = refresh_quota_for_provider(&st, "p1").await;
        assert!(snap.last_error.is_empty());
        assert_eq!(snap.kind.as_str(), "budget_info");
        assert_eq!(snap.package_expires_at_unix_ms, Some(1_900_000_000_000));
    }

    #[tokio::test]
    async fn packycode_budget_info_uses_single_users_info_request_when_payload_is_complete() {
        use axum::http::StatusCode;
        use axum::routing::get;
        use axum::{Json, Router};
        use std::sync::Arc;
        use std::sync::atomic::{AtomicU64, Ordering};

        let token_stats_hits = Arc::new(AtomicU64::new(0));
        let user_info_hits = Arc::new(AtomicU64::new(0));
        let subscriptions_hits = Arc::new(AtomicU64::new(0));

        let app = Router::new()
            .route(
                "/api/token-stats",
                get({
                    let token_stats_hits = Arc::clone(&token_stats_hits);
                    move || {
                        let token_stats_hits = Arc::clone(&token_stats_hits);
                        async move {
                            token_stats_hits.fetch_add(1, Ordering::Relaxed);
                            (StatusCode::OK, Json(serde_json::json!({})))
                        }
                    }
                }),
            )
            .route(
                "/api/backend/users/info",
                get({
                    let user_info_hits = Arc::clone(&user_info_hits);
                    move || {
                        let user_info_hits = Arc::clone(&user_info_hits);
                        async move {
                            user_info_hits.fetch_add(1, Ordering::Relaxed);
                            (
                                StatusCode::OK,
                                Json(serde_json::json!({
                                  "daily_spent_usd": "13.657",
                                  "daily_budget_usd": 60,
                                  "weekly_spent_usd": 55.927,
                                  "weekly_budget_usd": 180,
                                  "remaining_quota": 123,
                                  "plan_expires_at": "2030-01-01T00:00:00Z"
                                })),
                            )
                        }
                    }
                }),
            )
            .route(
                "/api/backend/subscriptions",
                get({
                    let subscriptions_hits = Arc::clone(&subscriptions_hits);
                    move || {
                        let subscriptions_hits = Arc::clone(&subscriptions_hits);
                        async move {
                            subscriptions_hits.fetch_add(1, Ordering::Relaxed);
                            (StatusCode::OK, Json(serde_json::json!({ "data": [] })))
                        }
                    }
                }),
            );

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let base = format!("http://{}:{}", addr.ip(), addr.port());
        let handle = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        let tmp = tempfile::tempdir().unwrap();
        let secrets = SecretStore::new(tmp.path().join("secrets.json"));
        secrets.set_provider_key("p1", "k1").unwrap();
        let st = mk_state(format!("{base}/v1"), secrets);
        {
            let mut cfg = st.cfg.write();
            if let Some(p) = cfg.providers.get_mut("p1") {
                p.base_url = "https://codex-api.packycode.com/v1".to_string();
                p.usage_base_url = Some(base.clone());
            }
        }

        let snap = refresh_quota_for_provider(&st, "p1").await;
        handle.abort();

        assert!(snap.last_error.is_empty());
        assert_eq!(snap.kind.as_str(), "budget_info");
        assert_eq!(snap.package_expires_at_unix_ms, Some(1_893_456_000_000));
        assert_eq!(token_stats_hits.load(Ordering::Relaxed), 0);
        assert_eq!(user_info_hits.load(Ordering::Relaxed), 1);
        assert_eq!(subscriptions_hits.load(Ordering::Relaxed), 0);
    }

    #[tokio::test]
    async fn packycode_budget_info_uses_provider_key_only() {
        use axum::extract::State;
        use axum::http::{HeaderMap, StatusCode};
        use axum::routing::get;
        use axum::{Json, Router};
        use std::sync::Arc;
        use std::sync::atomic::{AtomicU64, Ordering};

        let _guard = usage_base_gate_test_lock().lock().await;

        #[derive(Clone)]
        struct MockState {
            user_info_hits: Arc<AtomicU64>,
        }

        let state = MockState {
            user_info_hits: Arc::new(AtomicU64::new(0)),
        };
        let user_info_hits = Arc::clone(&state.user_info_hits);

        let app = Router::new()
            .route(
                "/api/backend/users/info",
                get({
                    move |State(state): State<MockState>, headers: HeaderMap| async move {
                        state.user_info_hits.fetch_add(1, Ordering::Relaxed);
                        let auth = headers
                            .get(axum::http::header::AUTHORIZATION)
                            .and_then(|value| value.to_str().ok())
                            .unwrap_or_default();
                        if auth != "Bearer api-key" {
                            return (
                                StatusCode::UNAUTHORIZED,
                                Json(serde_json::json!({ "error": "invalid token" })),
                            );
                        }
                        (
                            StatusCode::OK,
                            Json(serde_json::json!({
                              "daily_spent_usd": "13.657",
                              "daily_budget_usd": 60,
                              "monthly_spent_usd": 55.927,
                              "monthly_budget_usd": 180,
                              "remaining_quota": 123,
                              "plan_expires_at": "2030-01-01T00:00:00Z"
                            })),
                        )
                    }
                }),
            )
            .route(
                "/api/backend/subscriptions",
                get(|| async move { (StatusCode::OK, Json(serde_json::json!({ "data": [] }))) }),
            )
            .with_state(state);

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let base = format!("http://{}:{}", addr.ip(), addr.port());
        let handle = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        let tmp = tempfile::tempdir().unwrap();
        let secrets = SecretStore::new(tmp.path().join("secrets.json"));
        secrets.set_provider_key("p1", "api-key").unwrap();
        let st = mk_state(format!("{base}/v1"), secrets);
        {
            let mut cfg = st.cfg.write();
            if let Some(p) = cfg.providers.get_mut("p1") {
                p.base_url = "https://codex-api.packycode.com/v1".to_string();
                p.usage_base_url = Some(base.clone());
            }
        }

        let snap = refresh_quota_for_provider(&st, "p1").await;
        handle.abort();
        clear_usage_base_refresh_gate();

        assert!(snap.last_error.is_empty(), "unexpected refresh error: {}", snap.last_error);
        assert_eq!(snap.kind.as_str(), "budget_info");
        assert_eq!(snap.daily_spent_usd, Some(13.657));
        assert_eq!(snap.daily_budget_usd, Some(60.0));
        assert_eq!(snap.monthly_spent_usd, Some(55.927));
        assert_eq!(snap.monthly_budget_usd, Some(180.0));
        assert_eq!(user_info_hits.load(Ordering::Relaxed), 1);
    }

    #[tokio::test]
    async fn packycode_budget_info_returns_api_error_without_packycode_fallbacks() {
        use axum::extract::State;
        use axum::http::{HeaderMap, StatusCode};
        use axum::routing::get;
        use axum::{Json, Router};
        use std::sync::Arc;
        use std::sync::atomic::{AtomicU64, Ordering};

        let _guard = usage_base_gate_test_lock().lock().await;

        clear_usage_base_refresh_gate();

        #[derive(Clone)]
        struct MockState {
            token_stats_hits: Arc<AtomicU64>,
        }

        let state = MockState {
            token_stats_hits: Arc::new(AtomicU64::new(0)),
        };
        let token_stats_hits = Arc::clone(&state.token_stats_hits);

        let app = Router::new()
            .route(
                "/api/backend/users/info",
                get(|headers: HeaderMap| async move {
                    let auth = headers
                        .get(axum::http::header::AUTHORIZATION)
                        .and_then(|value| value.to_str().ok())
                        .unwrap_or_default();
                    let status = if auth == "Bearer api-key" {
                        StatusCode::UNAUTHORIZED
                    } else {
                        StatusCode::TOO_MANY_REQUESTS
                    };
                    (status, Json(serde_json::json!({ "error": "nope" })))
                }),
            )
            .route(
                "/api/token-stats",
                get({
                    move |State(state): State<MockState>| async move {
                        state.token_stats_hits.fetch_add(1, Ordering::Relaxed);
                        (
                            StatusCode::TOO_MANY_REQUESTS,
                            Json(serde_json::json!({ "error": "rate limited" })),
                        )
                    }
                }),
            )
            .with_state(state);

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let base = format!("http://{}:{}", addr.ip(), addr.port());
        let handle = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        let tmp = tempfile::tempdir().unwrap();
        let secrets = SecretStore::new(tmp.path().join("secrets.json"));
        secrets.set_provider_key("p1", "api-key").unwrap();
        let st = mk_state(format!("{base}/v1"), secrets);
        {
            let mut cfg = st.cfg.write();
            if let Some(p) = cfg.providers.get_mut("p1") {
                p.base_url = "https://codex-api.packycode.com/v1".to_string();
                p.usage_base_url = Some(base.clone());
            }
        }

        let snap = refresh_quota_for_provider(&st, "p1").await;
        handle.abort();
        clear_usage_base_refresh_gate();

        assert_eq!(snap.updated_at_unix_ms, 0);
        assert_eq!(snap.last_error, format!("http 401 from {base}"));
        assert_eq!(token_stats_hits.load(Ordering::Relaxed), 0);
    }

    #[tokio::test]
    async fn cached_future_package_expiry_still_allows_packycode_refetch() {
        use axum::http::StatusCode;
        use axum::routing::get;
        use axum::{Json, Router};
        use std::sync::Arc;
        use std::sync::atomic::{AtomicU64, Ordering};

        let _guard = usage_base_gate_test_lock().lock().await;

        let user_info_hits = Arc::new(AtomicU64::new(0));
        let subscriptions_hits = Arc::new(AtomicU64::new(0));
        let user_info_hits_ref = Arc::clone(&user_info_hits);
        let subscriptions_hits_ref = Arc::clone(&subscriptions_hits);
        let app = Router::new()
            .route(
                "/api/token-stats",
                get(|| async move {
                    (
                        StatusCode::OK,
                        Json(serde_json::json!({
                          "data": {
                            "info": { "remain_quota_display": 12.3 },
                            "stats": { "today_stats": { "used_quota": 1.0, "added_quota": 2.0 } }
                          }
                        })),
                    )
                }),
            )
            .route(
                "/api/backend/users/info",
                get(move || {
                    let user_info_hits_ref = Arc::clone(&user_info_hits_ref);
                    async move {
                        user_info_hits_ref.fetch_add(1, Ordering::Relaxed);
                        (
                            StatusCode::OK,
                            Json(serde_json::json!({
                              "daily_spent_usd": 1.0,
                              "daily_budget_usd": 60,
                              "plan_expires_at": "2030-01-01T00:00:00Z"
                            })),
                        )
                    }
                }),
            )
            .route(
                "/api/backend/subscriptions",
                get(move || {
                    let subscriptions_hits_ref = Arc::clone(&subscriptions_hits_ref);
                    async move {
                        subscriptions_hits_ref.fetch_add(1, Ordering::Relaxed);
                        (StatusCode::OK, Json(serde_json::json!({ "data": [] })))
                    }
                }),
            );

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let base = format!("http://{}:{}", addr.ip(), addr.port());
        let handle = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        let tmp = tempfile::tempdir().unwrap();
        let secrets = SecretStore::new(tmp.path().join("secrets.json"));
        secrets.set_provider_key("p1", "k1").unwrap();
        secrets.set_usage_token("p1", "jwt-token").unwrap();
        let st = mk_state(format!("{base}/v1"), secrets);
        {
            let mut cfg = st.cfg.write();
            if let Some(p) = cfg.providers.get_mut("p1") {
                p.base_url = "https://codex-api.packycode.com/v1".to_string();
                p.usage_base_url = Some(base.clone());
            }
        }
        st.store
            .put_quota_snapshot(
                "p1",
                &serde_json::json!({
                    "kind": "token_stats",
                    "updated_at_unix_ms": unix_ms(),
                    "remaining": 12.3,
                    "today_used": 1.0,
                    "today_added": 2.0,
                    "package_expires_at_unix_ms": unix_ms().saturating_add(24 * 60 * 60 * 1000),
                    "last_error": "",
                    "effective_usage_base": base
                }),
            )
            .expect("seed cached quota snapshot");

        let snap = refresh_quota_for_provider(&st, "p1").await;
        handle.abort();

        assert!(snap.last_error.is_empty());
        assert!(snap.package_expires_at_unix_ms.is_some());
        assert_eq!(user_info_hits.load(Ordering::Relaxed), 1);
        assert_eq!(subscriptions_hits.load(Ordering::Relaxed), 0);
    }

    #[tokio::test]
    async fn cached_future_package_expiry_does_not_disable_packycode_api_refresh() {
        use axum::http::StatusCode;
        use axum::routing::get;
        use axum::{Json, Router};
        use std::sync::Arc;
        use std::sync::atomic::{AtomicU64, Ordering};

        let _guard = usage_base_gate_test_lock().lock().await;

        clear_usage_base_refresh_gate();

        let budget_hits = Arc::new(AtomicU64::new(0));
        let token_stats_hits = Arc::new(AtomicU64::new(0));
        let budget_hits_ref = Arc::clone(&budget_hits);
        let token_stats_hits_ref = Arc::clone(&token_stats_hits);
        let app = Router::new()
            .route(
                "/api/backend/users/info",
                get(move || {
                    let budget_hits_ref = Arc::clone(&budget_hits_ref);
                    async move {
                        budget_hits_ref.fetch_add(1, Ordering::Relaxed);
                        (
                            StatusCode::TOO_MANY_REQUESTS,
                            Json(serde_json::json!({ "error": "rate limited" })),
                        )
                    }
                }),
            )
            .route(
                "/api/token-stats",
                get(move || {
                    let token_stats_hits_ref = Arc::clone(&token_stats_hits_ref);
                    async move {
                        token_stats_hits_ref.fetch_add(1, Ordering::Relaxed);
                        (
                            StatusCode::TOO_MANY_REQUESTS,
                            Json(serde_json::json!({ "error": "rate limited" })),
                        )
                    }
                }),
            );

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let base = format!("http://{}:{}", addr.ip(), addr.port());
        let handle = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        let tmp = tempfile::tempdir().unwrap();
        let secrets = SecretStore::new(tmp.path().join("secrets.json"));
        secrets.set_provider_key("p1", "api-key").unwrap();
        secrets.set_usage_token("p1", "jwt-token").unwrap();
        let st = mk_state(format!("{base}/v1"), secrets);
        {
            let mut cfg = st.cfg.write();
            if let Some(p) = cfg.providers.get_mut("p1") {
                p.base_url = "https://codex-api.packycode.com/v1".to_string();
                p.usage_base_url = Some(base.clone());
            }
        }
        st.store
            .put_quota_snapshot(
                "p1",
                &serde_json::json!({
                    "kind": "budget_info",
                    "updated_at_unix_ms": unix_ms(),
                    "daily_spent_usd": 1.0,
                    "package_expires_at_unix_ms": unix_ms().saturating_add(24 * 60 * 60 * 1000),
                    "last_error": "",
                    "effective_usage_base": base
                }),
            )
            .expect("seed cached quota snapshot");

        let snap = refresh_quota_for_provider(&st, "p1").await;
        handle.abort();
        clear_usage_base_refresh_gate();

        assert_eq!(snap.updated_at_unix_ms, 0);
        assert_eq!(snap.last_error, format!("http 429 from {base}"));
        assert_eq!(budget_hits.load(Ordering::Relaxed), 1);
        assert_eq!(token_stats_hits.load(Ordering::Relaxed), 0);
    }

    #[tokio::test]
    async fn package_expiry_does_not_propagate_to_non_packycode_provider() {
        let (base, _h) = start_mock_server(true).await;
        let tmp = tempfile::tempdir().unwrap();
        let secrets = SecretStore::new(tmp.path().join("secrets.json"));
        secrets.set_provider_key("p1", "k-shared").unwrap();
        secrets.set_provider_key("p2", "k-shared").unwrap();

        let providers = std::collections::BTreeMap::from([
            (
                "p1".to_string(),
                ProviderConfig {
                    display_name: "P1".to_string(),
                    base_url: "https://codex-api.packycode.com/v1".to_string(),
                    usage_adapter: String::new(),
                    usage_base_url: Some(base.clone()),
                    group: None,
                    disabled: false,
                    supports_websockets: false,
                    api_key: String::new(),
                },
            ),
            (
                "p2".to_string(),
                ProviderConfig {
                    display_name: "P2".to_string(),
                    base_url: "https://example.com/v1".to_string(),
                    usage_adapter: String::new(),
                    usage_base_url: Some(base.clone()),
                    group: None,
                    disabled: false,
                    supports_websockets: false,
                    api_key: String::new(),
                },
            ),
        ]);
        let st = mk_state_with_providers(
            providers,
            vec!["p1".to_string(), "p2".to_string()],
            secrets,
        );

        let source = refresh_quota_for_provider(&st, "p1").await;
        assert!(source.last_error.is_empty());
        assert!(source.package_expires_at_unix_ms.is_some());

        let quota = st.store.list_quota_snapshots();
        let p2 = quota.get("p2").expect("p2 snapshot should be propagated");
        assert_eq!(
            p2.get("package_expires_at_unix_ms").and_then(|v| v.as_u64()),
            None
        );
    }

    #[test]
    fn silent_quota_propagation_does_not_duplicate_budget_spend() {
        let tmp = tempfile::tempdir().unwrap();
        let secrets = SecretStore::new(tmp.path().join("secrets.json"));
        let st = mk_state("http://127.0.0.1:9/v1".to_string(), secrets);

        let mut snap = QuotaSnapshot::empty(UsageKind::BudgetInfo);
        snap.updated_at_unix_ms = 1_739_120_000_000;
        snap.daily_spent_usd = Some(5.0);

        store_quota_snapshot(&st, "p1", &snap);
        store_quota_snapshot_silent(&st, "p2", &snap);

        let p1_days = st.store.list_spend_days("p1");
        let p2_days = st.store.list_spend_days("p2");
        assert_eq!(p1_days.len(), 1);
        assert!(p2_days.is_empty());
        assert!(st.store.get_spend_state("p1").is_some());
        assert!(st.store.get_spend_state("p2").is_none());
    }

    #[test]
    fn track_budget_spend_reuses_remote_open_day_after_state_rebuild() {
        let tmp = tempfile::tempdir().unwrap();
        let secrets = SecretStore::new(tmp.path().join("secrets.json"));
        secrets.set_provider_key("p1", "sk-remote-owner").unwrap();
        let st = mk_state("https://usage.example/v1".to_string(), secrets);

        st.store.put_spend_day(
            "p1",
            1_711_929_600_000,
            &serde_json::json!({
                "provider": "p1",
                "started_at_unix_ms": 1_711_929_600_000u64,
                "ended_at_unix_ms": Value::Null,
                "tracked_spend_usd": 17.47,
                "last_seen_daily_spent_usd": 17.47,
                "updated_at_unix_ms": 2_222u64,
                "producer_node_id": "node-remote",
                "producer_node_name": "remote",
                "applied_from_node_id": "node-remote",
                "applied_from_node_name": "remote"
            }),
        );
        assert!(st.store.get_spend_state("p1").is_none());

        let mut snap = QuotaSnapshot::empty(UsageKind::BudgetInfo);
        snap.updated_at_unix_ms = 1_711_929_603_333;
        snap.daily_spent_usd = Some(20.0);

        track_budget_spend(&st, "p1", &snap);

        let spend_days = st.store.list_spend_days("p1");
        assert_eq!(spend_days.len(), 1, "should update existing open row");
        assert_eq!(
            spend_days[0]
                .get("tracked_spend_usd")
                .and_then(|value| value.as_f64()),
            Some(20.0)
        );
        assert_eq!(
            spend_days[0]
                .get("last_seen_daily_spent_usd")
                .and_then(|value| value.as_f64()),
            Some(20.0)
        );

        let spend_state = st.store.get_spend_state("p1").expect("rebuilt spend state");
        assert_eq!(
            spend_state
                .get("open_day_started_at_unix_ms")
                .and_then(|value| value.as_u64()),
            Some(1_711_929_600_000)
        );
        assert_eq!(
            spend_state
                .get("last_seen_daily_spent_usd")
                .and_then(|value| value.as_f64()),
            Some(20.0)
        );
    }

    #[test]
    fn track_budget_spend_skips_non_zero_initial_baseline_without_same_day_requests() {
        let tmp = tempfile::tempdir().unwrap();
        let secrets = SecretStore::new(tmp.path().join("secrets.json"));
        let st = mk_state("https://usage.example/v1".to_string(), secrets);

        let mut snap = QuotaSnapshot::empty(UsageKind::BudgetInfo);
        snap.updated_at_unix_ms = chrono::Local
            .with_ymd_and_hms(2026, 4, 1, 0, 58, 0)
            .single()
            .unwrap()
            .timestamp_millis() as u64;
        snap.daily_spent_usd = Some(17.4690825);

        track_budget_spend(&st, "p1", &snap);

        let spend_days = st.store.list_spend_days("p1");
        assert_eq!(spend_days.len(), 1);
        assert_eq!(
            spend_days[0]
                .get("tracked_spend_usd")
                .and_then(|value| value.as_f64()),
            Some(0.0)
        );
        assert_eq!(
            spend_days[0]
                .get("last_seen_daily_spent_usd")
                .and_then(|value| value.as_f64()),
            Some(17.4690825)
        );
    }

    #[test]
    fn track_budget_spend_keeps_non_zero_initial_baseline_when_same_day_requests_exist() {
        let tmp = tempfile::tempdir().unwrap();
        let secrets = SecretStore::new(tmp.path().join("secrets.json"));
        let st = mk_state("https://usage.example/v1".to_string(), secrets);
        let ts = chrono::Local
            .with_ymd_and_hms(2026, 4, 1, 0, 58, 0)
            .single()
            .unwrap()
            .timestamp_millis() as u64;
        st.store.upsert_usage_request_sync_rows(&[crate::orchestrator::store::UsageRequestSyncRow {
            id: "req-1".to_string(),
            unix_ms: ts,
            ingested_at_unix_ms: ts,
            provider: "p1".to_string(),
            api_key_ref: "-".to_string(),
            model: String::new(),
            origin: "windows".to_string(),
            transport: "http".to_string(),
            session_id: String::new(),
            node_id: String::new(),
            node_name: String::new(),
            input_tokens: 0,
            output_tokens: 0,
            total_tokens: 100,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
        }]);

        let mut snap = QuotaSnapshot::empty(UsageKind::BudgetInfo);
        snap.updated_at_unix_ms = ts;
        snap.daily_spent_usd = Some(17.4690825);

        track_budget_spend(&st, "p1", &snap);

        let spend_days = st.store.list_spend_days("p1");
        assert_eq!(spend_days.len(), 1);
        assert_eq!(
            spend_days[0]
                .get("tracked_spend_usd")
                .and_then(|value| value.as_f64()),
            Some(17.4690825)
        );
    }

    #[test]
    fn track_budget_spend_starts_new_local_day_without_waiting_for_spend_reset() {
        let tmp = tempfile::tempdir().unwrap();
        let secrets = SecretStore::new(tmp.path().join("secrets.json"));
        let st = mk_state("https://usage.example/v1".to_string(), secrets);
        let first_ts = chrono::Local
            .with_ymd_and_hms(2026, 4, 7, 23, 58, 0)
            .single()
            .unwrap()
            .timestamp_millis() as u64;
        let second_ts = chrono::Local
            .with_ymd_and_hms(2026, 4, 8, 0, 5, 0)
            .single()
            .unwrap()
            .timestamp_millis() as u64;
        st.store.upsert_usage_request_sync_rows(&[
            crate::orchestrator::store::UsageRequestSyncRow {
                id: "req-1".to_string(),
                unix_ms: first_ts,
                ingested_at_unix_ms: first_ts,
                provider: "p1".to_string(),
                api_key_ref: "-".to_string(),
                model: String::new(),
                origin: "windows".to_string(),
                transport: "http".to_string(),
                session_id: String::new(),
                node_id: "node-a".to_string(),
                node_name: "desk-a".to_string(),
                input_tokens: 0,
                output_tokens: 0,
                total_tokens: 100,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0,
            },
            crate::orchestrator::store::UsageRequestSyncRow {
                id: "req-2".to_string(),
                unix_ms: second_ts,
                ingested_at_unix_ms: second_ts,
                provider: "p1".to_string(),
                api_key_ref: "-".to_string(),
                model: String::new(),
                origin: "windows".to_string(),
                transport: "http".to_string(),
                session_id: String::new(),
                node_id: "node-b".to_string(),
                node_name: "desk-b".to_string(),
                input_tokens: 0,
                output_tokens: 0,
                total_tokens: 200,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0,
            },
        ]);

        let mut first = QuotaSnapshot::empty(UsageKind::BudgetInfo);
        first.updated_at_unix_ms = first_ts;
        first.daily_spent_usd = Some(80.0);
        track_budget_spend(&st, "p1", &first);

        let mut second = QuotaSnapshot::empty(UsageKind::BudgetInfo);
        second.updated_at_unix_ms = second_ts;
        second.daily_spent_usd = Some(120.0);
        track_budget_spend(&st, "p1", &second);

        let spend_days = st.store.list_local_spend_days("p1");
        assert_eq!(spend_days.len(), 2, "crossing midnight must open a new tracked day");
        assert_eq!(
            spend_days[0]
                .get("tracked_spend_usd")
                .and_then(|value| value.as_f64()),
            Some(80.0)
        );
        assert_eq!(
            spend_days[1]
                .get("tracked_spend_usd")
                .and_then(|value| value.as_f64()),
            Some(40.0)
        );
        assert_eq!(
            spend_days[1]
                .get("started_at_unix_ms")
                .and_then(|value| value.as_u64()),
            Some(second_ts)
        );
    }

    #[test]
    fn remote_quota_snapshot_updates_shared_tracked_spend_state() {
        let tmp = tempfile::tempdir().unwrap();
        let secrets = SecretStore::new(tmp.path().join("secrets.json"));
        let st = mk_state("https://usage.example/v1".to_string(), secrets);
        let ts = chrono::Local
            .with_ymd_and_hms(2026, 4, 8, 16, 58, 0)
            .single()
            .unwrap()
            .timestamp_millis() as u64;
        st.store.upsert_usage_request_sync_rows(&[crate::orchestrator::store::UsageRequestSyncRow {
            id: "req-remote".to_string(),
            unix_ms: ts,
            ingested_at_unix_ms: ts,
            provider: "p1".to_string(),
            api_key_ref: "-".to_string(),
            model: String::new(),
            origin: "windows".to_string(),
            transport: "http".to_string(),
            session_id: String::new(),
            node_id: "node-remote".to_string(),
            node_name: "remote-box".to_string(),
            input_tokens: 0,
            output_tokens: 0,
            total_tokens: 123,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
        }]);

        let mut snap = QuotaSnapshot::empty(UsageKind::BudgetInfo);
        snap.updated_at_unix_ms = ts;
        snap.daily_spent_usd = Some(126.4827855);
        snap.producer_node_id = Some("node-remote".to_string());
        snap.producer_node_name = Some("remote-box".to_string());

        apply_remote_quota_snapshot(
            &st,
            "p1",
            &snap,
            Some("node-remote"),
            Some("remote-box"),
        );

        let spend_days = st.store.list_local_spend_days("p1");
        assert_eq!(spend_days.len(), 1);
        assert_eq!(
            spend_days[0]
                .get("tracked_spend_usd")
                .and_then(|value| value.as_f64()),
            Some(126.4827855)
        );
        let spend_state = st.store.get_spend_state("p1").expect("shared spend state");
        assert_eq!(
            spend_state
                .get("last_seen_daily_spent_usd")
                .and_then(|value| value.as_f64()),
            Some(126.4827855)
        );
    }

    #[test]
    fn track_budget_spend_rebuilds_only_when_state_points_to_missing_open_day() {
        let tmp = tempfile::tempdir().unwrap();
        let secrets = SecretStore::new(tmp.path().join("secrets.json"));
        secrets.set_provider_key("p1", "sk-remote-owner").unwrap();
        let st = mk_state("https://usage.example/v1".to_string(), secrets);

        st.store.put_spend_day(
            "p1",
            1_711_929_600_000,
            &serde_json::json!({
                "provider": "p1",
                "started_at_unix_ms": 1_711_929_600_000u64,
                "ended_at_unix_ms": Value::Null,
                "tracked_spend_usd": 17.47,
                "last_seen_daily_spent_usd": 17.47,
                "updated_at_unix_ms": 2_222u64,
            }),
        );
        st.store.put_spend_state(
            "p1",
            &serde_json::json!({
                "provider": "p1",
                "tracking_started_unix_ms": 1_700_000_000_000u64,
                "open_day_started_at_unix_ms": 1_700_000_000_001u64,
                "last_seen_daily_spent_usd": 10.0,
                "updated_at_unix_ms": 1_111u64,
            }),
        );

        let mut snap = QuotaSnapshot::empty(UsageKind::BudgetInfo);
        snap.updated_at_unix_ms = 1_711_929_603_333;
        snap.daily_spent_usd = Some(20.0);

        track_budget_spend(&st, "p1", &snap);

        let spend_days = st.store.list_spend_days("p1");
        assert_eq!(spend_days.len(), 1, "should recover onto canonical open row");
        assert_eq!(
            spend_days[0]
                .get("started_at_unix_ms")
                .and_then(|value| value.as_u64()),
            Some(1_711_929_600_000)
        );
        assert_eq!(
            spend_days[0]
                .get("tracked_spend_usd")
                .and_then(|value| value.as_f64()),
            Some(20.0)
        );

        let spend_state = st.store.get_spend_state("p1").expect("rebuilt spend state");
        assert_eq!(
            spend_state
                .get("open_day_started_at_unix_ms")
                .and_then(|value| value.as_u64()),
            Some(1_711_929_600_000)
        );
        assert_eq!(
            spend_state
                .get("tracking_started_unix_ms")
                .and_then(|value| value.as_u64()),
            Some(1_711_929_600_000)
        );
    }

    #[test]
    fn remote_quota_snapshot_skips_disabled_siblings_and_logs_shared_apply() {
        let providers = std::collections::BTreeMap::from([
            (
                "p1".to_string(),
                ProviderConfig {
                    display_name: "P1".to_string(),
                    base_url: "https://usage-router.example/v1".to_string(),
                    usage_adapter: String::new(),
                    usage_base_url: Some("https://usage-router.example".to_string()),
                    group: None,
                    disabled: false,
                    supports_websockets: false,
                    api_key: String::new(),
                },
            ),
            (
                "p2".to_string(),
                ProviderConfig {
                    display_name: "P2".to_string(),
                    base_url: "https://usage-router.example/v1".to_string(),
                    usage_adapter: String::new(),
                    usage_base_url: Some("https://usage-router.example".to_string()),
                    group: None,
                    disabled: true,
                    supports_websockets: false,
                    api_key: String::new(),
                },
            ),
        ]);
        let tmp = tempfile::tempdir().unwrap();
        let secrets = SecretStore::new(tmp.path().join("secrets.json"));
        secrets.set_provider_key("p1", "sk-shared").unwrap();
        secrets.set_provider_key("p2", "sk-shared").unwrap();
        let st = mk_state_with_providers(
            providers,
            vec!["p1".to_string(), "p2".to_string()],
            secrets,
        );

        let mut snap = QuotaSnapshot::empty(UsageKind::BudgetInfo);
        snap.updated_at_unix_ms = 1_739_120_000_000;
        snap.daily_spent_usd = Some(5.0);
        snap.producer_node_id = Some("node-owner".to_string());
        snap.producer_node_name = Some("Owner".to_string());

        apply_remote_quota_snapshot(&st, "p1", &snap, Some("node-owner"), Some("Owner"));

        assert!(st.store.get_quota_snapshot("p1").is_some());
        assert!(
            st.store.get_quota_snapshot("p2").is_none(),
            "disabled sibling should not receive propagated shared quota"
        );
        let events = st.store.list_events_range(None, None, Some(10));
        assert!(
            events.iter().any(|event| {
                event.get("code").and_then(|value| value.as_str())
                    == Some("usage.refresh_shared_applied")
            }),
            "requester should see that the shared usage result came back"
        );
    }

    async fn start_mock_server_token_info() -> (String, tokio::task::JoinHandle<()>) {
        use axum::http::StatusCode;
        use axum::routing::get;
        use axum::{Json, Router};

        let app = Router::new().route(
            "/api/token-stats",
            get(|| async move {
                (
                    StatusCode::OK,
                    Json(serde_json::json!({
                      "data": {
                        "data": {
                          "token_info": {
                            "remain_quota_display": 2953,
                            "today_used_quota_display": 12040,
                            "today_added_quota_display": 14993
                          }
                        }
                      }
                    })),
                )
            }),
        );

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let url = format!("http://{}:{}", addr.ip(), addr.port());
        let h = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        (url, h)
    }

    async fn start_mock_server_today_stats_only() -> (String, tokio::task::JoinHandle<()>) {
        use axum::http::StatusCode;
        use axum::routing::get;
        use axum::{Json, Router};

        let app = Router::new().route(
            "/api/token-stats",
            get(|| async move {
                (
                    StatusCode::OK,
                    Json(serde_json::json!({
                      "data": {
                        "today_stats": {
                          "used_quota": 1561,
                          "added_quota": 15000
                        },
                        "token_info": {
                          "remain_quota_display": 13439
                        }
                      }
                    })),
                )
            }),
        );

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let url = format!("http://{}:{}", addr.ip(), addr.port());
        let h = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        (url, h)
    }

    async fn start_mock_server_token_logs_only() -> (String, tokio::task::JoinHandle<()>) {
        use axum::http::StatusCode;
        use axum::routing::get;
        use axum::{Json, Router};

        let app = Router::new()
            .route(
                "/api/token-stats",
                get(|| async move {
                    (
                        StatusCode::OK,
                        Json(serde_json::json!({
                          "data": {}
                        })),
                    )
                }),
            )
            .route(
                "/api/token-logs",
                get(|| async move {
                    (
                        StatusCode::OK,
                        Json(serde_json::json!({
                          "data": {
                            "data": {
                              "token_info": {
                                "remain_quota_display": "1,343",
                                "today_used_quota_display": "12,040",
                                "today_added_quota_display": "14,993"
                              }
                            }
                          }
                        })),
                    )
                }),
            );

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let url = format!("http://{}:{}", addr.ip(), addr.port());
        let h = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        (url, h)
    }

    #[tokio::test]
    async fn token_stats_accepts_token_info_shape() {
        let (base, _h) = start_mock_server_token_info().await;
        let tmp = tempfile::tempdir().unwrap();
        let secrets = SecretStore::new(tmp.path().join("secrets.json"));
        secrets.set_provider_key("p1", "k1").unwrap();
        let st = mk_state(format!("{base}/v1"), secrets);

        let snap = refresh_quota_for_provider(&st, "p1").await;
        assert!(snap.last_error.is_empty());
        assert_eq!(snap.kind.as_str(), "token_stats");
        assert_eq!(snap.remaining.unwrap_or(0.0), 2953.0);
        assert_eq!(snap.today_used.unwrap_or(0.0), 12040.0);
        assert_eq!(snap.today_added.unwrap_or(0.0), 14993.0);
    }

    #[tokio::test]
    async fn token_logs_fallback_uses_token_info() {
        let (base, _h) = start_mock_server_token_logs_only().await;
        let tmp = tempfile::tempdir().unwrap();
        let secrets = SecretStore::new(tmp.path().join("secrets.json"));
        secrets.set_provider_key("p1", "k1").unwrap();
        let st = mk_state(format!("{base}/v1"), secrets);

        let snap = refresh_quota_for_provider(&st, "p1").await;
        assert!(snap.last_error.is_empty());
        assert_eq!(snap.kind.as_str(), "token_stats");
        assert_eq!(snap.remaining.unwrap_or(0.0), 1343.0);
        assert_eq!(snap.today_used.unwrap_or(0.0), 12040.0);
        assert_eq!(snap.today_added.unwrap_or(0.0), 14993.0);
    }

    #[tokio::test]
    async fn token_stats_uses_today_stats_when_present() {
        let (base, _h) = start_mock_server_today_stats_only().await;
        let tmp = tempfile::tempdir().unwrap();
        let secrets = SecretStore::new(tmp.path().join("secrets.json"));
        secrets.set_provider_key("p1", "k1").unwrap();
        let st = mk_state(format!("{base}/v1"), secrets);

        let snap = refresh_quota_for_provider(&st, "p1").await;
        assert!(snap.last_error.is_empty());
        assert_eq!(snap.kind.as_str(), "token_stats");
        assert_eq!(snap.remaining.unwrap_or(0.0), 13439.0);
        assert_eq!(snap.today_used.unwrap_or(0.0), 1561.0);
        assert_eq!(snap.today_added.unwrap_or(0.0), 15000.0);
    }

    #[test]
    fn shared_provider_fingerprint_ignores_local_shared_provider_id() {
        let tmp_a = tempfile::tempdir().expect("tempdir a");
        let tmp_b = tempfile::tempdir().expect("tempdir b");
        let secrets_a = SecretStore::new(tmp_a.path().join("secrets.json"));
        let secrets_b = SecretStore::new(tmp_b.path().join("secrets.json"));
        let cfg = AppConfig {
            listen: crate::orchestrator::config::ListenConfig {
                host: "127.0.0.1".to_string(),
                port: 4000,
            },
            routing: crate::orchestrator::config::RoutingConfig {
                preferred_provider: "p1".to_string(),
                session_preferred_providers: std::collections::BTreeMap::new(),
                route_mode: crate::orchestrator::config::RouteMode::FollowPreferredAuto,
                auto_return_to_preferred: true,
                preferred_stable_seconds: 1,
                failure_threshold: 1,
                cooldown_seconds: 600,
                request_timeout_seconds: 5,
            },
            providers: std::collections::BTreeMap::from([(
                "p1".to_string(),
                ProviderConfig {
                    display_name: "P1".to_string(),
                    base_url: "https://quota.example/v1".to_string(),
                    usage_adapter: String::new(),
                    usage_base_url: Some("https://quota.example".to_string()),
                    group: None,
                    disabled: false,
                    supports_websockets: false,
                    api_key: String::new(),
                },
            )]),
            provider_order: vec!["p1".to_string()],
        };
        secrets_a.set_provider_key("p1", "sk-same").unwrap();
        secrets_b.set_provider_key("p1", "sk-same").unwrap();
        secrets_a.set_provider_shared_id("p1", "sp_node_a").unwrap();
        secrets_b.set_provider_shared_id("p1", "sp_node_b").unwrap();

        let a = shared_provider_fingerprint(&cfg, &secrets_a, "p1").expect("fingerprint a");
        let b = shared_provider_fingerprint(&cfg, &secrets_b, "p1").expect("fingerprint b");

        assert_eq!(a, b);
    }

    #[test]
    fn as_f64_strips_commas_and_percent() {
        let v = serde_json::json!("14,993");
        assert_eq!(as_f64(Some(&v)).unwrap_or(0.0), 14993.0);
        let v = serde_json::json!("13%");
        assert_eq!(as_f64(Some(&v)).unwrap_or(0.0), 13.0);
    }

    #[test]
    fn quota_snapshot_roundtrips_through_canonical_usage() {
        let snapshot = QuotaSnapshot {
            kind: UsageKind::BudgetInfo,
            updated_at_unix_ms: 1_700_000_000_000,
            remaining: Some(42.5),
            today_used: Some(2.0),
            today_added: Some(5.0),
            daily_spent_usd: Some(7.5),
            daily_budget_usd: Some(20.0),
            weekly_spent_usd: Some(12.0),
            weekly_budget_usd: Some(50.0),
            monthly_spent_usd: Some(30.0),
            monthly_budget_usd: Some(200.0),
            package_expires_at_unix_ms: Some(1_800_000_000_000),
            last_error: String::new(),
            effective_usage_base: Some("https://usage.example".to_string()),
            effective_usage_source: Some("usage_base".to_string()),
            producer_node_id: None,
            producer_node_name: None,
            applied_from_node_id: None,
            applied_from_node_name: None,
            applied_at_unix_ms: 0,
        };

        let canonical =
            canonical_usage_from_snapshot(&snapshot).expect("successful snapshot should normalize");
        let rebuilt = QuotaSnapshot::from_canonical(canonical);

        assert_eq!(rebuilt.kind, snapshot.kind);
        assert_eq!(rebuilt.remaining, snapshot.remaining);
        assert_eq!(rebuilt.daily_spent_usd, snapshot.daily_spent_usd);
        assert_eq!(rebuilt.daily_budget_usd, snapshot.daily_budget_usd);
        assert_eq!(rebuilt.weekly_spent_usd, snapshot.weekly_spent_usd);
        assert_eq!(rebuilt.monthly_budget_usd, snapshot.monthly_budget_usd);
        assert_eq!(
            rebuilt.package_expires_at_unix_ms,
            snapshot.package_expires_at_unix_ms
        );
        assert_eq!(rebuilt.effective_usage_base, snapshot.effective_usage_base);
        assert_eq!(rebuilt.effective_usage_source, snapshot.effective_usage_source);
    }

    #[test]
    fn rate_limit_backoff_prefers_retry_after_header() {
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert(reqwest::header::RETRY_AFTER, "12".parse().unwrap());
        headers.insert("x-ratelimit-reset", "1700000005".parse().unwrap());
        assert_eq!(
            parse_rate_limit_backoff_ms(&headers, 1_700_000_000_000, USAGE_BASE_429_BACKOFF_MS),
            12_000
        );
    }

    #[test]
    fn rate_limit_backoff_uses_reset_when_retry_after_missing() {
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert("x-ratelimit-reset", "1700000015".parse().unwrap());
        assert_eq!(
            parse_rate_limit_backoff_ms(&headers, 1_700_000_000_000, USAGE_BASE_429_BACKOFF_MS),
            15_000
        );
    }

    #[test]
    fn failed_refresh_keeps_last_successful_usage_values() {
        let tmp = tempfile::tempdir().unwrap();
        let secrets = SecretStore::new(tmp.path().join("secrets.json"));
        let st = mk_state("https://example.com/v1".to_string(), secrets);

        let mut previous = QuotaSnapshot::empty(UsageKind::BudgetInfo);
        previous.updated_at_unix_ms = 123;
        previous.daily_spent_usd = Some(12.5);
        previous.daily_budget_usd = Some(120.0);
        previous.weekly_spent_usd = Some(50.0);
        previous.weekly_budget_usd = Some(360.0);
        previous.effective_usage_base = Some("https://codex.packycode.com".to_string());
        store_quota_snapshot(&st, "p1", &previous);

        let mut failed = QuotaSnapshot::empty(UsageKind::BudgetInfo);
        failed.last_error = "http 429 from https://codex.packycode.com".to_string();
        let merged = preserved_quota_snapshot_for_storage(&st, "p1", &failed);

        assert_eq!(merged.updated_at_unix_ms, 123);
        assert_eq!(merged.daily_spent_usd, Some(12.5));
        assert_eq!(merged.daily_budget_usd, Some(120.0));
        assert_eq!(merged.weekly_spent_usd, Some(50.0));
        assert_eq!(merged.weekly_budget_usd, Some(360.0));
        assert_eq!(
            merged.effective_usage_base.as_deref(),
            Some("https://codex.packycode.com")
        );
        assert_eq!(
            merged.last_error,
            "http 429 from https://codex.packycode.com".to_string()
        );
    }

    #[test]
    fn repeated_failed_refresh_still_keeps_last_successful_usage_values() {
        let tmp = tempfile::tempdir().unwrap();
        let secrets = SecretStore::new(tmp.path().join("secrets.json"));
        let st = mk_state("https://example.com/v1".to_string(), secrets);

        let mut previous = QuotaSnapshot::empty(UsageKind::BudgetInfo);
        previous.updated_at_unix_ms = 123;
        previous.daily_spent_usd = Some(12.5);
        previous.daily_budget_usd = Some(120.0);
        previous.weekly_spent_usd = Some(50.0);
        previous.weekly_budget_usd = Some(360.0);
        previous.last_error = "usage base rate limited: https://codex.packycode.com".to_string();
        previous.effective_usage_base = Some("https://codex.packycode.com".to_string());
        st.store
            .put_quota_snapshot("p1", &previous.to_json())
            .expect("seed previous failed snapshot");

        let mut failed = QuotaSnapshot::empty(UsageKind::BudgetInfo);
        failed.last_error = "usage base rate limited: https://codex.packycode.com (retry in ~23m)".to_string();
        let merged = preserved_quota_snapshot_for_storage(&st, "p1", &failed);

        assert_eq!(merged.updated_at_unix_ms, 123);
        assert_eq!(merged.daily_spent_usd, Some(12.5));
        assert_eq!(merged.daily_budget_usd, Some(120.0));
        assert_eq!(merged.weekly_spent_usd, Some(50.0));
        assert_eq!(merged.weekly_budget_usd, Some(360.0));
        assert_eq!(
            merged.effective_usage_base.as_deref(),
            Some("https://codex.packycode.com")
        );
        assert_eq!(
            merged.last_error,
            "usage base rate limited: https://codex.packycode.com (retry in ~23m)"
        );
    }

    #[test]
    fn repeated_rate_limited_failures_do_not_spam_duplicate_error_events() {
        let tmp = tempfile::tempdir().unwrap();
        let secrets = SecretStore::new(tmp.path().join("secrets.json"));
        let st = mk_state("https://example.com/v1".to_string(), secrets);

        let mut first = QuotaSnapshot::empty(UsageKind::BudgetInfo);
        first.last_error =
            "usage base rate limited: https://codex.packycode.com (retry in ~7m 2s)".to_string();
        store_quota_snapshot(&st, "p1", &first);

        let mut second = QuotaSnapshot::empty(UsageKind::BudgetInfo);
        second.last_error =
            "usage base rate limited: https://codex.packycode.com (retry in ~3m 1s)".to_string();
        store_quota_snapshot(&st, "p1", &second);

        let failed_events = st
            .store
            .list_events_range(None, None, Some(20))
            .into_iter()
            .filter(|event| {
                event.get("code").and_then(Value::as_str) == Some("usage.refresh_failed")
            })
            .count();
        assert_eq!(failed_events, 1);
    }

    #[test]
    fn successful_refresh_after_failure_emits_recovered_event_with_source() {
        let tmp = tempfile::tempdir().unwrap();
        let secrets = SecretStore::new(tmp.path().join("secrets.json"));
        let st = mk_state("https://example.com/v1".to_string(), secrets);

        let mut failed = QuotaSnapshot::empty(UsageKind::BudgetInfo);
        failed.last_error = "usage base rate limited: https://codex.packycode.com".to_string();
        store_quota_snapshot(&st, "p1", &failed);

        let mut recovered = QuotaSnapshot::empty(UsageKind::BudgetInfo);
        recovered.updated_at_unix_ms = 123;
        recovered.daily_spent_usd = Some(1.0);
        recovered.daily_budget_usd = Some(10.0);
        recovered.effective_usage_base = Some("https://codex.packycode.com".to_string());
        recovered.effective_usage_source = Some("usage_base".to_string());
        store_quota_snapshot(&st, "p1", &recovered);

        let recovered_event = st
            .store
            .list_events_range(None, None, Some(20))
            .into_iter()
            .find(|event| event.get("code").and_then(Value::as_str) == Some("usage.refresh_recovered"))
            .expect("missing recovered event");
        assert_eq!(
            recovered_event.get("provider").and_then(Value::as_str),
            Some("p1")
        );
        assert!(
            recovered_event
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .contains("usage base")
        );
    }

    #[test]
    fn background_quota_scheduler_requires_recent_activity_without_alive_peers() {
        let now = 10 * 60 * 1000;
        assert!(!should_run_background_quota_scheduler(now, 0, false));
        assert!(!should_run_background_quota_scheduler(now, now.saturating_sub(10 * 60 * 1000), false));
        assert!(should_run_background_quota_scheduler(now, now - 1_000, false));
        assert!(should_run_background_quota_scheduler(now, 0, true));
    }

    #[test]
    fn standard_quota_refresh_prefers_0058_before_next_daily_reset() {
        use chrono::{FixedOffset, TimeZone, Timelike};

        let tz = FixedOffset::east_opt(8 * 3600).unwrap();
        let now = tz.with_ymd_and_hms(2026, 3, 10, 11, 25, 42).unwrap();
        let due = next_standard_quota_refresh_at(now);
        assert_eq!(due.hour(), 11);
        assert_eq!(due.minute(), 58);
        assert_eq!(due.second(), 0);
    }

    #[test]
    fn standard_quota_refresh_uses_0001_after_2358() {
        use chrono::{FixedOffset, TimeZone, Timelike};

        let tz = FixedOffset::east_opt(8 * 3600).unwrap();
        let now = tz.with_ymd_and_hms(2026, 3, 10, 23, 58, 0).unwrap();
        let due = next_standard_quota_refresh_at(now);
        assert_eq!(due.hour(), 0);
        assert_eq!(due.minute(), 1);
        assert_eq!(due.second(), 0);
    }

    #[test]
    fn standard_quota_refresh_uses_0058_after_daily_reset_window() {
        use chrono::{Duration, Local, Timelike};

        let now = Local::now();
        let now_ms = now.timestamp_millis().max(0) as u64;
        let mut snapshot = QuotaSnapshot::empty(UsageKind::BudgetInfo);
        snapshot.updated_at_unix_ms = now_ms.saturating_sub(Duration::minutes(5).num_milliseconds() as u64);
        snapshot.last_error = "http 429 from https://usage-router.example".to_string();

        let due = initial_quota_refresh_due_unix_ms(
            now_ms,
            Some(&snapshot),
            true,
            true,
            1,
            PackageExpiryStrategy::None,
        )
        .expect("standard due");
        let due_dt = Local.timestamp_millis_opt(due as i64).single().unwrap();
        assert!(due > now_ms);
        assert!(matches!(due_dt.minute(), 1 | 58));
        assert_eq!(due_dt.second(), 0);
    }

    #[test]
    fn initial_standard_refresh_due_without_snapshot_waits_for_aligned_window() {
        use chrono::{Local, Timelike};

        let now = Local::now();
        let now_ms = now.timestamp_millis().max(0) as u64;

        let due = initial_quota_refresh_due_unix_ms(
            now_ms,
            None,
            true,
            true,
            1,
            PackageExpiryStrategy::None,
        )
        .expect("standard due without snapshot");
        let due_dt = Local.timestamp_millis_opt(due as i64).single().unwrap();
        assert!(due > now_ms);
        assert!(matches!(due_dt.minute(), 1 | 58));
        assert_eq!(due_dt.second(), 0);
    }

    #[test]
    fn packycode_refresh_aligns_to_minute_58_only() {
        use chrono::{FixedOffset, TimeZone, Timelike};

        let tz = FixedOffset::east_opt(8 * 3600).unwrap();
        let now = tz.with_ymd_and_hms(2026, 3, 11, 11, 25, 42).unwrap();
        let due = next_priority_quota_refresh_at(now);
        assert_eq!(due.minute(), 58);
        assert_eq!(due.second(), 0);

        let now = tz.with_ymd_and_hms(2026, 3, 11, 11, 58, 0).unwrap();
        let due = next_priority_quota_refresh_at(now);
        assert_eq!(due.hour(), 12);
        assert_eq!(due.minute(), 58);
        assert_eq!(due.second(), 0);

        let now = tz.with_ymd_and_hms(2026, 3, 10, 23, 58, 0).unwrap();
        let due = next_priority_quota_refresh_at(now);
        assert_eq!(due.hour(), 0);
        assert_eq!(due.minute(), 1);
        assert_eq!(due.second(), 0);
    }

    #[test]
    fn initial_packycode_refresh_due_uses_minute_58_window() {
        use chrono::{Local, Timelike};

        let now = Local::now();
        let now_ms = now.timestamp_millis().max(0) as u64;
        let mut snapshot = QuotaSnapshot::empty(UsageKind::BudgetInfo);
        snapshot.updated_at_unix_ms = now_ms.saturating_sub(60_000);

        let due = initial_quota_refresh_due_unix_ms(
            now_ms,
            Some(&snapshot),
            true,
            true,
            1,
            PackageExpiryStrategy::BackendUsersInfo,
        )
        .expect("packycode due");
        let due_dt = Local.timestamp_millis_opt(due as i64).single().unwrap();
        assert!(due > now_ms);
        assert!(matches!(due_dt.minute(), 1 | 58));
        assert_eq!(due_dt.second(), 0);
    }

    #[test]
    fn initial_packycode_refresh_due_without_snapshot_still_waits_for_minute_58() {
        use chrono::{Local, Timelike};

        let now = Local::now();
        let now_ms = now.timestamp_millis().max(0) as u64;

        let due = initial_quota_refresh_due_unix_ms(
            now_ms,
            None,
            true,
            true,
            1,
            PackageExpiryStrategy::BackendUsersInfo,
        )
        .expect("packycode due without snapshot");
        let due_dt = Local.timestamp_millis_opt(due as i64).single().unwrap();
        assert!(due > now_ms);
        assert!(matches!(due_dt.minute(), 1 | 58));
        assert_eq!(due_dt.second(), 0);
    }

    #[test]
    fn initial_packycode_refresh_due_retries_even_after_failed_snapshot() {
        use chrono::{Local, Timelike};

        let now = Local::now();
        let now_ms = now.timestamp_millis().max(0) as u64;
        let mut snapshot = QuotaSnapshot::empty(UsageKind::BudgetInfo);
        snapshot.updated_at_unix_ms = 0;
        snapshot.last_error = "initial refresh failed".to_string();

        let due = initial_quota_refresh_due_unix_ms(
            now_ms,
            Some(&snapshot),
            true,
            true,
            1,
            PackageExpiryStrategy::BackendUsersInfo,
        )
        .expect("packycode due after failed snapshot");
        let due_dt = Local.timestamp_millis_opt(due as i64).single().unwrap();
        assert!(due > now_ms);
        assert!(matches!(due_dt.minute(), 1 | 58));
        assert_eq!(due_dt.second(), 0);
    }

    #[test]
    fn usage_proxy_pool_rotates_per_request() {
        clear_usage_proxy_rotation_state();
        let tmp = tempfile::tempdir().unwrap();
        let secrets = SecretStore::new(tmp.path().join("secrets.json"));
        secrets
            .set_usage_proxy_pool(
                "p1",
                vec![
                    "http://127.0.0.1:9001".to_string(),
                    "http://127.0.0.1:9002".to_string(),
                ],
            )
            .unwrap();
        let st = mk_state("https://example.com/v1".to_string(), secrets);

        assert_eq!(
            next_usage_proxy_for_provider(&st, "p1").as_deref(),
            Some("http://127.0.0.1:9001")
        );
        assert_eq!(
            next_usage_proxy_for_provider(&st, "p1").as_deref(),
            Some("http://127.0.0.1:9002")
        );
        assert_eq!(
            next_usage_proxy_for_provider(&st, "p1").as_deref(),
            Some("http://127.0.0.1:9001")
        );
    }

    #[test]
    fn clear_quota_snapshot_resets_stale_usage_state() {
        let tmp = tempfile::tempdir().unwrap();
        let secrets = SecretStore::new(tmp.path().join("secrets.json"));
        let st = mk_state("https://example.com/v1".to_string(), secrets);

        let mut previous = QuotaSnapshot::empty(UsageKind::BudgetInfo);
        previous.updated_at_unix_ms = 123;
        previous.daily_spent_usd = Some(12.5);
        previous.last_error = "http 404 from https://api-vip.codex-for.me".to_string();
        previous.effective_usage_base = Some("https://api-vip.codex-for.me".to_string());
        st.store
            .put_quota_snapshot("p1", &previous.to_json())
            .expect("seed quota snapshot");

        clear_quota_snapshot(&st, "p1");

        let cleared = st
            .store
            .get_quota_snapshot("p1")
            .and_then(|value| quota_snapshot_from_json(&value))
            .expect("cleared quota snapshot");
        assert_eq!(cleared.updated_at_unix_ms, 0);
        assert!(cleared.last_error.is_empty());
        assert!(cleared.effective_usage_base.is_none());
        assert!(cleared.daily_spent_usd.is_none());
    }

    #[test]
    fn reconcile_blocked_shared_quota_snapshots_clears_remote_stale_snapshot() {
        let tmp = tempfile::tempdir().unwrap();
        let secrets = SecretStore::new(tmp.path().join("secrets.json"));
        let st = mk_state("https://api-vip.codex-for.me/v1".to_string(), secrets);

        let mut previous = QuotaSnapshot::empty(UsageKind::BudgetInfo);
        previous.updated_at_unix_ms = 123;
        previous.remaining = Some(50.0);
        previous.daily_budget_usd = Some(573.33);
        previous.applied_from_node_id = Some("node-remote".to_string());
        previous.applied_from_node_name = Some("SYB".to_string());
        st.store
            .put_quota_snapshot("p1", &previous.to_json())
            .expect("seed quota snapshot");

        let refreshed = reconcile_blocked_shared_quota_snapshots(
            &st,
            Some(&crate::lan_sync::LanSyncStatusSnapshot {
                enabled: true,
                discovery_port: 38455,
                heartbeat_interval_ms: 2000,
                peer_stale_after_ms: 20_000,
                last_peer_heartbeat_received_unix_ms: 0,
                last_peer_heartbeat_source: None,
                last_http_sync_probe: None,
                last_http_sync_failure: None,
                local_node: crate::lan_sync::LanLocalNodeSnapshot {
                    node_id: "node-local".to_string(),
                    node_name: "local".to_string(),
                    listen_addr: Some("127.0.0.1:4000".to_string()),
                    remote_update_updater_port: None,
                    capabilities: Vec::new(),
                    version_inventory: Vec::new(),
                    build_identity: crate::lan_sync::current_build_identity(),
                    version_sync: crate::lan_sync::LanLocalVersionSyncSnapshot {
                        target_ref: None,
                        git_worktree_clean: true,
                        update_to_local_build_allowed: true,
                        blocked_reason: None,
                    },
                    remote_update_status: None,
                    sync_contracts: std::collections::BTreeMap::new(),
                    provider_fingerprints: Vec::new(),
                    provider_definitions_revision: String::new(),
                },
                peers: vec![crate::lan_sync::LanPeerSnapshot {
                    node_id: "node-remote".to_string(),
                    node_name: "SYB".to_string(),
                    listen_addr: "192.168.1.10:4000".to_string(),
                    remote_update_updater_port: None,
                    last_heartbeat_unix_ms: 0,
                    capabilities: Vec::new(),
                    version_inventory: Vec::new(),
                    build_identity: crate::lan_sync::current_build_identity(),
                    provider_fingerprints: Vec::new(),
                    provider_definitions_revision: String::new(),
                    sync_contracts: std::collections::BTreeMap::new(),
                    followed_source_node_id: None,
                    trusted: true,
                    pair_state: Some("trusted".to_string()),
                    pair_request_id: None,
                    remote_update_readiness: None,
                    remote_update_status: None,
                    sync_blocked_domains: vec![
                        crate::lan_sync::LAN_SYNC_DOMAIN_SHARED_QUOTA.to_string(),
                    ],
                    sync_diagnostics: Vec::new(),
                    build_matches_local: false,
                    heartbeat_age_ms: 0,
                    http_probe_state: None,
                    http_probe_detail: None,
                }],
            }),
            &[SharedQuotaOwnerStatus {
                provider: "p1".to_string(),
                shared_provider_id: "shared-p1".to_string(),
                shared_provider_fingerprint: "https://api-vip.codex-for.me|99c51bdf89d7be31".to_string(),
                owner_node_id: "node-remote".to_string(),
                owner_node_name: "SYB".to_string(),
                local_is_owner: false,
                contender_count: 2,
            }],
        );

        assert_eq!(refreshed, vec!["p1".to_string()]);
        let cleared = st
            .store
            .get_quota_snapshot("p1")
            .and_then(|value| quota_snapshot_from_json(&value))
            .expect("cleared quota snapshot");
        assert_eq!(cleared.updated_at_unix_ms, 0);
        assert!(cleared.applied_from_node_id.is_none());
    }

    #[test]
    fn reconcile_blocked_shared_quota_snapshots_keeps_snapshot_when_blocked_peer_is_not_owner() {
        let tmp = tempfile::tempdir().unwrap();
        let secrets = SecretStore::new(tmp.path().join("secrets.json"));
        let st = mk_state("https://api-vip.codex-for.me/v1".to_string(), secrets);

        let mut previous = QuotaSnapshot::empty(UsageKind::BudgetInfo);
        previous.updated_at_unix_ms = 123;
        previous.remaining = Some(50.0);
        previous.daily_budget_usd = Some(573.33);
        previous.applied_from_node_id = Some("node-remote".to_string());
        previous.applied_from_node_name = Some("SYB".to_string());
        st.store
            .put_quota_snapshot("p1", &previous.to_json())
            .expect("seed quota snapshot");

        let refreshed = reconcile_blocked_shared_quota_snapshots(
            &st,
            Some(&crate::lan_sync::LanSyncStatusSnapshot {
                enabled: true,
                discovery_port: 38455,
                heartbeat_interval_ms: 2000,
                peer_stale_after_ms: 20_000,
                last_peer_heartbeat_received_unix_ms: 0,
                last_peer_heartbeat_source: None,
                last_http_sync_probe: None,
                last_http_sync_failure: None,
                local_node: crate::lan_sync::LanLocalNodeSnapshot {
                    node_id: "node-local".to_string(),
                    node_name: "local".to_string(),
                    listen_addr: Some("127.0.0.1:4000".to_string()),
                    remote_update_updater_port: None,
                    capabilities: Vec::new(),
                    version_inventory: Vec::new(),
                    build_identity: crate::lan_sync::current_build_identity(),
                    version_sync: crate::lan_sync::LanLocalVersionSyncSnapshot {
                        target_ref: None,
                        git_worktree_clean: true,
                        update_to_local_build_allowed: true,
                        blocked_reason: None,
                    },
                    remote_update_status: None,
                    sync_contracts: std::collections::BTreeMap::new(),
                    provider_fingerprints: Vec::new(),
                    provider_definitions_revision: String::new(),
                },
                peers: vec![crate::lan_sync::LanPeerSnapshot {
                    node_id: "node-remote".to_string(),
                    node_name: "SYB".to_string(),
                    listen_addr: "192.168.1.10:4000".to_string(),
                    remote_update_updater_port: None,
                    last_heartbeat_unix_ms: 0,
                    capabilities: Vec::new(),
                    version_inventory: Vec::new(),
                    build_identity: crate::lan_sync::current_build_identity(),
                    provider_fingerprints: Vec::new(),
                    provider_definitions_revision: String::new(),
                    sync_contracts: std::collections::BTreeMap::new(),
                    followed_source_node_id: None,
                    trusted: true,
                    pair_state: Some("trusted".to_string()),
                    pair_request_id: None,
                    remote_update_readiness: None,
                    remote_update_status: None,
                    sync_blocked_domains: vec![
                        crate::lan_sync::LAN_SYNC_DOMAIN_SHARED_QUOTA.to_string(),
                    ],
                    sync_diagnostics: Vec::new(),
                    build_matches_local: false,
                    heartbeat_age_ms: 0,
                    http_probe_state: None,
                    http_probe_detail: None,
                }],
            }),
            &[SharedQuotaOwnerStatus {
                provider: "p1".to_string(),
                shared_provider_id: "shared-p1".to_string(),
                shared_provider_fingerprint: "https://api-vip.codex-for.me|99c51bdf89d7be31".to_string(),
                owner_node_id: "node-local".to_string(),
                owner_node_name: "local".to_string(),
                local_is_owner: true,
                contender_count: 2,
            }],
        );

        assert!(refreshed.is_empty());
        let kept = st
            .store
            .get_quota_snapshot("p1")
            .and_then(|value| quota_snapshot_from_json(&value))
            .expect("kept quota snapshot");
        assert_eq!(kept.updated_at_unix_ms, 123);
        assert_eq!(kept.applied_from_node_id.as_deref(), Some("node-remote"));
    }

    #[test]
    fn reconcile_blocked_shared_quota_snapshots_derives_owner_when_status_list_is_empty() {
        let tmp = tempfile::tempdir().unwrap();
        let secrets = SecretStore::new(tmp.path().join("secrets.json"));
        let st = mk_state("https://api-vip.codex-for.me/v1".to_string(), secrets);

        let mut previous = QuotaSnapshot::empty(UsageKind::BudgetInfo);
        previous.updated_at_unix_ms = 123;
        previous.remaining = Some(50.0);
        previous.daily_budget_usd = Some(573.33);
        previous.applied_from_node_id = Some("node-remote".to_string());
        previous.applied_from_node_name = Some("SYB".to_string());
        st.store
            .put_quota_snapshot("p1", &previous.to_json())
            .expect("seed quota snapshot");

        let refreshed = reconcile_blocked_shared_quota_snapshots(
            &st,
            Some(&crate::lan_sync::LanSyncStatusSnapshot {
                enabled: true,
                discovery_port: 38455,
                heartbeat_interval_ms: 2000,
                peer_stale_after_ms: 20_000,
                last_peer_heartbeat_received_unix_ms: 0,
                last_peer_heartbeat_source: None,
                last_http_sync_probe: None,
                last_http_sync_failure: None,
                local_node: crate::lan_sync::LanLocalNodeSnapshot {
                    node_id: "node-local".to_string(),
                    node_name: "local".to_string(),
                    listen_addr: Some("127.0.0.1:4000".to_string()),
                    remote_update_updater_port: None,
                    capabilities: Vec::new(),
                    version_inventory: vec!["shared_quota_v2".to_string()],
                    build_identity: crate::lan_sync::current_build_identity(),
                    version_sync: crate::lan_sync::LanLocalVersionSyncSnapshot {
                        target_ref: None,
                        git_worktree_clean: true,
                        update_to_local_build_allowed: true,
                        blocked_reason: None,
                    },
                    remote_update_status: None,
                    sync_contracts: std::collections::BTreeMap::from([(
                        crate::lan_sync::LAN_SYNC_DOMAIN_SHARED_QUOTA.to_string(),
                        2,
                    )]),
                    provider_fingerprints: vec![
                        "https://api-vip.codex-for.me|anon".to_string(),
                    ],
                    provider_definitions_revision: String::new(),
                },
                peers: vec![crate::lan_sync::LanPeerSnapshot {
                    node_id: "node-remote".to_string(),
                    node_name: "SYB".to_string(),
                    listen_addr: "192.168.1.10:4000".to_string(),
                    remote_update_updater_port: None,
                    last_heartbeat_unix_ms: 0,
                    capabilities: Vec::new(),
                    version_inventory: vec!["shared_quota_v2".to_string()],
                    build_identity: crate::lan_sync::current_build_identity(),
                    provider_fingerprints: vec![
                        "https://api-vip.codex-for.me|anon".to_string(),
                    ],
                    provider_definitions_revision: String::new(),
                    sync_contracts: std::collections::BTreeMap::from([(
                        crate::lan_sync::LAN_SYNC_DOMAIN_SHARED_QUOTA.to_string(),
                        2,
                    )]),
                    followed_source_node_id: None,
                    trusted: true,
                    pair_state: Some("trusted".to_string()),
                    pair_request_id: None,
                    remote_update_readiness: None,
                    remote_update_status: None,
                    sync_blocked_domains: vec![
                        crate::lan_sync::LAN_SYNC_DOMAIN_SHARED_QUOTA.to_string(),
                    ],
                    sync_diagnostics: Vec::new(),
                    build_matches_local: false,
                    heartbeat_age_ms: 0,
                    http_probe_state: None,
                    http_probe_detail: None,
                }],
            }),
            &[],
        );

        assert_eq!(refreshed, vec!["p1".to_string()]);
        let cleared = st
            .store
            .get_quota_snapshot("p1")
            .and_then(|value| quota_snapshot_from_json(&value))
            .expect("cleared quota snapshot");
        assert_eq!(cleared.updated_at_unix_ms, 0);
        assert!(cleared.applied_from_node_id.is_none());
    }

    #[tokio::test]
    async fn manual_refresh_does_not_block_on_long_rate_limit_backoff() {
        let _guard = usage_base_gate_test_lock().lock().await;
        clear_usage_base_refresh_gate();
        let tmp = tempfile::tempdir().unwrap();
        let secrets = SecretStore::new(tmp.path().join("secrets.json"));
        secrets.set_provider_key("p1", "k1").unwrap();
        let gated_base = "https://manual-refresh-backoff.invalid";
        let st = mk_state(format!("{gated_base}/v1"), secrets);
        let now = unix_ms();
        note_usage_base_rate_limited(gated_base, now, 15 * 60_000);

        let snap = tokio::time::timeout(
            Duration::from_millis(250),
            refresh_quota_for_provider(&st, "p1"),
        )
        .await
        .expect("refresh should fail fast instead of waiting for backoff");

        assert_eq!(snap.updated_at_unix_ms, 0);
        assert!(
            snap.last_error
                .starts_with(&format!("usage base rate limited: {gated_base}")),
            "unexpected error: {}",
            snap.last_error
        );
    }

    #[tokio::test]
    async fn auto_probe_falls_back_to_budget_info_when_token_stats_missing() {
        let (base, _h) = start_mock_server(false).await;
        let tmp = tempfile::tempdir().unwrap();
        let secrets = SecretStore::new(tmp.path().join("secrets.json"));
        secrets.set_provider_key("p1", "k1").unwrap();
        secrets.set_usage_token("p1", "t1").unwrap();
        let st = mk_state(format!("{base}/v1"), secrets);

        let snap = refresh_quota_for_provider(&st, "p1").await;
        assert!(snap.last_error.is_empty());
        assert_eq!(snap.kind.as_str(), "budget_info");
        assert_eq!(snap.daily_spent_usd.unwrap_or(0.0), 0.5);
        assert_eq!(snap.package_expires_at_unix_ms, None);
    }

    #[tokio::test]
    async fn budget_info_reads_plan_expiry_from_users_info_when_subscriptions_unavailable() {
        let (base, _h) = start_mock_server_budget_plan_expiry_only().await;
        let tmp = tempfile::tempdir().unwrap();
        let secrets = SecretStore::new(tmp.path().join("secrets.json"));
        secrets.set_provider_key("p1", "k1").unwrap();
        secrets.set_usage_token("p1", "t1").unwrap();
        let st = mk_state(format!("{base}/v1"), secrets);
        {
            let mut cfg = st.cfg.write();
            if let Some(p) = cfg.providers.get_mut("p1") {
                p.base_url = "https://codex-api.packycode.com/v1".to_string();
                p.usage_base_url = Some(base.to_string());
            }
        }

        let snap = refresh_quota_for_provider(&st, "p1").await;
        assert!(snap.last_error.is_empty());
        assert_eq!(snap.kind.as_str(), "budget_info");
        assert_eq!(snap.daily_spent_usd.unwrap_or(0.0), 0.5);
        assert_eq!(snap.package_expires_at_unix_ms, Some(1_772_347_839_044));
    }

    #[tokio::test]
    async fn packycode_refresh_updates_cached_future_expiry_when_server_changes() {
        use axum::http::StatusCode;
        use axum::routing::get;
        use axum::{Json, Router};

        let app = Router::new()
            .route(
                "/api/backend/users/info",
                get(|| async move {
                    (
                        StatusCode::OK,
                        Json(serde_json::json!({
                          "daily_spent_usd": "0.5",
                          "daily_budget_usd": 1,
                          "monthly_spent_usd": 2,
                          "monthly_budget_usd": 10,
                          "remaining_quota": 123,
                          "plan_expires_at": "2027-04-01T00:00:00Z"
                        })),
                    )
                }),
            )
            .route(
                "/api/backend/subscriptions",
                get(|| async move { (StatusCode::UNAUTHORIZED, Json(serde_json::json!({}))) }),
            );

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let base = format!("http://{}:{}", addr.ip(), addr.port());
        let handle = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        let tmp = tempfile::tempdir().unwrap();
        let secrets = SecretStore::new(tmp.path().join("secrets.json"));
        secrets.set_provider_key("p1", "k1").unwrap();
        secrets.set_usage_token("p1", "t1").unwrap();
        let st = mk_state(format!("{base}/v1"), secrets);
        {
            let mut cfg = st.cfg.write();
            if let Some(p) = cfg.providers.get_mut("p1") {
                p.base_url = "https://codex-api.packycode.com/v1".to_string();
                p.usage_base_url = Some(base.to_string());
            }
        }

        let mut previous = QuotaSnapshot::empty(UsageKind::BudgetInfo);
        previous.updated_at_unix_ms = unix_ms().saturating_sub(60_000);
        previous.package_expires_at_unix_ms = Some(1_772_347_839_044);
        st.store
            .put_quota_snapshot("p1", &previous.to_json())
            .expect("seed quota snapshot");

        let snap = refresh_quota_for_provider(&st, "p1").await;
        handle.abort();

        assert!(snap.last_error.is_empty());
        assert_eq!(snap.package_expires_at_unix_ms, Some(1_806_537_600_000));
    }

    #[tokio::test]
    async fn refresh_quota_all_spaces_same_host_budget_requests_to_avoid_429() {
        use axum::http::StatusCode;
        use axum::routing::get;
        use axum::{Json, Router};
        use std::sync::Arc;
        use std::sync::atomic::{AtomicU64, Ordering};

        let _guard = usage_base_gate_test_lock().lock().await;

        clear_usage_base_refresh_gate();
        let last_hit_at_ms = Arc::new(AtomicU64::new(0));
        let gate = Arc::clone(&last_hit_at_ms);
        let app = Router::new().route(
            "/api/backend/users/info",
            get(move || {
                let gate = Arc::clone(&gate);
                async move {
                    let now = unix_ms();
                    let prev = gate.swap(now, Ordering::Relaxed);
                    if prev > 0 && now.saturating_sub(prev) < 800 {
                        return (
                            StatusCode::TOO_MANY_REQUESTS,
                            Json(serde_json::json!({ "error": "rate limited" })),
                        );
                    }
                    (
                        StatusCode::OK,
                        Json(serde_json::json!({
                          "daily_spent_usd": "0.5",
                          "daily_budget_usd": 1,
                          "monthly_spent_usd": 2,
                          "monthly_budget_usd": 10
                        })),
                    )
                }
            }),
        );

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let base = format!("http://{}:{}", addr.ip(), addr.port());
        let handle = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        let providers = std::collections::BTreeMap::from([
            (
                "p1".to_string(),
                ProviderConfig {
                    display_name: "P1".to_string(),
                    base_url: "https://usage-router.example/v1".to_string(),
                    usage_adapter: String::new(),
                    usage_base_url: Some(base.clone()),
                    group: None,
                    disabled: false,
                    supports_websockets: false,
                    api_key: String::new(),
                },
            ),
            (
                "p2".to_string(),
                ProviderConfig {
                    display_name: "P2".to_string(),
                    base_url: "https://usage-router.example/v1".to_string(),
                    usage_adapter: String::new(),
                    usage_base_url: Some(base.clone()),
                    group: None,
                    disabled: false,
                    supports_websockets: false,
                    api_key: String::new(),
                },
            ),
        ]);
        let tmp = tempfile::tempdir().unwrap();
        let secrets = SecretStore::new(tmp.path().join("secrets.json"));
        secrets.set_usage_token("p1", "t1").unwrap();
        secrets.set_usage_token("p2", "t2").unwrap();
        let st = mk_state_with_providers(providers, vec!["p1".to_string(), "p2".to_string()], secrets);

        let lan_sync = mk_lan_sync();
        let (ok, err, failed) = refresh_quota_all_with_summary(&st, &lan_sync).await;
        handle.abort();
        clear_usage_base_refresh_gate();

        assert_eq!(ok, 2);
        assert_eq!(err, 0);
        assert!(failed.is_empty());
    }

    #[tokio::test]
    async fn refresh_quota_all_skips_generic_provider_without_usage_source() {
        let (base, _h) = start_mock_server(false).await;
        let providers = std::collections::BTreeMap::from([
            (
                "p1".to_string(),
                ProviderConfig {
                    display_name: "P1".to_string(),
                    base_url: "https://usage-router.example/v1".to_string(),
                    usage_adapter: String::new(),
                    usage_base_url: Some(base),
                    group: None,
                    disabled: false,
                    supports_websockets: false,
                    api_key: String::new(),
                },
            ),
            (
                "codex-for.me".to_string(),
                ProviderConfig {
                    display_name: "codex-for.me".to_string(),
                    base_url: "https://api-vip.codex-for.me/v1".to_string(),
                    usage_adapter: String::new(),
                    usage_base_url: None,
                    group: None,
                    disabled: false,
                    supports_websockets: false,
                    api_key: String::new(),
                },
            ),
        ]);
        let tmp = tempfile::tempdir().unwrap();
        let secrets = SecretStore::new(tmp.path().join("secrets.json"));
        secrets.set_provider_key("p1", "k1").unwrap();
        secrets.set_usage_token("p1", "t1").unwrap();
        secrets.set_provider_key("codex-for.me", "k2").unwrap();
        let st = mk_state_with_providers(
            providers,
            vec!["p1".to_string(), "codex-for.me".to_string()],
            secrets,
        );

        let lan_sync = mk_lan_sync();
        let (ok, err, failed) = refresh_quota_all_with_summary(&st, &lan_sync).await;

        assert_eq!(ok, 1);
        assert_eq!(err, 0);
        assert!(failed.is_empty());
        assert!(st.store.get_quota_snapshot("p1").is_some());
        assert!(st.store.get_quota_snapshot("codex-for.me").is_none());
    }

    #[tokio::test]
    async fn refresh_quota_all_includes_packycode_providers_with_credentials() {
        let (base, _h) = start_mock_server(false).await;
        let providers = std::collections::BTreeMap::from([
            (
                "packycode".to_string(),
                ProviderConfig {
                    display_name: "Packycode".to_string(),
                    base_url: "https://codex.packycode.com/v1".to_string(),
                    usage_adapter: String::new(),
                    usage_base_url: Some(base.clone()),
                    group: None,
                    disabled: false,
                    supports_websockets: false,
                    api_key: String::new(),
                },
            ),
            (
                "p2".to_string(),
                ProviderConfig {
                    display_name: "P2".to_string(),
                    base_url: "https://usage-router.example/v1".to_string(),
                    usage_adapter: String::new(),
                    usage_base_url: Some(base),
                    group: None,
                    disabled: false,
                    supports_websockets: false,
                    api_key: String::new(),
                },
            ),
        ]);
        let tmp = tempfile::tempdir().unwrap();
        let secrets = SecretStore::new(tmp.path().join("secrets.json"));
        secrets.set_provider_key("packycode", "packy-key").unwrap();
        secrets.set_usage_token("p2", "p2-token").unwrap();
        let st = mk_state_with_providers(
            providers,
            vec!["packycode".to_string(), "p2".to_string()],
            secrets,
        );

        let lan_sync = mk_lan_sync();
        let (ok, err, failed) = refresh_quota_all_with_summary(&st, &lan_sync).await;

        assert_eq!(ok, 2);
        assert_eq!(err, 0);
        assert!(failed.is_empty());
        assert!(
            st.store.get_quota_snapshot("packycode").is_some(),
            "all-provider refresh should include packycode now"
        );
        assert!(
            st.store.get_quota_snapshot("p2").is_some(),
            "non-packycode providers should still refresh"
        );
    }

    #[tokio::test]
    async fn refresh_quota_all_skips_packycode_without_provider_key() {
        let (base, _h) = start_mock_server(false).await;
        let providers = std::collections::BTreeMap::from([(
            "packycode".to_string(),
            ProviderConfig {
                display_name: "Packycode".to_string(),
                base_url: "https://codex.packycode.com/v1".to_string(),
                usage_adapter: String::new(),
                usage_base_url: Some(base),
                group: None,
                disabled: false,
                supports_websockets: false,
                api_key: String::new(),
            },
        )]);
        let tmp = tempfile::tempdir().unwrap();
        let secrets = SecretStore::new(tmp.path().join("secrets.json"));
        let st = mk_state_with_providers(providers, vec!["packycode".to_string()], secrets);

        let lan_sync = mk_lan_sync();
        let (ok, err, failed) = refresh_quota_all_with_summary(&st, &lan_sync).await;

        assert_eq!(ok, 0);
        assert_eq!(err, 0);
        assert!(failed.is_empty());
        assert!(
            st.store.get_quota_snapshot("packycode").is_none(),
            "packycode refresh should require provider key"
        );
    }

    #[tokio::test]
    async fn refresh_quota_all_skips_disabled_provider_even_with_credentials() {
        let (base, _h) = start_mock_server(false).await;
        let providers = std::collections::BTreeMap::from([
            (
                "p1".to_string(),
                ProviderConfig {
                    display_name: "P1".to_string(),
                    base_url: "https://usage-router.example/v1".to_string(),
                    usage_adapter: String::new(),
                    usage_base_url: Some(base.clone()),
                    group: None,
                    disabled: false,
                    supports_websockets: false,
                    api_key: String::new(),
                },
            ),
            (
                "p2".to_string(),
                ProviderConfig {
                    display_name: "P2".to_string(),
                    base_url: "https://usage-router.example/v1".to_string(),
                    usage_adapter: String::new(),
                    usage_base_url: Some(base),
                    group: None,
                    disabled: true,
                    supports_websockets: false,
                    api_key: String::new(),
                },
            ),
        ]);
        let tmp = tempfile::tempdir().unwrap();
        let secrets = SecretStore::new(tmp.path().join("secrets.json"));
        secrets.set_usage_token("p1", "token-1").unwrap();
        secrets.set_usage_token("p2", "token-2").unwrap();
        let st = mk_state_with_providers(providers, vec!["p1".to_string(), "p2".to_string()], secrets);

        let lan_sync = mk_lan_sync();
        let (ok, err, failed) = refresh_quota_all_with_summary(&st, &lan_sync).await;

        assert_eq!(ok, 1);
        assert_eq!(err, 0);
        assert!(failed.is_empty());
        assert!(st.store.get_quota_snapshot("p1").is_some());
        assert!(
            st.store.get_quota_snapshot("p2").is_none(),
            "disabled provider must not be refreshed just because it still has credentials"
        );
    }

    #[test]
    fn explicit_usage_mapping_normalizes_user_me_payload_to_usd() {
        let payload = serde_json::json!({
            "quota": {
                "daily_quota": 4500,
                "daily_spent": 28,
                "daily_remaining": 4472
            },
            "timestamps": {
                "expires_at": "2026-04-04T14:57:44.674Z"
            }
        });

        let usage = map_canonical_usage(
            &payload,
            explicit_usage_mapping("https://yunyi.rdzhvip.com/user/api/v1/me"),
            CanonicalUsageContext {
                effective_usage_base: Some("https://yunyi.rdzhvip.com/user/api/v1/me".to_string()),
                effective_usage_source: Some("usage_base".to_string()),
                updated_at_unix_ms: 123,
            },
        )
        .expect("mapped usage");

        assert_eq!(usage.usage_kind, UsageKind::BudgetInfo);
        assert_eq!(usage.daily_limit, Some(45.0));
        assert_eq!(usage.daily_used, Some(0.28));
        assert_eq!(usage.remaining, Some(44.72));
        assert_eq!(usage.expires_at_unix_ms, Some(1_775_314_664_674));
    }

    #[test]
    fn packycode_mapping_reads_alias_fields_into_canonical_usage() {
        let provider = ProviderConfig {
            display_name: "Packycode".to_string(),
            base_url: "https://codex.packycode.com/v1".to_string(),
            usage_adapter: String::new(),
            usage_base_url: None,
            supports_websockets: false,
            group: None,
            disabled: false,
            api_key: String::new(),
        };
        let mapping = resolve_quota_profile(&provider)
            .budget_info_mapping
            .expect("budget info mapping");
        let payload = serde_json::json!({
            "daily_spent_usd": "0.5",
            "daily_budget_usd": 1,
            "weekly_spent": 2.5,
            "weekly_budget": "8",
            "monthly_spent_usd": 4,
            "monthly_budget_usd": 10,
            "remaining_quota": 123
        });

        let usage = map_canonical_usage(
            &payload,
            mapping,
            CanonicalUsageContext {
                effective_usage_base: Some("https://codex.packycode.com".to_string()),
                effective_usage_source: Some("usage_base".to_string()),
                updated_at_unix_ms: 456,
            },
        )
        .expect("mapped usage");

        assert_eq!(usage.daily_used, Some(0.5));
        assert_eq!(usage.daily_limit, Some(1.0));
        assert_eq!(usage.weekly_used, Some(2.5));
        assert_eq!(usage.weekly_limit, Some(8.0));
        assert_eq!(usage.monthly_used, Some(4.0));
        assert_eq!(usage.monthly_limit, Some(10.0));
        assert_eq!(usage.remaining, Some(123.0));
    }

    #[test]
    fn codex_for_me_mapping_preserves_balance_fields_and_budget_signal() {
        let provider = ProviderConfig {
            display_name: "Codex For Me".to_string(),
            base_url: "https://api-vip.codex-for.me/v1".to_string(),
            usage_adapter: String::new(),
            usage_base_url: None,
            supports_websockets: false,
            group: None,
            disabled: false,
            api_key: String::new(),
        };
        let mapping = resolve_quota_profile(&provider)
            .summary_mapping
            .expect("summary mapping");
        let payload = serde_json::json!({
            "data": {
                "card_balance": "42.5",
                "card_expire_date": "2026-04-13T14:42:44.143632+08:00",
                "card_name": "VIP",
                "card_daily_limit": "200",
                "today_spent_amount": "26.03",
                "card_total_spent_amount": "40.92",
                "plan_cards": [
                    {
                        "name": "Referral VIP Reward",
                        "daily_limit": "373.33",
                        "balance": "282.38",
                        "expiration_time": "2026-04-14T22:47:29.21256+08:00",
                        "state": "active"
                    },
                    {
                        "name": "codex-jfioejg",
                        "daily_limit": "200.00",
                        "balance": "49.62",
                        "expiration_time": "2026-05-14T22:47:29.21256+08:00",
                        "state": "active"
                    },
                    {
                        "name": "expired-card",
                        "daily_limit": "999.00",
                        "balance": "999.00",
                        "expiration_time": "2026-05-14T22:47:29.21256+08:00",
                        "state": "expired"
                    }
                ]
            }
        });

        let usage = map_canonical_usage(
            &payload,
            mapping,
            CanonicalUsageContext {
                effective_usage_base: Some("https://api-vip.codex-for.me".to_string()),
                effective_usage_source: Some("login_summary".to_string()),
                updated_at_unix_ms: 789,
            },
        )
        .expect("mapped usage");

        assert_eq!(usage.usage_kind, UsageKind::BudgetInfo);
        assert_eq!(usage.plan_name.as_deref(), Some("VIP"));
        assert_eq!(usage.remaining, Some(332.0));
        assert!(
            usage
                .today_added
                .map(|value| (value - 573.33).abs() < 0.001)
                .unwrap_or(false),
            "expected summed total around 573.33, got {:?}",
            usage.today_added
        );
        assert_eq!(usage.today_used, Some(26.03));
        assert!(
            usage
                .daily_limit
                .map(|value| (value - 573.33).abs() < 0.001)
                .unwrap_or(false),
            "expected summed daily limit around 573.33, got {:?}",
            usage.daily_limit
        );
        assert_eq!(usage.daily_used, Some(26.03));
        assert_eq!(usage.monthly_used, None);
        assert_eq!(usage.expires_at_unix_ms, Some(1_778_770_049_212));
    }

    #[test]
    fn quan2go_mapping_applies_daily_fallback_for_day_card_payloads() {
        let provider = ProviderConfig {
            display_name: "yangfangyu-old".to_string(),
            base_url: "https://capi.quan2go.com/openai".to_string(),
            usage_adapter: String::new(),
            usage_base_url: None,
            supports_websockets: false,
            group: None,
            disabled: false,
            api_key: String::new(),
        };
        let mapping = resolve_quota_profile(&provider)
            .summary_mapping
            .expect("summary mapping");
        let payload = serde_json::json!({
            "id": 81406,
            "score": 0,
            "score_used": 0,
            "day_score": 0,
            "day_score_used": 14.509279199999998,
            "vip": {
                "product": "codex",
                "score": 0,
                "day_score": 0,
                "expire_at": 1779036712763_u64
            }
        });

        let usage = map_canonical_usage(
            &payload,
            mapping,
            CanonicalUsageContext {
                effective_usage_base: Some("https://deepl.micosoft.icu".to_string()),
                effective_usage_source: Some("provider_key_card_login_summary".to_string()),
                updated_at_unix_ms: 789,
            },
        )
        .expect("mapped usage");

        assert_eq!(usage.usage_kind, UsageKind::BudgetInfo);
        assert_eq!(usage.plan_name.as_deref(), Some("codex"));
        assert_eq!(usage.daily_used, Some(14.509279199999998));
        assert_eq!(usage.daily_limit, Some(90.0));
        assert_eq!(usage.monthly_used, None);
        assert_eq!(usage.monthly_limit, None);
        assert_eq!(usage.expires_at_unix_ms, Some(1_779_036_712_763));
    }

    #[test]
    fn quan2go_mapping_prefers_total_budget_when_total_score_exists() {
        let provider = ProviderConfig {
            display_name: "yangfangyu-old".to_string(),
            base_url: "https://capi.quan2go.com/openai".to_string(),
            usage_adapter: String::new(),
            usage_base_url: None,
            supports_websockets: false,
            group: None,
            disabled: false,
            api_key: String::new(),
        };
        let mapping = resolve_quota_profile(&provider)
            .summary_mapping
            .expect("summary mapping");
        let payload = serde_json::json!({
            "id": 81406,
            "score": 300,
            "score_used": 12.5,
            "day_score": 0,
            "day_score_used": 3.25,
            "vip": {
                "product": "codex",
                "score": 300,
                "day_score": 0,
                "expire_at": 1779036712763_u64
            }
        });

        let usage = map_canonical_usage(
            &payload,
            mapping,
            CanonicalUsageContext {
                effective_usage_base: Some("https://deepl.micosoft.icu".to_string()),
                effective_usage_source: Some("provider_key_card_login_summary".to_string()),
                updated_at_unix_ms: 789,
            },
        )
        .expect("mapped usage");

        assert_eq!(usage.daily_used, None);
        assert_eq!(usage.daily_limit, None);
        assert_eq!(usage.monthly_used, Some(12.5));
        assert_eq!(usage.monthly_limit, Some(300.0));
    }

}
