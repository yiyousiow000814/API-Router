use keyring::Entry;
use keyring::Error as KeyringError;

#[derive(Clone)]
pub struct SecretStore {
    service: String,
}

impl SecretStore {
    pub fn new(service: &str) -> Self {
        Self {
            service: service.to_string(),
        }
    }

    pub fn get_provider_key(&self, provider: &str) -> Option<String> {
        let entry = Entry::new(&self.service, provider).ok()?;
        entry.get_password().ok()
    }

    pub fn set_provider_key(&self, provider: &str, key: &str) -> Result<(), String> {
        let entry = Entry::new(&self.service, provider).map_err(|e| e.to_string())?;
        entry
            .set_password(key)
            .map_err(|e| format!("keyring set failed: {e}"))?;
        Ok(())
    }

    pub fn clear_provider_key(&self, provider: &str) -> Result<(), String> {
        let entry = Entry::new(&self.service, provider).map_err(|e| e.to_string())?;
        match entry.delete_credential() {
            Ok(()) => Ok(()),
            Err(KeyringError::NoEntry) => Ok(()),
            Err(e) => Err(format!("keyring delete failed: {e}")),
        }
    }
}
