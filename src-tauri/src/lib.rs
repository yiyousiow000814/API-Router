mod app_state;
mod codex_app_server;
mod codex_cli_swap;
mod orchestrator;
mod platform;
mod provider_switchboard;

use tauri::Manager;

use crate::app_state::build_state;
use crate::orchestrator::gateway::serve_in_background;
use crate::orchestrator::store::unix_ms;
use chrono::{Local, LocalResult, NaiveDate, TimeZone, Timelike};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::time::Duration;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Ensure clicking the EXE again focuses the existing instance instead of launching a second one.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .setup(|app| {
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

            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // Prefer a stable per-user app data directory so rebuilds don't force re-login.
            // If a local ./user-data already exists next to the EXE, keep using it for portability.
            // Layout:
            // - user-data/config.toml
            // - user-data/secrets.json
            // - user-data/data/* (sled store, metrics, events)
            let user_data_dir = (|| -> Option<std::path::PathBuf> {
                let exe = std::env::current_exe().ok()?;
                let dir = exe.parent()?.to_path_buf();
                let local = dir.join("user-data");
                if local.exists() {
                    return Some(local);
                }
                None
            })()
            .unwrap_or(app.path().app_data_dir()?);

            // Isolate Codex auth/session from the default ~/.codex directory to avoid overwrites.
            // This keeps the app's login independent from CLI logins.
            let codex_home = user_data_dir.join("codex-home");
            let _ = std::fs::create_dir_all(&codex_home);
            std::env::set_var("CODEX_HOME", &codex_home);

            let state = build_state(
                user_data_dir.join("config.toml"),
                user_data_dir.join("data"),
            )?;
            app.manage(state);

            // Spawn the local OpenAI-compatible gateway.
            let st = app.state::<app_state::AppState>();
            let gateway = st.gateway.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = serve_in_background(gateway).await {
                    log::error!("gateway exited: {e:?}");
                }
            });

            // Quota refresh scheduler: only runs when the gateway is actively being used.
            let st = app.state::<app_state::AppState>();
            let gateway = st.gateway.clone();
            tauri::async_runtime::spawn(async move {
                crate::orchestrator::quota::run_quota_scheduler(gateway).await;
            });

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

            let mut tray_builder =
                tauri::tray::TrayIconBuilder::new()
                    .menu(&menu)
                    .on_menu_event(|app: &tauri::AppHandle, event: tauri::menu::MenuEvent| {
                        match event.id().as_ref() {
                            "show" => {
                                if let Some(w) = app.get_webview_window("main") {
                                    let _ = w.show();
                                    let _ = w.set_focus();
                                }
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

            // Closing the window should minimize to tray instead of exiting (background mode).
            if let Some(w) = app.get_webview_window("main") {
                let w2 = w.clone();
                w.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = w2.hide();
                    }
                });
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_status,
            set_manual_override,
            get_config,
            get_gateway_token_preview,
            get_gateway_token,
            rotate_gateway_token,
            set_preferred_provider,
            set_session_preferred_provider,
            clear_session_preferred_provider,
            upsert_provider,
            delete_provider,
            rename_provider,
            get_provider_key,
            set_provider_key,
            clear_provider_key,
            refresh_quota,
            refresh_quota_shared,
            refresh_quota_all,
            set_usage_token,
            clear_usage_token,
            set_usage_base_url,
            clear_usage_base_url,
            set_provider_manual_pricing,
            get_provider_timeline,
            set_provider_timeline,
            get_provider_schedule,
            set_provider_schedule,
            set_provider_gap_fill,
            get_effective_usage_base,
            set_provider_order,
            probe_provider,
            codex_cli_toggle_auth_config_swap,
            codex_cli_default_home,
            codex_cli_swap_status,
            provider_switchboard_status,
            provider_switchboard_set_target,
            codex_account_login,
            codex_account_logout,
            codex_account_refresh,
            get_usage_statistics,
            get_spend_history,
            set_spend_history_entry
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

include!("lib_parts/status.rs");

include!("lib_parts/usage_math.rs");

include!("lib_parts/usage_statistics.rs");

include!("lib_parts/usage_pricing.rs");

#[tauri::command]
fn set_manual_override(
    state: tauri::State<'_, app_state::AppState>,
    provider: Option<String>,
) -> Result<(), String> {
    if let Some(ref p) = provider {
        if !state.gateway.cfg.read().providers.contains_key(p) {
            return Err(format!("unknown provider: {p}"));
        }
    }
    state.gateway.router.set_manual_override(provider.clone());
    state.gateway.store.add_event(
        provider.as_deref().unwrap_or("-"),
        "info",
        "routing.manual_override_changed",
        "manual override changed",
        serde_json::Value::Null,
    );
    Ok(())
}

#[tauri::command]
fn get_config(state: tauri::State<'_, app_state::AppState>) -> serde_json::Value {
    let cfg = state.gateway.cfg.read().clone();
    let pricing = state.secrets.list_provider_pricing();
    let now = unix_ms();
    // Never expose keys in UI/API.
    let providers: serde_json::Map<String, serde_json::Value> = cfg
        .providers
        .iter()
        .map(|(name, p)| {
            let key = state.secrets.get_provider_key(name);
            let usage_token = state.secrets.get_usage_token(name);
            let manual_pricing = pricing.get(name).cloned();
            let active_package = active_package_period(manual_pricing.as_ref(), now);
            let active_package_amount = active_package.map(|(amount, _)| amount);
            let active_package_expires = active_package.and_then(|(_, expires)| expires);
            let manual_mode = manual_pricing.as_ref().map(|v| v.mode.clone());
            let manual_amount = manual_pricing.as_ref().and_then(|v| {
                if v.mode == "none" {
                    None
                } else if v.mode == "package_total" {
                    active_package_amount.or(Some(v.amount_usd))
                } else {
                    Some(v.amount_usd)
                }
            });
            let has_key = key.is_some();
            let key_preview = key.as_deref().map(mask_key_preview);
            (
                name.clone(),
                serde_json::json!({
                  "display_name": p.display_name,
                  "base_url": p.base_url,
                  "usage_adapter": p.usage_adapter.clone(),
                  "usage_base_url": p.usage_base_url.clone(),
                  "manual_pricing_mode": manual_mode.filter(|m| m != "none"),
                  "manual_pricing_amount_usd": manual_amount,
                  "manual_pricing_expires_at_unix_ms": active_package_expires,
                  "manual_gap_fill_mode": manual_pricing.as_ref().and_then(|v| v.gap_fill_mode.clone()),
                  "manual_gap_fill_amount_usd": manual_pricing.as_ref().and_then(|v| v.gap_fill_amount_usd),
                  "has_key": has_key
                  ,"key_preview": key_preview,
                  "has_usage_token": usage_token.is_some()
                }),
            )
        })
        .collect();

    serde_json::json!({
      "listen": cfg.listen,
      "routing": cfg.routing,
      "providers": providers,
      "provider_order": cfg.provider_order
    })
}

include!("lib_parts/provider_config.rs");

include!("lib_parts/codex_and_helpers.rs");
