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
    /// If empty, the gateway tries to passthrough the client's Authorization header (OAuth).
    pub api_key: String,
    pub supports_responses: bool,
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
                api_key: "".to_string(),
                supports_responses: true,
            },
        );
        providers.insert(
            "provider_a".to_string(),
            ProviderConfig {
                display_name: "Provider A".to_string(),
                base_url: "https://example-a.com".to_string(),
                api_key: "REPLACE_ME".to_string(),
                supports_responses: false,
            },
        );
        providers.insert(
            "provider_b".to_string(),
            ProviderConfig {
                display_name: "Provider B".to_string(),
                base_url: "https://example-b.com".to_string(),
                api_key: "REPLACE_ME".to_string(),
                supports_responses: true,
            },
        );

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
