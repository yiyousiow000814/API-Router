use std::collections::HashMap;
use std::time::Duration;

use parking_lot::RwLock;

use super::config::AppConfig;

#[derive(Debug, Clone, serde::Serialize)]
pub struct ProviderHealthSnapshot {
    pub is_healthy: bool,
    pub consecutive_failures: u32,
    pub cooldown_until_unix_ms: u64,
    pub last_error: String,
    pub last_ok_at_unix_ms: u64,
    pub last_fail_at_unix_ms: u64,
}

#[derive(Debug, Clone)]
struct ProviderHealth {
    consecutive_failures: u32,
    cooldown_until_unix_ms: u64,
    last_error: String,
    last_ok_at_unix_ms: u64,
    last_fail_at_unix_ms: u64,
}

impl ProviderHealth {
    fn new(now_ms: u64) -> Self {
        Self {
            consecutive_failures: 0,
            cooldown_until_unix_ms: 0,
            last_error: String::new(),
            last_ok_at_unix_ms: now_ms,
            last_fail_at_unix_ms: 0,
        }
    }

    fn in_cooldown(&self) -> bool {
        self.cooldown_until_unix_ms != 0 && unix_ms() < self.cooldown_until_unix_ms
    }
}

pub struct RouterState {
    pub manual_override: RwLock<Option<String>>,
    health: RwLock<HashMap<String, ProviderHealth>>,
}

impl RouterState {
    pub fn new(cfg: &AppConfig, now_ms: u64) -> Self {
        let mut health = HashMap::new();
        for name in cfg.providers.keys() {
            health.insert(name.clone(), ProviderHealth::new(now_ms));
        }
        Self {
            manual_override: RwLock::new(None),
            health: RwLock::new(health),
        }
    }

    pub fn set_manual_override(&self, provider: Option<String>) {
        *self.manual_override.write() = provider;
    }

    pub fn decide(&self, cfg: &AppConfig) -> (String, &'static str) {
        if let Some(p) = self.manual_override.read().clone() {
            if self.is_routable(&p) {
                return (p, "manual_override");
            }
            return (self.fallback(cfg), "manual_override_unhealthy");
        }

        let preferred = cfg.routing.preferred_provider.clone();
        if self.is_routable(&preferred) {
            return (preferred, "preferred_healthy");
        }
        (self.fallback(cfg), "preferred_unhealthy")
    }

    pub fn mark_success(&self, provider: &str, now_ms: u64) {
        let mut health = self.health.write();
        if let Some(h) = health.get_mut(provider) {
            h.consecutive_failures = 0;
            h.cooldown_until_unix_ms = 0;
            h.last_error.clear();
            h.last_ok_at_unix_ms = now_ms;
        }
    }

    pub fn mark_failure(&self, provider: &str, cfg: &AppConfig, err: &str, now_ms: u64) {
        let mut health = self.health.write();
        if let Some(h) = health.get_mut(provider) {
            h.consecutive_failures = h.consecutive_failures.saturating_add(1);
            h.last_error = err.chars().take(500).collect();
            h.last_fail_at_unix_ms = now_ms;

            if h.consecutive_failures >= cfg.routing.failure_threshold {
                h.cooldown_until_unix_ms = now_ms + (cfg.routing.cooldown_seconds * 1000);
            }
        }
    }

    pub fn snapshot(&self, _now_ms: u64) -> HashMap<String, ProviderHealthSnapshot> {
        let health = self.health.read();
        health
            .iter()
            .map(|(k, v)| {
                (
                    k.clone(),
                    ProviderHealthSnapshot {
                        // "Healthy" here means "currently routable". We treat a provider as
                        // available again once its cooldown expires (half-open circuit).
                        is_healthy: !v.in_cooldown(),
                        consecutive_failures: v.consecutive_failures,
                        cooldown_until_unix_ms: v.cooldown_until_unix_ms,
                        last_error: v.last_error.clone(),
                        last_ok_at_unix_ms: v.last_ok_at_unix_ms,
                        last_fail_at_unix_ms: v.last_fail_at_unix_ms,
                    },
                )
            })
            .collect()
    }

    fn is_routable(&self, provider: &str) -> bool {
        let health = self.health.read();
        let Some(h) = health.get(provider) else { return false };
        !h.in_cooldown()
    }

    fn fallback(&self, cfg: &AppConfig) -> String {
        for name in cfg.providers.keys() {
            if name == &cfg.routing.preferred_provider {
                continue;
            }
            if self.is_routable(name) {
                return name.clone();
            }
        }
        cfg.routing.preferred_provider.clone()
    }
}

fn unix_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::from_secs(0))
        .as_millis() as u64
}
