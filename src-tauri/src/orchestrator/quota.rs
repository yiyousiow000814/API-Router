use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::time::Duration;

use serde_json::Value;

use super::config::ProviderConfig;
use super::gateway::GatewayState;
use super::store::unix_ms;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuotaKind {
    None,
    Ppchat,
    Packycode,
}

impl QuotaKind {
    pub fn from_str(s: &str) -> Self {
        match s.trim().to_ascii_lowercase().as_str() {
            "ppchat" => Self::Ppchat,
            "packycode" => Self::Packycode,
            "" | "none" => Self::None,
            _ => Self::None,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Ppchat => "ppchat",
            Self::Packycode => "packycode",
        }
    }
}

#[derive(Debug, Clone)]
pub struct QuotaSnapshot {
    pub kind: QuotaKind,
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
    pub fn empty(kind: QuotaKind) -> Self {
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

pub fn detect_quota_kind(provider: &ProviderConfig) -> QuotaKind {
    let explicit = QuotaKind::from_str(&provider.quota_kind);
    if explicit != QuotaKind::None {
        return explicit;
    }

    let u = provider.base_url.to_ascii_lowercase();
    if u.contains("ppchat.vip") {
        return QuotaKind::Ppchat;
    }
    if u.contains("packycode.com") {
        return QuotaKind::Packycode;
    }
    QuotaKind::None
}

fn quota_base(provider: &ProviderConfig, kind: QuotaKind) -> String {
    if let Some(u) = provider.quota_base_url.as_deref() {
        let t = u.trim().trim_end_matches('/');
        if !t.is_empty() {
            return t.to_string();
        }
    }

    match kind {
        // IMPORTANT: do not hardcode the PPCHAT dashboard URL in code.
        QuotaKind::Ppchat => "https://his.ppchat.vip".to_string(),
        QuotaKind::Packycode => "https://codex.packycode.com".to_string(),
        QuotaKind::None => String::new(),
    }
}

pub async fn refresh_quota_for_provider(st: &GatewayState, provider_name: &str) -> QuotaSnapshot {
    let cfg = st.cfg.read().clone();
    let Some(p) = cfg.providers.get(provider_name) else {
        let mut out = QuotaSnapshot::empty(QuotaKind::None);
        out.last_error = format!("unknown provider: {provider_name}");
        return out;
    };

    let kind = detect_quota_kind(p);
    if kind == QuotaKind::None {
        return QuotaSnapshot::empty(kind);
    }

    let provider_key = st.secrets.get_provider_key(provider_name);
    let usage_token = st.secrets.get_usage_token(provider_name);

    let snap = fetch_quota(kind, p, provider_key.as_deref(), usage_token.as_deref()).await;
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
            let kind = detect_quota_kind(p);
            if kind == QuotaKind::None {
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

pub async fn fetch_quota(
    kind: QuotaKind,
    provider: &ProviderConfig,
    provider_key: Option<&str>,
    usage_token: Option<&str>,
) -> QuotaSnapshot {
    match kind {
        QuotaKind::None => QuotaSnapshot::empty(kind),
        QuotaKind::Ppchat => fetch_ppchat(provider, provider_key).await,
        QuotaKind::Packycode => fetch_packycode(provider, usage_token).await,
    }
}

async fn fetch_ppchat(provider: &ProviderConfig, provider_key: Option<&str>) -> QuotaSnapshot {
    let mut out = QuotaSnapshot::empty(QuotaKind::Ppchat);
    let Some(k) = provider_key else {
        out.last_error = "missing provider key".to_string();
        return out;
    };

    // PPCHAT: the same key is used as token_key for usage query.
    let base = quota_base(provider, QuotaKind::Ppchat);
    if base.is_empty() {
        out.last_error = "missing quota_base_url".to_string();
        return out;
    }
    let url = format!(
        "{base}/api/token-stats?token_key={}",
        urlencoding::encode(k)
    );

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
                out.last_error = format!("http {status}");
                return out;
            }

            // Schema (observed from PPCHAT dashboard JS):
            // - data.info.remain_quota_display
            // - data.stats.today_stats.used_quota / added_quota
            let info = j.pointer("/data/info").cloned().unwrap_or(Value::Null);
            let stats = j
                .pointer("/data/stats/today_stats")
                .cloned()
                .unwrap_or(Value::Null);

            out.remaining = as_f64(info.get("remain_quota_display"))
                .or_else(|| as_f64(info.get("remain_quota")));
            out.today_used =
                as_f64(stats.get("used_quota")).or_else(|| as_f64(stats.get("used_quota_display")));
            out.today_added = as_f64(stats.get("added_quota"))
                .or_else(|| as_f64(stats.get("added_quota_display")));
            out.updated_at_unix_ms = unix_ms();
            out
        }
        Err(e) => {
            out.last_error = format!("request error: {e}");
            out
        }
    }
}

async fn fetch_packycode(provider: &ProviderConfig, jwt: Option<&str>) -> QuotaSnapshot {
    let mut out = QuotaSnapshot::empty(QuotaKind::Packycode);
    let Some(token) = jwt else {
        out.last_error = "missing packycode jwt".to_string();
        return out;
    };

    let base = quota_base(provider, QuotaKind::Packycode);
    if base.is_empty() {
        out.last_error = "missing quota_base_url".to_string();
        return out;
    }
    let url = format!("{base}/api/backend/users/info");

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
                out.last_error = format!("http {status}");
                return out;
            }

            // Some endpoints wrap the payload in { success, data }.
            let root = j.get("data").unwrap_or(&j);

            out.daily_spent_usd = as_f64(root.get("daily_spent_usd"));
            out.daily_budget_usd = as_f64(root.get("daily_budget_usd"));
            out.monthly_spent_usd = as_f64(root.get("monthly_spent_usd"));
            out.monthly_budget_usd = as_f64(root.get("monthly_budget_usd"));
            out.remaining = as_f64(root.get("remaining_quota"));
            out.updated_at_unix_ms = unix_ms();
            out
        }
        Err(e) => {
            out.last_error = format!("request error: {e}");
            out
        }
    }
}

fn as_f64(v: Option<&Value>) -> Option<f64> {
    let Some(v) = v else {
        return None;
    };
    v.as_f64()
        .or_else(|| v.as_i64().map(|n| n as f64))
        .or_else(|| v.as_u64().map(|n| n as f64))
        .or_else(|| v.as_str().and_then(|s| s.parse::<f64>().ok()))
}
