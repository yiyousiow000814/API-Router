use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
struct SecretsFile {
    #[serde(default)]
    providers: BTreeMap<String, String>,
    /// Optional non-upstream secrets used by the app (e.g. usage JWTs).
    #[serde(default)]
    usage_tokens: BTreeMap<String, String>,
    #[serde(default)]
    provider_pricing: BTreeMap<String, ProviderPricingOverride>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ProviderPricingOverride {
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

#[derive(Debug, Clone)]
pub struct ProviderPricingConfig {
    pub mode: String,
    pub amount_usd: f64,
    pub periods: Vec<ProviderPricingPeriod>,
    pub gap_fill_mode: Option<String>,
    pub gap_fill_amount_usd: Option<f64>,
}

#[derive(Clone)]
pub struct SecretStore {
    path: PathBuf,
    inner: Arc<Mutex<SecretsFile>>,
}

const GATEWAY_TOKEN_KEY: &str = "__gateway_token__";

impl SecretStore {
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

    pub fn set_provider_key(&self, provider: &str, key: &str) -> Result<(), String> {
        let mut data = self.inner.lock();
        data.providers.insert(provider.to_string(), key.to_string());
        self.persist(&data)
    }

    pub fn clear_provider_key(&self, provider: &str) -> Result<(), String> {
        let mut data = self.inner.lock();
        data.providers.remove(provider);
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

    pub fn rename_provider(&self, old: &str, new: &str) -> Result<(), String> {
        if old == new {
            return Ok(());
        }
        let mut data = self.inner.lock();
        if let Some(v) = data.providers.remove(old) {
            data.providers.insert(new.to_string(), v);
        }
        if let Some(v) = data.usage_tokens.remove(old) {
            data.usage_tokens.insert(new.to_string(), v);
        }
        if let Some(v) = data.provider_pricing.remove(old) {
            data.provider_pricing.insert(new.to_string(), v);
        }
        self.persist(&data)
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

    pub fn clear_provider_pricing(&self, provider: &str) -> Result<(), String> {
        let mut data = self.inner.lock();
        data.provider_pricing.remove(provider);
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

    pub fn rotate_gateway_token(&self) -> Result<String, String> {
        let t = Self::new_gateway_token();
        self.set_gateway_token(&t)?;
        Ok(t)
    }

    fn new_gateway_token() -> String {
        format!("ao_{}", Uuid::new_v4().simple())
    }
}
