use std::collections::HashMap;
use std::error::Error;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use chrono::{TimeZone, Timelike};
use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use serde_json::Value;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message as WebSocketMessage;

use crate::orchestrator::config::AppConfig;

use super::config::ProviderConfig;
use super::gateway::GatewayState;
use super::secrets::UsageLoginConfig;
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
    BalanceInfo,
}

impl UsageKind {
    pub fn from_str(s: &str) -> Self {
        match s.trim().to_ascii_lowercase().as_str() {
            "token_stats" => Self::TokenStats,
            "budget_info" => Self::BudgetInfo,
            "balance_info" => Self::BalanceInfo,
            "" | "none" => Self::None,
            _ => Self::None,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::None => "none",
            Self::TokenStats => "token_stats",
            Self::BudgetInfo => "budget_info",
            Self::BalanceInfo => "balance_info",
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
    pub package_expires_at_unix_ms: Option<u64>,
    pub last_error: String,
    pub effective_usage_base: Option<String>,
    pub effective_usage_source: Option<String>,
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

#[derive(Debug, Clone, Serialize)]
pub struct SharedQuotaOwnerStatus {
    pub provider: String,
    pub shared_provider_id: String,
    pub shared_provider_fingerprint: String,
    pub owner_node_id: String,
    pub owner_node_name: String,
    pub local_is_owner: bool,
    pub contender_count: usize,
}

#[derive(Clone, Copy)]
struct QuotaCredentials<'a> {
    provider_key: Option<&'a str>,
    usage_token: Option<&'a str>,
    usage_login: Option<&'a UsageLoginConfig>,
}

#[derive(Clone, Copy)]
struct QuotaSnapshotStrategies {
    provider_strategy: PackageExpiryStrategy,
    package_expiry_fetch_strategy: PackageExpiryStrategy,
}

const USAGE_BASE_MIN_GAP_MS: u64 = 1_250;
const USAGE_BASE_429_BACKOFF_MS: u64 = 20_000;
const USAGE_BASE_MAX_INLINE_WAIT_MS: u64 = 2_500;

fn usage_base_refresh_gate() -> &'static Mutex<HashMap<String, u64>> {
    static STATE: OnceLock<Mutex<HashMap<String, u64>>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn usage_proxy_rotation_state() -> &'static Mutex<HashMap<String, usize>> {
    static STATE: OnceLock<Mutex<HashMap<String, usize>>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn usage_base_gate_key(base: &str) -> String {
    let trimmed = base.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return String::new();
    }
    reqwest::Url::parse(trimmed)
        .ok()
        .map(|mut url| {
            url.set_path("");
            url.set_query(None);
            url.set_fragment(None);
            url.as_str().trim_end_matches('/').to_string()
        })
        .unwrap_or_else(|| trimmed.to_string())
}

fn reserve_usage_base_refresh_slot(base: &str, now_ms: u64, min_gap_ms: u64) -> u64 {
    let key = usage_base_gate_key(base);
    if key.is_empty() {
        return 0;
    }
    let lock = usage_base_refresh_gate();
    let mut gate = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let next_allowed = gate.get(&key).copied().unwrap_or(0);
    let scheduled_start = next_allowed.max(now_ms);
    gate.insert(key, scheduled_start.saturating_add(min_gap_ms));
    scheduled_start.saturating_sub(now_ms)
}

fn note_usage_base_rate_limited(base: &str, now_ms: u64, backoff_ms: u64) {
    let key = usage_base_gate_key(base);
    if key.is_empty() {
        return;
    }
    let lock = usage_base_refresh_gate();
    let mut gate = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let next_allowed = gate.get(&key).copied().unwrap_or(0);
    gate.insert(key, next_allowed.max(now_ms.saturating_add(backoff_ms)));
}

fn clear_usage_base_refresh_gate_for_base(base: &str) {
    let key = usage_base_gate_key(base);
    if key.is_empty() {
        return;
    }
    let lock = usage_base_refresh_gate();
    let mut gate = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    gate.remove(&key);
}

fn parse_rate_limit_backoff_ms(
    headers: &reqwest::header::HeaderMap,
    now_ms: u64,
    default_backoff_ms: u64,
) -> u64 {
    let retry_after_ms = headers
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.trim().parse::<u64>().ok())
        .map(|secs| secs.saturating_mul(1000));

    let reset_ms = headers
        .get("x-ratelimit-reset")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.trim().parse::<u64>().ok())
        .map(|secs| secs.saturating_mul(1000))
        .and_then(|reset_at_ms| reset_at_ms.checked_sub(now_ms));

    retry_after_ms
        .into_iter()
        .chain(reset_ms)
        .max()
        .unwrap_or(default_backoff_ms)
}

fn format_usage_base_backoff_error(base: &str, wait_ms: u64) -> String {
    let secs = wait_ms.div_ceil(1000);
    if secs >= 60 {
        let mins = secs / 60;
        let rem = secs % 60;
        if rem == 0 {
            format!("usage base rate limited: {base} (retry in ~{mins}m)")
        } else {
            format!("usage base rate limited: {base} (retry in ~{mins}m {rem}s)")
        }
    } else {
        format!("usage base rate limited: {base} (retry in ~{secs}s)")
    }
}

async fn wait_for_usage_base_refresh_slot(base: &str) -> Result<(), String> {
    let wait_ms = reserve_usage_base_refresh_slot(base, unix_ms(), USAGE_BASE_MIN_GAP_MS);
    if wait_ms > USAGE_BASE_MAX_INLINE_WAIT_MS {
        return Err(format_usage_base_backoff_error(base, wait_ms));
    }
    if wait_ms > 0 {
        tokio::time::sleep(Duration::from_millis(wait_ms)).await;
    }
    Ok(())
}

#[cfg(test)]
fn clear_usage_base_refresh_gate() {
    let lock = usage_base_refresh_gate();
    let mut gate = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    gate.clear();
}

#[cfg(test)]
fn clear_usage_proxy_rotation_state() {
    let lock = usage_proxy_rotation_state();
    let mut state = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    state.clear();
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
            package_expires_at_unix_ms: None,
            last_error: String::new(),
            effective_usage_base: None,
            effective_usage_source: None,
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
            "package_expires_at_unix_ms": self.package_expires_at_unix_ms,
            "last_error": self.last_error,
            "effective_usage_base": self.effective_usage_base,
            "effective_usage_source": self.effective_usage_source,
        })
    }
}

