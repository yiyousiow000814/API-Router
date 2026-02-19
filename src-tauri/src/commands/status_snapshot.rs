#[tauri::command]
pub(crate) fn get_status(state: tauri::State<'_, app_state::AppState>) -> serde_json::Value {
    let cfg = state.gateway.cfg.read().clone();
    let wsl_gateway_host =
        crate::platform::wsl_gateway_host::resolve_wsl_gateway_host(Some(&state.config_path));
    let now = unix_ms();
    state.gateway.router.sync_with_config(&cfg, now);
    let providers = state.gateway.router.snapshot(now);
    let manual_override = state.gateway.router.manual_override.read().clone();
    // Dashboard snapshot is intentionally compact (recent only). Full event history is queried
    // via get_event_log_entries for Event Log page, not through this status payload.
    let recent_events = state.gateway.store.list_events_split(5, 5);
    let metrics = state.gateway.store.get_metrics();
    let quota = state.gateway.store.list_quota_snapshots();
    let ledgers = state.gateway.store.list_ledgers();
    let last_activity = state.gateway.last_activity_unix_ms.load(Ordering::Relaxed);
    let active_recent = last_activity > 0 && now.saturating_sub(last_activity) < 2 * 60 * 1000;
    let (active_provider, active_reason, active_provider_counts) = if active_recent {
        let map = state.gateway.last_used_by_session.read();

        // Multiple Codex sessions can be active simultaneously, potentially routing through different
        // providers. Expose the full active provider set so the UI can mark multiple providers as
        // "effective" at once.
        //
        // Keep this a single pass so `active_provider` (most recent) and `active_provider_counts`
        // share the same time window semantics.
        let mut counts: std::collections::BTreeMap<String, u64> = std::collections::BTreeMap::new();
        let mut last: Option<crate::orchestrator::gateway::LastUsedRoute> = None;

        for v in map.values() {
            if now.saturating_sub(v.unix_ms) >= 2 * 60 * 1000 {
                continue;
            }
            *counts.entry(v.provider.clone()).or_default() += 1;
            if last
                .as_ref()
                .map(|cur| v.unix_ms > cur.unix_ms)
                .unwrap_or(true)
            {
                last = Some(v.clone());
            }
        }

        (
            last.as_ref().map(|v| v.provider.clone()),
            last.map(|v| v.reason),
            counts,
        )
    } else {
        (None, None, std::collections::BTreeMap::<String, u64>::new())
    };
    let codex_account = state
        .gateway
        .store
        .get_codex_account_snapshot()
        .unwrap_or(serde_json::json!({"ok": false}));

    let client_sessions = {
        // Best-effort: discover running Codex processes configured to use this router, even before
        // the first request is sent (Windows Terminal only).
        let gateway_token = state.secrets.get_gateway_token().unwrap_or_default();
        let expected = (!gateway_token.is_empty()).then_some(gateway_token.as_str());
        let discovered_snapshot = crate::platform::windows_terminal::discover_sessions_using_router_snapshot(
            cfg.listen.port,
            expected,
        );
        let discovered = discovered_snapshot.items;
        let discovery_is_fresh = discovered_snapshot.fresh;
        let mut seen_in_discovery: std::collections::HashSet<String> =
            std::collections::HashSet::new();

        // Track all discovered sessions, but only allow provider preference changes once we have
        // strong evidence that the session is using this gateway.
        {
            let mut map = state.gateway.client_sessions.write();
            for s in discovered {
                if !discovery_is_fresh {
                    // Stale discovery snapshots are display-only. Do not mutate runtime session
                    // state with cached rows.
                    continue;
                }
                let Some(codex_session_id) = s.codex_session_id.as_deref() else {
                    continue;
                };
                seen_in_discovery.insert(codex_session_id.to_string());
                let entry = map.entry(codex_session_id.to_string()).or_insert_with(|| {
                    crate::orchestrator::gateway::ClientSessionRuntime {
                        codex_session_id: codex_session_id.to_string(),
                        pid: s.pid,
                        wt_session: crate::platform::windows_terminal::merge_wt_session_marker(
                            None,
                            &s.wt_session,
                        ),
                        last_request_unix_ms: 0,
                        last_discovered_unix_ms: 0,
                        last_reported_model_provider: None,
                        last_reported_model: None,
                        last_reported_base_url: None,
                        agent_parent_session_id: None,
                        is_agent: s.is_agent,
                        is_review: s.is_review,
                        confirmed_router: s.router_confirmed,
                    }
                });
                entry.pid = s.pid;
                entry.wt_session = crate::platform::windows_terminal::merge_wt_session_marker(
                    entry.wt_session.as_deref(),
                    &s.wt_session,
                );
                entry.last_discovered_unix_ms =
                    next_last_discovered_unix_ms(entry.last_discovered_unix_ms, now, true);
                apply_discovered_router_confirmation(entry, s.router_confirmed, s.is_agent);
                merge_discovered_model_provider(entry, s.reported_model_provider.as_deref());
                if let Some(bu) = s.reported_base_url.as_deref() {
                    entry.last_reported_base_url = Some(bu.to_string());
                }
                if let Some(parent_sid) = s.agent_parent_session_id.as_deref() {
                    entry.agent_parent_session_id = Some(parent_sid.to_string());
                }
                if s.is_agent {
                    entry.is_agent = true;
                }
                if s.is_review {
                    entry.is_review = true;
                    entry.is_agent = true;
                }
            }
            backfill_main_confirmation_from_verified_agent(&mut map, now);
        }

        // Drop dead sessions aggressively (e.g. user Ctrl+C'd Codex).
        // We keep the persisted preference mapping in config; only the runtime list is pruned.
        {
            let mut map = state.gateway.client_sessions.write();
            static WSL_DISCOVERY_MISS_COUNTS: std::sync::OnceLock<
                std::sync::Mutex<std::collections::HashMap<String, u8>>,
            > = std::sync::OnceLock::new();
            let miss_counts = WSL_DISCOVERY_MISS_COUNTS
                .get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()));
            let mut miss_counts_guard = miss_counts.lock().ok();
            map.retain(|_, v| {
                let codex_id = v.codex_session_id.clone();
                let is_wsl_pidless = v.pid == 0
                    && v.wt_session
                        .as_deref()
                        .unwrap_or_default()
                        .trim()
                        .to_ascii_lowercase()
                        .starts_with("wsl:");
                let seen_now = seen_in_discovery.contains(&codex_id);
                let wsl_discovery_miss_count = if is_wsl_pidless {
                    if seen_now {
                        if let Some(guard) = miss_counts_guard.as_mut() {
                            guard.remove(&codex_id);
                        }
                        0
                    } else if let Some(guard) = miss_counts_guard.as_mut() {
                        let prev = guard.get(&codex_id).copied().unwrap_or(0);
                        let next =
                            next_wsl_discovery_miss_count(prev, seen_now, discovery_is_fresh);
                        if discovery_is_fresh {
                            guard.insert(codex_id.clone(), next);
                        }
                        next
                    } else {
                        0
                    }
                } else {
                    if let Some(guard) = miss_counts_guard.as_mut() {
                        guard.remove(&codex_id);
                    }
                    0
                };

                should_keep_runtime_session(
                    v,
                    now,
                    crate::platform::windows_terminal::is_pid_alive,
                    crate::platform::windows_terminal::is_wt_session_alive,
                    wsl_discovery_miss_count,
                )
            });
            if let Some(guard) = miss_counts_guard.as_mut() {
                let live_ids: std::collections::HashSet<String> =
                    map.keys().map(|k| k.to_string()).collect();
                guard.retain(|k, _| live_ids.contains(k));
            }
        }

        let map = state.gateway.client_sessions.read().clone();
        let last_used_by_session = state.gateway.last_used_by_session.read().clone();
        let mut items: Vec<_> = map.into_iter().collect();
        items.sort_by_key(|(_k, v)| {
            std::cmp::Reverse(v.last_request_unix_ms.max(v.last_discovered_unix_ms))
        });
        items.truncate(20);
        let sessions = items
            .into_iter()
            .map(|(_codex_session_id, v)| {
                // Consider a session "active" only if it has recently made requests through the router.
                // Discovery scans run frequently and should not keep sessions pinned as active forever.
                let active = session_is_active(&v, now);

                let codex_id = v.codex_session_id.clone();
                let pref = cfg
                    .routing
                    .session_preferred_providers
                    .get(&codex_id)
                    .cloned()
                    .filter(|p| cfg.providers.contains_key(p));
                let current_route = last_used_by_session
                    .get(&codex_id)
                    .filter(|route| cfg.providers.contains_key(route.provider.as_str()));
                let last_seen_unix_ms = v.last_request_unix_ms.max(v.last_discovered_unix_ms);
                serde_json::json!({
                    "id": codex_id,
                    "wt_session": v.wt_session,
                    "codex_session_id": v.codex_session_id,
                    "reported_model_provider": v.last_reported_model_provider,
                    "reported_model": v.last_reported_model,
                    "reported_base_url": v.last_reported_base_url,
                    "last_seen_unix_ms": last_seen_unix_ms,
                    "active": active,
                    "preferred_provider": pref,
                    "current_provider": current_route.as_ref().map(|route| route.provider.clone()),
                    "current_reason": current_route.as_ref().map(|route| route.reason.clone()),
                    "verified": v.confirmed_router,
                    "is_agent": v.is_agent,
                    "is_review": v.is_review
                })
            })
            .collect::<Vec<_>>();
        sessions
    };

    serde_json::json!({
      "listen": { "host": cfg.listen.host, "port": cfg.listen.port },
      "wsl_gateway_host": wsl_gateway_host,
      "preferred_provider": cfg.routing.preferred_provider,
      "manual_override": manual_override,
      "providers": providers,
      "metrics": metrics,
      "recent_events": recent_events,
      "active_provider": active_provider,
      "active_reason": active_reason,
      "active_provider_counts": active_provider_counts,
      "quota": quota,
      "ledgers": ledgers,
      "last_activity_unix_ms": last_activity,
      "codex_account": codex_account,
      "client_sessions": client_sessions
    })
}

