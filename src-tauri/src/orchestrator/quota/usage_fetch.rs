async fn fetch_token_stats_any(
    st: &GatewayState,
    provider_name: &str,
    bases: &[String],
    explicit_usage_endpoint: Option<&str>,
    provider_key: Option<&str>,
    usage_token: Option<&str>,
    package_expiry_strategy: PackageExpiryStrategy,
) -> QuotaSnapshot {
    let mut out = QuotaSnapshot::empty(UsageKind::TokenStats);
    if let Some(endpoint_url) = explicit_usage_endpoint {
        let direct = fetch_explicit_usage_endpoint_any(
            st,
            provider_name,
            endpoint_url,
            provider_key,
            usage_token,
        )
        .await;
        if direct.last_error.is_empty() {
            return direct;
        }
    }
    let Some(k) = provider_key else {
        out.last_error = "missing provider key".to_string();
        return out;
    };
    if bases.is_empty() {
        out.last_error = "missing quota base".to_string();
        return out;
    }

    let client = match build_usage_http_client(st, provider_name) {
        Ok(c) => c,
        Err(err) => {
            out.last_error = err;
            return out;
        }
    };

    let mut last_err = String::new();
    let mut saw_404 = false;
    let mut non_404_err: Option<String> = None;
    for base in bases {
        let base = base.trim_end_matches('/');
        if base.is_empty() {
            continue;
        }
        let url = format!(
            "{base}/api/token-stats?token_key={}",
            urlencoding::encode(k)
        );
        if let Err(err) = wait_for_usage_base_refresh_slot(base).await {
            last_err = err.clone();
            non_404_err.get_or_insert(err);
            continue;
        }
        match client
            .get(url)
            .timeout(Duration::from_secs(15))
            .send()
            .await
        {
            Ok(resp) => {
                let status = resp.status().as_u16();
                let backoff_ms = parse_rate_limit_backoff_ms(
                    resp.headers(),
                    unix_ms(),
                    USAGE_BASE_429_BACKOFF_MS,
                );
                let j = resp.json::<Value>().await.unwrap_or(Value::Null);
                if !(200..300).contains(&status) {
                    if status == 429 {
                        note_usage_base_rate_limited(base, unix_ms(), backoff_ms);
                    }
                    if status == 404 {
                        saw_404 = true;
                    } else {
                        non_404_err.get_or_insert_with(|| format!("http {status} from {base}"));
                    }
                    last_err = format!("http {status} from {base}");
                    continue;
                }

                if let Some((remaining, today_used, today_added)) = extract_token_stats(&j) {
                    out.remaining = remaining;
                    out.today_used = today_used;
                    out.today_added = today_added;
                    if let Some(token) = usage_token {
                        out.package_expires_at_unix_ms = fetch_package_expiry_for_strategy(
                            package_expiry_strategy,
                            st,
                            provider_name,
                            bases,
                            token,
                            Some(base),
                            None,
                        )
                        .await;
                    }
                    out.effective_usage_base = Some(base.to_string());
                    out.effective_usage_source = Some("token_stats".to_string());
                    out.updated_at_unix_ms = unix_ms();
                    out.last_error.clear();
                    return out;
                }

                if let Some((remaining, today_used, today_added)) =
                    fetch_token_logs_stats(&client, base, k).await
                {
                    out.remaining = remaining;
                    out.today_used = today_used;
                    out.today_added = today_added;
                    if let Some(token) = usage_token {
                        out.package_expires_at_unix_ms = fetch_package_expiry_for_strategy(
                            package_expiry_strategy,
                            st,
                            provider_name,
                            bases,
                            token,
                            Some(base),
                            None,
                        )
                        .await;
                    }
                    out.effective_usage_base = Some(base.to_string());
                    out.effective_usage_source = Some("token_stats".to_string());
                    out.updated_at_unix_ms = unix_ms();
                    out.last_error.clear();
                    return out;
                }

                last_err = format!("unexpected response from {base}");
                non_404_err.get_or_insert_with(|| last_err.clone());
                continue;
            }
            Err(e) => {
                last_err = format_reqwest_error_for_logs(&e);
                non_404_err.get_or_insert_with(|| last_err.clone());
                continue;
            }
        }
    }

    if let Some(err) = non_404_err {
        out.last_error = err;
    } else if last_err.is_empty() || (saw_404 && last_err == "http 404") {
        out.last_error = "usage endpoint not found (set Usage base URL)".to_string();
    } else {
        out.last_error = last_err;
    }
    out
}

