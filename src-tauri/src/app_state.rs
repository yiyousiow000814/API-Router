use std::collections::{HashMap, VecDeque};
use std::io;
use std::path::PathBuf;
use std::sync::Arc;

use parking_lot::{Mutex, RwLock};

use crate::orchestrator::config::AppConfig;
use crate::orchestrator::gateway::{open_store_dir, GatewayState};
use crate::orchestrator::router::RouterState;
use crate::orchestrator::secrets::SecretStore;
use crate::orchestrator::store::unix_ms;
use crate::orchestrator::upstream::UpstreamClient;
use std::sync::atomic::AtomicU64;

const UI_WATCHDOG_UNRESPONSIVE_AFTER_MS: u64 = 6_000;
const UI_WATCHDOG_SLOW_REFRESH_AFTER_MS: u64 = 2_000;
const UI_WATCHDOG_LONG_TASK_AFTER_MS: u64 = 1_000;
const UI_WATCHDOG_FRAME_STALL_LOG_COOLDOWN_MS: u64 = 10_000;
const UI_WATCHDOG_SLOW_REFRESH_LOG_COOLDOWN_MS: u64 = 60_000;
const UI_WATCHDOG_LONG_TASK_LOG_COOLDOWN_MS: u64 = 60_000;
const UI_WATCHDOG_INVOKE_LOG_COOLDOWN_MS: u64 = 60_000;
const UI_WATCHDOG_DUMP_WINDOW_MS: u64 = 60_000;
const UI_WATCHDOG_TRACE_CAPACITY: usize = 512;

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
    pub diagnostics_dir: PathBuf,
    pub gateway: GatewayState,
    pub secrets: SecretStore,
    pub lan_sync: crate::lan_sync::LanSyncRuntime,
    pub local_network: crate::platform::local_network::LocalNetworkState,
    pub ui_watchdog: UiWatchdogState,
}

#[derive(Clone)]
pub struct UiWatchdogState {
    heartbeat: Arc<RwLock<UiWatchdogHeartbeatState>>,
    traces: Arc<Mutex<VecDeque<serde_json::Value>>>,
    diagnostics_meta: Arc<Mutex<UiWatchdogDiagnosticsMeta>>,
    dump_writer: Arc<UiWatchdogDumpWriter>,
}

pub struct UiWatchdogRuntime<'a> {
    pub store: &'a crate::orchestrator::store::Store,
    pub diagnostics_dir: &'a std::path::Path,
}

pub struct UiWatchdogPageState<'a> {
    pub active_page: &'a str,
    pub visible: bool,
}

pub struct UiWatchdogInvokeResult<'a> {
    pub command: &'a str,
    pub elapsed_ms: u64,
    pub ok: bool,
    pub error_message: Option<&'a str>,
}

type UiWatchdogDumpWriter =
    dyn Fn(&std::path::Path, &serde_json::Value) -> io::Result<()> + Send + Sync + 'static;

#[derive(Clone, Default)]
struct UiWatchdogHeartbeatState {
    last_heartbeat_unix_ms: u64,
    active_page: String,
    visible: bool,
    status_in_flight: bool,
    config_in_flight: bool,
    provider_switch_in_flight: bool,
}

#[derive(Clone, Default)]
struct UiWatchdogDiagnosticsMeta {
    unresponsive_logged: bool,
    unresponsive_since_unix_ms: u64,
    last_status_slow_log_unix_ms: u64,
    last_config_slow_log_unix_ms: u64,
    last_provider_switch_slow_log_unix_ms: u64,
    last_long_task_log_unix_ms: u64,
    last_frame_stall_log_unix_ms: u64,
    last_frontend_error_log_unix_ms: u64,
    last_invoke_slow_log_unix_ms: u64,
    last_invoke_error_log_unix_ms: u64,
}

impl UiWatchdogState {
    #[cfg(test)]
    fn with_dump_writer(dump_writer: Arc<UiWatchdogDumpWriter>) -> Self {
        Self {
            heartbeat: Arc::new(RwLock::new(UiWatchdogHeartbeatState::default())),
            traces: Arc::new(Mutex::new(VecDeque::new())),
            diagnostics_meta: Arc::new(Mutex::new(UiWatchdogDiagnosticsMeta::default())),
            dump_writer,
        }
    }

    fn append_trace(&self, kind: &str, now_unix_ms: u64, fields: serde_json::Value) {
        let mut traces = self.traces.lock();
        traces.push_back(serde_json::json!({
            "unix_ms": now_unix_ms,
            "kind": kind,
            "fields": fields,
        }));
        while traces.len() > UI_WATCHDOG_TRACE_CAPACITY {
            traces.pop_front();
        }
        let cutoff = now_unix_ms.saturating_sub(UI_WATCHDOG_DUMP_WINDOW_MS);
        while traces
            .front()
            .and_then(|entry| entry.get("unix_ms").and_then(|value| value.as_u64()))
            .is_some_and(|unix_ms| unix_ms < cutoff)
        {
            traces.pop_front();
        }
    }

