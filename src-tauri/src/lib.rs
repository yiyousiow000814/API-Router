mod app_state;
mod codex_app_server;
mod codex_cli_swap;
mod commands;
mod orchestrator;
mod platform;
mod provider_switchboard;

use tauri::Manager;

use crate::app_state::build_state;
use crate::orchestrator::gateway::serve_in_background;
use std::path::PathBuf;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let is_ui_tauri = std::env::var("UI_TAURI").ok().as_deref() == Some("1");
    let mut builder = tauri::Builder::default();
    if !is_ui_tauri {
        // Ensure clicking the EXE again focuses the existing instance instead of launching a second one.
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
            }
        }));
    }
    builder
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
            let is_ui_tauri = std::env::var("UI_TAURI").ok().as_deref() == Some("1");
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
                (|| -> Option<std::path::PathBuf> {
                    let exe = std::env::current_exe().ok()?;
                    let dir = exe.parent()?.to_path_buf();
                    let local = dir.join("user-data");
                    if local.exists() {
                        return Some(local);
                    }
                    None
                })()
                .unwrap_or(app.path().app_data_dir()?)
            };

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

            if !is_ui_tauri {
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
            }

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
            commands::get_status,
            commands::set_manual_override,
            commands::get_config,
            commands::get_gateway_token_preview,
            commands::get_gateway_token,
            commands::rotate_gateway_token,
            commands::set_preferred_provider,
            commands::set_session_preferred_provider,
            commands::clear_session_preferred_provider,
            commands::upsert_provider,
            commands::delete_provider,
            commands::rename_provider,
            commands::get_provider_key,
            commands::set_provider_key,
            commands::clear_provider_key,
            commands::refresh_quota,
            commands::refresh_quota_shared,
            commands::refresh_quota_all,
            commands::set_usage_token,
            commands::clear_usage_token,
            commands::set_usage_base_url,
            commands::clear_usage_base_url,
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
            commands::codex_cli_swap_status,
            commands::provider_switchboard_status,
            commands::provider_switchboard_set_target,
            commands::codex_account_login,
            commands::codex_account_logout,
            commands::codex_account_refresh,
            commands::get_usage_statistics,
            commands::get_spend_history,
            commands::set_spend_history_entry
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
