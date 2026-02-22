mod app_state;
mod codex_app_server;
mod codex_cli_swap;
mod commands;
mod constants;
mod orchestrator;
mod platform;
mod provider_switchboard;

use tauri::Manager;

use crate::app_state::build_state;
use crate::orchestrator::gateway::serve_in_background;
use crate::orchestrator::store::unix_ms;
use chrono::{Duration as ChronoDuration, Local};
use serde_json::json;
use std::path::PathBuf;

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
                    Some("test"),
                    None,
                    origin,
                    Some(session_id.as_str()),
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
        state.gateway.store.add_event(
            provider,
            "info",
            "test_profile.bulk_event",
            &format!("test profile bulk event #{i}"),
            json!({
                "seed": true,
                "seq": i,
                "codex_session_id": format!("test-session-{}", i % 9),
            }),
        );
    }

    state.gateway.store.add_event(
        "gateway",
        "info",
        "test_profile.mock_seeded",
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
    let mut builder = tauri::Builder::default();
    if !is_ui_tauri && app_profile != "test" {
        // Ensure clicking the EXE again focuses the existing instance instead of launching a second one.
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
            }
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
            } else if app_profile != "default" {
                let base = app.path().app_data_dir()?;
                let p = base.join(profile_data_dir_name(&app_profile));
                let _ = std::fs::create_dir_all(&p);
                p
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

            if should_reset_profile_data(&app_profile, is_ui_tauri) {
                if user_data_dir.exists() {
                    let _ = std::fs::remove_dir_all(&user_data_dir);
                }
                let _ = std::fs::create_dir_all(&user_data_dir);
            }

            // Isolate Codex auth/session from the default ~/.codex directory to avoid overwrites.
            // This keeps the app's login independent from CLI logins.
            let codex_home = user_data_dir.join("codex-home");
            let _ = std::fs::create_dir_all(&codex_home);
            std::env::set_var("CODEX_HOME", &codex_home);

            let state = build_state(
                user_data_dir.join("config.toml"),
                user_data_dir.join("data"),
            )?;
            if should_seed_mock_data(&app_profile, is_ui_tauri) {
                if let Err(e) = seed_test_profile_data(&state) {
                    eprintln!("failed to seed test profile mock data: {e}");
                }
            }
            app.manage(state);
            if !is_ui_tauri {
                let app_handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let st = app_handle.state::<app_state::AppState>();
                    app_state::run_startup_gateway_token_sync(&st);
                });
            }

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
            commands::get_event_log_entries,
            commands::get_event_log_years,
            commands::get_event_log_daily_stats,
            commands::set_manual_override,
            commands::get_config,
            commands::get_gateway_token_preview,
            commands::get_gateway_token,
            commands::rotate_gateway_token,
            commands::set_preferred_provider,
            commands::set_route_mode,
            commands::set_session_preferred_provider,
            commands::clear_session_preferred_provider,
            commands::upsert_provider,
            commands::set_provider_disabled,
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
            commands::codex_cli_default_wsl_home,
            commands::codex_cli_swap_status,
            commands::get_codex_cli_config_toml,
            commands::set_codex_cli_config_toml,
            commands::provider_switchboard_status,
            commands::provider_switchboard_set_target,
            commands::wsl_gateway_access_status,
            commands::wsl_gateway_access_quick_status,
            commands::wsl_gateway_authorize_access,
            commands::wsl_gateway_revoke_access,
            commands::codex_account_login,
            commands::codex_account_logout,
            commands::codex_account_refresh,
            commands::get_usage_statistics,
            commands::get_usage_request_entries,
            commands::get_usage_request_summary,
            commands::get_usage_request_daily_totals,
            commands::get_spend_history,
            commands::set_spend_history_entry
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::{
        app_profile_name_from_inputs, profile_data_dir_name, should_reset_profile_data,
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
}
