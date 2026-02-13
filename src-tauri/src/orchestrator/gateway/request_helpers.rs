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
        Value::String(v) => v.to_ascii_lowercase().contains("subagent"),
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