fn normalized_usage_proxy_pool(st: &GatewayState, provider_name: &str) -> Vec<String> {
    st.secrets
        .get_usage_proxy_pool(provider_name)
        .into_iter()
        .map(|proxy| proxy.trim().to_string())
        .filter(|proxy| !proxy.is_empty())
        .collect()
}

fn next_usage_proxy_for_provider(st: &GatewayState, provider_name: &str) -> Option<String> {
    let pool = normalized_usage_proxy_pool(st, provider_name);
    if pool.is_empty() {
        return None;
    }
    let lock = usage_proxy_rotation_state();
    let mut state = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let next = state.entry(provider_name.to_string()).or_insert(0);
    let proxy = pool[*next % pool.len()].clone();
    *next = next.saturating_add(1);
    Some(proxy)
}

fn build_usage_http_client(
    st: &GatewayState,
    provider_name: &str,
) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder().user_agent("api-router/0.1");
    if let Some(proxy_url) = next_usage_proxy_for_provider(st, provider_name) {
        let proxy = reqwest::Proxy::all(&proxy_url)
            .map_err(|e| format!("invalid usage proxy for {provider_name}: {e}"))?;
        builder = builder.proxy(proxy);
    }
    builder
        .build()
        .map_err(|e| format!("failed to build usage http client: {e}"))
}

pub fn detect_usage_kind(provider: &ProviderConfig) -> UsageKind {
    let explicit = UsageKind::from_str(&provider.usage_adapter);
    if explicit != UsageKind::None {
        return explicit;
    }

    // Intentionally do not infer from domains; keep it provider-agnostic.
    UsageKind::None
}

fn next_daily_reset_refresh_at<Tz>(now: chrono::DateTime<Tz>) -> chrono::DateTime<Tz>
where
    Tz: chrono::TimeZone,
    Tz::Offset: Copy,
{
    let base = now
        .with_second(0)
        .and_then(|dt| dt.with_nanosecond(0))
        .unwrap_or(now);
    if base.hour() == 0 && base.minute() < 1 {
        return base.with_minute(1).unwrap_or(base);
    }
    (base + chrono::Duration::days(1))
        .with_hour(0)
        .and_then(|dt| dt.with_minute(1))
        .and_then(|dt| dt.with_second(0))
        .and_then(|dt| dt.with_nanosecond(0))
        .unwrap_or(base + chrono::Duration::days(1))
}

fn next_packycode_refresh_at<Tz>(now: chrono::DateTime<Tz>) -> chrono::DateTime<Tz>
where
    Tz: chrono::TimeZone,
    Tz::Offset: Copy,
{
    let base = now
        .with_second(0)
        .and_then(|dt| dt.with_nanosecond(0))
        .unwrap_or(now);
    let hourly = if base.minute() < 58 {
        base.with_minute(58).unwrap_or(base)
    } else {
        (base + chrono::Duration::hours(1))
            .with_minute(58)
            .and_then(|dt| dt.with_second(0))
            .and_then(|dt| dt.with_nanosecond(0))
            .unwrap_or(base + chrono::Duration::hours(1))
    };
    let daily = next_daily_reset_refresh_at(now);
    if hourly <= daily {
        hourly
    } else {
        daily
    }
}

fn next_standard_quota_refresh_at<Tz>(now: chrono::DateTime<Tz>) -> chrono::DateTime<Tz>
where
    Tz: chrono::TimeZone,
    Tz::Offset: Copy,
{
    let hourly = next_packycode_refresh_at(now);
    let daily = next_daily_reset_refresh_at(now);
    if hourly <= daily {
        hourly
    } else {
        daily
    }
}

fn next_standard_quota_refresh_due_unix_ms(now_ms: u64) -> u64 {
    let now = chrono::Local
        .timestamp_millis_opt(now_ms as i64)
        .single()
        .unwrap_or_else(chrono::Local::now);
    next_standard_quota_refresh_at(now)
        .timestamp_millis()
        .max(0) as u64
}

include!("quota/base_resolution.rs");
include!("quota/package_expiry.rs");
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
    usage_login: &Option<UsageLoginConfig>,
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
    let auth_key = usage_auth_key(provider_key, usage_token, usage_login);
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
    usage_login: &Option<UsageLoginConfig>,
) -> UsageSharedKey {
    let base_key = base.trim().trim_end_matches('/').to_string();
    let auth_key = usage_auth_key(provider_key, usage_token, usage_login);
    UsageSharedKey { base_key, auth_key }
}

fn usage_auth_key(
    provider_key: &Option<String>,
    usage_token: &Option<String>,
    usage_login: &Option<UsageLoginConfig>,
) -> Option<String> {
    usage_token
        .clone()
        .or_else(|| provider_key.clone())
        .or_else(|| {
            usage_login
                .as_ref()
                .map(|entry| format!("login:{}", entry.username.trim()))
        })
}

fn stable_shared_fingerprint_component(input: &str) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in input.trim().as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

pub fn provider_runtime_identity(
    provider: &ProviderConfig,
    provider_key: &Option<String>,
    usage_token: &Option<String>,
    usage_login: &Option<UsageLoginConfig>,
) -> Option<String> {
    let shared_base = candidate_quota_bases(provider).first()?.clone();
    let shared_key = usage_shared_key(&shared_base, provider_key, usage_token, usage_login);
    let auth_component = shared_key
        .auth_key
        .as_deref()
        .map(stable_shared_fingerprint_component)
        .unwrap_or_else(|| "anon".to_string());
    Some(format!(
        "{}|{}",
        shared_key.base_key.trim().to_ascii_lowercase(),
        auth_component
    ))
}

pub fn shared_provider_fingerprint(
    cfg: &AppConfig,
    secrets: &super::secrets::SecretStore,
    provider_name: &str,
) -> Option<String> {
    let provider = cfg.providers.get(provider_name)?;
    let provider_key = secrets.get_provider_key(provider_name);
    let usage_token = secrets.get_usage_token(provider_name);
    let usage_login = secrets.get_usage_login(provider_name);
    provider_runtime_identity(provider, &provider_key, &usage_token, &usage_login)
}

