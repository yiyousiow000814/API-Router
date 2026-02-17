fn prefers_simple_input_list(base_url: &str) -> bool {
    let host = reqwest::Url::parse(base_url)
        .ok()
        .and_then(|u| u.host_str().map(|s| s.to_string()))
        .unwrap_or_default();
    host.ends_with("ppchat.vip")
        || host.ends_with("pumpkinai.vip")
        || host.ends_with("packycode.com")
}

fn input_contains_tools(input: &Value) -> bool {
    contains_tool_value(input)
}

fn summarize_input_for_debug(input: &Value) -> String {
    let mut s = serde_json::to_string(input).unwrap_or_else(|_| "<unserializable>".to_string());
    const LIMIT: usize = 400;
    if s.len() > LIMIT {
        s.truncate(LIMIT);
        s.push_str("...");
    }
    s
}

fn contains_tool_value(value: &Value) -> bool {
    match value {
        Value::Object(map) => {
            if let Some(Value::String(t)) = map.get("type") {
                if t.contains("tool") {
                    return true;
                }
            }
            for v in map.values() {
                if contains_tool_value(v) {
                    return true;
                }
            }
            false
        }
        Value::Array(items) => items.iter().any(contains_tool_value),
        _ => false,
    }
}

fn session_key_from_request(headers: &HeaderMap, body: &Value) -> Option<String> {
    let v = headers.get("session_id")?.to_str().ok()?;
    let v = v.trim();
    if v.is_empty() {
        return None;
    }
    let _ = body;
    Some(v.to_string())
}

fn request_base_url_hint(headers: &HeaderMap, listen_port: u16) -> Option<String> {
    let host_raw = headers
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|v| !v.is_empty())?;

    // `Host` is usually `host[:port]`. Keep this best-effort and deterministic for UI origin
    // detection. If the client omitted port, use the router listen port.
    let authority = if host_raw.starts_with('[') {
        // IPv6 host: `[::1]` or `[::1]:4000`
        if host_raw.rfind("]:").is_some() {
            host_raw.to_string()
        } else {
            format!("{host_raw}:{listen_port}")
        }
    } else if host_raw.contains(':') {
        host_raw.to_string()
    } else {
        format!("{host_raw}:{listen_port}")
    };

    Some(format!("http://{authority}/v1"))
}

fn request_looks_like_wsl_origin(base_url: &str) -> bool {
    let Some(host) = reqwest::Url::parse(base_url)
        .ok()
        .and_then(|u| u.host_str().map(|s| s.to_ascii_lowercase()))
    else {
        return false;
    };
    let windows_host = crate::constants::GATEWAY_WINDOWS_HOST.to_ascii_lowercase();
    if host == windows_host || host == "localhost" || host == "::1" {
        return false;
    }
    if host == crate::platform::wsl_gateway_host::resolve_wsl_gateway_host(None).to_ascii_lowercase()
    {
        return true;
    }
    host.parse::<std::net::Ipv4Addr>().is_ok()
}

fn request_looks_like_windows_origin(base_url: &str) -> bool {
    let Some(host) = reqwest::Url::parse(base_url)
        .ok()
        .and_then(|u| u.host_str().map(|s| s.to_ascii_lowercase()))
    else {
        return false;
    };
    host == crate::constants::GATEWAY_WINDOWS_HOST || host == "localhost" || host == "::1"
}

fn usage_origin_from_base_url(base_url: Option<&str>) -> &'static str {
    let Some(base_url) = base_url else {
        return crate::constants::USAGE_ORIGIN_UNKNOWN;
    };
    if request_looks_like_wsl_origin(base_url) {
        return crate::constants::USAGE_ORIGIN_WSL2;
    }
    if request_looks_like_windows_origin(base_url) {
        return crate::constants::USAGE_ORIGIN_WINDOWS;
    }
    crate::constants::USAGE_ORIGIN_UNKNOWN
}

fn codex_session_id_for_display(headers: &HeaderMap, body: &Value) -> Option<String> {
    for k in [
        "session_id",
        "x-session-id",
        "x-codex-session",
        "x-codex-session-id",
        "codex-session",
        "codex_session",
    ] {
        if let Some(v) = headers.get(k).and_then(|v| v.to_str().ok()) {
            let v = v.trim();
            if !v.is_empty() {
                return Some(v.to_string());
            }
        }
    }
    for k in [
        "session_id",
        "session",
        "codex_session_id",
        "codexSessionId",
    ] {
        if let Some(v) = body.get(k) {
            if let Some(s) = v.as_str() {
                let s = s.trim();
                if !s.is_empty() {
                    return Some(s.to_string());
                }
            }
        }
    }
    None
}

fn body_session_source_is_agent(body: &Value) -> bool {
    let source = body
        .get("session_source")
        .or_else(|| body.get("sessionSource"));
    let Some(source) = source else {
        return false;
    };
    match source {
        Value::Object(map) => map.contains_key("subagent") || map.contains_key("subAgent"),
        Value::String(v) => {
            let v = v.to_ascii_lowercase();
            v.contains("subagent") || v.contains("review")
        }
        _ => false,
    }
}

fn body_session_source_is_review(body: &Value) -> bool {
    let source = body
        .get("session_source")
        .or_else(|| body.get("sessionSource"));
    let Some(source) = source else {
        return false;
    };
    match source {
        Value::Object(map) => map
            .get("subagent")
            .or_else(|| map.get("subAgent"))
            .and_then(|v| v.as_str())
            .is_some_and(|v| v.eq_ignore_ascii_case("review")),
        Value::String(v) => v.to_ascii_lowercase().contains("review"),
        _ => false,
    }
}