    fn heartbeat_snapshot(&self) -> UiWatchdogHeartbeatState {
        self.heartbeat.read().clone()
    }

    fn trace_snapshot(&self) -> Vec<serde_json::Value> {
        self.traces.lock().iter().cloned().collect()
    }

    fn build_dump_payload(
        trigger: &str,
        now_unix_ms: u64,
        heartbeat: &UiWatchdogHeartbeatState,
        diagnostics: &UiWatchdogDiagnosticsMeta,
        traces: &[serde_json::Value],
    ) -> serde_json::Value {
        let payload = serde_json::json!({
            "trigger": trigger,
            "captured_at_unix_ms": now_unix_ms,
            "window_ms": UI_WATCHDOG_DUMP_WINDOW_MS,
            "snapshot": {
                "last_heartbeat_unix_ms": heartbeat.last_heartbeat_unix_ms,
                "active_page": heartbeat.active_page,
                "visible": heartbeat.visible,
                "status_in_flight": heartbeat.status_in_flight,
                "config_in_flight": heartbeat.config_in_flight,
                "provider_switch_in_flight": heartbeat.provider_switch_in_flight,
                "unresponsive_logged": diagnostics.unresponsive_logged,
                "unresponsive_since_unix_ms": diagnostics.unresponsive_since_unix_ms,
            },
            "recent_traces": traces,
        });
        payload
    }

    fn write_dump(
        &self,
        diagnostics_dir: &std::path::Path,
        trigger: &str,
        now_unix_ms: u64,
        payload: &serde_json::Value,
    ) {
        let filename = format!("ui-freeze-{now_unix_ms}-{trigger}.json");
        let path = diagnostics_dir.join(filename);
        let _ = (self.dump_writer)(&path, payload);
    }

    pub fn record_heartbeat(
        &self,
        active_page: &str,
        visible: bool,
        status_in_flight: bool,
        config_in_flight: bool,
        provider_switch_in_flight: bool,
        now_unix_ms: u64,
    ) {
        let active_page_value = active_page.trim().to_string();
        {
            let mut heartbeat = self.heartbeat.write();
            heartbeat.last_heartbeat_unix_ms = now_unix_ms;
            heartbeat.active_page = active_page_value.clone();
            heartbeat.visible = visible;
            heartbeat.status_in_flight = status_in_flight;
            heartbeat.config_in_flight = config_in_flight;
            heartbeat.provider_switch_in_flight = provider_switch_in_flight;
        }
        self.append_trace(
            "heartbeat",
            now_unix_ms,
            serde_json::json!({
                "active_page": active_page_value,
                "visible": visible,
                "status_in_flight": status_in_flight,
                "config_in_flight": config_in_flight,
                "provider_switch_in_flight": provider_switch_in_flight,
            }),
        );
    }

    pub fn record_trace(&self, kind: &str, fields: serde_json::Value, now_unix_ms: u64) {
        self.append_trace(kind.trim(), now_unix_ms, fields);
    }

    pub fn record_slow_refresh(
        &self,
        runtime: UiWatchdogRuntime<'_>,
        kind: &str,
        elapsed_ms: u64,
        page: UiWatchdogPageState<'_>,
        now_unix_ms: u64,
    ) {
        if elapsed_ms < UI_WATCHDOG_SLOW_REFRESH_AFTER_MS {
            return;
        }
        let kind_key = kind.trim().to_ascii_lowercase();
        let heartbeat = self.heartbeat_snapshot();
        self.append_trace(
            "slow_refresh",
            now_unix_ms,
            serde_json::json!({
                "kind": kind_key,
                "elapsed_ms": elapsed_ms,
                "active_page": page.active_page.trim(),
                "visible": page.visible,
            }),
        );
        let mut diagnostics = self.diagnostics_meta.lock();
        let last_logged_at = match kind_key.as_str() {
            "status" => &mut diagnostics.last_status_slow_log_unix_ms,
            "config" => &mut diagnostics.last_config_slow_log_unix_ms,
            "provider_switch" => &mut diagnostics.last_provider_switch_slow_log_unix_ms,
            _ => return,
        };
        if *last_logged_at > 0
            && now_unix_ms.saturating_sub(*last_logged_at)
                < UI_WATCHDOG_SLOW_REFRESH_LOG_COOLDOWN_MS
        {
            return;
        }
        *last_logged_at = now_unix_ms;
        let diagnostics_snapshot = diagnostics.clone();
        drop(diagnostics);
        let traces = self.trace_snapshot();
        let payload = Self::build_dump_payload(
            "slow-refresh",
            now_unix_ms,
            &heartbeat,
            &diagnostics_snapshot,
            &traces,
        );
        self.write_dump(
            runtime.diagnostics_dir,
            "slow-refresh",
            now_unix_ms,
            &payload,
        );
    }

