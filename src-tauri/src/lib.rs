mod app_state;
mod orchestrator;

use tauri::Manager;
use tauri::WebviewUrl;

use crate::app_state::build_state;
use crate::orchestrator::gateway::serve_in_background;
use crate::orchestrator::store::unix_ms;
use std::sync::atomic::Ordering;

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
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // Keep all local state next to the EXE so it's easy to find, backup, and move between machines.
            // Layout:
            // - user-data/config.toml
            // - user-data/secrets.json
            // - user-data/data/* (sled store, metrics, events)
            let user_data_dir = (|| -> Option<std::path::PathBuf> {
                let exe = std::env::current_exe().ok()?;
                let dir = exe.parent()?.to_path_buf();
                Some(dir.join("user-data"))
            })()
            .unwrap_or(app.path().app_data_dir()?);

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
            upsert_provider,
            delete_provider,
            set_provider_key,
            clear_provider_key,
            refresh_quota,
            refresh_quota_all,
            set_usage_token,
            clear_usage_token,
            set_usage_base_url,
            clear_usage_base_url,
            official_web_open,
            official_web_close,
            official_web_refresh,
            official_web_report
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[tauri::command]
fn get_status(state: tauri::State<'_, app_state::AppState>) -> serde_json::Value {
    let cfg = state.gateway.cfg.read().clone();
    let now = unix_ms();
    let providers = state.gateway.router.snapshot(now);
    let manual_override = state.gateway.router.manual_override.read().clone();
    let recent_events = state.gateway.store.list_events(50);
    let metrics = state.gateway.store.get_metrics();
    let quota = state.gateway.store.list_quota_snapshots();
    let ledgers = state.gateway.store.list_ledgers();
    let last_activity = state.gateway.last_activity_unix_ms.load(Ordering::Relaxed);
    let official_web = state
        .gateway
        .store
        .get_official_web_snapshot()
        .unwrap_or(serde_json::json!({"ok": false}));

    serde_json::json!({
      "listen": { "host": cfg.listen.host, "port": cfg.listen.port },
      "preferred_provider": cfg.routing.preferred_provider,
      "manual_override": manual_override,
      "providers": providers,
      "metrics": metrics,
      "recent_events": recent_events,
      "quota": quota,
      "ledgers": ledgers,
      "last_activity_unix_ms": last_activity,
      "official_web": official_web
    })
}

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
        "manual override changed",
    );
    Ok(())
}

