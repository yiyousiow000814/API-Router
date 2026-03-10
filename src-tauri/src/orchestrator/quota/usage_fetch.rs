async fn fetch_token_stats_any(
    st: &GatewayState,
    provider_name: &str,
    bases: &[String],
    provider_key: Option<&str>,
    usage_token: Option<&str>,
    package_expiry_strategy: PackageExpiryStrategy,
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
                let backoff_ms =
                    parse_rate_limit_backoff_ms(resp.headers(), unix_ms(), USAGE_BASE_429_BACKOFF_MS);
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

fn packycode_login_slug_for_usage_context(provider: &str) -> String {
    let mut slug = String::new();
    let mut last_was_dash = false;
    for ch in provider.trim().chars() {
        let normalized = ch.to_ascii_lowercase();
        if normalized.is_ascii_alphanumeric() {
            slug.push(normalized);
            last_was_dash = false;
        } else if !last_was_dash {
            slug.push('-');
            last_was_dash = true;
        }
    }
    let trimmed = slug.trim_matches('-');
    if trimmed.is_empty() {
        "provider".to_string()
    } else {
        trimmed.to_string()
    }
}

fn packycode_login_data_dir_for_usage_context(
    st: &GatewayState,
    provider_name: &str,
) -> std::path::PathBuf {
    st.secrets
        .path()
        .parent()
        .unwrap_or(std::path::Path::new("."))
        .join("packycode-login")
        .join(packycode_login_slug_for_usage_context(provider_name))
}

fn packycode_devtools_active_port_path_for_usage_context(
    data_dir: &std::path::Path,
) -> std::path::PathBuf {
    data_dir.join("DevToolsActivePort")
}

fn parse_packycode_devtools_port_for_usage_context(raw: &str) -> Option<u16> {
    raw.lines()
        .next()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .and_then(|line| line.parse::<u16>().ok())
}

fn packycode_browser_candidates_for_usage_context() -> Vec<std::path::PathBuf> {
    let mut candidates = Vec::new();
    #[cfg(target_os = "windows")]
    {
        if let Ok(program_files_x86) = std::env::var("ProgramFiles(x86)") {
            candidates.push(
                std::path::PathBuf::from(program_files_x86)
                    .join("Microsoft\\Edge\\Application\\msedge.exe"),
            );
        }
        if let Ok(program_files) = std::env::var("ProgramFiles") {
            let program_files = std::path::PathBuf::from(program_files);
            candidates.push(program_files.join("Microsoft\\Edge\\Application\\msedge.exe"));
            candidates.push(program_files.join("Google\\Chrome\\Application\\chrome.exe"));
        }
        if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
            candidates.push(
                std::path::PathBuf::from(local_app_data)
                    .join("Google\\Chrome\\Application\\chrome.exe"),
            );
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        for name in [
            "microsoft-edge",
            "microsoft-edge-stable",
            "google-chrome",
            "chromium",
            "chromium-browser",
        ] {
            candidates.push(std::path::PathBuf::from(name));
        }
    }
    candidates
}

fn resolve_packycode_browser_path_for_usage_context() -> Option<std::path::PathBuf> {
    packycode_browser_candidates_for_usage_context()
        .into_iter()
        .find(|candidate| candidate.is_file() || candidate.components().count() == 1)
        .or_else(|| {
            let lookup = if cfg!(target_os = "windows") {
                std::process::Command::new("where")
                    .args(["msedge", "chrome"])
                    .output()
                    .ok()
            } else {
                std::process::Command::new("which")
                    .args(["microsoft-edge", "google-chrome", "chromium"])
                    .output()
                    .ok()
            }?;
            if !lookup.status.success() {
                return None;
            }
            lookup
                .stdout
                .split(|byte| *byte == b'\n' || *byte == b'\r')
                .filter_map(|line| std::str::from_utf8(line).ok())
                .map(str::trim)
                .find(|line| !line.is_empty())
                .map(std::path::PathBuf::from)
        })
}

async fn wait_for_packycode_devtools_port_for_usage_context(
    data_dir: &std::path::Path,
) -> Result<u16, String> {
    let active_port_path = packycode_devtools_active_port_path_for_usage_context(data_dir);
    let started = std::time::Instant::now();
    loop {
        if let Ok(raw) = std::fs::read_to_string(&active_port_path) {
            if let Some(port) = parse_packycode_devtools_port_for_usage_context(&raw) {
                return Ok(port);
            }
        }
        if started.elapsed() >= Duration::from_secs(30) {
            return Err("timed out waiting for Packycode browser debug port".to_string());
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

async fn fetch_packycode_devtools_page_ws_url_for_usage_context(
    port: u16,
) -> Result<Option<String>, String> {
    let client = reqwest::Client::builder()
        .user_agent("api-router/0.1")
        .build()
        .map_err(|err| format!("failed to build devtools client: {err}"))?;
    let targets = client
        .get(format!("http://127.0.0.1:{port}/json/list"))
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(|err| format!("devtools target list failed: {err}"))?
        .json::<Value>()
        .await
        .map_err(|err| format!("devtools target list decode failed: {err}"))?;
    let Some(items) = targets.as_array() else {
        return Ok(None);
    };
    Ok(items.iter().find_map(|item| {
        let item_type = item.get("type").and_then(Value::as_str)?.trim();
        if item_type != "page" {
            return None;
        }
        let url = item.get("url").and_then(Value::as_str)?.trim();
        if !url.contains("packycode.com") {
            return None;
        }
        item.get("webSocketDebuggerUrl")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToString::to_string)
    }))
}

async fn send_packycode_devtools_command(
    socket: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    id: u64,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    socket
        .send(WebSocketMessage::Text(
            serde_json::json!({
                "id": id,
                "method": method,
                "params": params,
            })
            .to_string(),
        ))
        .await
        .map_err(|err| format!("devtools websocket send failed: {err}"))?;
    while let Some(message) = socket.next().await {
        let message = message.map_err(|err| format!("devtools websocket read failed: {err}"))?;
        let WebSocketMessage::Text(text) = message else {
            continue;
        };
        let payload: Value = serde_json::from_str(&text)
            .map_err(|err| format!("devtools websocket decode failed: {err}"))?;
        if payload.get("id").and_then(Value::as_u64) != Some(id) {
            continue;
        }
        if let Some(err) = payload.get("error") {
            return Err(format!("devtools command {method} failed: {err}"));
        }
        return Ok(payload);
    }
    Err(format!("devtools websocket closed before {method} completed"))
}

fn build_packycode_auth_storage_seed(token: &str) -> String {
    serde_json::json!({
        "state": {
            "token": token.trim(),
            "user": Value::Null,
        },
        "version": 0,
    })
    .to_string()
}

fn extract_packycode_browser_auth_storage_user(root: &Value) -> Result<Value, String> {
    let result = root
        .pointer("/result/result/value")
        .ok_or_else(|| "missing devtools evaluate result".to_string())?;
    if let Some(err) = result.get("__parseError").and_then(Value::as_str) {
        return Err(format!("Packycode dashboard auth-storage parse failed: {err}"));
    }
    let storage = if let Some(raw) = result.as_str() {
        let raw = raw.trim();
        if raw.is_empty() {
            return Err("Packycode dashboard auth-storage is empty".to_string());
        }
        serde_json::from_str::<Value>(raw)
            .map_err(|err| format!("invalid Packycode auth-storage JSON: {err}"))?
    } else {
        result.clone()
    };
    let user = storage
        .pointer("/state/user")
        .or_else(|| storage.get("user"))
        .cloned()
        .ok_or_else(|| "Packycode dashboard auth-storage missing user payload".to_string())?;
    if user.get("daily_spent_usd").is_none()
        && user.get("monthly_spent_usd").is_none()
        && user.get("weekly_spent_usd").is_none()
        && user.get("weekly_spent").is_none()
    {
        return Err("Packycode dashboard user payload has no usage fields".to_string());
    }
    Ok(user)
}

fn packycode_usage_browser_args(
    data_dir: &std::path::Path,
    dashboard_url: &str,
) -> Vec<String> {
    vec![
        "--headless=new".to_string(),
        "--disable-gpu".to_string(),
        "--hide-scrollbars".to_string(),
        "--mute-audio".to_string(),
        "--no-first-run".to_string(),
        "--remote-debugging-port=0".to_string(),
        format!("--user-data-dir={}", data_dir.display()),
        dashboard_url.to_string(),
    ]
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

async fn fetch_packycode_budget_info_via_browser_context(
    st: &GatewayState,
    provider_name: &str,
    base: &str,
    usage_token: Option<&str>,
) -> QuotaSnapshot {
    const PACKYCODE_DASHBOARD_URL: &str = "https://codex.packycode.com/dashboard";
    const PACKYCODE_ORIGIN_URL: &str = "https://codex.packycode.com/";
    let mut out = QuotaSnapshot::empty(UsageKind::BudgetInfo);
    let data_dir = packycode_login_data_dir_for_usage_context(st, provider_name);
    if !data_dir.exists() {
        out.last_error = "Packycode login browser profile not found".to_string();
        return out;
    }

    let browser_path = match resolve_packycode_browser_path_for_usage_context() {
        Some(path) => path,
        None => {
            out.last_error = "no supported browser found for Packycode browser usage sync".to_string();
            return out;
        }
    };

    let _ = std::fs::remove_file(packycode_devtools_active_port_path_for_usage_context(&data_dir));
    let launch_args = packycode_usage_browser_args(&data_dir, PACKYCODE_DASHBOARD_URL);
    let mut child = match tokio::process::Command::new(&browser_path)
        .args(&launch_args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
    {
        Ok(child) => child,
        Err(err) => {
            out.last_error =
                format!("failed to launch Packycode browser usage session: {err}");
            return out;
        }
    };

    let result = async {
        let port = wait_for_packycode_devtools_port_for_usage_context(&data_dir).await?;
        let Some(ws_url) = fetch_packycode_devtools_page_ws_url_for_usage_context(port).await? else {
            return Err("Packycode browser page websocket not found".to_string());
        };
        let (mut socket, _) = connect_async(ws_url)
            .await
            .map_err(|err| format!("devtools websocket connect failed: {err}"))?;

        let _ = send_packycode_devtools_command(
            &mut socket,
            1,
            "Page.enable",
            Value::Object(Default::default()),
        )
        .await?;
        let _ = send_packycode_devtools_command(
            &mut socket,
            2,
            "Runtime.enable",
            Value::Object(Default::default()),
        )
        .await?;
        let _ = send_packycode_devtools_command(
            &mut socket,
            3,
            "Network.enable",
            Value::Object(Default::default()),
        )
        .await?;

        if let Some(token) = usage_token.map(str::trim).filter(|value| !value.is_empty()) {
            let auth_storage_seed = serde_json::to_string(&build_packycode_auth_storage_seed(token))
                .map_err(|err| format!("failed to encode Packycode auth-storage seed: {err}"))?;
            let _ = send_packycode_devtools_command(
                &mut socket,
                4,
                "Network.setCookie",
                serde_json::json!({
                    "name": "token",
                    "value": token,
                    "url": PACKYCODE_ORIGIN_URL,
                    "path": "/",
                    "secure": true,
                }),
            )
            .await?;
            let _ = send_packycode_devtools_command(
                &mut socket,
                5,
                "Runtime.evaluate",
                serde_json::json!({
                    "expression": format!(
                        "(() => {{ localStorage.setItem('auth-storage', {}); return true; }})()",
                        auth_storage_seed
                    ),
                    "returnByValue": true,
                }),
            )
            .await?;
        }

        let _ = send_packycode_devtools_command(
            &mut socket,
            6,
            "Page.reload",
            serde_json::json!({ "ignoreCache": true }),
        )
        .await?;
        let mut last_err = "Packycode dashboard auth-storage missing user payload".to_string();
        for attempt in 0..10 {
            if attempt > 0 {
                tokio::time::sleep(Duration::from_millis(700)).await;
            } else {
                tokio::time::sleep(Duration::from_millis(1200)).await;
            }
            let evaluated = send_packycode_devtools_command(
                &mut socket,
                7 + attempt,
                "Runtime.evaluate",
                serde_json::json!({
                    "expression": r#"(() => {
  const raw = localStorage.getItem('auth-storage');
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    return {
      __parseError: String(err),
      __raw: String(raw).slice(0, 400),
    };
  }
})()"#,
                    "returnByValue": true,
                }),
            )
            .await?;
            match extract_packycode_browser_auth_storage_user(&evaluated) {
                Ok(user) => {
                    apply_packycode_budget_payload(&mut out, &user, base, unix_ms())?;
                    out.effective_usage_source = Some("packycode_browser_session".to_string());
                    out.package_expires_at_unix_ms =
                        extract_packycode_package_expiry_from_value(&user);
                    return Ok::<QuotaSnapshot, String>(out);
                }
                Err(err) => last_err = err,
            }
        }
        Err(last_err)
    }
    .await;

    let _ = child.kill().await;
    match result {
        Ok(snapshot) => snapshot,
        Err(err) => {
            let mut failed = QuotaSnapshot::empty(UsageKind::BudgetInfo);
            failed.last_error = err;
            failed
        }
    }
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
                    Ok(fresh_token) => fetch_codex_for_me_summary(&client, base, &fresh_token).await,
                    Err(login_err) => Err(login_err),
                }
            }
            Err(err) => Err(err),
        };

        match payload {
            Ok(payload) => {
                let Some(summary) = extract_codex_for_me_summary_snapshot(&payload)
                else {
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
    jwt: Option<&str>,
    package_expiry_strategy: PackageExpiryStrategy,
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
            .header(reqwest::header::AUTHORIZATION, format!("Bearer {token}"))
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
                if let Err(err) = apply_packycode_budget_payload(&mut out, root, base, response_now_ms) {
                    last_err = err.clone();
                    non_404_err.get_or_insert(err);
                    continue;
                }
                out.package_expires_at_unix_ms = fetch_package_expiry_for_strategy(
                    package_expiry_strategy,
                    st,
                    provider_name,
                    bases,
                    token,
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