fn merge_discovered_model_provider(
    entry: &mut crate::orchestrator::gateway::ClientSessionRuntime,
    discovered_model_provider: Option<&str>,
) {
    let Some(mp) = discovered_model_provider else {
        return;
    };
    if entry.confirmed_router {
        return;
    }
    entry.last_reported_model_provider = Some(mp.to_string());
}

fn apply_discovered_router_confirmation(
    entry: &mut crate::orchestrator::gateway::ClientSessionRuntime,
    router_confirmed: bool,
    discovered_is_agent: bool,
) {
    if !router_confirmed {
        return;
    }
    entry.confirmed_router = true;
    // For verified non-agent sessions discovered before first request, show codex provider as
    // API Router instead of blank to match gateway ownership semantics.
    if !(discovered_is_agent || entry.is_agent) {
        entry.last_reported_model_provider = Some(crate::constants::GATEWAY_MODEL_PROVIDER_ID.to_string());
    }
}

fn backfill_main_confirmation_from_verified_agent(
    map: &mut std::collections::HashMap<String, crate::orchestrator::gateway::ClientSessionRuntime>,
    _now_unix_ms: u64,
) {
    for entry in map.values_mut() {
        if !(entry.confirmed_router && entry.is_agent) {
            continue;
        }
        if entry.agent_parent_session_id.is_some() {
            continue;
        }
        let Some(parent_sid) =
            crate::platform::windows_terminal::infer_parent_session_id_for_agent_session(
                &entry.codex_session_id,
            )
        else {
            continue;
        };
        if parent_sid != entry.codex_session_id {
            entry.agent_parent_session_id = Some(parent_sid);
        }
    }

    let anchors: Vec<(u32, Option<String>, Option<String>)> = map
        .values()
        .filter(|v| v.confirmed_router && v.is_agent)
        .map(|v| (v.pid, v.wt_session.clone(), v.agent_parent_session_id.clone()))
        .collect();

    if anchors.is_empty() {
        return;
    }

    let parent_ids: std::collections::HashSet<String> = anchors
        .iter()
        .filter_map(|(_, _, parent_sid)| parent_sid.as_ref())
        .map(|sid| sid.to_string())
        .collect();

    for parent_sid in parent_ids {
        let Some(entry) = map.get_mut(&parent_sid) else {
            continue;
        };
        if entry.confirmed_router || entry.is_agent || entry.is_review {
            continue;
        }
        entry.confirmed_router = true;
        entry.last_reported_model_provider =
            Some(crate::constants::GATEWAY_MODEL_PROVIDER_ID.to_string());
    }

    for entry in map.values_mut() {
        if entry.confirmed_router || entry.is_agent || entry.is_review {
            continue;
        }
        let same_proc = anchors.iter().any(|(pid, wt, _parent_sid)| {
            let pid_match = *pid != 0 && entry.pid != 0 && *pid == entry.pid;
            let wt_match = wt
                .as_deref()
                .zip(entry.wt_session.as_deref())
                .is_some_and(|(a, b)| crate::platform::windows_terminal::wt_session_ids_equal(a, b));
            pid_match || wt_match
        });
        if !same_proc {
            continue;
        }
        entry.confirmed_router = true;
        entry.last_reported_model_provider =
            Some(crate::constants::GATEWAY_MODEL_PROVIDER_ID.to_string());
    }
}

fn session_is_active(entry: &crate::orchestrator::gateway::ClientSessionRuntime, now: u64) -> bool {
    entry.last_request_unix_ms > 0 && now.saturating_sub(entry.last_request_unix_ms) < 60_000
}

fn next_last_discovered_unix_ms(prev: u64, now: u64, discovery_is_fresh: bool) -> u64 {
    if discovery_is_fresh {
        return now;
    }
    prev
}

fn next_wsl_discovery_miss_count(prev: u8, seen_now: bool, discovery_is_fresh: bool) -> u8 {
    if seen_now {
        return 0;
    }
    if !discovery_is_fresh {
        return prev;
    }
    prev.saturating_add(1)
}

fn should_keep_runtime_session(
    entry: &crate::orchestrator::gateway::ClientSessionRuntime,
    now: u64,
    is_pid_alive: fn(u32) -> bool,
    is_wt_session_alive: fn(&str) -> bool,
    wsl_discovery_miss_count: u8,
) -> bool {
    const WSL_MAX_DISCOVERY_MISSES: u8 = 3;
    const PIDLESS_WT_MAX_STALE_MS: u64 = 15 * 60 * 1000;

    let active = session_is_active(entry, now);
    if entry.is_agent && !active {
        return false;
    }
    if entry.pid != 0 && !is_pid_alive(entry.pid) {
        return false;
    }
    if entry.pid == 0 {
        let wt = entry.wt_session.as_deref().unwrap_or_default().trim();
        let is_wsl_marker = wt.to_ascii_lowercase().starts_with("wsl:");
        if is_wsl_marker {
            // WSL sessions usually have pid=0 on Windows side. Use consecutive discovery misses
            // to avoid flicker from one-off scan failures while still removing quickly after Ctrl+C.
            if wsl_discovery_miss_count >= WSL_MAX_DISCOVERY_MISSES {
                return false;
            }
        }

        if !wt.is_empty() {
            let last_seen = entry.last_request_unix_ms.max(entry.last_discovered_unix_ms);
            let stale_too_long = last_seen == 0 || now.saturating_sub(last_seen) > PIDLESS_WT_MAX_STALE_MS;
            if !active && stale_too_long {
                return false;
            }
            // WT tab identity is a hard liveness boundary for pid=0 sessions.
            if !is_wt_session_alive(wt) {
                return false;
            }
        } else if !active {
            return false;
        }
    }
    true
}