#[tauri::command]
fn get_config(state: tauri::State<'_, app_state::AppState>) -> serde_json::Value {
    let cfg = state.gateway.cfg.read().clone();
    // Never expose keys in UI/API.
    let providers: serde_json::Map<String, serde_json::Value> = cfg
        .providers
        .iter()
        .map(|(name, p)| {
            let key = state.secrets.get_provider_key(name);
            let usage_token = state.secrets.get_usage_token(name);
            let has_key = key.is_some();
            let key_preview = key.as_deref().map(mask_key_preview);
            (
                name.clone(),
                serde_json::json!({
                  "display_name": p.display_name,
                  "base_url": p.base_url,
                  "usage_adapter": p.usage_adapter.clone(),
                  "usage_base_url": p.usage_base_url.clone(),
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
      "providers": providers
    })
}

#[tauri::command]
fn get_gateway_token_preview(state: tauri::State<'_, app_state::AppState>) -> String {
    let tok = state.secrets.get_gateway_token().unwrap_or_default();
    mask_key_preview(&tok)
}

#[tauri::command]
fn get_gateway_token(state: tauri::State<'_, app_state::AppState>) -> String {
    state.secrets.get_gateway_token().unwrap_or_default()
}

#[tauri::command]
fn rotate_gateway_token(state: tauri::State<'_, app_state::AppState>) -> Result<String, String> {
    state.secrets.rotate_gateway_token()
}

#[tauri::command]
fn set_preferred_provider(
    state: tauri::State<'_, app_state::AppState>,
    provider: String,
) -> Result<(), String> {
    {
        let mut cfg = state.gateway.cfg.write();
        if !cfg.providers.contains_key(&provider) {
            return Err(format!("unknown provider: {provider}"));
        }
        cfg.routing.preferred_provider = provider.clone();
    }
    persist_config(&state).map_err(|e| e.to_string())?;
    state
        .gateway
        .store
        .add_event(&provider, "info", "preferred_provider updated");
    Ok(())
}

#[tauri::command]
fn upsert_provider(
    state: tauri::State<'_, app_state::AppState>,
    name: String,
    display_name: String,
    base_url: String,
) -> Result<(), String> {
    if name.trim().is_empty() {
        return Err("name is required".to_string());
    }
    {
        let mut cfg = state.gateway.cfg.write();
        cfg.providers.insert(
            name.clone(),
            crate::orchestrator::config::ProviderConfig {
                display_name,
                base_url,
                usage_adapter: String::new(),
                usage_base_url: None,
                api_key: String::new(),
            },
        );
    }
    persist_config(&state).map_err(|e| e.to_string())?;
    state
        .gateway
        .store
        .add_event(&name, "info", "provider upserted");
    Ok(())
}

#[tauri::command]
fn delete_provider(
    state: tauri::State<'_, app_state::AppState>,
    name: String,
) -> Result<(), String> {
    let mut next_preferred: Option<String> = None;
    {
        let mut cfg = state.gateway.cfg.write();
        cfg.providers.remove(&name);

        if cfg.providers.is_empty() {
            return Err("cannot delete the last provider".to_string());
        }

        if cfg.routing.preferred_provider == name {
            next_preferred = cfg.providers.keys().next().cloned();
            if let Some(p) = next_preferred.clone() {
                cfg.routing.preferred_provider = p;
            }
        }
    }

    // If the deleted provider was manually locked, return to auto.
    {
        let mut mo = state.gateway.router.manual_override.write();
        if mo.as_deref() == Some(&name) {
            *mo = None;
        }
    }
    let _ = state.secrets.clear_provider_key(&name);
    persist_config(&state).map_err(|e| e.to_string())?;
    state
        .gateway
        .store
        .add_event(&name, "info", "provider deleted");
    if let Some(p) = next_preferred {
        state.gateway.store.add_event(
            &p,
            "info",
            "preferred_provider updated (deleted old preferred)",
        );
    }
    Ok(())
}

#[tauri::command]
fn set_provider_key(
    state: tauri::State<'_, app_state::AppState>,
    provider: String,
    key: String,
) -> Result<(), String> {
    if !state.gateway.cfg.read().providers.contains_key(&provider) {
        return Err(format!("unknown provider: {provider}"));
    }
    state.secrets.set_provider_key(&provider, &key)?;
    state.gateway.store.add_event(
        &provider,
        "info",
        "provider key updated (stored in user-data/secrets.json)",
    );
    Ok(())
}

#[tauri::command]
fn clear_provider_key(
    state: tauri::State<'_, app_state::AppState>,
    provider: String,
) -> Result<(), String> {
    if !state.gateway.cfg.read().providers.contains_key(&provider) {
        return Err(format!("unknown provider: {provider}"));
    }
    state.secrets.clear_provider_key(&provider)?;
    state.gateway.store.add_event(
        &provider,
        "info",
        "provider key cleared (user-data/secrets.json)",
    );
    Ok(())
}

#[tauri::command]
async fn refresh_quota(
    state: tauri::State<'_, app_state::AppState>,
    provider: String,
) -> Result<(), String> {
    if !state.gateway.cfg.read().providers.contains_key(&provider) {
        return Err(format!("unknown provider: {provider}"));
    }
    let _ = crate::orchestrator::quota::refresh_quota_for_provider(&state.gateway, &provider).await;
    Ok(())
}

#[tauri::command]
async fn refresh_quota_all(state: tauri::State<'_, app_state::AppState>) -> Result<(), String> {
    crate::orchestrator::quota::refresh_quota_all(&state.gateway).await;
    Ok(())
}

#[tauri::command]
fn set_usage_token(
    state: tauri::State<'_, app_state::AppState>,
    provider: String,
    token: String,
) -> Result<(), String> {
    if !state.gateway.cfg.read().providers.contains_key(&provider) {
        return Err(format!("unknown provider: {provider}"));
    }
    state.secrets.set_usage_token(&provider, &token)?;
    state.gateway.store.add_event(
        &provider,
        "info",
        "usage token updated (user-data/secrets.json)",
    );
    Ok(())
}

#[tauri::command]
fn clear_usage_token(
    state: tauri::State<'_, app_state::AppState>,
    provider: String,
) -> Result<(), String> {
    if !state.gateway.cfg.read().providers.contains_key(&provider) {
        return Err(format!("unknown provider: {provider}"));
    }
    state.secrets.clear_usage_token(&provider)?;
    state.gateway.store.add_event(
        &provider,
        "info",
        "usage token cleared (user-data/secrets.json)",
    );
    Ok(())
}

#[tauri::command]
fn set_usage_base_url(
    state: tauri::State<'_, app_state::AppState>,
    provider: String,
    url: String,
) -> Result<(), String> {
    if !state.gateway.cfg.read().providers.contains_key(&provider) {
        return Err(format!("unknown provider: {provider}"));
    }
    let u = url.trim().trim_end_matches('/').to_string();
    if u.is_empty() {
        return Err("url is required".to_string());
    }
    if reqwest::Url::parse(&u).is_err() {
        return Err("invalid url".to_string());
    }
    {
        let mut cfg = state.gateway.cfg.write();
        if let Some(p) = cfg.providers.get_mut(&provider) {
            p.usage_base_url = Some(u);
        }
    }
    persist_config(&state).map_err(|e| e.to_string())?;
    state
        .gateway
        .store
        .add_event(&provider, "info", "usage base url updated");
    Ok(())
}

#[tauri::command]
fn clear_usage_base_url(
    state: tauri::State<'_, app_state::AppState>,
    provider: String,
) -> Result<(), String> {
    if !state.gateway.cfg.read().providers.contains_key(&provider) {
        return Err(format!("unknown provider: {provider}"));
    }
    {
        let mut cfg = state.gateway.cfg.write();
        if let Some(p) = cfg.providers.get_mut(&provider) {
            p.usage_base_url = None;
        }
    }
    persist_config(&state).map_err(|e| e.to_string())?;
    state
        .gateway
        .store
        .add_event(&provider, "info", "usage base url cleared");
    Ok(())
}

const OFFICIAL_WEB_URL: &str = "https://chatgpt.com/codex/settings/usage";

#[tauri::command]
fn official_web_open(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("official_web") {
        let _ = w.show();
        let _ = w.set_focus();
        return Ok(());
    }

    let url = OFFICIAL_WEB_URL
        .parse()
        .map_err(|e| format!("invalid url: {e}"))?;
    tauri::WebviewWindowBuilder::new(&app, "official_web", WebviewUrl::External(url))
        .title("Official (Web)")
        .resizable(true)
        .decorations(true)
        .inner_size(980.0, 760.0)
        .build()
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
fn official_web_close(app: tauri::AppHandle) -> Result<(), String> {
    let Some(w) = app.get_webview_window("official_web") else {
        return Ok(());
    };
    w.close().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn official_web_refresh(app: tauri::AppHandle, state: tauri::State<'_, app_state::AppState>) -> Result<(), String> {
    let Some(w) = app.get_webview_window("official_web") else {
        return Err("official web window not open".to_string());
    };

    // Rotate nonce so random pages can't spoof a report without a fresh refresh.
    let nonce = {
        let mut g = state.official_web_nonce.lock();
        *g = format!("ow_{}", uuid::Uuid::new_v4().simple());
        g.clone()
    };

    // Use webview JS execution to extract minimal signals from the logged-in web session.
    // This avoids needing to read cookies from the host platform.
    let js = format!(
        r#"(async () => {{
  try {{
    const href = String(location.href || "");
    const bodyText = String(document?.body?.innerText || "");
    const payload = {{
      nonce: {nonce_json},
      href,
      bodyText,
    }};
    if (window.__TAURI__?.core?.invoke) {{
      await window.__TAURI__.core.invoke("official_web_report", payload);
    }}
  }} catch (e) {{
    try {{
      if (window.__TAURI__?.core?.invoke) {{
        await window.__TAURI__.core.invoke("official_web_report", {{
          nonce: {nonce_json},
          href: String(location.href || ""),
          bodyText: "",
          error: String(e)
        }});
      }}
    }} catch (_) {{}}
  }}
}})();"#,
        nonce_json = serde_json::to_string(&nonce).unwrap_or_else(|_| "\"\"".to_string())
    );
    w.eval(&js).map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(serde::Deserialize)]
struct OfficialWebReport {
    nonce: String,
    #[serde(default)]
    href: String,
    #[serde(default, alias = "bodyText")]
    body_text: String,
    #[serde(default)]
    error: String,
}

#[tauri::command]
fn official_web_report(state: tauri::State<'_, app_state::AppState>, report: OfficialWebReport) -> Result<(), String> {
    let expected = state.official_web_nonce.lock().clone();
    if report.nonce != expected {
        return Err("stale nonce".to_string());
    }

    let href = report.href;
    let body = report.body_text;

    // Very lightweight parser (best-effort). We don't rely on a stable API;
    // this is just for displaying "signed in" and a remaining value if present.
    let mut signed_in = true;
    let low = body.to_ascii_lowercase();
    if low.contains("log in") || low.contains("sign in") {
        signed_in = false;
    }

    let mut remaining: Option<f64> = None;
    if !body.is_empty() {
        let re = regex::Regex::new(r"(?i)credits remaining[^0-9]*([0-9]+(?:\\.[0-9]+)?)").ok();
        if let Some(re) = re {
            if let Some(caps) = re.captures(&body) {
                if let Some(m) = caps.get(1) {
                    remaining = m.as_str().parse::<f64>().ok();
                }
            }
        }
    }

    let snap = serde_json::json!({
      "ok": true,
      "checked_at_unix_ms": unix_ms(),
      "signed_in": signed_in,
      "href": href,
      "remaining": remaining,
      "error": report.error
    });

    state.gateway.store.put_official_web_snapshot(&snap);
    Ok(())
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
