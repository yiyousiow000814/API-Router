mod aigateway;
mod codex_for_me;
mod generic;
mod mapping;
mod packycode;
mod ppchat;
mod pumpkinai;

use super::config::ProviderConfig;
use super::quota::UsageKind;

pub(crate) use aigateway::{AIGATEWAY_USAGE_MAPPING, USER_ME_USAGE_MAPPING};
pub(crate) use codex_for_me::CODEX_FOR_ME_SUMMARY_MAPPING;
pub(crate) use generic::derive_origin;
pub(crate) use mapping::{map_canonical_usage, CanonicalUsageContext, CanonicalUsageMapping};
pub(crate) use packycode::{
    canonical_usage_base as canonical_packycode_usage_base, PACKYCODE_USAGE_MAPPING,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ProviderFamily {
    Generic,
    Packycode,
    CodexForMe,
    Aigateway,
    Ppchat,
    PumpkinAi,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PackageExpiryStrategy {
    None,
    Packycode,
}

#[derive(Debug, Clone)]
pub(crate) struct ProviderQuotaProfile {
    pub family: ProviderFamily,
    pub usage_kind: UsageKind,
    pub candidate_bases: Vec<String>,
    pub explicit_usage_endpoint: Option<String>,
    pub package_expiry_strategy: PackageExpiryStrategy,
}

impl ProviderQuotaProfile {
    pub fn is_codex_for_me(&self) -> bool {
        self.family == ProviderFamily::CodexForMe
    }

    pub fn uses_packycode_usage_schedule(&self) -> bool {
        self.package_expiry_strategy == PackageExpiryStrategy::Packycode
    }
}

#[allow(dead_code)]
#[derive(Debug, Clone)]
pub(crate) struct CanonicalProviderUsage {
    pub usage_kind: UsageKind,
    pub plan_name: Option<String>,
    pub mode: Option<String>,
    pub currency_unit: Option<String>,
    pub remaining: Option<f64>,
    pub today_used: Option<f64>,
    pub today_added: Option<f64>,
    pub daily_used: Option<f64>,
    pub daily_limit: Option<f64>,
    pub weekly_used: Option<f64>,
    pub weekly_limit: Option<f64>,
    pub monthly_used: Option<f64>,
    pub monthly_limit: Option<f64>,
    pub expires_at_unix_ms: Option<u64>,
    pub effective_usage_base: Option<String>,
    pub effective_usage_source: Option<String>,
    pub updated_at_unix_ms: u64,
}

pub(crate) fn detect_usage_kind(provider: &ProviderConfig) -> UsageKind {
    let explicit = UsageKind::from_str(&provider.usage_adapter);
    if explicit != UsageKind::None {
        return explicit;
    }
    UsageKind::None
}

pub(crate) fn resolve_quota_profile(provider: &ProviderConfig) -> ProviderQuotaProfile {
    let family = detect_provider_family(provider);
    ProviderQuotaProfile {
        family,
        usage_kind: detect_usage_kind(provider),
        candidate_bases: candidate_quota_bases(provider, family),
        explicit_usage_endpoint: explicit_usage_endpoint_url(provider),
        package_expiry_strategy: package_expiry_strategy_for_family(family),
    }
}

pub(crate) fn explicit_usage_mapping(endpoint_url: &str) -> &'static CanonicalUsageMapping {
    if endpoint_url
        .trim_end_matches('/')
        .to_ascii_lowercase()
        .ends_with("/user/api/v1/me")
    {
        &USER_ME_USAGE_MAPPING
    } else {
        &AIGATEWAY_USAGE_MAPPING
    }
}

fn detect_provider_family(provider: &ProviderConfig) -> ProviderFamily {
    if packycode::is_packycode_base(&provider.base_url) {
        return ProviderFamily::Packycode;
    }
    if codex_for_me::is_codex_for_me_origin(&provider.base_url) {
        return ProviderFamily::CodexForMe;
    }
    if is_aigateway_base(&provider.base_url) {
        return ProviderFamily::Aigateway;
    }
    if ppchat::is_ppchat_base(&provider.base_url) {
        return ProviderFamily::Ppchat;
    }
    if pumpkinai::is_pumpkinai_base(&provider.base_url) {
        return ProviderFamily::PumpkinAi;
    }
    ProviderFamily::Generic
}

pub(crate) fn explicit_usage_endpoint_url(provider: &ProviderConfig) -> Option<String> {
    if let Some(raw) = provider.usage_base_url.as_deref() {
        let raw = raw.trim();
        if !raw.is_empty() {
            if let Ok(parsed) = reqwest::Url::parse(raw) {
                let path = parsed.path().trim_end_matches('/');
                if !(path.is_empty() || path == "/") {
                    let normalized = path.to_ascii_lowercase();
                    if !matches!(
                        normalized.as_str(),
                        "/v1" | "/api" | "/web/api/v1" | "/user/api/v1" | "/backend"
                    ) {
                        return Some(raw.trim_end_matches('/').to_string());
                    }
                }
            }
        }
    }

    if is_aigateway_base(&provider.base_url) {
        return Some("https://aigateway.chat/v1/usage".to_string());
    }

    None
}

pub(crate) fn candidate_quota_bases(
    provider: &ProviderConfig,
    family: ProviderFamily,
) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut push_unique = |value: String| {
        if value.is_empty() {
            return;
        }
        if !out.iter().any(|v| v == &value) {
            out.push(value);
        }
    };

    if let Some(u) = provider.usage_base_url.as_deref() {
        let trimmed = u.trim().trim_end_matches('/');
        if !trimmed.is_empty() {
            if let Some(canonical) = canonical_packycode_usage_base(trimmed) {
                push_unique(canonical);
            } else {
                push_unique(trimmed.to_string());
            }
        }
    }

    if matches!(family, ProviderFamily::Ppchat | ProviderFamily::PumpkinAi) {
        for base in ppchat::default_candidate_bases() {
            push_unique(base.to_string());
        }
    }

    if let Some(canonical) = canonical_packycode_usage_base(&provider.base_url) {
        push_unique(canonical);
    }

    if family == ProviderFamily::CodexForMe {
        if let Some(origin) = derive_origin(&provider.base_url) {
            push_unique(origin);
        }
    }

    if family == ProviderFamily::Aigateway {
        push_unique("https://aigateway.chat".to_string());
    }

    out
}