fn apply_packycode_budget_payload(
    out: &mut QuotaSnapshot,
    root: &Value,
    base: &str,
    now_ms: u64,
) -> Result<(), String> {
    if root.get("daily_spent_usd").is_none()
        && root.get("monthly_spent_usd").is_none()
        && root.get("weekly_spent_usd").is_none()
        && root.get("weekly_spent").is_none()
    {
        return Err(format!("unexpected response from {base}"));
    }

    out.daily_spent_usd = as_f64(root.get("daily_spent_usd"));
    out.daily_budget_usd = as_f64(root.get("daily_budget_usd"));
    out.weekly_spent_usd =
        as_f64(root.get("weekly_spent_usd")).or_else(|| as_f64(root.get("weekly_spent")));
    out.weekly_budget_usd =
        as_f64(root.get("weekly_budget_usd")).or_else(|| as_f64(root.get("weekly_budget")));
    out.monthly_spent_usd = as_f64(root.get("monthly_spent_usd"));
    out.monthly_budget_usd = as_f64(root.get("monthly_budget_usd"));
    out.remaining = as_f64(root.get("remaining_quota"));
    out.effective_usage_base = Some(base.to_string());
    out.effective_usage_source = Some("usage_base".to_string());
    out.updated_at_unix_ms = now_ms;
    out.last_error.clear();
    Ok(())
}

fn apply_explicit_usage_endpoint_payload(
    out: &mut QuotaSnapshot,
    root: &Value,
    endpoint_url: &str,
    now_ms: u64,
) -> Result<(), String> {
    let normalize_money = |value: Option<f64>| {
        if endpoint_url
            .trim_end_matches('/')
            .to_ascii_lowercase()
            .ends_with("/user/api/v1/me")
        {
            value.map(|amount| amount / 100.0)
        } else {
            value
        }
    };
    let daily_budget_usd = root
        .pointer("/quota/daily_quota")
        .and_then(|value| as_f64(Some(value)))
        .or_else(|| {
            root.pointer("/daily_quota")
                .and_then(|value| as_f64(Some(value)))
        })
        .or_else(|| {
            root.pointer("/daily_budget_usd")
                .and_then(|value| as_f64(Some(value)))
        })
        .or_else(|| {
            root.pointer("/daily_limit_usd")
                .and_then(|value| as_f64(Some(value)))
        })
        .or_else(|| {
            root.pointer("/subscription/daily_limit_usd")
                .and_then(|value| as_f64(Some(value)))
        });
    let daily_spent_usd = root
        .pointer("/quota/daily_spent")
        .and_then(|value| as_f64(Some(value)))
        .or_else(|| {
            root.pointer("/quota/daily_total_spent")
                .and_then(|value| as_f64(Some(value)))
        })
        .or_else(|| {
            root.pointer("/usage/daily_spent")
                .and_then(|value| as_f64(Some(value)))
        })
        .or_else(|| {
            root.pointer("/usage/daily_total_spent")
                .and_then(|value| as_f64(Some(value)))
        })
        .or_else(|| {
            root.pointer("/daily_spent_usd")
                .and_then(|value| as_f64(Some(value)))
        })
        .or_else(|| {
            root.pointer("/daily_usage_usd")
                .and_then(|value| as_f64(Some(value)))
        })
        .or_else(|| {
            root.pointer("/subscription/daily_usage_usd")
                .and_then(|value| as_f64(Some(value)))
        });
    let remaining = root
        .pointer("/quota/daily_remaining")
        .and_then(|value| as_f64(Some(value)))
        .or_else(|| {
            root.pointer("/remaining")
                .and_then(|value| as_f64(Some(value)))
        })
        .or_else(|| {
            root.pointer("/remaining_quota")
                .and_then(|value| as_f64(Some(value)))
        })
        .or_else(|| {
            root.pointer("/balance")
                .and_then(|value| as_f64(Some(value)))
        });
    let package_expires_at_unix_ms = root
        .pointer("/timestamps/expires_at")
        .and_then(|value| parse_unix_ms_from_value(Some(value)))
        .or_else(|| parse_unix_ms_from_value(root.pointer("/expires_at")))
        .or_else(|| parse_unix_ms_from_value(root.pointer("/subscription/expires_at")));
    if daily_budget_usd.is_none()
        && daily_spent_usd.is_none()
        && remaining.is_none()
        && package_expires_at_unix_ms.is_none()
    {
        return Err(format!("unexpected response from {endpoint_url}"));
    }

    let daily_budget_usd = normalize_money(daily_budget_usd);
    let daily_spent_usd = normalize_money(daily_spent_usd);
    let remaining = normalize_money(remaining);

    out.kind = if daily_budget_usd.is_some() || daily_spent_usd.is_some() {
        UsageKind::BudgetInfo
    } else {
        UsageKind::BalanceInfo
    };
    out.remaining = remaining;
    out.daily_budget_usd = daily_budget_usd;
    out.daily_spent_usd = daily_spent_usd;
    out.package_expires_at_unix_ms = package_expires_at_unix_ms;
    out.effective_usage_base = Some(endpoint_url.to_string());
    out.effective_usage_source = Some("usage_base".to_string());
    out.updated_at_unix_ms = now_ms;
    out.last_error.clear();
    Ok(())
}

