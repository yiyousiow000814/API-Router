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

pub(crate) fn canonical_packycode_usage_base(base_url: &str) -> Option<String> {
    if is_packycode_base(base_url) {
        Some("https://codex.packycode.com".to_string())
    } else {
        None
    }
}

fn is_codex_for_me_host(host: &str) -> bool {
    host.contains("codex-for")
}

fn is_codex_for_me_origin(base_url: &str) -> bool {
    reqwest::Url::parse(base_url)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.to_string()))
        .map(|host| is_codex_for_me_host(&host))
        .unwrap_or(false)
}

fn is_codex_for_me_base(_provider_name: &str, bases: &[String]) -> bool {
    bases.iter().any(|base| {
        reqwest::Url::parse(base)
            .ok()
            .and_then(|u| u.host_str().map(|h| h.to_string()))
            .map(|host| is_codex_for_me_host(&host))
            .unwrap_or(false)
    })
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

fn is_aigateway_base(base_url: &str) -> bool {
    reqwest::Url::parse(base_url)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.to_string()))
        .map(|host| host == "aigateway.chat" || host.ends_with(".aigateway.chat"))
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

fn explicit_usage_endpoint_url(provider: &ProviderConfig) -> Option<String> {
    if let Some(raw) = provider.usage_base_url.as_deref() {
        let raw = raw.trim();
        if !raw.is_empty() {
            if let Ok(parsed) = reqwest::Url::parse(raw) {
                let path = parsed.path().trim_end_matches('/');
                if !(path.is_empty() || path == "/") {
                    let normalized = path.to_ascii_lowercase();
                    if !matches!(
                        normalized.as_str(),
                        "/v1" | "/api" | "/web/api/v1" | "/user/api/v1" | "/backend"
                    ) {
                        return Some(raw.trim_end_matches('/').to_string());
                    }
                }
            }
        }
    }

    if is_aigateway_base(&provider.base_url) {
        return Some("https://aigateway.chat/v1/usage".to_string());
    }

    None
}

fn candidate_quota_bases(provider: &ProviderConfig) -> Vec<String> {
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
    let packycode_usage_base = canonical_packycode_usage_base(&provider.base_url);

    // Only keep explicit URLs for generic providers. Built-in inference is canonical for providers
    // whose usage endpoint family is known and stable.
    if let Some(u) = provider.usage_base_url.as_deref() {
        let t = u.trim().trim_end_matches('/');
        if !t.is_empty() {
            if let Some(canonical) = canonical_packycode_usage_base(t) {
                push_unique(canonical);
            } else {
                push_unique(t.to_string());
            }
        }
    }

    if is_ppchat || is_pumpkin {
        // Prefer the shared history/usage endpoint for ppchat/pumpkinai.
        push_unique("https://his.ppchat.vip".to_string());
    }

    if let Some(canonical) = packycode_usage_base {
        push_unique(canonical);
    }

    if is_codex_for_me_origin(&provider.base_url) {
        if let Some(origin) = derive_origin(&provider.base_url) {
            push_unique(origin);
        }
    }

    if is_aigateway_base(&provider.base_url) {
        push_unique("https://aigateway.chat".to_string());
    }

    if is_ppchat || is_pumpkin {
        push_unique("https://code.ppchat.vip".to_string());
        push_unique("https://code.pumpkinai.vip".to_string());
    }

    out
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
