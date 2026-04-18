struct TokenStatsFetchConfig<'a> {
    explicit_usage_endpoint: Option<&'a str>,
    explicit_usage_mapping: Option<&'static CanonicalUsageMapping>,
    provider_key: Option<&'a str>,
    usage_token: Option<&'a str>,
    package_expiry_strategy: PackageExpiryStrategy,
}

async fn fetch_token_stats_any(
    st: &GatewayState,
    provider_name: &str,
    bases: &[String],
    config: TokenStatsFetchConfig<'_>,
) -> QuotaSnapshot {
    let mut out = QuotaSnapshot::empty(UsageKind::TokenStats);
    if let Some(endpoint_url) = config.explicit_usage_endpoint {
        let direct = fetch_explicit_usage_endpoint_any(
            st,
            provider_name,
            endpoint_url,
            config
                .explicit_usage_mapping
                .unwrap_or_else(|| super::providers::explicit_usage_mapping(endpoint_url)),
            config.provider_key,
            config.usage_token,
        )
        .await;
        if direct.last_error.is_empty() {
            return direct;
        }
    }
    let Some(k) = config.provider_key else {
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
                    if let Some(token) = config.usage_token {
                        out.package_expires_at_unix_ms = fetch_package_expiry_for_strategy(
                            config.package_expiry_strategy,
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
                    if let Some(token) = config.usage_token {
                        out.package_expires_at_unix_ms = fetch_package_expiry_for_strategy(
                            config.package_expiry_strategy,
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

fn snapshot_from_canonical_usage(usage: CanonicalProviderUsage) -> QuotaSnapshot {
    QuotaSnapshot::from_canonical(usage)
}

fn map_snapshot_from_usage_payload(
    root: &Value,
    mapping: &CanonicalUsageMapping,
    effective_usage_base: &str,
    effective_usage_source: &str,
    now_ms: u64,
) -> Option<QuotaSnapshot> {
    map_canonical_usage(
        root,
        mapping,
        CanonicalUsageContext {
            effective_usage_base: Some(effective_usage_base.to_string()),
            effective_usage_source: Some(effective_usage_source.to_string()),
            updated_at_unix_ms: now_ms,
        },
    )
    .map(snapshot_from_canonical_usage)
}

async fn fetch_explicit_usage_endpoint_any(
    st: &GatewayState,
    provider_name: &str,
    endpoint_url: &str,
    mapping: &'static CanonicalUsageMapping,
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
        if let Some(snapshot) = map_snapshot_from_usage_payload(
            root,
            mapping,
            endpoint_url,
            "usage_base",
            response_now_ms,
        ) {
            return snapshot;
        }
        last_err = format!("unexpected response from {endpoint_url}");
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

fn build_login_summary_api_url(base: &str, endpoint: &str) -> Option<String> {
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

async fn fetch_login_summary_token(
    client: &reqwest::Client,
    base: &str,
    login: &UsageLoginConfig,
) -> Result<String, String> {
    let url = build_login_summary_api_url(base, "users/login")
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

async fn fetch_login_summary_payload(
    client: &reqwest::Client,
    base: &str,
    token: &str,
) -> Result<Value, String> {
    let url = build_login_summary_api_url(base, "users/summary")
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

fn build_provider_key_card_login_api_url(base: &str, endpoint: &str) -> Option<String> {
    let trimmed = base.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return None;
    }
    let url = reqwest::Url::parse(&format!(
        "{trimmed}/{}",
        endpoint.trim_start_matches('/')
    ))
    .ok()?;
    Some(url.to_string())
}

async fn fetch_provider_key_card_login_token(
    client: &reqwest::Client,
    base: &str,
    provider_key: &str,
) -> Result<String, String> {
    let url = build_provider_key_card_login_api_url(base, "api/users/card-login")
        .ok_or_else(|| format!("invalid usage base: {base}"))?;
    wait_for_usage_base_refresh_slot(base).await?;
    let resp = client
        .post(url)
        .json(&serde_json::json!({
            "card": provider_key.trim(),
            "agent": "main",
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
        .pointer("/data/token")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|token| !token.is_empty())
        .map(ToString::to_string)
        .ok_or_else(|| format!("unexpected response from {base}"))
}

async fn fetch_provider_key_card_summary_payload(
    client: &reqwest::Client,
    base: &str,
    token: &str,
) -> Result<Value, String> {
    let url = build_provider_key_card_login_api_url(base, "api/users/whoami")
        .ok_or_else(|| format!("invalid usage base: {base}"))?;
    wait_for_usage_base_refresh_slot(base).await?;
    let resp = client
        .get(url)
        .header("x-auth-token", token.trim())
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

async fn fetch_provider_key_card_login_summary_any(
    st: &GatewayState,
    provider_name: &str,
    bases: &[String],
    provider_key: Option<&str>,
    summary_mapping: Option<&'static CanonicalUsageMapping>,
) -> QuotaSnapshot {
    let mut out = QuotaSnapshot::empty(UsageKind::BalanceInfo);
    let Some(provider_key) = provider_key
        .map(str::trim)
        .filter(|provider_key| !provider_key.is_empty())
    else {
        out.last_error = "missing provider key".to_string();
        return out;
    };
    if bases.is_empty() {
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

    let mut last_err = String::new();
    let mut saw_404 = false;
    let mut non_404_err: Option<String> = None;
    for base in bases {
        let base = base.trim().trim_end_matches('/');
        if base.is_empty() {
            continue;
        }

        let token = match fetch_provider_key_card_login_token(&client, base, provider_key).await {
            Ok(token) => token,
            Err(err) => {
                last_err = err.clone();
                if !err.contains("http 404") {
                    non_404_err.get_or_insert(err);
                } else {
                    saw_404 = true;
                }
                continue;
            }
        };

        match fetch_provider_key_card_summary_payload(&client, base, &token).await {
            Ok(payload) => {
                let Some(mapping) = summary_mapping else {
                    last_err = "missing summary mapping".to_string();
                    non_404_err.get_or_insert_with(|| last_err.clone());
                    continue;
                };
                let root = payload.get("data").unwrap_or(&payload);
                let Some(usage) = map_canonical_usage(
                    root,
                    mapping,
                    CanonicalUsageContext {
                        effective_usage_base: Some(base.to_string()),
                        effective_usage_source: Some("provider_key_card_login_summary".to_string()),
                        updated_at_unix_ms: unix_ms(),
                    },
                ) else {
                    last_err = format!("unexpected response from {base}");
                    non_404_err.get_or_insert_with(|| last_err.clone());
                    continue;
                };
                return snapshot_from_canonical_usage(usage);
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

async fn fetch_login_summary_any(
    st: &GatewayState,
    provider_name: &str,
    bases: &[String],
    usage_token: Option<&str>,
    usage_login: Option<&UsageLoginConfig>,
    summary_mapping: Option<&'static CanonicalUsageMapping>,
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
                match fetch_login_summary_token(&client, base, login).await {
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

        let payload = match fetch_login_summary_payload(&client, base, &token).await {
            Ok(payload) => Ok(payload),
            Err(err) if !login_attempted && err.contains("http 401") && usage_login.is_some() => {
                let login = usage_login.expect("checked is_some");
                match fetch_login_summary_token(&client, base, login).await {
                    Ok(fresh_token) => {
                        fetch_login_summary_payload(&client, base, &fresh_token).await
                    }
                    Err(login_err) => Err(login_err),
                }
            }
            Err(err) => Err(err),
        };

        match payload {
            Ok(payload) => {
                let Some(mapping) = summary_mapping else {
                    last_err = "missing summary mapping".to_string();
                    non_404_err.get_or_insert_with(|| last_err.clone());
                    continue;
                };
                let Some(mut usage) = map_canonical_usage(
                    &payload,
                    mapping,
                    CanonicalUsageContext {
                        effective_usage_base: Some(base.to_string()),
                        effective_usage_source: Some("login_summary".to_string()),
                        updated_at_unix_ms: unix_ms(),
                    },
                ) else {
                    last_err = format!("unexpected response from {base}");
                    non_404_err.get_or_insert_with(|| last_err.clone());
                    continue;
                };
                usage.monthly_limit = match (usage.remaining, usage.monthly_used) {
                    (Some(balance), Some(spent)) => Some(balance + spent),
                    _ => None,
                };
                return snapshot_from_canonical_usage(usage);
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
    credential_value: Option<&str>,
    missing_credential_label: &str,
    budget_info_mapping: &'static CanonicalUsageMapping,
    package_expiry_strategy: PackageExpiryStrategy,
) -> QuotaSnapshot {
    let mut out = QuotaSnapshot::empty(UsageKind::BudgetInfo);
    let Some(usage_token) = credential_value
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        out.last_error = format!("missing {missing_credential_label}");
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
                let Some(mut snapshot) = map_snapshot_from_usage_payload(
                    root,
                    budget_info_mapping,
                    base,
                    "usage_base",
                    response_now_ms,
                ) else {
                    last_err = format!("unexpected response from {base}");
                    non_404_err.get_or_insert_with(|| last_err.clone());
                    continue;
                };
                snapshot.package_expires_at_unix_ms = fetch_package_expiry_for_strategy(
                    package_expiry_strategy,
                    st,
                    provider_name,
                    bases,
                    usage_token,
                    Some(base),
                    Some(root),
                )
                .await;
                return snapshot;
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
            "usage token",
            crate::orchestrator::providers::default_budget_info_mapping(),
            crate::orchestrator::quota::PackageExpiryStrategy::None,
        )
        .await;

        assert_eq!(snapshot.last_error, "missing usage token");
    }
}