pub(crate) fn package_expiry_strategy_for_family(family: ProviderFamily) -> PackageExpiryStrategy {
    if family == ProviderFamily::Packycode {
        PackageExpiryStrategy::Packycode
    } else {
        PackageExpiryStrategy::None
    }
}

pub(crate) fn detect_package_expiry_strategy(base_url: &str) -> PackageExpiryStrategy {
    package_expiry_strategy_for_family(detect_provider_family_from_base_url(base_url))
}

fn detect_provider_family_from_base_url(base_url: &str) -> ProviderFamily {
    if packycode::is_packycode_base(base_url) {
        return ProviderFamily::Packycode;
    }
    if codex_for_me::is_codex_for_me_origin(base_url) {
        return ProviderFamily::CodexForMe;
    }
    if is_aigateway_base(base_url) {
        return ProviderFamily::Aigateway;
    }
    if ppchat::is_ppchat_base(base_url) {
        return ProviderFamily::Ppchat;
    }
    if pumpkinai::is_pumpkinai_base(base_url) {
        return ProviderFamily::PumpkinAi;
    }
    ProviderFamily::Generic
}

fn is_aigateway_base(base_url: &str) -> bool {
    reqwest::Url::parse(base_url)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.to_string()))
        .map(|host| host == "aigateway.chat" || host.ends_with(".aigateway.chat"))
        .unwrap_or(false)
}