async fn fetch_explicit_usage_endpoint_any(
    st: &GatewayState,
    provider_name: &str,
    endpoint_url: &str,
    provider_key: Option<&str>,
    usage_token: Option<&str>,
) -> QuotaSnapshot {
    let mut out = QuotaSnapshot::empty(UsageKind::BudgetInfo);
    let endpoint_url = endpoint_url.trim().trim_end_matches('/');
    if endpoint_url.is_empty() {
        out.last_error = "missing quota base".to_string();
        return out;
    }

    let client = match build_usage_http_client(st, provider_name) {
        Ok(client) => client,
        Err(err) => {
            out.last_error = err;
            return out;
        }
    };

    let mut auth_candidates: Vec<&str> = Vec::new();
    if let Some(token) = usage_token.map(str::trim).filter(|token| !token.is_empty()) {
        auth_candidates.push(token);
    }
    if let Some(token) = provider_key
        .map(str::trim)
        .filter(|token| !token.is_empty())
    {
        if !auth_candidates.contains(&token) {
            auth_candidates.push(token);
        }
    }
    if auth_candidates.is_empty() {
        out.last_error = "missing credentials for quota refresh".to_string();
        return out;
    }

    let mut last_err = String::new();
    for token in auth_candidates {
        if let Err(err) = wait_for_usage_base_refresh_slot(endpoint_url).await {
            out.last_error = err;
            return out;
        }
        let resp = match client
            .get(endpoint_url)
            .header(reqwest::header::AUTHORIZATION, format!("Bearer {token}"))
            .timeout(Duration::from_secs(15))
            .send()
            .await
        {
            Ok(resp) => resp,
            Err(err) => {
                last_err = format_reqwest_error_for_logs(&err);
                continue;
            }
        };
        let status = resp.status().as_u16();
        let response_now_ms = unix_ms();
        let backoff_ms =
            parse_rate_limit_backoff_ms(resp.headers(), response_now_ms, USAGE_BASE_429_BACKOFF_MS);
        let payload = resp.json::<Value>().await.unwrap_or(Value::Null);
        if !(200..300).contains(&status) {
            if status == 429 {
                note_usage_base_rate_limited(endpoint_url, response_now_ms, backoff_ms);
            }
            last_err = format!("http {status} from {endpoint_url}");
            continue;
        }
        let root = payload.get("data").unwrap_or(&payload);
        match apply_explicit_usage_endpoint_payload(&mut out, root, endpoint_url, response_now_ms) {
            Ok(()) => return out,
            Err(err) => last_err = err,
        }
    }

    out.last_error = if last_err.is_empty() {
        format!("unexpected response from {endpoint_url}")
    } else {
        last_err
    };
    out
}

