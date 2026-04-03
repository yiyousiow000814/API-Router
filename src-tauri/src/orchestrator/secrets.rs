use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use std::sync::Arc;

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
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UsageLoginConfig {
    pub username: String,
    pub password: String,
}

fn default_hard_cap_enabled() -> bool {
    true
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
    #[allow(dead_code)]
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
        let inner = Self::load_from_disk(&path).unwrap_or_default();
        Self {
            path,
            inner: Arc::new(Mutex::new(inner)),
        }
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
        periods.sort_by(|a, b| a.started_at_unix_ms.cmp(&b.started_at_unix_ms));
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
        periods.sort_by(|a, b| a.started_at_unix_ms.cmp(&b.started_at_unix_ms));
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
        periods.sort_by(|a, b| a.started_at_unix_ms.cmp(&b.started_at_unix_ms));
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

    pub fn replace_provider_pricing_config(
        &self,
        provider: &str,
        pricing: Option<ProviderPricingConfig>,
    ) -> Result<(), String> {
        let mut data = self.inner.lock();
        match pricing {
            Some(pricing) => {
                data.provider_pricing.insert(
                    provider.to_string(),
                    ProviderPricingOverride {
                        mode: pricing.mode,
                        amount_usd: pricing.amount_usd,
                        periods: pricing.periods,
                        gap_fill_mode: pricing.gap_fill_mode,
                        gap_fill_amount_usd: pricing.gap_fill_amount_usd,
                    },
                );
            }
            None => {
                data.provider_pricing.remove(provider);
            }
        }
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
        pricing_per_request_amount_at, resolve_provider_pricing_config, ProviderPricingConfig,
        ProviderPricingPeriod, ProviderQuotaHardCapConfig, ProviderStateBundle, SecretStore,
        UsageLoginConfig,
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
