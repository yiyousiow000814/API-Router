use serde_json::Value;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct SessionMetaIdentity {
    pub(crate) session_id: String,
    pub(crate) cwd: Option<String>,
    pub(crate) created_at: Option<i64>,
    pub(crate) source: Option<Value>,
    pub(crate) agent_parent_session_id: Option<String>,
    pub(crate) agent_role: Option<String>,
    pub(crate) agent_nickname: Option<String>,
    pub(crate) is_agent: bool,
    pub(crate) is_review: bool,
}

pub(crate) fn session_meta_string_field(payload: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| payload.get(*key))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

pub(crate) fn session_meta_i64_field(payload: &Value, keys: &[&str]) -> Option<i64> {
    keys.iter()
        .find_map(|key| payload.get(*key))
        .and_then(parse_json_i64)
}

fn parse_json_i64(value: &Value) -> Option<i64> {
    if let Some(value) = value.as_i64() {
        return Some(value);
    }
    if let Some(value) = value.as_u64().and_then(|value| i64::try_from(value).ok()) {
        return Some(value);
    }
    value
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .and_then(|value| value.parse::<i64>().ok())
}

pub(crate) fn session_meta_source_subagent(source: &Value) -> Option<&Value> {
    source
        .as_object()
        .and_then(|source| source.get("subagent").or_else(|| source.get("subAgent")))
}

pub(crate) fn session_meta_source_is_agent(source: Option<&Value>) -> bool {
    let Some(source) = source else {
        return false;
    };
    match source {
        Value::Object(_) => session_meta_source_subagent(source).is_some(),
        Value::String(source) => {
            let source = source.to_ascii_lowercase();
            source.contains("subagent") || source.contains("review")
        }
        _ => false,
    }
}

pub(crate) fn session_meta_source_is_review(source: Option<&Value>) -> bool {
    let Some(source) = source else {
        return false;
    };
    match source {
        Value::Object(_) => session_meta_source_subagent(source)
            .and_then(Value::as_str)
            .is_some_and(|value| value.eq_ignore_ascii_case("review")),
        Value::String(source) => source.to_ascii_lowercase().contains("review"),
        _ => false,
    }
}

pub(crate) fn session_meta_source_parent_session_id(source: Option<&Value>) -> Option<String> {
    let subagent = session_meta_source_subagent(source?)?;
    let parent = subagent
        .as_object()
        .and_then(|subagent| {
            subagent
                .get("thread_spawn")
                .or_else(|| subagent.get("threadSpawn"))
        })
        .and_then(Value::as_object)
        .and_then(|spawn| {
            spawn
                .get("parent_thread_id")
                .or_else(|| spawn.get("parentThreadId"))
        })
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    Some(parent.to_string())
}

pub(crate) fn session_meta_thread_source_is_agent(payload: &Value) -> bool {
    session_meta_string_field(payload, &["thread_source", "threadSource"])
        .map(|source| {
            let source = source.to_ascii_lowercase();
            source.contains("subagent") || source.contains("review")
        })
        .unwrap_or(false)
}

impl SessionMetaIdentity {
    pub(crate) fn from_session_meta_event(value: &Value) -> Option<Self> {
        if value.get("type").and_then(Value::as_str) != Some("session_meta") {
            return None;
        }
        Self::from_payload(value.get("payload")?)
    }

    pub(crate) fn from_payload(payload: &Value) -> Option<Self> {
        let session_id = session_meta_string_field(payload, &["id", "session_id", "sessionId"])?;
        let source = payload.get("source");
        let agent_role = session_meta_string_field(payload, &["agent_role", "agentRole"]);
        let agent_nickname =
            session_meta_string_field(payload, &["agent_nickname", "agentNickname"]);
        let is_review = session_meta_source_is_review(source)
            || session_meta_string_field(payload, &["thread_source", "threadSource"])
                .is_some_and(|source| source.to_ascii_lowercase().contains("review"))
            || agent_role
                .as_deref()
                .is_some_and(|role| role.eq_ignore_ascii_case("review"));
        let is_agent = session_meta_source_is_agent(source)
            || session_meta_thread_source_is_agent(payload)
            || agent_role.as_deref().is_some_and(|role| !role.is_empty())
            || agent_nickname
                .as_deref()
                .is_some_and(|nickname| !nickname.is_empty());
        Some(Self {
            session_id,
            cwd: session_meta_string_field(payload, &["cwd"]),
            created_at: session_meta_i64_field(payload, &["created_at", "createdAt"]),
            source: source.cloned(),
            agent_parent_session_id: session_meta_source_parent_session_id(source).or_else(|| {
                session_meta_string_field(
                    payload,
                    &[
                        "parentThreadId",
                        "parent_thread_id",
                        "agentParentSessionId",
                        "agent_parent_session_id",
                    ],
                )
            }),
            agent_role,
            agent_nickname,
            is_agent: is_agent || is_review,
            is_review,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_subagent_aliases_from_session_meta() {
        let meta = json!({
            "type": "session_meta",
            "payload": {
                "sessionId": "agent-thread",
                "cwd": "C:/repo",
                "createdAt": 1742340000,
                "source": {
                    "subAgent": {
                        "threadSpawn": {
                            "parentThreadId": "main-thread"
                        }
                    }
                },
                "agentRole": "explorer",
                "agentNickname": "Curie"
            }
        });

        let identity = SessionMetaIdentity::from_session_meta_event(&meta).expect("identity");
        assert_eq!(identity.session_id, "agent-thread");
        assert_eq!(identity.cwd.as_deref(), Some("C:/repo"));
        assert_eq!(identity.created_at, Some(1742340000));
        assert!(identity.is_agent);
        assert!(!identity.is_review);
        assert_eq!(
            identity.agent_parent_session_id.as_deref(),
            Some("main-thread")
        );
        assert_eq!(identity.agent_role.as_deref(), Some("explorer"));
        assert_eq!(identity.agent_nickname.as_deref(), Some("Curie"));
    }
}
