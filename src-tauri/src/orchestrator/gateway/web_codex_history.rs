#[cfg(target_os = "windows")]
use super::web_codex_home::{linux_path_to_unc, resolve_wsl_identity};
use super::web_codex_home::{parse_wsl_unc_to_linux_path, WorkspaceTarget};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

mod cache;
mod parser;
mod wsl_index;

use self::cache::load_cached_rollout_history;
#[cfg(test)]
use self::parser::{history_parse_count_for_path, reset_history_parse_counter};
use self::parser::{
    history_turn_to_value, parse_rollout_history, HistoryTurn, ParsedRolloutHistory,
};
use self::wsl_index::load_wsl_history_page;

const DEFAULT_HISTORY_PAGE_LIMIT: usize = 60;
const MAX_HISTORY_PAGE_LIMIT: usize = 240;

pub(super) struct ThreadHistoryPage {
    pub(super) thread: Value,
    pub(super) page: Value,
}

fn ensure_history_thread_path(thread: &mut Value) {
    let Some(thread_obj) = thread.as_object_mut() else {
        return;
    };
    let has_path = thread_obj
        .get("path")
        .and_then(Value::as_str)
        .map(str::trim)
        .is_some_and(|value| !value.is_empty());
    if has_path {
        return;
    }
    let Some(rollout_path) = thread_obj
        .get("rolloutPath")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return;
    };
    thread_obj.insert("path".to_string(), Value::String(rollout_path.to_string()));
}

struct BuildThreadHistoryPageInput<'a> {
    thread_id: &'a str,
    workspace_value: Option<&'a str>,
    rollout_path: &'a str,
    turns: &'a [HistoryTurn],
    token_usage: Option<&'a Value>,
    incomplete: bool,
    before: Option<&'a str>,
    normalized_limit: usize,
}

struct ResolvedRolloutPath {
    local_path: PathBuf,
    #[cfg_attr(not(test), allow(dead_code))]
    linux_path: Option<String>,
}

#[cfg(test)]
type TestHistoryLoader = std::sync::Arc<
    dyn Fn(
            String,
            Option<WorkspaceTarget>,
            Option<String>,
            Option<String>,
            usize,
        ) -> Result<ThreadHistoryPage, String>
        + Send
        + Sync,
>;

#[cfg(test)]
fn test_history_loader() -> &'static std::sync::Mutex<Option<TestHistoryLoader>> {
    static LOADER: std::sync::OnceLock<std::sync::Mutex<Option<TestHistoryLoader>>> =
        std::sync::OnceLock::new();
    LOADER.get_or_init(|| std::sync::Mutex::new(None))
}

#[cfg(test)]
pub(super) fn _set_test_history_loader(loader: Option<TestHistoryLoader>) {
    match test_history_loader().lock() {
        Ok(mut guard) => *guard = loader,
        Err(err) => *err.into_inner() = loader,
    }
}

#[cfg(test)]
fn should_use_test_history_loader(thread_id: &str, rollout_path: Option<&str>) -> bool {
    thread_id == "test-thread"
        && rollout_path
            .map(str::trim)
            .is_some_and(|value| value.eq_ignore_ascii_case(r"C:\temp\test.jsonl"))
}

pub(super) fn default_history_page_limit() -> usize {
    DEFAULT_HISTORY_PAGE_LIMIT
}

pub(super) fn clamp_history_page_limit(limit: usize) -> usize {
    limit.clamp(1, MAX_HISTORY_PAGE_LIMIT)
}

fn should_prefer_wsl_linux_loader(
    workspace: Option<WorkspaceTarget>,
    linux_rollout_path: Option<&str>,
) -> bool {
    matches!(workspace, Some(WorkspaceTarget::Wsl2))
        && linux_rollout_path
            .map(str::trim)
            .is_some_and(|value| !value.is_empty())
}

pub(super) fn spawn_wsl_history_prewarm(items: &[Value]) {
    self::wsl_index::spawn_wsl_history_prewarm(items);
}

pub(super) fn load_thread_history_page(
    thread_id: &str,
    workspace: Option<WorkspaceTarget>,
    rollout_path: Option<&str>,
    before: Option<&str>,
    limit: usize,
) -> Result<ThreadHistoryPage, String> {
    #[cfg(test)]
    if should_use_test_history_loader(thread_id, rollout_path) {
        if let Some(loader) = match test_history_loader().lock() {
            Ok(guard) => guard.clone(),
            Err(err) => err.into_inner().clone(),
        } {
            return loader(
                thread_id.to_string(),
                workspace,
                rollout_path.map(str::to_string),
                before.map(str::to_string),
                limit,
            );
        }
    }
    load_thread_history_page_impl(thread_id, workspace, rollout_path, before, limit)
}

