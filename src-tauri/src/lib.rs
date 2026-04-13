mod app_state;
mod codex_app_server;
mod codex_cli_swap;
mod codex_home_env;
mod codex_wsl_bridge;
mod commands;
mod constants;
mod diagnostics;
mod lan_sync;
mod orchestrator;
mod platform;
mod provider_switchboard;
mod tailscale_diagnostics;

use tauri::Manager;
#[cfg(target_os = "windows")]
use tauri_plugin_notification::NotificationExt;

use crate::app_state::build_state;
use crate::orchestrator::gateway::serve_in_background;
use crate::orchestrator::gateway_bootstrap::prepare_gateway_listeners;
use crate::orchestrator::store::unix_ms;
use chrono::{Duration as ChronoDuration, Local};
use serde_json::json;
use std::path::{Path, PathBuf};
use std::time::Instant;

fn normalize_profile_name(raw: &str) -> String {
    let trimmed = raw.trim().to_ascii_lowercase();
    if trimmed.is_empty() || trimmed == "default" {
        return "default".to_string();
    }
    let normalized: String = trimmed
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();
    let collapsed = normalized
        .trim_matches('-')
        .split('-')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    if collapsed.is_empty() {
        "default".to_string()
    } else {
        collapsed
    }
}

fn infer_profile_from_exe_stem(stem: &str) -> Option<String> {
    let s = stem.trim().to_ascii_lowercase();
    if s.is_empty() {
        return None;
    }
    if s.contains("[test]") {
        return Some("test".to_string());
    }
    None
}

fn app_profile_name_from_inputs(raw_profile: Option<&str>, exe_stem: Option<&str>) -> String {
    let raw = raw_profile.unwrap_or_default();
    let normalized = normalize_profile_name(raw);
    if !raw.trim().is_empty() {
        return normalized;
    }
    exe_stem
        .and_then(infer_profile_from_exe_stem)
        .unwrap_or(normalized)
}

fn app_profile_name() -> String {
    let raw = std::env::var("API_ROUTER_PROFILE").unwrap_or_default();
    let exe_stem = std::env::current_exe().ok().and_then(|p| {
        p.file_stem()
            .and_then(|s| s.to_str())
            .map(|s| s.to_string())
    });
    app_profile_name_from_inputs(Some(raw.as_str()), exe_stem.as_deref())
}

fn app_launch_args() -> Vec<String> {
    std::env::args().collect()
}

fn app_launch_requests_hidden(args: &[String]) -> bool {
    args.iter().any(|arg| arg == "--start-hidden")
}

fn should_reveal_main_window_on_setup(start_hidden: bool, is_ui_tauri: bool) -> bool {
    !start_hidden && !is_ui_tauri
}

fn reveal_main_window(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.set_skip_taskbar(false);
        let _ = w.set_focusable(true);
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn hide_main_window_for_background_launch(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.set_skip_taskbar(true);
        let _ = w.set_focusable(false);
        let _ = w.minimize();
        let _ = w.hide();
    }
}

#[cfg(target_os = "windows")]
fn maybe_notify_hidden_remote_update_success(app: &tauri::AppHandle) {
    let target_ref = std::env::var("API_ROUTER_REMOTE_UPDATE_TARGET_REF")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let Some(target_ref) = target_ref else {
        write_app_startup_diag(
            "remote_update_success_notification_skipped",
            0,
            Some("no target ref"),
        );
        return;
    };
    let short_target = target_ref.chars().take(8).collect::<String>();
    let body = if short_target.is_empty() {
        "API Router updated successfully and is running in the background.".to_string()
    } else {
        format!(
            "API Router updated successfully to {short_target} and is running in the background."
        )
    };
    if let Err(err) = app
        .notification()
        .builder()
        .title("API Router updated")
        .body(&body)
        .show()
    {
        write_app_startup_diag(
            "remote_update_success_notification_failed",
            0,
            Some(&err.to_string()),
        );
        log::warn!("failed to show remote update notification: {err}");
    } else {
        write_app_startup_diag(
            "remote_update_success_notification_shown",
            0,
            Some(&format!("target_ref={short_target}")),
        );
    }
}

#[cfg(not(target_os = "windows"))]
fn maybe_notify_hidden_remote_update_success(_app: &tauri::AppHandle) {}