fn extract_token_stats(payload: &Value) -> Option<(Option<f64>, Option<f64>, Option<f64>)> {
    if let Some(info) = payload.pointer("/data/info") {
        if info.is_object() {
            let stats = payload
                .pointer("/data/stats/today_stats")
                .unwrap_or(&Value::Null);
            let remaining = as_f64(info.get("remain_quota_display"))
                .or_else(|| as_f64(info.get("remain_quota")));
            let today_used =
                as_f64(stats.get("used_quota")).or_else(|| as_f64(stats.get("used_quota_display")));
            let today_added = as_f64(stats.get("added_quota"))
                .or_else(|| as_f64(stats.get("added_quota_display")));
            return Some((remaining, today_used, today_added));
        }
    }

    let token_info = payload
        .pointer("/data/token_info")
        .or_else(|| payload.pointer("/data/data/token_info"))
        .or_else(|| payload.pointer("/token_info"));
    let token_info = token_info?;
    if !token_info.is_object() {
        return None;
    }

    let mut remaining = as_f64(token_info.get("remain_quota_display"))
        .or_else(|| as_f64(token_info.get("remain_quota")))
        .or_else(|| as_f64(token_info.get("remaining_quota")));
    let mut today_used = as_f64(token_info.get("today_used_quota"))
        .or_else(|| as_f64(token_info.get("today_used_quota_display")))
        .or_else(|| as_f64(token_info.get("used_quota")))
        .or_else(|| as_f64(token_info.get("used_quota_display")));
    let mut today_added = as_f64(token_info.get("today_added_quota"))
        .or_else(|| as_f64(token_info.get("today_added_quota_display")))
        .or_else(|| as_f64(token_info.get("added_quota")))
        .or_else(|| as_f64(token_info.get("added_quota_display")));
    let today_stats = payload
        .pointer("/data/today_stats")
        .or_else(|| payload.pointer("/data/stats/today_stats"));
    if let Some(stats) = today_stats {
        if today_used.is_none() {
            today_used =
                as_f64(stats.get("used_quota")).or_else(|| as_f64(stats.get("used_quota_display")));
        }
        if today_added.is_none() {
            today_added = as_f64(stats.get("added_quota"))
                .or_else(|| as_f64(stats.get("added_quota_display")));
        }
    }
    if remaining.is_none() {
        if let (Some(added), Some(used)) = (today_added, today_used) {
            remaining = Some(added - used);
        }
    }
    if remaining.is_none() && today_used.is_none() && today_added.is_none() {
        return None;
    }
    Some((remaining, today_used, today_added))
}

async fn fetch_token_logs_stats(
    client: &reqwest::Client,
    base: &str,
    token_key: &str,
) -> Option<(Option<f64>, Option<f64>, Option<f64>)> {
    let url = format!(
        "{base}/api/token-logs?token_key={}&page=1&page_size=1",
        urlencoding::encode(token_key)
    );
    if wait_for_usage_base_refresh_slot(base).await.is_err() {
        return None;
    }
    let resp = client
        .get(url)
        .timeout(Duration::from_secs(15))
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
    let j = resp.json::<Value>().await.ok()?;
    let token_info = j
        .pointer("/data/token_info")
        .or_else(|| j.pointer("/data/data/token_info"))
        .or_else(|| j.pointer("/token_info"))?;
    if !token_info.is_object() {
        return None;
    }

    let remaining = as_f64(token_info.get("remain_quota_display"))
        .or_else(|| as_f64(token_info.get("remain_quota")))
        .or_else(|| as_f64(token_info.get("remaining_quota")));
    let today_used = as_f64(token_info.get("today_used_quota"))
        .or_else(|| as_f64(token_info.get("today_used_quota_display")))
        .or_else(|| as_f64(token_info.get("used_quota")))
        .or_else(|| as_f64(token_info.get("used_quota_display")));
    let today_added = as_f64(token_info.get("today_added_quota"))
        .or_else(|| as_f64(token_info.get("today_added_quota_display")))
        .or_else(|| as_f64(token_info.get("added_quota")))
        .or_else(|| as_f64(token_info.get("added_quota_display")));
    if remaining.is_none() && today_used.is_none() && today_added.is_none() {
        return None;
    }
    Some((remaining, today_used, today_added))
}

fn build_codex_for_me_api_url(base: &str, endpoint: &str) -> Option<String> {
    let trimmed = base.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return None;
    }
    let normalized_base = if trimmed.ends_with("/web/api/v1") {
        trimmed.to_string()
    } else {
        format!("{trimmed}/web/api/v1")
    };
    let url = reqwest::Url::parse(&format!(
        "{normalized_base}/{}",
        endpoint.trim_start_matches('/')
    ))
    .ok()?;
    Some(url.to_string())
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