fn shared_provider_fingerprint_for_provider(
    st: &GatewayState,
    provider_name: &str,
) -> Option<String> {
    let cfg = st.cfg.read().clone();
    shared_provider_fingerprint(&cfg, &st.secrets, provider_name)
}

pub fn shared_quota_owner_for_provider(
    st: &GatewayState,
    lan_sync: &crate::lan_sync::LanSyncRuntime,
    provider_name: &str,
) -> Option<crate::lan_sync::LanQuotaOwnerDecision> {
    let fingerprint = shared_provider_fingerprint_for_provider(st, provider_name)?;
    lan_sync.quota_owner_for_fingerprint(&fingerprint)
}

pub fn shared_quota_owner_statuses(
    st: &GatewayState,
    lan_sync: &crate::lan_sync::LanSyncRuntime,
) -> Vec<SharedQuotaOwnerStatus> {
    let cfg = st.cfg.read().clone();
    let mut out = Vec::new();
    for provider_name in cfg.providers.keys() {
        let Some(shared_provider_fingerprint) =
            shared_provider_fingerprint(&cfg, &st.secrets, provider_name)
        else {
            continue;
        };
        let Some(owner) = lan_sync.quota_owner_for_fingerprint(&shared_provider_fingerprint) else {
            continue;
        };
        let shared_provider_id = st
            .secrets
            .get_provider_shared_id(provider_name)
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| provider_name.clone());
        out.push(SharedQuotaOwnerStatus {
            provider: provider_name.clone(),
            shared_provider_id,
            shared_provider_fingerprint,
            owner_node_id: owner.owner_node_id,
            owner_node_name: owner.owner_node_name,
            local_is_owner: owner.local_is_owner,
            contender_count: owner.contender_count,
        });
    }
    out.sort_by(|a, b| a.provider.cmp(&b.provider));
    out
}

async fn compute_quota_snapshot(
    st: &GatewayState,
    provider_name: &str,
    kind: UsageKind,
    bases: &[String],
    explicit_usage_endpoint: Option<&str>,
    credentials: QuotaCredentials<'_>,
    strategies: QuotaSnapshotStrategies,
) -> QuotaSnapshot {
    let should_use_packycode_usage_flow = strategies.provider_strategy
        == PackageExpiryStrategy::Packycode
        && (credentials.usage_token.is_some()
            || strategies.package_expiry_fetch_strategy == PackageExpiryStrategy::Packycode);
    if should_use_packycode_usage_flow {
        let mut budget_errors: Vec<String> = Vec::new();

        if credentials.usage_token.is_some() {
            let browser_base = bases
                .first()
                .map(|value| value.as_str())
                .unwrap_or("https://codex.packycode.com");
            let budget = fetch_packycode_budget_info_via_browser_context(
                st,
                provider_name,
                browser_base,
                credentials.usage_token,
            )
            .await;
            if budget.last_error.is_empty() {
                return budget;
            }
            budget_errors.push(format!("packycode browser session: {}", budget.last_error));

            if let Some(token) = credentials.usage_token {
                let budget = fetch_budget_info_any(
                    st,
                    provider_name,
                    bases,
                    Some(token),
                    strategies.package_expiry_fetch_strategy,
                )
                .await;
                if budget.last_error.is_empty() {
                    return budget;
                }
                budget_errors.push(format!("packycode login token: {}", budget.last_error));
            }
        }

        if let Some(token) = credentials.provider_key {
            if credentials.usage_token != Some(token) {
                let budget = fetch_budget_info_any(
                    st,
                    provider_name,
                    bases,
                    Some(token),
                    strategies.package_expiry_fetch_strategy,
                )
                .await;
                if budget.last_error.is_empty() {
                    return budget;
                }
                budget_errors.push(format!("provider key: {}", budget.last_error));
            }
        }

        if credentials.provider_key.is_some() {
            let mut stats = fetch_token_stats_any(
                st,
                provider_name,
                bases,
                explicit_usage_endpoint,
                credentials.provider_key,
                credentials.usage_token,
                strategies.package_expiry_fetch_strategy,
            )
            .await;
            if !stats.last_error.is_empty() && !budget_errors.is_empty() {
                stats.last_error = format!(
                    "{}; token stats fallback: {}",
                    budget_errors.join("; "),
                    stats.last_error
                );
            }
            return stats;
        }

        if !budget_errors.is_empty() {
            let mut out = QuotaSnapshot::empty(UsageKind::BudgetInfo);
            out.last_error = budget_errors.join("; ");
            return out;
        }
    }

    if is_codex_for_me_base(provider_name, bases) {
        return fetch_codex_for_me_balance_any(
            st,
            provider_name,
            bases,
            credentials.usage_token,
            credentials.usage_login,
        )
        .await;
    }

    if let Some(endpoint_url) = explicit_usage_endpoint {
        let direct = fetch_explicit_usage_endpoint_any(
            st,
            provider_name,
            endpoint_url,
            credentials.provider_key,
            credentials.usage_token,
        )
        .await;
        if direct.last_error.is_empty() {
            return direct;
        }
    }

    match kind {
        UsageKind::TokenStats => {
            fetch_token_stats_any(
                st,
                provider_name,
                bases,
                explicit_usage_endpoint,
                credentials.provider_key,
                credentials.usage_token,
                strategies.package_expiry_fetch_strategy,
            )
            .await
        }
        UsageKind::BudgetInfo => {
            fetch_budget_info_any(
                st,
                provider_name,
                bases,
                credentials.usage_token,
                strategies.package_expiry_fetch_strategy,
            )
            .await
        }
        UsageKind::BalanceInfo => {
            fetch_codex_for_me_balance_any(
                st,
                provider_name,
                bases,
                credentials.usage_token,
                credentials.usage_login,
            )
            .await
        }
        UsageKind::None => {
            if credentials.provider_key.is_some() {
                let s = fetch_token_stats_any(
                    st,
                    provider_name,
                    bases,
                    explicit_usage_endpoint,
                    credentials.provider_key,
                    credentials.usage_token,
                    strategies.package_expiry_fetch_strategy,
                )
                .await;
                if s.last_error.is_empty() {
                    s
                } else if credentials.usage_token.is_some() {
                    fetch_budget_info_any(
                        st,
                        provider_name,
                        bases,
                        credentials.usage_token,
                        strategies.package_expiry_fetch_strategy,
                    )
                    .await
                } else if credentials.usage_login.is_some()
                    && is_codex_for_me_base(provider_name, bases)
                {
                    fetch_codex_for_me_balance_any(
                        st,
                        provider_name,
                        bases,
                        credentials.usage_token,
                        credentials.usage_login,
                    )
                    .await
                } else {
                    s
                }
            } else if credentials.usage_token.is_some() {
                fetch_budget_info_any(
                    st,
                    provider_name,
                    bases,
                    credentials.usage_token,
                    strategies.package_expiry_fetch_strategy,
                )
                .await
            } else if credentials.usage_login.is_some()
                && is_codex_for_me_base(provider_name, bases)
            {
                fetch_codex_for_me_balance_any(
                    st,
                    provider_name,
                    bases,
                    credentials.usage_token,
                    credentials.usage_login,
                )
                .await
            } else {
                let mut out = QuotaSnapshot::empty(UsageKind::None);
                out.last_error = "missing credentials for quota refresh".to_string();
                out
            }
        }
    }
}