fn profile_data_dir_name(profile: &str) -> String {
    if profile == "default" {
        "user-data".to_string()
    } else {
        format!("user-data-{profile}")
    }
}

fn should_reset_profile_data(profile: &str, is_ui_tauri: bool) -> bool {
    !is_ui_tauri && profile == "test"
}

fn should_seed_mock_data(profile: &str, is_ui_tauri: bool) -> bool {
    !is_ui_tauri && profile == "test"
}

fn resolve_codex_home(user_data_dir: &Path, _is_ui_tauri: bool, _app_profile: &str) -> PathBuf {
    let isolated = user_data_dir.join("codex-home");

    if let Ok(explicit) = std::env::var("API_ROUTER_CODEX_HOME") {
        let trimmed = explicit.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }

    // Keep app auth/session isolated by default so login state is stable inside API Router.
    isolated
}

fn app_startup_diag_path() -> Option<PathBuf> {
    let user_data_dir = std::env::var("API_ROUTER_USER_DATA_DIR").ok()?;
    let trimmed = user_data_dir.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(PathBuf::from(trimmed).join("app-startup.json"))
}

fn reset_app_startup_diag() {
    let Some(path) = app_startup_diag_path() else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let payload = json!({
        "updatedAtUnixMs": unix_ms(),
        "stages": [],
    });
    let _ = std::fs::write(
        path,
        serde_json::to_vec_pretty(&payload).unwrap_or_default(),
    );
}

