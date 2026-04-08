use super::mapping::{CanonicalUsageMapping, NumericFieldSpec, StringFieldSpec, UnixMsFieldSpec};
use crate::orchestrator::quota::UsageKind;

pub(crate) const CODEX_FOR_ME_SUMMARY_MAPPING: CanonicalUsageMapping = CanonicalUsageMapping {
    usage_kind: UsageKind::BalanceInfo,
    plan_name: Some(StringFieldSpec {
        aliases: &["/data/card_name", "/card_name"],
    }),
    mode: None,
    currency_unit: None,
    remaining: Some(NumericFieldSpec {
        aliases: &[
            "/data/card_balance",
            "/data/balance",
            "/card_balance",
            "/balance",
        ],
        transform: super::mapping::NumericTransform::None,
    }),
    today_used: None,
    today_added: None,
    daily_used: Some(NumericFieldSpec {
        aliases: &[
            "/data/today_spent_amount",
            "/data/today_total_amount",
            "/data/daily_spent_usd",
            "/today_spent_amount",
            "/today_total_amount",
            "/daily_spent_usd",
        ],
        transform: super::mapping::NumericTransform::None,
    }),
    daily_limit: Some(NumericFieldSpec {
        aliases: &[
            "/data/card_daily_limit",
            "/data/daily_limit",
            "/data/daily_budget_usd",
            "/card_daily_limit",
            "/daily_limit",
            "/daily_budget_usd",
        ],
        transform: super::mapping::NumericTransform::None,
    }),
    weekly_used: None,
    weekly_limit: None,
    monthly_used: Some(NumericFieldSpec {
        aliases: &[
            "/data/card_total_spent_amount",
            "/data/this_month_total_amount",
            "/data/total_spent_amount",
            "/data/monthly_spent_usd",
            "/card_total_spent_amount",
            "/this_month_total_amount",
            "/total_spent_amount",
            "/monthly_spent_usd",
        ],
        transform: super::mapping::NumericTransform::None,
    }),
    monthly_limit: None,
    expires_at_unix_ms: Some(UnixMsFieldSpec {
        aliases: &[
            "/data/card_expire_date",
            "/data/expire_date",
            "/card_expire_date",
            "/expire_date",
        ],
    }),
    requires_any: &[
        "/data/card_balance",
        "/data/balance",
        "/data/card_expire_date",
        "/data/card_daily_limit",
        "/data/today_spent_amount",
        "/data/card_total_spent_amount",
    ],
};

pub(crate) fn is_codex_for_me_origin(base_url: &str) -> bool {
    reqwest::Url::parse(base_url)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.to_string()))
        .map(|host| host.contains("codex-for"))
        .unwrap_or(false)
}
