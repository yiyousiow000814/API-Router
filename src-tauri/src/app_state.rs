use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use parking_lot::RwLock;

use crate::orchestrator::config::AppConfig;
use crate::orchestrator::gateway::{open_store_dir, GatewayState};
use crate::orchestrator::router::RouterState;
use crate::orchestrator::secrets::SecretStore;
use crate::orchestrator::store::unix_ms;
use crate::orchestrator::upstream::UpstreamClient;
use std::sync::atomic::AtomicU64;

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

pub struct AppState {
    pub config_path: PathBuf,
    pub gateway: GatewayState,
    pub secrets: SecretStore,
}

pub fn load_or_init_config(path: &PathBuf) -> anyhow::Result<AppConfig> {
    if path.exists() {
        let txt = std::fs::read_to_string(path)?;
        let cfg: AppConfig = toml::from_str(&txt)?;
        return Ok(cfg);
    }
    let cfg = AppConfig::default_config();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, toml::to_string_pretty(&cfg)?)?;
    Ok(cfg)
}

pub fn build_state(config_path: PathBuf, data_dir: PathBuf) -> anyhow::Result<AppState> {
    let mut cfg = load_or_init_config(&config_path)?;
    let secrets_path = config_path
        .parent()
        .unwrap_or(std::path::Path::new("."))
        .join("secrets.json");
    let secrets = SecretStore::new(secrets_path);
    // Ensure a local gateway auth token exists so Codex can authenticate to the localhost base_url.
    // This token is not an upstream provider key; it only protects the local gateway.
    let _ = secrets.ensure_gateway_token();

    // Normalize: older config.toml may contain `api_key = ""` fields. We keep `api_key` only for
    // one-time migration; new config writes omit empty api_key to avoid confusion.
    let normalize_api_key_field = config_path
        .exists()
        .then(|| std::fs::read_to_string(&config_path).ok())
        .flatten()
        .map(|s| s.contains("api_key"))
        .unwrap_or(false);

    // Migration: older defaults used provider_a/provider_b. Rename to provider_1/provider_2 so the
    // UI and docs match.
    let mut changed = false;
    changed |= migrate_provider_name(&mut cfg, "provider_a", "provider_1");
    changed |= migrate_provider_name(&mut cfg, "provider_b", "provider_2");
    if changed {
        // keep preferred_provider consistent if it pointed at an old name
        if cfg.routing.preferred_provider == "provider_a"
            && cfg.providers.contains_key("provider_1")
        {
            cfg.routing.preferred_provider = "provider_1".to_string();
        }
        if cfg.routing.preferred_provider == "provider_b"
            && cfg.providers.contains_key("provider_2")
        {
            cfg.routing.preferred_provider = "provider_2".to_string();
        }
    }

    // Migration: we only ship two placeholder providers by default. If provider_3/provider_4
    // exist but are still unconfigured (no base_url + no key), remove them to reduce clutter.
    for name in ["provider_3", "provider_4"] {
        if should_prune_placeholder_provider(&cfg, &secrets, name) {
            cfg.providers.remove(name);
            changed = true;
        }
    }

    changed |= normalize_provider_order(&mut cfg);

    // Migration note: quota endpoints are intentionally not auto-detected to keep the app generic.

    // Migration: if a provider api_key is present in config.toml, move it into user-data/secrets.json
    // and blank it. This avoids committing or leaving plaintext keys in config.toml.
    let mut migrated_keys = false;
    for (name, p) in cfg.providers.iter_mut() {
        if !p.api_key.is_empty()
            && p.api_key != "REPLACE_ME"
            && secrets.set_provider_key(name, &p.api_key).is_ok()
        {
            p.api_key.clear();
            migrated_keys = true;
        }
    }
    if changed || migrated_keys || normalize_api_key_field {
        std::fs::write(&config_path, toml::to_string_pretty(&cfg)?)?;
    }

    let store = open_store_dir(data_dir.clone())?;
    let router = Arc::new(RouterState::new(&cfg, unix_ms()));
    let gateway = GatewayState {
        cfg: Arc::new(RwLock::new(cfg)),
        router,
        store,
        upstream: UpstreamClient::new(),
        secrets: secrets.clone(),
        last_activity_unix_ms: Arc::new(AtomicU64::new(0)),
        last_used_by_session: Arc::new(RwLock::new(HashMap::new())),
        usage_base_speed_cache: Arc::new(RwLock::new(HashMap::new())),
        prev_id_support_cache: Arc::new(RwLock::new(HashMap::new())),
        client_sessions: Arc::new(RwLock::new(HashMap::new())),
    };
    {
        let mut key_refs: std::collections::BTreeMap<String, String> =
            std::collections::BTreeMap::new();
        for provider_name in gateway.cfg.read().providers.keys() {
            let key_ref = secrets
                .get_provider_key(provider_name)
                .as_deref()
                .map(mask_key_preview)
                .unwrap_or_else(|| "-".to_string());
            key_refs.insert(provider_name.clone(), key_ref);
        }
        let _ = gateway.store.backfill_api_key_ref_fields(&key_refs);
    }
    let app_state = AppState {
        config_path,
        gateway,
        secrets,
    };

    match crate::provider_switchboard::sync_gateway_target_for_current_token_on_startup(&app_state)
    {
        Ok(failed_targets) => {
            if !failed_targets.is_empty() {
                app_state.gateway.store.add_event(
                    "gateway",
                    "error",
                    "codex.provider_switchboard.gateway_token_sync_failed",
                    "Gateway token sync at startup failed for some targets.",
                    serde_json::json!({ "failed_targets": failed_targets }),
                );
            }
        }
        Err(e) => {
            app_state.gateway.store.add_event(
                "gateway",
                "error",
                "codex.provider_switchboard.gateway_token_sync_failed",
                &format!("Gateway token sync at startup failed: {e}"),
                serde_json::Value::Null,
            );
        }
    }

    Ok(app_state)
}

