mod app_state;
mod orchestrator;

use tauri::Manager;

use crate::app_state::build_state;
use crate::orchestrator::gateway::serve_in_background;
use crate::orchestrator::store::unix_ms;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }

      let config_dir = app.path().app_config_dir()?;
      let data_dir = app.path().app_data_dir()?;
      let state = build_state(config_dir.join("config.toml"), data_dir)?;
      app.manage(state);

      // Start in background (tray-style behavior).
      if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
      }

      // Spawn the local OpenAI-compatible gateway.
      let st = app.state::<app_state::AppState>();
      let gateway = st.gateway.clone();
      tauri::async_runtime::spawn(async move {
        if let Err(e) = serve_in_background(gateway).await {
          log::error!("gateway exited: {e:?}");
        }
      });

      // Tray menu so the app is usable even when the main window starts hidden.
      let show = tauri::menu::MenuItemBuilder::with_id("show", "Show").build(app)?;
      let quit = tauri::menu::MenuItemBuilder::with_id("quit", "Quit").build(app)?;
      let menu = tauri::menu::MenuBuilder::new(app).items(&[&show, &quit]).build()?;

      // Ensure the tray icon has an actual image on Windows; otherwise it can appear as "blank".
      let icon = app
        .default_window_icon()
        .cloned()
        .or_else(|| {
          // Decode a bundled PNG as a fallback (Tauri Image expects RGBA bytes).
          let bytes = include_bytes!("../icons/32x32.png");
          let img = image::load_from_memory(bytes).ok()?.to_rgba8();
          let (w, h) = img.dimensions();
          Some(tauri::image::Image::new_owned(img.into_raw(), w, h))
        });

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
        })
        ;

      if let Some(icon) = icon {
        tray_builder = tray_builder.icon(icon);
      }

      let _tray = tray_builder.build(app)?;

      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      get_status,
      set_manual_override,
      get_config,
      set_preferred_provider,
      upsert_provider,
      delete_provider,
      set_provider_key,
      clear_provider_key
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

  serde_json::json!({
    "listen": { "host": cfg.listen.host, "port": cfg.listen.port },
    "preferred_provider": cfg.routing.preferred_provider,
    "manual_override": manual_override,
    "providers": providers,
    "metrics": metrics,
    "recent_events": recent_events
  })
}

#[tauri::command]
fn set_manual_override(state: tauri::State<'_, app_state::AppState>, provider: Option<String>) -> Result<(), String> {
  if let Some(ref p) = provider {
    if !state.gateway.cfg.read().providers.contains_key(p) {
      return Err(format!("unknown provider: {p}"));
    }
  }
  state.gateway.router.set_manual_override(provider.clone());
  state.gateway.store.add_event(provider.as_deref().unwrap_or("-"), "info", "manual override changed");
  Ok(())
}

#[tauri::command]
fn get_config(state: tauri::State<'_, app_state::AppState>) -> serde_json::Value {
  let cfg = state.gateway.cfg.read().clone();
  // Never expose keys in UI/API.
  let providers: serde_json::Map<String, serde_json::Value> = cfg.providers.iter().map(|(name, p)| {
    let has_key = state.secrets.get_provider_key(name).is_some();
    (name.clone(), serde_json::json!({
      "display_name": p.display_name,
      "base_url": p.base_url,
      "supports_responses": p.supports_responses,
      "supports_chat_completions": p.supports_chat_completions,
      "has_key": has_key
    }))
  }).collect();

  serde_json::json!({
    "listen": cfg.listen,
    "routing": cfg.routing,
    "providers": providers
  })
}

#[tauri::command]
fn set_preferred_provider(state: tauri::State<'_, app_state::AppState>, provider: String) -> Result<(), String> {
  {
    let mut cfg = state.gateway.cfg.write();
    if !cfg.providers.contains_key(&provider) {
      return Err(format!("unknown provider: {provider}"));
    }
    cfg.routing.preferred_provider = provider.clone();
  }
  persist_config(&state).map_err(|e| e.to_string())?;
  state.gateway.store.add_event(&provider, "info", "preferred_provider updated");
  Ok(())
}

#[tauri::command]
fn upsert_provider(
  state: tauri::State<'_, app_state::AppState>,
  name: String,
  display_name: String,
  base_url: String,
  supports_responses: bool,
  supports_chat_completions: bool,
) -> Result<(), String> {
  if name.trim().is_empty() {
    return Err("name is required".to_string());
  }
  {
    let mut cfg = state.gateway.cfg.write();
    cfg.providers.insert(name.clone(), crate::orchestrator::config::ProviderConfig {
      display_name,
      base_url,
      api_key: String::new(),
      supports_responses,
      supports_chat_completions,
    });
  }
  persist_config(&state).map_err(|e| e.to_string())?;
  state.gateway.store.add_event(&name, "info", "provider upserted");
  Ok(())
}

#[tauri::command]
fn delete_provider(state: tauri::State<'_, app_state::AppState>, name: String) -> Result<(), String> {
  if name == state.gateway.cfg.read().routing.preferred_provider {
    return Err("cannot delete preferred provider".to_string());
  }
  {
    let mut cfg = state.gateway.cfg.write();
    cfg.providers.remove(&name);
  }
  let _ = state.secrets.clear_provider_key(&name);
  persist_config(&state).map_err(|e| e.to_string())?;
  state.gateway.store.add_event(&name, "info", "provider deleted");
  Ok(())
}

#[tauri::command]
fn set_provider_key(state: tauri::State<'_, app_state::AppState>, provider: String, key: String) -> Result<(), String> {
  if !state.gateway.cfg.read().providers.contains_key(&provider) {
    return Err(format!("unknown provider: {provider}"));
  }
  state.secrets.set_provider_key(&provider, &key)?;
  state.gateway.store.add_event(&provider, "info", "provider key updated (stored in keyring)");
  Ok(())
}

#[tauri::command]
fn clear_provider_key(state: tauri::State<'_, app_state::AppState>, provider: String) -> Result<(), String> {
  if !state.gateway.cfg.read().providers.contains_key(&provider) {
    return Err(format!("unknown provider: {provider}"));
  }
  state.secrets.clear_provider_key(&provider)?;
  state.gateway.store.add_event(&provider, "info", "provider key cleared (keyring)");
  Ok(())
}

fn persist_config(state: &tauri::State<'_, app_state::AppState>) -> anyhow::Result<()> {
  let cfg = state.gateway.cfg.read().clone();
  std::fs::write(&state.config_path, toml::to_string_pretty(&cfg)?)?;
  Ok(())
}
