use serde::{Deserialize, Serialize};
use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message as WebSocketMessage;

const USAGE_REFRESH_SUMMARY_WINDOW_MS: u64 = 30 * 60 * 1000;
const PACKYCODE_LOGIN_URL: &str = "https://codex.packycode.com/";
const PACKYCODE_LOGIN_STATUS_URL: &str = "https://codex.packycode.com/api/backend/users/info";
const PACKYCODE_LOGIN_POLL_INTERVAL_MS: u64 = 2000;
const PACKYCODE_LOGIN_TIMEOUT_SECS: u64 = 10 * 60;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct UsageAuthPayload {
    pub token: String,
    pub username: String,
    pub password: String,
}

#[derive(Clone, Copy, Debug, Default)]
struct UsageRefreshSummaryWindow {
    window_start_ms: u64,
    first_success_at_ms: u64,
    last_success_at_ms: u64,
    success_count: u64,
    providers: usize,
    consecutive_failures: u64,
}

fn usage_refresh_window_state() -> &'static std::sync::Mutex<UsageRefreshSummaryWindow> {
    static STATE: std::sync::OnceLock<std::sync::Mutex<UsageRefreshSummaryWindow>> =
        std::sync::OnceLock::new();
    STATE.get_or_init(|| std::sync::Mutex::new(UsageRefreshSummaryWindow::default()))
}

fn usage_refresh_on_success(
    now_ms: u64,
    providers: usize,
) -> (Option<UsageRefreshSummaryWindow>, Option<u64>) {
    let lock = usage_refresh_window_state();
    let Ok(mut st) = lock.lock() else {
        return (None, None);
    };

    let mut summary_to_emit: Option<UsageRefreshSummaryWindow> = None;
    let recovered_failures = if st.consecutive_failures > 0 {
        let n = st.consecutive_failures;
        st.consecutive_failures = 0;
        Some(n)
    } else {
        None
    };

    if st.window_start_ms > 0
        && st.success_count > 0
        && now_ms.saturating_sub(st.window_start_ms) >= USAGE_REFRESH_SUMMARY_WINDOW_MS
    {
        summary_to_emit = Some(*st);
        st.window_start_ms = now_ms;
        st.first_success_at_ms = now_ms;
        st.last_success_at_ms = now_ms;
        st.success_count = 0;
        st.providers = providers;
    } else if st.window_start_ms == 0 {
        st.window_start_ms = now_ms;
        st.first_success_at_ms = now_ms;
        st.last_success_at_ms = now_ms;
        st.providers = providers;
    }

    st.success_count = st.success_count.saturating_add(1);
    if st.first_success_at_ms == 0 {
        st.first_success_at_ms = now_ms;
    }
    st.last_success_at_ms = now_ms;
    st.providers = providers;

    (summary_to_emit, recovered_failures)
}

fn usage_refresh_on_failure() {
    let lock = usage_refresh_window_state();
    if let Ok(mut st) = lock.lock() {
        st.consecutive_failures = st.consecutive_failures.saturating_add(1);
    }
}

fn is_packycode_provider_base(base_url: &str) -> bool {
    base_url.trim().to_ascii_lowercase().contains("packycode")
}

fn packycode_login_slug(provider: &str) -> String {
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

fn packycode_login_data_dir(
    state: &app_state::AppState,
    provider: &str,
) -> std::path::PathBuf {
    state
        .config_path
        .parent()
        .unwrap_or(std::path::Path::new("."))
        .join("packycode-login")
        .join(packycode_login_slug(provider))
}

fn packycode_devtools_active_port_path(data_dir: &std::path::Path) -> PathBuf {
    data_dir.join("DevToolsActivePort")
}

fn parse_packycode_devtools_port(raw: &str) -> Option<u16> {
    raw.lines()
        .next()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .and_then(|line| line.parse::<u16>().ok())
}

fn extract_packycode_token_from_devtools_payload(root: &Value) -> Option<String> {
    root.pointer("/result/cookies")?
        .as_array()?
        .iter()
        .filter_map(Value::as_object)
        .find_map(|cookie| {
            let name = cookie.get("name").and_then(Value::as_str)?.trim();
            if name != "token" {
                return None;
            }
            let value = cookie.get("value").and_then(Value::as_str)?.trim();
            (!value.is_empty()).then_some(value.to_string())
        })
}

fn packycode_browser_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    #[cfg(target_os = "windows")]
    {
        if let Ok(program_files_x86) = std::env::var("ProgramFiles(x86)") {
            candidates.push(
                PathBuf::from(program_files_x86).join("Microsoft\\Edge\\Application\\msedge.exe"),
            );
        }
        if let Ok(program_files) = std::env::var("ProgramFiles") {
            let program_files = PathBuf::from(program_files);
            candidates.push(program_files.join("Microsoft\\Edge\\Application\\msedge.exe"));
            candidates.push(program_files.join("Google\\Chrome\\Application\\chrome.exe"));
        }
        if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
            candidates.push(
                PathBuf::from(local_app_data).join("Google\\Chrome\\Application\\chrome.exe"),
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
            candidates.push(PathBuf::from(name));
        }
    }
    candidates
}

fn resolve_packycode_browser_path() -> Option<PathBuf> {
    packycode_browser_candidates()
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
                .map(PathBuf::from)
        })
}