    pub fn record_long_task(
        &self,
        runtime: UiWatchdogRuntime<'_>,
        elapsed_ms: u64,
        page: UiWatchdogPageState<'_>,
        now_unix_ms: u64,
    ) {
        let heartbeat = self.heartbeat_snapshot();
        self.append_trace(
            "long_task",
            now_unix_ms,
            serde_json::json!({
                "elapsed_ms": elapsed_ms,
                "active_page": page.active_page.trim(),
                "visible": page.visible,
            }),
        );
        if elapsed_ms < UI_WATCHDOG_LONG_TASK_AFTER_MS {
            return;
        }
        let mut diagnostics = self.diagnostics_meta.lock();
        if diagnostics.last_long_task_log_unix_ms > 0
            && now_unix_ms.saturating_sub(diagnostics.last_long_task_log_unix_ms)
                < UI_WATCHDOG_LONG_TASK_LOG_COOLDOWN_MS
        {
            return;
        }
        diagnostics.last_long_task_log_unix_ms = now_unix_ms;
        let diagnostics_snapshot = diagnostics.clone();
        drop(diagnostics);
        let traces = self.trace_snapshot();
        let payload = Self::build_dump_payload(
            "long-task",
            now_unix_ms,
            &heartbeat,
            &diagnostics_snapshot,
            &traces,
        );
        self.write_dump(runtime.diagnostics_dir, "long-task", now_unix_ms, &payload);
    }

    pub fn record_frame_stall(
        &self,
        runtime: UiWatchdogRuntime<'_>,
        elapsed_ms: u64,
        monitor_kind: &str,
        page: UiWatchdogPageState<'_>,
        now_unix_ms: u64,
    ) {
        let heartbeat = self.heartbeat_snapshot();
        let monitor_kind = monitor_kind.trim();
        self.append_trace(
            "frame_stall",
            now_unix_ms,
            serde_json::json!({
                "elapsed_ms": elapsed_ms,
                "monitor_kind": monitor_kind,
                "active_page": page.active_page.trim(),
                "visible": page.visible,
            }),
        );
        runtime.store.events().app().ui_frame_stall_at(
            "gateway",
            &format!("ui frame stalled for {elapsed_ms}ms"),
            serde_json::json!({
                "elapsed_ms": elapsed_ms,
                "monitor_kind": monitor_kind,
                "active_page": page.active_page.trim(),
                "visible": page.visible,
            }),
            now_unix_ms,
        );
        let mut diagnostics = self.diagnostics_meta.lock();
        if diagnostics.last_frame_stall_log_unix_ms > 0
            && now_unix_ms.saturating_sub(diagnostics.last_frame_stall_log_unix_ms)
                < UI_WATCHDOG_FRAME_STALL_LOG_COOLDOWN_MS
        {
            return;
        }
        diagnostics.last_frame_stall_log_unix_ms = now_unix_ms;
        let diagnostics_snapshot = diagnostics.clone();
        drop(diagnostics);
        let traces = self.trace_snapshot();
        let payload = Self::build_dump_payload(
            "frame-stall",
            now_unix_ms,
            &heartbeat,
            &diagnostics_snapshot,
            &traces,
        );
        self.write_dump(
            runtime.diagnostics_dir,
            "frame-stall",
            now_unix_ms,
            &payload,
        );
    }

    pub fn record_frontend_error(
        &self,
        runtime: UiWatchdogRuntime<'_>,
        kind: &str,
        message: &str,
        page: UiWatchdogPageState<'_>,
        now_unix_ms: u64,
    ) {
        let heartbeat = self.heartbeat_snapshot();
        self.append_trace(
            "frontend_error",
            now_unix_ms,
            serde_json::json!({
                "kind": kind.trim(),
                "message": message.trim(),
                "active_page": page.active_page.trim(),
                "visible": page.visible,
            }),
        );
        runtime.store.events().app().ui_frontend_error_at(
            "gateway",
            &format!("frontend runtime {kind}: {}", message.trim()),
            serde_json::json!({
                "kind": kind.trim(),
                "message": message.trim(),
                "active_page": page.active_page.trim(),
                "visible": page.visible,
            }),
            now_unix_ms,
        );
        let mut diagnostics = self.diagnostics_meta.lock();
        if diagnostics.last_frontend_error_log_unix_ms > 0
            && now_unix_ms.saturating_sub(diagnostics.last_frontend_error_log_unix_ms)
                < UI_WATCHDOG_LONG_TASK_LOG_COOLDOWN_MS
        {
            return;
        }
        diagnostics.last_frontend_error_log_unix_ms = now_unix_ms;
        let diagnostics_snapshot = diagnostics.clone();
        drop(diagnostics);
        let traces = self.trace_snapshot();
        let payload = Self::build_dump_payload(
            "frontend-error",
            now_unix_ms,
            &heartbeat,
            &diagnostics_snapshot,
            &traces,
        );
        self.write_dump(
            runtime.diagnostics_dir,
            "frontend-error",
            now_unix_ms,
            &payload,
        );
    }

