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

async fn compute_quota_snapshot(
    kind: UsageKind,
    bases: &[String],
    provider_key: Option<&str>,
    usage_token: Option<&str>,
) -> QuotaSnapshot {
    match kind {
        UsageKind::TokenStats => fetch_token_stats_any(bases, provider_key).await,
        UsageKind::BudgetInfo => fetch_budget_info_any(bases, usage_token).await,
        UsageKind::None => {
            if provider_key.is_some() {
                let s = fetch_token_stats_any(bases, provider_key).await;
                if s.last_error.is_empty() {
                    s
                } else if usage_token.is_some() {
                    fetch_budget_info_any(bases, usage_token).await
                } else {
                    s
                }
            } else if usage_token.is_some() {
                fetch_budget_info_any(bases, usage_token).await
            } else {
                let mut out = QuotaSnapshot::empty(UsageKind::None);
                out.last_error = "missing credentials for quota refresh".to_string();
                out
            }
        }
    }
}

fn store_quota_snapshot(st: &GatewayState, provider_name: &str, snap: &QuotaSnapshot) {
    let _ = st.store.put_quota_snapshot(provider_name, &snap.to_json());
    track_budget_spend(st, provider_name, snap);
    if snap.last_error.is_empty() && snap.updated_at_unix_ms > 0 {
        st.store.reset_ledger(provider_name);
    }
    // Avoid spamming the event log on routine/background refreshes. Only surface failures here;
    // user-initiated success summaries are logged by the tauri command layer.
    if !snap.last_error.is_empty() {
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

fn store_quota_snapshot_silent(st: &GatewayState, provider_name: &str, snap: &QuotaSnapshot) {
    let _ = st.store.put_quota_snapshot(provider_name, &snap.to_json());
    // Propagation writes should not affect per-provider ledgers; only a real refresh should reset.
    // Tracking budget spend here would duplicate the same shared-key delta across propagated
    // providers and inflate total usage cost.
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
    for (name, p) in cfg.providers.iter() {
        if name == source_provider {
            continue;
        }

        let provider_key = st.secrets.get_provider_key(name);
        let mut usage_token = st.secrets.get_usage_token(name);
        if usage_token.is_none() && is_packycode_base(&p.base_url) {
            usage_token = provider_key.clone();
        }

        let bases = candidate_quota_bases(p);
        let Some(shared_base) = bases.first().map(|s| s.as_str()) else {
            continue;
        };
        let shared = usage_shared_key(shared_base, &provider_key, &usage_token);
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
    let mut usage_token = st.secrets.get_usage_token(provider_name);
    if usage_token.is_none() && is_packycode_base(&p.base_url) {
        usage_token = provider_key.clone();
    }
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
    let shared_key = usage_shared_key(&shared_base, &provider_key, &usage_token);
    let mut snap = compute_quota_snapshot(
        kind,
        &bases,
        provider_key.as_deref(),
        usage_token.as_deref(),
    )
    .await;
    if snap.effective_usage_base.is_none() {
        snap.effective_usage_base = effective_base;
    }
    store_quota_snapshot(st, provider_name, &snap);
    propagate_quota_snapshot_shared(st, provider_name, &shared_key, &snap).await;
    snap
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
    let mut usage_token = st.secrets.get_usage_token(provider_name);
    if usage_token.is_none() && is_packycode_base(&p.base_url) {
        usage_token = provider_key.clone();
    }
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
    let key = usage_request_key(&bases, &provider_key, &usage_token, kind);
    let shared_key = usage_shared_key(&shared_base, &provider_key, &usage_token);
    let snap = if let Some(existing) = cache.get(&key) {
        existing.clone()
    } else {
        let mut computed = compute_quota_snapshot(
            kind,
            &bases,
            provider_key.as_deref(),
            usage_token.as_deref(),
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
    store_quota_snapshot(st, provider_name, &snap);
    propagate_quota_snapshot_shared(st, provider_name, &shared_key, &snap).await;
    snap
}

fn usage_shared_key_for_provider(st: &GatewayState, provider_name: &str) -> Option<UsageSharedKey> {
    let cfg = st.cfg.read().clone();
    let p = cfg.providers.get(provider_name)?;
    let provider_key = st.secrets.get_provider_key(provider_name);
    let mut usage_token = st.secrets.get_usage_token(provider_name);
    if usage_token.is_none() && is_packycode_base(&p.base_url) {
        usage_token = provider_key.clone();
    }
    let bases = candidate_quota_bases(p);
    let shared_base = bases.first()?.as_str();
    Some(usage_shared_key(shared_base, &provider_key, &usage_token))
}

pub async fn refresh_quota_shared(
    st: &GatewayState,
    provider_name: &str,
) -> Result<Vec<String>, String> {
    let cfg = st.cfg.read().clone();
    if !cfg.providers.contains_key(provider_name) {
        return Err(format!("unknown provider: {provider_name}"));
    }
    let target_key = usage_shared_key_for_provider(st, provider_name);
    let mut cache: HashMap<UsageRequestKey, QuotaSnapshot> = HashMap::new();
    let mut group = Vec::new();

    if let Some(target_key) = target_key {
        for name in cfg.providers.keys() {
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

pub async fn refresh_quota_all_with_summary(st: &GatewayState) -> (usize, usize, Vec<String>) {
    let cfg = st.cfg.read().clone();
    let mut cache: HashMap<UsageRequestKey, QuotaSnapshot> = HashMap::new();
    let mut ok = 0usize;
    let mut err = 0usize;
    let mut failed = Vec::new();

    for name in cfg.providers.keys() {
        let snap = refresh_quota_for_provider_cached(st, name, &mut cache).await;
        if snap.last_error.is_empty() && snap.updated_at_unix_ms > 0 {
            ok += 1;
        } else {
            err += 1;
            failed.push(name.clone());
        }
        // Manual/all refresh: keep a small delay so we don't look like a burst/DDOS.
        tokio::time::sleep(Duration::from_millis(120)).await;
    }

    (ok, err, failed)
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
        let mut cache: HashMap<UsageRequestKey, QuotaSnapshot> = HashMap::new();
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

            let snap = refresh_quota_for_provider_cached(&st, name, &mut cache).await;
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
        .user_agent("api-router/0.1")
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

                if let Some((remaining, today_used, today_added)) = extract_token_stats(&j) {
                    out.remaining = remaining;
                    out.today_used = today_used;
                    out.today_added = today_added;
                    out.effective_usage_base = Some(base.to_string());
                    out.updated_at_unix_ms = unix_ms();
                    out.last_error.clear();
                    return out;
                }

                if let Some((remaining, today_used, today_added)) =
                    fetch_token_logs_stats(&client, base, k).await
                {
                    out.remaining = remaining;
                    out.today_used = today_used;
                    out.today_added = today_added;
                    out.effective_usage_base = Some(base.to_string());
                    out.updated_at_unix_ms = unix_ms();
                    out.last_error.clear();
                    return out;
                }

                last_err = "unexpected response".to_string();
                continue;
            }
            Err(e) => {
                last_err = format_reqwest_error_for_logs(&e);
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

fn extract_token_stats(payload: &Value) -> Option<(Option<f64>, Option<f64>, Option<f64>)> {
    if let Some(info) = payload.pointer("/data/info") {
        if info.is_object() {
            let stats = payload
                .pointer("/data/stats/today_stats")
                .unwrap_or(&Value::Null);
            let remaining = as_f64(info.get("remain_quota_display"))
                .or_else(|| as_f64(info.get("remain_quota")));
            let today_used =
                as_f64(stats.get("used_quota")).or_else(|| as_f64(stats.get("used_quota_display")));
            let today_added = as_f64(stats.get("added_quota"))
                .or_else(|| as_f64(stats.get("added_quota_display")));
            return Some((remaining, today_used, today_added));
        }
    }

    let token_info = payload
        .pointer("/data/token_info")
        .or_else(|| payload.pointer("/data/data/token_info"))
        .or_else(|| payload.pointer("/token_info"));
    let token_info = token_info?;
    if !token_info.is_object() {
        return None;
    }

    let mut remaining = as_f64(token_info.get("remain_quota_display"))
        .or_else(|| as_f64(token_info.get("remain_quota")))
        .or_else(|| as_f64(token_info.get("remaining_quota")));
    let mut today_used = as_f64(token_info.get("today_used_quota"))
        .or_else(|| as_f64(token_info.get("today_used_quota_display")))
        .or_else(|| as_f64(token_info.get("used_quota")))
        .or_else(|| as_f64(token_info.get("used_quota_display")));
    let mut today_added = as_f64(token_info.get("today_added_quota"))
        .or_else(|| as_f64(token_info.get("today_added_quota_display")))
        .or_else(|| as_f64(token_info.get("added_quota")))
        .or_else(|| as_f64(token_info.get("added_quota_display")));
    let today_stats = payload
        .pointer("/data/today_stats")
        .or_else(|| payload.pointer("/data/stats/today_stats"));
    if let Some(stats) = today_stats {
        if today_used.is_none() {
            today_used =
                as_f64(stats.get("used_quota")).or_else(|| as_f64(stats.get("used_quota_display")));
        }
        if today_added.is_none() {
            today_added = as_f64(stats.get("added_quota"))
                .or_else(|| as_f64(stats.get("added_quota_display")));
        }
    }
    if remaining.is_none() {
        if let (Some(added), Some(used)) = (today_added, today_used) {
            remaining = Some(added - used);
        }
    }
    if remaining.is_none() && today_used.is_none() && today_added.is_none() {
        return None;
    }
    Some((remaining, today_used, today_added))
}

async fn fetch_token_logs_stats(
    client: &reqwest::Client,
    base: &str,
    token_key: &str,
) -> Option<(Option<f64>, Option<f64>, Option<f64>)> {
    let url = format!(
        "{base}/api/token-logs?token_key={}&page=1&page_size=1",
        urlencoding::encode(token_key)
    );
    let resp = client
        .get(url)
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let j = resp.json::<Value>().await.ok()?;
    let token_info = j
        .pointer("/data/token_info")
        .or_else(|| j.pointer("/data/data/token_info"))
        .or_else(|| j.pointer("/token_info"))?;
    if !token_info.is_object() {
        return None;
    }

    let remaining = as_f64(token_info.get("remain_quota_display"))
        .or_else(|| as_f64(token_info.get("remain_quota")))
        .or_else(|| as_f64(token_info.get("remaining_quota")));
    let today_used = as_f64(token_info.get("today_used_quota"))
        .or_else(|| as_f64(token_info.get("today_used_quota_display")))
        .or_else(|| as_f64(token_info.get("used_quota")))
        .or_else(|| as_f64(token_info.get("used_quota_display")));
    let today_added = as_f64(token_info.get("today_added_quota"))
        .or_else(|| as_f64(token_info.get("today_added_quota_display")))
        .or_else(|| as_f64(token_info.get("added_quota")))
        .or_else(|| as_f64(token_info.get("added_quota_display")));
    if remaining.is_none() && today_used.is_none() && today_added.is_none() {
        return None;
    }
    Some((remaining, today_used, today_added))
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
        .user_agent("api-router/0.1")
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
                if root.get("daily_spent_usd").is_none()
                    && root.get("monthly_spent_usd").is_none()
                    && root.get("weekly_spent_usd").is_none()
                    && root.get("weekly_spent").is_none()
                {
                    last_err = "unexpected response".to_string();
                    continue;
                }

                out.daily_spent_usd = as_f64(root.get("daily_spent_usd"));
                out.daily_budget_usd = as_f64(root.get("daily_budget_usd"));
                out.weekly_spent_usd = as_f64(root.get("weekly_spent_usd"))
                    .or_else(|| as_f64(root.get("weekly_spent")));
                out.weekly_budget_usd = as_f64(root.get("weekly_budget_usd"))
                    .or_else(|| as_f64(root.get("weekly_budget")));
                out.monthly_spent_usd = as_f64(root.get("monthly_spent_usd"));
                out.monthly_budget_usd = as_f64(root.get("monthly_budget_usd"));
                out.remaining = as_f64(root.get("remaining_quota"));
                out.effective_usage_base = Some(base.to_string());
                out.updated_at_unix_ms = unix_ms();
                out.last_error.clear();
                return out;
            }
            Err(e) => {
                last_err = format_reqwest_error_for_logs(&e);
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
        .or_else(|| {
            v.as_str().and_then(|s| {
                let cleaned = s.trim().replace([',', '%'], "");
                if cleaned.is_empty() {
                    None
                } else {
                    cleaned.parse::<f64>().ok()
                }
            })
        })
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
            usage_adapter: String::new(),
            usage_base_url: None,
            api_key: String::new(),
        };
        let pumpkin = ProviderConfig {
            display_name: "Pumpkin".to_string(),
            base_url: "https://code.pumpkinai.vip/v1".to_string(),
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
