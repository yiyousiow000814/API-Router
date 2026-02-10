use std::collections::HashMap;
use std::error::Error;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use serde_json::Value;

use super::config::ProviderConfig;
use super::gateway::GatewayState;
use super::store::unix_ms;

fn redact_url_for_logs(url: &reqwest::Url) -> String {
    // Avoid logging secrets in query strings (e.g. token_key=...).
    // Keep only scheme://host[:port]/path so logs are still actionable.
    let scheme = url.scheme();
    let host = url.host_str().unwrap_or("<unknown>");
    let port = url.port().map(|p| format!(":{p}")).unwrap_or_default();
    format!("{scheme}://{host}{port}{}", url.path())
}

fn format_reqwest_error_for_logs(e: &reqwest::Error) -> String {
    // reqwest::Error's Display often includes the full URL, including query params.
    // Build our own short classification + redacted URL + root causes.
    let kind = if e.is_timeout() {
        "timeout"
    } else if e.is_connect() {
        "connect"
    } else {
        "request"
    };

    let mut parts: Vec<String> = vec![format!("request error ({kind})")];
    if let Some(url) = e.url() {
        parts.push(format!("url={}", redact_url_for_logs(url)));
    }

    // Surface a little bit more context from the source chain (often includes OS error codes).
    let mut src: Option<&(dyn Error + 'static)> = e.source();
    let mut causes: Vec<String> = Vec::new();
    while let Some(err) = src {
        let s = err.to_string();
        if !s.is_empty() && !causes.contains(&s) {
            causes.push(s);
        }
        // Keep it short (Events table is meant to be scannable).
        if causes.len() >= 2 {
            break;
        }
        src = err.source();
    }
    if !causes.is_empty() {
        parts.push(format!("cause={}", causes.join(" | ")));
    }

    parts.join("; ")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
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
    pub weekly_spent_usd: Option<f64>,
    pub weekly_budget_usd: Option<f64>,
    pub monthly_spent_usd: Option<f64>,
    pub monthly_budget_usd: Option<f64>,
    pub last_error: String,
    pub effective_usage_base: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct UsageRequestKey {
    bases_key: String,
    auth_key: Option<String>,
    kind: UsageKind,
}

// Used for syncing quota results across providers that share the same quota source,
// even if their usage adapter differs.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct UsageSharedKey {
    // Shared "usage base" (normalized), not the whole candidate list.
    //
    // The candidate list may include provider-specific origins / fallbacks that differ even when
    // the *actual* usage endpoint is shared (e.g. ppchat/pumpkinai). Using only the shared base
    // makes "same base + same key => same quota snapshot" deterministic.
    base_key: String,
    auth_key: Option<String>,
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
            weekly_spent_usd: None,
            weekly_budget_usd: None,
            monthly_spent_usd: None,
            monthly_budget_usd: None,
            last_error: String::new(),
            effective_usage_base: None,
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
            "weekly_spent_usd": self.weekly_spent_usd,
            "weekly_budget_usd": self.weekly_budget_usd,
            "monthly_spent_usd": self.monthly_spent_usd,
            "monthly_budget_usd": self.monthly_budget_usd,
            "last_error": self.last_error,
            "effective_usage_base": self.effective_usage_base,
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

fn is_packycode_base(base_url: &str) -> bool {
    reqwest::Url::parse(base_url)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.to_string()))
        .map(|host| host.ends_with("packycode.com"))
        .unwrap_or(false)
}

fn is_ppchat_base(base_url: &str) -> bool {
    reqwest::Url::parse(base_url)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.to_string()))
        .map(|host| host.ends_with("ppchat.vip"))
        .unwrap_or(false)
}

fn is_pumpkinai_base(base_url: &str) -> bool {
    reqwest::Url::parse(base_url)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.to_string()))
        .map(|host| host.ends_with("pumpkinai.vip"))
        .unwrap_or(false)
}

fn build_models_url(base: &str) -> String {
    let trimmed = base.trim_end_matches('/');
    if trimmed.ends_with("/v1") {
        format!("{trimmed}/models")
    } else {
        format!("{trimmed}/v1/models")
    }
}

fn candidate_quota_bases(provider: &ProviderConfig) -> Vec<String> {
    // User-provided usage_base_url always wins.
    if let Some(u) = provider.usage_base_url.as_deref() {
        let t = u.trim().trim_end_matches('/');
        if !t.is_empty() {
            return vec![t.to_string()];
        }
    }

    let mut out: Vec<String> = Vec::new();
    let mut push_unique = |value: String| {
        if value.is_empty() {
            return;
        }
        if !out.iter().any(|v| v == &value) {
            out.push(value);
        }
    };

    let is_ppchat = is_ppchat_base(&provider.base_url);
    let is_pumpkin = is_pumpkinai_base(&provider.base_url);

    if is_ppchat || is_pumpkin {
        // Prefer the shared history/usage endpoint for ppchat/pumpkinai.
        push_unique("https://his.ppchat.vip".to_string());
    }

    if let Some(origin) = derive_origin(&provider.base_url) {
        push_unique(origin.clone());

        // Heuristic: if upstream uses a "*-api." hostname, also try the non-api hostname.
        // This stays generic and does not encode any provider-specific domains.
        if let Ok(mut u) = reqwest::Url::parse(&origin) {
            if let Some(host) = u.host_str().map(|s| s.to_string()) {
                if host.contains("-api.") {
                    let alt = host.replacen("-api.", ".", 1);
                    if u.set_host(Some(&alt)).is_ok() {
                        push_unique(u.as_str().trim_end_matches('/').to_string());
                    }
                }
            }
        }
    }

    if is_packycode_base(&provider.base_url) {
        push_unique("https://www.packycode.com".to_string());
        push_unique("https://packycode.com".to_string());
    }

    if is_ppchat || is_pumpkin {
        push_unique("https://code.ppchat.vip".to_string());
        push_unique("https://code.pumpkinai.vip".to_string());
    }

    out
}