fn store_quota_snapshot(st: &GatewayState, provider_name: &str, snap: &QuotaSnapshot) {
    let previous_snapshot = st
        .store
        .get_quota_snapshot(provider_name)
        .and_then(|value| quota_snapshot_from_json(&value));
    let snapshot_to_store = preserved_quota_snapshot_for_storage(st, provider_name, snap);
    let _ = st
        .store
        .put_quota_snapshot(provider_name, &snapshot_to_store.to_json());
    track_budget_spend(st, provider_name, &snapshot_to_store);
    if snap.last_error.is_empty() && snap.updated_at_unix_ms > 0 {
        st.router
            .mark_usage_refresh_success(provider_name, snap.updated_at_unix_ms);
        st.store.reset_ledger(provider_name);
        if previous_snapshot
            .as_ref()
            .is_some_and(|previous| !previous.last_error.trim().is_empty())
        {
            let source = quota_refresh_source_label(
                snapshot_to_store
                    .effective_usage_source
                    .as_deref()
                    .unwrap_or_default(),
            );
            let message = if source.is_empty() {
                "usage refresh recovered".to_string()
            } else {
                format!("usage refresh recovered via {source}")
            };
            st.store.add_event(
                provider_name,
                "info",
                "usage.refresh_recovered",
                &message,
                serde_json::json!({
                    "source": snapshot_to_store.effective_usage_source,
                    "effective_usage_base": snapshot_to_store.effective_usage_base,
                }),
            );
        }
    }
    // Avoid spamming the event log on routine/background refreshes. Only surface failures here;
    // user-initiated success summaries are logged by the tauri command layer.
    if !snap.last_error.is_empty() && !is_quota_refresh_config_gap(&snap.last_error) {
        let previous_key = previous_snapshot
            .as_ref()
            .map(|previous| quota_refresh_error_log_key(&previous.last_error));
        let current_key = quota_refresh_error_log_key(&snap.last_error);
        if previous_key.as_deref() == Some(current_key.as_str()) {
            return;
        }
        let err = snap.last_error.chars().take(300).collect::<String>();
        st.store.add_event(
            provider_name,
            "error",
            "usage.refresh_failed",
            &format!("usage refresh failed: {err}"),
            Value::Null,
        );
    }
}

pub(crate) fn clear_quota_snapshot(st: &GatewayState, provider_name: &str) {
    let snap = QuotaSnapshot::empty(UsageKind::None);
    let _ = st.store.put_quota_snapshot(provider_name, &snap.to_json());
}

fn store_quota_snapshot_silent(st: &GatewayState, provider_name: &str, snap: &QuotaSnapshot) {
    let _ = st.store.put_quota_snapshot(provider_name, &snap.to_json());
    // Propagation writes should not affect per-provider ledgers; only a real refresh should reset.
    // Tracking budget spend here would duplicate the same shared-key delta across propagated
    // providers and inflate total usage cost.
}

fn quota_snapshot_from_json(value: &Value) -> Option<QuotaSnapshot> {
    Some(QuotaSnapshot {
        kind: UsageKind::from_str(value.get("kind")?.as_str().unwrap_or("none")),
        updated_at_unix_ms: value
            .get("updated_at_unix_ms")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        remaining: as_f64(value.get("remaining")),
        today_used: as_f64(value.get("today_used")),
        today_added: as_f64(value.get("today_added")),
        daily_spent_usd: as_f64(value.get("daily_spent_usd")),
        daily_budget_usd: as_f64(value.get("daily_budget_usd")),
        weekly_spent_usd: as_f64(value.get("weekly_spent_usd")),
        weekly_budget_usd: as_f64(value.get("weekly_budget_usd")),
        monthly_spent_usd: as_f64(value.get("monthly_spent_usd")),
        monthly_budget_usd: as_f64(value.get("monthly_budget_usd")),
        package_expires_at_unix_ms: value
            .get("package_expires_at_unix_ms")
            .and_then(Value::as_u64),
        last_error: value
            .get("last_error")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        effective_usage_base: value
            .get("effective_usage_base")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        effective_usage_source: value
            .get("effective_usage_source")
            .and_then(Value::as_str)
            .map(ToString::to_string),
    })
}

fn cached_future_package_expiry_for_provider(
    st: &GatewayState,
    provider_name: &str,
    now_ms: u64,
) -> Option<u64> {
    st.store
        .get_quota_snapshot(provider_name)
        .and_then(|value| quota_snapshot_from_json(&value))
        .and_then(|snapshot| snapshot.package_expires_at_unix_ms)
        .filter(|expiry| *expiry > now_ms)
}

