#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PackageExpiryStrategy {
    None,
    Packycode,
}

fn detect_package_expiry_strategy(base_url: &str) -> PackageExpiryStrategy {
    if is_packycode_base(base_url) {
        PackageExpiryStrategy::Packycode
    } else {
        PackageExpiryStrategy::None
    }
}

async fn fetch_package_expiry_for_strategy(
    strategy: PackageExpiryStrategy,
    st: &GatewayState,
    provider_name: &str,
    bases: &[String],
    token: &str,
    preferred_base: Option<&str>,
    budget_root: Option<&Value>,
) -> Option<u64> {
    match strategy {
        PackageExpiryStrategy::None => None,
        PackageExpiryStrategy::Packycode => {
            fetch_packycode_package_expiry(
                st,
                provider_name,
                bases,
                token,
                preferred_base,
                budget_root,
            )
            .await
        }
    }
}

async fn fetch_packycode_package_expiry(
    st: &GatewayState,
    provider_name: &str,
    bases: &[String],
    token: &str,
    preferred_base: Option<&str>,
    budget_root: Option<&Value>,
) -> Option<u64> {
    if let Some(root) = budget_root {
        if let Some(expiry) = extract_packycode_package_expiry_from_value(root) {
            return Some(expiry);
        }
    }

    let mut ordered_bases: Vec<String> = Vec::new();
    let mut push_unique = |value: &str| {
        let trimmed = value.trim().trim_end_matches('/');
        if trimmed.is_empty() {
            return;
        }
        if ordered_bases.iter().any(|base| base == trimmed) {
            return;
        }
        ordered_bases.push(trimmed.to_string());
    };
    if let Some(base) = preferred_base {
        push_unique(base);
    }
    for base in bases {
        push_unique(base);
    }

    for base in ordered_bases {
        if let Some(found) = fetch_packycode_expiry_from_user_info(st, provider_name, &base, token).await {
            return Some(found);
        }
        if let Some(found) = fetch_packycode_expiry_from_subscriptions(st, provider_name, &base, token).await {
            return Some(found);
        }
    }
    None
}

async fn fetch_packycode_expiry_from_user_info(
    st: &GatewayState,
    provider_name: &str,
    base: &str,
    token: &str,
) -> Option<u64> {
    const PACKAGE_EXPIRY_TIMEOUT_SECS: u64 = 8;
    let client = build_usage_http_client(st, provider_name).ok()?;
    let url = format!("{base}/api/backend/users/info");
    if wait_for_usage_base_refresh_slot(base).await.is_err() {
        return None;
    }
    let resp = client
        .get(url)
        .header(reqwest::header::AUTHORIZATION, format!("Bearer {token}"))
        .timeout(Duration::from_secs(PACKAGE_EXPIRY_TIMEOUT_SECS))
        .send()
        .await
        .ok()?;
    if resp.status().as_u16() == 429 {
        let backoff_ms =
            parse_rate_limit_backoff_ms(resp.headers(), unix_ms(), USAGE_BASE_429_BACKOFF_MS);
        note_usage_base_rate_limited(base, unix_ms(), backoff_ms);
    }
    if !resp.status().is_success() {
        return None;
    }
    let payload = resp.json::<Value>().await.ok()?;
    let root = payload.get("data").unwrap_or(&payload);
    extract_packycode_package_expiry_from_value(root)
}

async fn fetch_packycode_expiry_from_subscriptions(
    st: &GatewayState,
    provider_name: &str,
    base: &str,
    token: &str,
) -> Option<u64> {
    const PACKAGE_EXPIRY_TIMEOUT_SECS: u64 = 8;
    let client = build_usage_http_client(st, provider_name).ok()?;
    let url = format!("{base}/api/backend/subscriptions?page=1&per_page=50");
    if wait_for_usage_base_refresh_slot(base).await.is_err() {
        return None;
    }
    let resp = client
        .get(url)
        .header(reqwest::header::AUTHORIZATION, format!("Bearer {token}"))
        .timeout(Duration::from_secs(PACKAGE_EXPIRY_TIMEOUT_SECS))
        .send()
        .await
        .ok()?;
    if resp.status().as_u16() == 429 {
        let backoff_ms =
            parse_rate_limit_backoff_ms(resp.headers(), unix_ms(), USAGE_BASE_429_BACKOFF_MS);
        note_usage_base_rate_limited(base, unix_ms(), backoff_ms);
    }
    if !resp.status().is_success() {
        return None;
    }
    let payload = resp.json::<Value>().await.ok()?;
    let rows = payload
        .get("data")
        .and_then(Value::as_array)
        .or_else(|| payload.as_array())
        .cloned()
        .unwrap_or_default();
    let mut best: Option<u64> = None;
    for row in rows {
        let status = row
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        if status != "active" {
            continue;
        }
        let Some(end) = parse_packycode_unix_ms_any(row.get("current_period_end")) else {
            continue;
        };
        best = Some(best.map_or(end, |prev| prev.max(end)));
    }
    best
}

fn extract_packycode_package_expiry_from_value(root: &Value) -> Option<u64> {
    parse_packycode_unix_ms_any(root.get("package_expires_at_unix_ms"))
        .or_else(|| parse_packycode_unix_ms_any(root.get("plan_expires_at")))
        .or_else(|| parse_packycode_unix_ms_any(root.get("plan_expire_at")))
        .or_else(|| parse_packycode_unix_ms_any(root.get("expires_at")))
        .or_else(|| parse_packycode_unix_ms_any(root.get("current_period_end")))
}

fn parse_packycode_unix_ms_any(v: Option<&Value>) -> Option<u64> {
    let value = v?;
    if let Some(ms) = value.as_u64() {
        if ms == 0 {
            return None;
        }
        return Some(normalize_packycode_unix_ms(ms));
    }
    if let Some(ms) = value.as_i64() {
        if ms <= 0 {
            return None;
        }
        let ms = ms as u64;
        return Some(normalize_packycode_unix_ms(ms));
    }
    let text = value.as_str()?.trim();
    if text.is_empty() {
        return None;
    }
    if text.chars().all(|c| c.is_ascii_digit()) {
        let ms = text.parse::<u64>().ok()?;
        if ms == 0 {
            return None;
        }
        return Some(normalize_packycode_unix_ms(ms));
    }
    let ts = chrono::DateTime::parse_from_rfc3339(text)
        .ok()?
        .timestamp_millis();
    if ts <= 0 {
        return None;
    }
    Some(ts as u64)
}

fn normalize_packycode_unix_ms(raw: u64) -> u64 {
    if raw < 1_000_000_000_000 {
        raw * 1000
    } else {
        raw
    }
}

#[cfg(test)]
mod package_expiry_tests {
    use super::*;

    #[test]
    fn parse_packycode_unix_ms_rejects_zero_number() {
        let v = serde_json::json!(0);
        assert_eq!(parse_packycode_unix_ms_any(Some(&v)), None);
    }

    #[test]
    fn parse_packycode_unix_ms_rejects_zero_digit_string() {
        let v = serde_json::json!("0");
        assert_eq!(parse_packycode_unix_ms_any(Some(&v)), None);
    }
}
