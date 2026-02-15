#[tauri::command]
pub(crate) async fn codex_account_login(
    state: tauri::State<'_, app_state::AppState>,
) -> Result<(), String> {
    let result = codex_app_server::request(
        "account/login/start",
        serde_json::json!({ "type": "chatgpt" }),
    )
    .await?;
    let auth_url = result
        .get("authUrl")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "codex login response missing authUrl".to_string())?;
    codex_app_server::open_external_url(auth_url)?;
    let snap = serde_json::json!({
      "ok": true,
      "checked_at_unix_ms": unix_ms(),
      "signed_in": false,
      "remaining": null,
      "unlimited": null,
      "error": ""
    });
    state.gateway.store.put_codex_account_snapshot(&snap);
    let gateway = state.gateway.clone();
    tauri::async_runtime::spawn(async move {
        let deadline = unix_ms().saturating_add(120_000);
        loop {
            if unix_ms() >= deadline {
                break;
            }
            if let Ok(true) = refresh_codex_account_snapshot(&gateway).await {
                break;
            }
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
    });
    Ok(())
}

#[tauri::command]
pub(crate) async fn codex_account_logout(
    state: tauri::State<'_, app_state::AppState>,
) -> Result<(), String> {
    let mut error = String::new();
    if let Err(e) = codex_app_server::request("account/logout", Value::Null).await {
        error = e;
    }
    let snap = serde_json::json!({
      "ok": error.is_empty(),
      "checked_at_unix_ms": unix_ms(),
      "signed_in": false,
      "remaining": null,
      "unlimited": null,
      "error": error
    });
    state.gateway.store.put_codex_account_snapshot(&snap);
    Ok(())
}

#[tauri::command]
pub(crate) async fn codex_account_refresh(
    state: tauri::State<'_, app_state::AppState>,
) -> Result<(), String> {
    let gateway = state.gateway.clone();
    let _ = refresh_codex_account_snapshot(&gateway).await?;
    Ok(())
}

#[tauri::command]
pub(crate) fn codex_cli_toggle_auth_config_swap(
    state: tauri::State<'_, app_state::AppState>,
    cli_homes: Option<Vec<String>>,
) -> Result<serde_json::Value, String> {
    crate::codex_cli_swap::toggle_cli_auth_config_swap(&state, cli_homes.unwrap_or_default())
}

#[tauri::command]
pub(crate) fn codex_cli_default_home() -> Result<String, String> {
    crate::codex_cli_swap::default_cli_codex_home()
        .ok_or_else(|| "missing HOME/USERPROFILE".to_string())
        .map(|p| p.to_string_lossy().to_string())
}

#[tauri::command]
pub(crate) fn codex_cli_default_wsl_home() -> Result<String, String> {
    crate::codex_cli_swap::default_wsl_cli_codex_home()
        .ok_or_else(|| "missing WSL distro/HOME".to_string())
        .map(|p| p.to_string_lossy().to_string())
}

#[tauri::command]
pub(crate) fn codex_cli_swap_status(
    cli_homes: Option<Vec<String>>,
) -> Result<serde_json::Value, String> {
    crate::codex_cli_swap::cli_auth_config_swap_status(cli_homes.unwrap_or_default())
}

#[tauri::command]
pub(crate) fn get_codex_cli_config_toml(cli_home: Option<String>) -> Result<String, String> {
    crate::codex_cli_swap::get_cli_config_toml(cli_home.as_deref())
}

#[tauri::command]
pub(crate) fn set_codex_cli_config_toml(
    cli_home: Option<String>,
    toml_text: String,
) -> Result<(), String> {
    crate::codex_cli_swap::set_cli_config_toml(cli_home.as_deref(), &toml_text)
}

#[tauri::command]
pub(crate) fn provider_switchboard_status(
    state: tauri::State<'_, app_state::AppState>,
    cli_homes: Option<Vec<String>>,
) -> Result<serde_json::Value, String> {
    crate::provider_switchboard::get_status(&state, cli_homes.unwrap_or_default())
}

