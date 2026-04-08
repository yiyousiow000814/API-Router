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

    let cfg = st.cfg.read().clone();
    let Some(provider) = cfg.providers.get(provider_name) else {
        return normalized;
    };
    let speed_probe_bases = resolve_quota_profile(provider).speed_probe_bases;
    if speed_probe_bases.len() < 2 {
        return normalized;
    }
    if !speed_probe_bases
        .iter()
        .all(|base| normalized.iter().any(|candidate| candidate == base))
    {
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

    let mut measured = Vec::new();
    for base in &speed_probe_bases {
        measured.push((
            base.clone(),
            probe_usage_base_speed(st, provider_name, base, api_key).await,
        ));
    }
    measured.sort_by(|(left_base, left_latency), (right_base, right_latency)| {
        match (left_latency, right_latency) {
            (Some(left), Some(right)) => left.cmp(right).then_with(|| left_base.cmp(right_base)),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => left_base.cmp(right_base),
        }
    });

    let mut ordered = Vec::new();
    for base in normalized.iter() {
        if speed_probe_bases.iter().any(|candidate| candidate == base) {
            continue;
        }
        ordered.push(base.clone());
    }
    // Keep the provider-selected primary bases first, then append the probed cluster in speed order.
    for (base, _) in measured {
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