fn write_app_startup_diag(stage: &str, elapsed_ms: u128, detail: Option<&str>) {
    let Some(path) = app_startup_diag_path() else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let mut payload = std::fs::read(&path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .unwrap_or_else(|| json!({ "stages": [] }));
    if let Some(stages) = payload
        .get_mut("stages")
        .and_then(|value| value.as_array_mut())
    {
        stages.push(json!({
            "stage": stage,
            "elapsedMs": elapsed_ms,
            "detail": detail,
            "updatedAtUnixMs": unix_ms(),
        }));
    } else {
        payload["stages"] = json!([{
            "stage": stage,
            "elapsedMs": elapsed_ms,
            "detail": detail,
            "updatedAtUnixMs": unix_ms(),
        }]);
    }
    payload["updatedAtUnixMs"] = json!(unix_ms());
    let _ = std::fs::write(
        path,
        serde_json::to_vec_pretty(&payload).unwrap_or_default(),
    );
}

fn seed_test_profile_data(state: &app_state::AppState) -> anyhow::Result<()> {
    {
        let mut cfg = state.gateway.cfg.write();
        if let Some(p1) = cfg.providers.get_mut("provider_1") {
            p1.display_name = "Provider 1".to_string();
            p1.base_url = "https://provider1.mock.local/v1".to_string();
        }
        if let Some(p2) = cfg.providers.get_mut("provider_2") {
            p2.display_name = "Provider 2".to_string();
            p2.base_url = "https://provider2.mock.local/v1".to_string();
        }
        cfg.routing.preferred_provider = "provider_1".to_string();
        app_state::normalize_provider_order(&mut cfg);
        std::fs::write(&state.config_path, toml::to_string_pretty(&*cfg)?)?;
    }

    let _ = state
        .secrets
        .set_provider_key("official", "sk-test-official-key");
    let _ = state
        .secrets
        .set_provider_key("provider_1", "sk-test-provider-1-key");
    let _ = state
        .secrets
        .set_provider_key("provider_2", "sk-test-provider-2-key");

    // Seed deterministic per-request pricing so Usage Statistics can render anomaly rows in test mode.
    let _ = state.secrets.set_provider_pricing(
        "official",
        "per_request",
        0.02,
        None,
        Some("-".to_string()),
    );
    let _ = state.secrets.set_provider_pricing(
        "provider_2",
        "per_request",
        0.03,
        None,
        Some("-".to_string()),
    );
    let _ = state.secrets.set_provider_pricing(
        "provider_1",
        "per_request",
        0.22,
        None,
        Some("-".to_string()),
    );
    state
        .gateway
        .store
        .sync_provider_pricing_configs(&state.secrets.list_provider_pricing());

    let seed_usage_requests =
        |provider: &str, model: &str, count: usize, input_tokens: u64, output_tokens: u64| {
            for i in 0..count {
                let total = input_tokens.saturating_add(output_tokens);
                let cache_create = if i % 4 == 0 {
                    100_000 + ((i as u64 * 137_731) % 900_000)
                } else {
                    0
                };
                let cache_read = if i % 3 == 0 {
                    100_000 + ((i as u64 * 219_541) % 900_000)
                } else {
                    0
                };
                let origin = if i % 2 == 0 {
                    crate::constants::USAGE_ORIGIN_WINDOWS
                } else {
                    crate::constants::USAGE_ORIGIN_WSL2
                };
                let session_id = format!("test-session-{}", (i % 9) + 1);
                let local_node_id = state.lan_sync.local_node_id();
                let local_node_name = state.lan_sync.local_node_name();
                state.gateway.store.record_success_with_model(
                    provider,
                    &json!({
                        "id": format!("test-seed-{provider}-{i}"),
                        "model": model,
                        "usage": {
                            "input_tokens": input_tokens,
                            "output_tokens": output_tokens,
                            "total_tokens": total,
                            "cache_creation_input_tokens": cache_create,
                            "cache_read_input_tokens": cache_read,
                        }
                    }),
                    crate::orchestrator::store::UsageRequestContext {
                        api_key_ref: Some("test"),
                        origin,
                        transport: "http",
                        session_id: Some(session_id.as_str()),
                        node_id: Some(local_node_id.as_str()),
                        node_name: Some(local_node_name.as_str()),
                    },
                    None,
                );
            }
        };
    // Keep totals uneven so provider_1 appears as a clear outlier in anomaly watch.
    seed_usage_requests("official", "gpt-5.2", 8, 620, 180);
    seed_usage_requests("provider_2", "gpt-5.2", 9, 700, 210);
    seed_usage_requests("provider_1", "gpt-5.2", 10, 980, 320);

    let now = unix_ms();
    for i in 0..45 {
        let day = (Local::now() - ChronoDuration::days(i)).format("%Y-%m-%d");
        let day_key = day.to_string();
        let total_1 = 1.2 + (i as f64 * 0.11);
        let total_2 = 0.9 + (i as f64 * 0.08);
        state.gateway.store.put_spend_manual_day(
            "provider_1",
            &day_key,
            &json!({
                "provider": "provider_1",
                "day_key": day_key,
                "manual_total_usd": total_1,
                "manual_usd_per_req": 0.022,
                "updated_at_unix_ms": now.saturating_sub((i as u64) * 3_600_000),
            }),
        );
        state.gateway.store.put_spend_manual_day(
            "provider_2",
            &day_key,
            &json!({
                "provider": "provider_2",
                "day_key": day_key,
                "manual_total_usd": total_2,
                "manual_usd_per_req": 0.018,
                "updated_at_unix_ms": now.saturating_sub((i as u64) * 4_200_000),
            }),
        );
    }

    // Seed enough event-log rows so UI pagination/incremental loading can be verified in test profile.
    for i in 0..520 {
        let provider = if i % 3 == 0 {
            "provider_1"
        } else if i % 3 == 1 {
            "provider_2"
        } else {
            "official"
        };
        state.gateway.store.events().emit(
            provider,
            crate::orchestrator::store::EventCode::TEST_PROFILE_BULK_EVENT,
            &format!("test profile bulk event #{i}"),
            json!({
                "seed": true,
                "seq": i,
                "codex_session_id": format!("test-session-{}", i % 9),
            }),
        );
    }

    state.gateway.store.events().emit(
        "gateway",
        crate::orchestrator::store::EventCode::TEST_PROFILE_MOCK_SEEDED,
        "test profile mock data seeded",
        json!({
            "providers": ["provider_1", "provider_2"],
            "history_days": 45,
            "seeded_events": 520,
        }),
    );
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let is_ui_tauri = std::env::var("UI_TAURI").ok().as_deref() == Some("1");
    let app_profile = app_profile_name();
    let launch_args = app_launch_args();
    let start_hidden = app_launch_requests_hidden(&launch_args);
    let mut builder = tauri::Builder::default().plugin(tauri_plugin_notification::init());
    if !is_ui_tauri && app_profile != "test" {
        // Ensure clicking the EXE again focuses the existing instance instead of launching a second one.
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if app_launch_requests_hidden(&argv) {
                return;
            }
            reveal_main_window(app);
        }));
    }
    let app_profile_for_setup = app_profile.clone();
    builder
        .setup(move |app| {
            // UI automation should not steal focus or visibly pop up windows.
            // The WebView still needs a real window on Windows/WebView2, so we move it far off-screen
            // and hide it from the taskbar (best-effort).
            if std::env::var("UI_TAURI").ok().as_deref() == Some("1") {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.set_skip_taskbar(true);
                    let _ = w.set_focusable(false);
                    let _ = w.minimize();
                    let _ = w.set_position(tauri::Position::Physical(tauri::PhysicalPosition {
                        x: 100_000,
                        y: 100_000,
                    }));
                }
            }

            let hidden_remote_update_launch = start_hidden && !is_ui_tauri;
            if hidden_remote_update_launch {
                hide_main_window_for_background_launch(app.handle());
            } else if should_reveal_main_window_on_setup(start_hidden, is_ui_tauri) {
                reveal_main_window(app.handle());
            }

            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // Canonical runtime layout is always local to the running EXE so config, secrets,
            // SQLite, logs, and diagnostics stay together and are easy to inspect/port.
            // Layout:
            // - user-data/config.toml
            // - user-data/secrets.json
            // - user-data/data/* (sled store, metrics, events)
            let is_ui_tauri = std::env::var("UI_TAURI").ok().as_deref() == Some("1");
            let app_profile = app_profile_for_setup.clone();
            let user_data_dir = if is_ui_tauri {
                if let Ok(p) = std::env::var("UI_TAURI_PROFILE_DIR") {
                    let p = PathBuf::from(p);
                    let _ = std::fs::create_dir_all(&p);
                    p
                } else {
                    let p = std::env::temp_dir()
                        .join("api-router-ui-check")
                        .join(format!("{}", std::process::id()));
                    let _ = std::fs::create_dir_all(&p);
                    p
                }
            } else {
                let exe = std::env::current_exe()?;
                let dir = exe
                    .parent()
                    .map(std::path::Path::to_path_buf)
                    .ok_or_else(|| anyhow::anyhow!("failed to resolve EXE directory"))?;
                let p = dir.join(profile_data_dir_name(&app_profile));
                let _ = std::fs::create_dir_all(&p);
                p
            };

            if should_reset_profile_data(&app_profile, is_ui_tauri) {
                if user_data_dir.exists() {
                    let _ = std::fs::remove_dir_all(&user_data_dir);
                }
                let _ = std::fs::create_dir_all(&user_data_dir);
            }

            // Share the existing ~/.codex history in the default profile so Web Codex can
            // show real chats, while still allowing isolated homes for test/non-default profiles.
            let codex_home = resolve_codex_home(&user_data_dir, is_ui_tauri, &app_profile);
            let _ = std::fs::create_dir_all(&codex_home);
            // Coordinate with tests/commands that also set CODEX_HOME (process-global env).
            {
                let _lock = crate::codex_home_env::lock_env();
                std::env::set_var("CODEX_HOME", &codex_home);
            }
            std::env::set_var("API_ROUTER_USER_DATA_DIR", &user_data_dir);
            reset_app_startup_diag();
            if hidden_remote_update_launch {
                // The remote-update completion notification is emitted by the restarted Tauri
                // process, not the hidden PowerShell worker. This path is more reliable and now
                // leaves app-startup diagnostics when Windows accepts or rejects the notification.
                maybe_notify_hidden_remote_update_success(app.handle());
            }

            let build_state_started = Instant::now();
            let state = build_state(
                user_data_dir.join("config.toml"),
                user_data_dir.join("data"),
            )?;
            write_app_startup_diag(
                "build_state",
                build_state_started.elapsed().as_millis(),
                None,
            );
            if should_seed_mock_data(&app_profile, is_ui_tauri) {
                if let Err(e) = seed_test_profile_data(&state) {
                    eprintln!("failed to seed test profile mock data: {e}");
                }
            }
            app.manage(state);
            {
                let st = app.state::<app_state::AppState>();
                crate::lan_sync::register_gateway_status_runtime(st.lan_sync.clone());
                crate::platform::local_network::spawn_monitor(
                    app.handle(),
                    st.local_network.clone(),
                );
                if let Some(local_node) = crate::lan_sync::current_local_node_identity() {
                    if let Ok((migrated_spend_days, migrated_manual_days)) = st
                        .gateway
                        .store
                        .migrate_legacy_remote_usage_sources_if_needed(&local_node.node_id)
                    {
                        if migrated_spend_days > 0 || migrated_manual_days > 0 {
                            st.gateway.store.events().emit(
                                "gateway",
                                crate::orchestrator::store::EventCode::LAN_LEGACY_USAGE_SOURCES_MIGRATED,
                                "Migrated legacy LAN usage history into source-scoped remote storage",
                                serde_json::json!({
                                    "migrated_spend_days": migrated_spend_days,
                                    "migrated_manual_days": migrated_manual_days,
                                    "local_node_id": local_node.node_id,
                                }),
                            );
                        }
                    }
                }
            }
            if !is_ui_tauri {
                let st = app.state::<app_state::AppState>();
                if cfg!(target_os = "windows") {
                    if let Ok(app_path) = std::env::current_exe() {
                        std::thread::spawn(move || {
                            crate::platform::windows_firewall::ensure_api_router_udp_firewall_rule(
                                &app_path,
                            );
                        });
                    }
                }
                st.lan_sync
                    .start_background(st.gateway.clone(), st.config_path.clone());
                crate::lan_sync::reconcile_remote_update_terminal_event(&st.gateway);
            }
            if !is_ui_tauri {
                let app_handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let st = app_handle.state::<app_state::AppState>();
                    let started = Instant::now();
                    let updated = app_state::run_startup_usage_key_ref_backfill(&st);
                    let detail = format!("updated_rows={updated}");
                    write_app_startup_diag(
                        "usage_key_ref_backfill",
                        started.elapsed().as_millis(),
                        Some(&detail),
                    );
                });
                let app_handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let st = app_handle.state::<app_state::AppState>();
                    let started = Instant::now();
                    let updated = app_state::run_startup_usage_request_node_backfill(&st);
                    let detail = format!("updated_rows={updated}");
                    write_app_startup_diag(
                        "usage_request_node_backfill",
                        started.elapsed().as_millis(),
                        Some(&detail),
                    );
                });
            }

            if !is_ui_tauri {
                // Spawn the local OpenAI-compatible gateway without blocking Tauri setup.
                let app_handle = app.handle().clone();
                write_app_startup_diag("gateway_spawn_scheduled", 0, None);
                tauri::async_runtime::spawn(async move {
                    write_app_startup_diag("gateway_spawn_enter", 0, None);
                    let (gateway, prepared_gateway) = {
                        let st = app_handle.state::<app_state::AppState>();
                        write_app_startup_diag("gateway_prepare_enter", 0, None);
                        let prepare_started = Instant::now();
                        let prepared_gateway = match prepare_gateway_listeners(&st) {
                            Ok(prepared) => prepared,
                            Err(err) => {
                                let detail = err.to_string();
                                write_app_startup_diag(
                                    "prepare_gateway_listeners_failed",
                                    prepare_started.elapsed().as_millis(),
                                    Some(&detail),
                                );
                                log::error!("prepare gateway listeners failed: {detail}");
                                return;
                            }
                        };
                        write_app_startup_diag(
                            "prepare_gateway_listeners",
                            prepare_started.elapsed().as_millis(),
                            Some(&format!("listen_port={}", prepared_gateway.listen_port)),
                        );

                        let token_sync_started = Instant::now();
                        app_state::run_startup_gateway_token_sync(&st);
                        write_app_startup_diag(
                            "startup_gateway_token_sync",
                            token_sync_started.elapsed().as_millis(),
                            None,
                        );
                        (st.gateway.clone(), prepared_gateway)
                    };
                    write_app_startup_diag(
                        "serve_in_background_enter",
                        0,
                        Some(&format!("listen_port={}", prepared_gateway.listen_port)),
                    );
                    if let Err(e) = serve_in_background(gateway, prepared_gateway).await {
                        write_app_startup_diag(
                            "serve_in_background_failed",
                            0,
                            Some(&e.to_string()),
                        );
                        log::error!("gateway exited: {e:?}");
                    } else {
                        write_app_startup_diag("serve_in_background_completed", 0, None);
                    }
                });

                // Quota refresh scheduler: only runs when the gateway is actively being used.
                let st = app.state::<app_state::AppState>();
                let gateway = st.gateway.clone();
                let lan_sync = st.lan_sync.clone();
                tauri::async_runtime::spawn(async move {
                    crate::orchestrator::quota::run_quota_scheduler(gateway, lan_sync).await;
                });

                let app_handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    loop {
                        tokio::time::sleep(std::time::Duration::from_secs(30)).await;
                        let st = app_handle.state::<app_state::AppState>();
                        let _ = app_state::disable_expired_package_providers(&st);
                    }
                });

                let app_handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    loop {
                        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                        let st = app_handle.state::<app_state::AppState>();
                        st.ui_watchdog.check_unresponsive(
                            &st.gateway.store,
                            &st.diagnostics_dir,
                            unix_ms(),
                        );
                    }
                });
            }

            if app_profile == "default" {
                // Tray menu so the app is usable even when the main window starts hidden.
                let show = tauri::menu::MenuItemBuilder::with_id("show", "Show").build(app)?;
                let quit = tauri::menu::MenuItemBuilder::with_id("quit", "Quit").build(app)?;
                let menu = tauri::menu::MenuBuilder::new(app)
                    .items(&[&show, &quit])
                    .build()?;

                // Ensure the tray icon has an actual image on Windows; otherwise it can appear as "blank".
                // We always provide an explicit tray icon (rather than relying on default_window_icon)
                // because on Windows the "default" can still render as an empty square.
                let icon = (|| {
                    let bytes = include_bytes!("../icons/32x32.png");
                    let img = image::load_from_memory(bytes).ok()?.to_rgba8();
                    let (w, h) = img.dimensions();
                    Some(tauri::image::Image::new_owned(img.into_raw(), w, h))
                })();

                let mut tray_builder = tauri::tray::TrayIconBuilder::new()
                    .menu(&menu)
                    .on_menu_event(|app: &tauri::AppHandle, event: tauri::menu::MenuEvent| {
                        match event.id().as_ref() {
                            "show" => {
                                reveal_main_window(app);
                            }
                            "quit" => {
                                app.exit(0);
                            }
                            _ => {}
                        }
                    });

                if let Some(icon) = icon {
                    tray_builder = tray_builder.icon(icon);
                }

                let _tray = tray_builder.build(app)?;
            }

            // Closing the window should minimize to tray instead of exiting (background mode).
            if let Some(w) = app.get_webview_window("main") {
                if !is_ui_tauri && app_profile != "default" {
                    let _ = w.set_title(&format!(
                        "API Router [{}]",
                        app_profile.to_ascii_uppercase()
                    ));
                }
                if app_profile == "default" {
                    let w2 = w.clone();
                    w.on_window_event(move |event| {
                        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                            api.prevent_close();
                            let _ = w2.hide();
                        }
                    });
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_status,
            commands::record_app_startup_stage,
            commands::record_web_transport_event,
            commands::record_ui_watchdog_heartbeat,
            commands::record_ui_trace,
            commands::record_ui_diagnostics_batch,
            commands::record_ui_slow_refresh,
            commands::record_ui_long_task,
            commands::record_ui_frame_stall,
            commands::record_ui_frontend_error,
            commands::record_ui_invoke_result,
            commands::open_external_url,
            commands::get_event_log_entries,
            commands::get_event_log_entry_by_id,
            commands::get_event_log_years,
            commands::get_event_log_daily_stats,
            commands::set_manual_override,
            commands::get_config,
            commands::request_lan_pair,
            commands::approve_lan_pair,
            commands::submit_lan_pair_pin,
            commands::request_lan_remote_update,
            commands::request_lan_remote_update_same_version,
            commands::fetch_lan_peer_remote_update_debug,
            commands::set_followed_config_source,
            commands::clear_followed_config_source,
            commands::copy_provider_from_config_source,
            commands::get_gateway_token_preview,
            commands::get_gateway_token,
            commands::rotate_gateway_token,
            commands::set_preferred_provider,
            commands::set_route_mode,
            commands::set_session_preferred_provider,
            commands::clear_session_preferred_provider,
            commands::upsert_provider,
            commands::set_provider_supports_websockets,
            commands::set_provider_disabled,
            commands::set_provider_group,
            commands::set_providers_group,
            commands::delete_provider,
            commands::rename_provider,
            commands::get_provider_key,
            commands::set_provider_key,
            commands::clear_provider_key,
            commands::set_provider_account_email,
            commands::clear_provider_account_email,
            commands::refresh_quota,
            commands::refresh_quota_shared,
            commands::refresh_quota_all,
            commands::get_usage_auth,
            commands::set_usage_auth,
            commands::clear_usage_auth,
            commands::set_usage_token,
            commands::clear_usage_token,
            commands::set_usage_base_url,
            commands::clear_usage_base_url,
            commands::set_usage_proxy_pool,
            commands::set_provider_quota_hard_cap,
            commands::set_provider_quota_hard_cap_field,
            commands::set_provider_manual_pricing,
            commands::get_provider_timeline,
            commands::set_provider_timeline,
            commands::get_provider_schedule,
            commands::set_provider_schedule,
            commands::set_provider_gap_fill,
            commands::get_effective_usage_base,
            commands::set_provider_order,
            commands::probe_provider,
            commands::codex_cli_toggle_auth_config_swap,
            commands::codex_cli_default_home,
            commands::codex_cli_default_wsl_home,
            commands::codex_cli_swap_status,
            commands::get_codex_cli_config_toml,
            commands::set_codex_cli_config_toml,
            commands::provider_switchboard_status,
            commands::provider_switchboard_set_target,
            commands::tailscale_status,
            commands::codex_account_login,
            commands::codex_account_logout,
            commands::codex_account_refresh,
            commands::get_usage_statistics,
            commands::get_usage_request_entries,
            commands::get_usage_request_summary,
            commands::get_usage_request_daily_totals,
            commands::get_spend_history,
            commands::set_spend_history_entry,
            commands::remove_tracked_spend_history_entries
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::{
        app_launch_requests_hidden, app_profile_name_from_inputs, profile_data_dir_name,
        resolve_codex_home, should_reset_profile_data, should_reveal_main_window_on_setup,
        should_seed_mock_data,
    };

    #[test]
    fn infer_profile_from_test_exe_name() {
        let got = app_profile_name_from_inputs(None, Some("API Router [TEST]"));
        assert_eq!(got, "test");
    }

    #[test]
    fn env_profile_takes_precedence_over_exe_name() {
        let got = app_profile_name_from_inputs(Some("staging"), Some("API Router [TEST]"));
        assert_eq!(got, "staging");
    }

    #[test]
    fn non_default_profile_uses_isolated_data_dir() {
        assert_eq!(profile_data_dir_name("default"), "user-data");
        assert_eq!(profile_data_dir_name("test"), "user-data-test");
    }

    #[test]
    fn test_profile_enables_reset_and_mock_seed_only_for_app_runtime() {
        assert!(should_reset_profile_data("test", false));
        assert!(should_seed_mock_data("test", false));
        assert!(!should_reset_profile_data("test", true));
        assert!(!should_seed_mock_data("test", true));
        assert!(!should_reset_profile_data("default", false));
        assert!(!should_seed_mock_data("default", false));
    }

    #[test]
    fn resolve_codex_home_defaults_to_isolated() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let user_data = tmp.path().join("user-data");
        std::fs::create_dir_all(&user_data).unwrap();
        std::env::remove_var("API_ROUTER_CODEX_HOME");
        let got = resolve_codex_home(&user_data, false, "default");
        assert_eq!(got, user_data.join("codex-home"));
    }

    #[test]
    fn start_hidden_launch_flag_is_detected() {
        assert!(app_launch_requests_hidden(&[
            "API Router.exe".to_string(),
            "--start-hidden".to_string(),
        ]));
        assert!(!app_launch_requests_hidden(&["API Router.exe".to_string()]));
    }

    #[test]
    fn setup_only_reveals_window_for_normal_launches() {
        assert!(should_reveal_main_window_on_setup(false, false));
        assert!(!should_reveal_main_window_on_setup(true, false));
        assert!(!should_reveal_main_window_on_setup(false, true));
    }
}
