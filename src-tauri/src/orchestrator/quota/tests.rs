#[cfg(test)]
mod tests {
    use super::*;
    use crate::orchestrator::config::{AppConfig, ListenConfig, RoutingConfig};
    use crate::orchestrator::gateway::open_store_dir;
    use crate::orchestrator::router::RouterState;
    use crate::orchestrator::secrets::SecretStore;
    use crate::orchestrator::upstream::UpstreamClient;
    use parking_lot::RwLock;
    use std::sync::atomic::AtomicU64;
    use std::sync::Arc;

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
                                    "card_balance": "42.5",
                                    "card_expire_date": "2027-12-31",
                                    "card_name": "VIP",
                                    "card_daily_limit": "200",
                                    "today_spent_amount": "26.03",
                                    "card_total_spent_amount": "40.92"
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
            usage_adapter: String::new(),
            usage_base_url: None,
            api_key: String::new(),
        };
        let bases = candidate_quota_bases(&p);
        assert!(bases.is_empty());
    }

    #[tokio::test]
    async fn candidate_quota_bases_keeps_only_explicit_for_generic_provider() {
        let p = ProviderConfig {
            display_name: "P".to_string(),
            base_url: "http://codex-api.example.com/v1".to_string(),
            group: None,
            disabled: false,
            usage_adapter: String::new(),
            usage_base_url: Some("https://explicit.example.com/".to_string()),
            api_key: String::new(),
        };
        let bases = candidate_quota_bases(&p);
        assert_eq!(bases, vec!["https://explicit.example.com".to_string()]);
    }

    #[tokio::test]
    async fn candidate_quota_bases_canonicalizes_packycode_to_codex_host_only() {
        let p = ProviderConfig {
            display_name: "P".to_string(),
            base_url: "https://codex-api.packycode.com/v1".to_string(),
            group: None,
            disabled: false,
            usage_adapter: String::new(),
            usage_base_url: None,
            api_key: String::new(),
        };
        let bases = candidate_quota_bases(&p);
        assert_eq!(bases, vec!["https://codex.packycode.com".to_string()]);
    }

    #[tokio::test]
    async fn candidate_quota_bases_ignores_packycode_explicit_non_canonical_usage_host() {
        let p = ProviderConfig {
            display_name: "P".to_string(),
            base_url: "https://codex-api.packycode.com/v1".to_string(),
            group: None,
            disabled: false,
            usage_adapter: String::new(),
            usage_base_url: Some("https://www.packycode.com".to_string()),
            api_key: String::new(),
        };
        let bases = candidate_quota_bases(&p);
        assert_eq!(bases, vec!["https://codex.packycode.com".to_string()]);
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
            &[base.clone()],
            Some("test-token"),
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
        let bases_a = vec![
            "https://code.ppchat.vip".to_string(),
            "https://code.pumpkinai.vip".to_string(),
        ];
        let bases_b = vec![
            "https://code.pumpkinai.vip/".to_string(),
            "https://code.ppchat.vip/".to_string(),
        ];
        let key_a = usage_request_key(
            &bases_a,
            &Some("sk-test".to_string()),
            &None,
            &None,
            UsageKind::TokenStats,
        );
        let key_b = usage_request_key(
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
            usage_adapter: String::new(),
            usage_base_url: None,
            api_key: String::new(),
        };
        let pumpkin = ProviderConfig {
            display_name: "Pumpkin".to_string(),
            base_url: "https://code.pumpkinai.vip/v1".to_string(),
            group: None,
            disabled: false,
            usage_adapter: String::new(),
            usage_base_url: None,
            api_key: String::new(),
        };

        let bases_pp = candidate_quota_bases(&pp);
        let bases_pumpkin = candidate_quota_bases(&pumpkin);
        assert_eq!(bases_pp, bases_pumpkin);
        assert_eq!(bases_pp.first().unwrap(), "https://his.ppchat.vip");
        assert_eq!(bases_pumpkin.first().unwrap(), "https://his.ppchat.vip");

        let k1 = usage_shared_key(
            bases_pp.first().unwrap(),
            &Some("k".to_string()),
            &None,
            &None,
        );
        let k2 = usage_shared_key(
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
            usage_adapter: String::new(),
            usage_base_url: None,
            api_key: String::new(),
        };
        let bases = candidate_quota_bases(&p);
        assert_eq!(bases, vec!["https://api-vip.codex-for.me".to_string()]);
    }

    #[tokio::test]
    async fn candidate_quota_bases_infers_codex_for_host_origin() {
        let p = ProviderConfig {
            display_name: "Codex For".to_string(),
            base_url: "https://api-vip.codex-for.vip/v1".to_string(),
            group: None,
            disabled: false,
            usage_adapter: String::new(),
            usage_base_url: None,
            api_key: String::new(),
        };
        let bases = candidate_quota_bases(&p);
        assert_eq!(bases, vec!["https://api-vip.codex-for.vip".to_string()]);
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
        assert_eq!(snap.remaining, Some(42.5));
        assert_eq!(snap.daily_budget_usd, Some(200.0));
        assert_eq!(snap.daily_spent_usd, Some(26.03));
        assert_eq!(snap.monthly_spent_usd, Some(40.92));
        assert_eq!(snap.monthly_budget_usd, Some(83.42));
        assert_eq!(snap.package_expires_at_unix_ms, Some(1_830_254_400_000));
        assert_eq!(snap.effective_usage_base.as_deref(), Some(base.as_str()));
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
    async fn auto_probe_prefers_token_stats_when_key_present() {
        let (base, _h) = start_mock_server(true).await;
        let tmp = tempfile::tempdir().unwrap();
        let secrets = SecretStore::new(tmp.path().join("secrets.json"));
        secrets.set_provider_key("p1", "k1").unwrap();
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
        assert_eq!(health.last_ok_at_unix_ms, 0);
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
    async fn packycode_budget_info_prefers_login_token_over_provider_key() {
        use axum::extract::State;
        use axum::http::{HeaderMap, StatusCode};
        use axum::routing::get;
        use axum::{Json, Router};
        use std::sync::Arc;
        use std::sync::atomic::{AtomicU64, Ordering};

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
                        if auth == "Bearer api-key" {
                            return (
                                StatusCode::TOO_MANY_REQUESTS,
                                Json(serde_json::json!({ "error": "rate limited" })),
                            );
                        }
                        if auth != "Bearer jwt-token" {
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
        secrets.set_usage_token("p1", "jwt-token").unwrap();
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
    async fn packycode_budget_info_labels_login_and_provider_key_failures() {
        use axum::extract::State;
        use axum::http::{HeaderMap, StatusCode};
        use axum::routing::get;
        use axum::{Json, Router};
        use std::sync::Arc;
        use std::sync::atomic::{AtomicU64, Ordering};

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
                    let status = if auth == "Bearer jwt-token" {
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
        secrets.set_usage_token("p1", "jwt-token").unwrap();
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
        assert!(snap.last_error.contains("packycode browser session:"));
        assert!(snap.last_error.contains("packycode login token: http 401"));
        assert!(snap.last_error.contains("provider key: http 429"));
        assert!(snap.last_error.contains("token stats fallback: "));
        assert_eq!(token_stats_hits.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn extract_packycode_browser_auth_storage_user_reads_runtime_evaluate_value() {
        let payload = serde_json::json!({
            "result": {
                "result": {
                    "value": {
                        "state": {
                            "user": {
                                "daily_spent_usd": 1,
                                "plan_expires_at": "2030-01-01T00:00:00Z"
                            }
                        }
                    }
                }
            }
        });
        let extracted = extract_packycode_browser_auth_storage_user(&payload).expect("payload");
        assert_eq!(extracted["daily_spent_usd"], 1);
        assert_eq!(extracted["plan_expires_at"], "2030-01-01T00:00:00Z");
    }

    #[test]
    fn extract_packycode_browser_auth_storage_user_reads_stringified_storage() {
        let payload = serde_json::json!({
            "result": {
                "result": {
                    "value": "{\"state\":{\"user\":{\"monthly_spent_usd\":\"699.7540\",\"monthly_budget_usd\":\"3600.00000000\"}}}"
                }
            }
        });
        let extracted = extract_packycode_browser_auth_storage_user(&payload).expect("payload");
        assert_eq!(extracted["monthly_spent_usd"], "699.7540");
        assert_eq!(extracted["monthly_budget_usd"], "3600.00000000");
    }

    #[test]
    fn packycode_usage_browser_args_are_headless() {
        let args = packycode_usage_browser_args(
            std::path::Path::new("C:/tmp/packycode-login/provider-1"),
            "https://codex.packycode.com/dashboard",
        );
        assert!(args.iter().any(|arg| arg == "--headless=new"));
        assert!(args.iter().any(|arg| arg == "--remote-debugging-port=0"));
        assert!(args
            .iter()
            .any(|arg| arg == "--user-data-dir=C:/tmp/packycode-login/provider-1"));
        assert!(!args.iter().any(|arg| arg == "--new-window"));
        assert_eq!(
            args.last().map(String::as_str),
            Some("https://codex.packycode.com/dashboard")
        );
    }

    #[tokio::test]
    async fn cached_future_package_expiry_skips_packycode_refetch() {
        use axum::http::StatusCode;
        use axum::routing::get;
        use axum::{Json, Router};
        use std::sync::Arc;
        use std::sync::atomic::{AtomicU64, Ordering};

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
        assert_eq!(user_info_hits.load(Ordering::Relaxed), 0);
        assert_eq!(subscriptions_hits.load(Ordering::Relaxed), 0);
    }

    #[tokio::test]
    async fn package_expiry_does_not_propagate_to_non_packycode_provider() {
        let (base, _h) = start_mock_server(true).await;
        let tmp = tempfile::tempdir().unwrap();
        let secrets = SecretStore::new(tmp.path().join("secrets.json"));
        secrets.set_provider_key("p1", "k-shared").unwrap();
        secrets.set_provider_key("p2", "k-shared").unwrap();
        secrets.set_usage_token("p1", "t-shared").unwrap();
        secrets.set_usage_token("p2", "t-shared").unwrap();

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
    fn as_f64_strips_commas_and_percent() {
        let v = serde_json::json!("14,993");
        assert_eq!(as_f64(Some(&v)).unwrap_or(0.0), 14993.0);
        let v = serde_json::json!("13%");
        assert_eq!(as_f64(Some(&v)).unwrap_or(0.0), 13.0);
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
        recovered.effective_usage_source = Some("packycode_browser_session".to_string());
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
                .contains("Packycode dashboard session")
        );
    }

    #[test]
    fn background_quota_refresh_requires_real_recent_provider_usage() {
        assert!(!should_run_background_quota_refresh(false, false, true));
        assert!(!should_run_background_quota_refresh(true, false, true));
        assert!(!should_run_background_quota_refresh(true, true, false));
        assert!(should_run_background_quota_refresh(true, true, true));
    }

    #[test]
    fn initial_refresh_due_reuses_fresh_snapshot_for_recently_used_provider() {
        let mut snapshot = QuotaSnapshot::empty(UsageKind::BudgetInfo);
        snapshot.updated_at_unix_ms = 100_000;
        let due = initial_quota_refresh_due_unix_ms(100_001, Some(&snapshot), true, false, 4)
            .expect("fresh due");
        assert!(due > 100_001);
        assert_eq!(due, 100_000 + 10 * 60_000);
    }

    #[test]
    fn rate_limited_refresh_aligns_to_half_hour_windows() {
        use chrono::{FixedOffset, TimeZone, Timelike};

        let tz = FixedOffset::east_opt(8 * 3600).unwrap();
        let now = tz.with_ymd_and_hms(2026, 3, 10, 11, 25, 42).unwrap();
        let due = next_rate_limited_refresh_at(now);
        assert_eq!(due.minute(), 30);
        assert_eq!(due.second(), 0);

        let now = tz.with_ymd_and_hms(2026, 3, 10, 11, 35, 1).unwrap();
        let due = next_rate_limited_refresh_at(now);
        assert_eq!(due.minute(), 58);
        assert_eq!(due.second(), 0);

        let now = tz.with_ymd_and_hms(2026, 3, 10, 11, 58, 0).unwrap();
        let due = next_rate_limited_refresh_at(now);
        assert_eq!(due.hour(), 12);
        assert_eq!(due.minute(), 30);
        assert_eq!(due.second(), 0);
    }

    #[test]
    fn initial_refresh_due_uses_rate_limit_window_for_failed_snapshot() {
        use chrono::{Duration, Local, Timelike};

        let now = Local::now();
        let now_ms = now.timestamp_millis().max(0) as u64;
        let mut snapshot = QuotaSnapshot::empty(UsageKind::BudgetInfo);
        snapshot.updated_at_unix_ms = now_ms.saturating_sub(Duration::minutes(5).num_milliseconds() as u64);
        snapshot.last_error = "http 429 from https://codex.packycode.com".to_string();

        let due = initial_quota_refresh_due_unix_ms(now_ms, Some(&snapshot), true, true, 1)
            .expect("rate limited due");
        let due_dt = Local.timestamp_millis_opt(due as i64).single().unwrap();
        assert!(due > now_ms);
        assert!(matches!(due_dt.minute(), 30 | 58));
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

    #[tokio::test]
    async fn manual_refresh_does_not_block_on_long_rate_limit_backoff() {
        clear_usage_base_refresh_gate();
        let tmp = tempfile::tempdir().unwrap();
        let secrets = SecretStore::new(tmp.path().join("secrets.json"));
        secrets.set_provider_key("p1", "k1").unwrap();
        let st = mk_state("https://example.com/v1".to_string(), secrets);
        let now = unix_ms();
        note_usage_base_rate_limited("https://example.com", now, 15 * 60_000);

        let snap = tokio::time::timeout(
            Duration::from_millis(250),
            refresh_quota_for_provider(&st, "p1"),
        )
        .await
        .expect("refresh should fail fast instead of waiting for backoff");

        assert_eq!(snap.updated_at_unix_ms, 0);
        assert!(
            snap.last_error
                .starts_with("usage base rate limited: https://example.com"),
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
    async fn refresh_quota_all_spaces_same_host_budget_requests_to_avoid_429() {
        use axum::http::StatusCode;
        use axum::routing::get;
        use axum::{Json, Router};
        use std::sync::Arc;
        use std::sync::atomic::{AtomicU64, Ordering};

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
                    base_url: format!("{base}/v1"),
                    usage_adapter: String::new(),
                    usage_base_url: Some(base.clone()),
                    group: None,
                    disabled: false,
                    api_key: String::new(),
                },
            ),
            (
                "p2".to_string(),
                ProviderConfig {
                    display_name: "P2".to_string(),
                    base_url: format!("{base}/v1"),
                    usage_adapter: String::new(),
                    usage_base_url: Some(base.clone()),
                    group: None,
                    disabled: false,
                    api_key: String::new(),
                },
            ),
        ]);
        let tmp = tempfile::tempdir().unwrap();
        let secrets = SecretStore::new(tmp.path().join("secrets.json"));
        secrets.set_usage_token("p1", "t1").unwrap();
        secrets.set_usage_token("p2", "t2").unwrap();
        let st = mk_state_with_providers(providers, vec!["p1".to_string(), "p2".to_string()], secrets);

        let (ok, err, failed) = refresh_quota_all_with_summary(&st).await;
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
                "packycode".to_string(),
                ProviderConfig {
                    display_name: "Packycode".to_string(),
                    base_url: "https://codex-api.packycode.com/v1".to_string(),
                    usage_adapter: String::new(),
                    usage_base_url: Some(base),
                    group: None,
                    disabled: false,
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
                    api_key: String::new(),
                },
            ),
        ]);
        let tmp = tempfile::tempdir().unwrap();
        let secrets = SecretStore::new(tmp.path().join("secrets.json"));
        secrets.set_provider_key("packycode", "k1").unwrap();
        secrets.set_usage_token("packycode", "t1").unwrap();
        secrets.set_provider_key("codex-for.me", "k2").unwrap();
        let st = mk_state_with_providers(
            providers,
            vec!["packycode".to_string(), "codex-for.me".to_string()],
            secrets,
        );

        let (ok, err, failed) = refresh_quota_all_with_summary(&st).await;

        assert_eq!(ok, 1);
        assert_eq!(err, 0);
        assert!(failed.is_empty());
        assert!(st.store.get_quota_snapshot("codex-for.me").is_none());
    }
}
