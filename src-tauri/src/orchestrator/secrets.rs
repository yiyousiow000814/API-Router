use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
struct SecretsFile {
    #[serde(default)]
    providers: BTreeMap<String, String>,
    /// Optional non-upstream secrets used by the app (e.g. usage JWTs).
    #[serde(default)]
    usage_tokens: BTreeMap<String, String>,
}

#[derive(Clone)]
pub struct SecretStore {
    path: PathBuf,
    inner: Arc<Mutex<SecretsFile>>,
}

const GATEWAY_TOKEN_KEY: &str = "__gateway_token__";

impl SecretStore {
    pub fn new(path: PathBuf) -> Self {
        let inner = Self::load_from_disk(&path).unwrap_or_default();
        Self {
            path,
            inner: Arc::new(Mutex::new(inner)),
        }
    }

    fn load_from_disk(path: &PathBuf) -> Option<SecretsFile> {
        let txt = std::fs::read_to_string(path).ok()?;
        serde_json::from_str(&txt).ok()
    }

    fn persist(&self, data: &SecretsFile) -> Result<(), String> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let txt = serde_json::to_string_pretty(data).map_err(|e| e.to_string())?;
        std::fs::write(&self.path, txt).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn get_provider_key(&self, provider: &str) -> Option<String> {
        self.inner.lock().providers.get(provider).cloned()
    }

    pub fn set_provider_key(&self, provider: &str, key: &str) -> Result<(), String> {
        let mut data = self.inner.lock();
        data.providers.insert(provider.to_string(), key.to_string());
        self.persist(&data)
    }

    pub fn clear_provider_key(&self, provider: &str) -> Result<(), String> {
        let mut data = self.inner.lock();
        data.providers.remove(provider);
        self.persist(&data)
    }

    pub fn get_usage_token(&self, provider: &str) -> Option<String> {
        self.inner.lock().usage_tokens.get(provider).cloned()
    }

    pub fn set_usage_token(&self, provider: &str, token: &str) -> Result<(), String> {
        let mut data = self.inner.lock();
        data.usage_tokens
            .insert(provider.to_string(), token.to_string());
        self.persist(&data)
    }

    pub fn clear_usage_token(&self, provider: &str) -> Result<(), String> {
        let mut data = self.inner.lock();
        data.usage_tokens.remove(provider);
        self.persist(&data)
    }

    pub fn rename_provider(&self, old: &str, new: &str) -> Result<(), String> {
        if old == new {
            return Ok(());
        }
        let mut data = self.inner.lock();
        if let Some(v) = data.providers.remove(old) {
            data.providers.insert(new.to_string(), v);
        }
        if let Some(v) = data.usage_tokens.remove(old) {
            data.usage_tokens.insert(new.to_string(), v);
        }
        self.persist(&data)
    }

    pub fn get_gateway_token(&self) -> Option<String> {
        self.inner.lock().providers.get(GATEWAY_TOKEN_KEY).cloned()
    }

    pub fn ensure_gateway_token(&self) -> Result<String, String> {
        if let Some(t) = self.get_gateway_token() {
            return Ok(t);
        }
        let t = Self::new_gateway_token();
        self.set_gateway_token(&t)?;
        Ok(t)
    }

    pub fn set_gateway_token(&self, token: &str) -> Result<(), String> {
        let mut data = self.inner.lock();
        data.providers
            .insert(GATEWAY_TOKEN_KEY.to_string(), token.to_string());
        self.persist(&data)
    }

    pub fn rotate_gateway_token(&self) -> Result<String, String> {
        let t = Self::new_gateway_token();
        self.set_gateway_token(&t)?;
        Ok(t)
    }

    fn new_gateway_token() -> String {
        format!("ao_{}", Uuid::new_v4().simple())
    }
}