fn local_day_key_from_unix_ms(ts_unix_ms: u64) -> Option<String> {
    let ts = i64::try_from(ts_unix_ms).ok()?;
    let dt = Local.timestamp_millis_opt(ts).single()?;
    Some(dt.format("%Y-%m-%d").to_string())
}

fn day_start_unix_ms_from_day_key(day_key: &str) -> Option<u64> {
    let date = chrono::NaiveDate::parse_from_str(day_key, "%Y-%m-%d").ok()?;
    let dt = Local
        .with_ymd_and_hms(
            chrono::Datelike::year(&date),
            chrono::Datelike::month(&date),
            chrono::Datelike::day(&date),
            0,
            0,
            0,
        )
        .single()?;
    u64::try_from(dt.timestamp_millis()).ok()
}

fn event_query_key(e: &Value) -> Option<String> {
    let unix_ms = e.get("unix_ms").and_then(|v| v.as_u64())?;
    let provider = e.get("provider").and_then(|v| v.as_str()).unwrap_or("");
    let level = e.get("level").and_then(|v| v.as_str()).unwrap_or("");
    let code = e.get("code").and_then(|v| v.as_str()).unwrap_or("");
    let message = e.get("message").and_then(|v| v.as_str()).unwrap_or("");
    let fields = e
        .get("fields")
        .and_then(|v| serde_json::to_string(v).ok())
        .unwrap_or_default();
    Some(format!(
        "{unix_ms}|{provider}|{level}|{code}|{message}|{fields}"
    ))
}

fn event_shape_is_valid(e: &Value) -> bool {
    e.get("unix_ms").and_then(|v| v.as_u64()).is_some()
        && e.get("provider").and_then(|v| v.as_str()).is_some()
        && e.get("level").and_then(|v| v.as_str()).is_some()
        && e.get("code").and_then(|v| v.as_str()).is_some()
        && e.get("message").and_then(|v| v.as_str()).is_some()
}

const EVENT_LOG_QUERY_DEFAULT_LIMIT: usize = 2000;
const EVENT_LOG_QUERY_MAX_LIMIT: usize = 5000;

fn normalize_event_query_limit(limit: Option<usize>) -> usize {
    limit
        .unwrap_or(EVENT_LOG_QUERY_DEFAULT_LIMIT)
        .clamp(1, EVENT_LOG_QUERY_MAX_LIMIT)
}

fn event_in_time_window(e: &Value, from: Option<u64>, to: Option<u64>) -> bool {
    let Some(unix_ms) = e.get("unix_ms").and_then(|v| v.as_u64()) else {
        return false;
    };
    if let Some(from_ms) = from {
        if unix_ms < from_ms {
            return false;
        }
    }
    if let Some(to_ms) = to {
        if unix_ms > to_ms {
            return false;
        }
    }
    true
}

fn append_backup_events(
    out: &mut Vec<Value>,
    dedup: &mut std::collections::HashSet<String>,
    data_root: &std::path::Path,
    from: Option<u64>,
    to: Option<u64>,
    cap: usize,
) {
    if out.len() >= cap {
        return;
    }
    let Ok(entries) = std::fs::read_dir(data_root) else {
        return;
    };
    for entry in entries.flatten() {
        if out.len() >= cap {
            break;
        }
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|s| s.to_str()) else {
            continue;
        };
        let include = name.starts_with("sled.backup.")
            || name.starts_with("sled.manual-backup.")
            || name.starts_with("sled.bak.");
        if !include {
            continue;
        }
        let Ok(db) = sled::open(&path) else {
            continue;
        };
        for item in db.scan_prefix(b"event:").rev() {
            if out.len() >= cap {
                break;
            }
            let Ok((_, v)) = item else {
                continue;
            };
            let Ok(e) = serde_json::from_slice::<Value>(&v) else {
                continue;
            };
            if !event_shape_is_valid(&e) {
                continue;
            }
            if !event_in_time_window(&e, from, to) {
                continue;
            }
            let Some(key) = event_query_key(&e) else {
                continue;
            };
            if dedup.insert(key) {
                out.push(e);
            }
        }
    }
}

fn backup_data_root_from_config_path(config_path: &std::path::Path) -> std::path::PathBuf {
    config_path
        .parent()
        .unwrap_or(std::path::Path::new("."))
        .join("data")
}

fn append_backup_event_years(years: &mut std::collections::BTreeSet<i32>, backup_root: &std::path::Path) {
    let Ok(entries) = std::fs::read_dir(backup_root) else {
        return;
    };
    let mut dirs: Vec<std::path::PathBuf> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let include = name.starts_with("sled.backup.")
            || name.starts_with("sled.manual-backup.")
            || name.starts_with("sled.bak.");
        if include && path.is_dir() {
            dirs.push(path);
        }
    }
    dirs.sort();
    for path in dirs {
        let Ok(db) = sled::open(&path) else {
            continue;
        };
        for item in db.scan_prefix(b"event:") {
            let Ok((k, _)) = item else {
                continue;
            };
            let Some(body) = k.as_ref().strip_prefix(b"event:") else {
                continue;
            };
            let Some(split_at) = body.iter().position(|b| *b == b':') else {
                continue;
            };
            let ts_bytes = &body[..split_at];
            let Ok(ts_str) = std::str::from_utf8(ts_bytes) else {
                continue;
            };
            let Ok(unix_ms) = ts_str.parse::<u64>() else {
                continue;
            };
            let Ok(ts) = i64::try_from(unix_ms) else {
                continue;
            };
            if let chrono::LocalResult::Single(dt) = chrono::Local.timestamp_millis_opt(ts) {
                years.insert(chrono::Datelike::year(&dt));
            }
        }
    }
}

fn append_backup_event_daily_stats(
    rows: &mut Vec<Value>,
    backup_root: &std::path::Path,
    from: Option<u64>,
    to: Option<u64>,
) {
    let Ok(entries) = std::fs::read_dir(backup_root) else {
        return;
    };
    let mut existing_days: std::collections::HashSet<String> = rows
        .iter()
        .filter_map(|row| row.get("day").and_then(|v| v.as_str()).map(str::to_string))
        .collect();
    let mut dirs: Vec<std::path::PathBuf> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let include = name.starts_with("sled.backup.")
            || name.starts_with("sled.manual-backup.")
            || name.starts_with("sled.bak.");
        if include && path.is_dir() {
            dirs.push(path);
        }
    }
    dirs.sort();
    let mut day_counts: std::collections::BTreeMap<String, (u64, u64, u64, u64)> =
        std::collections::BTreeMap::new();
    for path in dirs {
        let Ok(db) = sled::open(&path) else {
            continue;
        };
        for item in db.scan_prefix(b"event:") {
            let Ok((_, v)) = item else {
                continue;
            };
            let Ok(e) = serde_json::from_slice::<Value>(&v) else {
                continue;
            };
            if !event_shape_is_valid(&e) {
                continue;
            }
            if !event_in_time_window(&e, from, to) {
                continue;
            }
            let Some(unix_ms) = e.get("unix_ms").and_then(|v| v.as_u64()) else {
                continue;
            };
            let Some(day_key) = local_day_key_from_unix_ms(unix_ms) else {
                continue;
            };
            if existing_days.contains(&day_key) {
                continue;
            }
            let level = e.get("level").and_then(|v| v.as_str()).unwrap_or("info");
            let row = day_counts.entry(day_key).or_insert((0, 0, 0, 0));
            row.0 = row.0.saturating_add(1);
            match level {
                "error" => row.3 = row.3.saturating_add(1),
                "warning" => row.2 = row.2.saturating_add(1),
                _ => row.1 = row.1.saturating_add(1),
            }
        }
    }
    for (day, (total, infos, warnings, errors)) in day_counts {
        let Some(day_start_unix_ms) = day_start_unix_ms_from_day_key(&day) else {
            continue;
        };
        rows.push(serde_json::json!({
            "day": day,
            "day_start_unix_ms": day_start_unix_ms,
            "total": total,
            "infos": infos,
            "warnings": warnings,
            "errors": errors,
        }));
        let _ = existing_days.insert(day);
    }
}

