use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use std::sync::Arc;

use base64::Engine as _;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
struct SecretsFile {
    #[serde(default)]
    providers: BTreeMap<String, String>,
    #[serde(default)]
    provider_key_storage_modes: BTreeMap<String, String>,
    #[serde(default)]
    provider_account_emails: BTreeMap<String, String>,
    /// Optional non-upstream secrets used by the app (e.g. usage JWTs).
    #[serde(default)]
    usage_tokens: BTreeMap<String, String>,
    #[serde(default)]
    usage_logins: BTreeMap<String, UsageLoginSecret>,
    #[serde(default)]
    usage_proxy_pools: BTreeMap<String, Vec<String>>,
    #[serde(default)]
    provider_pricing: BTreeMap<String, ProviderPricingOverride>,
    #[serde(default)]
    provider_quota_hard_cap: BTreeMap<String, ProviderQuotaHardCapOverride>,
    #[serde(default)]
    provider_shared_ids: BTreeMap<String, String>,
    #[serde(default)]
    lan_node_id: Option<String>,
    #[serde(default)]
    lan_node_name: Option<String>,
    #[serde(default)]
    lan_follow_source_node_id: Option<String>,
    #[serde(default)]
    lan_trust_secret: Option<String>,
    #[serde(default)]
    lan_trusted_node_ids: BTreeSet<String>,
    #[serde(default)]
    official_account_profiles: BTreeMap<String, OfficialAccountProfileSecret>,
    #[serde(default)]
    active_official_account_profile_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderPricingOverride {
    mode: String,
    amount_usd: f64,
    #[serde(default)]
    periods: Vec<ProviderPricingPeriod>,
    #[serde(default)]
    gap_fill_mode: Option<String>,
    #[serde(default)]
    gap_fill_amount_usd: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UsageLoginSecret {
    pub username: String,
    pub password: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OfficialAccountProfileSecret {
    pub label: String,
    pub auth_json: serde_json::Value,
    pub updated_at_unix_ms: u64,
    #[serde(default)]
    pub usage_updated_at_unix_ms: Option<u64>,
    #[serde(default)]
    pub limit_5h_remaining: Option<String>,
    #[serde(default)]
    pub limit_5h_reset_at: Option<String>,
    #[serde(default)]
    pub limit_weekly_remaining: Option<String>,
    #[serde(default)]
    pub limit_weekly_reset_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OfficialAccountProfileSummary {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub plan_label: Option<String>,
    pub updated_at_unix_ms: u64,
    #[serde(default)]
    pub usage_updated_at_unix_ms: Option<u64>,
    pub active: bool,
    #[serde(default)]
    pub limit_5h_remaining: Option<String>,
    #[serde(default)]
    pub limit_5h_reset_at: Option<String>,
    #[serde(default)]
    pub limit_weekly_remaining: Option<String>,
    #[serde(default)]
    pub limit_weekly_reset_at: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct OfficialAccountUsageSnapshot {
    pub limit_5h_remaining: Option<String>,
    pub limit_5h_reset_at: Option<String>,
    pub limit_weekly_remaining: Option<String>,
    pub limit_weekly_reset_at: Option<String>,
}

#[derive(Debug, Clone)]
pub struct OfficialAccountProfileAuthEntry {
    pub id: String,
    pub auth_json: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OfficialAccountProfileSyncItem {
    pub id: String,
    #[serde(default)]
    pub identity_key: Option<String>,
    pub summary: OfficialAccountProfileSummary,
    pub auth_json: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ProviderStateBundle {
    pub providers: BTreeMap<String, String>,
    pub provider_key_storage_modes: BTreeMap<String, String>,
    pub provider_account_emails: BTreeMap<String, String>,
    pub usage_tokens: BTreeMap<String, String>,
    pub usage_logins: BTreeMap<String, UsageLoginSecret>,
    pub usage_proxy_pools: BTreeMap<String, Vec<String>>,
    pub provider_pricing: BTreeMap<String, ProviderPricingOverride>,
    pub provider_quota_hard_cap: BTreeMap<String, ProviderQuotaHardCapOverride>,
    pub provider_shared_ids: BTreeMap<String, String>,
}

impl ProviderStateBundle {
    pub fn find_provider_name_by_shared_id(&self, shared_id: &str) -> Option<String> {
        let normalized = shared_id.trim();
        if normalized.is_empty() {
            return None;
        }
        self.provider_shared_ids
            .iter()
            .find_map(|(provider, value)| (value == normalized).then(|| provider.clone()))
    }

    pub fn set_provider_quota_hard_cap(
        &mut self,
        provider: &str,
        hard_cap: ProviderQuotaHardCapConfig,
    ) {
        if hard_cap == ProviderQuotaHardCapConfig::default() {
            self.provider_quota_hard_cap.remove(provider);
        } else {
            self.provider_quota_hard_cap.insert(
                provider.to_string(),
                ProviderQuotaHardCapOverride {
                    daily: hard_cap.daily,
                    weekly: hard_cap.weekly,
                    monthly: hard_cap.monthly,
                },
            );
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UsageLoginConfig {
    pub username: String,
    pub password: String,
}

fn default_hard_cap_enabled() -> bool {
    true
}

fn unix_ms_now() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};

    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn next_official_account_label(
    profiles: &BTreeMap<String, OfficialAccountProfileSecret>,
    preferred_label: Option<&str>,
) -> String {
    let preferred = preferred_label
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    if let Some(label) = preferred {
        return label;
    }
    let mut next_index = 1usize;
    loop {
        let candidate = format!("Official account {next_index}");
        let used = profiles.values().any(|profile| {
            profile
                .label
                .trim()
                .eq_ignore_ascii_case(candidate.as_str())
        });
        if !used {
            return candidate;
        }
        next_index += 1;
    }
}

fn official_account_sort_key(label: &str) -> (u64, String) {
    let trimmed = label.trim();
    let lower = trimmed.to_ascii_lowercase();
    if let Some(rest) = lower.strip_prefix("official account ") {
        if let Ok(index) = rest.trim().parse::<u64>() {
            return (index, trimmed.to_string());
        }
    }
    (u64::MAX, trimmed.to_string())
}

fn official_account_group_key(auth_json: &serde_json::Value) -> Option<String> {
    official_account_identity_key(auth_json).or_else(|| {
        serde_json::to_string(auth_json)
            .ok()
            .map(|text| format!("raw:{text}"))
    })
}

fn official_account_profile_has_usage(profile: &OfficialAccountProfileSecret) -> bool {
    profile.limit_5h_remaining.is_some()
        || profile.limit_5h_reset_at.is_some()
        || profile.limit_weekly_remaining.is_some()
        || profile.limit_weekly_reset_at.is_some()
}

fn merge_official_account_profiles(data: &mut SecretsFile) -> bool {
    if data.official_account_profiles.len() <= 1 {
        return false;
    }

    let mut groups: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for (id, profile) in data.official_account_profiles.iter() {
        let key = official_account_group_key(&profile.auth_json)
            .unwrap_or_else(|| format!("profile:{id}"));
        groups.entry(key).or_default().push(id.clone());
    }

    let mut changed = false;
    let mut new_active_id = data.active_official_account_profile_id.clone();
    let active_before = data.active_official_account_profile_id.clone();

    for ids in groups.values() {
        if ids.len() <= 1 {
            continue;
        }

        changed = true;
        let mut canonical_id = ids[0].clone();
        for id in ids.iter().skip(1) {
            let Some(left) = data.official_account_profiles.get(&canonical_id) else {
                continue;
            };
            let Some(right) = data.official_account_profiles.get(id) else {
                continue;
            };
            let left_key = official_account_sort_key(&left.label);
            let right_key = official_account_sort_key(&right.label);
            if right_key < left_key || (right_key == left_key && id < &canonical_id) {
                canonical_id = id.clone();
            }
        }

        let mut source_id = active_before
            .as_ref()
            .filter(|active| ids.iter().any(|id| id == *active))
            .cloned()
            .unwrap_or_else(|| {
                ids.iter()
                    .max_by_key(|id| {
                        data.official_account_profiles
                            .get(*id)
                            .map(|profile| profile.updated_at_unix_ms)
                            .unwrap_or(0)
                    })
                    .cloned()
                    .unwrap_or_else(|| canonical_id.clone())
            });

        if let (Some(source_profile), Some(canonical_profile)) = (
            data.official_account_profiles.get(&source_id),
            data.official_account_profiles.get(&canonical_id),
        ) {
            if !official_account_profile_has_usage(source_profile)
                && official_account_profile_has_usage(canonical_profile)
            {
                source_id = canonical_id.clone();
            }
        }

        let canonical_label = data
            .official_account_profiles
            .get(&canonical_id)
            .map(|profile| profile.label.clone())
            .unwrap_or_else(|| canonical_id.clone());
        let source_profile = match data.official_account_profiles.get(&source_id).cloned() {
            Some(profile) => profile,
            None => continue,
        };
        if let Some(canonical_profile) = data.official_account_profiles.get_mut(&canonical_id) {
            canonical_profile.label = canonical_label;
            canonical_profile.auth_json = source_profile.auth_json;
            canonical_profile.updated_at_unix_ms = source_profile.updated_at_unix_ms;
            canonical_profile.limit_5h_remaining = source_profile.limit_5h_remaining;
            canonical_profile.limit_5h_reset_at = source_profile.limit_5h_reset_at;
            canonical_profile.limit_weekly_remaining = source_profile.limit_weekly_remaining;
            canonical_profile.limit_weekly_reset_at = source_profile.limit_weekly_reset_at;
        }

        for id in ids {
            if *id == canonical_id {
                continue;
            }
            data.official_account_profiles.remove(id);
            if active_before.as_deref() == Some(id.as_str()) {
                new_active_id = Some(canonical_id.clone());
            }
        }
    }

    if changed {
        data.active_official_account_profile_id = new_active_id
            .filter(|id| data.official_account_profiles.contains_key(id))
            .or_else(|| data.official_account_profiles.keys().next().cloned());
    }

    changed
}

pub(crate) fn official_account_identity_key(auth_json: &serde_json::Value) -> Option<String> {
    let tokens = auth_json.get("tokens")?;
    let account_id = tokens
        .get("account_id")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| format!("account_id:{value}"));
    if account_id.is_some() {
        return account_id;
    }

    let id_token = tokens
        .get("id_token")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    let payload_b64 = id_token.split('.').nth(1)?;
    let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload_b64.as_bytes())
        .ok()?;
    let payload: serde_json::Value = serde_json::from_slice(&decoded).ok()?;

    payload
        .get("email")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| format!("email:{value}"))
        .or_else(|| {
            payload
                .get("sub")
                .and_then(|value| value.as_str())
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(|value| format!("sub:{value}"))
        })
}

fn official_account_id_token_payload(auth_json: &serde_json::Value) -> Option<serde_json::Value> {
    let id_token = auth_json
        .get("tokens")?
        .get("id_token")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    let payload_b64 = id_token.split('.').nth(1)?;
    let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload_b64.as_bytes())
        .ok()?;
    serde_json::from_slice(&decoded).ok()
}

fn official_account_email(auth_json: &serde_json::Value) -> Option<String> {
    official_account_id_token_payload(auth_json)?
        .get("email")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string())
}

fn official_account_plan_label(auth_json: &serde_json::Value) -> Option<String> {
    let payload = official_account_id_token_payload(auth_json)?;
    let raw = payload
        .get("chatgpt_plan_type")
        .and_then(|value| value.as_str())
        .or_else(|| {
            payload
                .get("https://api.openai.com/auth")
                .and_then(|value| value.get("chatgpt_plan_type"))
                .and_then(|value| value.as_str())
        })
        .map(str::trim)
        .filter(|value| !value.is_empty())?
        .to_ascii_lowercase();
    Some(match raw.as_str() {
        "plus" => "Plus".to_string(),
        "pro" => "Pro".to_string(),
        "prolite" => "Pro Lite".to_string(),
        "free" => "Free".to_string(),
        other => {
            let mut normalized = String::new();
            let mut upper = true;
            for ch in other.chars() {
                if ch == '_' || ch == '-' {
                    normalized.push(' ');
                    upper = true;
                    continue;
                }
                if upper {
                    normalized.extend(ch.to_uppercase());
                    upper = false;
                } else {
                    normalized.push(ch);
                }
            }
            normalized
        }
    })
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct ProviderQuotaHardCapOverride {
    #[serde(default = "default_hard_cap_enabled")]
    daily: bool,
    #[serde(default = "default_hard_cap_enabled")]
    weekly: bool,
    #[serde(default = "default_hard_cap_enabled")]
    monthly: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProviderQuotaHardCapConfig {
    pub daily: bool,
    pub weekly: bool,
    pub monthly: bool,
}

impl Default for ProviderQuotaHardCapConfig {
    fn default() -> Self {
        Self {
            daily: true,
            weekly: true,
            monthly: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProviderPricingPeriod {
    pub id: String,
    pub mode: String,
    pub amount_usd: f64,
    #[serde(default)]
    pub api_key_ref: String,
    pub started_at_unix_ms: u64,
    #[serde(default)]
    pub ended_at_unix_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProviderPricingConfig {
    pub mode: String,
    pub amount_usd: f64,
    pub periods: Vec<ProviderPricingPeriod>,
    pub gap_fill_mode: Option<String>,
    pub gap_fill_amount_usd: Option<f64>,
}

pub fn resolve_provider_pricing_config<'a>(
    pricing: &'a BTreeMap<String, ProviderPricingConfig>,
    provider_name: &str,
    api_key_ref: Option<&str>,
    at_unix_ms: u64,
) -> Option<&'a ProviderPricingConfig> {
    if let Some(cfg) = pricing.get(provider_name) {
        return Some(cfg);
    }
    let target_key_ref = api_key_ref
        .map(str::trim)
        .filter(|value| !value.is_empty() && *value != "-")?;
    let mut matched: Option<(&'a ProviderPricingConfig, u64)> = None;
    for cfg in pricing.values() {
        for period in &cfg.periods {
            if period.mode != "package_total" && period.mode != "per_request" {
                continue;
            }
            if !period.amount_usd.is_finite() || period.amount_usd <= 0.0 {
                continue;
            }
            let period_key_ref = period.api_key_ref.trim();
            if period_key_ref.is_empty()
                || period_key_ref == "-"
                || period_key_ref != target_key_ref
            {
                continue;
            }
            let ended = period.ended_at_unix_ms.unwrap_or(u64::MAX);
            if !(period.started_at_unix_ms <= at_unix_ms && at_unix_ms < ended) {
                continue;
            }
            let replace = matched
                .as_ref()
                .map(|(_, started_at)| period.started_at_unix_ms >= *started_at)
                .unwrap_or(true);
            if replace {
                matched = Some((cfg, period.started_at_unix_ms));
            }
        }
    }
    matched.map(|(cfg, _)| cfg)
}

pub fn pricing_per_request_amount_at(
    pricing_cfg: Option<&ProviderPricingConfig>,
    ts_unix_ms: u64,
) -> Option<f64> {
    let cfg = pricing_cfg?;
    let mut matched: Option<(f64, u64)> = None;
    for period in cfg.periods.iter() {
        if period.mode != "per_request"
            || !period.amount_usd.is_finite()
            || period.amount_usd <= 0.0
        {
            continue;
        }
        let ended = period.ended_at_unix_ms.unwrap_or(u64::MAX);
        if period.started_at_unix_ms <= ts_unix_ms && ts_unix_ms < ended {
            let replace = matched
                .as_ref()
                .map(|(_, started)| period.started_at_unix_ms >= *started)
                .unwrap_or(true);
            if replace {
                matched = Some((period.amount_usd, period.started_at_unix_ms));
            }
        }
    }
    if let Some((amount, _)) = matched {
        return Some(amount);
    }
    if cfg.mode == "per_request" && cfg.amount_usd.is_finite() && cfg.amount_usd > 0.0 {
        return Some(cfg.amount_usd);
    }
    None
}

#[derive(Clone)]
pub struct SecretStore {
    path: PathBuf,
    inner: Arc<Mutex<SecretsFile>>,
}

const GATEWAY_TOKEN_KEY: &str = "__gateway_token__";
const PROVIDER_KEY_STORAGE_AUTH_JSON: &str = "auth_json";
const PROVIDER_KEY_STORAGE_CONFIG_TOML_EXPERIMENTAL_BEARER_TOKEN: &str =
    "config_toml_experimental_bearer_token";

fn is_reserved_provider_state_key(key: &str) -> bool {
    key.trim() == GATEWAY_TOKEN_KEY
}

impl SecretStore {
    fn official_account_summary(
        id: &str,
        profile: &OfficialAccountProfileSecret,
        active_id: Option<&str>,
    ) -> OfficialAccountProfileSummary {
        OfficialAccountProfileSummary {
            id: id.to_string(),
            label: profile.label.clone(),
            email: official_account_email(&profile.auth_json),
            plan_label: official_account_plan_label(&profile.auth_json),
            updated_at_unix_ms: profile.updated_at_unix_ms,
            usage_updated_at_unix_ms: profile.usage_updated_at_unix_ms,
            active: active_id == Some(id),
            limit_5h_remaining: profile.limit_5h_remaining.clone(),
            limit_5h_reset_at: profile.limit_5h_reset_at.clone(),
            limit_weekly_remaining: profile.limit_weekly_remaining.clone(),
            limit_weekly_reset_at: profile.limit_weekly_reset_at.clone(),
        }
    }

    #[cfg(test)]
    pub fn path(&self) -> &std::path::Path {
        &self.path
    }

    fn apply_provider_quota_hard_cap(
        data: &mut SecretsFile,
        provider: &str,
        hard_cap: ProviderQuotaHardCapConfig,
    ) {
        if hard_cap == ProviderQuotaHardCapConfig::default() {
            data.provider_quota_hard_cap.remove(provider);
        } else {
            data.provider_quota_hard_cap.insert(
                provider.to_string(),
                ProviderQuotaHardCapOverride {
                    daily: hard_cap.daily,
                    weekly: hard_cap.weekly,
                    monthly: hard_cap.monthly,
                },
            );
        }
    }

    pub fn new(path: PathBuf) -> Self {
        let mut inner = Self::load_from_disk(&path).unwrap_or_default();
        let normalized = merge_official_account_profiles(&mut inner);
        let store = Self {
            path,
            inner: Arc::new(Mutex::new(inner)),
        };
        if normalized {
            let snapshot = store.inner.lock().clone();
            let _ = store.persist(&snapshot);
        }
        store
    }

    fn load_from_disk(path: &PathBuf) -> Option<SecretsFile> {
        let txt = std::fs::read_to_string(path).ok()?;
        serde_json::from_str(&txt).ok()
    }

    fn persist(&self, data: &SecretsFile) -> Result<(), String> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let txt = serde_json::to_string_pretty(data).map_err(|e| e.to_string())?;
        std::fs::write(&self.path, txt).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn get_provider_key(&self, provider: &str) -> Option<String> {
        self.inner.lock().providers.get(provider).cloned()
    }

    pub fn export_provider_state_bundle(&self) -> ProviderStateBundle {
        let data = self.inner.lock();
        ProviderStateBundle {
            providers: data
                .providers
                .iter()
                .filter(|(provider, _)| !is_reserved_provider_state_key(provider))
                .map(|(provider, value)| (provider.clone(), value.clone()))
                .collect(),
            provider_key_storage_modes: data.provider_key_storage_modes.clone(),
            provider_account_emails: data.provider_account_emails.clone(),
            usage_tokens: data.usage_tokens.clone(),
            usage_logins: data.usage_logins.clone(),
            usage_proxy_pools: data.usage_proxy_pools.clone(),
            provider_pricing: data.provider_pricing.clone(),
            provider_quota_hard_cap: data.provider_quota_hard_cap.clone(),
            provider_shared_ids: data.provider_shared_ids.clone(),
        }
    }

    pub fn replace_provider_state_bundle(&self, bundle: ProviderStateBundle) -> Result<(), String> {
        let mut data = self.inner.lock();
        let previous = data.clone();
        let reserved_provider_entries = data
            .providers
            .iter()
            .filter(|(provider, _)| is_reserved_provider_state_key(provider))
            .map(|(provider, value)| (provider.clone(), value.clone()))
            .collect::<BTreeMap<_, _>>();
        data.providers = bundle.providers;
        for (provider, value) in reserved_provider_entries {
            data.providers.insert(provider, value);
        }
        data.provider_key_storage_modes = bundle.provider_key_storage_modes;
        data.provider_account_emails = bundle.provider_account_emails;
        data.usage_tokens = bundle.usage_tokens;
        data.usage_logins = bundle.usage_logins;
        data.usage_proxy_pools = bundle.usage_proxy_pools;
        data.provider_pricing = bundle.provider_pricing;
        data.provider_quota_hard_cap = bundle.provider_quota_hard_cap;
        data.provider_shared_ids = bundle.provider_shared_ids;
        if let Err(err) = self.persist(&data) {
            *data = previous;
            return Err(err);
        }
        Ok(())
    }

    pub fn get_provider_key_storage_mode(&self, provider: &str) -> String {
        self.inner
            .lock()
            .provider_key_storage_modes
            .get(provider)
            .map(|value| value.trim().to_ascii_lowercase())
            .filter(|value| {
                value == PROVIDER_KEY_STORAGE_AUTH_JSON
                    || value == PROVIDER_KEY_STORAGE_CONFIG_TOML_EXPERIMENTAL_BEARER_TOKEN
            })
            .unwrap_or_else(|| PROVIDER_KEY_STORAGE_AUTH_JSON.to_string())
    }

    pub fn get_provider_account_email(&self, provider: &str) -> Option<String> {
        self.inner
            .lock()
            .provider_account_emails
            .get(provider)
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    }

    pub fn set_provider_account_email(&self, provider: &str, email: &str) -> Result<(), String> {
        let normalized = email.trim().to_string();
        let mut data = self.inner.lock();
        if normalized.is_empty() {
            data.provider_account_emails.remove(provider);
        } else {
            data.provider_account_emails
                .insert(provider.to_string(), normalized);
        }
        self.persist(&data)
    }

    pub fn clear_provider_account_email(&self, provider: &str) -> Result<(), String> {
        let mut data = self.inner.lock();
        data.provider_account_emails.remove(provider);
        self.persist(&data)
    }

    pub fn set_provider_key(&self, provider: &str, key: &str) -> Result<(), String> {
        self.set_provider_key_with_storage_mode(provider, key, None)
    }

    pub fn set_provider_key_with_storage_mode(
        &self,
        provider: &str,
        key: &str,
        storage_mode: Option<&str>,
    ) -> Result<(), String> {
        let mut data = self.inner.lock();
        data.providers.insert(provider.to_string(), key.to_string());
        let normalized_storage = storage_mode
            .map(|value| value.trim().to_ascii_lowercase())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| PROVIDER_KEY_STORAGE_AUTH_JSON.to_string());
        if normalized_storage == PROVIDER_KEY_STORAGE_AUTH_JSON {
            data.provider_key_storage_modes.remove(provider);
        } else {
            data.provider_key_storage_modes
                .insert(provider.to_string(), normalized_storage);
        }
        self.persist(&data)
    }

    pub fn clear_provider_key(&self, provider: &str) -> Result<(), String> {
        let mut data = self.inner.lock();
        data.providers.remove(provider);
        data.provider_key_storage_modes.remove(provider);
        self.persist(&data)
    }

    pub fn get_usage_token(&self, provider: &str) -> Option<String> {
        self.inner.lock().usage_tokens.get(provider).cloned()
    }

    pub fn set_usage_token(&self, provider: &str, token: &str) -> Result<(), String> {
        let mut data = self.inner.lock();
        data.usage_tokens
            .insert(provider.to_string(), token.to_string());
        self.persist(&data)
    }

    pub fn clear_usage_token(&self, provider: &str) -> Result<(), String> {
        let mut data = self.inner.lock();
        data.usage_tokens.remove(provider);
        self.persist(&data)
    }

    pub fn get_usage_login(&self, provider: &str) -> Option<UsageLoginConfig> {
        self.inner
            .lock()
            .usage_logins
            .get(provider)
            .map(|entry| UsageLoginConfig {
                username: entry.username.clone(),
                password: entry.password.clone(),
            })
            .filter(|entry| !entry.username.trim().is_empty() && !entry.password.is_empty())
    }

    pub fn set_usage_login(
        &self,
        provider: &str,
        username: &str,
        password: &str,
    ) -> Result<(), String> {
        let normalized_username = username.trim().to_string();
        let normalized_password = password.to_string();
        let mut data = self.inner.lock();
        if normalized_username.is_empty() || normalized_password.is_empty() {
            data.usage_logins.remove(provider);
        } else {
            data.usage_logins.insert(
                provider.to_string(),
                UsageLoginSecret {
                    username: normalized_username,
                    password: normalized_password,
                },
            );
        }
        self.persist(&data)
    }

    pub fn clear_usage_login(&self, provider: &str) -> Result<(), String> {
        let mut data = self.inner.lock();
        data.usage_logins.remove(provider);
        self.persist(&data)
    }

    pub fn list_official_account_profiles(&self) -> Vec<OfficialAccountProfileSummary> {
        let mut data = self.inner.lock();
        if merge_official_account_profiles(&mut data) {
            let _ = self.persist(&data);
        }
        let active_id = data.active_official_account_profile_id.clone();
        let mut profiles = data
            .official_account_profiles
            .iter()
            .map(|(id, profile)| Self::official_account_summary(id, profile, active_id.as_deref()))
            .collect::<Vec<_>>();
        profiles.sort_by(|left, right| {
            official_account_sort_key(&left.label)
                .cmp(&official_account_sort_key(&right.label))
                .then_with(|| left.label.cmp(&right.label))
        });
        profiles
    }

    pub fn list_official_account_profile_auth_entries(
        &self,
    ) -> Vec<OfficialAccountProfileAuthEntry> {
        let mut data = self.inner.lock();
        if merge_official_account_profiles(&mut data) {
            let _ = self.persist(&data);
        }
        let mut entries = data
            .official_account_profiles
            .iter()
            .map(|(id, profile)| OfficialAccountProfileAuthEntry {
                id: id.clone(),
                auth_json: profile.auth_json.clone(),
            })
            .collect::<Vec<_>>();
        entries.sort_by(|left, right| left.id.cmp(&right.id));
        entries
    }

    pub fn export_official_account_sync_items(&self) -> Vec<OfficialAccountProfileSyncItem> {
        let mut data = self.inner.lock();
        if merge_official_account_profiles(&mut data) {
            let _ = self.persist(&data);
        }
        let active_id = data.active_official_account_profile_id.clone();
        let mut items = data
            .official_account_profiles
            .iter()
            .map(|(id, profile)| OfficialAccountProfileSyncItem {
                id: id.clone(),
                identity_key: official_account_identity_key(&profile.auth_json),
                summary: Self::official_account_summary(id, profile, active_id.as_deref()),
                auth_json: profile.auth_json.clone(),
            })
            .collect::<Vec<_>>();
        items.sort_by(|left, right| {
            official_account_sort_key(&left.summary.label)
                .cmp(&official_account_sort_key(&right.summary.label))
                .then_with(|| left.summary.label.cmp(&right.summary.label))
        });
        items
    }

    pub fn import_official_account_sync_item(
        &self,
        item: &OfficialAccountProfileSyncItem,
    ) -> Result<OfficialAccountProfileSummary, String> {
        let usage = OfficialAccountUsageSnapshot {
            limit_5h_remaining: item.summary.limit_5h_remaining.clone(),
            limit_5h_reset_at: item.summary.limit_5h_reset_at.clone(),
            limit_weekly_remaining: item.summary.limit_weekly_remaining.clone(),
            limit_weekly_reset_at: item.summary.limit_weekly_reset_at.clone(),
        };
        let imported = self.capture_official_account_profile(
            &item.auth_json,
            Some(&item.summary.label),
            Some(&usage),
        )?;
        self.select_official_account_profile(&imported.id)
    }

    pub fn update_official_account_profile_usage_and_auth(
        &self,
        profile_id: &str,
        usage: &OfficialAccountUsageSnapshot,
        auth_json: Option<&serde_json::Value>,
    ) -> Result<(), String> {
        let mut data = self.inner.lock();
        merge_official_account_profiles(&mut data);
        let profile = data
            .official_account_profiles
            .get_mut(profile_id)
            .ok_or_else(|| format!("official account profile not found: {profile_id}"))?;
        let now = unix_ms_now();
        if let Some(auth_json) = auth_json {
            if profile.auth_json != *auth_json {
                profile.auth_json = auth_json.clone();
                profile.updated_at_unix_ms = now;
            }
        }
        profile.usage_updated_at_unix_ms = Some(now);
        profile.limit_5h_remaining = usage.limit_5h_remaining.clone();
        profile.limit_5h_reset_at = usage.limit_5h_reset_at.clone();
        profile.limit_weekly_remaining = usage.limit_weekly_remaining.clone();
        profile.limit_weekly_reset_at = usage.limit_weekly_reset_at.clone();
        self.persist(&data)
    }

    pub fn capture_official_account_profile(
        &self,
        auth_json: &serde_json::Value,
        preferred_label: Option<&str>,
        usage: Option<&OfficialAccountUsageSnapshot>,
    ) -> Result<OfficialAccountProfileSummary, String> {
        let mut data = self.inner.lock();
        merge_official_account_profiles(&mut data);
        let now = unix_ms_now();
        let incoming_identity = official_account_identity_key(auth_json);

        if let Some(active_id) = data.active_official_account_profile_id.clone() {
            let active_matches = data
                .official_account_profiles
                .get(&active_id)
                .map(|profile| {
                    official_account_identity_key(&profile.auth_json)
                        .zip(incoming_identity.clone())
                        .map(|(existing, incoming)| existing == incoming)
                        .unwrap_or(profile.auth_json == *auth_json)
                })
                .unwrap_or(false);
            if active_matches {
                let replacement_label = data
                    .official_account_profiles
                    .get(&active_id)
                    .map(|profile| profile.label.trim().is_empty())
                    .filter(|needs_label| *needs_label)
                    .map(|_| {
                        next_official_account_label(
                            &data.official_account_profiles,
                            preferred_label,
                        )
                    });
                {
                    let active_profile = data
                        .official_account_profiles
                        .get_mut(&active_id)
                        .expect("checked active official profile");
                    active_profile.updated_at_unix_ms = now;
                    if let Some(usage) = usage {
                        active_profile.usage_updated_at_unix_ms = Some(now);
                        active_profile.limit_5h_remaining = usage.limit_5h_remaining.clone();
                        active_profile.limit_5h_reset_at = usage.limit_5h_reset_at.clone();
                        active_profile.limit_weekly_remaining =
                            usage.limit_weekly_remaining.clone();
                        active_profile.limit_weekly_reset_at = usage.limit_weekly_reset_at.clone();
                    }
                    if let Some(label) = replacement_label {
                        active_profile.label = label;
                    }
                }
                self.persist(&data)?;
                let profile = data
                    .official_account_profiles
                    .get(&active_id)
                    .expect("persisted active official profile");
                return Ok(Self::official_account_summary(
                    &active_id,
                    profile,
                    Some(active_id.as_str()),
                ));
            }
        }

        if let Some(existing_id) = data
            .official_account_profiles
            .iter()
            .find(|(_, profile)| {
                official_account_identity_key(&profile.auth_json)
                    .zip(incoming_identity.clone())
                    .map(|(existing, incoming)| existing == incoming)
                    .unwrap_or(profile.auth_json == *auth_json)
            })
            .map(|(id, _)| id.clone())
        {
            let replacement_label = data
                .official_account_profiles
                .get(&existing_id)
                .map(|profile| profile.label.trim().is_empty())
                .filter(|needs_label| *needs_label)
                .map(|_| {
                    next_official_account_label(&data.official_account_profiles, preferred_label)
                });
            {
                let existing_profile = data
                    .official_account_profiles
                    .get_mut(&existing_id)
                    .expect("checked existing official profile");
                existing_profile.updated_at_unix_ms = now;
                if let Some(usage) = usage {
                    existing_profile.usage_updated_at_unix_ms = Some(now);
                    existing_profile.limit_5h_remaining = usage.limit_5h_remaining.clone();
                    existing_profile.limit_5h_reset_at = usage.limit_5h_reset_at.clone();
                    existing_profile.limit_weekly_remaining = usage.limit_weekly_remaining.clone();
                    existing_profile.limit_weekly_reset_at = usage.limit_weekly_reset_at.clone();
                }
                if let Some(label) = replacement_label {
                    existing_profile.label = label;
                }
            }
            if data.active_official_account_profile_id.is_none() {
                data.active_official_account_profile_id = Some(existing_id.clone());
            }
            self.persist(&data)?;
            let active_id = data.active_official_account_profile_id.clone();
            let profile = data
                .official_account_profiles
                .get(&existing_id)
                .expect("persisted existing official profile");
            return Ok(Self::official_account_summary(
                &existing_id,
                profile,
                active_id.as_deref(),
            ));
        }

        let id = format!("official_{}", Uuid::new_v4().simple());
        let label = next_official_account_label(&data.official_account_profiles, preferred_label);
        let profile = OfficialAccountProfileSecret {
            label: label.clone(),
            auth_json: auth_json.clone(),
            updated_at_unix_ms: now,
            usage_updated_at_unix_ms: usage.map(|_| now),
            limit_5h_remaining: usage.and_then(|value| value.limit_5h_remaining.clone()),
            limit_5h_reset_at: usage.and_then(|value| value.limit_5h_reset_at.clone()),
            limit_weekly_remaining: usage.and_then(|value| value.limit_weekly_remaining.clone()),
            limit_weekly_reset_at: usage.and_then(|value| value.limit_weekly_reset_at.clone()),
        };
        data.official_account_profiles.insert(id.clone(), profile);
        if data.active_official_account_profile_id.is_none() {
            data.active_official_account_profile_id = Some(id.clone());
        }
        self.persist(&data)?;
        let is_active = data.active_official_account_profile_id.as_deref() == Some(id.as_str());
        Ok(OfficialAccountProfileSummary {
            id,
            label,
            email: official_account_email(auth_json),
            plan_label: official_account_plan_label(auth_json),
            updated_at_unix_ms: now,
            usage_updated_at_unix_ms: usage.map(|_| now),
            active: is_active,
            limit_5h_remaining: usage.and_then(|value| value.limit_5h_remaining.clone()),
            limit_5h_reset_at: usage.and_then(|value| value.limit_5h_reset_at.clone()),
            limit_weekly_remaining: usage.and_then(|value| value.limit_weekly_remaining.clone()),
            limit_weekly_reset_at: usage.and_then(|value| value.limit_weekly_reset_at.clone()),
        })
    }

    pub fn select_official_account_profile(
        &self,
        profile_id: &str,
    ) -> Result<OfficialAccountProfileSummary, String> {
        let mut data = self.inner.lock();
        merge_official_account_profiles(&mut data);
        let id = profile_id.trim();
        if !data.official_account_profiles.contains_key(id) {
            return Err(format!("unknown official account profile: {id}"));
        }
        data.active_official_account_profile_id = Some(id.to_string());
        self.persist(&data)?;
        let profile = data
            .official_account_profiles
            .get(id.trim())
            .expect("persisted activated official profile");
        Ok(Self::official_account_summary(id, profile, Some(id)))
    }

    pub fn active_official_account_profile_auth_json(&self) -> Option<serde_json::Value> {
        let mut data = self.inner.lock();
        if merge_official_account_profiles(&mut data) {
            let _ = self.persist(&data);
        }
        let active_id = data.active_official_account_profile_id.as_deref()?;
        data.official_account_profiles
            .get(active_id)
            .map(|profile| profile.auth_json.clone())
    }

    pub fn official_account_profile_auth_json(
        &self,
        profile_id: &str,
    ) -> Result<serde_json::Value, String> {
        let mut data = self.inner.lock();
        if merge_official_account_profiles(&mut data) {
            let _ = self.persist(&data);
        }
        let id = profile_id.trim();
        data.official_account_profiles
            .get(id)
            .map(|profile| profile.auth_json.clone())
            .ok_or_else(|| format!("unknown official account profile: {id}"))
    }

    pub fn remove_official_account_profile(&self, profile_id: &str) -> Result<(), String> {
        let mut data = self.inner.lock();
        merge_official_account_profiles(&mut data);
        let id = profile_id.trim();
        data.official_account_profiles.remove(id);
        if data.active_official_account_profile_id.as_deref() == Some(id) {
            data.active_official_account_profile_id = data
                .official_account_profiles
                .iter()
                .max_by_key(|(_, profile)| profile.updated_at_unix_ms)
                .map(|(next_id, _)| next_id.clone());
        }
        self.persist(&data)
    }

    pub fn get_usage_proxy_pool(&self, provider: &str) -> Vec<String> {
        self.inner
            .lock()
            .usage_proxy_pools
            .get(provider)
            .cloned()
            .unwrap_or_default()
    }

    pub fn set_usage_proxy_pool(&self, provider: &str, pool: Vec<String>) -> Result<(), String> {
        let mut data = self.inner.lock();
        let normalized: Vec<String> = pool
            .into_iter()
            .map(|entry| entry.trim().to_string())
            .filter(|entry| !entry.is_empty())
            .collect();
        if normalized.is_empty() {
            data.usage_proxy_pools.remove(provider);
        } else {
            data.usage_proxy_pools
                .insert(provider.to_string(), normalized);
        }
        self.persist(&data)
    }

    pub fn get_provider_shared_id(&self, provider: &str) -> Option<String> {
        self.inner.lock().provider_shared_ids.get(provider).cloned()
    }

    pub fn ensure_provider_shared_id(&self, provider: &str) -> Result<String, String> {
        let normalized = provider.trim();
        if normalized.is_empty() {
            return Err("provider is required".to_string());
        }
        let mut data = self.inner.lock();
        let shared_id = data
            .provider_shared_ids
            .get(normalized)
            .cloned()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| format!("sp_{}", Uuid::new_v4().simple()));
        let changed = data.provider_shared_ids.get(normalized) != Some(&shared_id);
        data.provider_shared_ids
            .insert(normalized.to_string(), shared_id.clone());
        if changed {
            self.persist(&data)?;
        }
        Ok(shared_id)
    }

    pub fn set_provider_shared_id(&self, provider: &str, shared_id: &str) -> Result<(), String> {
        let normalized_provider = provider.trim();
        let normalized_shared_id = shared_id.trim();
        if normalized_provider.is_empty() {
            return Err("provider is required".to_string());
        }
        if normalized_shared_id.is_empty() {
            return Err("shared_id is required".to_string());
        }
        let mut data = self.inner.lock();
        data.provider_shared_ids.insert(
            normalized_provider.to_string(),
            normalized_shared_id.to_string(),
        );
        self.persist(&data)
    }

    pub fn find_provider_by_shared_id(&self, shared_id: &str) -> Option<String> {
        let normalized = shared_id.trim();
        if normalized.is_empty() {
            return None;
        }
        self.inner
            .lock()
            .provider_shared_ids
            .iter()
            .find_map(|(provider, value)| (value == normalized).then(|| provider.clone()))
    }

    pub fn rename_provider(&self, old: &str, new: &str) -> Result<(), String> {
        if old == new {
            return Ok(());
        }
        let mut data = self.inner.lock();
        if let Some(v) = data.providers.remove(old) {
            data.providers.insert(new.to_string(), v);
        }
        if let Some(v) = data.provider_key_storage_modes.remove(old) {
            data.provider_key_storage_modes.insert(new.to_string(), v);
        }
        if let Some(v) = data.provider_account_emails.remove(old) {
            data.provider_account_emails.insert(new.to_string(), v);
        }
        if let Some(v) = data.usage_tokens.remove(old) {
            data.usage_tokens.insert(new.to_string(), v);
        }
        if let Some(v) = data.usage_logins.remove(old) {
            data.usage_logins.insert(new.to_string(), v);
        }
        if let Some(v) = data.usage_proxy_pools.remove(old) {
            data.usage_proxy_pools.insert(new.to_string(), v);
        }
        if let Some(v) = data.provider_pricing.remove(old) {
            data.provider_pricing.insert(new.to_string(), v);
        }
        if let Some(v) = data.provider_quota_hard_cap.remove(old) {
            data.provider_quota_hard_cap.insert(new.to_string(), v);
        }
        if let Some(v) = data.provider_shared_ids.remove(old) {
            data.provider_shared_ids.insert(new.to_string(), v);
        }
        self.persist(&data)
    }

    pub fn get_provider_quota_hard_cap(&self, provider: &str) -> ProviderQuotaHardCapConfig {
        let data = self.inner.lock();
        data.provider_quota_hard_cap
            .get(provider)
            .map(|v| ProviderQuotaHardCapConfig {
                daily: v.daily,
                weekly: v.weekly,
                monthly: v.monthly,
            })
            .unwrap_or_default()
    }

    pub fn list_provider_quota_hard_cap(&self) -> BTreeMap<String, ProviderQuotaHardCapConfig> {
        let data = self.inner.lock();
        data.provider_quota_hard_cap
            .iter()
            .map(|(provider, value)| {
                (
                    provider.clone(),
                    ProviderQuotaHardCapConfig {
                        daily: value.daily,
                        weekly: value.weekly,
                        monthly: value.monthly,
                    },
                )
            })
            .collect()
    }

    pub fn set_provider_quota_hard_cap(
        &self,
        provider: &str,
        hard_cap: ProviderQuotaHardCapConfig,
    ) -> Result<(), String> {
        let mut data = self.inner.lock();
        let mut next = data.clone();
        // Canonical storage invariant: all-true means "no override", so we
        // remove the row and let readers fall back to ProviderQuotaHardCapConfig::default().
        Self::apply_provider_quota_hard_cap(&mut next, provider, hard_cap);
        self.persist(&next)?;
        *data = next;
        Ok(())
    }

    pub fn set_provider_quota_hard_cap_field(
        &self,
        provider: &str,
        field: &str,
        enabled: bool,
    ) -> Result<ProviderQuotaHardCapConfig, String> {
        let mut data = self.inner.lock();
        let mut next = data.clone();
        let mut hard_cap = next
            .provider_quota_hard_cap
            .get(provider)
            .map(|v| ProviderQuotaHardCapConfig {
                daily: v.daily,
                weekly: v.weekly,
                monthly: v.monthly,
            })
            .unwrap_or_default();
        match field {
            "daily" => hard_cap.daily = enabled,
            "weekly" => hard_cap.weekly = enabled,
            "monthly" => hard_cap.monthly = enabled,
            _ => return Err("field must be one of: daily, weekly, monthly".to_string()),
        }
        Self::apply_provider_quota_hard_cap(&mut next, provider, hard_cap);
        self.persist(&next)?;
        *data = next;
        Ok(hard_cap)
    }

    pub fn list_provider_pricing(&self) -> BTreeMap<String, ProviderPricingConfig> {
        let data = self.inner.lock();
        data.provider_pricing
            .iter()
            .map(|(k, v)| {
                (
                    k.clone(),
                    ProviderPricingConfig {
                        mode: v.mode.clone(),
                        amount_usd: v.amount_usd,
                        periods: v.periods.clone(),
                        gap_fill_mode: v.gap_fill_mode.clone(),
                        gap_fill_amount_usd: v.gap_fill_amount_usd,
                    },
                )
            })
            .collect()
    }

    pub fn set_provider_pricing(
        &self,
        provider: &str,
        mode: &str,
        amount_usd: f64,
        package_expires_at_unix_ms: Option<u64>,
        api_key_ref: Option<String>,
    ) -> Result<(), String> {
        let mut data = self.inner.lock();
        let existing_gap_mode = data
            .provider_pricing
            .get(provider)
            .and_then(|v| v.gap_fill_mode.clone());
        let existing_gap_amount = data
            .provider_pricing
            .get(provider)
            .and_then(|v| v.gap_fill_amount_usd);
        let normalized_mode = mode.trim().to_lowercase();
        let now = crate::orchestrator::store::unix_ms();
        let mut periods = data
            .provider_pricing
            .get(provider)
            .map(|v| v.periods.clone())
            .unwrap_or_default();

        for period in periods.iter_mut() {
            if period.ended_at_unix_ms.is_some() {
                continue;
            }
            if normalized_mode == "none" || period.mode == normalized_mode {
                period.ended_at_unix_ms = Some(now);
            }
        }

        if normalized_mode == "none" && amount_usd <= 0.0 {
            if existing_gap_mode.is_none() && existing_gap_amount.is_none() && periods.is_empty() {
                data.provider_pricing.remove(provider);
            } else {
                data.provider_pricing.insert(
                    provider.to_string(),
                    ProviderPricingOverride {
                        mode: "none".to_string(),
                        amount_usd: 0.0,
                        periods,
                        gap_fill_mode: existing_gap_mode,
                        gap_fill_amount_usd: existing_gap_amount,
                    },
                );
            }
            return self.persist(&data);
        }

        if normalized_mode == "package_total" || normalized_mode == "per_request" {
            let api_key_ref = api_key_ref
                .clone()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| "-".to_string());
            periods.push(ProviderPricingPeriod {
                id: Uuid::new_v4().to_string(),
                mode: normalized_mode.clone(),
                amount_usd,
                api_key_ref,
                started_at_unix_ms: now,
                ended_at_unix_ms: if normalized_mode == "package_total" {
                    package_expires_at_unix_ms
                } else {
                    None
                },
            });
        }

        data.provider_pricing.insert(
            provider.to_string(),
            ProviderPricingOverride {
                mode: normalized_mode,
                amount_usd,
                periods,
                gap_fill_mode: existing_gap_mode,
                gap_fill_amount_usd: existing_gap_amount,
            },
        );
        self.persist(&data)
    }

    pub fn list_provider_schedule(&self, provider: &str) -> Vec<ProviderPricingPeriod> {
        let data = self.inner.lock();
        let mut periods = data
            .provider_pricing
            .get(provider)
            .map(|entry| {
                entry
                    .periods
                    .iter()
                    .filter(|period| period.mode == "package_total")
                    .cloned()
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        periods.sort_by_key(|period| period.started_at_unix_ms);
        periods
    }

    pub fn list_provider_timeline(&self, provider: &str) -> Vec<ProviderPricingPeriod> {
        let data = self.inner.lock();
        let mut periods = data
            .provider_pricing
            .get(provider)
            .map(|entry| {
                entry
                    .periods
                    .iter()
                    .filter(|period| period.mode == "package_total" || period.mode == "per_request")
                    .cloned()
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        periods.sort_by_key(|period| period.started_at_unix_ms);
        periods
    }

    pub fn set_provider_schedule(
        &self,
        provider: &str,
        mut periods: Vec<ProviderPricingPeriod>,
    ) -> Result<(), String> {
        for period in periods.iter_mut() {
            period.mode = "package_total".to_string();
            if period.api_key_ref.trim().is_empty() {
                period.api_key_ref = "-".to_string();
            }
            if period.ended_at_unix_ms.is_none() {
                period.ended_at_unix_ms = Some(period.started_at_unix_ms.saturating_add(1));
            }
        }

        // Preserve existing per-request timeline rows when replacing package schedule rows.
        let existing_per_request: Vec<ProviderPricingPeriod> = {
            let data = self.inner.lock();
            data.provider_pricing
                .get(provider)
                .map(|entry| {
                    entry
                        .periods
                        .iter()
                        .filter(|period| period.mode == "per_request")
                        .cloned()
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default()
        };
        periods.extend(existing_per_request);

        self.set_provider_timeline(provider, periods)
    }

    pub fn set_provider_timeline(
        &self,
        provider: &str,
        mut periods: Vec<ProviderPricingPeriod>,
    ) -> Result<(), String> {
        periods.sort_by_key(|period| period.started_at_unix_ms);
        for period in periods.iter_mut() {
            if period.id.trim().is_empty() {
                period.id = Uuid::new_v4().to_string();
            }
            period.mode = period.mode.trim().to_ascii_lowercase();
            if period.api_key_ref.trim().is_empty() {
                period.api_key_ref = "-".to_string();
            }
        }

        let now = crate::orchestrator::store::unix_ms();
        let active = periods
            .iter()
            .filter(|period| {
                let starts = period.started_at_unix_ms <= now;
                let not_ended = match period.ended_at_unix_ms {
                    Some(end) => now < end,
                    None => true,
                };
                starts && not_ended
            })
            .max_by_key(|period| period.started_at_unix_ms);
        let upcoming = periods
            .iter()
            .filter(|period| period.started_at_unix_ms > now)
            .min_by_key(|period| period.started_at_unix_ms);
        let next_mode = active
            .map(|period| period.mode.clone())
            .or_else(|| upcoming.map(|period| period.mode.clone()))
            .unwrap_or_else(|| "none".to_string());
        let next_amount = active
            .map(|period| period.amount_usd)
            .or_else(|| upcoming.map(|period| period.amount_usd))
            .unwrap_or(0.0);

        let mut data = self.inner.lock();
        let existing_gap_mode = data
            .provider_pricing
            .get(provider)
            .and_then(|v| v.gap_fill_mode.clone());
        let existing_gap_amount = data
            .provider_pricing
            .get(provider)
            .and_then(|v| v.gap_fill_amount_usd);

        if periods.is_empty() && existing_gap_mode.is_none() && existing_gap_amount.is_none() {
            data.provider_pricing.remove(provider);
            return self.persist(&data);
        }

        data.provider_pricing.insert(
            provider.to_string(),
            ProviderPricingOverride {
                mode: next_mode,
                amount_usd: next_amount,
                periods,
                gap_fill_mode: existing_gap_mode,
                gap_fill_amount_usd: existing_gap_amount,
            },
        );
        self.persist(&data)
    }

    pub fn set_provider_gap_fill(
        &self,
        provider: &str,
        mode: Option<&str>,
        amount_usd: Option<f64>,
    ) -> Result<(), String> {
        let mut data = self.inner.lock();
        let entry =
            data.provider_pricing
                .entry(provider.to_string())
                .or_insert(ProviderPricingOverride {
                    mode: "none".to_string(),
                    amount_usd: 0.0,
                    periods: Vec::new(),
                    gap_fill_mode: None,
                    gap_fill_amount_usd: None,
                });
        entry.gap_fill_mode = mode.map(|s| s.to_string());
        entry.gap_fill_amount_usd = amount_usd;

        // Keep storage clean: if no base pricing and no gap config, remove row.
        let remove = entry.mode == "none"
            && entry.amount_usd <= 0.0
            && entry.periods.is_empty()
            && entry.gap_fill_mode.is_none()
            && entry.gap_fill_amount_usd.is_none();
        if remove {
            data.provider_pricing.remove(provider);
        }
        self.persist(&data)
    }

    pub fn delete_provider(&self, provider: &str) -> Result<(), String> {
        let mut data = self.inner.lock();
        data.providers.remove(provider);
        data.provider_key_storage_modes.remove(provider);
        data.provider_account_emails.remove(provider);
        data.usage_tokens.remove(provider);
        data.usage_logins.remove(provider);
        data.usage_proxy_pools.remove(provider);
        data.provider_pricing.remove(provider);
        data.provider_quota_hard_cap.remove(provider);
        data.provider_shared_ids.remove(provider);
        self.persist(&data)
    }

    pub fn get_gateway_token(&self) -> Option<String> {
        self.inner.lock().providers.get(GATEWAY_TOKEN_KEY).cloned()
    }

    pub fn ensure_gateway_token(&self) -> Result<String, String> {
        if let Some(t) = self.get_gateway_token() {
            return Ok(t);
        }
        let t = Self::new_gateway_token();
        self.set_gateway_token(&t)?;
        Ok(t)
    }

    pub fn set_gateway_token(&self, token: &str) -> Result<(), String> {
        let mut data = self.inner.lock();
        data.providers
            .insert(GATEWAY_TOKEN_KEY.to_string(), token.to_string());
        self.persist(&data)
    }

    pub fn ensure_lan_node_identity(
        &self,
        default_node_name: &str,
    ) -> Result<crate::lan_sync::LanNodeIdentity, String> {
        let mut data = self.inner.lock();
        let node_id = data
            .lan_node_id
            .clone()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| format!("node_{}", Uuid::new_v4().simple()));
        let node_name = crate::lan_sync::sanitize_node_name(
            data.lan_node_name
                .as_deref()
                .filter(|value| !value.trim().is_empty())
                .unwrap_or(default_node_name),
        );
        let changed = data.lan_node_id.as_deref() != Some(node_id.as_str())
            || data.lan_node_name.as_deref() != Some(node_name.as_str());
        data.lan_node_id = Some(node_id.clone());
        data.lan_node_name = Some(node_name.clone());
        if changed {
            self.persist(&data)?;
        }
        Ok(crate::lan_sync::LanNodeIdentity { node_id, node_name })
    }

    pub fn get_lan_trust_secret(&self) -> Option<String> {
        self.inner
            .lock()
            .lan_trust_secret
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToString::to_string)
    }

    pub fn ensure_lan_trust_secret(&self) -> Result<String, String> {
        let mut data = self.inner.lock();
        let trust_secret = data
            .lan_trust_secret
            .clone()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| format!("lan_{}", Uuid::new_v4().simple()));
        let changed = data.lan_trust_secret.as_deref() != Some(trust_secret.as_str());
        data.lan_trust_secret = Some(trust_secret.clone());
        if changed {
            self.persist(&data)?;
        }
        Ok(trust_secret)
    }

    pub fn set_lan_trust_secret(&self, trust_secret: &str) -> Result<(), String> {
        let normalized = trust_secret.trim();
        if normalized.is_empty() {
            return Err("lan trust secret is required".to_string());
        }
        let mut data = self.inner.lock();
        data.lan_trust_secret = Some(normalized.to_string());
        self.persist(&data)
    }

    pub fn get_lan_node_identity(&self) -> Option<crate::lan_sync::LanNodeIdentity> {
        let data = self.inner.lock();
        let node_id = data
            .lan_node_id
            .clone()
            .filter(|value| !value.trim().is_empty())?;
        let node_name = data
            .lan_node_name
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .map(crate::lan_sync::sanitize_node_name)
            .unwrap_or_else(|| "api-router-node".to_string());
        Some(crate::lan_sync::LanNodeIdentity { node_id, node_name })
    }

    pub fn is_lan_node_trusted(&self, node_id: &str) -> bool {
        let normalized = node_id.trim();
        !normalized.is_empty() && self.inner.lock().lan_trusted_node_ids.contains(normalized)
    }

    pub fn trusted_lan_node_ids(&self) -> BTreeSet<String> {
        self.inner.lock().lan_trusted_node_ids.clone()
    }

    pub fn set_lan_node_trusted(&self, node_id: &str, trusted: bool) -> Result<bool, String> {
        let normalized = node_id.trim();
        if normalized.is_empty() {
            return Ok(false);
        }
        let mut data = self.inner.lock();
        let changed = if trusted {
            data.lan_trusted_node_ids.insert(normalized.to_string())
        } else {
            data.lan_trusted_node_ids.remove(normalized)
        };
        if changed {
            self.persist(&data)?;
        }
        Ok(changed)
    }

    pub fn get_followed_config_source_node_id(&self) -> Option<String> {
        self.inner
            .lock()
            .lan_follow_source_node_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToString::to_string)
    }

    pub fn set_followed_config_source_node_id(&self, node_id: Option<&str>) -> Result<(), String> {
        let normalized = node_id
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToString::to_string);
        let mut data = self.inner.lock();
        data.lan_follow_source_node_id = normalized;
        self.persist(&data)
    }

    pub fn rotate_gateway_token(&self) -> Result<String, String> {
        let t = Self::new_gateway_token();
        self.set_gateway_token(&t)?;
        Ok(t)
    }

    fn new_gateway_token() -> String {
        format!("ao_{}", Uuid::new_v4().simple())
    }
}

#[cfg(test)]
mod tests {
    use super::{
        pricing_per_request_amount_at, resolve_provider_pricing_config,
        OfficialAccountUsageSnapshot, ProviderPricingConfig, ProviderPricingPeriod,
        ProviderQuotaHardCapConfig, ProviderStateBundle, SecretStore, UsageLoginConfig,
    };
    use std::collections::BTreeMap;
    use std::sync::{Arc, Barrier};

    #[test]
    fn provider_shared_id_persists_across_reload_and_rename() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let path = tmp.path().join("secrets.json");
        let store = SecretStore::new(path.clone());

        let first = store
            .ensure_provider_shared_id("p1")
            .expect("ensure provider shared id");
        assert!(first.starts_with("sp_"));

        store.rename_provider("p1", "p2").expect("rename provider");

        let reloaded = SecretStore::new(path);
        let second = reloaded
            .ensure_provider_shared_id("p2")
            .expect("reload provider shared id");
        assert_eq!(second, first);
    }

    #[test]
    fn lan_node_identity_persists_across_reload() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let path = tmp.path().join("secrets.json");
        let store = SecretStore::new(path.clone());

        let first = store
            .ensure_lan_node_identity("Desk-Node")
            .expect("ensure lan node identity");
        assert!(first.node_id.starts_with("node_"));
        assert_eq!(first.node_name, "Desk-Node");

        let reloaded = SecretStore::new(path);
        let second = reloaded
            .ensure_lan_node_identity("Other Name")
            .expect("reload lan node identity");
        assert_eq!(second.node_id, first.node_id);
        assert_eq!(second.node_name, first.node_name);
    }

    #[test]
    fn lan_trust_secret_is_independent_and_persists() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let path = tmp.path().join("secrets.json");
        let store = SecretStore::new(path.clone());

        let first = store
            .ensure_lan_trust_secret()
            .expect("ensure trust secret");
        assert!(first.starts_with("lan_"));

        let reloaded = SecretStore::new(path);
        let second = reloaded
            .ensure_lan_trust_secret()
            .expect("reload trust secret");
        assert_eq!(second, first);
    }

    #[test]
    fn provider_account_email_roundtrip_and_rename() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let path = tmp.path().join("secrets.json");
        let store = SecretStore::new(path.clone());

        store
            .set_provider_account_email("p1", "user@example.com")
            .expect("set provider account email");
        assert_eq!(
            store.get_provider_account_email("p1").as_deref(),
            Some("user@example.com")
        );

        let reloaded = SecretStore::new(path);
        assert_eq!(
            reloaded.get_provider_account_email("p1").as_deref(),
            Some("user@example.com")
        );

        reloaded
            .rename_provider("p1", "p2")
            .expect("rename provider");
        assert_eq!(reloaded.get_provider_account_email("p1"), None);
        assert_eq!(
            reloaded.get_provider_account_email("p2").as_deref(),
            Some("user@example.com")
        );

        reloaded
            .clear_provider_account_email("p2")
            .expect("clear provider account email");
        assert_eq!(reloaded.get_provider_account_email("p2"), None);
    }

    #[test]
    fn quota_hard_cap_field_update_roundtrip_and_cleanup() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let path = tmp.path().join("secrets.json");
        let store = SecretStore::new(path.clone());

        let updated = store
            .set_provider_quota_hard_cap_field("p1", "weekly", false)
            .expect("set weekly hard cap");
        assert_eq!(
            updated,
            ProviderQuotaHardCapConfig {
                daily: true,
                weekly: false,
                monthly: true,
            }
        );
        assert_eq!(store.get_provider_quota_hard_cap("p1"), updated);

        // Reload from disk to verify persistence.
        let reloaded = SecretStore::new(path.clone());
        assert_eq!(reloaded.get_provider_quota_hard_cap("p1"), updated);

        // Reset to all-true; this should collapse to default (no override row).
        let reset = reloaded
            .set_provider_quota_hard_cap_field("p1", "weekly", true)
            .expect("reset weekly hard cap");
        assert_eq!(reset, ProviderQuotaHardCapConfig::default());
        assert_eq!(
            reloaded.get_provider_quota_hard_cap("p1"),
            ProviderQuotaHardCapConfig::default()
        );

        let raw = std::fs::read_to_string(path).expect("read secrets");
        assert!(
            !raw.contains("\"provider_quota_hard_cap\": {\n    \"p1\""),
            "all-true override should be removed from persisted file"
        );
    }

    #[test]
    fn quota_hard_cap_field_update_rejects_invalid_field_without_mutation() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let path = tmp.path().join("secrets.json");
        let store = SecretStore::new(path);
        store
            .set_provider_quota_hard_cap_field("p1", "daily", false)
            .expect("seed daily=false");

        let err = store
            .set_provider_quota_hard_cap_field("p1", "bad_field", true)
            .expect_err("invalid field should fail");
        assert_eq!(err, "field must be one of: daily, weekly, monthly");
        assert_eq!(
            store.get_provider_quota_hard_cap("p1"),
            ProviderQuotaHardCapConfig {
                daily: false,
                weekly: true,
                monthly: true,
            }
        );
    }

    #[test]
    fn quota_hard_cap_field_update_does_not_mutate_memory_when_persist_fails() {
        let tmp = tempfile::tempdir().expect("tempdir");
        // Use a directory path as "file" path so persist() fails consistently.
        let store = SecretStore::new(tmp.path().to_path_buf());

        let err = store
            .set_provider_quota_hard_cap_field("p1", "daily", false)
            .expect_err("persist should fail on directory path");
        assert!(
            !err.trim().is_empty(),
            "persist failure should bubble an error"
        );
        assert_eq!(
            store.get_provider_quota_hard_cap("p1"),
            ProviderQuotaHardCapConfig::default(),
            "in-memory state should remain unchanged when persist fails"
        );
    }

    #[test]
    fn replace_provider_state_bundle_does_not_mutate_memory_when_persist_fails() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let store = SecretStore::new(tmp.path().to_path_buf());
        {
            let mut data = store.inner.lock();
            data.providers
                .insert("p1".to_string(), "sk-before".to_string());
        }

        let err = store
            .replace_provider_state_bundle(ProviderStateBundle {
                providers: BTreeMap::from([("p2".to_string(), "sk-after".to_string())]),
                ..ProviderStateBundle::default()
            })
            .expect_err("persist should fail on directory path");
        assert!(
            !err.trim().is_empty(),
            "persist failure should bubble an error"
        );
        assert_eq!(store.get_provider_key("p1").as_deref(), Some("sk-before"));
        assert_eq!(store.get_provider_key("p2"), None);
    }