fn preserved_quota_snapshot_for_storage(
    st: &GatewayState,
    provider_name: &str,
    snap: &QuotaSnapshot,
) -> QuotaSnapshot {
    if snap.last_error.is_empty() && snap.updated_at_unix_ms > 0 {
        return snap.clone();
    }
    let Some(previous) = st
        .store
        .get_quota_snapshot(provider_name)
        .and_then(|value| quota_snapshot_from_json(&value))
    else {
        return snap.clone();
    };
    if previous.updated_at_unix_ms == 0 {
        return snap.clone();
    }

    QuotaSnapshot {
        kind: previous.kind,
        updated_at_unix_ms: previous.updated_at_unix_ms,
        remaining: previous.remaining,
        today_used: previous.today_used,
        today_added: previous.today_added,
        daily_spent_usd: previous.daily_spent_usd,
        daily_budget_usd: previous.daily_budget_usd,
        weekly_spent_usd: previous.weekly_spent_usd,
        weekly_budget_usd: previous.weekly_budget_usd,
        monthly_spent_usd: previous.monthly_spent_usd,
        monthly_budget_usd: previous.monthly_budget_usd,
        package_expires_at_unix_ms: previous.package_expires_at_unix_ms,
        last_error: snap.last_error.clone(),
        effective_usage_base: previous.effective_usage_base,
        effective_usage_source: previous.effective_usage_source,
    }
}

fn quota_refresh_source_label(source: &str) -> &'static str {
    match source.trim() {
        "packycode_browser_session" => "Packycode dashboard session",
        "usage_base" => "usage base",
        "token_stats" => "token stats",
        "codex_for_me_balance" => "codex-for.me dashboard",
        _ => "",
    }
}

fn quota_refresh_error_log_key(err: &str) -> String {
    let trimmed = err.trim();
    if let Some(rest) = trimmed.strip_prefix("usage base rate limited: ") {
        let base = rest.split(" (retry in").next().unwrap_or(rest).trim();
        return format!("usage_base_rate_limited:{base}");
    }
    trimmed.to_string()
}

pub(crate) fn clear_usage_refresh_gate_for_provider(st: &GatewayState, provider_name: &str) {
    let cfg = st.cfg.read().clone();
    let Some(provider) = cfg.providers.get(provider_name) else {
        return;
    };
    for base in candidate_quota_bases(provider) {
        clear_usage_base_refresh_gate_for_base(&base);
    }
}

fn is_quota_refresh_config_gap(err: &str) -> bool {
    matches!(
        err.trim(),
        "missing credentials for quota refresh"
            | "missing usage auth"
            | "missing usage token"
            | "missing quota base"
            | "missing base_url"
            | "usage endpoint not found (set Usage base URL)"
    )
}

fn should_run_background_quota_refresh(has_any_credential: bool, has_quota_source: bool) -> bool {
    has_any_credential && has_quota_source
}

fn should_run_background_quota_scheduler(
    now_ms: u64,
    last_activity_unix_ms: u64,
    has_alive_peers: bool,
) -> bool {
    if has_alive_peers {
        return true;
    }
    last_activity_unix_ms != 0 && now_ms.saturating_sub(last_activity_unix_ms) < 10 * 60 * 1000
}

fn can_refresh_quota_for_provider(
    st: &GatewayState,
    provider_name: &str,
    provider: &ProviderConfig,
) -> bool {
    let bases = candidate_quota_bases(provider);
    if bases.is_empty() {
        return false;
    }
    let provider_key = st.secrets.get_provider_key(provider_name);
    let usage_token = st.secrets.get_usage_token(provider_name);
    let usage_login = st.secrets.get_usage_login(provider_name);
    if is_codex_for_me_base(provider_name, &bases) {
        return usage_token.is_some() || usage_login.is_some();
    }
    provider_key.is_some() || usage_token.is_some() || usage_login.is_some()
}

fn quota_refresh_interval_ms(
    now_ms: u64,
    _is_active_provider: bool,
    _is_preferred_provider: bool,
    _has_successful_snapshot: bool,
    _shared_provider_count: usize,
    _last_error: &str,
    _provider_strategy: PackageExpiryStrategy,
) -> u64 {
    next_standard_quota_refresh_due_unix_ms(now_ms).saturating_sub(now_ms)
}

fn initial_quota_refresh_due_unix_ms(
    now_ms: u64,
    existing_snapshot: Option<&QuotaSnapshot>,
    _is_active_provider: bool,
    _is_preferred_provider: bool,
    _shared_provider_count: usize,
    _provider_strategy: PackageExpiryStrategy,
) -> Option<u64> {
    if existing_snapshot.is_some_and(|existing| existing.updated_at_unix_ms == 0) {
        return None;
    }
    Some(next_standard_quota_refresh_due_unix_ms(now_ms))
}

