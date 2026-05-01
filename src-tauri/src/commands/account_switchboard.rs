#[tauri::command]
pub(crate) async fn codex_account_login(
    state: tauri::State<'_, app_state::AppState>,
    profile_id: Option<String>,
) -> Result<(), String> {
    let login_target = resolve_codex_account_login_target(
        &state.config_path,
        &state.secrets,
        profile_id.as_deref(),
    )?;
    let baseline_auth_json = login_target.baseline_auth_json.clone();
    if let Some(profile_id) = login_target.profile_id.as_deref() {
        state.secrets.select_official_account_profile(profile_id)?;
    }
    if let Some(runtime_auth_json) = login_target.runtime_auth_json.as_ref() {
        write_codex_auth_to_app(&state.config_path, runtime_auth_json)?;
        codex_app_server::refresh_server_in_home(None).await?;
    }
    let result =
        codex_app_server::request("account/login/start", serde_json::json!({ "type": "chatgpt" }))
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
    let config_path = state.config_path.clone();
    let secrets = state.secrets.clone();
    let profile_id = login_target.profile_id.clone();
    tauri::async_runtime::spawn(async move {
        let deadline = unix_ms().saturating_add(120_000);
        loop {
            if unix_ms() >= deadline {
                break;
            }
            if let Ok(signed_in) = refresh_codex_account_login_target_snapshot(
                &config_path,
                &gateway,
                &secrets,
                profile_id.as_deref(),
            )
            .await
            {
                let current_auth_json = read_codex_auth_for_login_target(&config_path);
                if should_finish_codex_account_login_poll(
                    baseline_auth_json.as_ref(),
                    current_auth_json.as_ref(),
                    signed_in,
                ) {
                    break;
                }
            }
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
    });
    Ok(())
}

struct CodexAccountLoginTarget {
    profile_id: Option<String>,
    baseline_auth_json: Option<Value>,
    runtime_auth_json: Option<Value>,
}

fn resolve_codex_account_login_target(
    config_path: &std::path::Path,
    secrets: &crate::orchestrator::secrets::SecretStore,
    profile_id: Option<&str>,
) -> Result<CodexAccountLoginTarget, String> {
    let Some(profile_id) = profile_id.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(CodexAccountLoginTarget {
            profile_id: None,
            baseline_auth_json: read_codex_auth_from_app(config_path),
            runtime_auth_json: None,
        });
    };

    let auth_json = secrets.official_account_profile_auth_json(profile_id)?;
    Ok(CodexAccountLoginTarget {
        profile_id: Some(profile_id.to_string()),
        baseline_auth_json: Some(auth_json.clone()),
        runtime_auth_json: Some(auth_json),
    })
}

fn read_codex_auth_for_login_target(config_path: &std::path::Path) -> Option<Value> {
    read_codex_auth_from_app(config_path)
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
) -> Result<serde_json::Value, String> {
    refresh_all_codex_account_usage(&state.config_path, &state.gateway, &state.secrets).await
}

#[tauri::command]
pub(crate) fn codex_account_profiles_list(
    state: tauri::State<'_, app_state::AppState>,
) -> Result<Vec<crate::orchestrator::secrets::OfficialAccountProfileSummary>, String> {
    Ok(state.secrets.list_official_account_profiles())
}

#[tauri::command]
pub(crate) fn codex_account_remote_profiles_list(
    state: tauri::State<'_, app_state::AppState>,
) -> Result<Vec<crate::lan_sync::LanOfficialAccountProfileSyncItem>, String> {
    let cfg = state.gateway.cfg.read().clone();
    let local_profiles = state.secrets.export_official_account_sync_items();
    let local_identity_keys = local_profiles
        .iter()
        .filter_map(|item| item.identity_key.clone())
        .collect::<std::collections::BTreeSet<_>>();
    let lan_snapshot = state.lan_sync.snapshot(cfg.listen.port, &cfg, &state.secrets);
    let mut remote_profiles = Vec::new();
    for peer in lan_snapshot.peers {
        if !peer.trusted {
            continue;
        }
        if crate::lan_sync::sync_contract_mismatch_detail(
            &peer,
            crate::lan_sync::LAN_SYNC_DOMAIN_OFFICIAL_ACCOUNTS,
        )
        .is_some()
        {
            continue;
        }
        if !peer
            .capabilities
            .iter()
            .any(|value| value == "official_accounts_v1")
        {
            continue;
        }
        let Ok(packet) = crate::lan_sync::fetch_official_account_profiles_from_peer(
            &state.lan_sync,
            &state.gateway,
            &peer,
        ) else {
            continue;
        };
        remote_profiles.extend(packet.profiles.into_iter().filter_map(|mut profile| {
            let keep = profile
                .identity_key
                .as_ref()
                .map(|identity| !local_identity_keys.contains(identity))
                .unwrap_or(true);
            if keep {
                profile.auth_json = None;
                Some(profile)
            } else {
                None
            }
        }));
    }
    remote_profiles.sort_by(|left, right| {
        left.source_node_name
            .cmp(&right.source_node_name)
            .then_with(|| left.summary.label.cmp(&right.summary.label))
    });
    Ok(remote_profiles)
}

