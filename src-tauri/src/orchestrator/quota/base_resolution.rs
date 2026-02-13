fn derive_origin(base_url: &str) -> Option<String> {
    let u = reqwest::Url::parse(base_url).ok()?;
    let mut origin = u.clone();
    origin.set_path("");
    origin.set_query(None);
    origin.set_fragment(None);
    Some(origin.as_str().trim_end_matches('/').to_string())
}

fn is_packycode_base(base_url: &str) -> bool {
    reqwest::Url::parse(base_url)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.to_string()))
        .map(|host| host.ends_with("packycode.com"))
        .unwrap_or(false)
}

fn is_ppchat_base(base_url: &str) -> bool {
    reqwest::Url::parse(base_url)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.to_string()))
        .map(|host| host.ends_with("ppchat.vip"))
        .unwrap_or(false)
}

fn is_pumpkinai_base(base_url: &str) -> bool {
    reqwest::Url::parse(base_url)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.to_string()))
        .map(|host| host.ends_with("pumpkinai.vip"))
        .unwrap_or(false)
}

fn build_models_url(base: &str) -> String {
    let trimmed = base.trim_end_matches('/');
    if trimmed.ends_with("/v1") {
        format!("{trimmed}/models")
    } else {
        format!("{trimmed}/v1/models")
    }
}

fn candidate_quota_bases(provider: &ProviderConfig) -> Vec<String> {
    // User-provided usage_base_url always wins.
    if let Some(u) = provider.usage_base_url.as_deref() {
        let t = u.trim().trim_end_matches('/');
        if !t.is_empty() {
            return vec![t.to_string()];
        }
    }

    let mut out: Vec<String> = Vec::new();
    let mut push_unique = |value: String| {
        if value.is_empty() {
            return;
        }
        if !out.iter().any(|v| v == &value) {
            out.push(value);
        }
    };

    let is_ppchat = is_ppchat_base(&provider.base_url);
    let is_pumpkin = is_pumpkinai_base(&provider.base_url);

    if is_ppchat || is_pumpkin {
        // Prefer the shared history/usage endpoint for ppchat/pumpkinai.
        push_unique("https://his.ppchat.vip".to_string());
    }

    if let Some(origin) = derive_origin(&provider.base_url) {
        push_unique(origin.clone());

        // Heuristic: if upstream uses a "*-api." hostname, also try the non-api hostname.
        // This stays generic and does not encode any provider-specific domains.
        if let Ok(mut u) = reqwest::Url::parse(&origin) {
            if let Some(host) = u.host_str().map(|s| s.to_string()) {
                if host.contains("-api.") {
                    let alt = host.replacen("-api.", ".", 1);
                    if u.set_host(Some(&alt)).is_ok() {
                        push_unique(u.as_str().trim_end_matches('/').to_string());
                    }
                }
            }
        }
    }

    if is_packycode_base(&provider.base_url) {
        push_unique("https://www.packycode.com".to_string());
        push_unique("https://packycode.com".to_string());
    }

    if is_ppchat || is_pumpkin {
        push_unique("https://code.ppchat.vip".to_string());
        push_unique("https://code.pumpkinai.vip".to_string());
    }

    out
}

async fn probe_usage_base_speed(base: &str, api_key: &str) -> Option<Duration> {
    let client = reqwest::Client::builder()
        .user_agent("api-router/0.1")
        .build()
        .ok()?;
    let url = build_models_url(base);
    let start = Instant::now();
    let resp = client
        .get(url)
        .bearer_auth(api_key)
        .timeout(Duration::from_secs(10))
        .send()
        .await;
    match resp {
        Ok(_) => Some(start.elapsed()),
        Err(_) => None,
    }
}

async fn reorder_bases_for_speed(
    st: &GatewayState,
    provider_name: &str,
    bases: Vec<String>,
    api_key: Option<&str>,
) -> Vec<String> {
    let mut normalized: Vec<String> = Vec::new();
    for base in bases {
        let trimmed = base.trim_end_matches('/').to_string();
        if trimmed.is_empty() || normalized.iter().any(|b| b == &trimmed) {
            continue;
        }
        normalized.push(trimmed);
    }

    let has_ppchat = normalized.iter().any(|b| b == "https://code.ppchat.vip");
    let has_pumpkin = normalized.iter().any(|b| b == "https://code.pumpkinai.vip");
    if !has_ppchat || !has_pumpkin {
        return normalized;
    }
    let Some(api_key) = api_key else {
        return normalized;
    };

    let now = unix_ms();
    let mut bases_key = normalized.clone();
    bases_key.sort();
    bases_key.dedup();

    if let Some(entry) = st.usage_base_speed_cache.read().get(provider_name) {
        if entry.bases_key == bases_key
            && now.saturating_sub(entry.updated_at_unix_ms) < 5 * 60 * 1000
        {
            return entry.ordered_bases.clone();
        }
    }

    let ppchat = "https://code.ppchat.vip";
    let pumpkin = "https://code.pumpkinai.vip";
    let (ppchat_latency, pumpkin_latency) = tokio::join!(
        probe_usage_base_speed(ppchat, api_key),
        probe_usage_base_speed(pumpkin, api_key)
    );

    let mut ordered_pair = vec![ppchat.to_string(), pumpkin.to_string()];
    match (ppchat_latency, pumpkin_latency) {
        (Some(a), Some(b)) => {
            if b < a {
                ordered_pair.reverse();
            }
        }
        (None, Some(_)) => {
            ordered_pair.reverse();
        }
        _ => {}
    }

    let mut ordered = Vec::new();
    for base in normalized.iter() {
        if base == "https://code.ppchat.vip" || base == "https://code.pumpkinai.vip" {
            continue;
        }
        ordered.push(base.clone());
    }
    // Insert the speed-ordered ppchat/pumpkin bases at the end to avoid overriding preferred bases.
    for base in ordered_pair {
        if normalized.contains(&base) {
            ordered.push(base);
        }
    }

    st.usage_base_speed_cache.write().insert(
        provider_name.to_string(),
        super::gateway::UsageBaseSpeedCacheEntry {
            updated_at_unix_ms: now,
            bases_key,
            ordered_bases: ordered.clone(),
        },
    );

    ordered
}