#[tauri::command]
pub(crate) fn get_event_log_entries(
    state: tauri::State<'_, app_state::AppState>,
    from_unix_ms: Option<u64>,
    to_unix_ms: Option<u64>,
    limit: Option<usize>,
) -> serde_json::Value {
    let (from, to) = match (from_unix_ms, to_unix_ms) {
        (Some(from), Some(to)) if from > to => (Some(to), Some(from)),
        _ => (from_unix_ms, to_unix_ms),
    };
    let cap = normalize_event_query_limit(limit);
    let mut events = state.gateway.store.list_events_range(from, to, Some(cap));
    events.retain(event_shape_is_valid);
    let mut dedup = std::collections::HashSet::<String>::new();
    for e in &events {
        if let Some(key) = event_query_key(e) {
            let _ = dedup.insert(key);
        }
    }
    let backup_root = state
        .config_path
        .as_path();
    let backup_root = backup_data_root_from_config_path(backup_root);
    append_backup_events(&mut events, &mut dedup, &backup_root, from, to, cap);
    events.sort_by(|a, b| {
        let a_ts = a.get("unix_ms").and_then(|v| v.as_u64()).unwrap_or(0);
        let b_ts = b.get("unix_ms").and_then(|v| v.as_u64()).unwrap_or(0);
        b_ts.cmp(&a_ts)
    });
    events.truncate(cap);
    serde_json::Value::Array(events)
}

#[tauri::command]
pub(crate) fn get_event_log_years(state: tauri::State<'_, app_state::AppState>) -> Vec<i32> {
    let mut years = state.gateway.store.list_event_years();
    let backup_root = backup_data_root_from_config_path(state.config_path.as_path());
    append_backup_event_years(&mut years, &backup_root);
    years.into_iter().collect()
}

#[tauri::command]
pub(crate) fn get_event_log_daily_stats(
    state: tauri::State<'_, app_state::AppState>,
    from_unix_ms: Option<u64>,
    to_unix_ms: Option<u64>,
) -> serde_json::Value {
    let (from, to) = match (from_unix_ms, to_unix_ms) {
        (Some(from), Some(to)) if from > to => (Some(to), Some(from)),
        _ => (from_unix_ms, to_unix_ms),
    };
    let mut rows = state.gateway.store.list_event_daily_counts_range(from, to);
    let backup_root = backup_data_root_from_config_path(state.config_path.as_path());
    append_backup_event_daily_stats(&mut rows, &backup_root, from, to);
    rows.sort_by_key(|row| row.get("day_start_unix_ms").and_then(|v| v.as_u64()).unwrap_or(0));
    serde_json::Value::Array(rows)
}

#[cfg(test)]
mod tests {
    use crate::constants::GATEWAY_MODEL_PROVIDER_ID;
    use crate::commands::{
        apply_discovered_router_confirmation, backfill_main_confirmation_from_verified_agent,
        append_backup_event_daily_stats, day_start_unix_ms_from_day_key, event_query_key,
        merge_discovered_model_provider, next_last_discovered_unix_ms, normalize_event_query_limit,
        next_wsl_discovery_miss_count,
        should_keep_runtime_session,
    };
    use crate::orchestrator::gateway::ClientSessionRuntime;
    use chrono::TimeZone;

    #[test]
    fn discovered_provider_does_not_override_confirmed_gateway_session() {
        let mut entry = ClientSessionRuntime {
            codex_session_id: "s1".to_string(),
            pid: 1,
            wt_session: None,
            last_request_unix_ms: 1,
            last_discovered_unix_ms: 1,
            last_reported_model_provider: Some(GATEWAY_MODEL_PROVIDER_ID.to_string()),
            last_reported_model: None,
            last_reported_base_url: None,
            agent_parent_session_id: None,
            is_agent: false,
            is_review: false,
            confirmed_router: true,
        };
        merge_discovered_model_provider(&mut entry, Some("openai"));
        assert_eq!(
            entry.last_reported_model_provider.as_deref(),
            Some(GATEWAY_MODEL_PROVIDER_ID)
        );
    }

    #[test]
    fn normalize_event_query_limit_applies_default_and_cap() {
        assert_eq!(normalize_event_query_limit(None), 2000);
        assert_eq!(normalize_event_query_limit(Some(0)), 1);
        assert_eq!(normalize_event_query_limit(Some(999_999)), 5000);
    }

    #[test]
    fn event_query_key_distinguishes_fields_payload() {
        let a = serde_json::json!({
            "unix_ms": 1,
            "provider": "gateway",
            "level": "info",
            "code": "x",
            "message": "same",
            "fields": { "codex_session_id": "s1" }
        });
        let b = serde_json::json!({
            "unix_ms": 1,
            "provider": "gateway",
            "level": "info",
            "code": "x",
            "message": "same",
            "fields": { "codex_session_id": "s2" }
        });
        assert_ne!(event_query_key(&a), event_query_key(&b));
    }