async fn fetch_codex_for_me_login_token(
    client: &reqwest::Client,
    base: &str,
    login: &UsageLoginConfig,
) -> Result<String, String> {
    let url = build_codex_for_me_api_url(base, "users/login")
        .ok_or_else(|| format!("invalid usage base: {base}"))?;
    wait_for_usage_base_refresh_slot(base).await?;
    let resp = client
        .post(url)
        .json(&serde_json::json!({
            "user_name": login.username.trim(),
            "password": login.password,
        }))
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|err| format_reqwest_error_for_logs(&err))?;
    let status = resp.status().as_u16();
    let backoff_ms =
        parse_rate_limit_backoff_ms(resp.headers(), unix_ms(), USAGE_BASE_429_BACKOFF_MS);
    let payload = resp.json::<Value>().await.unwrap_or(Value::Null);
    if !(200..300).contains(&status) {
        if status == 429 {
            note_usage_base_rate_limited(base, unix_ms(), backoff_ms);
        }
        return Err(format!("http {status} from {base}"));
    }
    payload
        .get("token")
        .and_then(Value::as_str)
        .or_else(|| payload.pointer("/data/token").and_then(Value::as_str))
        .map(|token| token.trim().to_string())
        .filter(|token| !token.is_empty())
        .ok_or_else(|| format!("unexpected response from {base}"))
}

async fn fetch_codex_for_me_summary(
    client: &reqwest::Client,
    base: &str,
    token: &str,
) -> Result<Value, String> {
    let url = build_codex_for_me_api_url(base, "users/summary")
        .ok_or_else(|| format!("invalid usage base: {base}"))?;
    wait_for_usage_base_refresh_slot(base).await?;
    let resp = client
        .get(url)
        .header(reqwest::header::AUTHORIZATION, format!("Bearer {token}"))
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|err| format_reqwest_error_for_logs(&err))?;
    let status = resp.status().as_u16();
    let backoff_ms =
        parse_rate_limit_backoff_ms(resp.headers(), unix_ms(), USAGE_BASE_429_BACKOFF_MS);
    let payload = resp.json::<Value>().await.unwrap_or(Value::Null);
    if !(200..300).contains(&status) {
        if status == 429 {
            note_usage_base_rate_limited(base, unix_ms(), backoff_ms);
        }
        return Err(format!("http {status} from {base}"));
    }
    Ok(payload)
}

struct CodexForMeSummarySnapshot {
    balance: Option<f64>,
    expires_at_unix_ms: Option<u64>,
    daily_budget_usd: Option<f64>,
    daily_spent_usd: Option<f64>,
    total_spent_usd: Option<f64>,
}

fn extract_codex_for_me_summary_snapshot(root: &Value) -> Option<CodexForMeSummarySnapshot> {
    let summary = root.get("data").unwrap_or(root);
    let balance = as_f64(summary.get("card_balance")).or_else(|| as_f64(summary.get("balance")));
    let expires_at_unix_ms = parse_unix_ms_from_value(summary.get("card_expire_date"))
        .or_else(|| parse_unix_ms_from_value(summary.get("expire_date")));
    let daily_budget_usd = as_f64(summary.get("card_daily_limit"))
        .or_else(|| as_f64(summary.get("daily_limit")))
        .or_else(|| as_f64(summary.get("daily_budget_usd")));
    let daily_spent_usd = as_f64(summary.get("today_spent_amount"))
        .or_else(|| as_f64(summary.get("today_total_amount")))
        .or_else(|| as_f64(summary.get("daily_spent_usd")));
    let total_spent_usd = as_f64(summary.get("card_total_spent_amount"))
        .or_else(|| as_f64(summary.get("this_month_total_amount")))
        .or_else(|| as_f64(summary.get("total_spent_amount")))
        .or_else(|| as_f64(summary.get("monthly_spent_usd")));
    if balance.is_none()
        && expires_at_unix_ms.is_none()
        && daily_budget_usd.is_none()
        && daily_spent_usd.is_none()
        && total_spent_usd.is_none()
    {
        return None;
    }
    Some(CodexForMeSummarySnapshot {
        balance,
        expires_at_unix_ms,
        daily_budget_usd,
        daily_spent_usd,
        total_spent_usd,
    })
}