fn load_thread_history_page_impl(
    thread_id: &str,
    workspace: Option<WorkspaceTarget>,
    rollout_path: Option<&str>,
    before: Option<&str>,
    limit: usize,
) -> Result<ThreadHistoryPage, String> {
    let raw_rollout_path = rollout_path
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "missing rollout path".to_string())?;
    let resolved = resolve_rollout_path(workspace, raw_rollout_path)?;
    let normalized_limit = clamp_history_page_limit(limit);
    let workspace_value = match workspace {
        Some(WorkspaceTarget::Windows) => Some("windows"),
        Some(WorkspaceTarget::Wsl2) => Some("wsl2"),
        None => None,
    };
    if should_prefer_wsl_linux_loader(workspace, resolved.linux_path.as_deref()) {
        if let Some(linux_rollout_path) = resolved.linux_path.as_deref() {
            return load_wsl_history_page(
                thread_id,
                workspace_value,
                raw_rollout_path,
                &resolved.local_path,
                linux_rollout_path,
                before,
                normalized_limit,
            );
        }
    }
    if matches!(workspace, Some(WorkspaceTarget::Wsl2)) && resolved.local_path.exists() {
        let parsed = load_cached_rollout_history(&resolved.local_path)?;
        let page = build_thread_history_page(BuildThreadHistoryPageInput {
            thread_id,
            workspace_value,
            rollout_path: raw_rollout_path,
            turns: parsed.turns.as_slice(),
            token_usage: parsed.token_usage.as_ref(),
            incomplete: parsed.incomplete,
            before,
            normalized_limit,
        })?;
        return Ok(page);
    }
    let parsed = load_cached_rollout_history(&resolved.local_path)?;
    let page = build_thread_history_page(BuildThreadHistoryPageInput {
        thread_id,
        workspace_value,
        rollout_path: raw_rollout_path,
        turns: parsed.turns.as_slice(),
        token_usage: parsed.token_usage.as_ref(),
        incomplete: parsed.incomplete,
        before,
        normalized_limit,
    })?;
    Ok(page)
}

fn build_thread_history_page(
    input: BuildThreadHistoryPageInput<'_>,
) -> Result<ThreadHistoryPage, String> {
    let BuildThreadHistoryPageInput {
        thread_id,
        workspace_value,
        rollout_path,
        turns,
        token_usage,
        incomplete,
        before,
        normalized_limit,
    } = input;
    let page_end = before
        .and_then(|cursor| {
            turns
                .iter()
                .position(|turn| turn.id == cursor.trim())
                .or_else(|| {
                    turns
                        .iter()
                        .position(|turn| turn.id == format!("history-turn-{}", cursor.trim()))
                })
        })
        .unwrap_or(turns.len());
    let start = page_end.saturating_sub(normalized_limit);
    let page_turns = turns[start..page_end]
        .iter()
        .map(history_turn_to_value)
        .collect::<Vec<_>>();
    let before_cursor = if start > 0 {
        turns
            .get(start)
            .map(|turn| turn.id.clone())
            .map(Value::String)
            .unwrap_or(Value::Null)
    } else {
        Value::Null
    };
    let mut thread = json!({
        "id": thread_id,
        "workspace": workspace_value,
        "path": rollout_path,
        "rolloutPath": rollout_path,
        "turns": page_turns,
        "tokenUsage": token_usage.cloned().unwrap_or(Value::Null),
    });
    ensure_history_thread_path(&mut thread);
    Ok(ThreadHistoryPage {
        thread,
        page: json!({
            "hasMore": start > 0,
            "beforeCursor": before_cursor,
            "limit": normalized_limit,
            "totalTurns": turns.len(),
            "incomplete": incomplete && page_end == turns.len(),
        }),
    })
}