#[tauri::command]
pub(crate) fn provider_switchboard_set_target(
    state: tauri::State<'_, app_state::AppState>,
    cli_homes: Option<Vec<String>>,
    target: String,
    provider: Option<String>,
) -> Result<serde_json::Value, String> {
    crate::provider_switchboard::set_target(&state, cli_homes.unwrap_or_default(), target, provider)
}

fn mask_key_preview(key: &str) -> String {
    let k = key.trim();
    let chars: Vec<char> = k.chars().collect();
    if chars.len() < 10 {
        return "set".to_string();
    }
    let start_len = std::cmp::min(6, chars.len().saturating_sub(4));
    let start: String = chars.iter().take(start_len).collect();
    let end: String = chars
        .iter()
        .rev()
        .take(4)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    format!("{start}******{end}")
}

fn persist_config(state: &tauri::State<'_, app_state::AppState>) -> anyhow::Result<()> {
    let cfg = state.gateway.cfg.read().clone();
    std::fs::write(&state.config_path, toml::to_string_pretty(&cfg)?)?;
    Ok(())
}

async fn refresh_codex_account_snapshot(
    gateway: &crate::orchestrator::gateway::GatewayState,
) -> Result<bool, String> {
    let mut signed_in = false;
    let mut remaining: Option<String> = None;
    let mut unlimited: Option<bool> = None;
    let mut limit_5h_remaining: Option<String> = None;
    let mut limit_weekly_remaining: Option<String> = None;
    let mut limit_weekly_reset_at: Option<String> = None;
    let mut code_review_remaining: Option<String> = None;
    let mut code_review_reset_at: Option<String> = None;
    let mut error = String::new();

    let auth = codex_app_server::request("getAuthStatus", Value::Null).await?;
    if let Some(tok) = auth.get("authToken").and_then(|v| v.as_str()) {
        if !tok.trim().is_empty() {
            signed_in = true;
        }
    }

    let rate_limits = codex_app_server::request("account/rateLimits/read", Value::Null).await;
    match rate_limits {
        Ok(result) => {
            signed_in = true;
            let rate_limits = get_rate_limits_obj(&result);
            let used_percent = rate_limits
                .and_then(|v| v.get("secondary").or_else(|| v.get("Secondary")))
                .and_then(get_used_percent);

            if let Some(rate_limits) = rate_limits {
                let mut weekly_best: Option<(String, Option<String>, i32)> = None;
                for (key, target) in [
                    ("primary", "primary"),
                    ("Primary", "primary"),
                    ("secondary", "secondary"),
                    ("Secondary", "secondary"),
                ] {
                    if let Some(node) = rate_limits.get(key) {
                        if let Some(used) = get_used_percent(node) {
                            let window_mins = get_window_minutes(node);
                            if window_mins == Some(300) {
                                limit_5h_remaining = Some(format_percent(100.0 - used));
                            } else if window_mins == Some(10080) || target == "secondary" {
                                // Keep weekly remaining/reset paired from the same node.
                                // Prefer the explicit weekly window; otherwise fall back to the first "secondary".
                                let priority = if window_mins == Some(10080) { 2 } else { 1 };
                                let should_update = weekly_best
                                    .as_ref()
                                    .map(|(_, _, p)| priority > *p)
                                    .unwrap_or(true);
                                if should_update {
                                    weekly_best = Some((
                                        format_percent(100.0 - used),
                                        get_reset_time_str(node),
                                        priority,
                                    ));
                                }
                            }
                        }
                    }
                }
                if let Some((rem, reset, _)) = weekly_best {
                    limit_weekly_remaining = Some(rem);
                    limit_weekly_reset_at = reset;
                }

                if code_review_remaining.is_none() {
                    for key in [
                        "codeReview",
                        "code_review",
                        "codeReviewRemaining",
                        "code_review_remaining",
                        "review",
                        "CodeReview",
                    ] {
                        if let Some(node) = rate_limits.get(key) {
                            if let Some(rem) = get_remaining_percent(node) {
                                code_review_remaining = Some(rem);
                                code_review_reset_at = get_reset_time_str(node);
                                break;
                            }
                        }
                    }
                }
            }
            if let Some(credits) = result
                .get("rateLimits")
                .and_then(|v| v.get("credits"))
                .and_then(|v| v.as_object())
            {
                remaining = credits
                    .get("balance")
                    .and_then(parse_number)
                    .map(|n| n.to_string())
                    .or_else(|| {
                        credits
                            .get("balance")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string())
                    });
                unlimited = credits.get("unlimited").and_then(|v| v.as_bool());
            }
            if unlimited != Some(true) {
                if let Some(used) = used_percent {
                    remaining = Some(format_percent(100.0 - used));
                }
            }
        }
        Err(e) => {
            if !signed_in {
                error = e;
            }
        }
    }

    // Do not infer code review from other limits.
    // Fetch the dedicated code-review window from ChatGPT usage API when available.
    if let Some(access_token) = read_codex_access_token() {
        if let Ok(Some((remaining, reset_at))) = fetch_code_review_from_wham(&access_token).await {
            code_review_remaining = Some(remaining);
            code_review_reset_at = reset_at;
        }
    }

    let snap = serde_json::json!({
      "ok": error.is_empty(),
      "checked_at_unix_ms": unix_ms(),
      "signed_in": signed_in,
      "remaining": remaining,
      "limit_5h_remaining": limit_5h_remaining,
      "limit_weekly_remaining": limit_weekly_remaining,
      "limit_weekly_reset_at": limit_weekly_reset_at,
      "code_review_remaining": code_review_remaining,
      "code_review_reset_at": code_review_reset_at,
      "unlimited": unlimited,
      "error": error
    });
    gateway.store.put_codex_account_snapshot(&snap);
    Ok(signed_in)
}

