use std::collections::HashMap;
use std::sync::atomic::AtomicU64;
use std::sync::Arc;

use std::sync::Mutex as StdMutex;
use std::sync::MutexGuard as StdMutexGuard;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use parking_lot::RwLock;
use tower::ServiceExt;

use crate::constants::GATEWAY_MODEL_PROVIDER_ID;
use crate::orchestrator::config::{AppConfig, ListenConfig, ProviderConfig, RoutingConfig};
use crate::orchestrator::gateway::{
    build_router, build_router_with_body_limit, decide_provider, open_store_dir, GatewayState,
    LastUsedRoute,
};
use crate::orchestrator::router::RouterState;
use crate::orchestrator::secrets::SecretStore;
use crate::orchestrator::store::unix_ms;
use crate::orchestrator::upstream::UpstreamClient;
use axum::routing::post;
use axum::{Json, Router};
use parking_lot::Mutex;
use serde_json::json;

static CODEX_ENV_LOCK: StdMutex<()> = StdMutex::new(());

struct CodexSessionGuard<'a> {
    _lock: StdMutexGuard<'a, ()>,
    prev_env: Option<String>,
}

impl<'a> CodexSessionGuard<'a> {
    fn new(lock: StdMutexGuard<'a, ()>) -> Self {
        let prev_env = std::env::var("CODEX_HOME").ok();
        Self {
            _lock: lock,
            prev_env,
        }
    }
}

impl Drop for CodexSessionGuard<'_> {
    fn drop(&mut self) {
        if let Some(prev_env) = self.prev_env.take() {
            std::env::set_var("CODEX_HOME", prev_env);
        } else {
            std::env::remove_var("CODEX_HOME");
        }
    }
}

fn setup_codex_session(
    tmp: &tempfile::TempDir,
    session_id: &str,
    lines: &[serde_json::Value],
) -> CodexSessionGuard<'static> {
    let guard = CodexSessionGuard::new(CODEX_ENV_LOCK.lock().unwrap());
    std::env::set_var("CODEX_HOME", tmp.path());
    let sessions_dir = tmp
        .path()
        .join("sessions")
        .join("2026")
        .join("01")
        .join("31");
    std::fs::create_dir_all(&sessions_dir).unwrap();
    let session_file =
        sessions_dir.join(format!("rollout-2026-01-31T00-00-00-{session_id}.jsonl"));
    let mut body_txt = String::new();
    for line in lines {
        body_txt.push_str(&line.to_string());
        body_txt.push('\n');
    }
    std::fs::write(&session_file, body_txt).unwrap();
    guard
}

