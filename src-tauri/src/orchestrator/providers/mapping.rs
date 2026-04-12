use serde_json::Value;

use crate::orchestrator::quota::UsageKind;

use super::CanonicalProviderUsage;

#[derive(Debug, Clone, Copy)]
pub(crate) enum NumericTransform {
    None,
    DivideBy(f64),
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct NumericFieldSpec {
    pub aliases: &'static [&'static str],
    pub transform: NumericTransform,
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct StringFieldSpec {
    pub aliases: &'static [&'static str],
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct UnixMsFieldSpec {
    pub aliases: &'static [&'static str],
    pub rules: &'static [UnixMsRule],
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum UnixMsAggregate {
    First,
    Max,
}

#[derive(Debug, Clone, Copy)]
pub(crate) enum UnixMsRule {
    Pointer(&'static str),
    Array {
        pointer: &'static str,
        item_pointer: &'static str,
        aggregate: UnixMsAggregate,
        filter_pointer: Option<&'static str>,
        filter_eq: Option<&'static str>,
        filter_in: &'static [&'static str],
    },
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct CanonicalUsageMapping {
    pub usage_kind: UsageKind,
    pub plan_name: Option<StringFieldSpec>,
    pub mode: Option<StringFieldSpec>,
    pub currency_unit: Option<StringFieldSpec>,
    pub remaining: Option<NumericFieldSpec>,
    pub today_used: Option<NumericFieldSpec>,
    pub today_added: Option<NumericFieldSpec>,
    pub daily_used: Option<NumericFieldSpec>,
    pub daily_limit: Option<NumericFieldSpec>,
    pub weekly_used: Option<NumericFieldSpec>,
    pub weekly_limit: Option<NumericFieldSpec>,
    pub monthly_used: Option<NumericFieldSpec>,
    pub monthly_limit: Option<NumericFieldSpec>,
    pub expires_at_unix_ms: Option<UnixMsFieldSpec>,
    pub requires_any: &'static [&'static str],
}

#[derive(Debug, Clone)]
pub(crate) struct CanonicalUsageContext {
    pub effective_usage_base: Option<String>,
    pub effective_usage_source: Option<String>,
    pub updated_at_unix_ms: u64,
}

pub(crate) fn map_canonical_usage(
    root: &Value,
    mapping: &CanonicalUsageMapping,
    context: CanonicalUsageContext,
) -> Option<CanonicalProviderUsage> {
    if !mapping.requires_any.is_empty()
        && !mapping
            .requires_any
            .iter()
            .any(|pointer| value_at_pointer(root, pointer).is_some())
    {
        return None;
    }

    let usage = CanonicalProviderUsage {
        usage_kind: infer_usage_kind(root, mapping),
        plan_name: extract_string(root, mapping.plan_name),
        mode: extract_string(root, mapping.mode),
        currency_unit: extract_string(root, mapping.currency_unit),
        remaining: extract_number(root, mapping.remaining),
        today_used: extract_number(root, mapping.today_used),
        today_added: extract_number(root, mapping.today_added),
        daily_used: extract_number(root, mapping.daily_used),
        daily_limit: extract_number(root, mapping.daily_limit),
        weekly_used: extract_number(root, mapping.weekly_used),
        weekly_limit: extract_number(root, mapping.weekly_limit),
        monthly_used: extract_number(root, mapping.monthly_used),
        monthly_limit: extract_number(root, mapping.monthly_limit),
        expires_at_unix_ms: extract_unix_ms(root, mapping.expires_at_unix_ms),
        effective_usage_base: context.effective_usage_base,
        effective_usage_source: context.effective_usage_source,
        updated_at_unix_ms: context.updated_at_unix_ms,
    };

    if has_canonical_values(&usage) {
        Some(usage)
    } else {
        None
    }
}

fn infer_usage_kind(root: &Value, mapping: &CanonicalUsageMapping) -> UsageKind {
    if mapping.usage_kind != UsageKind::BalanceInfo {
        return mapping.usage_kind;
    }
    if extract_number(root, mapping.daily_used).is_some()
        || extract_number(root, mapping.daily_limit).is_some()
        || extract_number(root, mapping.monthly_used).is_some()
        || extract_number(root, mapping.monthly_limit).is_some()
    {
        UsageKind::BudgetInfo
    } else {
        UsageKind::BalanceInfo
    }
}

fn has_canonical_values(usage: &CanonicalProviderUsage) -> bool {
    usage.plan_name.is_some()
        || usage.mode.is_some()
        || usage.currency_unit.is_some()
        || usage.remaining.is_some()
        || usage.today_used.is_some()
        || usage.today_added.is_some()
        || usage.daily_used.is_some()
        || usage.daily_limit.is_some()
        || usage.weekly_used.is_some()
        || usage.weekly_limit.is_some()
        || usage.monthly_used.is_some()
        || usage.monthly_limit.is_some()
        || usage.expires_at_unix_ms.is_some()
}

fn extract_number(root: &Value, spec: Option<NumericFieldSpec>) -> Option<f64> {
    let spec = spec?;
    spec.aliases.iter().find_map(|pointer| {
        json_value_as_f64(value_at_pointer(root, pointer)).map(|value| match spec.transform {
            NumericTransform::None => value,
            NumericTransform::DivideBy(divisor) => value / divisor,
        })
    })
}

fn extract_string(root: &Value, spec: Option<StringFieldSpec>) -> Option<String> {
    let spec = spec?;
    spec.aliases.iter().find_map(|pointer| {
        value_at_pointer(root, pointer)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToString::to_string)
    })
}

