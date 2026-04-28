use serde_json::Value;

const STARTUP_FRAME_STALL_WARNING_MS: u64 = 250;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum WatchdogIncidentSeverity {
    Info,
    Warning,
    Error,
    Critical,
}

impl WatchdogIncidentSeverity {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::Info => "info",
            Self::Warning => "warning",
            Self::Error => "error",
            Self::Critical => "critical",
        }
    }

    pub(super) fn is_actionable(self) -> bool {
        !matches!(self, Self::Info)
    }
}

#[derive(Debug, Clone, Copy)]
pub(super) struct WatchdogIncidentClassification {
    pub(super) severity: WatchdogIncidentSeverity,
    pub(super) impact: &'static str,
}

pub(super) fn default_watchdog_incident_classification(
    trigger: &str,
) -> WatchdogIncidentClassification {
    let severity = match trigger {
        "heartbeat-stall" | "frontend-error" | "invoke-error" => WatchdogIncidentSeverity::Error,
        _ => WatchdogIncidentSeverity::Warning,
    };
    WatchdogIncidentClassification {
        severity,
        impact: "unknown",
    }
}

pub(super) fn classify_watchdog_incident(
    trigger: &str,
    payload: &Value,
) -> WatchdogIncidentClassification {
    match trigger {
        "backend-pipeline" => classify_backend_pipeline_incident(payload),
        "frame-stall" => classify_frame_stall_incident(payload),
        "local-task" => classify_local_task_incident(payload),
        "long-task" => classify_long_task_incident(payload),
        "heartbeat-stall" => WatchdogIncidentClassification {
            severity: WatchdogIncidentSeverity::Critical,
            impact: "visible-ui",
        },
        "backend-status-stall" => WatchdogIncidentClassification {
            severity: WatchdogIncidentSeverity::Error,
            impact: "backend-status",
        },
        "frontend-error" | "invoke-error" => WatchdogIncidentClassification {
            severity: WatchdogIncidentSeverity::Error,
            impact: "visible-ui",
        },
        "slow-refresh" | "slow-invoke" | "status" | "config" | "provider_switch" => {
            WatchdogIncidentClassification {
                severity: WatchdogIncidentSeverity::Warning,
                impact: "visible-ui",
            }
        }
        _ => default_watchdog_incident_classification(trigger),
    }
}

fn classify_backend_pipeline_incident(payload: &Value) -> WatchdogIncidentClassification {
    let Some(event) = payload.get("pipeline_event") else {
        return default_watchdog_incident_classification("backend-pipeline");
    };
    let route = json_field_str(event, "route").unwrap_or_default();
    let stage = json_field_str(event, "stage").unwrap_or_default();
    let method = json_field_str(event, "method").unwrap_or_default();
    let source = json_field_str(event, "source").unwrap_or_default();
    let ok = event.get("ok").and_then(Value::as_bool);
    let status_code = event.get("statusCode").and_then(Value::as_u64).unwrap_or(0);

    if ok == Some(false) || status_code >= 500 {
        return WatchdogIncidentClassification {
            severity: WatchdogIncidentSeverity::Error,
            impact: "request",
        };
    }
    if status_code >= 400 {
        return WatchdogIncidentClassification {
            severity: WatchdogIncidentSeverity::Warning,
            impact: "request",
        };
    }
    if stage == "runtime_detect"
        && route == "/codex/version-info"
        && source == "codex-version-command"
    {
        return WatchdogIncidentClassification {
            severity: WatchdogIncidentSeverity::Info,
            impact: "background",
        };
    }
    if stage == "app_server_rpc" && method == "account/rateLimits/read" {
        return WatchdogIncidentClassification {
            severity: WatchdogIncidentSeverity::Info,
            impact: "background",
        };
    }
    if route == "/codex/ui-diagnostics" {
        return WatchdogIncidentClassification {
            severity: WatchdogIncidentSeverity::Info,
            impact: "background",
        };
    }

    let is_codex_hot_path = route.starts_with("/codex/threads")
        || route.starts_with("/codex/history")
        || route == "/codex/models"
        || route == "/codex/version-info";
    WatchdogIncidentClassification {
        severity: WatchdogIncidentSeverity::Warning,
        impact: if is_codex_hot_path {
            "request"
        } else {
            "backend"
        },
    }
}

