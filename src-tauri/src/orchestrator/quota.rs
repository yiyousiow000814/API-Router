use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::time::Duration;

use serde_json::Value;

use super::config::ProviderConfig;
use super::gateway::GatewayState;
use super::store::unix_ms;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UsageKind {
    None,
    TokenStats,
    BudgetInfo,
}

impl UsageKind {
    pub fn from_str(s: &str) -> Self {
        match s.trim().to_ascii_lowercase().as_str() {
            "token_stats" => Self::TokenStats,
            "budget_info" => Self::BudgetInfo,
            "" | "none" => Self::None,
            _ => Self::None,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::None => "none",
            Self::TokenStats => "token_stats",
            Self::BudgetInfo => "budget_info",
        }
    }
}

#[derive(Debug, Clone)]
pub struct QuotaSnapshot {
    pub kind: UsageKind,
    pub updated_at_unix_ms: u64,
    pub remaining: Option<f64>,
    pub today_used: Option<f64>,
    pub today_added: Option<f64>,
    pub daily_spent_usd: Option<f64>,
    pub daily_budget_usd: Option<f64>,
    pub monthly_spent_usd: Option<f64>,
    pub monthly_budget_usd: Option<f64>,
    pub last_error: String,
}

impl QuotaSnapshot {
    pub fn empty(kind: UsageKind) -> Self {
        Self {
            kind,
            updated_at_unix_ms: 0,
            remaining: None,
            today_used: None,
            today_added: None,
            daily_spent_usd: None,
            daily_budget_usd: None,
            monthly_spent_usd: None,
            monthly_budget_usd: None,
            last_error: String::new(),
        }
    }

    pub fn to_json(&self) -> Value {
        serde_json::json!({
            "kind": self.kind.as_str(),
            "updated_at_unix_ms": self.updated_at_unix_ms,
            "remaining": self.remaining,
            "today_used": self.today_used,
            "today_added": self.today_added,
            "daily_spent_usd": self.daily_spent_usd,
            "daily_budget_usd": self.daily_budget_usd,
            "monthly_spent_usd": self.monthly_spent_usd,
            "monthly_budget_usd": self.monthly_budget_usd,
            "last_error": self.last_error,
        })
    }
}

pub fn detect_usage_kind(provider: &ProviderConfig) -> UsageKind {
    let explicit = UsageKind::from_str(&provider.usage_adapter);
    if explicit != UsageKind::None {
        return explicit;
    }

    // Intentionally do not infer from domains; keep it provider-agnostic.
    UsageKind::None
}

fn derive_origin(base_url: &str) -> Option<String> {
    let u = reqwest::Url::parse(base_url).ok()?;
    let mut origin = u.clone();
    origin.set_path("");
    origin.set_query(None);
    origin.set_fragment(None);
    Some(origin.as_str().trim_end_matches('/').to_string())
}

fn candidate_quota_bases(provider: &ProviderConfig) -> Vec<String> {
    // User-provided usage_base_url always wins.
    if let Some(u) = provider.usage_base_url.as_deref() {
        let t = u.trim().trim_end_matches('/');
        if !t.is_empty() {
            return vec![t.to_string()];
        }
    }

    let mut out = Vec::new();
    if let Some(origin) = derive_origin(&provider.base_url) {
        out.push(origin.clone());

        // Heuristic: if upstream uses a "*-api." hostname, also try the non-api hostname.
        // This stays generic and does not encode any provider-specific domains.
        if let Ok(mut u) = reqwest::Url::parse(&origin) {
            if let Some(host) = u.host_str().map(|s| s.to_string()) {
                if host.contains("-api.") {
                    let alt = host.replacen("-api.", ".", 1);
                    if u.set_host(Some(&alt)).is_ok() {
                        out.push(u.as_str().trim_end_matches('/').to_string());
                    }
                }
            }
        }
    }

    out.sort();
    out.dedup();
    out
}