fn track_budget_spend(st: &GatewayState, provider_name: &str, snap: &QuotaSnapshot) {
    fn api_key_ref_from_raw(key: Option<&str>) -> String {
        let raw = key.unwrap_or("").trim();
        if raw.is_empty() {
            return "-".to_string();
        }
        let chars: Vec<char> = raw.chars().collect();
        if chars.len() < 10 {
            return "set".to_string();
        }
        let start_len = std::cmp::min(6, chars.len().saturating_sub(4));
        let start: String = chars.iter().take(start_len).collect();
        let end: String = chars
            .iter()
            .rev()
            .take(4)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        format!("{start}******{end}")
    }

    if snap.kind != UsageKind::BudgetInfo {
        return;
    }
    if !snap.last_error.is_empty() || snap.updated_at_unix_ms == 0 {
        return;
    }
    let Some(current_daily_spent) = snap.daily_spent_usd.filter(|v| v.is_finite() && *v >= 0.0)
    else {
        return;
    };

    let now = snap.updated_at_unix_ms;
    let api_key_ref = api_key_ref_from_raw(st.secrets.get_provider_key(provider_name).as_deref());
    let existing_state = st.store.get_spend_state(provider_name);

    let mut tracking_started_unix_ms = existing_state
        .as_ref()
        .and_then(|s| s.get("tracking_started_unix_ms"))
        .and_then(|v| v.as_u64())
        .unwrap_or(now);
    let mut open_day_started_at_unix_ms = existing_state
        .as_ref()
        .and_then(|s| s.get("open_day_started_at_unix_ms"))
        .and_then(|v| v.as_u64())
        .unwrap_or(now);
    let mut last_seen_daily_spent = existing_state
        .as_ref()
        .and_then(|s| as_f64(s.get("last_seen_daily_spent_usd")))
        .unwrap_or(current_daily_spent);

    // First observed snapshot for this provider: initialize tracking baseline.
    if existing_state.is_none() {
        tracking_started_unix_ms = now;
        open_day_started_at_unix_ms = now;
        last_seen_daily_spent = current_daily_spent;
        let day = serde_json::json!({
            "provider": provider_name,
            "api_key_ref": api_key_ref.clone(),
            "started_at_unix_ms": open_day_started_at_unix_ms,
            "ended_at_unix_ms": Value::Null,
            // First snapshot of the day already includes spend that happened before refresh.
            "tracked_spend_usd": current_daily_spent,
            "last_seen_daily_spent_usd": current_daily_spent,
            "updated_at_unix_ms": now
        });
        st.store
            .put_spend_day(provider_name, open_day_started_at_unix_ms, &day);
    } else {
        let epsilon = 1e-7_f64;
        if current_daily_spent + epsilon < last_seen_daily_spent {
            if let Some(mut prev_day) = st
                .store
                .get_spend_day(provider_name, open_day_started_at_unix_ms)
            {
                if prev_day.get("ended_at_unix_ms").is_none()
                    || prev_day.get("ended_at_unix_ms").is_some_and(Value::is_null)
                {
                    prev_day["ended_at_unix_ms"] = serde_json::json!(now);
                }
                prev_day["updated_at_unix_ms"] = serde_json::json!(now);
                prev_day["last_seen_daily_spent_usd"] = serde_json::json!(last_seen_daily_spent);
                st.store
                    .put_spend_day(provider_name, open_day_started_at_unix_ms, &prev_day);
            }

            open_day_started_at_unix_ms = now;
            let day = serde_json::json!({
                "provider": provider_name,
                "api_key_ref": api_key_ref.clone(),
                "started_at_unix_ms": open_day_started_at_unix_ms,
                "ended_at_unix_ms": Value::Null,
                // New day baseline can be non-zero if first refresh happens after early usage.
                "tracked_spend_usd": current_daily_spent,
                "last_seen_daily_spent_usd": current_daily_spent,
                "updated_at_unix_ms": now
            });
            st.store
                .put_spend_day(provider_name, open_day_started_at_unix_ms, &day);
            last_seen_daily_spent = current_daily_spent;
        } else {
            let delta = (current_daily_spent - last_seen_daily_spent).max(0.0);
            let mut day = st
                .store
                .get_spend_day(provider_name, open_day_started_at_unix_ms)
                .unwrap_or_else(|| {
                    serde_json::json!({
                        "provider": provider_name,
                        "api_key_ref": api_key_ref.clone(),
                        "started_at_unix_ms": open_day_started_at_unix_ms,
                        "ended_at_unix_ms": Value::Null,
                        "tracked_spend_usd": 0.0,
                        "last_seen_daily_spent_usd": last_seen_daily_spent,
                        "updated_at_unix_ms": now
                    })
                });
            let tracked = as_f64(day.get("tracked_spend_usd")).unwrap_or(0.0);
            day["tracked_spend_usd"] = serde_json::json!(tracked + delta);
            day["last_seen_daily_spent_usd"] = serde_json::json!(current_daily_spent);
            day["updated_at_unix_ms"] = serde_json::json!(now);
            st.store
                .put_spend_day(provider_name, open_day_started_at_unix_ms, &day);
            last_seen_daily_spent = current_daily_spent;
        }
    }

    let state = serde_json::json!({
        "provider": provider_name,
        "tracking_started_unix_ms": tracking_started_unix_ms,
        "open_day_started_at_unix_ms": open_day_started_at_unix_ms,
        "last_seen_daily_spent_usd": last_seen_daily_spent,
        "updated_at_unix_ms": now
    });
    st.store.put_spend_state(provider_name, &state);
}

async fn propagate_quota_snapshot_shared(
    st: &GatewayState,
    source_provider: &str,
    source_shared_key: &UsageSharedKey,
    snap: &QuotaSnapshot,
) {
    if !snap.last_error.is_empty() || snap.updated_at_unix_ms == 0 {
        return;
    }

    let cfg = st.cfg.read().clone();
    let source_package_expiry_strategy = cfg
        .providers
        .get(source_provider)
        .map(|p| detect_package_expiry_strategy(&p.base_url))
        .unwrap_or(PackageExpiryStrategy::None);
    for (name, p) in cfg.providers.iter() {
        if name == source_provider {
            continue;
        }

        let provider_key = st.secrets.get_provider_key(name);
        let usage_token = st.secrets.get_usage_token(name);
        let usage_login = st.secrets.get_usage_login(name);

        let bases = candidate_quota_bases(p);
        let Some(shared_base) = bases.first().map(|s| s.as_str()) else {
            continue;
        };
        let shared = usage_shared_key(shared_base, &provider_key, &usage_token, &usage_login);
        if &shared != source_shared_key {
            continue;
        }

        // If the target provider explicitly pins a usage adapter, only propagate matching snapshots.
        // (Auto-detected providers use `UsageKind::None` and can accept either kind.)
        let other_kind = detect_usage_kind(p);
        if other_kind != UsageKind::None && other_kind != snap.kind {
            continue;
        }

        let mut copied = snap.clone();
        let target_package_expiry_strategy = detect_package_expiry_strategy(&p.base_url);
        if target_package_expiry_strategy != source_package_expiry_strategy {
            copied.package_expires_at_unix_ms = None;
        }
        copied.effective_usage_base = Some(shared_base.to_string());
        store_quota_snapshot_silent(st, name, &copied);
    }
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
    let usage_login = st.secrets.get_usage_login(provider_name);
    let bases_raw = candidate_quota_bases(p);
    let Some(shared_base) = bases_raw.first().cloned() else {
        let mut out = QuotaSnapshot::empty(UsageKind::None);
        out.last_error = "missing base_url".to_string();
        return out;
    };
    let bases =
        reorder_bases_for_speed(st, provider_name, bases_raw, provider_key.as_deref()).await;
    let effective_base = bases.first().cloned();

    let kind = detect_usage_kind(p);
    let cached_package_expiry =
        cached_future_package_expiry_for_provider(st, provider_name, unix_ms());
    let provider_strategy = detect_package_expiry_strategy(&p.base_url);
    let package_expiry_fetch_strategy = if cached_package_expiry.is_some()
        && provider_strategy != PackageExpiryStrategy::Packycode
    {
        PackageExpiryStrategy::None
    } else {
        provider_strategy
    };
    let shared_key = usage_shared_key(&shared_base, &provider_key, &usage_token, &usage_login);
    let mut snap = compute_quota_snapshot(
        st,
        provider_name,
        kind,
        &bases,
        explicit_usage_endpoint_url(p).as_deref(),
        QuotaCredentials {
            provider_key: provider_key.as_deref(),
            usage_token: usage_token.as_deref(),
            usage_login: usage_login.as_ref(),
        },
        QuotaSnapshotStrategies {
            provider_strategy,
            package_expiry_fetch_strategy,
        },
    )
    .await;
    if snap.effective_usage_base.is_none() {
        snap.effective_usage_base = effective_base;
    }
    if snap.package_expires_at_unix_ms.is_none() {
        snap.package_expires_at_unix_ms = cached_package_expiry;
    }
    store_quota_snapshot(st, provider_name, &snap);
    propagate_quota_snapshot_shared(st, provider_name, &shared_key, &snap).await;
    snap
}

