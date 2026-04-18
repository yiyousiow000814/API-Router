use super::web_codex_home::{web_codex_rpc_home_override_for_target, WorkspaceTarget};
use super::web_codex_rollout_import::{
    import_rollout_from_known_path, import_windows_rollout_into_codex_home,
    import_wsl_rollout_into_codex_home, resume_import_order,
};
use super::web_codex_rollout_path::runtime_path_should_override_existing;
use super::web_codex_session_runtime::{
    ensure_workspace_runtime_registered, mark_workspace_runtime_connected,
    mark_workspace_runtime_replay, upsert_workspace_thread_runtime, workspace_runtime_snapshot,
    workspace_thread_runtime_snapshot, WorkspaceRuntimeSnapshot, WorkspaceThreadRuntimeSnapshot,
    WorkspaceThreadRuntimeUpdate,
};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

const MANAGED_TERMINAL_DISCOVERY_TIMEOUT_MS: u64 = 4_000;
const MANAGED_TERMINAL_DISCOVERY_POLL_MS: u64 = 100;

fn runtime_trace_cache() -> &'static Mutex<HashMap<String, String>> {
    static CACHE: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn toggle_sandbox_variant(value: &str) -> Option<String> {
    match value.trim() {
        "dangerFullAccess" => Some("danger-full-access".to_string()),
        "danger-full-access" => Some("dangerFullAccess".to_string()),
        "readOnly" => Some("read-only".to_string()),
        "read-only" => Some("readOnly".to_string()),
        "workspaceWrite" => Some("workspace-write".to_string()),
        "workspace-write" => Some("workspaceWrite".to_string()),
        _ => None,
    }
}

fn toggle_sandbox_schema(params: &Value) -> Value {
    let mut next = params.clone();
    let Some(obj) = next.as_object_mut() else {
        return next;
    };
    if let Some(sandbox) = obj.get("sandbox").and_then(Value::as_str) {
        if let Some(next_value) = toggle_sandbox_variant(sandbox) {
            obj.insert("sandbox".to_string(), Value::String(next_value));
        }
    }
    if let Some(policy_value) = obj.get_mut("sandboxPolicy") {
        if let Some(policy) = policy_value.as_object_mut() {
            if let Some(value) = policy.get("type").and_then(Value::as_str) {
                if let Some(next_value) = toggle_sandbox_variant(value) {
                    policy.insert("type".to_string(), Value::String(next_value));
                }
            }
        }
    }
    next
}

fn sandbox_schema_retryable_error(error: &str) -> bool {
    let lower = error.to_ascii_lowercase();
    lower.contains("unknown variant")
        && (lower.contains("workspacewrite")
            || lower.contains("workspace-write")
            || lower.contains("readonly")
            || lower.contains("read-only")
            || lower.contains("dangerfullaccess")
            || lower.contains("danger-full-access"))
}

fn workspace_target_label(workspace_target: Option<WorkspaceTarget>) -> &'static str {
    match workspace_target {
        Some(WorkspaceTarget::Windows) => "windows",
        Some(WorkspaceTarget::Wsl2) => "wsl2",
        None => "unspecified",
    }
}

fn trace_runtime_payload_summary(
    cache_key: String,
    summary: serde_json::Value,
) -> Result<(), String> {
    let summary_text = serde_json::to_string(&summary).map_err(|err| err.to_string())?;
    let cache = runtime_trace_cache();
    let mut guard = match cache.lock() {
        Ok(guard) => guard,
        Err(err) => err.into_inner(),
    };
    if guard.get(&cache_key).map(String::as_str) == Some(summary_text.as_str()) {
        return Ok(());
    }
    guard.insert(cache_key, summary_text);
    crate::orchestrator::gateway::web_codex_storage::append_codex_live_trace_entry(&summary)
}

fn trace_loaded_thread_ids_snapshot(
    workspace_target: Option<WorkspaceTarget>,
    home_override: Option<&str>,
    loaded_ids: &[String],
) {
    let _ = trace_runtime_payload_summary(
        format!(
            "loaded-thread-ids:{}:{}",
            workspace_target_label(workspace_target),
            home_override.unwrap_or_default()
        ),
        json!({
            "source": "codex.session_manager",
            "entry": {
                "at": crate::orchestrator::store::unix_ms(),
                "kind": "codex.session_manager.loaded_thread_ids",
                "workspace": workspace_target_label(workspace_target),
                "homeOverride": home_override,
                "count": loaded_ids.len(),
                "threadIds": loaded_ids,
            }
        }),
    );
}