    #[test]
    fn provider_state_bundle_excludes_and_preserves_gateway_token() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let path = tmp.path().join("secrets.json");
        let store = SecretStore::new(path);
        store
            .set_gateway_token("ao-local-token")
            .expect("set gateway token");
        store
            .set_provider_key("p1", "sk-p1")
            .expect("set provider key");

        let exported = store.export_provider_state_bundle();
        assert!(
            !exported.providers.contains_key(super::GATEWAY_TOKEN_KEY),
            "gateway token must stay out of provider bundle exports"
        );
        assert_eq!(
            exported.providers.get("p1").map(String::as_str),
            Some("sk-p1")
        );

        store
            .replace_provider_state_bundle(ProviderStateBundle {
                providers: BTreeMap::from([("p2".to_string(), "sk-p2".to_string())]),
                ..ProviderStateBundle::default()
            })
            .expect("replace provider bundle");

        assert_eq!(
            store.get_gateway_token().as_deref(),
            Some("ao-local-token"),
            "gateway token must survive provider bundle replacement"
        );
        assert_eq!(store.get_provider_key("p1"), None);
        assert_eq!(store.get_provider_key("p2").as_deref(), Some("sk-p2"));
    }

    #[test]
    fn quota_hard_cap_field_updates_are_atomic_under_concurrency() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let path = tmp.path().join("secrets.json");
        let store = Arc::new(SecretStore::new(path));

        for _ in 0..200 {
            store
                .set_provider_quota_hard_cap("p1", ProviderQuotaHardCapConfig::default())
                .expect("reset to default");

            let barrier = Arc::new(Barrier::new(3));
            let s1 = Arc::clone(&store);
            let b1 = Arc::clone(&barrier);
            let t1 = std::thread::spawn(move || {
                b1.wait();
                s1.set_provider_quota_hard_cap_field("p1", "daily", false)
                    .expect("daily=false");
            });

            let s2 = Arc::clone(&store);
            let b2 = Arc::clone(&barrier);
            let t2 = std::thread::spawn(move || {
                b2.wait();
                s2.set_provider_quota_hard_cap_field("p1", "weekly", false)
                    .expect("weekly=false");
            });

            barrier.wait();
            t1.join().expect("thread1");
            t2.join().expect("thread2");

            let got = store.get_provider_quota_hard_cap("p1");
            assert!(
                !got.daily && !got.weekly && got.monthly,
                "concurrent field updates should merge, got: {:?}",
                got
            );
        }
    }

    #[test]
    fn usage_login_roundtrip_and_clear() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let path = tmp.path().join("secrets.json");
        let store = SecretStore::new(path.clone());

        store
            .set_usage_login("p1", "alice", "secret-pass")
            .expect("set usage login");
        assert_eq!(
            store.get_usage_login("p1"),
            Some(UsageLoginConfig {
                username: "alice".to_string(),
                password: "secret-pass".to_string(),
            })
        );

        let reloaded = SecretStore::new(path.clone());
        assert_eq!(
            reloaded.get_usage_login("p1"),
            Some(UsageLoginConfig {
                username: "alice".to_string(),
                password: "secret-pass".to_string(),
            })
        );

        reloaded.clear_usage_login("p1").expect("clear usage login");
        assert_eq!(reloaded.get_usage_login("p1"), None);
    }

    #[test]
    fn official_account_profiles_capture_switch_and_remove_roundtrip() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let path = tmp.path().join("secrets.json");
        let store = SecretStore::new(path.clone());
        let first_usage = OfficialAccountUsageSnapshot {
            limit_5h_remaining: Some("87%".to_string()),
            limit_5h_reset_at: Some("123".to_string()),
            limit_weekly_remaining: Some("13%".to_string()),
            limit_weekly_reset_at: Some("456".to_string()),
        };
        let second_usage = OfficialAccountUsageSnapshot {
            limit_5h_remaining: Some("64%".to_string()),
            limit_5h_reset_at: Some("789".to_string()),
            limit_weekly_remaining: Some("41%".to_string()),
            limit_weekly_reset_at: Some("999".to_string()),
        };

        let first_auth = serde_json::json!({
            "tokens": {
                "access_token": "token-1",
                "refresh_token": "refresh-1"
            }
        });
        let second_auth = serde_json::json!({
            "tokens": {
                "access_token": "token-2",
                "refresh_token": "refresh-2"
            }
        });

        let first = store
            .capture_official_account_profile(&first_auth, None, Some(&first_usage))
            .expect("capture first official account");
        assert!(first.active);
        assert_eq!(first.limit_5h_remaining.as_deref(), Some("87%"));
        let second = store
            .capture_official_account_profile(&second_auth, None, Some(&second_usage))
            .expect("capture second official account");
        assert!(!second.active);
        assert_ne!(first.id, second.id);
        assert_eq!(second.limit_weekly_remaining.as_deref(), Some("41%"));

        let listed = store.list_official_account_profiles();
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0].id, first.id);
        assert_eq!(listed[1].id, second.id);
        assert!(listed[0].active);
        assert!(!listed[1].active);
        assert_eq!(listed[1].limit_5h_remaining.as_deref(), Some("64%"));

        let refreshed_second = store
            .capture_official_account_profile(&second_auth, None, Some(&second_usage))
            .expect("refresh second official account");
        assert_eq!(refreshed_second.id, second.id);
        assert!(!refreshed_second.active);

        let reactivated = store
            .select_official_account_profile(&first.id)
            .expect("select first official account");
        assert_eq!(reactivated.id, first.id);
        assert_eq!(reactivated.limit_weekly_remaining.as_deref(), Some("13%"));
        assert_eq!(
            store.active_official_account_profile_auth_json(),
            Some(first_auth.clone())
        );

        let reloaded = SecretStore::new(path.clone());
        let listed_after_reload = reloaded.list_official_account_profiles();
        assert_eq!(listed_after_reload.len(), 2);
        assert_eq!(
            listed_after_reload
                .iter()
                .find(|profile| profile.active)
                .map(|profile| profile.id.as_str()),
            Some(first.id.as_str())
        );

        reloaded
            .remove_official_account_profile(&first.id)
            .expect("remove first official account");
        let remaining = reloaded.list_official_account_profiles();
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].id, second.id);
        assert!(remaining[0].active);
    }

    #[test]
    fn official_account_sync_items_roundtrip_into_another_store() {
        let source_tmp = tempfile::tempdir().expect("source tempdir");
        let target_tmp = tempfile::tempdir().expect("target tempdir");
        let source = SecretStore::new(source_tmp.path().join("secrets.json"));
        let target = SecretStore::new(target_tmp.path().join("secrets.json"));
        let usage = OfficialAccountUsageSnapshot {
            limit_5h_remaining: Some("92%".to_string()),
            limit_5h_reset_at: Some("111".to_string()),
            limit_weekly_remaining: Some("81%".to_string()),
            limit_weekly_reset_at: Some("222".to_string()),
        };
        let auth_json = serde_json::json!({
            "tokens": {
                "account_id": "acct-sync",
                "access_token": "access-sync",
                "refresh_token": "refresh-sync"
            }
        });

        source
            .capture_official_account_profile(&auth_json, Some("Synced account"), Some(&usage))
            .expect("capture source account");
        let item = source
            .export_official_account_sync_items()
            .into_iter()
            .next()
            .expect("sync item");
        let imported = target
            .import_official_account_sync_item(&item)
            .expect("import synced account");

        assert_eq!(imported.label, "Synced account");
        assert_eq!(imported.limit_5h_remaining.as_deref(), Some("92%"));
        assert_eq!(
            target.active_official_account_profile_auth_json(),
            Some(auth_json)
        );
    }

    #[test]
    fn importing_official_account_sync_item_selects_imported_profile() {
        let source_tmp = tempfile::tempdir().expect("source tempdir");
        let target_tmp = tempfile::tempdir().expect("target tempdir");
        let source = SecretStore::new(source_tmp.path().join("secrets.json"));
        let target = SecretStore::new(target_tmp.path().join("secrets.json"));
        let existing_auth_json = serde_json::json!({
            "tokens": {
                "account_id": "acct-existing",
                "access_token": "access-existing"
            }
        });
        let synced_auth_json = serde_json::json!({
            "tokens": {
                "account_id": "acct-synced",
                "access_token": "access-synced"
            }
        });

        target
            .capture_official_account_profile(&existing_auth_json, Some("Existing"), None)
            .expect("capture existing account");
        source
            .capture_official_account_profile(&synced_auth_json, Some("Synced"), None)
            .expect("capture source account");
        let item = source
            .export_official_account_sync_items()
            .into_iter()
            .next()
            .expect("sync item");

        let imported = target
            .import_official_account_sync_item(&item)
            .expect("import synced account");

        assert!(imported.active);
        assert_eq!(
            target.active_official_account_profile_auth_json(),
            Some(synced_auth_json)
        );
    }

    #[test]
    fn official_account_profiles_dedupe_same_identity_even_when_tokens_change() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let path = tmp.path().join("secrets.json");
        let store = SecretStore::new(path);

        let first_auth = serde_json::json!({
            "tokens": {
                "account_id": "acct-1",
                "access_token": "token-1",
                "refresh_token": "refresh-1"
            }
        });
        let refreshed_same_account = serde_json::json!({
            "tokens": {
                "account_id": "acct-1",
                "access_token": "token-2",
                "refresh_token": "refresh-2"
            }
        });

        let first = store
            .capture_official_account_profile(&first_auth, None, None)
            .expect("capture first");
        let refreshed = store
            .capture_official_account_profile(&refreshed_same_account, None, None)
            .expect("capture refreshed same account");

        assert_eq!(first.id, refreshed.id);
        let profiles = store.list_official_account_profiles();
        assert_eq!(profiles.len(), 1);
    }

    #[test]
    fn capturing_new_official_account_profile_preserves_existing_active_selection() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let path = tmp.path().join("secrets.json");
        let store = SecretStore::new(path);

        let first = store
            .capture_official_account_profile(
                &serde_json::json!({
                    "tokens": {
                        "account_id": "acct-1",
                        "access_token": "token-1"
                    }
                }),
                Some("Official account 1"),
                None,
            )
            .expect("capture first");
        let second = store
            .capture_official_account_profile(
                &serde_json::json!({
                    "tokens": {
                        "account_id": "acct-2",
                        "access_token": "token-2"
                    }
                }),
                Some("Official account 2"),
                None,
            )
            .expect("capture second");

        assert!(first.active);
        assert!(!second.active);
        assert_eq!(
            store.active_official_account_profile_auth_json(),
            Some(serde_json::json!({
                "tokens": {
                    "account_id": "acct-1",
                    "access_token": "token-1"
                }
            }))
        );
    }

    #[test]
    fn official_account_profile_summary_includes_email_and_plan_label() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let path = tmp.path().join("secrets.json");
        let store = SecretStore::new(path);

        let auth_json = serde_json::json!({
            "tokens": {
                "account_id": "acct-1",
                "id_token": "header.eyJlbWFpbCI6InVzZXJAZXhhbXBsZS5jb20iLCJjaGF0Z3B0X3BsYW5fdHlwZSI6InByb2xpdGUifQ.signature"
            }
        });

        let profile = store
            .capture_official_account_profile(&auth_json, None, None)
            .expect("capture official account");

        assert_eq!(profile.email.as_deref(), Some("user@example.com"));
        assert_eq!(profile.plan_label.as_deref(), Some("Pro Lite"));
    }

    #[test]
    fn official_account_profile_summary_reads_nested_plan_label_from_real_id_token_shape() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let path = tmp.path().join("secrets.json");
        let store = SecretStore::new(path);

        let auth_json = serde_json::json!({
            "tokens": {
                "account_id": "acct-1",
                "id_token": "header.eyJlbWFpbCI6InVzZXJAZXhhbXBsZS5jb20iLCJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9wbGFuX3R5cGUiOiJwbHVzIn19.signature"
            }
        });

        let profile = store
            .capture_official_account_profile(&auth_json, None, None)
            .expect("capture official account");

        assert_eq!(profile.email.as_deref(), Some("user@example.com"));
        assert_eq!(profile.plan_label.as_deref(), Some("Plus"));
    }

    #[test]
    fn official_account_profiles_normalize_legacy_duplicate_entries_on_load() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let path = tmp.path().join("secrets.json");
        let duplicate_auth_one = serde_json::json!({
            "tokens": {
                "account_id": "acct-1",
                "access_token": "token-1",
                "id_token": "duplicate-id-token"
            }
        });
        let duplicate_auth_two = serde_json::json!({
            "tokens": {
                "account_id": "acct-1",
                "access_token": "token-2",
                "id_token": "duplicate-id-token"
            }
        });
        let raw = serde_json::json!({
            "official_account_profiles": {
                "official_a": {
                    "label": "Official account 1",
                    "auth_json": duplicate_auth_one,
                    "updated_at_unix_ms": 100,
                    "limit_5h_remaining": "87%",
                    "limit_5h_reset_at": "111",
                    "limit_weekly_remaining": "13%",
                    "limit_weekly_reset_at": "222"
                },
                "official_b": {
                    "label": "Official account 2",
                    "auth_json": duplicate_auth_two,
                    "updated_at_unix_ms": 200,
                    "limit_5h_remaining": "64%",
                    "limit_5h_reset_at": "333",
                    "limit_weekly_remaining": "41%",
                    "limit_weekly_reset_at": "444"
                }
            },
            "active_official_account_profile_id": "official_b"
        });
        std::fs::write(
            &path,
            serde_json::to_string_pretty(&raw).expect("serialize raw secrets"),
        )
        .expect("write legacy duplicate secrets");

        let store = SecretStore::new(path.clone());
        let profiles = store.list_official_account_profiles();
        assert_eq!(profiles.len(), 1);
        assert_eq!(profiles[0].label, "Official account 1");
        assert!(profiles[0].active);
        assert_eq!(profiles[0].limit_5h_remaining.as_deref(), Some("64%"));
        assert_eq!(profiles[0].limit_weekly_remaining.as_deref(), Some("41%"));

        let persisted = SecretStore::new(path);
        let persisted_profiles = persisted.list_official_account_profiles();
        assert_eq!(persisted_profiles.len(), 1);
        assert_eq!(persisted_profiles[0].label, "Official account 1");
        assert!(persisted_profiles[0].active);
    }

    #[test]
    fn provider_key_storage_mode_roundtrip_and_rename() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let path = tmp.path().join("secrets.json");
        let store = SecretStore::new(path.clone());

        store
            .set_provider_key_with_storage_mode(
                "p1",
                "sk-test",
                Some("config_toml_experimental_bearer_token"),
            )
            .expect("set provider key with storage mode");
        assert_eq!(
            store.get_provider_key_storage_mode("p1"),
            "config_toml_experimental_bearer_token"
        );

        let reloaded = SecretStore::new(path);
        assert_eq!(
            reloaded.get_provider_key_storage_mode("p1"),
            "config_toml_experimental_bearer_token"
        );

        reloaded
            .rename_provider("p1", "p2")
            .expect("rename provider");
        assert_eq!(
            reloaded.get_provider_key_storage_mode("p2"),
            "config_toml_experimental_bearer_token"
        );
        assert_eq!(
            reloaded.get_provider_key_storage_mode("missing"),
            "auth_json"
        );
    }

    #[test]
    fn resolve_provider_pricing_config_matches_renamed_per_request_period_by_key_ref() {
        let pricing = std::collections::BTreeMap::from([(
            "codex-for.me".to_string(),
            ProviderPricingConfig {
                mode: "per_request".to_string(),
                amount_usd: 0.0,
                periods: vec![ProviderPricingPeriod {
                    id: "period-1".to_string(),
                    mode: "per_request".to_string(),
                    amount_usd: 0.035,
                    api_key_ref: "sk-tPN******hxNs".to_string(),
                    started_at_unix_ms: 1_700_000_000_000,
                    ended_at_unix_ms: Some(1_800_000_000_000),
                }],
                gap_fill_mode: None,
                gap_fill_amount_usd: None,
            },
        )]);

        let resolved = resolve_provider_pricing_config(
            &pricing,
            "packycode",
            Some("sk-tPN******hxNs"),
            1_700_100_000_000,
        );

        assert_eq!(
            pricing_per_request_amount_at(resolved, 1_700_100_000_000),
            Some(0.035)
        );
    }
}