    #[test]
    fn append_backup_event_daily_stats_adds_missing_backup_day() {
        let tmp = tempfile::tempdir().unwrap();
        let backup = tmp.path().join("sled.backup.test");
        std::fs::create_dir_all(&backup).unwrap();
        let db = sled::open(&backup).unwrap();
        let ts = chrono::Local
            .with_ymd_and_hms(2026, 2, 17, 12, 0, 0)
            .single()
            .unwrap()
            .timestamp_millis() as u64;
        let key = format!("event:{ts}:a");
        let v = serde_json::json!({
            "provider": "gateway",
            "level": "warning",
            "unix_ms": ts,
            "code": "test_backup_day",
            "message": "backup only",
            "fields": {}
        });
        db.insert(key.as_bytes(), serde_json::to_vec(&v).unwrap()).unwrap();
        db.flush().unwrap();
        drop(db);

        let mut rows: Vec<serde_json::Value> = Vec::new();
        append_backup_event_daily_stats(&mut rows, tmp.path(), None, None);

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].get("day").and_then(|v| v.as_str()), Some("2026-02-17"));
        assert_eq!(rows[0].get("warnings").and_then(|v| v.as_u64()), Some(1));
    }

    #[test]
    fn append_backup_event_daily_stats_does_not_duplicate_existing_day() {
        let tmp = tempfile::tempdir().unwrap();
        let backup = tmp.path().join("sled.backup.test2");
        std::fs::create_dir_all(&backup).unwrap();
        let db = sled::open(&backup).unwrap();
        let ts = chrono::Local
            .with_ymd_and_hms(2026, 2, 19, 12, 0, 0)
            .single()
            .unwrap()
            .timestamp_millis() as u64;
        let key = format!("event:{ts}:b");
        let v = serde_json::json!({
            "provider": "gateway",
            "level": "error",
            "unix_ms": ts,
            "code": "test_backup_day_dup",
            "message": "duplicate day",
            "fields": {}
        });
        db.insert(key.as_bytes(), serde_json::to_vec(&v).unwrap()).unwrap();
        db.flush().unwrap();
        drop(db);

        let day_start = day_start_unix_ms_from_day_key("2026-02-19").unwrap();
        let mut rows: Vec<serde_json::Value> = vec![serde_json::json!({
            "day": "2026-02-19",
            "day_start_unix_ms": day_start,
            "total": 3,
            "infos": 2,
            "warnings": 1,
            "errors": 0
        })];
        append_backup_event_daily_stats(&mut rows, tmp.path(), None, None);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].get("total").and_then(|v| v.as_u64()), Some(3));
    }

    #[test]
    fn discovered_provider_sets_value_when_session_not_confirmed() {
        let mut entry = ClientSessionRuntime {
            codex_session_id: "s2".to_string(),
            pid: 1,
            wt_session: None,
            last_request_unix_ms: 0,
            last_discovered_unix_ms: 1,
            last_reported_model_provider: None,
            last_reported_model: None,
            last_reported_base_url: None,
            agent_parent_session_id: None,
            is_agent: false,
            is_review: false,
            confirmed_router: false,
        };
        merge_discovered_model_provider(&mut entry, Some("openai"));
        assert_eq!(entry.last_reported_model_provider.as_deref(), Some("openai"));
    }

    #[test]
    fn confirmed_non_agent_discovery_sets_gateway_provider() {
        let mut entry = ClientSessionRuntime {
            codex_session_id: "s3".to_string(),
            pid: 1,
            wt_session: None,
            last_request_unix_ms: 0,
            last_discovered_unix_ms: 1,
            last_reported_model_provider: None,
            last_reported_model: None,
            last_reported_base_url: None,
            agent_parent_session_id: None,
            is_agent: false,
            is_review: false,
            confirmed_router: false,
        };
        apply_discovered_router_confirmation(&mut entry, true, false);
        assert!(entry.confirmed_router);
        assert_eq!(
            entry.last_reported_model_provider.as_deref(),
            Some(GATEWAY_MODEL_PROVIDER_ID)
        );
    }

    #[test]
    fn confirmed_agent_discovery_keeps_provider_unset() {
        let mut entry = ClientSessionRuntime {
            codex_session_id: "s4".to_string(),
            pid: 1,
            wt_session: None,
            last_request_unix_ms: 0,
            last_discovered_unix_ms: 1,
            last_reported_model_provider: None,
            last_reported_model: None,
            last_reported_base_url: None,
            agent_parent_session_id: None,
            is_agent: true,
            is_review: false,
            confirmed_router: false,
        };
        apply_discovered_router_confirmation(&mut entry, true, true);
        assert!(entry.confirmed_router);
        assert_eq!(entry.last_reported_model_provider.as_deref(), None);
    }

    #[test]
    fn verified_review_backfills_main_session_confirmation() {
        let mut map = std::collections::HashMap::new();
        map.insert(
            "main".to_string(),
            ClientSessionRuntime {
                codex_session_id: "main".to_string(),
                pid: 9527,
                wt_session: Some("wt-1".to_string()),
                last_request_unix_ms: 0,
                last_discovered_unix_ms: 1,
                last_reported_model_provider: None,
                last_reported_model: None,
                last_reported_base_url: None,
                agent_parent_session_id: None,
                is_agent: false,
                is_review: false,
                confirmed_router: false,
            },
        );
        map.insert(
            "review".to_string(),
            ClientSessionRuntime {
                codex_session_id: "review".to_string(),
                pid: 9527,
                wt_session: Some("wt-1".to_string()),
                last_request_unix_ms: 0,
                last_discovered_unix_ms: 1,
                last_reported_model_provider: None,
                last_reported_model: None,
                last_reported_base_url: None,
                agent_parent_session_id: None,
                is_agent: true,
                is_review: true,
                confirmed_router: true,
            },
        );

        backfill_main_confirmation_from_verified_agent(&mut map, 1);

        let main = map.get("main").expect("main row");
        assert!(main.confirmed_router);
        assert_eq!(
            main.last_reported_model_provider.as_deref(),
            Some(GATEWAY_MODEL_PROVIDER_ID)
        );
    }

    #[test]
    fn backfill_can_confirm_old_main_session_when_review_verified() {
        let mut map = std::collections::HashMap::new();
        map.insert(
            "main_old".to_string(),
            ClientSessionRuntime {
                codex_session_id: "main_old".to_string(),
                pid: 9527,
                wt_session: Some("wt-1".to_string()),
                last_request_unix_ms: 0,
                last_discovered_unix_ms: 1,
                last_reported_model_provider: None,
                last_reported_model: None,
                last_reported_base_url: None,
                agent_parent_session_id: None,
                is_agent: false,
                is_review: false,
                confirmed_router: false,
            },
        );
        map.insert(
            "review_now".to_string(),
            ClientSessionRuntime {
                codex_session_id: "review_now".to_string(),
                pid: 9527,
                wt_session: Some("wt-1".to_string()),
                last_request_unix_ms: 0,
                last_discovered_unix_ms: 2,
                last_reported_model_provider: None,
                last_reported_model: None,
                last_reported_base_url: None,
                agent_parent_session_id: None,
                is_agent: true,
                is_review: true,
                confirmed_router: true,
            },
        );

        backfill_main_confirmation_from_verified_agent(&mut map, 2);

        let main = map.get("main_old").expect("main_old row");
        assert!(main.confirmed_router);
        assert_eq!(
            main.last_reported_model_provider.as_deref(),
            Some(GATEWAY_MODEL_PROVIDER_ID)
        );
    }

    #[test]
    fn verified_review_recent_request_backfills_main_without_discovery_now() {
        let mut map = std::collections::HashMap::new();
        map.insert(
            "main_now".to_string(),
            ClientSessionRuntime {
                codex_session_id: "main_now".to_string(),
                pid: 9527,
                wt_session: Some("wt-1".to_string()),
                last_request_unix_ms: 0,
                last_discovered_unix_ms: 2_000,
                last_reported_model_provider: None,
                last_reported_model: None,
                last_reported_base_url: None,
                agent_parent_session_id: None,
                is_agent: false,
                is_review: false,
                confirmed_router: false,
            },
        );
        map.insert(
            "review_active".to_string(),
            ClientSessionRuntime {
                codex_session_id: "review_active".to_string(),
                pid: 9527,
                wt_session: Some("wt-1".to_string()),
                last_request_unix_ms: 1_995,
                last_discovered_unix_ms: 1,
                last_reported_model_provider: None,
                last_reported_model: None,
                last_reported_base_url: None,
                agent_parent_session_id: None,
                is_agent: true,
                is_review: true,
                confirmed_router: true,
            },
        );

        backfill_main_confirmation_from_verified_agent(&mut map, 2_000);

        let main = map.get("main_now").expect("main_now row");
        assert!(main.confirmed_router);
        assert_eq!(
            main.last_reported_model_provider.as_deref(),
            Some(GATEWAY_MODEL_PROVIDER_ID)
        );
    }

    #[test]
    fn verified_agent_backfills_main_by_same_wt_without_review_flag() {
        let mut map = std::collections::HashMap::new();
        map.insert(
            "main_agent_wt".to_string(),
            ClientSessionRuntime {
                codex_session_id: "main_agent_wt".to_string(),
                pid: 0,
                wt_session: Some("wsl:abc-123".to_string()),
                last_request_unix_ms: 0,
                last_discovered_unix_ms: 2_000,
                last_reported_model_provider: None,
                last_reported_model: None,
                last_reported_base_url: None,
                agent_parent_session_id: None,
                is_agent: false,
                is_review: false,
                confirmed_router: false,
            },
        );
        map.insert(
            "agent_tool".to_string(),
            ClientSessionRuntime {
                codex_session_id: "agent_tool".to_string(),
                pid: 0,
                wt_session: Some("abc-123".to_string()),
                last_request_unix_ms: 1_995,
                last_discovered_unix_ms: 1,
                last_reported_model_provider: None,
                last_reported_model: None,
                last_reported_base_url: None,
                agent_parent_session_id: None,
                is_agent: true,
                is_review: false,
                confirmed_router: true,
            },
        );

        backfill_main_confirmation_from_verified_agent(&mut map, 2_000);

        let main = map.get("main_agent_wt").expect("main_agent_wt row");
        assert!(main.confirmed_router);
        assert_eq!(
            main.last_reported_model_provider.as_deref(),
            Some(GATEWAY_MODEL_PROVIDER_ID)
        );
    }

    #[test]
    fn verified_agent_backfills_main_by_parent_sid_without_wt_or_pid_match() {
        let mut map = std::collections::HashMap::new();
        map.insert(
            "main_from_parent".to_string(),
            ClientSessionRuntime {
                codex_session_id: "main_from_parent".to_string(),
                pid: 0,
                wt_session: None,
                last_request_unix_ms: 0,
                last_discovered_unix_ms: 2_000,
                last_reported_model_provider: None,
                last_reported_model: None,
                last_reported_base_url: None,
                agent_parent_session_id: None,
                is_agent: false,
                is_review: false,
                confirmed_router: false,
            },
        );
        map.insert(
            "agent_with_parent".to_string(),
            ClientSessionRuntime {
                codex_session_id: "agent_with_parent".to_string(),
                pid: 0,
                wt_session: None,
                last_request_unix_ms: 1_995,
                last_discovered_unix_ms: 1,
                last_reported_model_provider: None,
                last_reported_model: None,
                last_reported_base_url: None,
                agent_parent_session_id: Some("main_from_parent".to_string()),
                is_agent: true,
                is_review: false,
                confirmed_router: true,
            },
        );

        backfill_main_confirmation_from_verified_agent(&mut map, 2_000);

        let main = map.get("main_from_parent").expect("main_from_parent row");
        assert!(main.confirmed_router);
        assert_eq!(
            main.last_reported_model_provider.as_deref(),
            Some(GATEWAY_MODEL_PROVIDER_ID)
        );
    }

    #[cfg(windows)]
    #[test]
    fn verified_agent_backfills_main_from_tui_parent_lookup_when_runtime_parent_missing() {
        use std::io::Write;

        let tmp = tempfile::tempdir().expect("tmpdir");
        let codex_home = tmp.path().join(".codex");
        let log_dir = codex_home.join("log");
        std::fs::create_dir_all(&log_dir).expect("mkdir");
        let log_path = log_dir.join("codex-tui.log");

        let main_sid = "019c67c0-c95d-7b10-a0a1-fc576b458272";
        let agent_sid = "019c6bc7-1636-7730-ae5a-03f9d3417528";
        let mut f = std::fs::File::create(&log_path).expect("create");
        writeln!(
            f,
            "2026-02-17T13:25:35.418912Z  INFO session_loop{{thread_id={main_sid}}}:session_loop{{thread_id={agent_sid}}}: codex_core::codex: new"
        )
        .unwrap();

        let prev_codex_home = std::env::var("CODEX_HOME").ok();
        std::env::set_var("CODEX_HOME", &codex_home);

        let mut map = std::collections::HashMap::new();
        map.insert(
            main_sid.to_string(),
            ClientSessionRuntime {
                codex_session_id: main_sid.to_string(),
                pid: 0,
                wt_session: None,
                last_request_unix_ms: 0,
                last_discovered_unix_ms: 2_000,
                last_reported_model_provider: None,
                last_reported_model: None,
                last_reported_base_url: None,
                agent_parent_session_id: None,
                is_agent: false,
                is_review: false,
                confirmed_router: false,
            },
        );
        map.insert(
            agent_sid.to_string(),
            ClientSessionRuntime {
                codex_session_id: agent_sid.to_string(),
                pid: 0,
                wt_session: None,
                last_request_unix_ms: 1_995,
                last_discovered_unix_ms: 1,
                last_reported_model_provider: None,
                last_reported_model: None,
                last_reported_base_url: None,
                agent_parent_session_id: None,
                is_agent: true,
                is_review: false,
                confirmed_router: true,
            },
        );

        backfill_main_confirmation_from_verified_agent(&mut map, 2_000);

        match prev_codex_home {
            Some(v) => std::env::set_var("CODEX_HOME", v),
            None => std::env::remove_var("CODEX_HOME"),
        }

        let main = map.get(main_sid).expect("main row");
        assert!(main.confirmed_router);
        assert_eq!(
            main.last_reported_model_provider.as_deref(),
            Some(GATEWAY_MODEL_PROVIDER_ID)
        );
    }

    #[test]
    fn verified_review_backfills_main_when_wsl_prefix_differs() {
        let mut map = std::collections::HashMap::new();
        map.insert(
            "main_wsl".to_string(),
            ClientSessionRuntime {
                codex_session_id: "main_wsl".to_string(),
                pid: 0,
                wt_session: Some("wsl:ABC-123".to_string()),
                last_request_unix_ms: 0,
                last_discovered_unix_ms: 2_000,
                last_reported_model_provider: None,
                last_reported_model: None,
                last_reported_base_url: None,
                agent_parent_session_id: None,
                is_agent: false,
                is_review: false,
                confirmed_router: false,
            },
        );
        map.insert(
            "review_wsl".to_string(),
            ClientSessionRuntime {
                codex_session_id: "review_wsl".to_string(),
                pid: 0,
                wt_session: Some("abc-123".to_string()),
                last_request_unix_ms: 1_995,
                last_discovered_unix_ms: 1,
                last_reported_model_provider: None,
                last_reported_model: None,
                last_reported_base_url: None,
                agent_parent_session_id: None,
                is_agent: true,
                is_review: true,
                confirmed_router: true,
            },
        );

        backfill_main_confirmation_from_verified_agent(&mut map, 2_000);

        let main = map.get("main_wsl").expect("main_wsl row");
        assert!(main.confirmed_router);
        assert_eq!(
            main.last_reported_model_provider.as_deref(),
            Some(GATEWAY_MODEL_PROVIDER_ID)
        );
    }

    #[test]
    fn verified_review_backfills_main_when_wsl_prefix_differs_reverse() {
        let mut map = std::collections::HashMap::new();
        map.insert(
            "main_wsl_rev".to_string(),
            ClientSessionRuntime {
                codex_session_id: "main_wsl_rev".to_string(),
                pid: 0,
                wt_session: Some("abc-xyz".to_string()),
                last_request_unix_ms: 0,
                last_discovered_unix_ms: 2_000,
                last_reported_model_provider: None,
                last_reported_model: None,
                last_reported_base_url: None,
                agent_parent_session_id: None,
                is_agent: false,
                is_review: false,
                confirmed_router: false,
            },
        );
        map.insert(
            "review_wsl_rev".to_string(),
            ClientSessionRuntime {
                codex_session_id: "review_wsl_rev".to_string(),
                pid: 0,
                wt_session: Some("wsl:ABC-XYZ".to_string()),
                last_request_unix_ms: 1_995,
                last_discovered_unix_ms: 1,
                last_reported_model_provider: None,
                last_reported_model: None,
                last_reported_base_url: None,
                agent_parent_session_id: None,
                is_agent: true,
                is_review: true,
                confirmed_router: true,
            },
        );

        backfill_main_confirmation_from_verified_agent(&mut map, 2_000);

        let main = map.get("main_wsl_rev").expect("main_wsl_rev row");
        assert!(main.confirmed_router);
        assert_eq!(
            main.last_reported_model_provider.as_deref(),
            Some(GATEWAY_MODEL_PROVIDER_ID)
        );
    }

    #[test]
    fn stale_wsl_session_drops_even_when_wt_session_is_alive() {
        let now = 100_000_u64;
        let entry = ClientSessionRuntime {
            codex_session_id: "wsl-old".to_string(),
            pid: 0,
            wt_session: Some("wsl:test-wt".to_string()),
            last_request_unix_ms: now.saturating_sub(120_000),
            last_discovered_unix_ms: now.saturating_sub(30_000),
            last_reported_model_provider: None,
            last_reported_model: None,
            last_reported_base_url: None,
            agent_parent_session_id: None,
            is_agent: false,
            is_review: false,
            confirmed_router: true,
        };

        let keep = should_keep_runtime_session(&entry, now, |_pid| true, |_wt| true, 3);
        assert!(!keep);
    }

    #[test]
    fn recent_wsl_discovery_keeps_idle_session_when_wt_alive() {
        let now = 100_000_u64;
        let entry = ClientSessionRuntime {
            codex_session_id: "wsl-recent".to_string(),
            pid: 0,
            wt_session: Some("wsl:test-wt".to_string()),
            last_request_unix_ms: now.saturating_sub(120_000),
            last_discovered_unix_ms: now.saturating_sub(5_000),
            last_reported_model_provider: None,
            last_reported_model: None,
            last_reported_base_url: None,
            agent_parent_session_id: None,
            is_agent: false,
            is_review: false,
            confirmed_router: true,
        };

        let keep = should_keep_runtime_session(&entry, now, |_pid| true, |_wt| true, 1);
        assert!(keep);
    }

    #[test]
    fn active_wsl_session_drops_when_discovery_is_stale() {
        let now = 100_000_u64;
        let entry = ClientSessionRuntime {
            codex_session_id: "wsl-active".to_string(),
            pid: 0,
            wt_session: Some("wsl:test-wt".to_string()),
            last_request_unix_ms: now.saturating_sub(5_000),
            last_discovered_unix_ms: now.saturating_sub(45_000),
            last_reported_model_provider: None,
            last_reported_model: None,
            last_reported_base_url: None,
            agent_parent_session_id: None,
            is_agent: false,
            is_review: false,
            confirmed_router: true,
        };

        let keep = should_keep_runtime_session(&entry, now, |_pid| true, |_wt| true, 3);
        assert!(!keep);
    }

    #[test]
    fn active_wsl_session_keeps_when_discovery_is_recent() {
        let now = 100_000_u64;
        let entry = ClientSessionRuntime {
            codex_session_id: "wsl-active-recent".to_string(),
            pid: 0,
            wt_session: Some("wsl:test-wt".to_string()),
            last_request_unix_ms: now.saturating_sub(5_000),
            last_discovered_unix_ms: now.saturating_sub(2_000),
            last_reported_model_provider: None,
            last_reported_model: None,
            last_reported_base_url: None,
            agent_parent_session_id: None,
            is_agent: false,
            is_review: false,
            confirmed_router: true,
        };

        let keep = should_keep_runtime_session(&entry, now, |_pid| true, |_wt| true, 0);
        assert!(keep);
    }

    #[test]
    fn pidless_wt_session_drops_when_stale_too_long_even_if_wt_alive() {
        let now = 2_000_000_u64;
        let entry = ClientSessionRuntime {
            codex_session_id: "pidless-stale".to_string(),
            pid: 0,
            wt_session: Some("abc-wt".to_string()),
            last_request_unix_ms: now.saturating_sub(20 * 60 * 1000),
            last_discovered_unix_ms: now.saturating_sub(20 * 60 * 1000),
            last_reported_model_provider: None,
            last_reported_model: None,
            last_reported_base_url: None,
            agent_parent_session_id: None,
            is_agent: false,
            is_review: false,
            confirmed_router: true,
        };

        let keep = should_keep_runtime_session(&entry, now, |_pid| true, |_wt| true, 0);
        assert!(!keep);
    }

    #[test]
    fn wsl_discovery_miss_count_skips_increment_when_discovery_is_stale() {
        assert_eq!(
            next_wsl_discovery_miss_count(2, false, false),
            2
        );
    }

    #[test]
    fn wsl_discovery_miss_count_increments_when_discovery_is_fresh() {
        assert_eq!(
            next_wsl_discovery_miss_count(2, false, true),
            3
        );
    }

    #[test]
    fn wsl_discovery_miss_count_resets_when_seen_in_discovery() {
        assert_eq!(
            next_wsl_discovery_miss_count(2, true, false),
            0
        );
    }

    #[test]
    fn last_discovered_timestamp_is_not_overwritten_by_stale_discovery() {
        assert_eq!(next_last_discovered_unix_ms(1234, 9999, false), 1234);
        assert_eq!(next_last_discovered_unix_ms(1234, 9999, true), 9999);
    }
}