fn extract_unix_ms(root: &Value, spec: Option<UnixMsFieldSpec>) -> Option<u64> {
    let spec = spec?;
    spec.aliases
        .iter()
        .find_map(|pointer| parse_unix_ms_from_value(value_at_pointer(root, pointer)))
        .or_else(|| {
            spec.rules
                .iter()
                .find_map(|rule| extract_unix_ms_from_rule(root, rule))
        })
}

fn extract_unix_ms_from_rule(root: &Value, rule: &UnixMsRule) -> Option<u64> {
    match rule {
        UnixMsRule::Pointer(pointer) => parse_unix_ms_from_value(value_at_pointer(root, pointer)),
        UnixMsRule::Array {
            pointer,
            item_pointer,
            aggregate,
            filter_pointer,
            filter_eq,
            filter_in,
        } => {
            let items = value_at_pointer(root, pointer)?.as_array()?;
            let mut values = items
                .iter()
                .filter(|item| {
                    unix_ms_rule_matches_filter(item, *filter_pointer, *filter_eq, filter_in)
                })
                .filter_map(|item| parse_unix_ms_from_value(value_at_pointer(item, item_pointer)));
            match aggregate {
                UnixMsAggregate::First => values.next(),
                UnixMsAggregate::Max => values.max(),
            }
        }
    }
}

fn unix_ms_rule_matches_filter(
    item: &Value,
    filter_pointer: Option<&str>,
    filter_eq: Option<&str>,
    filter_in: &[&str],
) -> bool {
    let Some(filter_pointer) = filter_pointer else {
        return true;
    };
    let Some(value) = value_at_pointer(item, filter_pointer)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return false;
    };
    if let Some(expected) = filter_eq {
        return value.eq_ignore_ascii_case(expected);
    }
    if !filter_in.is_empty() {
        return filter_in
            .iter()
            .any(|candidate| value.eq_ignore_ascii_case(candidate));
    }
    true
}

fn value_at_pointer<'a>(root: &'a Value, pointer: &str) -> Option<&'a Value> {
    root.pointer(pointer)
}

fn json_value_as_f64(value: Option<&Value>) -> Option<f64> {
    let value = value?;
    value
        .as_f64()
        .or_else(|| value.as_i64().map(|n| n as f64))
        .or_else(|| value.as_u64().map(|n| n as f64))
        .or_else(|| {
            value.as_str().and_then(|text| {
                let cleaned = text.trim().replace([',', '%'], "");
                if cleaned.is_empty() {
                    None
                } else {
                    cleaned.parse::<f64>().ok()
                }
            })
        })
}

fn parse_unix_ms_from_value(value: Option<&Value>) -> Option<u64> {
    let value = value?;
    if let Some(raw) = value.as_u64() {
        return Some(if raw < 1_000_000_000_000 {
            raw.saturating_mul(1000)
        } else {
            raw
        });
    }
    if let Some(raw) = value.as_i64() {
        if raw <= 0 {
            return None;
        }
        let raw = raw as u64;
        return Some(if raw < 1_000_000_000_000 {
            raw.saturating_mul(1000)
        } else {
            raw
        });
    }
    let text = value.as_str()?.trim();
    if text.is_empty() {
        return None;
    }
    if text.chars().all(|ch| ch.is_ascii_digit()) {
        let raw = text.parse::<u64>().ok()?;
        return Some(if raw < 1_000_000_000_000 {
            raw.saturating_mul(1000)
        } else {
            raw
        });
    }
    if let Ok(ts) = chrono::DateTime::parse_from_rfc3339(text) {
        let millis = ts.timestamp_millis();
        return (millis > 0).then_some(millis as u64);
    }
    if let Ok(ts) = chrono::NaiveDateTime::parse_from_str(text, "%Y-%m-%d %H:%M:%S") {
        let millis = ts.and_utc().timestamp_millis();
        return (millis > 0).then_some(millis as u64);
    }
    if let Ok(date) = chrono::NaiveDate::parse_from_str(text, "%Y-%m-%d") {
        let millis = date
            .and_hms_opt(12, 0, 0)
            .map(|dt| dt.and_utc().timestamp_millis())?;
        return (millis > 0).then_some(millis as u64);
    }
    None
}