async fn wait_for_packycode_devtools_port(data_dir: &std::path::Path) -> Result<u16, String> {
    let active_port_path = packycode_devtools_active_port_path(data_dir);
    let started = std::time::Instant::now();
    loop {
        if let Ok(raw) = std::fs::read_to_string(&active_port_path) {
            if let Some(port) = parse_packycode_devtools_port(&raw) {
                return Ok(port);
            }
        }
        if started.elapsed() >= Duration::from_secs(30) {
            return Err("timed out waiting for browser debug port".to_string());
        }
        tokio::time::sleep(Duration::from_millis(PACKYCODE_LOGIN_POLL_INTERVAL_MS)).await;
    }
}

async fn fetch_packycode_devtools_page_ws_url(port: u16) -> Result<Option<String>, String> {
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

async fn fetch_packycode_token_via_devtools(port: u16) -> Result<Option<String>, String> {
    let Some(ws_url) = fetch_packycode_devtools_page_ws_url(port).await? else {
        return Ok(None);
    };
    let (mut socket, _) = connect_async(ws_url)
        .await
        .map_err(|err| format!("devtools websocket connect failed: {err}"))?;
    socket
        .send(WebSocketMessage::Text(
            serde_json::json!({
                "id": 1,
                "method": "Network.getCookies",
                "params": {
                    "urls": [PACKYCODE_LOGIN_URL]
                }
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
        if payload.get("id").and_then(Value::as_u64) != Some(1) {
            continue;
        }
        if let Some(err) = payload.get("error") {
            return Err(format!("devtools cookie query failed: {err}"));
        }
        return Ok(extract_packycode_token_from_devtools_payload(&payload));
    }
    Err("devtools websocket closed before token query completed".to_string())
}

fn extract_packycode_account_email(root: &Value) -> Option<String> {
    let candidates = [
        root.pointer("/data/email"),
        root.pointer("/data/user/email"),
        root.pointer("/email"),
        root.pointer("/user/email"),
    ];
    candidates
        .into_iter()
        .flatten()
        .find_map(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

async fn fetch_packycode_account_info(token: &str) -> Result<Value, String> {
    let client = reqwest::Client::builder()
        .user_agent("api-router/0.1")
        .build()
        .map_err(|err| format!("failed to build packycode auth client: {err}"))?;
    let resp = client
        .get(PACKYCODE_LOGIN_STATUS_URL)
        .header(reqwest::header::AUTHORIZATION, format!("Bearer {}", token.trim()))
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|err| format!("packycode login verify failed: {err}"))?;
    let status = resp.status().as_u16();
    let payload = resp.json::<Value>().await.unwrap_or(Value::Null);
    if !(200..300).contains(&status) {
        return Err(format!("packycode login verify failed: http {status}"));
    }
    Ok(payload)
}

async fn finalize_packycode_login(
    gateway: crate::orchestrator::gateway::GatewayState,
    secrets: crate::orchestrator::secrets::SecretStore,
    provider: String,
    token: String,
) {
    let account_info = match fetch_packycode_account_info(&token).await {
        Ok(payload) => payload,
        Err(err) => {
            gateway.store.add_event(
                &provider,
                "error",
                "packycode.login_verify_failed",
                &format!("Packycode login verify failed: {err}"),
                serde_json::Value::Null,
            );
            return;
        }
    };

    if let Err(err) = secrets.set_usage_token(&provider, &token) {
        gateway.store.add_event(
            &provider,
            "error",
            "packycode.login_window_store_failed",
            &format!("packycode login store failed: {err}"),
            serde_json::Value::Null,
        );
        return;
    }

    let imported_email = extract_packycode_account_email(&account_info);
    if let Some(email) = imported_email.as_deref() {
        let _ = secrets.set_provider_account_email(&provider, email);
    }

    gateway.store.add_event(
        &provider,
        "info",
        "packycode.login_imported",
        "Packycode login imported into user-data/secrets.json",
        serde_json::json!({
            "has_email": imported_email.is_some(),
        }),
    );
}

async fn monitor_packycode_login_browser(
    gateway: crate::orchestrator::gateway::GatewayState,
    secrets: crate::orchestrator::secrets::SecretStore,
    provider: String,
    data_dir: PathBuf,
    mut child: tokio::process::Child,
) {
    let started = std::time::Instant::now();
    let port = match wait_for_packycode_devtools_port(&data_dir).await {
        Ok(port) => port,
        Err(err) => {
            let _ = child.kill().await;
            gateway.store.add_event(
                &provider,
                "error",
                "packycode.login_browser_unavailable",
                &format!("Packycode login browser unavailable: {err}"),
                serde_json::Value::Null,
            );
            return;
        }
    };

    loop {
        match child.try_wait() {
            Ok(Some(_status)) => return,
            Ok(None) => {}
            Err(err) => {
                gateway.store.add_event(
                    &provider,
                    "error",
                    "packycode.login_browser_wait_failed",
                    &format!("Packycode login browser wait failed: {err}"),
                    serde_json::Value::Null,
                );
                return;
            }
        }

        match fetch_packycode_token_via_devtools(port).await {
            Ok(Some(token)) => {
                finalize_packycode_login(gateway, secrets, provider.clone(), token).await;
                let _ = child.kill().await;
                return;
            }
            Ok(None) => {}
            Err(err) => {
                gateway.store.add_event(
                    &provider,
                    "warn",
                    "packycode.login_browser_poll_failed",
                    &format!("Packycode login browser poll failed: {err}"),
                    serde_json::Value::Null,
                );
            }
        }

        if started.elapsed() >= Duration::from_secs(PACKYCODE_LOGIN_TIMEOUT_SECS) {
            let _ = child.kill().await;
            gateway.store.add_event(
                &provider,
                "warn",
                "packycode.login_browser_timeout",
                "Packycode login timed out before token import",
                serde_json::Value::Null,
            );
            return;
        }
        tokio::time::sleep(Duration::from_millis(PACKYCODE_LOGIN_POLL_INTERVAL_MS)).await;
    }
}

#[tauri::command]
pub(crate) fn open_packycode_login_window(
    state: tauri::State<'_, app_state::AppState>,
    provider: String,
) -> Result<(), String> {
    let provider = provider.trim().to_string();
    if provider.is_empty() {
        return Err("provider is required".to_string());
    }
    let provider_base_url = {
        let cfg = state.gateway.cfg.read();
        cfg.providers
            .get(&provider)
            .map(|provider| provider.base_url.clone())
    }
    .ok_or_else(|| format!("unknown provider: {provider}"))?;
    if !is_packycode_provider_base(&provider_base_url) {
        return Err("Packycode login only supports packycode providers".to_string());
    }

    let data_dir = packycode_login_data_dir(&state, &provider);
    std::fs::create_dir_all(&data_dir).map_err(|err| err.to_string())?;
    let _ = std::fs::remove_file(packycode_devtools_active_port_path(&data_dir));
    let browser_path = resolve_packycode_browser_path()
        .ok_or_else(|| "no supported browser found for Packycode login".to_string())?;
    let child = tokio::process::Command::new(&browser_path)
        .arg("--new-window")
        .arg("--no-first-run")
        .arg("--remote-debugging-port=0")
        .arg(format!("--user-data-dir={}", data_dir.display()))
        .arg(PACKYCODE_LOGIN_URL)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|err| format!("failed to launch Packycode login browser: {err}"))?;
    let gateway = state.gateway.clone();
    let secrets = state.secrets.clone();
    tauri::async_runtime::spawn(monitor_packycode_login_browser(
        gateway,
        secrets,
        provider.clone(),
        data_dir,
        child,
    ));

    state.gateway.store.add_event(
        &provider,
        "info",
        "packycode.login_browser_opened",
        "Packycode login browser opened",
        serde_json::Value::Null,
    );
    Ok(())
}

#[tauri::command]
pub(crate) async fn refresh_quota(
    state: tauri::State<'_, app_state::AppState>,
    provider: String,
) -> Result<(), String> {
    if !state.gateway.cfg.read().providers.contains_key(&provider) {
        return Err(format!("unknown provider: {provider}"));
    }
    if let Some(owner) = crate::orchestrator::quota::shared_quota_owner_for_provider(
        &state.gateway,
        &state.lan_sync,
        &provider,
    ) {
        if !owner.local_is_owner {
            let cfg = state.gateway.cfg.read().clone();
            let fingerprint = crate::orchestrator::quota::shared_provider_fingerprint(
                &cfg,
                &state.gateway.secrets,
                &provider,
            )
            .ok_or_else(|| "shared quota fingerprint unavailable".to_string())?;
            state.lan_sync.request_remote_quota_refresh(
                &state.gateway,
                &owner.owner_node_id,
                &fingerprint,
            )?;
            state.gateway.store.add_event(
                &provider,
                "info",
                "usage.refresh_forwarded",
                &format!(
                    "Usage refresh forwarded to {} ({})",
                    owner.owner_node_name, owner.owner_node_id
                ),
                serde_json::json!({
                    "owner_node_id": owner.owner_node_id,
                    "owner_node_name": owner.owner_node_name,
                }),
            );
            return Ok(());
        }
    }
    crate::orchestrator::quota::clear_usage_refresh_gate_for_provider(&state.gateway, &provider);
    let snap = crate::orchestrator::quota::refresh_quota_for_provider_with_lan_owner(
        &state.gateway,
        &state.lan_sync,
        &provider,
    )
    .await?;
    if snap.last_error.is_empty() && snap.updated_at_unix_ms > 0 {
        state.gateway.store.add_event(
            &provider,
            "info",
            "usage.refresh_succeeded",
            "Usage refresh succeeded",
            serde_json::Value::Null,
        );
    } else {
        // Avoid double-logging: quota.rs already records an error event when refresh fails.
        let err = if snap.last_error.is_empty() {
            "usage refresh failed".to_string()
        } else {
            snap.last_error.chars().take(300).collect::<String>()
        };
        if crate::orchestrator::quota::is_followed_source_refresh_fallback_error(&err) {
            if let Some(owner) = crate::orchestrator::quota::followed_source_quota_fallback_target(
                &state.gateway,
                &state.lan_sync,
                &provider,
            ) {
                let cfg = state.gateway.cfg.read().clone();
                let fingerprint = crate::orchestrator::quota::shared_provider_fingerprint(
                    &cfg,
                    &state.gateway.secrets,
                    &provider,
                )
                .ok_or_else(|| "shared quota fingerprint unavailable".to_string())?;
                state.lan_sync.request_remote_quota_refresh(
                    &state.gateway,
                    &owner.owner_node_id,
                    &fingerprint,
                )?;
                state.gateway.store.add_event(
                    &provider,
                    "info",
                    "usage.refresh_forwarded_after_local_failure",
                    &format!(
                        "Usage refresh failed locally and was forwarded to {} ({})",
                        owner.owner_node_name, owner.owner_node_id
                    ),
                    serde_json::json!({
                        "owner_node_id": owner.owner_node_id,
                        "owner_node_name": owner.owner_node_name,
                        "local_error": err,
                    }),
                );
                return Ok(());
            }
        }
        return Err(err);
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn refresh_quota_shared(
    state: tauri::State<'_, app_state::AppState>,
    provider: String,
) -> Result<(), String> {
    let group =
        crate::orchestrator::quota::refresh_quota_shared(&state.gateway, &state.lan_sync, &provider)
            .await?;
    let n = group.len();
    // Keep the message short (events list is meant to be scannable).
    state.gateway.store.add_event(
        "gateway",
        "info",
        "usage.refresh_succeeded",
        &format!("Usage refresh succeeded (shared): {n} providers updated"),
        serde_json::json!({ "providers": n }),
    );
    Ok(())
}

#[tauri::command]
pub(crate) async fn refresh_quota_all(
    state: tauri::State<'_, app_state::AppState>,
) -> Result<(), String> {
    let (ok, err, failed) =
        crate::orchestrator::quota::refresh_quota_all_with_summary(&state.gateway, &state.lan_sync)
            .await;
    let now_ms = crate::orchestrator::store::unix_ms();
    if err == 0 {
        let (summary_to_emit, recovered_failures) = usage_refresh_on_success(now_ms, ok);
        if let Some(prev) = summary_to_emit {
            state.gateway.store.add_event(
                "gateway",
                "info",
                "usage.refresh_succeeded_summary",
                &format!(
                    "Usage refresh succeeded: {} runs, {} providers, 30m window",
                    prev.success_count, prev.providers
                ),
                serde_json::json!({
                    "runs": prev.success_count,
                    "providers": prev.providers,
                    "window_ms": USAGE_REFRESH_SUMMARY_WINDOW_MS,
                    "first_success_at_unix_ms": prev.first_success_at_ms,
                    "last_success_at_unix_ms": prev.last_success_at_ms
                }),
            );
        }
        if let Some(failed_count) = recovered_failures {
            state.gateway.store.add_event(
                "gateway",
                "info",
                "usage.refresh_recovered",
                &format!("Usage refresh recovered after {failed_count} failures"),
                serde_json::json!({ "failed_runs": failed_count, "providers": ok }),
            );
        }
    } else {
        usage_refresh_on_failure();
        let shown = failed
            .iter()
            .take(3)
            .cloned()
            .collect::<Vec<_>>()
            .join(", ");
        let suffix = if failed.len() > 3 { ", ..." } else { "" };
        state.gateway.store.add_event(
            "gateway",
            "error",
            "usage.refresh_partial",
            &format!("usage refresh partial: ok={ok} err={err} (failed: {shown}{suffix})"),
            serde_json::json!({ "ok": ok, "err": err, "failed": failed }),
        );
    }
    Ok(())
}

fn ensure_usage_settings_editable(
    state: &app_state::AppState,
    provider: &str,
) -> Result<(), String> {
    if !state.gateway.cfg.read().providers.contains_key(provider) {
        return Err(format!("unknown provider: {provider}"));
    }
    ensure_local_provider_definitions_editable(state)
}

fn set_usage_token_impl(
    state: &app_state::AppState,
    provider: &str,
    token: &str,
) -> Result<(), String> {
    ensure_usage_settings_editable(state, provider)?;
    state.secrets.set_usage_token(provider, token)?;
    if let Err(err) = crate::lan_sync::record_provider_definition_patch(
        state,
        provider,
        serde_json::json!({ "usage_token": token }),
    ) {
        state.gateway.store.add_event(
            provider,
            "error",
            "lan.edit_sync_record_failed",
            &format!("failed to record usage token update for LAN sync: {err}"),
            serde_json::Value::Null,
        );
    }
    state.gateway.store.add_event(
        provider,
        "info",
        "config.usage_token_updated",
        "usage token updated (user-data/secrets.json)",
        serde_json::Value::Null,
    );
    Ok(())
}

fn clear_usage_token_impl(state: &app_state::AppState, provider: &str) -> Result<(), String> {
    ensure_usage_settings_editable(state, provider)?;
    state.secrets.clear_usage_token(provider)?;
    if let Err(err) = crate::lan_sync::record_provider_definition_patch(
        state,
        provider,
        serde_json::json!({ "usage_token": serde_json::Value::Null }),
    ) {
        state.gateway.store.add_event(
            provider,
            "error",
            "lan.edit_sync_record_failed",
            &format!("failed to record usage token clear for LAN sync: {err}"),
            serde_json::Value::Null,
        );
    }
    state.gateway.store.add_event(
        provider,
        "info",
        "config.usage_token_cleared",
        "usage token cleared (user-data/secrets.json)",
        serde_json::Value::Null,
    );
    Ok(())
}

fn set_usage_auth_impl(
    state: &app_state::AppState,
    provider: &str,
    token: &str,
    username: &str,
    password: &str,
) -> Result<(), String> {
    ensure_usage_settings_editable(state, provider)?;
    let normalized_token = token.trim().to_string();
    let normalized_username = username.trim().to_string();
    if normalized_token.is_empty() {
        state.secrets.clear_usage_token(provider)?;
    } else {
        state.secrets.set_usage_token(provider, &normalized_token)?;
    }
    if normalized_username.is_empty() || password.is_empty() {
        state.secrets.clear_usage_login(provider)?;
    } else {
        state
            .secrets
            .set_usage_login(provider, &normalized_username, password)?;
    }
    if let Err(err) = crate::lan_sync::record_provider_definition_patch(
        state,
        provider,
        serde_json::json!({
            "usage_token": if normalized_token.is_empty() { serde_json::Value::Null } else { serde_json::Value::String(normalized_token.clone()) },
            "usage_login_username": if normalized_username.is_empty() { serde_json::Value::Null } else { serde_json::Value::String(normalized_username.clone()) },
            "usage_login_password": if normalized_username.is_empty() || password.is_empty() { serde_json::Value::Null } else { serde_json::Value::String(password.to_string()) },
        }),
    ) {
        state.gateway.store.add_event(
            provider,
            "error",
            "lan.edit_sync_record_failed",
            &format!("failed to record usage auth update for LAN sync: {err}"),
            serde_json::Value::Null,
        );
    }
    state.gateway.store.add_event(
        provider,
        "info",
        "config.usage_auth_updated",
        "usage auth updated (user-data/secrets.json)",
        serde_json::json!({
            "has_token": !normalized_token.is_empty(),
            "has_login": !normalized_username.is_empty() && !password.is_empty(),
        }),
    );
    Ok(())
}

fn clear_usage_auth_impl(state: &app_state::AppState, provider: &str) -> Result<(), String> {
    ensure_usage_settings_editable(state, provider)?;
    state.secrets.clear_usage_token(provider)?;
    state.secrets.clear_usage_login(provider)?;
    if let Err(err) = crate::lan_sync::record_provider_definition_patch(
        state,
        provider,
        serde_json::json!({
            "usage_token": serde_json::Value::Null,
            "usage_login_username": serde_json::Value::Null,
            "usage_login_password": serde_json::Value::Null,
        }),
    ) {
        state.gateway.store.add_event(
            provider,
            "error",
            "lan.edit_sync_record_failed",
            &format!("failed to record usage auth clear for LAN sync: {err}"),
            serde_json::Value::Null,
        );
    }
    state.gateway.store.add_event(
        provider,
        "info",
        "config.usage_auth_cleared",
        "usage auth cleared (user-data/secrets.json)",
        serde_json::Value::Null,
    );
    Ok(())
}

fn set_usage_base_url_impl(
    state: &app_state::AppState,
    provider: &str,
    url: &str,
) -> Result<(), String> {
    ensure_usage_settings_editable(state, provider)?;
    let provider_base_url = state
        .gateway
        .cfg
        .read()
        .providers
        .get(provider)
        .map(|provider| provider.base_url.clone())
        .ok_or_else(|| format!("unknown provider: {provider}"))?;
    let parsed = url.trim().trim_end_matches('/').to_string();
    let usage_base_url = crate::orchestrator::quota::canonical_packycode_usage_base(&provider_base_url)
        .filter(|_| crate::orchestrator::quota::canonical_packycode_usage_base(&parsed).is_some())
        .unwrap_or(parsed);
    if usage_base_url.is_empty() {
        return Err("url is required".to_string());
    }
    if reqwest::Url::parse(&usage_base_url).is_err() {
        return Err("invalid url".to_string());
    }
    {
        let mut cfg = state.gateway.cfg.write();
        if let Some(p) = cfg.providers.get_mut(provider) {
            p.usage_base_url = Some(usage_base_url.clone());
        }
    }
    persist_config_for_app_state(state).map_err(|e| e.to_string())?;
    if let Err(err) = crate::lan_sync::record_provider_definition_patch(
        state,
        provider,
        serde_json::json!({ "usage_base_url": usage_base_url.clone() }),
    ) {
        state.gateway.store.add_event(
            provider,
            "error",
            "lan.edit_sync_record_failed",
            &format!("failed to record usage base url update for LAN sync: {err}"),
            serde_json::Value::Null,
        );
    }
    state.gateway.store.add_event(
        provider,
        "info",
        "config.usage_base_url_updated",
        "usage base url updated",
        serde_json::Value::Null,
    );
    Ok(())
}

fn clear_usage_base_url_impl(state: &app_state::AppState, provider: &str) -> Result<(), String> {
    ensure_usage_settings_editable(state, provider)?;
    {
        let mut cfg = state.gateway.cfg.write();
        if let Some(p) = cfg.providers.get_mut(provider) {
            p.usage_base_url = None;
        }
    }
    persist_config_for_app_state(state).map_err(|e| e.to_string())?;
    crate::orchestrator::quota::clear_quota_snapshot(&state.gateway, provider);
    if let Err(err) = crate::lan_sync::record_provider_definition_patch(
        state,
        provider,
        serde_json::json!({ "usage_base_url": serde_json::Value::Null }),
    ) {
        state.gateway.store.add_event(
            provider,
            "error",
            "lan.edit_sync_record_failed",
            &format!("failed to record usage base url clear for LAN sync: {err}"),
            serde_json::Value::Null,
        );
    }
    state.gateway.store.add_event(
        provider,
        "info",
        "config.usage_base_url_cleared",
        "usage base url cleared",
        serde_json::Value::Null,
    );
    Ok(())
}

#[tauri::command]
pub(crate) fn set_usage_token(
    state: tauri::State<'_, app_state::AppState>,
    provider: String,
    token: String,
) -> Result<(), String> {
    set_usage_token_impl(&state, &provider, &token)
}

#[tauri::command]
pub(crate) fn clear_usage_token(
    state: tauri::State<'_, app_state::AppState>,
    provider: String,
) -> Result<(), String> {
    clear_usage_token_impl(&state, &provider)
}

#[tauri::command]
pub(crate) fn get_usage_auth(
    state: tauri::State<'_, app_state::AppState>,
    provider: String,
) -> Result<UsageAuthPayload, String> {
    if !state.gateway.cfg.read().providers.contains_key(&provider) {
        return Err(format!("unknown provider: {provider}"));
    }
    let token = state.secrets.get_usage_token(&provider).unwrap_or_default();
    let login = state.secrets.get_usage_login(&provider);
    Ok(UsageAuthPayload {
        token,
        username: login
            .as_ref()
            .map(|entry| entry.username.clone())
            .unwrap_or_default(),
        password: login.map(|entry| entry.password).unwrap_or_default(),
    })
}

#[tauri::command]
pub(crate) fn set_usage_auth(
    state: tauri::State<'_, app_state::AppState>,
    provider: String,
    token: String,
    username: String,
    password: String,
) -> Result<(), String> {
    set_usage_auth_impl(&state, &provider, &token, &username, &password)
}

#[tauri::command]
pub(crate) fn clear_usage_auth(
    state: tauri::State<'_, app_state::AppState>,
    provider: String,
) -> Result<(), String> {
    clear_usage_auth_impl(&state, &provider)
}

#[tauri::command]
pub(crate) fn set_usage_base_url(
    state: tauri::State<'_, app_state::AppState>,
    provider: String,
    url: String,
) -> Result<(), String> {
    set_usage_base_url_impl(&state, &provider, &url)
}

#[tauri::command]
pub(crate) fn clear_usage_base_url(
    state: tauri::State<'_, app_state::AppState>,
    provider: String,
) -> Result<(), String> {
    clear_usage_base_url_impl(&state, &provider)
}

#[tauri::command]
pub(crate) fn set_usage_proxy_pool(
    state: tauri::State<'_, app_state::AppState>,
    provider: String,
    proxies: Vec<String>,
) -> Result<(), String> {
    if !state.gateway.cfg.read().providers.contains_key(&provider) {
        return Err(format!("unknown provider: {provider}"));
    }
    state.secrets.set_usage_proxy_pool(&provider, proxies.clone())?;
    state.gateway.store.add_event(
        &provider,
        "info",
        "config.usage_proxy_pool_updated",
        "usage proxy pool updated",
        serde_json::json!({ "count": proxies.len() }),
    );
    Ok(())
}

#[tauri::command]
pub(crate) fn set_provider_quota_hard_cap(
    state: tauri::State<'_, app_state::AppState>,
    provider: String,
    daily: bool,
    weekly: bool,
    monthly: bool,
) -> Result<(), String> {
    if !state.gateway.cfg.read().providers.contains_key(&provider) {
        return Err(format!("unknown provider: {provider}"));
    }
    let hard_cap = crate::orchestrator::secrets::ProviderQuotaHardCapConfig {
        daily,
        weekly,
        monthly,
    };
    state
        .secrets
        .set_provider_quota_hard_cap(&provider, hard_cap)?;
    state.gateway.store.add_event(
        &provider,
        "info",
        "config.provider_quota_hard_cap_updated",
        "provider quota hard cap updated",
        serde_json::json!({
            "daily": daily,
            "weekly": weekly,
            "monthly": monthly,
        }),
    );
    Ok(())
}

#[tauri::command]
pub(crate) fn set_provider_quota_hard_cap_field(
    state: tauri::State<'_, app_state::AppState>,
    provider: String,
    field: String,
    enabled: bool,
) -> Result<(), String> {
    if !state.gateway.cfg.read().providers.contains_key(&provider) {
        return Err(format!("unknown provider: {provider}"));
    }
    let normalized_field = field.trim().to_ascii_lowercase();
    let hard_cap = state
        .secrets
        .set_provider_quota_hard_cap_field(&provider, normalized_field.as_str(), enabled)?;
    state.gateway.store.add_event(
        &provider,
        "info",
        "config.provider_quota_hard_cap_updated",
        "provider quota hard cap updated",
        serde_json::json!({
            "field": normalized_field,
            "enabled": enabled,
            "daily": hard_cap.daily,
            "weekly": hard_cap.weekly,
            "monthly": hard_cap.monthly,
        }),
    );
    Ok(())
}

#[tauri::command]
pub(crate) fn set_provider_manual_pricing(
    state: tauri::State<'_, app_state::AppState>,
    provider: String,
    mode: String,
    amount_usd: Option<f64>,
    package_expires_at_unix_ms: Option<u64>,
) -> Result<(), String> {
    if !state.gateway.cfg.read().providers.contains_key(&provider) {
        return Err(format!("unknown provider: {provider}"));
    }
    let mode = mode.trim().to_lowercase();
    let api_key_ref = provider_api_key_ref(&state, &provider);
    match mode.as_str() {
        "none" => {
            state.secrets.set_provider_pricing(
                &provider,
                "none",
                0.0,
                None,
                Some(api_key_ref.clone()),
            )?;
            state
                .gateway
                .store
                .sync_provider_pricing_configs(&state.secrets.list_provider_pricing());
            if let Err(err) = crate::lan_sync::record_provider_pricing_snapshot(&state, &provider) {
                state.gateway.store.add_event(
                    &provider,
                    "error",
                    "lan.edit_sync_record_failed",
                    &format!("failed to record pricing clear for LAN sync: {err}"),
                    serde_json::Value::Null,
                );
            }
            state.gateway.store.add_event(
                &provider,
                "info",
                "config.provider_pricing_cleared",
                "provider manual pricing cleared",
                serde_json::Value::Null,
            );
            Ok(())
        }
        "per_request" | "package_total" => {
            let Some(v) = amount_usd else {
                return Err("amount_usd is required".to_string());
            };
            if !v.is_finite() || v <= 0.0 {
                return Err("amount_usd must be > 0".to_string());
            }
            let expires = if mode == "package_total" {
                if let Some(ts) = package_expires_at_unix_ms {
                    if ts <= unix_ms() {
                        return Err("package_expires_at_unix_ms must be in the future".to_string());
                    }
                    Some(ts)
                } else {
                    None
                }
            } else {
                None
            };
            state.secrets.set_provider_pricing(
                &provider,
                &mode,
                v,
                expires,
                Some(api_key_ref.clone()),
            )?;
            state
                .gateway
                .store
                .sync_provider_pricing_configs(&state.secrets.list_provider_pricing());
            if let Err(err) = crate::lan_sync::record_provider_pricing_snapshot(&state, &provider) {
                state.gateway.store.add_event(
                    &provider,
                    "error",
                    "lan.edit_sync_record_failed",
                    &format!("failed to record pricing update for LAN sync: {err}"),
                    serde_json::Value::Null,
                );
            }
            state.gateway.store.add_event(
                &provider,
                "info",
                "config.provider_pricing_updated",
                "provider manual pricing updated",
                serde_json::json!({
                    "mode": mode,
                    "amount_usd": v,
                    "package_expires_at_unix_ms": expires,
                }),
            );
            Ok(())
        }
        _ => Err("mode must be one of: none, per_request, package_total".to_string()),
    }
}

#[tauri::command]
pub(crate) fn set_provider_gap_fill(
    state: tauri::State<'_, app_state::AppState>,
    provider: String,
    mode: String,
    amount_usd: Option<f64>,
) -> Result<(), String> {
    if !state.gateway.cfg.read().providers.contains_key(&provider) {
        return Err(format!("unknown provider: {provider}"));
    }
    let mode = mode.trim().to_lowercase();
    match mode.as_str() {
        "none" => {
            state.secrets.set_provider_gap_fill(&provider, None, None)?;
            state
                .gateway
                .store
                .sync_provider_pricing_configs(&state.secrets.list_provider_pricing());
            if let Err(err) = crate::lan_sync::record_provider_pricing_snapshot(&state, &provider) {
                state.gateway.store.add_event(
                    &provider,
                    "error",
                    "lan.edit_sync_record_failed",
                    &format!("failed to record gap-fill clear for LAN sync: {err}"),
                    serde_json::Value::Null,
                );
            }
            state.gateway.store.add_event(
                &provider,
                "info",
                "config.provider_gap_fill_cleared",
                "provider gap-fill pricing cleared",
                serde_json::Value::Null,
            );
            Ok(())
        }
        "per_request" | "total" | "per_day_average" => {
            let Some(v) = amount_usd else {
                return Err("amount_usd is required".to_string());
            };
            if !v.is_finite() || v <= 0.0 {
                return Err("amount_usd must be > 0".to_string());
            }
            state
                .secrets
                .set_provider_gap_fill(&provider, Some(&mode), Some(v))?;
            state
                .gateway
                .store
                .sync_provider_pricing_configs(&state.secrets.list_provider_pricing());
            if let Err(err) = crate::lan_sync::record_provider_pricing_snapshot(&state, &provider) {
                state.gateway.store.add_event(
                    &provider,
                    "error",
                    "lan.edit_sync_record_failed",
                    &format!("failed to record gap-fill update for LAN sync: {err}"),
                    serde_json::Value::Null,
                );
            }
            state.gateway.store.add_event(
                &provider,
                "info",
                "config.provider_gap_fill_updated",
                "provider gap-fill pricing updated",
                serde_json::json!({
                    "mode": mode,
                    "amount_usd": v,
                }),
            );
            Ok(())
        }
        _ => Err("mode must be one of: none, per_request, total, per_day_average".to_string()),
    }
}

#[tauri::command]
pub(crate) async fn get_effective_usage_base(
    state: tauri::State<'_, app_state::AppState>,
    provider: String,
) -> Result<Option<String>, String> {
    if !state.gateway.cfg.read().providers.contains_key(&provider) {
        return Err(format!("unknown provider: {provider}"));
    }
    Ok(crate::orchestrator::quota::effective_usage_base(&state.gateway, &provider).await)
}

#[tauri::command]
pub(crate) async fn probe_provider(
    state: tauri::State<'_, app_state::AppState>,
    provider: String,
) -> Result<(), String> {
    let cfg = state.gateway.cfg.read().clone();
    let Some(p) = cfg.providers.get(&provider) else {
        return Err(format!("unknown provider: {provider}"));
    };
    let now = unix_ms();
    state.gateway.router.sync_with_config(&cfg, now);
    let key = state.secrets.get_provider_key(&provider);

    let (status, _payload) = state
        .gateway
        .upstream
        .get_json(
            p,
            "/v1/models",
            key.as_deref(),
            None,
            cfg.routing.request_timeout_seconds,
        )
        .await
        .map_err(|e| {
            state
                .gateway
                .router
                .mark_failure(&provider, &cfg, &format!("request error: {e}"), now);
            state.gateway.store.add_event(
                &provider,
                "error",
                "health.probe_failed",
                "health probe failed (request error)",
                serde_json::Value::Null,
            );
            format!("request error: {e}")
        })?;

    if (200..300).contains(&status) {
        state.gateway.router.mark_success(&provider, now);
        state.gateway.store.add_event(
            &provider,
            "info",
            "health.probe_ok",
            "Provider is reachable and responding",
            serde_json::Value::Null,
        );
        return Ok(());
    }

    let err = format!("http {status}");
    state
        .gateway
        .router
        .mark_failure(&provider, &cfg, &err, now);
    state.gateway.store.add_event(
        &provider,
        "error",
        "health.probe_failed",
        "health probe failed",
        serde_json::Value::Null,
    );
    Err(err)
}

#[cfg(test)]
mod quota_ops_tests {
    use super::{set_usage_auth_impl, set_usage_base_url_impl, set_usage_token_impl};
    use crate::app_state::AppState;

    fn build_test_state() -> (tempfile::TempDir, AppState) {
        let tmp = tempfile::tempdir().expect("tempdir");
        let config_path = tmp.path().join("user-data").join("config.toml");
        let data_dir = tmp.path().join("data");
        let state = crate::app_state::build_state(config_path, data_dir).expect("build state");
        (tmp, state)
    }

    #[test]
    fn usage_secret_mutations_are_blocked_while_following_remote() {
        let (_tmp, state) = build_test_state();
        state
            .secrets
            .set_followed_config_source_node_id(Some("node-remote"))
            .expect("set followed source");

        let token_result = set_usage_token_impl(&state, "provider_1", "usage-token");
        let auth_result = set_usage_auth_impl(
            &state,
            "provider_1",
            "usage-token",
            "alice@example.com",
            "secret",
        );

        let expected = Err(
            "provider definitions are borrowed from a followed source; switch back to Local or copy first"
                .to_string(),
        );
        assert_eq!(token_result, expected);
        assert_eq!(
            auth_result,
            Err(
                "provider definitions are borrowed from a followed source; switch back to Local or copy first"
                    .to_string()
            )
        );
        assert_eq!(state.secrets.get_usage_token("provider_1"), None);
        assert_eq!(state.secrets.get_usage_login("provider_1"), None);
    }

    #[test]
    fn usage_base_url_mutations_are_blocked_while_following_remote() {
        let (_tmp, state) = build_test_state();
        state
            .secrets
            .set_followed_config_source_node_id(Some("node-remote"))
            .expect("set followed source");
        let original = state
            .gateway
            .cfg
            .read()
            .providers
            .get("provider_1")
            .and_then(|provider| provider.usage_base_url.clone());

        let result = set_usage_base_url_impl(&state, "provider_1", "https://usage.example/v1");

        assert_eq!(
            result,
            Err(
                "provider definitions are borrowed from a followed source; switch back to Local or copy first"
                    .to_string()
            )
        );
        assert_eq!(
            state
                .gateway
                .cfg
                .read()
                .providers
                .get("provider_1")
                .and_then(|provider| provider.usage_base_url.clone()),
            original
        );
    }
}

#[cfg(test)]
mod packycode_login_tests {
    use super::{
        extract_packycode_account_email, extract_packycode_token_from_devtools_payload,
        packycode_devtools_active_port_path, packycode_login_slug, parse_packycode_devtools_port,
    };

    #[test]
    fn packycode_login_slug_normalizes_provider_names() {
        assert_eq!(packycode_login_slug("Packycode 4"), "packycode-4");
        assert_eq!(packycode_login_slug("  @@  "), "provider");
    }

    #[test]
    fn packycode_devtools_active_port_path_is_stable() {
        assert_eq!(
            packycode_devtools_active_port_path(std::path::Path::new("C:/tmp/profile"))
                .file_name()
                .and_then(|value| value.to_str()),
            Some("DevToolsActivePort")
        );
    }

    #[test]
    fn parse_packycode_devtools_port_reads_first_line() {
        assert_eq!(parse_packycode_devtools_port("9222\n/browser-id"), Some(9222));
    }

    #[test]
    fn extract_packycode_login_token_reads_devtools_cookie_payload() {
        let payload = serde_json::json!({
            "result": {
                "cookies": [
                    { "name": "other", "value": "x" },
                    { "name": "token", "value": " bearer-token " }
                ]
            }
        });
        assert_eq!(
            extract_packycode_token_from_devtools_payload(&payload).as_deref(),
            Some("bearer-token")
        );
    }

    #[test]
    fn extract_packycode_account_email_reads_common_shapes() {
        let payload = serde_json::json!({
            "data": {
                "user": {
                    "email": "alice@example.com"
                }
            }
        });
        assert_eq!(
            extract_packycode_account_email(&payload).as_deref(),
            Some("alice@example.com")
        );
    }
}