#[tauri::command]
pub(crate) fn codex_account_profile_follow(
    state: tauri::State<'_, app_state::AppState>,
    source_node_id: String,
    remote_profile_id: String,
) -> Result<crate::orchestrator::secrets::OfficialAccountProfileSummary, String> {
    let source_node_id = source_node_id.trim();
    let remote_profile_id = remote_profile_id.trim();
    if source_node_id.is_empty() || remote_profile_id.is_empty() {
        return Err("source_node_id and remote_profile_id are required".to_string());
    }
    let cfg = state.gateway.cfg.read().clone();
    let lan_snapshot = state.lan_sync.snapshot(cfg.listen.port, &cfg, &state.secrets);
    let peer = lan_snapshot
        .peers
        .into_iter()
        .find(|peer| peer.node_id == source_node_id)
        .ok_or_else(|| format!("unknown or offline official account source: {source_node_id}"))?;
    if !peer.trusted || !state.secrets.is_lan_node_trusted(source_node_id) {
        return Err("official account source is not trusted; pair this device first".to_string());
    }
    if crate::lan_sync::sync_contract_mismatch_detail(
        &peer,
        crate::lan_sync::LAN_SYNC_DOMAIN_OFFICIAL_ACCOUNTS,
    )
    .is_some()
    {
        return Err("official account sync is blocked by a version mismatch".to_string());
    }
    let packet = crate::lan_sync::fetch_official_account_profiles_from_peer(
        &state.lan_sync,
        &state.gateway,
        &peer,
    )?;
    let profile = packet
        .profiles
        .into_iter()
        .find(|profile| profile.remote_profile_id == remote_profile_id)
        .ok_or_else(|| "remote official account is not available anymore".to_string())?;
    let auth_json = profile
        .auth_json
        .ok_or_else(|| "remote official account sync payload is missing auth_json".to_string())?;
    state
        .secrets
        .import_official_account_sync_item(
            &crate::orchestrator::secrets::OfficialAccountProfileSyncItem {
                id: profile.remote_profile_id,
                identity_key: profile.identity_key,
                summary: profile.summary,
                auth_json,
            },
        )
}

#[tauri::command]
pub(crate) fn codex_account_refresh_async(
    app: tauri::AppHandle,
    state: tauri::State<'_, app_state::AppState>,
) -> Result<(), String> {
    let config_path = state.config_path.clone();
    let gateway = state.gateway.clone();
    let secrets = state.secrets.clone();
    tauri::async_runtime::spawn(async move {
        let result = refresh_all_codex_account_usage(&config_path, &gateway, &secrets).await;
        let payload = match result {
            Ok(value) => value,
            Err(error) => serde_json::json!({ "ok": false, "error": error }),
        };
        let _ = tauri::Emitter::emit(&app, "codex-account-refreshed", payload);
    });
    Ok(())
}

#[tauri::command]
pub(crate) fn codex_account_profile_select(
    state: tauri::State<'_, app_state::AppState>,
    profile_id: String,
) -> Result<crate::orchestrator::secrets::OfficialAccountProfileSummary, String> {
    state.secrets.select_official_account_profile(&profile_id)
}

pub(crate) fn write_selected_official_account_to_app(
    config_path: &std::path::Path,
    secrets: &crate::orchestrator::secrets::SecretStore,
) -> Result<(), String> {
    let auth_json = secrets
        .active_official_account_profile_auth_json()
        .ok_or_else(|| "Missing selected official Codex auth profile. Try logging in first.".to_string())?;
    write_codex_auth_to_app(config_path, &auth_json)
}