async fn fetch_codex_for_me_balance_any(
    st: &GatewayState,
    provider_name: &str,
    bases: &[String],
    usage_token: Option<&str>,
    usage_login: Option<&UsageLoginConfig>,
) -> QuotaSnapshot {
    let mut out = QuotaSnapshot::empty(UsageKind::BalanceInfo);
    if bases.is_empty() {
        out.last_error = "missing quota base".to_string();
        return out;
    }
    if usage_token.is_none() && usage_login.is_none() {
        out.last_error = "missing usage auth".to_string();
        return out;
    }

    let client = match build_usage_http_client(st, provider_name) {
        Ok(client) => client,
        Err(err) => {
            out.last_error = err;
            return out;
        }
    };

    let mut last_err = String::new();
    let mut saw_404 = false;
    let mut non_404_err: Option<String> = None;
    for base in bases {
        let base = base.trim().trim_end_matches('/');
        if base.is_empty() {
            continue;
        }

        let mut token = usage_token.map(ToString::to_string);
        let mut login_attempted = false;
        if token.is_none() {
            if let Some(login) = usage_login {
                login_attempted = true;
                match fetch_codex_for_me_login_token(&client, base, login).await {
                    Ok(found) => token = Some(found),
                    Err(err) => {
                        last_err = err.clone();
                        if !err.contains("http 404") {
                            non_404_err.get_or_insert(err);
                        } else {
                            saw_404 = true;
                        }
                        continue;
                    }
                }
            }
        }

        let Some(token) = token else {
            last_err = "missing usage auth".to_string();
            non_404_err.get_or_insert_with(|| last_err.clone());
            continue;
        };

        let payload = match fetch_codex_for_me_summary(&client, base, &token).await {
            Ok(payload) => Ok(payload),
            Err(err) if !login_attempted && err.contains("http 401") && usage_login.is_some() => {
                let login = usage_login.expect("checked is_some");
                match fetch_codex_for_me_login_token(&client, base, login).await {
                    Ok(fresh_token) => {
                        fetch_codex_for_me_summary(&client, base, &fresh_token).await
                    }
                    Err(login_err) => Err(login_err),
                }
            }
            Err(err) => Err(err),
        };

        match payload {
            Ok(payload) => {
                let Some(summary) = extract_codex_for_me_summary_snapshot(&payload) else {
                    last_err = format!("unexpected response from {base}");
                    non_404_err.get_or_insert_with(|| last_err.clone());
                    continue;
                };
                out.kind = if summary.daily_budget_usd.is_some()
                    || summary.daily_spent_usd.is_some()
                    || summary.total_spent_usd.is_some()
                {
                    UsageKind::BudgetInfo
                } else {
                    UsageKind::BalanceInfo
                };
                out.remaining = summary.balance;
                out.daily_budget_usd = summary.daily_budget_usd;
                out.daily_spent_usd = summary.daily_spent_usd;
                out.monthly_spent_usd = summary.total_spent_usd;
                out.monthly_budget_usd = match (summary.balance, summary.total_spent_usd) {
                    (Some(balance), Some(spent)) => Some(balance + spent),
                    _ => None,
                };
                out.package_expires_at_unix_ms = summary.expires_at_unix_ms;
                out.effective_usage_base = Some(base.to_string());
                out.effective_usage_source = Some("codex_for_me_balance".to_string());
                out.updated_at_unix_ms = unix_ms();
                out.last_error.clear();
                return out;
            }
            Err(err) => {
                if err.contains("http 404") {
                    saw_404 = true;
                } else {
                    non_404_err.get_or_insert_with(|| err.clone());
                }
                last_err = err;
            }
        }
    }

    if let Some(err) = non_404_err {
        out.last_error = err;
    } else if saw_404 || last_err.is_empty() {
        out.last_error = "usage endpoint not found (set Usage base URL)".to_string();
    } else {
        out.last_error = last_err;
    }
    out
}

