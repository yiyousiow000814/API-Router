async fn fetch_token_stats_any(
    bases: &[String],
    provider_key: Option<&str>,
    usage_token: Option<&str>,
    supports_package_expiry: bool,
) -> QuotaSnapshot {
    let mut out = QuotaSnapshot::empty(UsageKind::TokenStats);
    let Some(k) = provider_key else {
        out.last_error = "missing provider key".to_string();
        return out;
    };
    if bases.is_empty() {
        out.last_error = "missing quota base".to_string();
        return out;
    }

    let client = match reqwest::Client::builder()
        .user_agent("api-router/0.1")
        .build()
    {
        Ok(c) => c,
        Err(_) => {
            out.last_error = "failed to build http client".to_string();
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
        match client
            .get(url)
            .timeout(Duration::from_secs(15))
            .send()
            .await
        {
            Ok(resp) => {
                let status = resp.status().as_u16();
                let j = resp.json::<Value>().await.unwrap_or(Value::Null);
                if !(200..300).contains(&status) {
                    if status == 404 {
                        saw_404 = true;
                    } else {
                        non_404_err.get_or_insert_with(|| format!("http {status}"));
                    }
                    last_err = format!("http {status}");
                    continue;
                }

                if let Some((remaining, today_used, today_added)) = extract_token_stats(&j) {
                    out.remaining = remaining;
                    out.today_used = today_used;
                    out.today_added = today_added;
                    if supports_package_expiry {
                        if let Some(token) = usage_token {
                            out.package_expires_at_unix_ms =
                                fetch_package_expiry_any(&client, bases, token, Some(base)).await;
                        }
                    }
                    out.effective_usage_base = Some(base.to_string());
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
                    if supports_package_expiry {
                        if let Some(token) = usage_token {
                            out.package_expires_at_unix_ms =
                                fetch_package_expiry_any(&client, bases, token, Some(base)).await;
                        }
                    }
                    out.effective_usage_base = Some(base.to_string());
                    out.updated_at_unix_ms = unix_ms();
                    out.last_error.clear();
                    return out;
                }

                last_err = "unexpected response".to_string();
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
    let resp = client
        .get(url)
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .ok()?;
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

async fn fetch_budget_info_any(
    bases: &[String],
    jwt: Option<&str>,
    supports_package_expiry: bool,
) -> QuotaSnapshot {
    let mut out = QuotaSnapshot::empty(UsageKind::BudgetInfo);
    let Some(token) = jwt else {
        out.last_error = "missing usage token".to_string();
        return out;
    };
    if bases.is_empty() {
        out.last_error = "missing quota base".to_string();
        return out;
    }

    let client = match reqwest::Client::builder()
        .user_agent("api-router/0.1")
        .build()
    {
        Ok(c) => c,
        Err(_) => {
            out.last_error = "failed to build http client".to_string();
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
        match client
            .get(url)
            .header(reqwest::header::AUTHORIZATION, format!("Bearer {token}"))
            .timeout(Duration::from_secs(15))
            .send()
            .await
        {
            Ok(resp) => {
                let status = resp.status().as_u16();
                let j = resp.json::<Value>().await.unwrap_or(Value::Null);
                if !(200..300).contains(&status) {
                    if status == 404 {
                        saw_404 = true;
                    } else {
                        non_404_err.get_or_insert_with(|| format!("http {status}"));
                    }
                    last_err = format!("http {status}");
                    continue;
                }

                // Some endpoints wrap the payload in { success, data }.
                let root = j.get("data").unwrap_or(&j);
                // Ensure this looks like a budget response to avoid mis-detecting.
                if root.get("daily_spent_usd").is_none()
                    && root.get("monthly_spent_usd").is_none()
                    && root.get("weekly_spent_usd").is_none()
                    && root.get("weekly_spent").is_none()
                {
                    last_err = "unexpected response".to_string();
                    non_404_err.get_or_insert_with(|| last_err.clone());
                    continue;
                }

                out.daily_spent_usd = as_f64(root.get("daily_spent_usd"));
                out.daily_budget_usd = as_f64(root.get("daily_budget_usd"));
                out.weekly_spent_usd = as_f64(root.get("weekly_spent_usd"))
                    .or_else(|| as_f64(root.get("weekly_spent")));
                out.weekly_budget_usd = as_f64(root.get("weekly_budget_usd"))
                    .or_else(|| as_f64(root.get("weekly_budget")));
                out.monthly_spent_usd = as_f64(root.get("monthly_spent_usd"));
                out.monthly_budget_usd = as_f64(root.get("monthly_budget_usd"));
                out.remaining = as_f64(root.get("remaining_quota"));
                out.package_expires_at_unix_ms = if supports_package_expiry {
                    if let Some(expiry) = extract_package_expiry_from_value(root) {
                        Some(expiry)
                    } else {
                        fetch_package_expiry_any(&client, bases, token, Some(base)).await
                    }
                } else {
                    None
                };
                out.effective_usage_base = Some(base.to_string());
                out.updated_at_unix_ms = unix_ms();
                out.last_error.clear();
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

async fn fetch_package_expiry_any(
    client: &reqwest::Client,
    bases: &[String],
    token: &str,
    preferred_base: Option<&str>,
) -> Option<u64> {
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
        if let Some(found) = fetch_package_expiry_from_user_info(client, &base, token).await {
            return Some(found);
        }
        if let Some(found) = fetch_package_expiry_unix_ms_for_base(client, &base, token).await {
            return Some(found);
        }
    }
    None
}

async fn fetch_package_expiry_from_user_info(
    client: &reqwest::Client,
    base: &str,
    token: &str,
) -> Option<u64> {
    const PACKAGE_EXPIRY_TIMEOUT_SECS: u64 = 8;
    let url = format!("{base}/api/backend/users/info");
    let resp = client
        .get(url)
        .header(reqwest::header::AUTHORIZATION, format!("Bearer {token}"))
        .timeout(Duration::from_secs(PACKAGE_EXPIRY_TIMEOUT_SECS))
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let payload = resp.json::<Value>().await.ok()?;
    let root = payload.get("data").unwrap_or(&payload);
    extract_package_expiry_from_value(root)
}

async fn fetch_package_expiry_unix_ms_for_base(
    client: &reqwest::Client,
    base: &str,
    token: &str,
) -> Option<u64> {
    const PACKAGE_EXPIRY_TIMEOUT_SECS: u64 = 8;
    let url = format!("{base}/api/backend/subscriptions?page=1&per_page=50");
    let resp = client
        .get(url)
        .header(reqwest::header::AUTHORIZATION, format!("Bearer {token}"))
        .timeout(Duration::from_secs(PACKAGE_EXPIRY_TIMEOUT_SECS))
        .send()
        .await
        .ok()?;
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
        let Some(end) = parse_unix_ms_any(row.get("current_period_end")) else {
            continue;
        };
        best = Some(best.map_or(end, |prev| prev.max(end)));
    }
    best
}

fn extract_package_expiry_from_value(root: &Value) -> Option<u64> {
    parse_unix_ms_any(root.get("package_expires_at_unix_ms"))
        .or_else(|| parse_unix_ms_any(root.get("plan_expires_at")))
        .or_else(|| parse_unix_ms_any(root.get("plan_expire_at")))
        .or_else(|| parse_unix_ms_any(root.get("expires_at")))
        .or_else(|| parse_unix_ms_any(root.get("current_period_end")))
}

fn parse_unix_ms_any(v: Option<&Value>) -> Option<u64> {
    let value = v?;
    if let Some(ms) = value.as_u64() {
        return Some(if ms < 1_000_000_000_000 { ms * 1000 } else { ms });
    }
    if let Some(ms) = value.as_i64() {
        if ms <= 0 {
            return None;
        }
        let ms = ms as u64;
        return Some(if ms < 1_000_000_000_000 { ms * 1000 } else { ms });
    }
    let text = value.as_str()?.trim();
    if text.is_empty() {
        return None;
    }
    if text.chars().all(|c| c.is_ascii_digit()) {
        let ms = text.parse::<u64>().ok()?;
        return Some(if ms < 1_000_000_000_000 { ms * 1000 } else { ms });
    }
    let ts = chrono::DateTime::parse_from_rfc3339(text)
        .ok()?
        .timestamp_millis();
    if ts <= 0 {
        return None;
    }
    Some(ts as u64)
}