    pub fn record_invoke_result(
        &self,
        runtime: UiWatchdogRuntime<'_>,
        invoke: UiWatchdogInvokeResult<'_>,
        page: UiWatchdogPageState<'_>,
        now_unix_ms: u64,
    ) {
        let heartbeat = self.heartbeat_snapshot();
        let command = invoke.command.trim();
        let elapsed_ms = invoke.elapsed_ms;
        let ok = invoke.ok;
        let error_message = invoke.error_message.unwrap_or("").trim();
        self.append_trace(
            "invoke",
            now_unix_ms,
            serde_json::json!({
                "command": command,
                "elapsed_ms": elapsed_ms,
                "ok": ok,
                "error": if error_message.is_empty() { serde_json::Value::Null } else { serde_json::json!(error_message) },
                "active_page": page.active_page.trim(),
                "visible": page.visible,
            }),
        );

        if !ok {
            runtime.store.events().app().ui_invoke_error_at(
                "gateway",
                &format!("ui invoke failed: {command}"),
                serde_json::json!({
                    "command": command,
                    "elapsed_ms": elapsed_ms,
                    "error": error_message,
                    "active_page": page.active_page.trim(),
                    "visible": page.visible,
                }),
                now_unix_ms,
            );
            let mut diagnostics = self.diagnostics_meta.lock();
            if diagnostics.last_invoke_error_log_unix_ms > 0
                && now_unix_ms.saturating_sub(diagnostics.last_invoke_error_log_unix_ms)
                    < UI_WATCHDOG_INVOKE_LOG_COOLDOWN_MS
            {
                return;
            }
            diagnostics.last_invoke_error_log_unix_ms = now_unix_ms;
            let diagnostics_snapshot = diagnostics.clone();
            drop(diagnostics);
            let traces = self.trace_snapshot();
            let payload = Self::build_dump_payload(
                "invoke-error",
                now_unix_ms,
                &heartbeat,
                &diagnostics_snapshot,
                &traces,
            );
            self.write_dump(
                runtime.diagnostics_dir,
                "invoke-error",
                now_unix_ms,
                &payload,
            );
            return;
        }

        if elapsed_ms < UI_WATCHDOG_SLOW_REFRESH_AFTER_MS {
            return;
        }
        let mut diagnostics = self.diagnostics_meta.lock();
        if diagnostics.last_invoke_slow_log_unix_ms > 0
            && now_unix_ms.saturating_sub(diagnostics.last_invoke_slow_log_unix_ms)
                < UI_WATCHDOG_INVOKE_LOG_COOLDOWN_MS
        {
            return;
        }
        diagnostics.last_invoke_slow_log_unix_ms = now_unix_ms;
        let diagnostics_snapshot = diagnostics.clone();
        drop(diagnostics);
        let traces = self.trace_snapshot();
        let payload = Self::build_dump_payload(
            "slow-invoke",
            now_unix_ms,
            &heartbeat,
            &diagnostics_snapshot,
            &traces,
        );
        self.write_dump(
            runtime.diagnostics_dir,
            "slow-invoke",
            now_unix_ms,
            &payload,
        );
    }

    pub fn check_unresponsive(
        &self,
        store: &crate::orchestrator::store::Store,
        diagnostics_dir: &std::path::Path,
        now_unix_ms: u64,
    ) {
        let heartbeat = self.heartbeat_snapshot();
        let last_heartbeat = heartbeat.last_heartbeat_unix_ms;
        if last_heartbeat == 0 {
            return;
        }
        let heartbeat_age_ms = now_unix_ms.saturating_sub(last_heartbeat);
        let mut diagnostics = self.diagnostics_meta.lock();
        if heartbeat_age_ms > UI_WATCHDOG_UNRESPONSIVE_AFTER_MS {
            if diagnostics.unresponsive_logged {
                return;
            }
            diagnostics.unresponsive_logged = true;
            diagnostics.unresponsive_since_unix_ms = last_heartbeat;
            store.events().app().ui_unresponsive(
                "gateway",
                "ui heartbeat stalled",
                serde_json::json!({
                    "heartbeat_age_ms": heartbeat_age_ms,
                    "active_page": heartbeat.active_page,
                    "visible": heartbeat.visible,
                    "status_in_flight": heartbeat.status_in_flight,
                    "config_in_flight": heartbeat.config_in_flight,
                    "provider_switch_in_flight": heartbeat.provider_switch_in_flight,
                }),
            );
            let diagnostics_snapshot = diagnostics.clone();
            drop(diagnostics);
            let traces = self.trace_snapshot();
            let payload = Self::build_dump_payload(
                "heartbeat-stall",
                now_unix_ms,
                &heartbeat,
                &diagnostics_snapshot,
                &traces,
            );
            self.write_dump(diagnostics_dir, "heartbeat-stall", now_unix_ms, &payload);
            return;
        }
        if !diagnostics.unresponsive_logged {
            return;
        }
        let stalled_for_ms = now_unix_ms.saturating_sub(diagnostics.unresponsive_since_unix_ms);
        diagnostics.unresponsive_logged = false;
        diagnostics.unresponsive_since_unix_ms = 0;
        store.events().app().ui_recovered(
            "gateway",
            "ui heartbeat recovered",
            serde_json::json!({
                "stalled_for_ms": stalled_for_ms,
                "active_page": heartbeat.active_page,
                "visible": heartbeat.visible,
            }),
        );
    }
}