fn trace_read_thread_runtime_summary(
    workspace_target: Option<WorkspaceTarget>,
    home_override: Option<&str>,
    requested_thread_id: &str,
    include_turns: bool,
    value: &Value,
) {
    let Some(thread) = runtime_thread_payload(value) else {
        return;
    };
    let Some(thread_obj) = thread.as_object() else {
        return;
    };
    let base_url = ["base_url", "baseUrl", "model_provider_base_url"]
        .into_iter()
        .find_map(|key| thread_obj.get(key).and_then(Value::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let summary = json!({
        "source": "codex.session_manager",
        "entry": {
            "at": crate::orchestrator::store::unix_ms(),
            "kind": "codex.session_manager.thread_read",
            "workspace": workspace_target_label(workspace_target),
            "homeOverride": home_override,
            "requestedThreadId": requested_thread_id,
            "threadId": thread_obj.get("id").and_then(Value::as_str),
            "includeTurns": include_turns,
            "statusType": thread_obj
                .get("status")
                .and_then(Value::as_object)
                .and_then(|status| status.get("type"))
                .and_then(Value::as_str),
            "hasBaseUrl": base_url.is_some(),
            "baseUrl": base_url,
            "path": thread_obj.get("path").and_then(Value::as_str),
            "cwd": thread_obj.get("cwd").and_then(Value::as_str),
            "turnCount": thread_obj.get("turns").and_then(Value::as_array).map(Vec::len),
        }
    });
    let thread_id = thread_obj
        .get("id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(requested_thread_id);
    let _ = trace_runtime_payload_summary(
        format!(
            "thread-read:{}:{}:{}:{}",
            workspace_target_label(workspace_target),
            home_override.unwrap_or_default(),
            include_turns,
            thread_id
        ),
        summary,
    );
}

#[cfg(test)]
fn clear_runtime_trace_cache_for_test() {
    let cache = runtime_trace_cache();
    let mut guard = match cache.lock() {
        Ok(guard) => guard,
        Err(err) => err.into_inner(),
    };
    guard.clear();
}

#[derive(Clone, Debug)]
pub(super) struct CodexSessionManager {
    workspace_target: Option<WorkspaceTarget>,
    home: Option<String>,
    terminal_bridge: Option<TerminalBridgeContext>,
}

#[derive(Clone, Debug)]
struct TerminalBridgeContext {
    server_port: u16,
    gateway_token: Option<String>,
}

#[derive(Clone, Debug)]
pub(super) struct TurnStartOutcome {
    pub(super) result: Value,
    pub(super) rollout_path: Option<String>,
}

#[derive(Clone, Debug)]
pub(super) struct ThreadStartOutcome {
    pub(super) result: Value,
    pub(super) runtime_response: Option<Value>,
    pub(super) rollout_path: Option<String>,
}

#[derive(Clone, Debug)]
pub(super) struct PendingEventsSnapshot {
    pub(super) approvals: Value,
    pub(super) user_inputs: Value,
}

#[derive(Clone, Debug)]
pub(super) struct ReplayNotificationBatch {
    pub(super) items: Vec<Value>,
    pub(super) requested_cursor: u64,
    pub(super) next_cursor: u64,
    pub(super) first_event_id: Option<u64>,
    pub(super) last_event_id: Option<u64>,
    pub(super) gap: bool,
    pub(super) reset: bool,
}

impl CodexSessionManager {
    pub(super) fn new(workspace_target: Option<WorkspaceTarget>) -> Self {
        let home = web_codex_rpc_home_override_for_target(workspace_target);
        ensure_workspace_runtime_registered(workspace_target, home.as_deref());
        Self {
            workspace_target,
            home,
            terminal_bridge: None,
        }
    }

    pub(super) fn with_terminal_bridge(
        mut self,
        server_port: u16,
        gateway_token: Option<String>,
    ) -> Self {
        self.terminal_bridge = Some(TerminalBridgeContext {
            server_port,
            gateway_token,
        });
        self
    }

    pub(super) fn with_home_override(mut self, home_override: Option<String>) -> Self {
        self.home = home_override
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        ensure_workspace_runtime_registered(self.workspace_target, self.home.as_deref());
        self
    }

    #[cfg(test)]
    pub(super) fn workspace_target(&self) -> Option<WorkspaceTarget> {
        self.workspace_target
    }

    pub(super) fn home_override(&self) -> Option<&str> {
        self.home.as_deref()
    }

    pub(super) async fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        crate::codex_app_server::request_in_home(self.home_override(), method, params).await
    }

    pub(super) async fn try_request_with_fallback(
        &self,
        methods: &[&str],
        params: Value,
    ) -> Result<Value, String> {
        super::codex_try_request_with_fallback_in_home(self.home_override(), methods, params).await
    }

    pub(super) async fn ensure_server(&self) -> Result<(), String> {
        crate::codex_app_server::ensure_server_in_home(self.home_override()).await?;
        mark_workspace_runtime_connected(self.workspace_target, self.home_override());
        Ok(())
    }

    pub(super) async fn replay_notifications_since(
        &self,
        cursor: u64,
        limit: usize,
    ) -> (Vec<Value>, Option<u64>, Option<u64>, bool) {
        let replayed = crate::codex_app_server::replay_notifications_since_in_home(
            self.home_override(),
            cursor,
            limit,
        )
        .await;
        mark_workspace_runtime_replay(
            self.workspace_target,
            self.home_override(),
            cursor,
            replayed.2,
        );
        replayed
    }

    pub(super) async fn replay_notification_batch(
        &self,
        cursor: u64,
        limit: usize,
        include_workspace: bool,
    ) -> ReplayNotificationBatch {
        let requested_cursor = cursor;
        let (mut items, first, last, gap) = self.replay_notifications_since(cursor, limit).await;
        let reset = should_reset_notification_cursor(cursor, first, last, gap);
        if reset {
            let replayed = self.replay_notifications_since(0, limit).await;
            items = replayed.0;
        }
        let mut next_cursor = if reset { 0 } else { cursor };
        for item in &mut items {
            if include_workspace {
                if let Some(target) = self.workspace_target {
                    inject_workspace_into_notification(item, target);
                }
            }
            if let Some(id) = item.get("eventId").and_then(Value::as_u64) {
                next_cursor = next_cursor.max(id);
            }
            record_notification_thread_state(self.workspace_target, self.home_override(), item);
            if let Some(target) = self.workspace_target {
                crate::orchestrator::gateway::web_codex_threads::upsert_thread_notification_hint(
                    target, item,
                );
            }
        }
        ReplayNotificationBatch {
            items,
            requested_cursor,
            next_cursor,
            first_event_id: first,
            last_event_id: last,
            gap,
            reset,
        }
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub(super) fn runtime_snapshot(&self) -> WorkspaceRuntimeSnapshot {
        workspace_runtime_snapshot(self.workspace_target, self.home_override())
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub(super) fn thread_runtime_snapshot(
        &self,
        thread_id: &str,
    ) -> Option<WorkspaceThreadRuntimeSnapshot> {
        workspace_thread_runtime_snapshot(self.workspace_target, self.home_override(), thread_id)
    }

    pub(super) async fn turn_start(
        &self,
        thread_id: &str,
        params: Value,
    ) -> Result<TurnStartOutcome, String> {
        let result = match self.request("turn/start", params.clone()).await {
            Ok(value) => value,
            Err(error) if sandbox_schema_retryable_error(&error) => self
                .request("turn/start", toggle_sandbox_schema(&params))
                .await
                .map_err(|retry_error| format!("{error}; retry failed: {retry_error}"))?,
            Err(error) => return Err(error),
        };
        let rollout_path = match self.workspace_target {
            Some(target) => {
                crate::orchestrator::gateway::web_codex_threads::known_rollout_path_for_thread(
                    target, thread_id,
                )
                .await
            }
            None => None,
        };
        record_started_turn_runtime(
            self.workspace_target,
            self.home_override(),
            thread_id,
            result
                .get("turn")
                .and_then(Value::as_object)
                .and_then(|turn| turn.get("id"))
                .and_then(Value::as_str)
                .or_else(|| result.get("turnId").and_then(Value::as_str))
                .or_else(|| result.get("turn_id").and_then(Value::as_str)),
            rollout_path.as_deref(),
        );
        Ok(TurnStartOutcome {
            result,
            rollout_path,
        })
    }

    pub(super) async fn thread_start(&self, params: Value) -> Result<ThreadStartOutcome, String> {
        if let (Some(bridge), Some(cwd)) = (
            self.terminal_bridge.as_ref(),
            thread_start_requested_cwd(&params),
        ) {
            let attached = crate::platform::codex_terminal_session::try_attach_live_session(
                bridge.server_port,
                bridge.gateway_token.as_deref(),
                self.workspace_target,
                &cwd,
            )
            .await?;
            if let Some(attached) = attached {
                let rollout_path = if let Some(path) = attached.rollout_path.clone() {
                    Some(path)
                } else if let Some(target) = self.workspace_target {
                    crate::orchestrator::gateway::web_codex_threads::known_rollout_path_for_thread(
                        target,
                        &attached.thread_id,
                    )
                    .await
                } else {
                    None
                };
                let runtime_response = Some(attached_runtime_thread_response(
                    self.workspace_target,
                    &crate::platform::codex_terminal_session::TerminalSessionAttachAck {
                        rollout_path: rollout_path.clone(),
                        ..attached.clone()
                    },
                ));
                let result = attached_thread_start_result(
                    self.workspace_target,
                    &crate::platform::codex_terminal_session::TerminalSessionAttachAck {
                        rollout_path: rollout_path.clone(),
                        ..attached.clone()
                    },
                );
                if let Some(runtime_value) = runtime_response.as_ref() {
                    record_runtime_thread_state(
                        self.workspace_target,
                        self.home_override(),
                        runtime_value,
                    );
                }
                return Ok(ThreadStartOutcome {
                    result,
                    runtime_response,
                    rollout_path,
                });
            }
        }

        let result = match self.request("thread/start", params.clone()).await {
            Ok(value) => value,
            Err(error) if sandbox_schema_retryable_error(&error) => self
                .request("thread/start", toggle_sandbox_schema(&params))
                .await
                .map_err(|retry_error| format!("{error}; retry failed: {retry_error}"))?,
            Err(error) => return Err(error),
        };
        let thread_id = thread_id_from_response(&result);
        let runtime_response = match thread_id.as_deref() {
            Some(thread_id) if self.workspace_target.is_some() => {
                self.read_thread(thread_id, false).await.ok()
            }
            _ => None,
        };
        let known_rollout_path = match (self.workspace_target, thread_id.as_deref()) {
            (Some(target), Some(thread_id)) => {
                crate::orchestrator::gateway::web_codex_threads::known_rollout_path_for_thread(
                    target, thread_id,
                )
                .await
            }
            _ => None,
        };
        let rollout_path = runtime_response
            .as_ref()
            .and_then(runtime_thread_path)
            .or_else(|| response_rollout_path(&result))
            .or(known_rollout_path);
        if let Some(runtime_value) = runtime_response.as_ref() {
            record_runtime_thread_state(self.workspace_target, self.home_override(), runtime_value);
        } else if self.workspace_target.is_some() {
            if let Some(thread_id) = thread_id.as_deref() {
                upsert_workspace_thread_runtime(
                    self.workspace_target,
                    self.home_override(),
                    WorkspaceThreadRuntimeUpdate {
                        thread_id,
                        cwd: result.get("cwd").and_then(Value::as_str),
                        rollout_path: rollout_path.as_deref(),
                        status: Some("queued"),
                        last_event_id: None,
                        last_turn_id: None,
                    },
                );
            }
        }
        Ok(ThreadStartOutcome {
            result,
            runtime_response,
            rollout_path,
        })
    }

    pub(super) async fn interrupt_turn(&self, turn_id: &str) -> Result<Value, String> {
        self.request("turn/interrupt", json!({ "turnId": turn_id }))
            .await
    }

    pub(super) async fn open_managed_terminal_surface(
        &self,
        thread_id: &str,
        cwd_override: Option<&str>,
    ) -> Result<crate::platform::codex_terminal_session::TerminalSessionAttachAck, String> {
        let requested_thread_id = thread_id.trim();
        if requested_thread_id.is_empty() {
            return Err("thread id is required".to_string());
        }
        let Some(workspace_target) = self.workspace_target else {
            return Err("workspace target is required".to_string());
        };
        let Some(bridge) = self.terminal_bridge.as_ref() else {
            return Err("terminal bridge is not configured".to_string());
        };

        self.ensure_server().await?;

        let cwd = cwd_override
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .or_else(|| {
                self.thread_runtime_snapshot(requested_thread_id)
                    .and_then(|snapshot| snapshot.cwd)
            });
        let Some(cwd) = cwd else {
            return Err("cwd is required to open managed terminal".to_string());
        };

        crate::platform::codex_managed_terminal::launch_managed_terminal_surface(
            &crate::platform::codex_managed_terminal::ManagedTerminalLaunchRequest {
                server_port: bridge.server_port,
                gateway_token: bridge.gateway_token.clone(),
                workspace_target,
                cwd: Some(cwd.clone()),
                home_override: self.home.clone(),
            },
        )?;

        let deadline = tokio::time::Instant::now()
            + std::time::Duration::from_millis(MANAGED_TERMINAL_DISCOVERY_TIMEOUT_MS);
        loop {
            if let Some(attached) =
                crate::platform::codex_terminal_session::try_attach_live_session(
                    bridge.server_port,
                    bridge.gateway_token.as_deref(),
                    self.workspace_target,
                    &cwd,
                )
                .await?
            {
                return Ok(attached);
            }
            if tokio::time::Instant::now() >= deadline {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(
                MANAGED_TERMINAL_DISCOVERY_POLL_MS,
            ))
            .await;
        }

        Err(format!(
            "managed terminal launch for thread {requested_thread_id} was not discovered"
        ))
    }

    pub(super) async fn read_thread(
        &self,
        thread_id: &str,
        include_turns: bool,
    ) -> Result<Value, String> {
        let value = self
            .request(
                "thread/read",
                json!({
                    "threadId": thread_id,
                    "includeTurns": include_turns
                }),
            )
            .await?;
        record_runtime_thread_state(self.workspace_target, self.home_override(), &value);
        trace_read_thread_runtime_summary(
            self.workspace_target,
            self.home_override(),
            thread_id,
            include_turns,
            &value,
        );
        Ok(value)
    }

    pub(super) async fn loaded_thread_ids(&self) -> Result<Vec<String>, String> {
        let value = self.request("thread/loaded/list", json!({})).await?;
        let loaded_ids = value
            .get("data")
            .and_then(Value::as_array)
            .or_else(|| value.as_array())
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|entry| entry.as_str().map(str::trim).map(str::to_string))
            .filter(|id| !id.is_empty())
            .collect::<Vec<_>>();
        trace_loaded_thread_ids_snapshot(self.workspace_target, self.home_override(), &loaded_ids);
        Ok(loaded_ids)
    }

    pub(super) async fn pending_events_snapshot(&self) -> PendingEventsSnapshot {
        let approvals = self
            .try_request_with_fallback(&["bridge/approvals/list", "approvals/list"], Value::Null)
            .await
            .unwrap_or_else(|error| unsupported_or_null_value(&error));
        let user_inputs = self
            .try_request_with_fallback(
                &[
                    "bridge/userInput/list",
                    "userInput/list",
                    "request_user_input/list",
                ],
                Value::Null,
            )
            .await
            .unwrap_or_else(|error| unsupported_or_null_value(&error));
        PendingEventsSnapshot {
            approvals,
            user_inputs,
        }
    }

    pub(super) async fn overlay_runtime_thread(
        &self,
        thread_id: &str,
        thread: &mut Value,
    ) -> Result<(), String> {
        let runtime_value = self.read_thread(thread_id, false).await?;
        merge_runtime_thread_overlay(thread, &runtime_value);
        Ok(())
    }

    pub(super) async fn read_thread_history_page_from_runtime(
        &self,
        thread_id: &str,
        before: Option<&str>,
        limit: usize,
        allow_empty_history_fallback: bool,
    ) -> Result<crate::orchestrator::gateway::web_codex_history::ThreadHistoryPage, String> {
        match self.read_thread(thread_id, true).await {
            Ok(runtime_value) => {
                runtime_thread_response_to_history_page(&runtime_value, before, limit)
            }
            Err(runtime_error) => {
                if !allow_empty_history_fallback
                    && !runtime_include_turns_error_allows_empty_history(&runtime_error)
                {
                    return Err(runtime_error);
                }
                let runtime_value =
                    self.read_thread(thread_id, false)
                        .await
                        .map_err(|runtime_read_error| {
                            format!(
                            "{runtime_error}; empty-history fallback failed: {runtime_read_error}"
                        )
                        })?;
                runtime_thread_response_to_history_page(&runtime_value, before, limit).map_err(
                    |runtime_page_error| {
                        format!(
                            "{runtime_error}; empty-history fallback failed: {runtime_page_error}"
                        )
                    },
                )
            }
        }
    }

    pub(super) async fn resume_thread(
        &self,
        thread_id: &str,
        params: Value,
        known_rollout_path: Option<&str>,
    ) -> Result<Value, String> {
        if let Some(rollout_path) = known_rollout_path {
            import_rollout_from_known_path(
                self.home_override(),
                thread_id,
                self.workspace_target,
                rollout_path,
            )
            .map_err(|import_error| format!("import failed: {import_error}"))?;
        }
        match resume_thread_once(self, &params).await {
            Ok(value) => Ok(value),
            Err(first_error) => {
                if sandbox_schema_retryable_error(&first_error) {
                    return resume_thread_once(self, &toggle_sandbox_schema(&params))
                        .await
                        .map_err(|retry_error| {
                            format!("{first_error}; retry failed: {retry_error}")
                        });
                }
                if !resume_error_looks_like_missing_rollout(&first_error) {
                    return Err(first_error);
                }

                if let Some(rollout_path) = known_rollout_path {
                    let imported = import_rollout_from_known_path(
                        self.home_override(),
                        thread_id,
                        self.workspace_target,
                        rollout_path,
                    )
                    .map_err(|import_error| {
                        format!("{first_error}; import failed: {import_error}")
                    })?;
                    if imported {
                        return resume_thread_once(self, &params).await;
                    }
                }

                for target in resume_import_order(self.workspace_target) {
                    let imported = import_rollout_into_target_home(target, thread_id).map_err(
                        |import_error| format!("{first_error}; import failed: {import_error}"),
                    )?;
                    if !imported {
                        continue;
                    }
                    let retry_manager = Self::new(Some(target));
                    return resume_thread_once(&retry_manager, &params).await;
                }

                Err(first_error)
            }
        }
    }
}

fn unsupported_or_null_value(error: &str) -> Value {
    if error
        .trim()
        .eq_ignore_ascii_case("all candidate rpc methods are marked unsupported")
    {
        json!([])
    } else {
        Value::Null
    }
}

async fn resume_thread_once(
    manager: &CodexSessionManager,
    params: &Value,
) -> Result<Value, String> {
    let value = manager.request("thread/resume", params.clone()).await?;
    record_runtime_thread_state(manager.workspace_target, manager.home_override(), &value);
    Ok(value)
}

fn read_non_empty_str(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

fn read_object_string_alias(map: &serde_json::Map<String, Value>, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| read_non_empty_str(map.get(*key)))
}

pub(super) fn thread_id_from_response(value: &Value) -> Option<String> {
    read_non_empty_str(value.get("id"))
        .or_else(|| read_non_empty_str(value.get("threadId")))
        .or_else(|| read_non_empty_str(value.get("thread_id")))
        .or_else(|| {
            value
                .get("thread")
                .and_then(Value::as_object)
                .and_then(|thread| read_non_empty_str(thread.get("id")))
        })
}

fn thread_start_requested_cwd(params: &Value) -> Option<String> {
    params
        .get("cwd")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn workspace_label(workspace_target: Option<WorkspaceTarget>) -> &'static str {
    match workspace_target {
        Some(WorkspaceTarget::Wsl2) => "wsl2",
        _ => "windows",
    }
}

pub(super) fn should_reset_notification_cursor(
    since_event_id: u64,
    first_event_id: Option<u64>,
    last_event_id: Option<u64>,
    gap: bool,
) -> bool {
    if gap {
        return true;
    }
    if since_event_id == 0 {
        return false;
    }
    match (first_event_id, last_event_id) {
        (None, None) => true,
        (_, Some(last)) => since_event_id > last,
        (Some(first), None) => since_event_id < first,
    }
}

fn inject_workspace_into_notification(notification: &mut Value, workspace_target: WorkspaceTarget) {
    let Some(map) = notification.as_object_mut() else {
        return;
    };
    let params = map.entry("params").or_insert_with(|| json!({}));
    let Some(params_obj) = params.as_object_mut() else {
        return;
    };
    params_obj
        .entry("workspace".to_string())
        .or_insert_with(|| json!(workspace_label(Some(workspace_target))));
}

fn record_started_turn_runtime(
    workspace_target: Option<WorkspaceTarget>,
    home_override: Option<&str>,
    thread_id: &str,
    turn_id: Option<&str>,
    rollout_path: Option<&str>,
) {
    if workspace_target.is_none() {
        return;
    }
    upsert_workspace_thread_runtime(
        workspace_target,
        home_override,
        WorkspaceThreadRuntimeUpdate {
            thread_id,
            cwd: None,
            rollout_path,
            status: Some("running"),
            last_event_id: None,
            last_turn_id: turn_id,
        },
    );
}

fn record_runtime_thread_state(
    workspace_target: Option<WorkspaceTarget>,
    home_override: Option<&str>,
    runtime_value: &Value,
) {
    if workspace_target.is_none() {
        return;
    }
    let Some(thread) = runtime_thread_payload(runtime_value).and_then(Value::as_object) else {
        return;
    };
    let Some(thread_id) = thread.get("id").and_then(Value::as_str) else {
        return;
    };
    let status = thread
        .get("status")
        .and_then(Value::as_object)
        .and_then(|status| status.get("type"))
        .and_then(Value::as_str);
    let last_turn_id = thread
        .get("turns")
        .and_then(Value::as_array)
        .and_then(|turns| turns.last())
        .and_then(|turn| turn.get("id"))
        .and_then(Value::as_str);
    upsert_workspace_thread_runtime(
        workspace_target,
        home_override,
        WorkspaceThreadRuntimeUpdate {
            thread_id,
            cwd: thread.get("cwd").and_then(Value::as_str),
            rollout_path: thread.get("path").and_then(Value::as_str),
            status,
            last_event_id: runtime_value.get("eventId").and_then(Value::as_u64),
            last_turn_id,
        },
    );
}

fn record_notification_thread_state(
    workspace_target: Option<WorkspaceTarget>,
    home_override: Option<&str>,
    notification: &Value,
) {
    if workspace_target.is_none() {
        return;
    }
    let params = notification
        .get("params")
        .and_then(Value::as_object)
        .or_else(|| notification.get("payload").and_then(Value::as_object));
    let direct_thread_id =
        params.and_then(|map| read_object_string_alias(map, &["threadId", "thread_id"]));
    let nested_payload = params
        .and_then(|map| map.get("payload").and_then(Value::as_object))
        .or_else(|| params.and_then(|map| map.get("item").and_then(Value::as_object)));
    let thread_id = direct_thread_id.or_else(|| {
        nested_payload
            .and_then(|payload| read_object_string_alias(payload, &["threadId", "thread_id"]))
    });
    let Some(thread_id) = thread_id.as_deref() else {
        return;
    };
    let method = notification
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_ascii_lowercase();
    let thread = params.and_then(|map| map.get("thread").and_then(Value::as_object));
    let rollout_path = params
        .and_then(|map| read_object_string_alias(map, &["rolloutPath", "rollout_path", "path"]))
        .or_else(|| thread.and_then(|map| read_object_string_alias(map, &["path"])));
    let cwd = params
        .and_then(|map| read_object_string_alias(map, &["cwd"]))
        .or_else(|| thread.and_then(|map| read_object_string_alias(map, &["cwd"])));
    let status = params
        .and_then(|map| read_object_string_alias(map, &["status"]))
        .or_else(|| {
            if method.contains("turn/started") {
                Some("running".to_string())
            } else if method.contains("turn/completed") || method.contains("turn/finished") {
                Some("completed".to_string())
            } else if method.contains("turn/failed") {
                Some("failed".to_string())
            } else if method.contains("turn/cancelled") {
                Some("interrupted".to_string())
            } else {
                None
            }
        });
    let last_turn_id = params
        .and_then(|map| read_object_string_alias(map, &["turnId", "turn_id"]))
        .or_else(|| thread.and_then(|map| read_object_string_alias(map, &["lastTurnId"])));
    upsert_workspace_thread_runtime(
        workspace_target,
        home_override,
        WorkspaceThreadRuntimeUpdate {
            thread_id,
            cwd: cwd.as_deref(),
            rollout_path: rollout_path.as_deref(),
            status: status.as_deref(),
            last_event_id: notification.get("eventId").and_then(Value::as_u64),
            last_turn_id: last_turn_id.as_deref(),
        },
    );
}

fn attached_thread_start_result(
    workspace_target: Option<WorkspaceTarget>,
    attached: &crate::platform::codex_terminal_session::TerminalSessionAttachAck,
) -> Value {
    let mut thread = serde_json::Map::from_iter([
        ("id".to_string(), Value::String(attached.thread_id.clone())),
        (
            "workspace".to_string(),
            Value::String(workspace_label(workspace_target).to_string()),
        ),
        ("status".to_string(), json!({ "type": "running" })),
    ]);
    if let Some(cwd) = attached.cwd.as_deref() {
        thread.insert("cwd".to_string(), Value::String(cwd.to_string()));
    }
    if let Some(path) = attached.rollout_path.as_deref() {
        thread.insert("path".to_string(), Value::String(path.to_string()));
    }

    let mut result = serde_json::Map::from_iter([
        ("id".to_string(), Value::String(attached.thread_id.clone())),
        (
            "transport".to_string(),
            Value::String("terminal-session".to_string()),
        ),
        ("attached".to_string(), Value::Bool(true)),
        ("thread".to_string(), Value::Object(thread)),
    ]);
    if let Some(cwd) = attached.cwd.as_deref() {
        result.insert("cwd".to_string(), Value::String(cwd.to_string()));
    }
    if let Some(path) = attached.rollout_path.as_deref() {
        result.insert("path".to_string(), Value::String(path.to_string()));
    }
    Value::Object(result)
}

fn attached_runtime_thread_response(
    workspace_target: Option<WorkspaceTarget>,
    attached: &crate::platform::codex_terminal_session::TerminalSessionAttachAck,
) -> Value {
    let mut thread = serde_json::Map::from_iter([
        ("id".to_string(), Value::String(attached.thread_id.clone())),
        (
            "workspace".to_string(),
            Value::String(workspace_label(workspace_target).to_string()),
        ),
        ("status".to_string(), json!({ "type": "running" })),
    ]);
    if let Some(cwd) = attached.cwd.as_deref() {
        thread.insert("cwd".to_string(), Value::String(cwd.to_string()));
    }
    if let Some(path) = attached.rollout_path.as_deref() {
        thread.insert("path".to_string(), Value::String(path.to_string()));
    }
    Value::Object(serde_json::Map::from_iter([(
        "thread".to_string(),
        Value::Object(thread),
    )]))
}

fn response_rollout_path(value: &Value) -> Option<String> {
    value
        .get("path")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .map(str::to_string)
        .or_else(|| {
            value
                .get("thread")
                .and_then(Value::as_object)
                .and_then(|thread| thread.get("path"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|path| !path.is_empty())
                .map(str::to_string)
        })
}

pub(super) fn runtime_thread_payload(value: &Value) -> Option<&Value> {
    value
        .get("thread")
        .or_else(|| value.get("data"))
        .or_else(|| value.get("id").and_then(Value::as_str).map(|_| value))
}

pub(super) fn runtime_thread_path(value: &Value) -> Option<String> {
    runtime_thread_payload(value)
        .and_then(Value::as_object)
        .and_then(|thread| thread.get("path").and_then(Value::as_str))
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .map(str::to_string)
}

pub(super) fn merge_runtime_thread_overlay(thread: &mut Value, runtime_value: &Value) {
    let (Some(thread_obj), Some(runtime_obj)) = (
        thread.as_object_mut(),
        runtime_thread_payload(runtime_value).and_then(Value::as_object),
    ) else {
        return;
    };
    let existing_path = thread_obj.get("path").and_then(Value::as_str);
    let runtime_path = runtime_obj.get("path").and_then(Value::as_str);
    let allow_runtime_rollout_override =
        runtime_path_should_override_existing(existing_path, runtime_path);
    for (target_key, source_key) in [
        ("status", "status"),
        ("model", "model"),
        ("modelProvider", "modelProvider"),
        ("base_url", "base_url"),
        ("base_url", "baseUrl"),
        ("base_url", "model_provider_base_url"),
        ("title", "title"),
        ("name", "name"),
    ] {
        if let Some(value) = runtime_obj.get(source_key) {
            thread_obj.insert(target_key.to_string(), value.clone());
        }
    }
    for (target_key, source_key) in [
        ("path", "path"),
        ("cwd", "cwd"),
        ("updatedAt", "updatedAt"),
        ("createdAt", "createdAt"),
    ] {
        if !allow_runtime_rollout_override {
            continue;
        }
        if let Some(value) = runtime_obj.get(source_key) {
            thread_obj.insert(target_key.to_string(), value.clone());
        }
    }
}

pub(super) fn overlay_runtime_thread_item(item: &mut Value, runtime_value: &Value) {
    merge_runtime_thread_overlay(item, runtime_value);
    let Some(item_obj) = item.as_object_mut() else {
        return;
    };
    let Some(thread_obj) = runtime_thread_payload(runtime_value).and_then(Value::as_object) else {
        return;
    };
    if let Some(metadata) = thread_obj.get("metadata").and_then(Value::as_object) {
        if let Some(value) = metadata.get("title").or_else(|| metadata.get("name")) {
            item_obj.insert("title".to_string(), value.clone());
        }
    }
}

pub(super) fn runtime_thread_response_to_history_page(
    value: &Value,
    before: Option<&str>,
    limit: usize,
) -> Result<crate::orchestrator::gateway::web_codex_history::ThreadHistoryPage, String> {
    let mut thread = runtime_thread_payload(value)
        .cloned()
        .ok_or_else(|| "thread/read missing thread payload".to_string())?;
    let Some(thread_obj) = thread.as_object_mut() else {
        return Err("thread/read returned non-object thread payload".to_string());
    };
    let turns = thread_obj
        .remove("turns")
        .and_then(|value| value.as_array().cloned())
        .unwrap_or_default();
    let normalized_limit =
        crate::orchestrator::gateway::web_codex_history::clamp_history_page_limit(limit);
    let page_end = before
        .map(str::trim)
        .filter(|cursor| !cursor.is_empty())
        .and_then(|cursor| {
            turns.iter().position(|turn| {
                turn.get("id").and_then(Value::as_str).map(str::trim) == Some(cursor)
            })
        })
        .unwrap_or(turns.len());
    let start = page_end.saturating_sub(normalized_limit);
    let page_turns = turns[start..page_end].to_vec();
    let before_cursor = if start > 0 {
        turns
            .get(start)
            .and_then(|turn| turn.get("id"))
            .cloned()
            .unwrap_or(Value::Null)
    } else {
        Value::Null
    };
    if !thread_obj.contains_key("rolloutPath") {
        if let Some(path) = thread_obj
            .get("path")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|path| !path.is_empty())
        {
            thread_obj.insert("rolloutPath".to_string(), Value::String(path.to_string()));
        }
    }
    thread_obj.insert("turns".to_string(), Value::Array(page_turns));
    let incomplete = thread_obj
        .get("status")
        .and_then(Value::as_object)
        .and_then(|status| status.get("type"))
        .and_then(Value::as_str)
        .map(str::trim)
        .map(|status| matches!(status, "running" | "queued" | "pending"))
        .unwrap_or(false)
        && page_end == turns.len();
    Ok(
        crate::orchestrator::gateway::web_codex_history::ThreadHistoryPage {
            thread,
            page: json!({
                "hasMore": start > 0,
                "beforeCursor": before_cursor,
                "limit": normalized_limit,
                "totalTurns": turns.len(),
                "incomplete": incomplete,
            }),
        },
    )
}

fn import_rollout_into_target_home(
    target: WorkspaceTarget,
    thread_id: &str,
) -> Result<bool, String> {
    match target {
        WorkspaceTarget::Windows => {
            let home = web_codex_rpc_home_override_for_target(Some(WorkspaceTarget::Windows));
            import_windows_rollout_into_codex_home(home.as_deref(), thread_id)
        }
        WorkspaceTarget::Wsl2 => {
            let home = web_codex_rpc_home_override_for_target(Some(WorkspaceTarget::Wsl2));
            import_wsl_rollout_into_codex_home(home.as_deref(), thread_id)
        }
    }
}

fn resume_error_looks_like_missing_rollout(error: &str) -> bool {
    let lower = error.to_ascii_lowercase();
    lower.contains("no rollout found") || lower.contains("thread id")
}

fn runtime_include_turns_error_allows_empty_history(detail: &str) -> bool {
    let lower = detail.to_ascii_lowercase();
    lower.contains("includeturns is unavailable before first user message")
        || lower.contains("not materialized yet")
}

#[cfg(test)]
#[allow(clippy::await_holding_lock)]
mod tests {
    use super::*;
    use crate::orchestrator::gateway::web_codex_home::parse_workspace_target;
    use crate::orchestrator::gateway::web_codex_session_runtime::_clear_workspace_runtime_registry_for_test;
    use crate::orchestrator::gateway::web_codex_threads::clear_threads_workspace_index_for_test;
    use serde_json::json;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };

    struct TestWebCodexHomeGuard {
        key: &'static str,
        previous: Option<String>,
        path: std::path::PathBuf,
    }

    impl Drop for TestWebCodexHomeGuard {
        fn drop(&mut self) {
            if let Some(previous) = self.previous.take() {
                unsafe {
                    std::env::set_var(self.key, previous);
                }
            } else {
                unsafe {
                    std::env::remove_var(self.key);
                }
            }
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    fn isolate_windows_web_codex_home() -> TestWebCodexHomeGuard {
        isolate_web_codex_home("API_ROUTER_WEB_CODEX_CODEX_HOME", "win")
    }

    fn isolate_wsl_web_codex_home() -> TestWebCodexHomeGuard {
        isolate_web_codex_home("API_ROUTER_WEB_CODEX_WSL_CODEX_HOME", "wsl")
    }

    fn isolate_user_data_dir() -> TestWebCodexHomeGuard {
        isolate_web_codex_home("API_ROUTER_USER_DATA_DIR", "user-data")
    }

    fn isolate_web_codex_home(key: &'static str, scope: &str) -> TestWebCodexHomeGuard {
        let previous = std::env::var(key).ok();
        let unique = format!(
            "api-router-web-codex-home-{scope}-{}-{}",
            std::process::id(),
            crate::orchestrator::store::unix_ms()
        );
        let path = std::env::temp_dir().join(unique);
        std::fs::create_dir_all(path.join("sessions")).expect("sessions dir");
        unsafe {
            std::env::set_var(key, &path);
        }
        TestWebCodexHomeGuard {
            key,
            previous,
            path,
        }
    }

    fn read_live_trace_lines() -> Vec<String> {
        let path = crate::orchestrator::gateway::web_codex_storage::codex_live_trace_file_path()
            .expect("live trace file path");
        std::fs::read_to_string(path)
            .expect("read live trace")
            .lines()
            .map(str::to_string)
            .collect()
    }

    #[test]
    fn session_manager_resolves_workspace_home_override() {
        let _guard = crate::codex_app_server::lock_test_globals();
        let _win_home = isolate_windows_web_codex_home();
        let _wsl_home = isolate_wsl_web_codex_home();
        _clear_workspace_runtime_registry_for_test();
        clear_threads_workspace_index_for_test();
        let windows = CodexSessionManager::new(parse_workspace_target("windows"));
        let wsl2 = CodexSessionManager::new(parse_workspace_target("wsl2"));
        assert_eq!(windows.workspace_target(), Some(WorkspaceTarget::Windows));
        assert_eq!(wsl2.workspace_target(), Some(WorkspaceTarget::Wsl2));
        assert_eq!(windows.runtime_snapshot().workspace_label, "windows");
        assert_eq!(wsl2.runtime_snapshot().workspace_label, "wsl2");
    }

    #[tokio::test]
    async fn turn_start_uses_workspace_scoped_request_home() {
        let _guard = crate::codex_app_server::lock_test_globals();
        let _home = isolate_windows_web_codex_home();
        _clear_workspace_runtime_registry_for_test();
        clear_threads_workspace_index_for_test();
        let calls = Arc::new(AtomicUsize::new(0));
        let calls_ref = calls.clone();
        crate::codex_app_server::_set_test_request_handler(Some(Arc::new(
            move |home, method, params| {
                assert!(home.is_some());
                match method {
                    "turn/start" => {
                        calls_ref.fetch_add(1, Ordering::SeqCst);
                        assert_eq!(
                            params.get("threadId").and_then(Value::as_str),
                            Some("thread-1")
                        );
                        Ok(json!({ "turnId": "turn-1" }))
                    }
                    "thread/loaded/list" => Ok(json!({ "data": [] })),
                    other => Err(format!("{other} should not be called")),
                }
            },
        )))
        .await;

        let manager = CodexSessionManager::new(parse_workspace_target("windows"));
        let outcome = manager
            .turn_start(
                "thread-1",
                json!({ "threadId": "thread-1", "workspace": "windows" }),
            )
            .await
            .expect("turn/start should succeed");

        assert_eq!(
            outcome.result.get("turnId").and_then(Value::as_str),
            Some("turn-1")
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);

        crate::codex_app_server::_set_test_request_handler(None).await;
    }

    #[test]
    fn sandbox_schema_toggle_flips_all_runtime_variants() {
        let params = json!({
            "sandbox": "workspaceWrite",
            "sandboxPolicy": { "type": "dangerFullAccess" }
        });
        let toggled = toggle_sandbox_schema(&params);
        assert_eq!(toggled["sandbox"], "workspace-write");
        assert_eq!(toggled["sandboxPolicy"]["type"], "danger-full-access");
    }

    #[test]
    fn sandbox_schema_retryable_error_detects_variant_mismatch() {
        assert!(sandbox_schema_retryable_error(
            "Invalid request: unknown variant `workspaceWrite`, expected one of `read-only`, `workspace-write`, `danger-full-access`"
        ));
        assert!(!sandbox_schema_retryable_error("something else entirely"));
    }

    #[tokio::test]
    async fn ensure_server_marks_workspace_runtime_connected() {
        let _guard = crate::codex_app_server::lock_test_globals();
        _clear_workspace_runtime_registry_for_test();
        clear_threads_workspace_index_for_test();
        crate::codex_app_server::_set_test_request_handler(Some(Arc::new(
            move |_home, method, _params| Err(format!("{method} should not be called")),
        )))
        .await;

        let manager = CodexSessionManager::new(parse_workspace_target("windows"));
        manager
            .ensure_server()
            .await
            .expect("ensure server should succeed in test mode");
        let snapshot = manager.runtime_snapshot();
        assert!(snapshot.connected);
        assert!(snapshot.connected_at_unix_secs.is_some());

        crate::codex_app_server::_set_test_request_handler(None).await;
    }

    #[tokio::test]
    async fn replay_notifications_updates_workspace_runtime_registry() {
        let _guard = crate::codex_app_server::lock_test_globals();
        let _home = isolate_windows_web_codex_home();
        _clear_workspace_runtime_registry_for_test();
        clear_threads_workspace_index_for_test();
        crate::codex_app_server::_clear_notifications_for_test().await;
        let home = web_codex_rpc_home_override_for_target(Some(WorkspaceTarget::Windows))
            .expect("isolated windows home");
        crate::codex_app_server::_push_notification_for_test(
            Some(home.as_str()),
            json!({"method":"turn/started","params":{"thread_id":"thread-1"}}),
        )
        .await;

        let manager = CodexSessionManager::new(parse_workspace_target("windows"));
        let (items, _first, last, _gap) = manager.replay_notifications_since(0, 16).await;
        assert_eq!(items.len(), 1);
        let snapshot = manager.runtime_snapshot();
        assert_eq!(snapshot.last_replay_cursor, 0);
        assert_eq!(snapshot.last_replay_last_event_id, last);
        assert!(snapshot.last_replay_at_unix_secs.is_some());

        crate::codex_app_server::_clear_notifications_for_test().await;
    }

    #[tokio::test]
    async fn replay_notification_batch_resets_cursor_and_injects_workspace() {
        let _guard = crate::codex_app_server::lock_test_globals();
        let _home = isolate_windows_web_codex_home();
        _clear_workspace_runtime_registry_for_test();
        clear_threads_workspace_index_for_test();
        crate::codex_app_server::_clear_notifications_for_test().await;
        let home = web_codex_rpc_home_override_for_target(Some(WorkspaceTarget::Windows))
            .expect("isolated windows home");
        crate::codex_app_server::_push_notification_for_test(
            Some(home.as_str()),
            json!({
                "eventId": 5,
                "method": "turn/started",
                "params": {
                    "thread_id": "thread-1"
                }
            }),
        )
        .await;

        let manager = CodexSessionManager::new(parse_workspace_target("windows"));
        let batch = manager.replay_notification_batch(999, 16, true).await;

        assert!(batch.reset);
        assert_eq!(batch.requested_cursor, 999);
        assert_eq!(batch.items.len(), 1);
        assert_eq!(
            batch.next_cursor,
            batch.items[0]
                .get("eventId")
                .and_then(Value::as_u64)
                .unwrap_or_default()
        );
        assert_eq!(
            batch.items[0]
                .get("params")
                .and_then(Value::as_object)
                .and_then(|params| params.get("workspace"))
                .and_then(Value::as_str),
            Some("windows")
        );
        let thread_snapshot = manager
            .thread_runtime_snapshot("thread-1")
            .expect("thread runtime snapshot");
        assert_eq!(thread_snapshot.thread_id, "thread-1");
        assert_eq!(thread_snapshot.status.as_deref(), Some("running"));
        assert_eq!(thread_snapshot.last_event_id, Some(batch.next_cursor));

        crate::codex_app_server::_clear_notifications_for_test().await;
    }

    #[tokio::test]
    async fn interrupt_turn_routes_through_manager_request_path() {
        let _guard = crate::codex_app_server::lock_test_globals();
        crate::codex_app_server::_set_test_request_handler(Some(Arc::new(
            move |_home, method, params| {
                assert_eq!(method, "turn/interrupt");
                assert_eq!(params, json!({ "turnId": "turn-9" }));
                Ok(json!({ "ok": true }))
            },
        )))
        .await;

        let manager = CodexSessionManager::new(None);
        let result = manager
            .interrupt_turn("turn-9")
            .await
            .expect("turn/interrupt should succeed");
        assert_eq!(result, json!({ "ok": true }));

        crate::codex_app_server::_set_test_request_handler(None).await;
    }

    #[tokio::test]
    async fn loaded_thread_ids_reads_workspace_scoped_loaded_list() {
        let _guard = crate::codex_app_server::lock_test_globals();
        let _home = isolate_windows_web_codex_home();
        crate::codex_app_server::_set_test_request_handler(Some(Arc::new(
            move |home, method, _params| {
                assert!(home.is_some());
                assert_eq!(method, "thread/loaded/list");
                Ok(json!({ "data": ["thread-1", "thread-2"] }))
            },
        )))
        .await;

        let manager = CodexSessionManager::new(parse_workspace_target("windows"));
        let loaded = manager
            .loaded_thread_ids()
            .await
            .expect("loaded thread list should succeed");

        assert_eq!(loaded, vec!["thread-1".to_string(), "thread-2".to_string()]);

        crate::codex_app_server::_set_test_request_handler(None).await;
    }

    #[tokio::test]
    async fn loaded_thread_ids_emits_trace_summary() {
        let _guard = crate::codex_app_server::lock_test_globals();
        let _home = isolate_windows_web_codex_home();
        let _user_data = isolate_user_data_dir();
        clear_runtime_trace_cache_for_test();
        crate::codex_app_server::_set_test_request_handler(Some(Arc::new(
            move |_home, method, _params| {
                assert_eq!(method, "thread/loaded/list");
                Ok(json!({ "data": ["thread-a", "thread-b"] }))
            },
        )))
        .await;

        let manager = CodexSessionManager::new(parse_workspace_target("windows"));
        let loaded = manager
            .loaded_thread_ids()
            .await
            .expect("loaded thread list should succeed");

        assert_eq!(loaded, vec!["thread-a".to_string(), "thread-b".to_string()]);
        let lines = read_live_trace_lines();
        assert!(lines.iter().any(|line| {
            line.contains("\"kind\":\"codex.session_manager.loaded_thread_ids\"")
                && line.contains("\"workspace\":\"windows\"")
                && line.contains("\"threadIds\":[\"thread-a\",\"thread-b\"]")
        }));

        crate::codex_app_server::_set_test_request_handler(None).await;
    }

    #[test]
    fn overlay_runtime_thread_item_copies_runtime_base_url() {
        let mut item = json!({
            "id": "thread-1",
            "workspace": "windows",
            "status": { "type": "notLoaded" }
        });

        overlay_runtime_thread_item(
            &mut item,
            &json!({
                "thread": {
                    "id": "thread-1",
                    "status": { "type": "running" },
                    "base_url": "http://127.0.0.1:4000/v1"
                }
            }),
        );

        assert_eq!(
            item.get("base_url").and_then(Value::as_str),
            Some("http://127.0.0.1:4000/v1")
        );
    }

    #[tokio::test]
    async fn read_thread_history_page_from_runtime_uses_empty_history_fallback_for_new_thread() {
        let _guard = crate::codex_app_server::lock_test_globals();
        crate::codex_app_server::_set_test_request_handler(Some(Arc::new(
            move |_home, method, params| {
                assert_eq!(method, "thread/read");
                if params
                    .get("includeTurns")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                {
                    return Err(
                        "thread abc is not materialized yet; includeTurns is unavailable before first user message"
                            .to_string(),
                    );
                }
                Ok(json!({
                    "thread": {
                        "id": "thread-1",
                        "path": "C:\\temp\\rollout.jsonl",
                        "status": { "type": "queued" }
                    }
                }))
            },
        )))
        .await;

        let manager = CodexSessionManager::new(parse_workspace_target("windows"));
        let page = manager
            .read_thread_history_page_from_runtime("thread-1", None, 20, false)
            .await
            .expect("runtime history page should use empty fallback");

        assert_eq!(page.thread["id"].as_str(), Some("thread-1"));
        assert_eq!(
            page.thread["rolloutPath"].as_str(),
            Some("C:\\temp\\rollout.jsonl")
        );
        assert_eq!(page.page["incomplete"].as_bool(), Some(true));

        crate::codex_app_server::_set_test_request_handler(None).await;
    }

    #[tokio::test]
    async fn read_thread_emits_trace_summary_with_base_url() {
        let _guard = crate::codex_app_server::lock_test_globals();
        let _home = isolate_windows_web_codex_home();
        let _user_data = isolate_user_data_dir();
        clear_runtime_trace_cache_for_test();
        crate::codex_app_server::_set_test_request_handler(Some(Arc::new(
            move |_home, method, params| {
                assert_eq!(method, "thread/read");
                assert_eq!(
                    params.get("threadId").and_then(Value::as_str),
                    Some("thread-1")
                );
                Ok(json!({
                    "thread": {
                        "id": "thread-1",
                        "status": { "type": "idle" },
                        "base_url": "http://127.0.0.1:4000/v1",
                        "path": "C:\\repo\\.codex\\sessions\\rollout-thread-1.jsonl"
                    }
                }))
            },
        )))
        .await;

        let manager = CodexSessionManager::new(parse_workspace_target("windows"));
        let value = manager
            .read_thread("thread-1", false)
            .await
            .expect("thread/read should succeed");

        assert_eq!(
            runtime_thread_payload(&value)
                .and_then(|thread| thread.get("base_url"))
                .and_then(Value::as_str),
            Some("http://127.0.0.1:4000/v1")
        );
        let lines = read_live_trace_lines();
        assert!(lines.iter().any(|line| {
            line.contains("\"kind\":\"codex.session_manager.thread_read\"")
                && line.contains("\"threadId\":\"thread-1\"")
                && line.contains("\"statusType\":\"idle\"")
                && line.contains("\"hasBaseUrl\":true")
                && line.contains("\"baseUrl\":\"http://127.0.0.1:4000/v1\"")
        }));

        crate::codex_app_server::_set_test_request_handler(None).await;
    }

    #[tokio::test]
    async fn thread_start_registers_canonical_runtime_for_new_web_thread() {
        let _guard = crate::codex_app_server::lock_test_globals();
        _clear_workspace_runtime_registry_for_test();
        clear_threads_workspace_index_for_test();
        crate::codex_app_server::_set_test_request_handler(Some(Arc::new(
            move |_home, method, params| match method {
                "thread/start" => {
                    assert_eq!(
                        params.get("workspace").and_then(Value::as_str),
                        Some("windows")
                    );
                    assert_eq!(params.get("cwd").and_then(Value::as_str), Some("C:\\repo"));
                    Ok(json!({
                        "threadId": "thread-web",
                        "cwd": "C:\\repo",
                        "thread": {
                            "id": "thread-web",
                            "path": "C:\\repo\\.codex\\sessions\\rollout-thread-web.jsonl",
                        }
                    }))
                }
                "thread/read" => Err("thread not materialized yet".to_string()),
                other => Err(format!("{other} should not be called")),
            },
        )))
        .await;

        let manager = CodexSessionManager::new(parse_workspace_target("windows"));
        let outcome = manager
            .thread_start(json!({
                "workspace": "windows",
                "cwd": "C:\\repo"
            }))
            .await
            .expect("thread/start should register canonical runtime");

        assert_eq!(
            outcome.result.get("threadId").and_then(Value::as_str),
            Some("thread-web")
        );
        assert_eq!(
            outcome.rollout_path.as_deref(),
            Some("C:\\repo\\.codex\\sessions\\rollout-thread-web.jsonl")
        );

        let snapshot = manager
            .thread_runtime_snapshot("thread-web")
            .expect("thread runtime snapshot");
        assert_eq!(snapshot.thread_id, "thread-web");
        assert_eq!(snapshot.cwd.as_deref(), Some("C:\\repo"));
        assert_eq!(
            snapshot.rollout_path.as_deref(),
            Some("C:\\repo\\.codex\\sessions\\rollout-thread-web.jsonl")
        );
        assert_eq!(snapshot.status.as_deref(), Some("queued"));

        let known_path =
            crate::orchestrator::gateway::web_codex_threads::known_rollout_path_for_thread(
                WorkspaceTarget::Windows,
                "thread-web",
            )
            .await;
        assert_eq!(
            known_path.as_deref(),
            Some("C:\\repo\\.codex\\sessions\\rollout-thread-web.jsonl")
        );

        crate::codex_app_server::_set_test_request_handler(None).await;
    }

    #[tokio::test]
    async fn thread_start_attaches_matching_live_terminal_session_before_app_server() {
        let _guard = crate::codex_app_server::lock_test_globals();
        crate::platform::codex_terminal_session::_set_test_discovery_sessions(Some(vec![
            crate::platform::windows_terminal::InferredWtSession {
                wt_session: "wt-1".to_string(),
                pid: 42,
                linux_pid: None,
                wsl_distro: None,
                cwd: Some("C:\\repo".to_string()),
                rollout_path: Some(
                    "C:\\repo\\.codex\\sessions\\rollout-thread-live.jsonl".to_string(),
                ),
                codex_session_id: Some("thread-live".to_string()),
                reported_model_provider: None,
                reported_base_url: None,
                agent_parent_session_id: None,
                router_confirmed: true,
                is_agent: false,
                is_review: false,
            },
        ]));
        crate::codex_app_server::_set_test_request_handler(Some(Arc::new(
            move |_home, method, _params| Err(format!("{method} should not be called")),
        )))
        .await;

        let manager = CodexSessionManager::new(parse_workspace_target("windows"))
            .with_terminal_bridge(4000, Some("token".to_string()));
        let outcome = manager
            .thread_start(json!({
                "workspace": "windows",
                "cwd": "C:\\repo"
            }))
            .await
            .expect("thread/start should attach to live terminal session");

        assert_eq!(
            outcome.result.get("transport").and_then(Value::as_str),
            Some("terminal-session")
        );
        assert_eq!(
            outcome.result.get("id").and_then(Value::as_str),
            Some("thread-live")
        );
        assert_eq!(
            outcome.rollout_path.as_deref(),
            Some("C:\\repo\\.codex\\sessions\\rollout-thread-live.jsonl")
        );

        crate::platform::codex_terminal_session::_set_test_discovery_sessions(None);
        crate::codex_app_server::_set_test_request_handler(None).await;
    }

    #[tokio::test]
    async fn thread_start_can_attach_non_router_terminal_session_by_cwd() {
        let _guard = crate::codex_app_server::lock_test_globals();
        crate::platform::codex_terminal_session::_set_test_discovery_sessions(Some(vec![
            crate::platform::windows_terminal::InferredWtSession {
                wt_session: "wt-1".to_string(),
                pid: 42,
                linux_pid: None,
                wsl_distro: None,
                cwd: Some("C:\\repo".to_string()),
                rollout_path: Some(
                    "C:\\repo\\.codex\\sessions\\rollout-thread-plain.jsonl".to_string(),
                ),
                codex_session_id: Some("thread-plain".to_string()),
                reported_model_provider: None,
                reported_base_url: None,
                agent_parent_session_id: None,
                router_confirmed: false,
                is_agent: false,
                is_review: false,
            },
        ]));
        crate::codex_app_server::_set_test_request_handler(Some(Arc::new(
            move |_home, method, _params| Err(format!("{method} should not be called")),
        )))
        .await;

        let manager = CodexSessionManager::new(parse_workspace_target("windows"))
            .with_terminal_bridge(4000, Some("token".to_string()));
        let outcome = manager
            .thread_start(json!({
                "workspace": "windows",
                "cwd": "C:\\repo"
            }))
            .await
            .expect("thread/start should attach to non-router live terminal session");

        assert_eq!(
            outcome.result.get("transport").and_then(Value::as_str),
            Some("terminal-session")
        );
        assert_eq!(
            outcome.result.get("id").and_then(Value::as_str),
            Some("thread-plain")
        );

        crate::platform::codex_terminal_session::_set_test_discovery_sessions(None);
        crate::codex_app_server::_set_test_request_handler(None).await;
    }

    #[tokio::test]
    async fn open_managed_terminal_surface_discovers_remote_terminal_by_cwd() {
        let _guard = crate::codex_app_server::lock_test_globals();
        _clear_workspace_runtime_registry_for_test();
        clear_threads_workspace_index_for_test();
        crate::platform::codex_terminal_session::_set_test_discovery_sessions(None);
        crate::codex_app_server::_set_test_request_handler(Some(Arc::new(
            move |_home, method, _params| Err(format!("{method} should not be called")),
        )))
        .await;

        let captured = Arc::new(std::sync::Mutex::new(None));
        let captured_ref = captured.clone();
        crate::platform::codex_managed_terminal::_set_test_launch_handler(Some(Arc::new(
            move |spec| {
                if let Ok(mut guard) = captured_ref.lock() {
                    *guard = Some(spec.clone());
                }
                crate::platform::codex_terminal_session::_set_test_discovery_sessions(Some(vec![
                    crate::platform::windows_terminal::InferredWtSession {
                        wt_session: "wt-managed".to_string(),
                        pid: 4242,
                        linux_pid: None,
                        wsl_distro: None,
                        cwd: Some("C:\\repo".to_string()),
                        rollout_path: Some(
                            "C:\\repo\\.codex\\sessions\\rollout-thread-terminal.jsonl".to_string(),
                        ),
                        codex_session_id: Some("thread-terminal".to_string()),
                        reported_model_provider: None,
                        reported_base_url: None,
                        agent_parent_session_id: None,
                        router_confirmed: true,
                        is_agent: false,
                        is_review: false,
                    },
                ]));
                Ok(())
            },
        )));

        let manager = CodexSessionManager::new(parse_workspace_target("windows"))
            .with_terminal_bridge(4000, Some("token-1".to_string()));
        let attached = manager
            .open_managed_terminal_surface("thread-web", Some("C:\\repo"))
            .await
            .expect("managed terminal surface should be discovered");

        assert_eq!(attached.thread_id, "thread-terminal");
        assert_eq!(attached.cwd.as_deref(), Some("C:\\repo"));
        assert_eq!(
            attached.rollout_path.as_deref(),
            Some("C:\\repo\\.codex\\sessions\\rollout-thread-terminal.jsonl")
        );

        let spec = captured
            .lock()
            .ok()
            .and_then(|guard| guard.clone())
            .expect("captured launch spec");
        assert_eq!(spec.program, "powershell.exe");
        assert_eq!(spec.args.first().map(String::as_str), Some("-NoLogo"));
        assert!(spec.args.iter().any(|arg| arg == "-NoExit"));
        assert!(spec.args.iter().any(|arg| arg.contains("codex.cmd")));
        assert!(!spec.args.iter().any(|arg| arg.contains("thread-web")));
        assert!(!spec.args.iter().any(|arg| arg.contains("thread-terminal")));
        assert!(spec
            .args
            .iter()
            .any(|arg| arg.contains("ws://127.0.0.1:4000/")));
        assert!(spec
            .args
            .iter()
            .any(|arg| arg.contains("--remote-auth-token-env")));
        assert!(spec
            .env
            .iter()
            .any(|(key, value)| { key == "API_ROUTER_GATEWAY_TOKEN" && value == "token-1" }));

        crate::platform::codex_managed_terminal::_set_test_launch_handler(None);
        crate::platform::codex_terminal_session::_set_test_discovery_sessions(None);
        crate::codex_app_server::_set_test_request_handler(None).await;
    }
}
