use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoutingConfig {
    pub preferred_provider: String,
    pub auto_return_to_preferred: bool,
    pub preferred_stable_seconds: u64,
    pub failure_threshold: u32,
    pub cooldown_seconds: u64,
    pub request_timeout_seconds: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderConfig {
    pub display_name: String,
    pub base_url: String,
    /// Optional usage/quota source type for this provider.
    ///
    /// Known values: "ppchat", "packycode". Empty/"none" disables quota fetching.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub quota_kind: String,
    /// Optional base URL for usage/quota API (often different from the OpenAI-compatible base_url).
    ///
    /// Examples:
    /// - PPCHAT: https://his.ppchat.vip
    /// - Packycode: https://codex.packycode.com
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quota_base_url: Option<String>,
    /// If empty, the gateway tries to passthrough the client's Authorization header (OAuth).
    ///
    /// This is only used for one-time migration into `user-data/secrets.json`.
    /// The UI/API never exposes it.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub api_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ListenConfig {
    pub host: String,
    pub port: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    pub listen: ListenConfig,
    pub routing: RoutingConfig,
    pub providers: std::collections::BTreeMap<String, ProviderConfig>,
}

impl AppConfig {
    pub fn default_config() -> Self {
        let mut providers = std::collections::BTreeMap::new();
        providers.insert(
            "official".to_string(),
            ProviderConfig {
                display_name: "Official (OAuth passthrough)".to_string(),
                base_url: "https://api.openai.com".to_string(),
                quota_kind: String::new(),
                quota_base_url: None,
                api_key: "".to_string(),
            },
        );
        for i in 1..=2 {
            let name = format!("provider_{i}");
            providers.insert(
                name.clone(),
                ProviderConfig {
                    display_name: format!("Provider {i}"),
                    base_url: String::new(),
                    quota_kind: String::new(),
                    quota_base_url: None,
                    api_key: String::new(),
                },
            );
        }

        Self {
            listen: ListenConfig {
                host: "127.0.0.1".to_string(),
                port: 4000,
            },
            routing: RoutingConfig {
                preferred_provider: "official".to_string(),
                auto_return_to_preferred: true,
                preferred_stable_seconds: 30,
                failure_threshold: 2,
                cooldown_seconds: 30,
                request_timeout_seconds: 60,
            },
            providers,
        }
    }
}
