use super::mapping::{CanonicalUsageMapping, NumericFieldSpec, NumericTransform, UnixMsFieldSpec};
use crate::orchestrator::quota::UsageKind;

pub(crate) const AIGATEWAY_USAGE_MAPPING: CanonicalUsageMapping = CanonicalUsageMapping {
    usage_kind: UsageKind::BudgetInfo,
    plan_name: None,
    mode: None,
    currency_unit: None,
    remaining: Some(NumericFieldSpec {
        aliases: &[
            "/remaining",
            "/remaining_quota",
            "/balance",
            "/quota/daily_remaining",
        ],
        transform: NumericTransform::None,
    }),
    today_used: None,
    today_added: None,
    daily_used: Some(NumericFieldSpec {
        aliases: &[
            "/usage/today/actual_cost",
            "/usage/today/cost",
            "/quota/daily_spent",
            "/quota/daily_total_spent",
            "/usage/daily_spent",
            "/usage/daily_total_spent",
            "/daily_spent_usd",
            "/daily_usage_usd",
            "/subscription/daily_usage_usd",
        ],
        transform: NumericTransform::None,
    }),
    daily_limit: Some(NumericFieldSpec {
        aliases: &[
            "/quota/daily_quota",
            "/daily_quota",
            "/daily_budget_usd",
            "/daily_limit_usd",
            "/subscription/daily_limit_usd",
        ],
        transform: NumericTransform::None,
    }),
    weekly_used: None,
    weekly_limit: None,
    monthly_used: None,
    monthly_limit: None,
    expires_at_unix_ms: Some(UnixMsFieldSpec {
        aliases: &[
            "/timestamps/expires_at",
            "/expires_at",
            "/subscription/expires_at",
        ],
    }),
    requires_any: &[
        "/quota/daily_quota",
        "/daily_quota",
        "/daily_budget_usd",
        "/daily_limit_usd",
        "/quota/daily_spent",
        "/daily_spent_usd",
        "/remaining",
        "/balance",
        "/timestamps/expires_at",
    ],
};

pub(crate) const USER_ME_USAGE_MAPPING: CanonicalUsageMapping = CanonicalUsageMapping {
    usage_kind: UsageKind::BudgetInfo,
    plan_name: None,
    mode: None,
    currency_unit: None,
    remaining: Some(NumericFieldSpec {
        aliases: &[
            "/quota/daily_remaining",
            "/remaining",
            "/remaining_quota",
            "/balance",
        ],
        transform: NumericTransform::DivideBy(100.0),
    }),
    today_used: None,
    today_added: None,
    daily_used: Some(NumericFieldSpec {
        aliases: &[
            "/usage/today/actual_cost",
            "/usage/today/cost",
            "/quota/daily_spent",
            "/quota/daily_total_spent",
            "/usage/daily_spent",
            "/usage/daily_total_spent",
            "/daily_spent_usd",
            "/daily_usage_usd",
            "/subscription/daily_usage_usd",
        ],
        transform: NumericTransform::DivideBy(100.0),
    }),
    daily_limit: Some(NumericFieldSpec {
        aliases: &[
            "/quota/daily_quota",
            "/daily_quota",
            "/daily_budget_usd",
            "/daily_limit_usd",
            "/subscription/daily_limit_usd",
        ],
        transform: NumericTransform::DivideBy(100.0),
    }),
    weekly_used: None,
    weekly_limit: None,
    monthly_used: None,
    monthly_limit: None,
    expires_at_unix_ms: Some(UnixMsFieldSpec {
        aliases: &[
            "/timestamps/expires_at",
            "/expires_at",
            "/subscription/expires_at",
        ],
    }),
    requires_any: &[
        "/quota/daily_quota",
        "/daily_quota",
        "/quota/daily_spent",
        "/daily_spent_usd",
        "/quota/daily_remaining",
        "/timestamps/expires_at",
    ],
};