impl Default for UiWatchdogState {
    fn default() -> Self {
        Self {
            heartbeat: Arc::new(RwLock::new(UiWatchdogHeartbeatState::default())),
            traces: Arc::new(Mutex::new(VecDeque::new())),
            diagnostics_meta: Arc::new(Mutex::new(UiWatchdogDiagnosticsMeta::default())),
            dump_writer: Arc::new(crate::diagnostics::write_pretty_json),
        }
    }
}

pub fn run_startup_gateway_token_sync(state: &AppState) {
    match crate::provider_switchboard::sync_gateway_target_for_current_token_on_startup(state) {
        Ok(failed_targets) => {
            if !failed_targets.is_empty() {
                state
                    .gateway
                    .store
                    .events()
                    .codex()
                    .provider_switchboard_gateway_token_sync_failed(
                        "gateway",
                        "Gateway token sync at startup failed for some targets.",
                        serde_json::json!({ "failed_targets": failed_targets }),
                    );
            }
        }
        Err(e) => {
            state
                .gateway
                .store
                .events()
                .codex()
                .provider_switchboard_gateway_token_sync_failed(
                    "gateway",
                    &format!("Gateway token sync at startup failed: {e}"),
                    serde_json::Value::Null,
                );
        }
    }
}

pub fn run_startup_usage_key_ref_backfill(state: &AppState) -> usize {
    let mut key_refs: std::collections::BTreeMap<String, String> =
        std::collections::BTreeMap::new();
    for provider_name in state.gateway.cfg.read().providers.keys() {
        let key_ref = state
            .secrets
            .get_provider_key(provider_name)
            .as_deref()
            .map(mask_key_preview)
            .unwrap_or_else(|| "-".to_string());
        key_refs.insert(provider_name.clone(), key_ref);
    }
    state.gateway.store.backfill_api_key_ref_fields(&key_refs)
}

pub fn run_startup_usage_request_node_backfill(state: &AppState) -> usize {
    let Some(node) = state.secrets.get_lan_node_identity() else {
        return 0;
    };
    state
        .gateway
        .store
        .backfill_usage_request_node_identity(&node.node_id, &node.node_name)
}