pub async fn refresh_quota_for_provider(st: &GatewayState, provider_name: &str) -> QuotaSnapshot {
    let cfg = st.cfg.read().clone();
    let Some(p) = cfg.providers.get(provider_name) else {
        let mut out = QuotaSnapshot::empty(UsageKind::None);
        out.last_error = format!("unknown provider: {provider_name}");
        return out;
    };

    let provider_key = st.secrets.get_provider_key(provider_name);
    let usage_token = st.secrets.get_usage_token(provider_name);
    let bases = candidate_quota_bases(p);
    if bases.is_empty() {
        let mut out = QuotaSnapshot::empty(UsageKind::None);
        out.last_error = "missing base_url".to_string();
        return out;
    }

    let kind = detect_usage_kind(p);
    let snap = match kind {
        UsageKind::TokenStats => fetch_token_stats_any(&bases, provider_key.as_deref()).await,
        UsageKind::BudgetInfo => fetch_budget_info_any(&bases, usage_token.as_deref()).await,
        UsageKind::None => {
            // Auto mode: probe endpoints based on available credentials.
            if provider_key.as_deref().is_some() {
                let s = fetch_token_stats_any(&bases, provider_key.as_deref()).await;
                if s.last_error.is_empty() {
                    s
                } else if usage_token.as_deref().is_some() {
                    fetch_budget_info_any(&bases, usage_token.as_deref()).await
                } else {
                    s
                }
            } else if usage_token.as_deref().is_some() {
                fetch_budget_info_any(&bases, usage_token.as_deref()).await
            } else {
                let mut out = QuotaSnapshot::empty(UsageKind::None);
                out.last_error = "missing credentials for quota refresh".to_string();
                out
            }
        }
    };
    let _ = st.store.put_quota_snapshot(provider_name, &snap.to_json());

    // Reset local "since last refresh" ledger only when we successfully fetched provider usage.
    if snap.last_error.is_empty() && snap.updated_at_unix_ms > 0 {
        st.store.reset_ledger(provider_name);
    }

    let msg = if snap.last_error.is_empty() {
        "usage refreshed"
    } else {
        "usage refresh failed"
    };
    st.store.add_event(
        provider_name,
        if snap.last_error.is_empty() {
            "info"
        } else {
            "error"
        },
        msg,
    );

    snap
}

pub async fn refresh_quota_all(st: &GatewayState) {
    let cfg = st.cfg.read().clone();
    for name in cfg.providers.keys() {
        let _ = refresh_quota_for_provider(st, name).await;
        // Manual/all refresh: keep a small delay so we don't look like a burst/DDOS.
        tokio::time::sleep(Duration::from_millis(120)).await;
    }
}

pub async fn run_quota_scheduler(st: GatewayState) {
    let mut next_refresh_unix_ms: HashMap<String, u64> = HashMap::new();

    loop {
        tokio::time::sleep(Duration::from_millis(900)).await;

        let now = unix_ms();
        let last = st.last_activity_unix_ms.load(Ordering::Relaxed);
        let active = last > 0 && now.saturating_sub(last) < 10 * 60 * 1000;
        if !active {
            continue;
        }

        let cfg = st.cfg.read().clone();
        for (name, p) in cfg.providers.iter() {
            let _ = p;
            let has_any_credential = st.secrets.get_provider_key(name).is_some()
                || st.secrets.get_usage_token(name).is_some();
            if !has_any_credential {
                continue;
            }

            let due = next_refresh_unix_ms.get(name).copied().unwrap_or(0);
            if due != 0 && now < due {
                continue;
            }

            let snap = refresh_quota_for_provider(&st, name).await;
            let jitter_ms = if snap.last_error.is_empty() {
                // When actively used, refresh randomly every 1-5 minutes.
                fastrand::u64(60_000..=300_000)
            } else {
                // On failure, back off a bit more to avoid hammering the provider.
                fastrand::u64(180_000..=600_000)
            };
            next_refresh_unix_ms.insert(name.clone(), now.saturating_add(jitter_ms));

            // Avoid "burst" patterns when multiple providers are due at the same time.
            tokio::time::sleep(Duration::from_millis(120)).await;
        }
    }
}