fn classify_frame_stall_incident(payload: &Value) -> WatchdogIncidentClassification {
    let fields = latest_trace_fields(payload, "frame_stall");
    let visible = fields
        .and_then(|fields| fields.get("visible"))
        .and_then(Value::as_bool)
        .or_else(|| {
            payload
                .get("snapshot")
                .and_then(|snapshot| snapshot.get("visible"))
                .and_then(Value::as_bool)
        })
        .unwrap_or(false);
    if !visible {
        return WatchdogIncidentClassification {
            severity: WatchdogIncidentSeverity::Info,
            impact: "background",
        };
    }
    let elapsed_ms = fields
        .and_then(|fields| fields.get("elapsed_ms"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let severity = if elapsed_ms >= 1_000 {
        WatchdogIncidentSeverity::Critical
    } else if elapsed_ms >= 500 {
        WatchdogIncidentSeverity::Error
    } else {
        WatchdogIncidentSeverity::Warning
    };
    let monitor_kind = fields
        .and_then(|fields| json_field_str(fields, "monitor_kind"))
        .unwrap_or_default();
    if monitor_kind == "startup" && elapsed_ms < STARTUP_FRAME_STALL_WARNING_MS {
        return WatchdogIncidentClassification {
            severity: WatchdogIncidentSeverity::Info,
            impact: "startup",
        };
    }
    WatchdogIncidentClassification {
        severity,
        impact: if monitor_kind == "startup" {
            "startup"
        } else {
            "visible-ui"
        },
    }
}

fn classify_local_task_incident(payload: &Value) -> WatchdogIncidentClassification {
    let fields = latest_trace_fields(payload, "local_task");
    let visible = fields
        .and_then(|fields| fields.get("visible"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if !visible {
        return WatchdogIncidentClassification {
            severity: WatchdogIncidentSeverity::Info,
            impact: "background",
        };
    }
    let elapsed_ms = fields
        .and_then(|fields| fields.get("elapsed_ms"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let command = fields
        .and_then(|fields| json_field_str(fields, "command"))
        .unwrap_or_default();
    let headers_ms = fields
        .and_then(|fields| fields.get("fields"))
        .and_then(|fields| fields.get("headersMs"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let severity = if elapsed_ms >= 3_000 {
        WatchdogIncidentSeverity::Error
    } else {
        WatchdogIncidentSeverity::Warning
    };
    WatchdogIncidentClassification {
        severity,
        impact: if command == "thread refresh fetch" && headers_ms >= 500 {
            "transport"
        } else {
            "visible-ui"
        },
    }
}

fn classify_long_task_incident(payload: &Value) -> WatchdogIncidentClassification {
    let fields = latest_trace_fields(payload, "long_task");
    let visible = fields
        .and_then(|fields| fields.get("visible"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if !visible {
        return WatchdogIncidentClassification {
            severity: WatchdogIncidentSeverity::Info,
            impact: "background",
        };
    }
    let elapsed_ms = fields
        .and_then(|fields| fields.get("elapsed_ms"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    WatchdogIncidentClassification {
        severity: if elapsed_ms >= 1_000 {
            WatchdogIncidentSeverity::Error
        } else {
            WatchdogIncidentSeverity::Warning
        },
        impact: "visible-ui",
    }
}

pub(super) fn describe_watchdog_incident(
    prefix: &str,
    trigger: &str,
    payload: &Value,
) -> Option<String> {
    let empty_traces = Vec::new();
    let recent_traces = payload
        .get("recent_traces")
        .and_then(Value::as_array)
        .unwrap_or(&empty_traces);
    match trigger {
        "slow-refresh" | "status" | "config" | "provider_switch" => {
            let refresh_source = recent_traces.iter().rev().find_map(|trace| {
                if trace.get("kind").and_then(|v| v.as_str()) == Some("status_refresh_requested") {
                    return trace
                        .get("fields")
                        .and_then(|fields| fields.get("fields"))
                        .and_then(|fields| fields.get("source"))
                        .and_then(|v| v.as_str())
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .map(ToString::to_string);
                }
                None
            });
            let source_label = refresh_source
                .as_deref()
                .map(humanize_watchdog_source)
                .unwrap_or_else(|| humanize_watchdog_trigger(prefix, trigger));
            Some(format!("{source_label} refresh too slow"))
        }
        "slow-invoke" => {
            let command = recent_traces.iter().rev().find_map(|trace| {
                if trace.get("kind").and_then(|v| v.as_str()) == Some("invoke") {
                    return trace
                        .get("fields")
                        .and_then(|fields| fields.get("command"))
                        .and_then(|v| v.as_str())
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .map(ToString::to_string);
                }
                None
            });
            let label = command
                .as_deref()
                .map(humanize_watchdog_command)
                .unwrap_or_else(|| humanize_watchdog_trigger(prefix, trigger));
            Some(format!("{label} request too slow"))
        }
        "invoke-error" => {
            let command = recent_traces.iter().rev().find_map(|trace| {
                if trace.get("kind").and_then(|v| v.as_str()) == Some("invoke") {
                    return trace
                        .get("fields")
                        .and_then(|fields| fields.get("command"))
                        .and_then(|v| v.as_str())
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .map(ToString::to_string);
                }
                None
            });
            let label = command
                .as_deref()
                .map(humanize_watchdog_command)
                .unwrap_or_else(|| humanize_watchdog_trigger(prefix, trigger));
            Some(format!("{label} request failed"))
        }
        "frame-stall" => {
            let monitor_kind = recent_traces.iter().rev().find_map(|trace| {
                if trace.get("kind").and_then(|v| v.as_str()) == Some("frame_stall") {
                    return trace
                        .get("fields")
                        .and_then(|fields| fields.get("monitor_kind"))
                        .and_then(|v| v.as_str())
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .map(ToString::to_string);
                }
                None
            });
            let label = monitor_kind
                .as_deref()
                .map(humanize_watchdog_source)
                .unwrap_or_else(|| "UI frame".to_string());
            Some(format!("{label} stalled"))
        }
        "local-task" => {
            let task = recent_traces.iter().rev().find_map(|trace| {
                if trace.get("kind").and_then(|v| v.as_str()) == Some("local_task") {
                    return trace.get("fields");
                }
                None
            })?;
            let command = json_field_str(task, "command").unwrap_or("local task");
            let elapsed_ms = task.get("elapsed_ms").and_then(Value::as_u64).unwrap_or(0);
            if command == "thread refresh fetch" {
                let fields = task.get("fields");
                let workspace = fields
                    .and_then(|fields| json_field_str(fields, "workspace"))
                    .unwrap_or("unknown");
                let headers_ms = fields
                    .and_then(|fields| fields.get("headersMs"))
                    .and_then(Value::as_u64)
                    .unwrap_or(0);
                let workspace_label = match workspace {
                    "wsl2" => "WSL2",
                    "windows" => "Windows",
                    _ => "unknown",
                };
                if headers_ms > 0 {
                    return Some(format!(
                        "Codex Web thread refresh waited {headers_ms}ms for {workspace_label} headers"
                    ));
                }
            }
            Some(format!(
                "{} local task took {}ms",
                humanize_watchdog_command(command),
                elapsed_ms
            ))
        }
        "heartbeat-stall" => {
            let snapshot = payload.get("snapshot");
            let mut detail = String::from("UI heartbeat stalled");
            let backend_status = snapshot.and_then(|value| value.get("backend_status"));
            let backend_in_flight = backend_status
                .and_then(|value| value.get("in_flight"))
                .and_then(|value| value.as_bool())
                == Some(true);
            let backend_stalled = backend_status
                .and_then(|value| value.get("stalled"))
                .and_then(|value| value.as_bool())
                == Some(true);
            let backend_phase = backend_status
                .and_then(|value| value.get("phase"))
                .and_then(|value| value.as_str())
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(|value| humanize_watchdog_trigger("", value));
            if backend_in_flight {
                if backend_stalled {
                    detail.push_str(" after backend status refresh stopped making progress");
                } else {
                    detail.push_str(" while backend status refresh was active");
                }
                if let Some(phase) = backend_phase {
                    detail.push_str(" at ");
                    detail.push_str(&phase);
                }
            } else if snapshot
                .and_then(|value| value.get("status_in_flight"))
                .and_then(|value| value.as_bool())
                == Some(true)
            {
                detail.push_str(" while UI status refresh was active");
            } else if snapshot
                .and_then(|value| value.get("config_in_flight"))
                .and_then(|value| value.as_bool())
                == Some(true)
            {
                detail.push_str(" while config refresh was active");
            } else if snapshot
                .and_then(|value| value.get("provider_switch_in_flight"))
                .and_then(|value| value.as_bool())
                == Some(true)
            {
                detail.push_str(" while provider switch was active");
            }
            Some(detail)
        }
        "backend-status-stall" => {
            let snapshot = payload.get("snapshot");
            let phase = snapshot
                .and_then(|value| value.get("backend_status"))
                .and_then(|value| value.get("phase"))
                .and_then(|value| value.as_str())
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(|value| humanize_watchdog_trigger("", value));
            let mut detail = String::from("Backend status refresh stalled");
            if let Some(phase) = phase {
                detail.push_str(" at ");
                detail.push_str(&phase);
            }
            Some(detail)
        }
        "backend-pipeline" => {
            let event = payload.get("pipeline_event")?;
            let route = event
                .get("route")
                .and_then(|value| value.as_str())
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or("Codex Web pipeline");
            let stage = event
                .get("stage")
                .and_then(|value| value.as_str())
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or("backend");
            let workspace = event
                .get("workspace")
                .and_then(|value| value.as_str())
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or("unknown");
            let elapsed_ms = event
                .get("elapsedMs")
                .and_then(|value| value.as_u64())
                .unwrap_or(0);
            let rebuild_ms = event
                .get("rebuildMs")
                .and_then(|value| value.as_i64())
                .and_then(|value| u64::try_from(value).ok())
                .unwrap_or(0);
            let method = event
                .get("method")
                .and_then(|value| value.as_str())
                .map(str::trim)
                .filter(|value| !value.is_empty());
            let route_label = method
                .map(|method| format!("{method} via {route}"))
                .unwrap_or_else(|| route.to_string());
            let workspace_label = match workspace {
                "wsl2" => "WSL2".to_string(),
                "windows" => "Windows".to_string(),
                _ => humanize_watchdog_trigger("", workspace),
            };
            let effective_ms = elapsed_ms.max(rebuild_ms);
            let stage_label = if rebuild_ms > elapsed_ms {
                format!("{stage} rebuild")
            } else {
                stage.to_string()
            };
            Some(format!(
                "{} {} took {}ms in {}",
                workspace_label, stage_label, effective_ms, route_label
            ))
        }
        _ => None,
    }
}

fn latest_trace_fields<'a>(payload: &'a Value, kind: &str) -> Option<&'a Value> {
    payload
        .get("recent_traces")?
        .as_array()?
        .iter()
        .rev()
        .find(|trace| trace.get("kind").and_then(Value::as_str) == Some(kind))
        .and_then(|trace| trace.get("fields"))
}

fn json_field_str<'a>(value: &'a Value, field: &str) -> Option<&'a str> {
    value
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn humanize_watchdog_source(source: &str) -> String {
    match source {
        "status_poll_interval" => "Status poll interval".to_string(),
        "manual_refresh" => "Manual refresh".to_string(),
        "status" => "Status snapshot".to_string(),
        "config" => "Config".to_string(),
        "provider_switch" => "Provider switch".to_string(),
        other => humanize_watchdog_trigger("", other),
    }
}

fn humanize_watchdog_command(command: &str) -> String {
    match command {
        "get_status" => "Status snapshot".to_string(),
        "get_local_diagnostics" => "Local diagnostics".to_string(),
        "get_remote_peer_diagnostics" => "Remote peer diagnostics".to_string(),
        "thread refresh fetch" => "Codex Web thread refresh".to_string(),
        other => humanize_watchdog_trigger("", other),
    }
}

fn humanize_watchdog_trigger(prefix: &str, trigger: &str) -> String {
    let raw = if prefix.is_empty() {
        trigger
    } else if trigger.is_empty() {
        prefix
    } else {
        trigger
    };
    raw.replace(['-', '_'], " ")
        .split_whitespace()
        .map(|part| {
            let mut chars = part.chars();
            match chars.next() {
                Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}