fn read_codex_access_token() -> Option<String> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(home) = std::env::var("CODEX_HOME") {
        candidates.push(PathBuf::from(home).join("auth.json"));
    }
    if let Ok(user) = std::env::var("USERPROFILE") {
        candidates.push(PathBuf::from(user).join(".codex").join("auth.json"));
    } else if let Ok(home) = std::env::var("HOME") {
        candidates.push(PathBuf::from(home).join(".codex").join("auth.json"));
    }

    for path in candidates {
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        let Ok(v) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        if let Some(tok) = v
            .get("tokens")
            .and_then(|t| t.get("access_token"))
            .and_then(|t| t.as_str())
        {
            let trimmed = tok.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

async fn fetch_code_review_from_wham(
    token: &str,
) -> Result<Option<(String, Option<String>)>, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client
        .get("https://chatgpt.com/backend-api/wham/usage")
        .bearer_auth(token)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Ok(None);
    }
    let body: Value = resp.json().await.map_err(|e| e.to_string())?;
    let node = body.get("code_review_rate_limit");
    let used = node
        .and_then(|n| n.get("primary_window"))
        .and_then(get_used_percent);
    let Some(used_percent) = used else {
        return Ok(None);
    };
    let remaining = format_percent(100.0 - used_percent);
    let reset_at = node
        .and_then(|n| n.get("primary_window"))
        .and_then(|n| n.get("reset_at"))
        .and_then(|v| {
            v.as_i64()
                .or_else(|| v.as_u64().and_then(|u| i64::try_from(u).ok()))
                .map(|n| n.to_string())
                .or_else(|| v.as_str().map(|s| s.to_string()))
        });
    Ok(Some((remaining, reset_at)))
}