fn local_day_range_from_key(day_key: &str) -> Option<(u64, u64)> {
    let date = NaiveDate::parse_from_str(day_key, "%Y-%m-%d").ok()?;
    let start_naive = date.and_hms_opt(0, 0, 0)?;
    let start = match Local.from_local_datetime(&start_naive) {
        LocalResult::Single(dt) => dt,
        LocalResult::Ambiguous(a, b) => a.min(b),
        LocalResult::None => return None,
    };
    let end = start + chrono::Duration::days(1);
    let start_ms = u64::try_from(start.timestamp_millis()).ok()?;
    let end_ms = u64::try_from(end.timestamp_millis()).ok()?;
    Some((start_ms, end_ms))
}

fn add_package_total_segment_by_day(
    by_day: &mut BTreeMap<String, f64>,
    package_total_usd: f64,
    segment_start_unix_ms: u64,
    segment_end_unix_ms: u64,
    window_start_unix_ms: u64,
    window_end_unix_ms: u64,
) {
    if !package_total_usd.is_finite() || package_total_usd <= 0.0 {
        return;
    }
    if segment_end_unix_ms <= segment_start_unix_ms || window_end_unix_ms <= window_start_unix_ms {
        return;
    }
    let overlap_start = segment_start_unix_ms.max(window_start_unix_ms);
    let overlap_end = segment_end_unix_ms.min(window_end_unix_ms);
    if overlap_end <= overlap_start {
        return;
    }

    let month_ms = (30_u64 * 24 * 60 * 60 * 1000) as f64;
    let mut cursor = overlap_start;
    while cursor < overlap_end {
        let Some(day_key) = local_day_key_from_unix_ms(cursor) else {
            break;
        };
        let Some((day_start, day_end)) = local_day_range_from_key(&day_key) else {
            break;
        };
        let part_start = cursor.max(day_start);
        let part_end = overlap_end.min(day_end);
        if part_end > part_start {
            let part_ms = (part_end.saturating_sub(part_start)) as f64;
            let cost = package_total_usd * (part_ms / month_ms);
            by_day
                .entry(day_key)
                .and_modify(|v| *v += cost)
                .or_insert(cost);
        }
        if day_end <= cursor {
            break;
        }
        cursor = day_end;
    }
}