pub fn disable_expired_package_providers(state: &AppState) -> Vec<String> {
    if state.secrets.get_followed_config_source_node_id().is_some() {
        return Vec::new();
    }
    let now = unix_ms();
    let mut expired = Vec::new();
    {
        let mut cfg = state.gateway.cfg.write();
        for (provider_name, provider) in cfg.providers.iter_mut() {
            if provider.disabled {
                continue;
            }
            let Some(expires_at) = state
                .gateway
                .store
                .get_quota_snapshot(provider_name)
                .and_then(|snapshot| {
                    snapshot
                        .get("package_expires_at_unix_ms")
                        .and_then(|value| value.as_u64())
                })
            else {
                continue;
            };
            if expires_at > now {
                continue;
            }
            provider.disabled = true;
            expired.push(provider_name.clone());
        }
        if expired.is_empty() {
            return expired;
        }
        cfg.routing
            .session_preferred_providers
            .retain(|_, provider_name| !expired.iter().any(|item| item == provider_name));
        if expired
            .iter()
            .any(|provider_name| provider_name == &cfg.routing.preferred_provider)
        {
            if let Some(next_provider) = cfg.provider_order.iter().find(|provider_name| {
                cfg.providers
                    .get(*provider_name)
                    .is_some_and(|provider| !provider.disabled)
            }) {
                cfg.routing.preferred_provider = next_provider.clone();
            }
        }
        normalize_provider_order(&mut cfg);
        let _ = std::fs::write(
            &state.config_path,
            toml::to_string_pretty(&*cfg).unwrap_or_default(),
        );
    }
    for provider_name in &expired {
        state
            .gateway
            .last_used_by_session
            .write()
            .retain(|_, route| {
                route.provider != *provider_name && route.preferred != *provider_name
            });
        if let Err(err) = crate::lan_sync::record_provider_definition_patch(
            state,
            provider_name,
            serde_json::json!({ "disabled": true }),
        ) {
            state.gateway.store.events().lan().edit_sync_record_failed(
                provider_name,
                &format!("failed to record expired provider disable for LAN sync: {err}"),
                serde_json::Value::Null,
            );
        }
        state.gateway.store.events().emit(
            provider_name,
            crate::orchestrator::store::EventCode::CONFIG_PROVIDER_DISABLED_AFTER_PACKAGE_EXPIRY,
            "provider disabled automatically after package expiry",
            serde_json::json!({ "expired_at_unix_ms": now }),
        );
    }
    let cfg = state.gateway.cfg.read().clone();
    state.gateway.router.sync_with_config(&cfg, now);
    expired
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
    let _ = secrets.ensure_lan_trust_secret();

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
    for provider_name in cfg.providers.keys() {
        let _ = secrets.ensure_provider_shared_id(provider_name);
    }

    let store = open_store_dir(data_dir.clone())?;
    let router = Arc::new(RouterState::new_with_store(
        &cfg,
        unix_ms(),
        Some(store.clone()),
    ));
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
    let lan_node = secrets
        .ensure_lan_node_identity(&crate::lan_sync::default_node_name())
        .map_err(anyhow::Error::msg)?;
    let app_state = AppState {
        diagnostics_dir: crate::diagnostics::app_diagnostics_dir(&config_path, &data_dir),
        config_path,
        gateway,
        secrets,
        lan_sync: crate::lan_sync::LanSyncRuntime::new(lan_node),
        local_network: crate::platform::local_network::LocalNetworkState::new(),
        ui_watchdog: UiWatchdogState::default(),
    };
    app_state
        .gateway
        .store
        .sync_provider_pricing_configs(&app_state.secrets.list_provider_pricing());
    let _ = crate::lan_sync::ensure_local_edit_seed_state(&app_state);

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
    use super::{
        build_state, disable_expired_package_providers, load_or_init_config,
        run_startup_gateway_token_sync, UiWatchdogPageState, UiWatchdogRuntime, UiWatchdogState,
    };
    use crate::orchestrator::config::AppConfig;
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

        let state = build_state(config_path, data_dir).expect("build state");
        run_startup_gateway_token_sync(&state);

        let auth: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(cli_home.join("auth.json")).expect("read synced auth"),
        )
        .expect("parse synced auth");
        assert_eq!(
            auth.get("OPENAI_API_KEY").and_then(|v| v.as_str()),
            Some("ao_new_gateway_token")
        );
    }

    #[tokio::test]
    async fn prepare_gateway_listeners_reassigns_port_and_persists_config_when_occupied() {
        let occupied = std::net::TcpListener::bind("127.0.0.1:0").expect("occupy port");
        let occupied_port = occupied.local_addr().expect("occupied addr").port();
        let tmp = tempfile::tempdir().expect("tempdir");
        let config_path = tmp.path().join("user-data").join("config.toml");
        let data_dir = tmp.path().join("data");
        std::fs::create_dir_all(config_path.parent().expect("config parent")).expect("mkdir");
        let mut cfg = AppConfig::default_config();
        cfg.listen.port = occupied_port;
        std::fs::write(
            &config_path,
            toml::to_string_pretty(&cfg).expect("cfg toml"),
        )
        .expect("write cfg");

        let state = build_state(config_path.clone(), data_dir).expect("build state");
        let prepared = crate::orchestrator::gateway_bootstrap::prepare_gateway_listeners(&state)
            .expect("prepare");
        let active_port = state.gateway.cfg.read().listen.port;
        let persisted = load_or_init_config(&config_path).expect("load config");

        assert_ne!(active_port, occupied_port);
        assert_eq!(prepared.listen_port, active_port);
        assert_eq!(persisted.listen.port, active_port);

        drop(prepared);
        drop(occupied);
    }

    #[tokio::test]
    async fn startup_gateway_token_sync_uses_reassigned_gateway_port() {
        let occupied = std::net::TcpListener::bind("127.0.0.1:0").expect("occupy port");
        let occupied_port = occupied.local_addr().expect("occupied addr").port();
        let tmp = tempfile::tempdir().expect("tempdir");
        let config_path = tmp.path().join("user-data").join("config.toml");
        let data_dir = tmp.path().join("data");
        std::fs::create_dir_all(config_path.parent().expect("config parent")).expect("mkdir");
        let mut cfg = AppConfig::default_config();
        cfg.listen.port = occupied_port;
        std::fs::write(
            &config_path,
            toml::to_string_pretty(&cfg).expect("cfg toml"),
        )
        .expect("write cfg");

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

        let state = build_state(config_path.clone(), data_dir).expect("build state");
        let prepared = crate::orchestrator::gateway_bootstrap::prepare_gateway_listeners(&state)
            .expect("prepare");
        let active_port = state.gateway.cfg.read().listen.port;
        assert_ne!(active_port, occupied_port);

        run_startup_gateway_token_sync(&state);

        let cli_cfg = std::fs::read_to_string(cli_home.join("config.toml")).expect("read cli cfg");
        assert!(cli_cfg.contains(&format!("base_url = \"http://127.0.0.1:{active_port}/v1\"")));

        drop(prepared);
        drop(occupied);
    }

    #[test]
    fn disable_expired_package_providers_disables_local_provider_after_expiry() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let config_path = tmp.path().join("user-data").join("config.toml");
        let data_dir = tmp.path().join("data");
        std::fs::create_dir_all(config_path.parent().expect("config parent")).expect("mkdir");

        let state = build_state(config_path.clone(), data_dir).expect("build state");
        let provider_name = "official";
        state
            .gateway
            .store
            .put_quota_snapshot(
                provider_name,
                &json!({
                    "package_expires_at_unix_ms": crate::orchestrator::store::unix_ms().saturating_sub(1_000)
                }),
            )
            .expect("put quota snapshot");

        let disabled = disable_expired_package_providers(&state);

        assert_eq!(disabled, vec![provider_name.to_string()]);
        assert!(state
            .gateway
            .cfg
            .read()
            .providers
            .get(provider_name)
            .is_some_and(|provider| provider.disabled));
        let persisted = load_or_init_config(&config_path).expect("load config");
        assert!(persisted
            .providers
            .get(provider_name)
            .is_some_and(|provider| provider.disabled));
    }

    #[test]
    fn ui_watchdog_logs_unresponsive_and_recovered_once() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let config_path = tmp.path().join("user-data").join("config.toml");
        let data_dir = tmp.path().join("data");
        std::fs::create_dir_all(config_path.parent().expect("config parent")).expect("mkdir");

        let state = build_state(config_path, data_dir).expect("build state");
        let watchdog = UiWatchdogState::default();

        watchdog.record_heartbeat("dashboard", true, true, false, false, 1_000);
        watchdog.check_unresponsive(&state.gateway.store, &state.diagnostics_dir, 7_500);
        watchdog.check_unresponsive(&state.gateway.store, &state.diagnostics_dir, 9_000);
        watchdog.record_heartbeat("dashboard", true, false, false, false, 9_100);
        watchdog.check_unresponsive(&state.gateway.store, &state.diagnostics_dir, 9_200);
        watchdog.check_unresponsive(&state.gateway.store, &state.diagnostics_dir, 9_300);

        let events = state.gateway.store.list_events_range(None, None, Some(10));
        let codes = events
            .iter()
            .filter_map(|entry| entry.get("code").and_then(|value| value.as_str()))
            .collect::<Vec<_>>();

        assert_eq!(
            codes
                .iter()
                .filter(|code| **code == "app.ui_unresponsive")
                .count(),
            1
        );
        assert_eq!(
            codes
                .iter()
                .filter(|code| **code == "app.ui_recovered")
                .count(),
            1
        );
        let dump_count = std::fs::read_dir(&state.diagnostics_dir)
            .expect("diagnostics dir")
            .filter_map(|entry| entry.ok())
            .count();
        assert!(dump_count >= 1);
    }

    #[test]
    fn ui_watchdog_slow_refresh_only_writes_diagnostics_dumps() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let config_path = tmp.path().join("user-data").join("config.toml");
        let data_dir = tmp.path().join("data");
        std::fs::create_dir_all(config_path.parent().expect("config parent")).expect("mkdir");

        let state = build_state(config_path, data_dir).expect("build state");
        let watchdog = UiWatchdogState::default();

        watchdog.record_slow_refresh(
            UiWatchdogRuntime {
                store: &state.gateway.store,
                diagnostics_dir: &state.diagnostics_dir,
            },
            "status",
            2_500,
            UiWatchdogPageState {
                active_page: "dashboard",
                visible: true,
            },
            10_000,
        );
        watchdog.record_slow_refresh(
            UiWatchdogRuntime {
                store: &state.gateway.store,
                diagnostics_dir: &state.diagnostics_dir,
            },
            "status",
            2_600,
            UiWatchdogPageState {
                active_page: "dashboard",
                visible: true,
            },
            10_500,
        );
        watchdog.record_slow_refresh(
            UiWatchdogRuntime {
                store: &state.gateway.store,
                diagnostics_dir: &state.diagnostics_dir,
            },
            "config",
            2_700,
            UiWatchdogPageState {
                active_page: "dashboard",
                visible: true,
            },
            10_700,
        );

        let slow_refresh_events = state
            .gateway
            .store
            .list_events_range(None, None, Some(10))
            .iter()
            .filter(|entry| {
                entry
                    .get("code")
                    .and_then(|value| value.as_str())
                    .is_some_and(|code| code == "app.ui_slow_refresh")
            })
            .count();

        assert_eq!(slow_refresh_events, 0);
        let dump_count = std::fs::read_dir(&state.diagnostics_dir)
            .expect("diagnostics dir")
            .filter_map(|entry| entry.ok())
            .count();
        assert!(dump_count >= 2);
    }

    #[test]
    fn ui_watchdog_frame_stall_logs_with_cooldown() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let config_path = tmp.path().join("user-data").join("config.toml");
        let data_dir = tmp.path().join("data");
        std::fs::create_dir_all(config_path.parent().expect("config parent")).expect("mkdir");

        let state = build_state(config_path, data_dir).expect("build state");
        let watchdog = UiWatchdogState::default();

        let runtime = UiWatchdogRuntime {
            store: &state.gateway.store,
            diagnostics_dir: &state.diagnostics_dir,
        };
        let page = UiWatchdogPageState {
            active_page: "requests",
            visible: true,
        };
        let base_unix_ms = 1_700_000_000_000_u64;

        watchdog.record_frame_stall(runtime, 123, "startup", page, base_unix_ms + 10_000);
        watchdog.record_frame_stall(
            UiWatchdogRuntime {
                store: &state.gateway.store,
                diagnostics_dir: &state.diagnostics_dir,
            },
            145,
            "interaction",
            UiWatchdogPageState {
                active_page: "requests",
                visible: true,
            },
            base_unix_ms + 15_000,
        );
        watchdog.record_frame_stall(
            UiWatchdogRuntime {
                store: &state.gateway.store,
                diagnostics_dir: &state.diagnostics_dir,
            },
            167,
            "interaction",
            UiWatchdogPageState {
                active_page: "requests",
                visible: true,
            },
            base_unix_ms + 21_000,
        );

        let events = state.gateway.store.list_events_range(None, None, Some(10));
        let frame_stall_events = events
            .iter()
            .filter(|entry| {
                entry
                    .get("code")
                    .and_then(|value| value.as_str())
                    .is_some_and(|code| code == "app.ui_frame_stall")
            })
            .count();
        assert_eq!(frame_stall_events, 2);

        let dump_count = std::fs::read_dir(&state.diagnostics_dir)
            .expect("diagnostics dir")
            .filter_map(|entry| entry.ok())
            .filter(|entry| {
                entry
                    .file_name()
                    .to_str()
                    .is_some_and(|name| name.contains("frame-stall"))
            })
            .count();
        assert_eq!(dump_count, 2);
    }

    #[test]
    fn ui_watchdog_heartbeat_is_not_blocked_by_slow_dump_writes() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::mpsc;
        use std::sync::Arc;
        use std::time::Duration;

        let tmp = tempfile::tempdir().expect("tempdir");
        let config_path = tmp.path().join("user-data").join("config.toml");
        let data_dir = tmp.path().join("data");
        std::fs::create_dir_all(config_path.parent().expect("config parent")).expect("mkdir");

        let state = build_state(config_path, data_dir).expect("build state");
        let dump_started = Arc::new(AtomicBool::new(false));
        let release_dump = Arc::new(AtomicBool::new(false));
        let dump_started_for_writer = dump_started.clone();
        let release_dump_for_writer = release_dump.clone();
        let watchdog = UiWatchdogState::with_dump_writer(Arc::new(move |path, payload| {
            dump_started_for_writer.store(true, Ordering::SeqCst);
            while !release_dump_for_writer.load(Ordering::SeqCst) {
                std::thread::sleep(Duration::from_millis(10));
            }
            crate::diagnostics::write_pretty_json(path, payload)
        }));

        watchdog.record_heartbeat("dashboard", true, false, false, false, 1_000);

        let watchdog_for_dump = watchdog.clone();
        let store = state.gateway.store.clone();
        let diagnostics_dir = state.diagnostics_dir.clone();
        let dump_thread = std::thread::spawn(move || {
            watchdog_for_dump.record_slow_refresh(
                UiWatchdogRuntime {
                    store: &store,
                    diagnostics_dir: &diagnostics_dir,
                },
                "status",
                2_500,
                UiWatchdogPageState {
                    active_page: "dashboard",
                    visible: true,
                },
                10_000,
            );
        });

        while !dump_started.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(10));
        }

        let (tx, rx) = mpsc::channel();
        let watchdog_for_heartbeat = watchdog.clone();
        let heartbeat_thread = std::thread::spawn(move || {
            watchdog_for_heartbeat.record_heartbeat("dashboard", true, false, false, false, 11_000);
            tx.send(()).expect("send heartbeat done");
        });

        rx.recv_timeout(Duration::from_millis(200))
            .expect("heartbeat should not block on dump writing");
        watchdog.check_unresponsive(&state.gateway.store, &state.diagnostics_dir, 15_000);

        release_dump.store(true, Ordering::SeqCst);
        heartbeat_thread.join().expect("join heartbeat thread");
        dump_thread.join().expect("join dump thread");

        let unresponsive_events = state
            .gateway
            .store
            .list_events_range(None, None, Some(10))
            .iter()
            .filter(|entry| {
                entry
                    .get("code")
                    .and_then(|value| value.as_str())
                    .is_some_and(|code| code == "app.ui_unresponsive")
            })
            .count();
        assert_eq!(unresponsive_events, 0);
    }
}