pub async fn refresh_quota_for_provider_with_lan_owner(
    st: &GatewayState,
    lan_sync: &crate::lan_sync::LanSyncRuntime,
    provider_name: &str,
) -> Result<QuotaSnapshot, String> {
    if let Some(owner) = shared_quota_owner_for_provider(st, lan_sync, provider_name) {
        if !owner.local_is_owner {
            return Err(format!(
                "shared quota refresh is owned by {} ({})",
                owner.owner_node_name, owner.owner_node_id
            ));
        }
    }
    Ok(refresh_quota_for_provider(st, provider_name).await)
}

async fn refresh_quota_for_provider_cached(
    st: &GatewayState,
    provider_name: &str,
    cache: &mut HashMap<UsageRequestKey, QuotaSnapshot>,
) -> QuotaSnapshot {
    let cfg = st.cfg.read().clone();
    let Some(p) = cfg.providers.get(provider_name) else {
        let mut out = QuotaSnapshot::empty(UsageKind::None);
        out.last_error = format!("unknown provider: {provider_name}");
        return out;
    };

    let provider_key = st.secrets.get_provider_key(provider_name);
    let usage_token = st.secrets.get_usage_token(provider_name);
    let usage_login = st.secrets.get_usage_login(provider_name);
    let bases_raw = candidate_quota_bases(p);
    let Some(shared_base) = bases_raw.first().cloned() else {
        let mut out = QuotaSnapshot::empty(UsageKind::None);
        out.last_error = "missing base_url".to_string();
        return out;
    };
    let bases =
        reorder_bases_for_speed(st, provider_name, bases_raw, provider_key.as_deref()).await;
    let effective_base = bases.first().cloned();

    let kind = detect_usage_kind(p);
    let cached_package_expiry =
        cached_future_package_expiry_for_provider(st, provider_name, unix_ms());
    let provider_strategy = detect_package_expiry_strategy(&p.base_url);
    let package_expiry_fetch_strategy = if cached_package_expiry.is_some()
        && provider_strategy != PackageExpiryStrategy::Packycode
    {
        PackageExpiryStrategy::None
    } else {
        provider_strategy
    };
    let key = usage_request_key(&bases, &provider_key, &usage_token, &usage_login, kind);
    let shared_key = usage_shared_key(&shared_base, &provider_key, &usage_token, &usage_login);
    let snap = if let Some(existing) = cache.get(&key) {
        existing.clone()
    } else {
        let mut computed = compute_quota_snapshot(
            st,
            provider_name,
            kind,
            &bases,
            explicit_usage_endpoint_url(p).as_deref(),
            QuotaCredentials {
                provider_key: provider_key.as_deref(),
                usage_token: usage_token.as_deref(),
                usage_login: usage_login.as_ref(),
            },
            QuotaSnapshotStrategies {
                provider_strategy,
                package_expiry_fetch_strategy,
            },
        )
        .await;
        if computed.effective_usage_base.is_none() {
            computed.effective_usage_base = effective_base.clone();
        }
        cache.insert(key, computed.clone());
        computed
    };
    let mut snap = snap;
    if snap.effective_usage_base.is_none() {
        snap.effective_usage_base = effective_base;
    }
    if snap.package_expires_at_unix_ms.is_none() {
        snap.package_expires_at_unix_ms = cached_package_expiry;
    }
    store_quota_snapshot(st, provider_name, &snap);
    propagate_quota_snapshot_shared(st, provider_name, &shared_key, &snap).await;
    snap
}

fn usage_shared_key_for_provider(st: &GatewayState, provider_name: &str) -> Option<UsageSharedKey> {
    let cfg = st.cfg.read().clone();
    let p = cfg.providers.get(provider_name)?;
    let provider_key = st.secrets.get_provider_key(provider_name);
    let usage_token = st.secrets.get_usage_token(provider_name);
    let usage_login = st.secrets.get_usage_login(provider_name);
    let bases = candidate_quota_bases(p);
    let shared_base = bases.first()?.as_str();
    Some(usage_shared_key(
        shared_base,
        &provider_key,
        &usage_token,
        &usage_login,
    ))
}

