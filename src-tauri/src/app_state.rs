use std::path::PathBuf;
use std::sync::Arc;

use parking_lot::RwLock;

use crate::orchestrator::config::AppConfig;
use crate::orchestrator::gateway::{open_store_dir, GatewayState};
use crate::orchestrator::router::RouterState;
use crate::orchestrator::secrets::SecretStore;
use crate::orchestrator::store::unix_ms;
use crate::orchestrator::upstream::UpstreamClient;

pub struct AppState {
    pub config_path: PathBuf,
    pub data_dir: PathBuf,
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
    let secrets = SecretStore::new("agent-orchestrator");

    // Migration: if a provider api_key is present in config.toml, move it into OS keyring and blank it.
    // This avoids committing or leaving plaintext keys on disk.
    let mut changed = false;
    for (name, p) in cfg.providers.iter_mut() {
        if !p.api_key.is_empty() && p.api_key != "REPLACE_ME" {
            if secrets.set_provider_key(name, &p.api_key).is_ok() {
                p.api_key.clear();
                changed = true;
            }
        }
    }
    if changed {
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
    };
    Ok(AppState {
        config_path,
        data_dir,
        gateway,
        secrets,
    })
}