async fn fetch_token_stats_any(bases: &[String], provider_key: Option<&str>) -> QuotaSnapshot {
    let mut out = QuotaSnapshot::empty(UsageKind::TokenStats);
    let Some(k) = provider_key else {
        out.last_error = "missing provider key".to_string();
        return out;
    };
    if bases.is_empty() {
        out.last_error = "missing quota base".to_string();
        return out;
    }

    let client = match reqwest::Client::builder()
        .user_agent("agent-orchestrator/0.1")
        .build()
    {
        Ok(c) => c,
        Err(_) => {
            out.last_error = "failed to build http client".to_string();
            return out;
        }
    };

    let mut last_err = String::new();
    let mut saw_404 = false;
    for base in bases {
        let base = base.trim_end_matches('/');
        if base.is_empty() {
            continue;
        }
        let url = format!(
            "{base}/api/token-stats?token_key={}",
            urlencoding::encode(k)
        );
        match client
            .get(url)
            .timeout(Duration::from_secs(15))
            .send()
            .await
        {
            Ok(resp) => {
                let status = resp.status().as_u16();
                let j = resp.json::<Value>().await.unwrap_or(Value::Null);
                if !(200..300).contains(&status) {
                    if status == 404 {
                        saw_404 = true;
                    }
                    last_err = format!("http {status}");
                    continue;
                }

                let info = j.pointer("/data/info").cloned().unwrap_or(Value::Null);
                if info.is_null() {
                    last_err = "unexpected response".to_string();
                    continue;
                }
                let stats = j
                    .pointer("/data/stats/today_stats")
                    .cloned()
                    .unwrap_or(Value::Null);

                out.remaining = as_f64(info.get("remain_quota_display"))
                    .or_else(|| as_f64(info.get("remain_quota")));
                out.today_used = as_f64(stats.get("used_quota"))
                    .or_else(|| as_f64(stats.get("used_quota_display")));
                out.today_added = as_f64(stats.get("added_quota"))
                    .or_else(|| as_f64(stats.get("added_quota_display")));
                out.updated_at_unix_ms = unix_ms();
                out.last_error.clear();
                return out;
            }
            Err(e) => {
                last_err = format!("request error: {e}");
                continue;
            }
        }
    }

    if last_err.is_empty() || (saw_404 && last_err == "http 404") {
        out.last_error = "usage endpoint not found (set Usage base URL)".to_string();
    } else {
        out.last_error = last_err;
    }
    out
}

async fn fetch_budget_info_any(bases: &[String], jwt: Option<&str>) -> QuotaSnapshot {
    let mut out = QuotaSnapshot::empty(UsageKind::BudgetInfo);
    let Some(token) = jwt else {
        out.last_error = "missing usage token".to_string();
        return out;
    };
    if bases.is_empty() {
        out.last_error = "missing quota base".to_string();
        return out;
    }

    let client = match reqwest::Client::builder()
        .user_agent("agent-orchestrator/0.1")
        .build()
    {
        Ok(c) => c,
        Err(_) => {
            out.last_error = "failed to build http client".to_string();
            return out;
        }
    };

    let mut last_err = String::new();
    let mut saw_404 = false;
    for base in bases {
        let base = base.trim_end_matches('/');
        if base.is_empty() {
            continue;
        }
        let url = format!("{base}/api/backend/users/info");
        match client
            .get(url)
            .header(reqwest::header::AUTHORIZATION, format!("Bearer {token}"))
            .timeout(Duration::from_secs(15))
            .send()
            .await
        {
            Ok(resp) => {
                let status = resp.status().as_u16();
                let j = resp.json::<Value>().await.unwrap_or(Value::Null);
                if !(200..300).contains(&status) {
                    if status == 404 {
                        saw_404 = true;
                    }
                    last_err = format!("http {status}");
                    continue;
                }

                // Some endpoints wrap the payload in { success, data }.
                let root = j.get("data").unwrap_or(&j);
                // Ensure this looks like a budget response to avoid mis-detecting.
                if root.get("daily_spent_usd").is_none() && root.get("monthly_spent_usd").is_none()
                {
                    last_err = "unexpected response".to_string();
                    continue;
                }

                out.daily_spent_usd = as_f64(root.get("daily_spent_usd"));
                out.daily_budget_usd = as_f64(root.get("daily_budget_usd"));
                out.monthly_spent_usd = as_f64(root.get("monthly_spent_usd"));
                out.monthly_budget_usd = as_f64(root.get("monthly_budget_usd"));
                out.remaining = as_f64(root.get("remaining_quota"));
                out.updated_at_unix_ms = unix_ms();
                out.last_error.clear();
                return out;
            }
            Err(e) => {
                last_err = format!("request error: {e}");
                continue;
            }
        }
    }

    if last_err.is_empty() || (saw_404 && last_err == "http 404") {
        out.last_error = "usage endpoint not found (set Usage base URL)".to_string();
    } else {
        out.last_error = last_err;
    }
    out
}

fn as_f64(v: Option<&Value>) -> Option<f64> {
    let v = v?;
    v.as_f64()
        .or_else(|| v.as_i64().map(|n| n as f64))
        .or_else(|| v.as_u64().map(|n| n as f64))
        .or_else(|| v.as_str().and_then(|s| s.parse::<f64>().ok()))
}

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
            usage_adapter: String::new(),
            usage_base_url: None,
            api_key: String::new(),
        };
        let bases = candidate_quota_bases(&p);
        assert!(bases.contains(&"http://codex-api.example.com".to_string()));
        assert!(bases.contains(&"http://codex.example.com".to_string()));
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