pub async fn refresh_quota_shared(
    st: &GatewayState,
    lan_sync: &crate::lan_sync::LanSyncRuntime,
    provider_name: &str,
) -> Result<Vec<String>, String> {
    let cfg = st.cfg.read().clone();
    let Some(provider) = cfg.providers.get(provider_name) else {
        return Err(format!("unknown provider: {provider_name}"));
    };
    if let Some(owner) = shared_quota_owner_for_provider(st, lan_sync, provider_name) {
        if !owner.local_is_owner {
            return Err(format!(
                "shared quota refresh is owned by {} ({})",
                owner.owner_node_name, owner.owner_node_id
            ));
        }
    }
    if !can_refresh_quota_for_provider(st, provider_name, provider) {
        return Ok(Vec::new());
    }
    let target_key = usage_shared_key_for_provider(st, provider_name);
    let mut cache: HashMap<UsageRequestKey, QuotaSnapshot> = HashMap::new();
    let mut group = Vec::new();

    if let Some(target_key) = target_key {
        for (name, provider) in cfg.providers.iter() {
            if !can_refresh_quota_for_provider(st, name, provider) {
                continue;
            }
            if let Some(key) = usage_shared_key_for_provider(st, name) {
                if key == target_key {
                    group.push(name.clone());
                }
            }
        }
    }

    // Fetch once for the requested provider; the "shared base+key" propagation will update peers.
    let snap = refresh_quota_for_provider_cached(st, provider_name, &mut cache).await;
    if !snap.last_error.is_empty() || snap.updated_at_unix_ms == 0 {
        return Err(if snap.last_error.is_empty() {
            "usage refresh failed".to_string()
        } else {
            snap.last_error
        });
    }

    if group.is_empty() {
        group.push(provider_name.to_string());
    }
    Ok(group)
}

pub async fn refresh_quota_all_with_summary(
    st: &GatewayState,
    lan_sync: &crate::lan_sync::LanSyncRuntime,
) -> (usize, usize, Vec<String>) {
    let cfg = st.cfg.read().clone();
    let mut cache: HashMap<UsageRequestKey, QuotaSnapshot> = HashMap::new();
    let mut ok = 0usize;
    let mut err = 0usize;
    let mut failed = Vec::new();

    for (name, provider) in cfg.providers.iter() {
        if !can_refresh_quota_for_provider(st, name, provider) {
            continue;
        }
        if shared_quota_owner_for_provider(st, lan_sync, name)
            .is_some_and(|owner| !owner.local_is_owner)
        {
            continue;
        }
        let snap = refresh_quota_for_provider_cached(st, name, &mut cache).await;
        if snap.last_error.is_empty() && snap.updated_at_unix_ms > 0 {
            ok += 1;
        } else {
            err += 1;
            failed.push(name.clone());
        }
        // Manual/all refresh: space requests enough to avoid tripping shared usage hosts.
        tokio::time::sleep(Duration::from_millis(USAGE_BASE_MIN_GAP_MS)).await;
    }

    (ok, err, failed)
}

pub async fn run_quota_scheduler(st: GatewayState, lan_sync: crate::lan_sync::LanSyncRuntime) {
    let mut next_refresh_unix_ms: HashMap<String, u64> = HashMap::new();

    loop {
        tokio::time::sleep(Duration::from_millis(900)).await;

        let now = unix_ms();
        let last_activity = st
            .last_activity_unix_ms
            .load(std::sync::atomic::Ordering::Relaxed);
        let has_alive_peers = lan_sync.has_alive_peers();
        if !should_run_background_quota_scheduler(now, last_activity, has_alive_peers) {
            continue;
        }
        let cfg = st.cfg.read().clone();
        let mut shared_provider_counts: HashMap<String, usize> = HashMap::new();
        for name in cfg.providers.keys() {
            if let Some(shared_key) = usage_shared_key_for_provider(&st, name) {
                *shared_provider_counts
                    .entry(shared_key.base_key)
                    .or_default() += 1;
            }
        }
        let mut cache: HashMap<UsageRequestKey, QuotaSnapshot> = HashMap::new();
        for (name, p) in cfg.providers.iter() {
            let has_any_credential = st.secrets.get_provider_key(name).is_some()
                || st.secrets.get_usage_token(name).is_some();
            let has_quota_source = !candidate_quota_bases(p).is_empty();
            if !should_run_background_quota_refresh(has_any_credential, has_quota_source) {
                continue;
            }

            let shared_provider_count = usage_shared_key_for_provider(&st, name)
                .and_then(|key| shared_provider_counts.get(&key.base_key).copied())
                .unwrap_or(1);
            let existing_snapshot = st
                .store
                .get_quota_snapshot(name)
                .and_then(|value| quota_snapshot_from_json(&value));
            let due = next_refresh_unix_ms.get(name).copied().unwrap_or_else(|| {
                initial_quota_refresh_due_unix_ms(
                    now,
                    existing_snapshot.as_ref(),
                    false,
                    name == &cfg.routing.preferred_provider,
                    shared_provider_count,
                    detect_package_expiry_strategy(&p.base_url),
                )
                .unwrap_or(0)
            });
            if due != 0 && now < due {
                next_refresh_unix_ms.insert(name.clone(), due);
                continue;
            }
            if shared_quota_owner_for_provider(&st, &lan_sync, name)
                .is_some_and(|owner| !owner.local_is_owner)
            {
                let jitter_ms = quota_refresh_interval_ms(
                    now,
                    false,
                    name == &cfg.routing.preferred_provider,
                    existing_snapshot.as_ref().is_some_and(|existing| {
                        existing.last_error.is_empty() && existing.updated_at_unix_ms > 0
                    }),
                    shared_provider_count,
                    "",
                    detect_package_expiry_strategy(&p.base_url),
                );
                next_refresh_unix_ms.insert(name.clone(), now.saturating_add(jitter_ms));
                continue;
            }

            let snap = refresh_quota_for_provider_cached(&st, name, &mut cache).await;
            let previous_success = existing_snapshot.is_some_and(|existing| {
                existing.last_error.is_empty() && existing.updated_at_unix_ms > 0
            });
            let jitter_ms = quota_refresh_interval_ms(
                now,
                false,
                name == &cfg.routing.preferred_provider,
                previous_success,
                shared_provider_count,
                &snap.last_error,
                detect_package_expiry_strategy(&p.base_url),
            );
            next_refresh_unix_ms.insert(name.clone(), now.saturating_add(jitter_ms));

            // Avoid "burst" patterns when multiple providers are due at the same time.
            tokio::time::sleep(Duration::from_millis(120)).await;
        }
    }
}

include!("quota/usage_fetch.rs");
include!("quota/tests.rs");