pub(crate) fn normalize_provider_order(cfg: &mut AppConfig) -> bool {
    let mut next = Vec::new();
    let mut seen = std::collections::HashSet::new();

    for name in cfg.provider_order.iter() {
        if cfg.providers.contains_key(name) && seen.insert(name.clone()) {
            next.push(name.clone());
        }
    }

    for name in cfg.providers.keys() {
        if seen.insert(name.clone()) {
            next.push(name.clone());
        }
    }

    if next != cfg.provider_order {
        cfg.provider_order = next;
        return true;
    }
    false
}

pub(crate) fn migrate_provider_name(cfg: &mut AppConfig, old: &str, new: &str) -> bool {
    if cfg.providers.contains_key(new) {
        return false;
    }
    let Some(p) = cfg.providers.get(old).cloned() else {
        return false;
    };

    cfg.providers.remove(old);
    cfg.providers.insert(new.to_string(), p);
    true
}

fn should_prune_placeholder_provider(cfg: &AppConfig, secrets: &SecretStore, name: &str) -> bool {
    let Some(p) = cfg.providers.get(name) else {
        return false;
    };
    if !p.base_url.trim().is_empty() {
        return false;
    }
    if secrets.get_provider_key(name).is_some() {
        return false;
    }
    // Only remove if it still looks like a default placeholder entry.
    p.display_name.trim().eq_ignore_ascii_case(&format!(
        "Provider {}",
        name.trim_start_matches("provider_")
    ))
}

#[cfg(test)]
mod tests {
    use super::build_state;
    use serde_json::json;

    #[test]
    fn build_state_syncs_gateway_token_to_gateway_targets() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let config_path = tmp.path().join("user-data").join("config.toml");
        let data_dir = tmp.path().join("data");
        std::fs::create_dir_all(config_path.parent().expect("config parent")).expect("mkdir");

        let secrets_path = config_path
            .parent()
            .expect("config parent")
            .join("secrets.json");
        let secrets = crate::orchestrator::secrets::SecretStore::new(secrets_path);
        secrets
            .set_gateway_token("ao_new_gateway_token")
            .expect("set gateway token");

        let cli_home = tmp.path().join("cli-home");
        std::fs::create_dir_all(&cli_home).expect("mkdir cli home");
        std::fs::write(
            cli_home.join("auth.json"),
            r#"{"OPENAI_API_KEY":"ao_old_gateway_token"}"#,
        )
        .expect("write stale auth");
        std::fs::write(
            cli_home.join("config.toml"),
            "model_provider = \"api_router\"\nmodel = \"gpt-5.3-codex\"\n",
        )
        .expect("write gateway config");

        let switchboard_state = config_path
            .parent()
            .expect("config parent")
            .join("codex-home")
            .join("provider-switchboard-state.json");
        std::fs::create_dir_all(switchboard_state.parent().expect("state parent"))
            .expect("mkdir state parent");
        std::fs::write(
            &switchboard_state,
            serde_json::to_string_pretty(&json!({
              "target": "gateway",
              "provider": serde_json::Value::Null,
              "cli_homes": [cli_home.to_string_lossy().to_string()]
            }))
            .expect("state json"),
        )
        .expect("write switchboard state");

        let _state = build_state(config_path, data_dir).expect("build state");

        let auth: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(cli_home.join("auth.json")).expect("read synced auth"),
        )
        .expect("parse synced auth");
        assert_eq!(
            auth.get("OPENAI_API_KEY").and_then(|v| v.as_str()),
            Some("ao_new_gateway_token")
        );
    }
}