fn package_total_schedule_by_day(
    pricing_cfg: Option<&crate::orchestrator::secrets::ProviderPricingConfig>,
    window_start_unix_ms: u64,
    window_end_unix_ms: u64,
) -> BTreeMap<String, f64> {
    let mut by_day: BTreeMap<String, f64> = BTreeMap::new();
    let Some(cfg) = pricing_cfg else {
        return by_day;
    };
    let mut has_timeline = false;
    for period in cfg.periods.iter() {
        if period.mode != "package_total" {
            continue;
        }
        if !period.amount_usd.is_finite() || period.amount_usd <= 0.0 {
            continue;
        }
        let segment_end = period.ended_at_unix_ms.unwrap_or(window_end_unix_ms);
        add_package_total_segment_by_day(
            &mut by_day,
            period.amount_usd,
            period.started_at_unix_ms,
            segment_end,
            window_start_unix_ms,
            window_end_unix_ms,
        );
        has_timeline = true;
    }
    if !has_timeline
        && cfg.mode == "package_total"
        && cfg.amount_usd.is_finite()
        && cfg.amount_usd > 0.0
    {
        add_package_total_segment_by_day(
            &mut by_day,
            cfg.amount_usd,
            window_start_unix_ms,
            window_end_unix_ms,
            window_start_unix_ms,
            window_end_unix_ms,
        );
    }
    by_day
}

