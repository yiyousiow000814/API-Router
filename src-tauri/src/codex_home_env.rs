use std::sync::{Mutex, MutexGuard};

#[cfg(test)]
use std::path::Path;

// Process-global environment variables are shared across Rust tests (which run in parallel by
// default). Any test or command that sets CODEX_HOME must coordinate through this lock to avoid
// flaky cross-test interference.
static CODEX_HOME_ENV_LOCK: Mutex<()> = Mutex::new(());

pub(crate) fn lock_env() -> MutexGuard<'static, ()> {
    CODEX_HOME_ENV_LOCK.lock().unwrap()
}

#[cfg(test)]
pub(crate) struct CodexHomeEnvGuard {
    _lock: MutexGuard<'static, ()>,
    prev: Option<String>,
}

#[cfg(test)]
impl CodexHomeEnvGuard {
    #[allow(dead_code)]
    pub(crate) fn set(path: &Path) -> Self {
        let lock = lock_env();
        let prev = std::env::var("CODEX_HOME").ok();
        std::env::set_var("CODEX_HOME", path);
        Self { _lock: lock, prev }
    }

    #[allow(dead_code)]
    pub(crate) fn unset() -> Self {
        let lock = lock_env();
        let prev = std::env::var("CODEX_HOME").ok();
        std::env::remove_var("CODEX_HOME");
        Self { _lock: lock, prev }
    }
}

#[cfg(test)]
impl Drop for CodexHomeEnvGuard {
    fn drop(&mut self) {
        if let Some(prev) = self.prev.take() {
            std::env::set_var("CODEX_HOME", prev);
        } else {
            std::env::remove_var("CODEX_HOME");
        }
    }
}