fn format_percent(value: f64) -> String {
    let mut pct = if value.is_finite() { value } else { 0.0 };
    if pct < 1.0 {
        pct = 0.0;
    }
    if pct > 100.0 {
        pct = 100.0;
    }
    format!("{}%", pct.floor() as i64)
}

fn get_rate_limits_obj(result: &Value) -> Option<&Value> {
    result
        .get("rateLimits")
        .or_else(|| result.get("rate_limits"))
}

fn get_used_percent(obj: &Value) -> Option<f64> {
    obj.get("usedPercent")
        .or_else(|| obj.get("used_percent"))
        .and_then(parse_number)
}

fn get_window_minutes(obj: &Value) -> Option<i64> {
    obj.get("windowDurationMins")
        .or_else(|| obj.get("window_minutes"))
        .or_else(|| obj.get("window_mins"))
        .and_then(parse_number)
        .map(|v| v.round() as i64)
}

fn get_remaining_percent(obj: &Value) -> Option<String> {
    if let Some(used) = get_used_percent(obj) {
        return Some(format_percent(100.0 - used));
    }
    if let Some(rem) = obj
        .get("remainingPercent")
        .or_else(|| obj.get("remaining_percent"))
        .and_then(parse_number)
    {
        return Some(format_percent(rem));
    }
    obj.get("remaining")
        .and_then(parse_number)
        .map(format_percent)
}

fn get_reset_time_str(obj: &Value) -> Option<String> {
    use std::collections::VecDeque;

    fn read_time_value(v: &Value) -> Option<String> {
        if let Some(s) = v.as_str().map(|s| s.trim().to_string()) {
            if !s.is_empty() {
                return Some(s);
            }
        }
        if let Some(n) = v
            .as_u64()
            .or_else(|| v.as_i64().and_then(|x| u64::try_from(x).ok()))
        {
            // Heuristic: seconds vs milliseconds.
            let ms = if n < 1_000_000_000_000 {
                n.saturating_mul(1000)
            } else {
                n
            };
            return Some(ms.to_string());
        }
        None
    }

    // Try direct keys first, then a small BFS for nested shapes.
    let keys = [
        "resetAt",
        "reset_at",
        "resetsAt",
        "resets_at",
        "nextResetAt",
        "next_reset_at",
        "resetTime",
        "reset_time",
        "resetAtUnixMs",
        "reset_at_unix_ms",
        "resetUnixMs",
        "reset_unix_ms",
        "resetAtMs",
        "reset_at_ms",
        "resetMs",
        "reset_ms",
        // Some APIs report window end times instead of reset times.
        "windowEnd",
        "window_end",
        "windowEndsAt",
        "window_ends_at",
        "endsAt",
        "ends_at",
        "endAt",
        "end_at",
        "expiresAt",
        "expires_at",
    ];

    if let Some(map) = obj.as_object() {
        for k in &keys {
            if let Some(v) = map.get(*k) {
                if let Some(out) = read_time_value(v) {
                    return Some(out);
                }
            }
        }
    }

    // BFS through nested objects/arrays, looking for any key that resembles a reset timestamp.
    let mut q = VecDeque::new();
    q.push_back((obj, 0usize));
    while let Some((cur, depth)) = q.pop_front() {
        if depth >= 4 {
            continue;
        }
        match cur {
            Value::Object(map) => {
                for (k, v) in map.iter() {
                    let kl = k.to_ascii_lowercase();
                    if kl.contains("reset") || kl.contains("expire") || kl.contains("windowend") {
                        if let Some(out) = read_time_value(v) {
                            return Some(out);
                        }
                    }
                    if v.is_object() || v.is_array() {
                        q.push_back((v, depth + 1));
                    }
                }
            }
            Value::Array(arr) => {
                for v in arr {
                    if v.is_object() || v.is_array() {
                        q.push_back((v, depth + 1));
                    }
                }
            }
            _ => {}
        }
    }

    None
}

fn parse_number(v: &Value) -> Option<f64> {
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
