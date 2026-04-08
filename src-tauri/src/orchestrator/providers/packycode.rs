use super::mapping::{CanonicalUsageMapping, NumericFieldSpec};
use crate::orchestrator::quota::UsageKind;

pub(crate) const PACKYCODE_USAGE_MAPPING: CanonicalUsageMapping = CanonicalUsageMapping {
    usage_kind: UsageKind::BudgetInfo,
    plan_name: None,
    mode: None,
    currency_unit: None,
    remaining: Some(NumericFieldSpec {
        aliases: &["/remaining_quota"],
        transform: super::mapping::NumericTransform::None,
    }),
    today_used: None,
    today_added: None,
    daily_used: Some(NumericFieldSpec {
        aliases: &["/daily_spent_usd"],
        transform: super::mapping::NumericTransform::None,
    }),
    daily_limit: Some(NumericFieldSpec {
        aliases: &["/daily_budget_usd"],
        transform: super::mapping::NumericTransform::None,
    }),
    weekly_used: Some(NumericFieldSpec {
        aliases: &["/weekly_spent_usd", "/weekly_spent"],
        transform: super::mapping::NumericTransform::None,
    }),
    weekly_limit: Some(NumericFieldSpec {
        aliases: &["/weekly_budget_usd", "/weekly_budget"],
        transform: super::mapping::NumericTransform::None,
    }),
    monthly_used: Some(NumericFieldSpec {
        aliases: &["/monthly_spent_usd"],
        transform: super::mapping::NumericTransform::None,
    }),
    monthly_limit: Some(NumericFieldSpec {
        aliases: &["/monthly_budget_usd"],
        transform: super::mapping::NumericTransform::None,
    }),
    expires_at_unix_ms: None,
    requires_any: &[
        "/daily_spent_usd",
        "/monthly_spent_usd",
        "/weekly_spent_usd",
        "/weekly_spent",
    ],
};

pub(crate) fn canonical_usage_base(base_url: &str) -> Option<String> {
    if is_packycode_base(base_url) {
        Some("https://codex.packycode.com".to_string())
    } else {
        None
    }
}

pub(crate) fn is_packycode_base(base_url: &str) -> bool {
    reqwest::Url::parse(base_url)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.to_string()))
        .map(|host| host.ends_with("packycode.com"))
        .unwrap_or(false)
}