async fn fetch_budget_info_any(
    st: &GatewayState,
    provider_name: &str,
    bases: &[String],
    usage_token: Option<&str>,
    package_expiry_strategy: PackageExpiryStrategy,
) -> QuotaSnapshot {
    let mut out = QuotaSnapshot::empty(UsageKind::BudgetInfo);
    let Some(usage_token) = usage_token.map(str::trim).filter(|value| !value.is_empty()) else {
        out.last_error = "missing usage token".to_string();
        return out;
    };
    if bases.is_empty() {
        out.last_error = "missing quota base".to_string();
        return out;
    }

    let client = match build_usage_http_client(st, provider_name) {
        Ok(c) => c,
        Err(err) => {
            out.last_error = err;
            return out;
        }
    };

    let mut last_err = String::new();
    let mut saw_404 = false;
    let mut non_404_err: Option<String> = None;

    for base in bases {
        let base = base.trim_end_matches('/');
        if base.is_empty() {
            continue;
        }
        let url = format!("{base}/api/backend/users/info");
        if let Err(err) = wait_for_usage_base_refresh_slot(base).await {
            last_err = err.clone();
            non_404_err.get_or_insert(err);
            continue;
        }
        match client
            .get(&url)
            .header(reqwest::header::AUTHORIZATION, format!("Bearer {usage_token}"))
            .timeout(Duration::from_secs(15))
            .send()
            .await
        {
            Ok(resp) => {
                let status = resp.status().as_u16();
                let response_now_ms = unix_ms();
                let backoff_ms = parse_rate_limit_backoff_ms(
                    resp.headers(),
                    response_now_ms,
                    USAGE_BASE_429_BACKOFF_MS,
                );
                let j = resp.json::<Value>().await.unwrap_or(Value::Null);
                if !(200..300).contains(&status) {
                    if status == 429 {
                        note_usage_base_rate_limited(base, response_now_ms, backoff_ms);
                    }
                    if status == 404 {
                        saw_404 = true;
                    } else {
                        non_404_err.get_or_insert_with(|| format!("http {status} from {base}"));
                    }
                    last_err = format!("http {status} from {base}");
                    continue;
                }

                // Some endpoints wrap the payload in { success, data }.
                let root = j.get("data").unwrap_or(&j);
                if let Err(err) =
                    apply_packycode_budget_payload(&mut out, root, base, response_now_ms)
                {
                    last_err = err.clone();
                    non_404_err.get_or_insert(err);
                    continue;
                }
                out.package_expires_at_unix_ms = fetch_package_expiry_for_strategy(
                    package_expiry_strategy,
                    st,
                    provider_name,
                    bases,
                    usage_token,
                    Some(base),
                    Some(root),
                )
                .await;
                return out;
            }
            Err(e) => {
                last_err = format_reqwest_error_for_logs(&e);
                non_404_err.get_or_insert_with(|| last_err.clone());
                continue;
            }
        }
    }

    if let Some(err) = non_404_err {
        out.last_error = err;
    } else if last_err.is_empty() || (saw_404 && last_err == "http 404") {
        out.last_error = "usage endpoint not found (set Usage base URL)".to_string();
    } else {
        out.last_error = last_err;
    }
    out
}

fn as_f64(v: Option<&Value>) -> Option<f64> {
    let v = v?;
    v.as_f64()
        .or_else(|| v.as_i64().map(|n| n as f64))
        .or_else(|| v.as_u64().map(|n| n as f64))
        .or_else(|| {
            v.as_str().and_then(|s| {
                let cleaned = s.trim().replace([',', '%'], "");
                if cleaned.is_empty() {
                    None
                } else {
                    cleaned.parse::<f64>().ok()
                }
            })
        })
}

#[cfg(test)]
mod usage_fetch_tests {
    #[tokio::test]
    async fn budget_info_without_usage_token_reports_missing_usage_token() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let config_path = tmp.path().join("user-data").join("config.toml");
        let data_dir = tmp.path().join("data");
        let state = crate::app_state::build_state(config_path, data_dir).expect("build state");

        let snapshot = super::fetch_budget_info_any(
            &state.gateway,
            "official",
            &["https://usage.example.test".to_string()],
            None,
            crate::orchestrator::quota::PackageExpiryStrategy::None,
        )
        .await;

        assert_eq!(snapshot.last_error, "missing usage token");
    }
}
