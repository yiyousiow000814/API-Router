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

    fn mk_state(base_url: String, secrets: SecretStore) -> GatewayState {
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
                    disabled: false,
                    api_key: String::new(),
                },
            )]),
            provider_order: vec!["p1".to_string()],
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
    async fn candidate_quota_bases_adds_non_api_hostname_variant() {
        let p = ProviderConfig {
            display_name: "P".to_string(),
            base_url: "http://codex-api.example.com/v1".to_string(),
            disabled: false,
            usage_adapter: String::new(),
            usage_base_url: None,
            api_key: String::new(),
        };
        let bases = candidate_quota_bases(&p);
        assert!(bases.contains(&"http://codex-api.example.com".to_string()));
        assert!(bases.contains(&"http://codex.example.com".to_string()));
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
            UsageKind::TokenStats,
        );
        let key_b = usage_request_key(
            &bases_b,
            &Some("sk-test".to_string()),
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
            disabled: false,
            usage_adapter: String::new(),
            usage_base_url: None,
            api_key: String::new(),
        };
        let pumpkin = ProviderConfig {
            display_name: "Pumpkin".to_string(),
            base_url: "https://code.pumpkinai.vip/v1".to_string(),
            disabled: false,
            usage_adapter: String::new(),
            usage_base_url: None,
            api_key: String::new(),
        };

        let bases_pp = candidate_quota_bases(&pp);
        let bases_pumpkin = candidate_quota_bases(&pumpkin);
        assert_ne!(bases_pp, bases_pumpkin);
        assert_eq!(bases_pp.first().unwrap(), "https://his.ppchat.vip");
        assert_eq!(bases_pumpkin.first().unwrap(), "https://his.ppchat.vip");

        let k1 = usage_shared_key(bases_pp.first().unwrap(), &Some("k".to_string()), &None);
        let k2 = usage_shared_key(
            bases_pumpkin.first().unwrap(),
            &Some("k".to_string()),
            &None,
        );
        assert_eq!(k1, k2);
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
    }
}
