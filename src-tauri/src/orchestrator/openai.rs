use serde_json::{json, Value};

pub fn input_to_messages(input: &Value) -> Vec<Value> {
    match input {
        Value::Null => vec![],
        Value::String(s) => vec![json!({"role": "user", "content": s})],
        Value::Array(items) => {
            let mut out = Vec::new();
            for item in items {
                if item.get("role").is_some() && item.get("content").is_some() {
                    out.push(item.clone());
                } else if item.get("type") == Some(&Value::String("input_text".to_string())) {
                    let text = item.get("text").and_then(|v| v.as_str()).unwrap_or("");
                    out.push(json!({"role": "user", "content": text}));
                } else if item.get("type") == Some(&Value::String("message".to_string())) {
                    let role = item.get("role").and_then(|v| v.as_str()).unwrap_or("user");
                    let content = item.get("content").cloned().unwrap_or(Value::Null);
                    out.push(json!({"role": role, "content": content}));
                }
            }
            out
        }
        Value::Object(_) => {
            if input.get("role").is_some() && input.get("content").is_some() {
                vec![input.clone()]
            } else {
                vec![json!({"role":"user","content": input.to_string()})]
            }
        }
        _ => vec![json!({"role":"user","content": input.to_string()})],
    }
}

pub fn input_to_items_preserve_tools(input: &Value) -> Vec<Value> {
    match input {
        Value::Null => vec![],
        Value::Array(items) => items.clone(),
        Value::Object(_) => vec![input.clone()],
        Value::String(s) => vec![json!({
            "type": "message",
            "role": "user",
            "content": [{"type": "input_text", "text": s}]
        })],
        _ => vec![json!({
            "type": "message",
            "role": "user",
            "content": [{"type": "input_text", "text": input.to_string()}]
        })],
    }
}

pub fn messages_to_responses_input(messages: &[Value]) -> Value {
    let mut out = Vec::new();
    for m in messages {
        let role = m.get("role").and_then(|v| v.as_str()).unwrap_or("user");
        let content = m
            .get("content")
            .cloned()
            .unwrap_or(Value::String(String::new()));
        let text = match content {
            Value::String(s) => s,
            Value::Array(arr) => arr
                .iter()
                .filter_map(|c| c.get("text").and_then(|v| v.as_str()))
                .collect::<Vec<_>>()
                .join(" "),
            _ => content.to_string(),
        };
        out.push(json!({
            "type": "message",
            "role": role,
            "content": [{"type": "input_text", "text": text}]
        }));
    }
    Value::Array(out)
}

pub fn messages_to_simple_input_list(messages: &[Value]) -> Value {
    let mut out = Vec::new();
    for m in messages {
        let role = m.get("role").and_then(|v| v.as_str()).unwrap_or("user");
        let content = m
            .get("content")
            .cloned()
            .unwrap_or(Value::String(String::new()));
        let text = match content {
            Value::String(s) => s,
            Value::Array(arr) => arr
                .iter()
                .filter_map(|c| c.get("text").and_then(|v| v.as_str()))
                .collect::<Vec<_>>()
                .join(" "),
            _ => content.to_string(),
        };
        out.push(json!({
            "role": role,
            "content": text
        }));
    }
    Value::Array(out)
}

pub fn extract_text_from_responses(resp: &Value) -> String {
    let mut out = String::new();
    let output = resp
        .get("output")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    for item in output {
        let content = item
            .get("content")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        for c in content {
            let ty = c.get("type").and_then(|v| v.as_str()).unwrap_or("");
            if ty == "output_text" {
                if let Some(t) = c.get("text").and_then(|v| v.as_str()) {
                    out.push_str(t);
                }
            }
        }
    }
    out
}

pub fn sse_events_for_text(response_id: &str, full_response: &Value, text: &str) -> Vec<String> {
    let mut events = Vec::new();

    events.push(sse_data(&json!({
        "type": "response.created",
        "response_id": response_id
    })));

    // Chunk by characters to avoid huge single event.
    let mut buf = String::new();
    for ch in text.chars() {
        buf.push(ch);
        if buf.len() >= 64 {
            events.push(sse_data(&json!({
                "type": "response.output_text.delta",
                "response_id": response_id,
                "delta": buf
            })));
            buf = String::new();
        }
    }
    if !buf.is_empty() {
        events.push(sse_data(&json!({
            "type": "response.output_text.delta",
            "response_id": response_id,
            "delta": buf
        })));
    }

    events.push(sse_data(&json!({
        "type": "response.output_text.done",
        "response_id": response_id
    })));

    events.push(sse_data(&json!({
        "type": "response.completed",
        "response": full_response
    })));

    events.push("data: [DONE]\n\n".to_string());
    events
}

fn sse_data(v: &Value) -> String {
    let s = serde_json::to_string(v).unwrap_or_else(|_| "{}".to_string());
    format!("data: {s}\n\n")
}