#[tauri::command]
pub(crate) fn codex_account_profile_remove(
    state: tauri::State<'_, app_state::AppState>,
    profile_id: String,
) -> Result<(), String> {
    state.secrets.remove_official_account_profile(&profile_id)
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
pub(crate) fn codex_cli_directories_get(
    state: tauri::State<'_, app_state::AppState>,
) -> Result<crate::codex_cli_swap::CodexCliDirectories, String> {
    Ok(crate::codex_cli_swap::load_cli_directories_for_config(
        &state.config_path,
    ))
}

#[tauri::command]
pub(crate) fn codex_cli_directories_set(
    state: tauri::State<'_, app_state::AppState>,
    windows_enabled: bool,
    windows_home: String,
    wsl2_enabled: bool,
    wsl2_home: String,
) -> Result<(), String> {
    crate::codex_cli_swap::save_cli_directories_for_config(
        &state.config_path,
        &crate::codex_cli_swap::CodexCliDirectories {
            windows_enabled,
            windows_home,
            wsl2_enabled,
            wsl2_home,
        },
    )
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

fn persist_config_for_app_state(state: &app_state::AppState) -> anyhow::Result<()> {
    let cfg = state.gateway.cfg.read().clone();
    std::fs::write(&state.config_path, toml::to_string_pretty(&cfg)?)?;
    Ok(())
}

fn persist_config(state: &tauri::State<'_, app_state::AppState>) -> anyhow::Result<()> {
    persist_config_for_app_state(state)
}

async fn refresh_codex_account_snapshot(
    config_path: &std::path::Path,
    gateway: &crate::orchestrator::gateway::GatewayState,
    secrets: Option<&crate::orchestrator::secrets::SecretStore>,
) -> Result<bool, String> {
    let app_auth_json = read_codex_auth_from_app(config_path);
    let usage = read_codex_account_usage(None, app_auth_json.as_ref()).await?;
    gateway
        .store
        .put_codex_account_snapshot(&codex_account_usage_status_snapshot(&usage));
    if usage.signed_in {
        if let Some(store) = secrets {
            if let Some(app_auth_json) = app_auth_json.as_ref() {
                let usage = crate::orchestrator::secrets::OfficialAccountUsageSnapshot {
                    limit_5h_remaining: usage.limit_5h_remaining.clone(),
                    limit_5h_reset_at: usage.limit_5h_reset_at.clone(),
                    limit_weekly_remaining: usage.limit_weekly_remaining.clone(),
                    limit_weekly_reset_at: usage.limit_weekly_reset_at.clone(),
                };
                let _ = store.capture_official_account_profile(app_auth_json, None, Some(&usage));
            }
        }
    }
    Ok(usage.signed_in)
}

async fn refresh_codex_account_login_target_snapshot(
    config_path: &std::path::Path,
    gateway: &crate::orchestrator::gateway::GatewayState,
    secrets: &crate::orchestrator::secrets::SecretStore,
    profile_id: Option<&str>,
) -> Result<bool, String> {
    let Some(profile_id) = profile_id else {
        return refresh_codex_account_snapshot(config_path, gateway, Some(secrets)).await;
    };

    let auth_json = read_codex_auth_from_app(config_path)
        .or_else(|| secrets.official_account_profile_auth_json(profile_id).ok())
        .ok_or_else(|| format!("official account profile not found: {profile_id}"))?;
    let usage = read_codex_account_usage(None, Some(&auth_json)).await?;
    let usage_snapshot = crate::orchestrator::secrets::OfficialAccountUsageSnapshot {
        limit_5h_remaining: usage.limit_5h_remaining.clone(),
        limit_5h_reset_at: usage.limit_5h_reset_at.clone(),
        limit_weekly_remaining: usage.limit_weekly_remaining.clone(),
        limit_weekly_reset_at: usage.limit_weekly_reset_at.clone(),
    };
    let refreshed_auth_json = read_codex_auth_from_app(config_path).unwrap_or(auth_json);
    secrets.update_official_account_profile_usage_and_auth(
        profile_id,
        &usage_snapshot,
        Some(&refreshed_auth_json),
    )?;
    if secrets
        .active_official_account_profile_auth_json()
        .as_ref()
        == Some(&refreshed_auth_json)
    {
        gateway
            .store
            .put_codex_account_snapshot(&codex_account_usage_status_snapshot(&usage));
    }
    Ok(usage.signed_in)
}

fn codex_account_usage_status_snapshot(usage: &CodexAccountUsageRead) -> serde_json::Value {
    serde_json::json!({
      "ok": usage.error.is_empty(),
      "checked_at_unix_ms": unix_ms(),
      "signed_in": usage.signed_in,
      "remaining": usage.remaining,
      "limit_5h_remaining": usage.limit_5h_remaining,
      "limit_5h_reset_at": usage.limit_5h_reset_at,
      "limit_weekly_remaining": usage.limit_weekly_remaining,
      "limit_weekly_reset_at": usage.limit_weekly_reset_at,
      "code_review_remaining": usage.code_review_remaining,
      "code_review_reset_at": usage.code_review_reset_at,
      "unlimited": usage.unlimited,
      "error": usage.error
    })
}

#[derive(Default)]
struct OfficialAccountProfilesRefreshOutcome {
    refreshed: usize,
    failures: Vec<serde_json::Value>,
    active_usage: Option<CodexAccountUsageRead>,
}

async fn refresh_all_codex_account_usage(
    config_path: &std::path::Path,
    gateway: &crate::orchestrator::gateway::GatewayState,
    secrets: &crate::orchestrator::secrets::SecretStore,
) -> Result<serde_json::Value, String> {
    let outcome = refresh_official_account_profiles_usage(config_path, secrets).await?;
    if let Some(usage) = outcome.active_usage.as_ref() {
        gateway
            .store
            .put_codex_account_snapshot(&codex_account_usage_status_snapshot(usage));
    } else if outcome.refreshed == 0 {
        let signed_in = refresh_codex_account_snapshot(config_path, gateway, Some(secrets)).await?;
        return Ok(serde_json::json!({
            "ok": signed_in,
            "refreshed": 0,
            "failures": outcome.failures,
        }));
    }
    Ok(serde_json::json!({
        "ok": outcome.failures.is_empty(),
        "refreshed": outcome.refreshed,
        "failures": outcome.failures,
    }))
}

async fn refresh_official_account_profiles_usage(
    config_path: &std::path::Path,
    secrets: &crate::orchestrator::secrets::SecretStore,
) -> Result<OfficialAccountProfilesRefreshOutcome, String> {
    let profile_summaries = secrets.list_official_account_profiles();
    let active_profile_id = profile_summaries
        .iter()
        .find(|profile| profile.active)
        .map(|profile| profile.id.clone());
    let profile_summary_by_id = profile_summaries
        .into_iter()
        .map(|profile| (profile.id.clone(), profile))
        .collect::<std::collections::BTreeMap<_, _>>();
    let entries = secrets.list_official_account_profile_auth_entries();
    let mut outcome = OfficialAccountProfilesRefreshOutcome::default();
    for entry in entries {
        let profile_summary = profile_summary_by_id.get(&entry.id);
        let now_unix_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_millis() as u64)
            .unwrap_or(0);
        let mut profile_home: Option<std::path::PathBuf> = None;
        let usage_result = async {
            let home =
                ensure_official_account_profile_home(config_path, &entry.id, &entry.auth_json)?;
            profile_home = Some(home.clone());
            let home_text = home.to_string_lossy().to_string();
            if official_account_auth_needs_runtime_refresh(&entry.auth_json, now_unix_ms) {
                crate::codex_app_server::refresh_server_in_home(Some(home_text.as_str())).await?;
            }
            let mut usage =
                read_codex_account_usage(Some(home_text.as_str()), Some(&entry.auth_json)).await?;
            if !has_official_account_usage_limits(&usage)
                && (official_account_auth_needs_runtime_refresh(&entry.auth_json, now_unix_ms)
                    || !usage.signed_in)
            {
                crate::codex_app_server::refresh_server_in_home(Some(home_text.as_str())).await?;
                usage = read_codex_account_usage(Some(home_text.as_str()), Some(&entry.auth_json))
                    .await?;
            }
            Ok::<CodexAccountUsageRead, String>(usage)
        }
        .await;
        let usage = match usage_result {
            Ok(usage) => usage,
            Err(error) => {
                outcome.failures.push(serde_json::json!({
                    "profileId": entry.id,
                    "label": profile_summary.and_then(|profile| profile.label.clone().into()),
                    "email": profile_summary.and_then(|profile| profile.email.clone()),
                    "error": error,
                }));
                continue;
            }
        };
        if !has_official_account_usage_limits(&usage) {
                outcome.failures.push(serde_json::json!({
                    "profileId": entry.id,
                    "label": profile_summary.map(|profile| profile.label.clone()),
                    "email": profile_summary.and_then(|profile| profile.email.clone()),
                    "error": "official account rate limits unavailable",
                }));
            continue;
        }
        let snapshot = crate::orchestrator::secrets::OfficialAccountUsageSnapshot {
            limit_5h_remaining: usage.limit_5h_remaining.clone(),
            limit_5h_reset_at: usage.limit_5h_reset_at.clone(),
            limit_weekly_remaining: usage.limit_weekly_remaining.clone(),
            limit_weekly_reset_at: usage.limit_weekly_reset_at.clone(),
        };
        let refreshed_auth_json = profile_home
            .as_deref()
            .and_then(read_official_account_profile_home_auth);
        if let Err(error) = secrets.update_official_account_profile_usage_and_auth(
            &entry.id,
            &snapshot,
            refreshed_auth_json.as_ref(),
        ) {
            outcome.failures.push(serde_json::json!({
                "profileId": entry.id,
                "label": profile_summary.map(|profile| profile.label.clone()),
                "email": profile_summary.and_then(|profile| profile.email.clone()),
                "error": error,
            }));
            continue;
        }
        outcome.refreshed += 1;
        if active_profile_id.as_deref() == Some(entry.id.as_str()) {
            outcome.active_usage = Some(usage);
        }
    }
    if outcome.refreshed == 0 && !outcome.failures.is_empty() {
        return Err(format!(
            "failed to refresh all official accounts ({} failed)",
            outcome.failures.len()
        ));
    }
    Ok(outcome)
}

fn has_official_account_usage_limits(usage: &CodexAccountUsageRead) -> bool {
    usage.limit_5h_remaining.is_some() || usage.limit_weekly_remaining.is_some()
}

fn read_codex_auth_from_app(config_path: &std::path::Path) -> Option<Value> {
    let app_auth = config_path.parent()?.join("codex-home").join("auth.json");
    let text = std::fs::read_to_string(app_auth).ok()?;
    serde_json::from_str::<Value>(&text).ok()
}

fn read_codex_access_token(auth_json: Option<&Value>) -> Option<String> {
    auth_json
        .and_then(|value| value.get("tokens"))
        .and_then(|tokens| tokens.get("access_token"))
        .and_then(|token| token.as_str())
        .map(str::trim)
        .filter(|token| !token.is_empty())
        .map(|token| token.to_string())
}

const OFFICIAL_ACCOUNT_REFRESH_GRACE_MS: u64 = 5 * 60 * 1000;
const OFFICIAL_ACCOUNT_REFRESH_STALE_AFTER_MS: u64 = 8 * 24 * 60 * 60 * 1000;

fn official_account_access_token_expires_at_unix_ms(auth_json: &Value) -> Option<u64> {
    let token = auth_json
        .get("tokens")
        .and_then(|tokens| tokens.get("access_token"))
        .and_then(|value| value.as_str())?;
    let payload = token.split('.').nth(1)?;
    let bytes = base64::Engine::decode(
        &base64::engine::general_purpose::URL_SAFE_NO_PAD,
        payload,
    )
    .ok()?;
    let json = serde_json::from_slice::<Value>(&bytes).ok()?;
    let exp = json.get("exp").and_then(|value| value.as_u64())?;
    exp.checked_mul(1000)
}

fn official_account_last_refresh_unix_ms(auth_json: &Value) -> Option<u64> {
    let raw = auth_json.get("last_refresh").and_then(|value| value.as_str())?;
    let parsed = chrono::DateTime::parse_from_rfc3339(raw).ok()?;
    let millis = parsed.timestamp_millis();
    u64::try_from(millis).ok()
}

fn official_account_auth_needs_runtime_refresh(auth_json: &Value, now_unix_ms: u64) -> bool {
    if official_account_access_token_expires_at_unix_ms(auth_json)
        .is_some_and(|value| value <= now_unix_ms.saturating_add(OFFICIAL_ACCOUNT_REFRESH_GRACE_MS))
    {
        return true;
    }
    official_account_last_refresh_unix_ms(auth_json).is_some_and(|value| {
        now_unix_ms.saturating_sub(value) >= OFFICIAL_ACCOUNT_REFRESH_STALE_AFTER_MS
    })
}

fn ensure_official_account_profile_home(
    config_path: &std::path::Path,
    profile_id: &str,
    auth_json: &Value,
) -> Result<std::path::PathBuf, String> {
    let home = config_path
        .parent()
        .unwrap_or(std::path::Path::new("."))
        .join("codex-profile-homes")
        .join(profile_id);
    std::fs::create_dir_all(&home).map_err(|e| e.to_string())?;
    let auth_path = home.join("auth.json");
    let text = serde_json::to_string_pretty(auth_json).map_err(|e| e.to_string())?;
    std::fs::write(auth_path, text).map_err(|e| e.to_string())?;
    Ok(home)
}

fn read_official_account_profile_home_auth(home: &std::path::Path) -> Option<Value> {
    let auth_path = home.join("auth.json");
    let text = std::fs::read_to_string(auth_path).ok()?;
    serde_json::from_str::<Value>(&text).ok()
}

struct CodexAccountUsageRead {
    signed_in: bool,
    remaining: Option<String>,
    unlimited: Option<bool>,
    limit_5h_remaining: Option<String>,
    limit_5h_reset_at: Option<String>,
    limit_weekly_remaining: Option<String>,
    limit_weekly_reset_at: Option<String>,
    code_review_remaining: Option<String>,
    code_review_reset_at: Option<String>,
    error: String,
}

async fn read_codex_account_usage(
    codex_home: Option<&str>,
    auth_json: Option<&Value>,
) -> Result<CodexAccountUsageRead, String> {
    let mut signed_in = false;
    let mut remaining: Option<String> = None;
    let mut unlimited: Option<bool> = None;
    let mut limit_5h_remaining: Option<String> = None;
    let mut limit_5h_reset_at: Option<String> = None;
    let mut limit_weekly_remaining: Option<String> = None;
    let mut limit_weekly_reset_at: Option<String> = None;
    let mut code_review_remaining: Option<String> = None;
    let mut code_review_reset_at: Option<String> = None;
    let mut error = String::new();

    let auth = if let Some(home) = codex_home {
        codex_app_server::request_in_home(Some(home), "getAuthStatus", Value::Null).await?
    } else {
        codex_app_server::request("getAuthStatus", Value::Null).await?
    };
    if let Some(tok) = auth.get("authToken").and_then(|v| v.as_str()) {
        if !tok.trim().is_empty() {
            signed_in = true;
        }
    }

    let rate_limits = if let Some(home) = codex_home {
        codex_app_server::request_in_home(Some(home), "account/rateLimits/read", Value::Null).await
    } else {
        codex_app_server::request("account/rateLimits/read", Value::Null).await
    };
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
                                limit_5h_reset_at = get_reset_time_str(node);
                            } else if window_mins == Some(10080) || target == "secondary" {
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

    if let Some(access_token) = read_codex_access_token(auth_json) {
        if let Ok(Some((remaining, reset_at))) = fetch_code_review_from_wham(&access_token).await {
            code_review_remaining = Some(remaining);
            code_review_reset_at = reset_at;
        }
    }

    Ok(CodexAccountUsageRead {
        signed_in,
        remaining,
        unlimited,
        limit_5h_remaining,
        limit_5h_reset_at,
        limit_weekly_remaining,
        limit_weekly_reset_at,
        code_review_remaining,
        code_review_reset_at,
        error,
    })
}

fn auth_json_changed(
    baseline_auth_json: Option<&Value>,
    current_auth_json: Option<&Value>,
) -> bool {
    match (baseline_auth_json, current_auth_json) {
        (None, Some(_)) => true,
        (Some(_), None) => false,
        (Some(baseline), Some(current)) => baseline != current,
        (None, None) => false,
    }
}

fn should_finish_codex_account_login_poll(
    baseline_auth_json: Option<&Value>,
    current_auth_json: Option<&Value>,
    signed_in: bool,
) -> bool {
    signed_in && auth_json_changed(baseline_auth_json, current_auth_json)
}

fn write_codex_auth_to_app(config_path: &std::path::Path, auth_json: &Value) -> Result<(), String> {
    let app_auth = config_path
        .parent()
        .unwrap_or(std::path::Path::new("."))
        .join("codex-home")
        .join("auth.json");
    if let Some(parent) = app_auth.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(auth_json).map_err(|e| e.to_string())?;
    std::fs::write(app_auth, text).map_err(|e| e.to_string())
}

#[cfg(test)]
fn read_codex_access_token_from_app(config_path: &std::path::Path) -> Option<String> {
    let auth_json = read_codex_auth_from_app(config_path)?;
    read_codex_access_token(Some(&auth_json))
}

#[cfg(test)]
#[allow(clippy::await_holding_lock)]
mod account_switchboard_tests {
    use super::*;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use crate::orchestrator::secrets::SecretStore;
    use std::sync::Arc;

    fn test_id_token(email: &str, plan: &str) -> String {
        let payload = serde_json::json!({
            "email": email,
            "chatgpt_plan_type": plan,
        });
        let payload_b64 = base64::Engine::encode(
            &base64::engine::general_purpose::URL_SAFE_NO_PAD,
            serde_json::to_vec(&payload).expect("payload json"),
        );
        format!("header.{payload_b64}.signature")
    }

    fn test_access_token_with_exp(exp_unix_secs: u64) -> String {
        let payload = serde_json::json!({ "exp": exp_unix_secs });
        let payload_b64 = base64::Engine::encode(
            &URL_SAFE_NO_PAD,
            serde_json::to_vec(&payload).expect("payload json"),
        );
        format!("header.{payload_b64}.signature")
    }

    #[test]
    fn read_codex_access_token_from_app_uses_app_local_codex_home() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let config_path = tmp.path().join("user-data").join("config.toml");
        let app_auth = config_path.parent().unwrap().join("codex-home").join("auth.json");
        std::fs::create_dir_all(app_auth.parent().expect("app auth parent")).expect("mkdir");
        std::fs::write(
            &app_auth,
            r#"{"tokens":{"access_token":"app-token","refresh_token":"app-refresh"}}"#,
        )
        .expect("write app auth");

        let cli_home = tmp.path().join(".codex");
        std::fs::create_dir_all(&cli_home).expect("mkdir cli");
        std::fs::write(
            cli_home.join("auth.json"),
            r#"{"OPENAI_API_KEY":"ao-runtime","tokens":{"access_token":"runtime-token"}}"#,
        )
        .expect("write cli auth");

        assert_eq!(
            read_codex_access_token_from_app(&config_path).as_deref(),
            Some("app-token")
        );
    }

    #[test]
    fn write_codex_auth_to_app_persists_selected_profile() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let config_path = tmp.path().join("user-data").join("config.toml");
        let auth_json = serde_json::json!({
            "tokens": {
                "access_token": "chosen-access",
                "refresh_token": "chosen-refresh"
            }
        });

        write_codex_auth_to_app(&config_path, &auth_json).expect("write selected auth");

        assert_eq!(
            read_codex_access_token_from_app(&config_path).as_deref(),
            Some("chosen-access")
        );
    }

    #[test]
    fn official_account_auth_needs_runtime_refresh_when_access_token_is_expired() {
        let now_unix_ms = 1_800_000_000_000u64;
        let auth_json = serde_json::json!({
            "tokens": {
                "access_token": test_access_token_with_exp((now_unix_ms / 1000).saturating_sub(1))
            }
        });

        assert!(official_account_auth_needs_runtime_refresh(
            &auth_json,
            now_unix_ms,
        ));
    }

    #[test]
    fn official_account_auth_needs_runtime_refresh_when_last_refresh_is_stale() {
        let now_unix_ms = 1_800_000_000_000u64;
        let stale = chrono::DateTime::from_timestamp_millis(
            (now_unix_ms - OFFICIAL_ACCOUNT_REFRESH_STALE_AFTER_MS - 1_000) as i64,
        )
        .expect("timestamp")
        .to_rfc3339();
        let auth_json = serde_json::json!({
            "last_refresh": stale,
            "tokens": {
                "access_token": test_access_token_with_exp((now_unix_ms / 1000).saturating_add(86_400))
            }
        });

        assert!(official_account_auth_needs_runtime_refresh(
            &auth_json,
            now_unix_ms,
        ));
    }

    #[test]
    fn official_account_auth_does_not_refresh_when_recent_and_unexpired() {
        let now_unix_ms = 1_800_000_000_000u64;
        let recent = chrono::DateTime::from_timestamp_millis(
            (now_unix_ms - 60_000) as i64,
        )
        .expect("timestamp")
        .to_rfc3339();
        let auth_json = serde_json::json!({
            "last_refresh": recent,
            "tokens": {
                "access_token": test_access_token_with_exp((now_unix_ms / 1000).saturating_add(86_400))
            }
        });

        assert!(!official_account_auth_needs_runtime_refresh(
            &auth_json,
            now_unix_ms,
        ));
    }

    #[test]
    fn select_official_account_profile_does_not_mutate_app_auth() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let config_path = tmp.path().join("user-data").join("config.toml");
        let store = SecretStore::new(tmp.path().join("user-data").join("secrets.json"));
        let first_auth = serde_json::json!({
            "tokens": {
                "account_id": "acct-1",
                "access_token": "token-1",
                "refresh_token": "refresh-1"
            }
        });
        let second_auth = serde_json::json!({
            "tokens": {
                "account_id": "acct-2",
                "access_token": "token-2",
                "refresh_token": "refresh-2"
            }
        });

        let _first = store
            .capture_official_account_profile(&first_auth, Some("Official account 1"), None)
            .expect("capture first");
        let second = store
            .capture_official_account_profile(&second_auth, Some("Official account 2"), None)
            .expect("capture second");

        write_codex_auth_to_app(&config_path, &first_auth).expect("seed app auth");

        let selected = store
            .select_official_account_profile(&second.id)
            .expect("select second");
        assert_eq!(selected.id, second.id);
        assert_eq!(
            read_codex_access_token_from_app(&config_path).as_deref(),
            Some("token-1"),
            "dashboard profile selection must not rewrite app auth.json"
        );
        assert_eq!(
            store.active_official_account_profile_auth_json(),
            Some(second_auth),
            "selection should only update active official profile"
        );
    }

    #[test]
    fn write_selected_official_account_to_app_uses_current_profile() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let config_path = tmp.path().join("user-data").join("config.toml");
        let store = SecretStore::new(tmp.path().join("user-data").join("secrets.json"));
        let first_auth = serde_json::json!({
            "tokens": {
                "account_id": "acct-1",
                "access_token": "token-1",
                "refresh_token": "refresh-1"
            }
        });
        let second_auth = serde_json::json!({
            "tokens": {
                "account_id": "acct-2",
                "access_token": "token-2",
                "refresh_token": "refresh-2"
            }
        });

        let _first = store
            .capture_official_account_profile(&first_auth, Some("Official account 1"), None)
            .expect("capture first");
        let second = store
            .capture_official_account_profile(&second_auth, Some("Official account 2"), None)
            .expect("capture second");
        store
            .select_official_account_profile(&second.id)
            .expect("select second");

        write_selected_official_account_to_app(&config_path, &store)
            .expect("write selected account to app");

        assert_eq!(
            read_codex_access_token_from_app(&config_path).as_deref(),
            Some("token-2"),
            "official mode switch must materialize the selected official profile"
        );
    }

    #[test]
    fn captured_app_auth_is_listed_as_an_official_profile() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let config_path = tmp.path().join("user-data").join("config.toml");
        let app_auth = config_path.parent().unwrap().join("codex-home").join("auth.json");
        std::fs::create_dir_all(app_auth.parent().expect("auth parent")).expect("mkdir auth parent");
        std::fs::write(
            &app_auth,
            r#"{"tokens":{"access_token":"capture-access","refresh_token":"capture-refresh"}}"#,
        )
        .expect("write app auth");

        let secrets = SecretStore::new(tmp.path().join("user-data").join("secrets.json"));
        let auth_json = read_codex_auth_from_app(&config_path).expect("read app auth json");
        let saved = secrets
            .capture_official_account_profile(&auth_json, None, None)
            .expect("capture official profile");

        let profiles = secrets.list_official_account_profiles();
        assert_eq!(profiles.len(), 1);
        assert_eq!(profiles[0].id, saved.id);
        assert!(profiles[0].active);
    }

    #[test]
    fn login_poll_does_not_finish_for_existing_signed_in_auth() {
        let baseline = serde_json::json!({
            "tokens": {
                "account_id": "acct-1",
                "access_token": "token-1"
            }
        });

        assert!(!should_finish_codex_account_login_poll(
            Some(&baseline),
            Some(&baseline),
            true,
        ));
    }

    #[test]
    fn login_poll_finishes_after_auth_json_changes() {
        let baseline = serde_json::json!({
            "tokens": {
                "account_id": "acct-1",
                "access_token": "token-1"
            }
        });
        let current = serde_json::json!({
            "tokens": {
                "account_id": "acct-2",
                "access_token": "token-2"
            }
        });

        assert!(should_finish_codex_account_login_poll(
            Some(&baseline),
            Some(&current),
            true,
        ));
    }

    #[test]
    fn resolve_codex_account_login_target_materializes_profile_into_runtime_auth() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let config_path = tmp.path().join("user-data").join("config.toml");
        std::fs::create_dir_all(config_path.parent().expect("config parent")).expect("mkdir");
        write_codex_auth_to_app(
            &config_path,
            &serde_json::json!({
                "tokens": {
                    "account_id": "app-acct",
                    "access_token": "app-token"
                }
            }),
        )
        .expect("seed app auth");

        let store = SecretStore::new(tmp.path().join("user-data").join("secrets.json"));
        let profile = store
            .capture_official_account_profile(
                &serde_json::json!({
                    "tokens": {
                        "account_id": "profile-acct",
                        "access_token": "profile-token"
                    }
                }),
                Some("Official account 1"),
                None,
            )
            .expect("capture profile");

        let target = resolve_codex_account_login_target(&config_path, &store, Some(&profile.id))
            .expect("resolve target");

        assert_eq!(target.profile_id.as_deref(), Some(profile.id.as_str()));
        assert_eq!(
            target
                .baseline_auth_json
                .as_ref()
                .and_then(|json| json.get("tokens"))
                .and_then(|tokens| tokens.get("access_token"))
                .and_then(|value| value.as_str()),
            Some("profile-token")
        );
        assert_eq!(
            target
                .runtime_auth_json
                .as_ref()
                .and_then(|json| json.get("tokens"))
                .and_then(|tokens| tokens.get("access_token"))
                .and_then(|value| value.as_str()),
            Some("profile-token")
        );
        assert_eq!(
            read_codex_access_token_from_app(&config_path).as_deref(),
            Some("app-token"),
            "profile reauth target resolution must not rewrite runtime auth before login starts"
        );
    }

    #[tokio::test]
    async fn refresh_official_account_profiles_usage_reads_each_profile_in_its_own_home() {
        let _guard = crate::codex_app_server::lock_test_globals();
        let first_profile_id = Arc::new(std::sync::Mutex::new(String::new()));
        let second_profile_id = Arc::new(std::sync::Mutex::new(String::new()));
        let first_profile_id_for_handler = first_profile_id.clone();
        let second_profile_id_for_handler = second_profile_id.clone();
        crate::codex_app_server::_set_test_request_handler(Some(Arc::new(
            move |codex_home, method, _params| {
                let home = codex_home.unwrap_or_default();
                let first_id = first_profile_id_for_handler
                    .lock()
                    .map(|value| value.clone())
                    .unwrap_or_default();
                let second_id = second_profile_id_for_handler
                    .lock()
                    .map(|value| value.clone())
                    .unwrap_or_default();
                let profile_kind = if !first_id.is_empty() && home.contains(first_id.as_str()) {
                    "first"
                } else if !second_id.is_empty() && home.contains(second_id.as_str()) {
                    "second"
                } else {
                    "unknown"
                };
                match method {
                    "getAuthStatus" => Ok(serde_json::json!({ "authToken": format!("token-{profile_kind}") })),
                    "account/rateLimits/read" => {
                        let (five_hour_used, weekly_used) = match profile_kind {
                            "first" => (13.0, 87.0),
                            "second" => (36.0, 59.0),
                            _ => (0.0, 0.0),
                        };
                        Ok(serde_json::json!({
                            "rateLimits": {
                                "primary": {
                                    "usedPercent": five_hour_used,
                                    "windowDurationMins": 300,
                                    "resetAt": "111"
                                },
                                "secondary": {
                                    "usedPercent": weekly_used,
                                    "windowDurationMins": 10080,
                                    "resetAt": "222"
                                }
                            }
                        }))
                    }
                    _ => Err(format!("unexpected method: {method}")),
                }
            },
        )))
        .await;

        let tmp = tempfile::tempdir().expect("tempdir");
        let config_path = tmp.path().join("user-data").join("config.toml");
        std::fs::create_dir_all(config_path.parent().expect("config parent")).expect("mkdir");
        let store = SecretStore::new(tmp.path().join("user-data").join("secrets.json"));

        let first = store
            .capture_official_account_profile(
                &serde_json::json!({ "tokens": { "account_id": "acct-1" } }),
                Some("Official account 1"),
                None,
            )
            .expect("capture first");
        let second = store
            .capture_official_account_profile(
                &serde_json::json!({ "tokens": { "account_id": "acct-2" } }),
                Some("Official account 2"),
                None,
            )
            .expect("capture second");
        *first_profile_id.lock().expect("first profile id lock") = first.id.clone();
        *second_profile_id.lock().expect("second profile id lock") = second.id.clone();

        refresh_official_account_profiles_usage(&config_path, &store)
            .await
            .expect("refresh usage");

        let profiles = store.list_official_account_profiles();
        assert_eq!(profiles.len(), 2);
        assert_eq!(profiles[0].label, "Official account 1");
        assert_eq!(profiles[0].limit_5h_remaining.as_deref(), Some("87%"));
        assert_eq!(profiles[0].limit_weekly_remaining.as_deref(), Some("13%"));
        assert_eq!(profiles[1].label, "Official account 2");
        assert_eq!(profiles[1].limit_5h_remaining.as_deref(), Some("64%"));
        assert_eq!(profiles[1].limit_weekly_remaining.as_deref(), Some("41%"));

        crate::codex_app_server::_set_test_request_handler(None).await;
    }

    #[tokio::test]
    async fn refresh_official_account_profiles_usage_updates_refreshed_auth_plan_label() {
        let _guard = crate::codex_app_server::lock_test_globals();
        crate::codex_app_server::_set_test_request_handler(Some(Arc::new(
            move |codex_home, method, _params| {
                let home = codex_home.expect("profile home");
                match method {
                    "getAuthStatus" => Ok(serde_json::json!({ "authToken": "token-refreshed" })),
                    "account/rateLimits/read" => {
                        let refreshed_auth = serde_json::json!({
                            "tokens": {
                                "account_id": "acct-1",
                                "id_token": test_id_token("user@example.com", "free")
                            }
                        });
                        std::fs::write(
                            std::path::Path::new(home).join("auth.json"),
                            serde_json::to_string_pretty(&refreshed_auth)
                                .expect("serialize refreshed auth"),
                        )
                        .expect("write refreshed auth");
                        Ok(serde_json::json!({
                            "rateLimits": {
                                "secondary": {
                                    "usedPercent": 59.0,
                                    "windowDurationMins": 10080,
                                    "resetAt": "222"
                                }
                            }
                        }))
                    }
                    _ => Err(format!("unexpected method: {method}")),
                }
            },
        )))
        .await;

        let tmp = tempfile::tempdir().expect("tempdir");
        let config_path = tmp.path().join("user-data").join("config.toml");
        std::fs::create_dir_all(config_path.parent().expect("config parent")).expect("mkdir");
        let store = SecretStore::new(tmp.path().join("user-data").join("secrets.json"));
        store
            .capture_official_account_profile(
                &serde_json::json!({
                    "tokens": {
                        "account_id": "acct-1",
                        "id_token": test_id_token("user@example.com", "prolite")
                    }
                }),
                Some("Official account 1"),
                None,
            )
            .expect("capture profile");

        refresh_official_account_profiles_usage(&config_path, &store)
            .await
            .expect("refresh usage");

        let profiles = store.list_official_account_profiles();
        assert_eq!(profiles[0].plan_label.as_deref(), Some("Free"));
        assert_eq!(profiles[0].limit_weekly_remaining.as_deref(), Some("41%"));

        crate::codex_app_server::_set_test_request_handler(None).await;
    }

    #[tokio::test]
    async fn refresh_official_account_profiles_usage_keeps_refreshing_after_profile_failure() {
        let _guard = crate::codex_app_server::lock_test_globals();
        let first_profile_id = Arc::new(std::sync::Mutex::new(String::new()));
        let second_profile_id = Arc::new(std::sync::Mutex::new(String::new()));
        let first_profile_id_for_handler = first_profile_id.clone();
        let second_profile_id_for_handler = second_profile_id.clone();
        crate::codex_app_server::_set_test_request_handler(Some(Arc::new(
            move |codex_home, method, _params| {
                let home = codex_home.unwrap_or_default();
                let first_id = first_profile_id_for_handler
                    .lock()
                    .map(|value| value.clone())
                    .unwrap_or_default();
                let second_id = second_profile_id_for_handler
                    .lock()
                    .map(|value| value.clone())
                    .unwrap_or_default();
                let profile_kind = if !first_id.is_empty() && home.contains(first_id.as_str()) {
                    "first"
                } else if !second_id.is_empty() && home.contains(second_id.as_str()) {
                    "second"
                } else {
                    "unknown"
                };
                match method {
                    "getAuthStatus" => Ok(serde_json::json!({ "authToken": format!("token-{profile_kind}") })),
                    "account/rateLimits/read" if profile_kind == "first" => {
                        Err("first account refresh failed".to_string())
                    }
                    "account/rateLimits/read" => Ok(serde_json::json!({
                        "rateLimits": {
                            "primary": {
                                "usedPercent": 36.0,
                                "windowDurationMins": 300,
                                "resetAt": "111"
                            },
                            "secondary": {
                                "usedPercent": 59.0,
                                "windowDurationMins": 10080,
                                "resetAt": "222"
                            }
                        }
                    })),
                    _ => Err(format!("unexpected method: {method}")),
                }
            },
        )))
        .await;

        let tmp = tempfile::tempdir().expect("tempdir");
        let config_path = tmp.path().join("user-data").join("config.toml");
        std::fs::create_dir_all(config_path.parent().expect("config parent")).expect("mkdir");
        let store = SecretStore::new(tmp.path().join("user-data").join("secrets.json"));

        let first = store
            .capture_official_account_profile(
                &serde_json::json!({ "tokens": { "account_id": "acct-1" } }),
                Some("Official account 1"),
                None,
            )
            .expect("capture first");
        let second = store
            .capture_official_account_profile(
                &serde_json::json!({ "tokens": { "account_id": "acct-2" } }),
                Some("Official account 2"),
                None,
            )
            .expect("capture second");
        *first_profile_id.lock().expect("first profile id lock") = first.id.clone();
        *second_profile_id.lock().expect("second profile id lock") = second.id.clone();

        let outcome = refresh_official_account_profiles_usage(&config_path, &store)
            .await
            .expect("partial refresh succeeds");

        assert_eq!(outcome.refreshed, 1);
        assert_eq!(outcome.failures.len(), 1);
        let profiles = store.list_official_account_profiles();
        assert_eq!(profiles.len(), 2);
        assert_eq!(profiles[0].limit_5h_remaining.as_deref(), None);
        assert_eq!(profiles[1].limit_5h_remaining.as_deref(), Some("64%"));
        assert_eq!(profiles[1].limit_weekly_remaining.as_deref(), Some("41%"));

        crate::codex_app_server::_set_test_request_handler(None).await;
    }
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