async fn probe_usage_base_speed(base: &str, api_key: &str) -> Option<Duration> {
    let client = reqwest::Client::builder()
        .user_agent("api-router/0.1")
        .build()
        .ok()?;
    let url = build_models_url(base);
    let start = Instant::now();
    let resp = client
        .get(url)
        .bearer_auth(api_key)
        .timeout(Duration::from_secs(10))
        .send()
        .await;
    match resp {
        Ok(_) => Some(start.elapsed()),
        Err(_) => None,
    }
}

async fn reorder_bases_for_speed(
    st: &GatewayState,
    provider_name: &str,
    bases: Vec<String>,
    api_key: Option<&str>,
) -> Vec<String> {
    let mut normalized: Vec<String> = Vec::new();
    for base in bases {
        let trimmed = base.trim_end_matches('/').to_string();
        if trimmed.is_empty() || normalized.iter().any(|b| b == &trimmed) {
            continue;
        }
        normalized.push(trimmed);
    }

    let has_ppchat = normalized.iter().any(|b| b == "https://code.ppchat.vip");
    let has_pumpkin = normalized.iter().any(|b| b == "https://code.pumpkinai.vip");
    if !has_ppchat || !has_pumpkin {
        return normalized;
    }
    let Some(api_key) = api_key else {
        return normalized;
    };

    let now = unix_ms();
    let mut bases_key = normalized.clone();
    bases_key.sort();
    bases_key.dedup();

    if let Some(entry) = st.usage_base_speed_cache.read().get(provider_name) {
        if entry.bases_key == bases_key
            && now.saturating_sub(entry.updated_at_unix_ms) < 5 * 60 * 1000
        {
            return entry.ordered_bases.clone();
        }
    }

    let ppchat = "https://code.ppchat.vip";
    let pumpkin = "https://code.pumpkinai.vip";
    let (ppchat_latency, pumpkin_latency) = tokio::join!(
        probe_usage_base_speed(ppchat, api_key),
        probe_usage_base_speed(pumpkin, api_key)
    );

    let mut ordered_pair = vec![ppchat.to_string(), pumpkin.to_string()];
    match (ppchat_latency, pumpkin_latency) {
        (Some(a), Some(b)) => {
            if b < a {
                ordered_pair.reverse();
            }
        }
        (None, Some(_)) => {
            ordered_pair.reverse();
        }
        _ => {}
    }

    let mut ordered = Vec::new();
    for base in normalized.iter() {
        if base == "https://code.ppchat.vip" || base == "https://code.pumpkinai.vip" {
            continue;
        }
        ordered.push(base.clone());
    }
    // Insert the speed-ordered ppchat/pumpkin bases at the end to avoid overriding preferred bases.
    for base in ordered_pair {
        if normalized.contains(&base) {
            ordered.push(base);
        }
    }

    st.usage_base_speed_cache.write().insert(
        provider_name.to_string(),
        super::gateway::UsageBaseSpeedCacheEntry {
            updated_at_unix_ms: now,
            bases_key,
            ordered_bases: ordered.clone(),
        },
    );

    ordered
}

pub async fn effective_usage_base(st: &GatewayState, provider_name: &str) -> Option<String> {
    let cfg = st.cfg.read().clone();
    let p = cfg.providers.get(provider_name)?;
    let api_key = st.secrets.get_provider_key(provider_name);
    let bases = candidate_quota_bases(p);
    if bases.is_empty() {
        return None;
    }
    let ordered = reorder_bases_for_speed(st, provider_name, bases, api_key.as_deref()).await;
    ordered.first().cloned()
}

fn usage_request_key(
    bases: &[String],
    provider_key: &Option<String>,
    usage_token: &Option<String>,
    kind: UsageKind,
) -> UsageRequestKey {
    let mut normalized: Vec<String> = bases
        .iter()
        .map(|b| b.trim_end_matches('/').to_string())
        .filter(|b| !b.is_empty())
        .collect();
    normalized.sort();
    normalized.dedup();
    let bases_key = if normalized.is_empty() {
        "-".to_string()
    } else {
        normalized.join("|")
    };
    let auth_key = usage_token.clone().or_else(|| provider_key.clone());
    UsageRequestKey {
        bases_key,
        auth_key,
        kind,
    }
}

fn usage_shared_key(
    base: &str,
    provider_key: &Option<String>,
    usage_token: &Option<String>,
) -> UsageSharedKey {
    let base_key = base.trim().trim_end_matches('/').to_string();
    let auth_key = usage_token.clone().or_else(|| provider_key.clone());
    UsageSharedKey { base_key, auth_key }
}