fn package_total_amount_for_slice(
    pricing_cfg: Option<&crate::orchestrator::secrets::ProviderPricingConfig>,
    slice_start_unix_ms: u64,
    slice_end_unix_ms: u64,
) -> Option<f64> {
    let cfg = pricing_cfg?;
    if slice_end_unix_ms <= slice_start_unix_ms {
        return None;
    }
    let mut best: Option<(f64, u64, u64)> = None; // (amount, overlap_ms, started_at)
    let mut has_timeline = false;
    for period in cfg.periods.iter() {
        if period.mode != "package_total" {
            continue;
        }
        if !period.amount_usd.is_finite() || period.amount_usd <= 0.0 {
            continue;
        }
        has_timeline = true;
        let period_end = period.ended_at_unix_ms.unwrap_or(u64::MAX);
        let overlap_start = period.started_at_unix_ms.max(slice_start_unix_ms);
        let overlap_end = period_end.min(slice_end_unix_ms);
        if overlap_end <= overlap_start {
            continue;
        }
        let overlap_ms = overlap_end.saturating_sub(overlap_start);
        let should_replace = best
            .as_ref()
            .map(|(_, cur_overlap, cur_started)| {
                overlap_ms > *cur_overlap
                    || (overlap_ms == *cur_overlap && period.started_at_unix_ms >= *cur_started)
            })
            .unwrap_or(true);
        if should_replace {
            best = Some((period.amount_usd, overlap_ms, period.started_at_unix_ms));
        }
    }
    if let Some((amount, _, _)) = best {
        return Some(amount);
    }
    if !has_timeline
        && cfg.mode == "package_total"
        && cfg.amount_usd.is_finite()
        && cfg.amount_usd > 0.0
    {
        return Some(cfg.amount_usd);
    }
    None
}

fn package_total_window_total_by_day_slots(
    pricing_cfg: Option<&crate::orchestrator::secrets::ProviderPricingConfig>,
    window_start_unix_ms: u64,
    window_end_unix_ms: u64,
    window_hours: u64,
) -> f64 {
    if window_end_unix_ms <= window_start_unix_ms || window_hours == 0 {
        return 0.0;
    }
    let slot_ms = 24_u64 * 60 * 60 * 1000;
    let slot_count = (window_hours / 24).max(1);
    let mut total = 0.0_f64;
    for i in 0..slot_count {
        let slot_end = window_end_unix_ms.saturating_sub(i.saturating_mul(slot_ms));
        if slot_end <= window_start_unix_ms {
            break;
        }
        let slot_start = slot_end.saturating_sub(slot_ms).max(window_start_unix_ms);
        if let Some(monthly_total) =
            package_total_amount_for_slice(pricing_cfg, slot_start, slot_end)
        {
            total += monthly_total / 30.0;
        }
    }
    total
}

fn active_package_period(
    pricing_cfg: Option<&crate::orchestrator::secrets::ProviderPricingConfig>,
    now_unix_ms: u64,
) -> Option<(f64, Option<u64>)> {
    let cfg = pricing_cfg?;
    let mut active: Option<(f64, Option<u64>)> = None;
    let mut active_start = 0u64;
    for period in cfg.periods.iter() {
        if period.mode != "package_total" {
            continue;
        }
        if !period.amount_usd.is_finite() || period.amount_usd <= 0.0 {
            continue;
        }
        let ended = period.ended_at_unix_ms.unwrap_or(u64::MAX);
        if period.started_at_unix_ms <= now_unix_ms
            && now_unix_ms < ended
            && period.started_at_unix_ms >= active_start
        {
            active = Some((period.amount_usd, period.ended_at_unix_ms));
            active_start = period.started_at_unix_ms;
        }
    }
    if active.is_some() {
        return active;
    }
    if cfg.mode == "package_total" && cfg.amount_usd.is_finite() && cfg.amount_usd > 0.0 {
        return Some((cfg.amount_usd, None));
    }
    None
}

fn active_package_total_usd(
    pricing_cfg: Option<&crate::orchestrator::secrets::ProviderPricingConfig>,
    now_unix_ms: u64,
) -> Option<f64> {
    active_package_period(pricing_cfg, now_unix_ms).map(|(amount, _)| amount)
}

fn package_profile_for_day(
    pricing_cfg: Option<&crate::orchestrator::secrets::ProviderPricingConfig>,
    day_start_unix_ms: u64,
) -> Option<(f64, Option<u64>, Option<String>)> {
    let cfg = pricing_cfg?;
    let mut matched: Option<(f64, Option<u64>, u64, String)> = None;
    for period in cfg.periods.iter() {
        if period.mode != "package_total"
            || !period.amount_usd.is_finite()
            || period.amount_usd <= 0.0
        {
            continue;
        }
        let ended = period.ended_at_unix_ms.unwrap_or(u64::MAX);
        if period.started_at_unix_ms <= day_start_unix_ms && day_start_unix_ms < ended {
            let replace = matched
                .as_ref()
                .map(|(_, _, started, _)| period.started_at_unix_ms >= *started)
                .unwrap_or(true);
            if replace {
                matched = Some((
                    period.amount_usd,
                    period.ended_at_unix_ms,
                    period.started_at_unix_ms,
                    period.api_key_ref.clone(),
                ));
            }
        }
    }
    if let Some((amount, expires, _, api_key_ref)) = matched {
        let key = api_key_ref.trim();
        return Some((
            amount,
            expires,
            if key.is_empty() || key == "-" {
                None
            } else {
                Some(key.to_string())
            },
        ));
    }
    if cfg.mode == "package_total" && cfg.amount_usd.is_finite() && cfg.amount_usd > 0.0 {
        return Some((cfg.amount_usd, None, None));
    }
    None
}

fn per_request_amount_at(
    pricing_cfg: Option<&crate::orchestrator::secrets::ProviderPricingConfig>,
    ts_unix_ms: u64,
) -> Option<f64> {
    let cfg = pricing_cfg?;
    let mut matched: Option<(f64, u64)> = None;
    for period in cfg.periods.iter() {
        if period.mode != "per_request"
            || !period.amount_usd.is_finite()
            || period.amount_usd <= 0.0
        {
            continue;
        }
        let ended = period.ended_at_unix_ms.unwrap_or(u64::MAX);
        if period.started_at_unix_ms <= ts_unix_ms && ts_unix_ms < ended {
            let replace = matched
                .as_ref()
                .map(|(_, started)| period.started_at_unix_ms >= *started)
                .unwrap_or(true);
            if replace {
                matched = Some((period.amount_usd, period.started_at_unix_ms));
            }
        }
    }
    if let Some((amount, _)) = matched {
        return Some(amount);
    }
    if cfg.mode == "per_request" && cfg.amount_usd.is_finite() && cfg.amount_usd > 0.0 {
        return Some(cfg.amount_usd);
    }
    None
}

fn has_per_request_timeline(
    pricing_cfg: Option<&crate::orchestrator::secrets::ProviderPricingConfig>,
) -> bool {
    let Some(cfg) = pricing_cfg else {
        return false;
    };
    cfg.periods.iter().any(|period| {
        period.mode == "per_request" && period.amount_usd.is_finite() && period.amount_usd > 0.0
    })
}

fn aligned_bucket_start_unix_ms(ts_unix_ms: u64, bucket_ms: u64) -> Option<u64> {
    if bucket_ms == 24 * 60 * 60 * 1000 {
        let day_key = local_day_key_from_unix_ms(ts_unix_ms)?;
        let (start, _) = local_day_range_from_key(&day_key)?;
        return Some(start);
    }
    if bucket_ms == 60 * 60 * 1000 {
        let ts = i64::try_from(ts_unix_ms).ok()?;
        let dt = Local.timestamp_millis_opt(ts).single()?;
        let hour = dt.with_minute(0)?.with_second(0)?.with_nanosecond(0)?;
        return u64::try_from(hour.timestamp_millis()).ok();
    }
    if bucket_ms == 0 {
        return Some(ts_unix_ms);
    }
    Some((ts_unix_ms / bucket_ms) * bucket_ms)
}