fn resolve_rollout_path(
    workspace: Option<WorkspaceTarget>,
    rollout_path: &str,
) -> Result<ResolvedRolloutPath, String> {
    let trimmed = rollout_path.trim();
    if trimmed.is_empty() {
        return Err("missing rollout path".to_string());
    }
    match workspace {
        Some(WorkspaceTarget::Wsl2) => {
            if let Some(linux_path) = parse_wsl_unc_to_linux_path(trimmed) {
                #[cfg(target_os = "windows")]
                let local_path = {
                    let (distro, _) = resolve_wsl_identity()?;
                    linux_path_to_unc(&linux_path, &distro)
                };
                #[cfg(not(target_os = "windows"))]
                let local_path = Path::new(trimmed).to_path_buf();
                return Ok(ResolvedRolloutPath {
                    local_path,
                    linux_path: Some(linux_path),
                });
            }
            let linux_path = trimmed.replace('\\', "/");
            #[cfg(target_os = "windows")]
            let local_path = {
                let (distro, _) = resolve_wsl_identity()?;
                linux_path_to_unc(trimmed, &distro)
            };
            #[cfg(not(target_os = "windows"))]
            let local_path = Path::new(trimmed).to_path_buf();
            Ok(ResolvedRolloutPath {
                local_path,
                linux_path: Some(linux_path),
            })
        }
        _ => Ok(ResolvedRolloutPath {
            local_path: Path::new(trimmed).to_path_buf(),
            linux_path: None,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::cache::_clear_history_turns_cache_for_test;
    use super::load_thread_history_page;
    use super::resolve_rollout_path;
    use super::wsl_index::_set_test_wsl_history_loader;
    use super::{
        history_parse_count_for_path, reset_history_parse_counter, should_prefer_wsl_linux_loader,
    };
    use crate::orchestrator::gateway::web_codex_home::WorkspaceTarget;
    use std::io::Write;

    struct EnvGuard {
        key: &'static str,
        prev: Option<String>,
    }

    impl EnvGuard {
        fn set(key: &'static str, value: &str) -> Self {
            let prev = std::env::var(key).ok();
            std::env::set_var(key, value);
            Self { key, prev }
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            if let Some(prev) = self.prev.as_deref() {
                std::env::set_var(self.key, prev);
            } else {
                std::env::remove_var(self.key);
            }
        }
    }

    fn write_rollout(lines: &[&str]) -> tempfile::NamedTempFile {
        let mut file = tempfile::NamedTempFile::new().expect("temp rollout");
        for line in lines {
            writeln!(file, "{line}").expect("write rollout line");
        }
        file
    }

    #[test]
    fn history_page_keeps_assistant_messages_after_compaction() {
        let rollout = write_rollout(&[
            r#"{"type":"session_meta","payload":{"id":"thread-1"}}"#,
            r#"{"type":"event_msg","payload":{"type":"user_message","message":"hello","images":[],"local_images":[],"text_elements":[]}}"#,
            r#"{"type":"event_msg","payload":{"type":"agent_message","message":"hi there"}}"#,
            r#"{"type":"compacted","payload":{"message":"summary only","replacement_history":[{"type":"message","role":"user","content":[{"type":"input_text","text":"summary user only"}]}]}}"#,
            r#"{"type":"event_msg","payload":{"type":"context_compacted"}}"#,
            r#"{"type":"event_msg","payload":{"type":"user_message","message":"next","images":[],"local_images":[],"text_elements":[]}}"#,
            r#"{"type":"event_msg","payload":{"type":"agent_message","message":"done"}}"#,
        ]);
        let result = load_thread_history_page(
            "thread-1",
            Some(WorkspaceTarget::Windows),
            Some(&rollout.path().to_string_lossy()),
            None,
            10,
        )
        .expect("history page");

        let turns = result
            .thread
            .get("turns")
            .and_then(|v| v.as_array())
            .expect("turns array");
        assert_eq!(turns.len(), 2);
        assert_eq!(
            turns[0]["items"][1]["text"].as_str(),
            Some("hi there"),
            "compaction must not erase earlier assistant turns"
        );
        assert_eq!(result.page["hasMore"].as_bool(), Some(false));
    }

    #[test]
    fn history_page_sets_thread_path_to_live_rollout_path() {
        let rollout = write_rollout(&[
            r#"{"type":"session_meta","payload":{"id":"thread-path"}}"#,
            r#"{"type":"event_msg","payload":{"type":"user_message","message":"hello","images":[],"local_images":[],"text_elements":[]}}"#,
        ]);
        let rollout_path = rollout.path().to_string_lossy().to_string();
        let result = load_thread_history_page(
            "thread-path",
            Some(WorkspaceTarget::Windows),
            Some(&rollout_path),
            None,
            10,
        )
        .expect("history page");

        assert_eq!(
            result.thread["rolloutPath"].as_str(),
            Some(rollout_path.as_str())
        );
        assert_eq!(result.thread["path"].as_str(), Some(rollout_path.as_str()));
    }

    #[test]
    fn history_page_applies_thread_rollback_before_paging() {
        let rollout = write_rollout(&[
            r#"{"type":"session_meta","payload":{"id":"thread-2"}}"#,
            r#"{"type":"event_msg","payload":{"type":"user_message","message":"one","images":[],"local_images":[],"text_elements":[]}}"#,
            r#"{"type":"event_msg","payload":{"type":"agent_message","message":"reply one"}}"#,
            r#"{"type":"event_msg","payload":{"type":"user_message","message":"two","images":[],"local_images":[],"text_elements":[]}}"#,
            r#"{"type":"event_msg","payload":{"type":"agent_message","message":"reply two"}}"#,
            r#"{"type":"event_msg","payload":{"type":"thread_rolled_back","num_turns":1}}"#,
            r#"{"type":"event_msg","payload":{"type":"user_message","message":"three","images":[],"local_images":[],"text_elements":[]}}"#,
            r#"{"type":"event_msg","payload":{"type":"agent_message","message":"reply three"}}"#,
        ]);
        let result = load_thread_history_page(
            "thread-2",
            Some(WorkspaceTarget::Windows),
            Some(&rollout.path().to_string_lossy()),
            None,
            1,
        )
        .expect("history page");
        let turns = result
            .thread
            .get("turns")
            .and_then(|v| v.as_array())
            .expect("turns array");
        assert_eq!(turns.len(), 1);
        assert_eq!(
            turns[0]["items"][0]["content"][0]["text"].as_str(),
            Some("three")
        );
        assert_eq!(result.page["hasMore"].as_bool(), Some(true));
        let before = result.page["beforeCursor"].as_str().expect("before cursor");
        let older = load_thread_history_page(
            "thread-2",
            Some(WorkspaceTarget::Windows),
            Some(&rollout.path().to_string_lossy()),
            Some(before),
            1,
        )
        .expect("older page");
        let older_turns = older
            .thread
            .get("turns")
            .and_then(|v| v.as_array())
            .expect("older turns");
        assert_eq!(older_turns.len(), 1);
        assert_eq!(
            older_turns[0]["items"][0]["content"][0]["text"].as_str(),
            Some("one")
        );
        assert_eq!(older.page["hasMore"].as_bool(), Some(false));
    }

    #[test]
    fn history_page_includes_latest_token_usage_snapshot() {
        _clear_history_turns_cache_for_test();
        let rollout = write_rollout(&[
            r#"{"type":"session_meta","payload":{"id":"thread-token-usage"}}"#,
            r#"{"type":"event_msg","payload":{"type":"token_count","info":null}}"#,
            r#"{"type":"event_msg","payload":{"type":"user_message","message":"hello","images":[],"local_images":[],"text_elements":[]}}"#,
            r#"{"type":"event_msg","payload":{"type":"agent_message","message":"world"}}"#,
            r#"{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":2048,"cached_input_tokens":512,"output_tokens":128,"reasoning_output_tokens":64,"total_tokens":2176},"last_token_usage":{"input_tokens":48,"cached_input_tokens":0,"output_tokens":16,"reasoning_output_tokens":8,"total_tokens":64},"model_context_window":32768}}}"#,
        ]);
        let result = load_thread_history_page(
            "thread-token-usage",
            Some(WorkspaceTarget::Windows),
            Some(&rollout.path().to_string_lossy()),
            None,
            10,
        )
        .expect("history page");
        assert_eq!(
            result.thread["tokenUsage"]["total"]["totalTokens"].as_u64(),
            Some(2176)
        );
        assert_eq!(
            result.thread["tokenUsage"]["last"]["totalTokens"].as_u64(),
            Some(64)
        );
        assert_eq!(
            result.thread["tokenUsage"]["modelContextWindow"].as_u64(),
            Some(32768)
        );
    }

    #[test]
    fn history_page_cache_reuses_parsed_turns_across_pages() {
        _clear_history_turns_cache_for_test();
        reset_history_parse_counter();
        let rollout = write_rollout(&[
            r#"{"type":"session_meta","payload":{"id":"thread-cache"}}"#,
            r#"{"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-1"}}"#,
            r#"{"type":"event_msg","payload":{"type":"user_message","message":"one","images":[],"local_images":[],"text_elements":[]}}"#,
            r#"{"type":"event_msg","payload":{"type":"agent_message","message":"reply one"}}"#,
            r#"{"type":"event_msg","payload":{"type":"task_complete"}}"#,
            r#"{"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-2"}}"#,
            r#"{"type":"event_msg","payload":{"type":"user_message","message":"two","images":[],"local_images":[],"text_elements":[]}}"#,
            r#"{"type":"event_msg","payload":{"type":"agent_message","message":"reply two"}}"#,
            r#"{"type":"event_msg","payload":{"type":"task_complete"}}"#,
            r#"{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":1024,"cached_input_tokens":0,"output_tokens":32,"reasoning_output_tokens":16,"total_tokens":1056},"last_token_usage":{"input_tokens":32,"cached_input_tokens":0,"output_tokens":8,"reasoning_output_tokens":4,"total_tokens":40},"model_context_window":8192}}}"#,
            r#"{"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-3"}}"#,
            r#"{"type":"event_msg","payload":{"type":"user_message","message":"three","images":[],"local_images":[],"text_elements":[]}}"#,
            r#"{"type":"event_msg","payload":{"type":"agent_message","message":"reply three"}}"#,
            r#"{"type":"event_msg","payload":{"type":"task_complete"}}"#,
        ]);
        let first = load_thread_history_page(
            "thread-cache",
            Some(WorkspaceTarget::Windows),
            Some(&rollout.path().to_string_lossy()),
            None,
            1,
        )
        .expect("first page");
        assert_eq!(
            history_parse_count_for_path(rollout.path()),
            1,
            "first page should parse rollout once"
        );
        assert_eq!(
            first.thread["tokenUsage"]["total"]["totalTokens"].as_u64(),
            Some(1056)
        );
        let before = first.page["beforeCursor"].as_str().expect("before cursor");
        let older = load_thread_history_page(
            "thread-cache",
            Some(WorkspaceTarget::Windows),
            Some(&rollout.path().to_string_lossy()),
            Some(before),
            1,
        )
        .expect("older page");
        assert_eq!(
            history_parse_count_for_path(rollout.path()),
            1,
            "older page should reuse cached parsed turns instead of reparsing"
        );
        assert_eq!(
            older.thread["tokenUsage"]["modelContextWindow"].as_u64(),
            Some(8192)
        );
        let older_turns = older.thread["turns"].as_array().expect("older turns");
        assert_eq!(older_turns.len(), 1);
        assert_eq!(
            older_turns[0]["items"][0]["content"][0]["text"].as_str(),
            Some("two")
        );
    }

    #[test]
    fn history_page_reparses_incomplete_rollout_even_when_file_key_is_unchanged() {
        _clear_history_turns_cache_for_test();
        reset_history_parse_counter();
        let rollout = tempfile::NamedTempFile::new().expect("temp rollout");
        let initial = [
            r#"{"type":"session_meta","payload":{"id":"thread-live-cache"}}"#,
            r#"{"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-1"}}"#,
            r#"{"type":"event_msg","payload":{"type":"user_message","message":"keep reparsing incomplete cache state please","images":[],"local_images":[],"text_elements":[]}}"#,
        ]
        .join("\n");
        let completed = [
            r#"{"type":"session_meta","payload":{"id":"thread-live-cache"}}"#,
            r#"{"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-1"}}"#,
            r#"{"type":"event_msg","payload":{"type":"user_message","message":"ok","images":[],"local_images":[],"text_elements":[]}}"#,
            r#"{"type":"event_msg","payload":{"type":"agent_message","message":"done"}}"#,
            r#"{"type":"event_msg","payload":{"type":"task_complete"}}"#,
        ]
        .join("\n");
        let target_len = initial.len().max(completed.len()) + 1;
        let initial_body = format!("{initial}\n{}", " ".repeat(target_len - initial.len() - 1));
        let completed_body = format!(
            "{completed}\n{}",
            " ".repeat(target_len - completed.len() - 1)
        );
        std::fs::write(rollout.path(), initial_body).expect("write initial rollout");
        let modified = std::fs::metadata(rollout.path())
            .expect("initial metadata")
            .modified()
            .expect("initial modified time");

        let first = load_thread_history_page(
            "thread-live-cache",
            Some(WorkspaceTarget::Windows),
            Some(&rollout.path().to_string_lossy()),
            None,
            10,
        )
        .expect("first page");
        assert_eq!(
            first.page["incomplete"].as_bool(),
            Some(true),
            "initial read should reflect the incomplete active turn"
        );
        assert_eq!(
            history_parse_count_for_path(rollout.path()),
            1,
            "first read should parse rollout once"
        );

        std::fs::write(rollout.path(), completed_body).expect("write completed rollout");
        std::fs::OpenOptions::new()
            .write(true)
            .open(rollout.path())
            .expect("open rewritten rollout")
            .set_modified(modified)
            .expect("restore modified time");

        let second = load_thread_history_page(
            "thread-live-cache",
            Some(WorkspaceTarget::Windows),
            Some(&rollout.path().to_string_lossy()),
            None,
            10,
        )
        .expect("second page");
        assert_eq!(
            history_parse_count_for_path(rollout.path()),
            2,
            "incomplete rollouts must be reparsed even if the file key looks unchanged"
        );
        assert_eq!(second.page["incomplete"].as_bool(), Some(false));
        let turns = second.thread["turns"].as_array().expect("turns array");
        let items = turns[0]["items"].as_array().expect("items array");
        assert!(
            matches!(
                items[1]["type"].as_str(),
                Some("agentMessage") | Some("assistantMessage")
            ),
            "expected final assistant content after reparsing the completed rollout"
        );
        assert_eq!(items[1]["text"].as_str(), Some("done"));
    }

    #[test]
    fn history_page_keeps_response_items_as_tool_and_assistant_entries() {
        let function_call_arguments = serde_json::to_string(
            &serde_json::json!({ "command": ["powershell.exe", "-Command", "git status --short"] }),
        )
        .expect("function call args");
        let function_call_output = serde_json::to_string(&serde_json::json!({
            "output": "M src/ui/codex-web-dev.js\n",
            "metadata": { "exit_code": 0 }
        }))
        .expect("function call output");
        let custom_tool_output = serde_json::to_string(&serde_json::json!({
            "output": "Success. Updated the following files:\nM AGENTS.md\n"
        }))
        .expect("custom tool output");
        let rollout = write_rollout(&[
            r#"{"type":"session_meta","payload":{"id":"thread-tools"}}"#,
            r#"{"type":"event_msg","payload":{"type":"user_message","message":"inspect history","images":[],"local_images":[],"text_elements":[]}}"#,
            &serde_json::json!({
                "type": "response_item",
                "payload": {
                    "type": "function_call",
                    "name": "shell_command",
                    "arguments": function_call_arguments,
                    "call_id": "call-shell-1"
                }
            })
            .to_string(),
            &serde_json::json!({
                "type": "response_item",
                "payload": {
                    "type": "function_call_output",
                    "call_id": "call-shell-1",
                    "output": function_call_output
                }
            })
            .to_string(),
            &serde_json::json!({
                "type": "response_item",
                "payload": {
                    "type": "custom_tool_call",
                    "status": "completed",
                    "name": "apply_patch",
                    "call_id": "call-tool-1",
                    "input": "*** Begin Patch\n*** End Patch\n"
                }
            })
            .to_string(),
            &serde_json::json!({
                "type": "response_item",
                "payload": {
                    "type": "custom_tool_call_output",
                    "call_id": "call-tool-1",
                    "output": custom_tool_output
                }
            })
            .to_string(),
            r#"{"type":"response_item","payload":{"type":"web_search_call","status":"completed","action":{"type":"search","query":"openai codex history tools"}}}"#,
            &serde_json::json!({
                "type": "event_msg",
                "payload": {
                    "type": "item_completed",
                    "thread_id": "thread-tools",
                    "item": {
                        "type": "Plan",
                        "text": "Step 1\nStep 2"
                    }
                }
            })
            .to_string(),
            r#"{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"done"}]}}"#,
        ]);
        let result = load_thread_history_page(
            "thread-tools",
            Some(WorkspaceTarget::Windows),
            Some(&rollout.path().to_string_lossy()),
            None,
            10,
        )
        .expect("history page");

        let turns = result
            .thread
            .get("turns")
            .and_then(|v| v.as_array())
            .expect("turns array");
        assert_eq!(turns.len(), 1);
        let items = turns[0]["items"].as_array().expect("items");
        assert_eq!(items[1]["type"].as_str(), Some("commandExecution"));
        assert_eq!(items[1]["command"].as_str(), Some("git status --short"));
        assert_eq!(items[1]["exitCode"].as_i64(), Some(0));
        assert_eq!(
            items[1]["output"].as_str(),
            Some("M src/ui/codex-web-dev.js")
        );
        assert_eq!(items[2]["type"].as_str(), Some("toolCall"));
        assert_eq!(items[2]["tool"].as_str(), Some("apply_patch"));
        assert_eq!(
            items[2]["result"].as_str(),
            Some("Success. Updated the following files:\nM AGENTS.md")
        );
        assert_eq!(items[3]["type"].as_str(), Some("webSearch"));
        assert_eq!(
            items[3]["query"].as_str(),
            Some("openai codex history tools")
        );
        assert_eq!(items[4]["type"].as_str(), Some("plan"));
        assert_eq!(items[4]["text"].as_str(), Some("Step 1\nStep 2"));
        assert_eq!(items[5]["type"].as_str(), Some("assistantMessage"));
        assert_eq!(items[5]["text"].as_str(), Some("done"));
    }

    #[test]
    fn history_page_marks_latest_turn_incomplete_when_rollout_has_no_turn_complete() {
        let rollout = write_rollout(&[
            r#"{"type":"session_meta","payload":{"id":"thread-incomplete"}}"#,
            r#"{"type":"event_msg","payload":{"type":"turn_started","turn_id":"turn-1"}}"#,
            r#"{"type":"event_msg","payload":{"type":"user_message","message":"hello","images":[],"local_images":[],"text_elements":[]}}"#,
            r#"{"type":"response_item","payload":{"type":"function_call","name":"shell","call_id":"call-1","arguments":"{\"command\":\"pwd\"}"}}"#,
        ]);
        let result = load_thread_history_page(
            "thread-incomplete",
            Some(WorkspaceTarget::Windows),
            Some(&rollout.path().to_string_lossy()),
            None,
            10,
        )
        .expect("history page");

        assert_eq!(result.page["incomplete"].as_bool(), Some(true));
    }

    #[test]
    fn history_page_maps_shell_command_tool_items_to_command_execution() {
        let rollout = write_rollout(&[
            r#"{"type":"session_meta","payload":{"id":"thread-shell-item"}}"#,
            r#"{"type":"event_msg","payload":{"type":"turn_started","turn_id":"turn-1"}}"#,
            &serde_json::json!({
                "type": "event_msg",
                "payload": {
                    "type": "item_completed",
                    "thread_id": "thread-shell-item",
                    "item": {
                        "type": "toolCall",
                        "id": "tool-1",
                        "tool": "shell_command",
                        "status": "running",
                        "arguments": serde_json::json!({ "command": "cargo test --lib" }),
                    }
                }
            })
            .to_string(),
        ]);
        let result = load_thread_history_page(
            "thread-shell-item",
            Some(WorkspaceTarget::Windows),
            Some(&rollout.path().to_string_lossy()),
            None,
            10,
        )
        .expect("history page");

        let turns = result
            .thread
            .get("turns")
            .and_then(|v| v.as_array())
            .expect("turns array");
        let items = turns[0]["items"].as_array().expect("items");
        assert_eq!(items[0]["type"].as_str(), Some("commandExecution"));
        assert_eq!(items[0]["command"].as_str(), Some("cargo test --lib"));
    }

    #[test]
    fn history_page_marks_task_started_turns_incomplete_too() {
        let rollout = write_rollout(&[
            r#"{"type":"session_meta","payload":{"id":"thread-task-incomplete"}}"#,
            r#"{"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-1"}}"#,
            r#"{"type":"event_msg","payload":{"type":"user_message","message":"hello","images":[],"local_images":[],"text_elements":[]}}"#,
            r#"{"type":"response_item","payload":{"type":"function_call","name":"shell","call_id":"call-1","arguments":"{\"command\":\"pwd\"}"}}"#,
        ]);
        let result = load_thread_history_page(
            "thread-task-incomplete",
            Some(WorkspaceTarget::Windows),
            Some(&rollout.path().to_string_lossy()),
            None,
            10,
        )
        .expect("history page");

        assert_eq!(result.page["incomplete"].as_bool(), Some(true));
    }

    #[test]
    fn wsl_rollout_path_resolves_host_specific_local_path() {
        let _home = EnvGuard::set("API_ROUTER_WEB_CODEX_WSL_CODEX_HOME", "/home/test/.codex");
        let raw_path = "/home/test/.codex/sessions/2026/03/07/rollout.jsonl";
        let path = resolve_rollout_path(Some(WorkspaceTarget::Wsl2), raw_path)
            .expect("resolve wsl rollout path");
        let text = path.local_path.to_string_lossy().replace('/', "\\");
        #[cfg(target_os = "windows")]
        assert!(
            text.starts_with("\\\\wsl.localhost\\") || text.starts_with("\\\\wsl$\\"),
            "expected WSL UNC path, got {text}"
        );
        #[cfg(not(target_os = "windows"))]
        assert_eq!(path.local_path, std::path::PathBuf::from(raw_path));
        assert_eq!(
            path.linux_path.as_deref(),
            Some("/home/test/.codex/sessions/2026/03/07/rollout.jsonl")
        );
    }

    #[test]
    fn wsl_unc_rollout_path_is_preserved() {
        let path = resolve_rollout_path(
            Some(WorkspaceTarget::Wsl2),
            r"\\wsl.localhost\Ubuntu\home\test\.codex\sessions\2026\03\07\rollout.jsonl",
        )
        .expect("resolve unc rollout path");
        let text = path.local_path.to_string_lossy().replace('/', "\\");
        #[cfg(target_os = "windows")]
        assert!(
            text.starts_with("\\\\wsl.localhost\\") || text.starts_with("\\\\wsl$\\"),
            "expected normalized UNC path, got {text}"
        );
        #[cfg(not(target_os = "windows"))]
        assert_eq!(
            path.local_path,
            std::path::PathBuf::from(
                r"\\wsl.localhost\Ubuntu\home\test\.codex\sessions\2026\03\07\rollout.jsonl"
            )
        );
        assert_eq!(
            path.linux_path.as_deref(),
            Some("/home/test/.codex/sessions/2026/03/07/rollout.jsonl")
        );
    }

    #[test]
    fn wsl_history_falls_back_to_linux_loader_when_local_path_is_missing() {
        let _home = EnvGuard::set("API_ROUTER_WEB_CODEX_WSL_CODEX_HOME", "/home/test/.codex");
        let seen = std::sync::Arc::new(std::sync::Mutex::new(None::<String>));
        let seen_clone = seen.clone();
        _set_test_wsl_history_loader(Some(std::sync::Arc::new(
            move |_thread_id,
                  _workspace,
                  _raw_rollout_path,
                  linux_rollout_path,
                  _before,
                  _limit| {
                match seen_clone.lock() {
                    Ok(mut guard) => *guard = Some(linux_rollout_path),
                    Err(err) => *err.into_inner() = Some(String::new()),
                }
                Ok(super::ThreadHistoryPage {
                    thread: serde_json::json!({
                        "id": "thread-wsl",
                        "workspace": "wsl2",
                        "rolloutPath": "/home/test/.codex/sessions/2026/03/07/rollout.jsonl",
                        "turns": [],
                    }),
                    page: serde_json::json!({
                        "hasMore": false,
                        "beforeCursor": serde_json::Value::Null,
                        "limit": 1,
                        "totalTurns": 0,
                    }),
                })
            },
        )));
        let result = load_thread_history_page(
            "thread-wsl",
            Some(WorkspaceTarget::Wsl2),
            Some("/home/test/.codex/sessions/2026/03/07/rollout.jsonl"),
            None,
            1,
        )
        .expect("wsl history page");
        _set_test_wsl_history_loader(None);
        let linux_rollout_path = match seen.lock() {
            Ok(guard) => guard.clone(),
            Err(err) => err.into_inner().clone(),
        };
        assert_eq!(
            linux_rollout_path.as_deref(),
            Some("/home/test/.codex/sessions/2026/03/07/rollout.jsonl")
        );
        assert_eq!(result.thread["workspace"].as_str(), Some("wsl2"));
    }

    #[test]
    fn wsl_history_prefers_linux_loader_when_linux_path_is_known() {
        assert!(should_prefer_wsl_linux_loader(
            Some(WorkspaceTarget::Wsl2),
            Some("/home/test/.codex/sessions/rollout.jsonl")
        ));
        assert!(!should_prefer_wsl_linux_loader(
            Some(WorkspaceTarget::Windows),
            Some("/home/test/.codex/sessions/rollout.jsonl")
        ));
        assert!(!should_prefer_wsl_linux_loader(
            Some(WorkspaceTarget::Wsl2),
            None
        ));
    }
}