fn request_is_agent(headers: &HeaderMap, body: &Value) -> bool {
    if headers
        .get("x-openai-subagent")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| !v.trim().is_empty())
    {
        return true;
    }
    body_session_source_is_agent(body)
}

fn request_is_review(headers: &HeaderMap, body: &Value) -> bool {
    if headers
        .get("x-openai-subagent")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.trim().eq_ignore_ascii_case("review"))
    {
        return true;
    }
    body_session_source_is_review(body)
}

fn body_agent_parent_session_id(body: &Value) -> Option<String> {
    let source = body
        .get("session_source")
        .or_else(|| body.get("sessionSource"))?;
    let source_obj = source.as_object()?;
    let subagent = source_obj
        .get("subagent")
        .or_else(|| source_obj.get("subAgent"))?;
    let subagent_obj = subagent.as_object()?;
    let thread_spawn = subagent_obj
        .get("thread_spawn")
        .or_else(|| subagent_obj.get("threadSpawn"))?;
    let thread_spawn_obj = thread_spawn.as_object()?;
    let parent = thread_spawn_obj
        .get("parent_thread_id")
        .or_else(|| thread_spawn_obj.get("parentThreadId"))
        .and_then(|v| v.as_str())?
        .trim();
    if parent.is_empty() {
        return None;
    }
    if uuid::Uuid::parse_str(parent).is_err() {
        return None;
    }
    Some(parent.to_string())
}

fn is_prev_id_unsupported_error(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    lower.contains("unsupported parameter: previous_response_id")
        || lower.contains("unsupported parameter: previous_response_id\"")
        || lower.contains("unsupported parameter: previous_response_id\\")
}

fn codex_home_dir() -> Option<PathBuf> {
    if let Ok(v) = std::env::var("CODEX_HOME") {
        if !v.trim().is_empty() {
            return Some(PathBuf::from(v));
        }
    }
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok()?;
    if home.trim().is_empty() {
        return None;
    }
    Some(PathBuf::from(home).join(".codex"))
}

fn find_codex_session_file_in(base: &Path, session_id: &str) -> Option<PathBuf> {
    let sessions_dir = base.join("sessions");
    if !sessions_dir.exists() {
        return None;
    }
    let mut stack = vec![sessions_dir];
    while let Some(dir) = stack.pop() {
        let entries = std::fs::read_dir(&dir).ok()?;
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                if name.contains(session_id) && name.ends_with(".jsonl") {
                    return Some(path);
                }
            }
        }
    }
    None
}

fn load_codex_session_messages_from_file(path: &PathBuf) -> Vec<Value> {
    let file = match File::open(path) {
        Ok(f) => f,
        Err(_) => return Vec::new(),
    };
    let reader = BufReader::new(file);
    let mut out = Vec::new();
    for line in reader.lines().map_while(Result::ok) {
        let Ok(v) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if v.get("type").and_then(|t| t.as_str()) != Some("response_item") {
            continue;
        }
        let Some(payload) = v.get("payload") else {
            continue;
        };
        if payload.get("type").and_then(|t| t.as_str()) != Some("message") {
            continue;
        }
        out.push(payload.clone());
    }
    out
}

fn load_codex_session_messages(session_id: &str) -> Option<Vec<Value>> {
    let base = codex_home_dir()?;
    let path = find_codex_session_file_in(&base, session_id)?;
    let items = load_codex_session_messages_from_file(&path);
    if items.is_empty() {
        return None;
    }
    Some(items)
}

fn ends_with_items(haystack: &[Value], needle: &[Value]) -> bool {
    if needle.is_empty() {
        return true;
    }
    if haystack.len() < needle.len() {
        return false;
    }
    let start = haystack.len() - needle.len();
    haystack[start..] == *needle
}

#[cfg(test)]
mod tests {
    use super::{body_agent_parent_session_id, usage_origin_from_base_url};
    use serde_json::json;

    #[test]
    fn usage_origin_recognizes_windows_hosts() {
        assert_eq!(
            usage_origin_from_base_url(Some("http://127.0.0.1:4000/v1")),
            crate::constants::USAGE_ORIGIN_WINDOWS
        );
        assert_eq!(
            usage_origin_from_base_url(Some("http://localhost:4000/v1")),
            crate::constants::USAGE_ORIGIN_WINDOWS
        );
    }

    #[test]
    fn usage_origin_recognizes_wsl2_private_ipv4_host() {
        assert_eq!(
            usage_origin_from_base_url(Some("http://172.31.192.1:4000/v1")),
            crate::constants::USAGE_ORIGIN_WSL2
        );
    }

    #[test]
    fn usage_origin_keeps_unknown_for_non_local_domain() {
        assert_eq!(
            usage_origin_from_base_url(Some("https://example.com/v1")),
            crate::constants::USAGE_ORIGIN_UNKNOWN
        );
    }

    #[test]
    fn review_parent_session_id_extracts_thread_spawn_parent() {
        let body = json!({
            "session_source": {
                "subagent": {
                    "thread_spawn": {
                        "parent_thread_id": "019c67c0-c95d-7b10-a0a1-fc576b458272"
                    }
                }
            }
        });
        assert_eq!(
            body_agent_parent_session_id(&body).as_deref(),
            Some("019c67c0-c95d-7b10-a0a1-fc576b458272")
        );
    }

    #[test]
    fn review_parent_session_id_rejects_invalid_parent() {
        let body = json!({
            "sessionSource": {
                "subAgent": {
                    "threadSpawn": {
                        "parentThreadId": "not-a-uuid"
                    }
                }
            }
        });
        assert!(body_agent_parent_session_id(&body).is_none());
    }
}
