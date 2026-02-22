use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum RouteMode {
    #[default]
    FollowPreferredAuto,
    BalancedAuto,
}

impl RouteMode {
    pub fn from_wire(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "follow_preferred_auto" => Some(Self::FollowPreferredAuto),
            "balanced_auto" => Some(Self::BalancedAuto),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoutingConfig {
    pub preferred_provider: String,
    /// Per-client-session preferred provider overrides (keyed by Codex session id).
    ///
    /// When a request is tagged with a client session id, the router can use this mapping
    /// instead of the global `preferred_provider`.
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub session_preferred_providers: std::collections::BTreeMap<String, String>,
    #[serde(default)]
    pub route_mode: RouteMode,
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
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub disabled: bool,
    /// Optional usage/quota source type for this provider.
    ///
    /// Empty disables usage fetching; otherwise the orchestrator may use it as a hint.
    #[serde(
        default,
        skip_serializing_if = "String::is_empty",
        alias = "quota_kind"
    )]
    pub usage_adapter: String,
    /// Optional base URL for usage/quota API (often different from the OpenAI-compatible base_url).
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        alias = "quota_base_url"
    )]
    pub usage_base_url: Option<String>,
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
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub provider_order: Vec<String>,
}

impl AppConfig {
    pub fn default_config() -> Self {
        let mut providers = std::collections::BTreeMap::new();
        providers.insert(
            "official".to_string(),
            ProviderConfig {
                display_name: "Official (OAuth passthrough)".to_string(),
                base_url: "https://api.openai.com".to_string(),
                disabled: false,
                usage_adapter: String::new(),
                usage_base_url: None,
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
                    disabled: false,
                    usage_adapter: String::new(),
                    usage_base_url: None,
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
                session_preferred_providers: std::collections::BTreeMap::new(),
                route_mode: RouteMode::FollowPreferredAuto,
                auto_return_to_preferred: true,
                preferred_stable_seconds: 30,
                failure_threshold: 2,
                cooldown_seconds: 30,
                // Streamed responses can be long-lived; keep a larger default to avoid
                // premature timeouts on slower providers/networks.
                request_timeout_seconds: 300,
            },
            providers,
            provider_order: vec![
                "official".to_string(),
                "provider_1".to_string(),
                "provider_2".to_string(),
            ],
        }
    }
}
