fn build_models_url(base: &str) -> String {
    let trimmed = base.trim_end_matches('/');
    if trimmed.ends_with("/v1") {
        format!("{trimmed}/models")
    } else {
        format!("{trimmed}/v1/models")
    }
}
async fn probe_usage_base_speed(
    st: &GatewayState,
    provider_name: &str,
    base: &str,
    api_key: &str,
) -> Option<Duration> {
    let client = build_usage_http_client(st, provider_name).ok()?;
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
        probe_usage_base_speed(st, provider_name, ppchat, api_key),
        probe_usage_base_speed(st, provider_name, pumpkin, api_key)
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
