#[tauri::command]
fn get_status(state: tauri::State<'_, app_state::AppState>) -> serde_json::Value {
    let cfg = state.gateway.cfg.read().clone();
    let now = unix_ms();
    state.gateway.router.sync_with_config(&cfg, now);
    let providers = state.gateway.router.snapshot(now);
    let manual_override = state.gateway.router.manual_override.read().clone();
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
        let discovered = crate::platform::windows_terminal::discover_sessions_using_router(
            cfg.listen.port,
            expected,
        );

        // Track all discovered sessions, but only allow provider preference changes once we have
        // strong evidence that the session is using this gateway.
        {
            let mut map = state.gateway.client_sessions.write();
            for s in discovered {
                let Some(codex_session_id) = s.codex_session_id.as_deref() else {
                    continue;
                };
                let entry = map.entry(codex_session_id.to_string()).or_insert_with(|| {
                    crate::orchestrator::gateway::ClientSessionRuntime {
                        codex_session_id: codex_session_id.to_string(),
                        pid: s.pid,
                        wt_session: Some(s.wt_session.clone()),
                        last_request_unix_ms: 0,
                        last_discovered_unix_ms: 0,
                        last_reported_model_provider: None,
                        last_reported_base_url: None,
                        confirmed_router: s.router_confirmed,
                    }
                });
                entry.pid = s.pid;
                entry.wt_session = Some(s.wt_session.clone());
                entry.last_discovered_unix_ms = now;
                if s.router_confirmed {
                    entry.confirmed_router = true;
                }
                if let Some(mp) = s.reported_model_provider.as_deref() {
                    entry.last_reported_model_provider = Some(mp.to_string());
                }
                if let Some(bu) = s.reported_base_url.as_deref() {
                    entry.last_reported_base_url = Some(bu.to_string());
                }
            }
        }

        // Drop dead sessions aggressively (e.g. user Ctrl+C'd Codex).
        // We keep the persisted preference mapping in config; only the runtime list is pruned.
        {
            let mut map = state.gateway.client_sessions.write();
            // Some sessions (e.g. non-Windows or when PID inference fails) can have pid=0. Keep them
            // around briefly for UI visibility, but prune if they go cold to avoid unbounded growth.
            const STALE_NO_PID_MS: u64 = 5 * 60 * 1000;
            map.retain(|_, v| {
                if v.pid != 0 && !crate::platform::windows_terminal::is_pid_alive(v.pid) {
                    return false;
                }
                if v.pid == 0 {
                    let last_seen = v.last_request_unix_ms.max(v.last_discovered_unix_ms);
                    if last_seen > 0 && now.saturating_sub(last_seen) > STALE_NO_PID_MS {
                        return false;
                    }
                }
                true
            });
        }

        let map = state.gateway.client_sessions.read().clone();
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
                let active = v.last_request_unix_ms > 0
                    && now.saturating_sub(v.last_request_unix_ms) < 60_000;

                let codex_id = v.codex_session_id.clone();
                let pref = cfg
                    .routing
                    .session_preferred_providers
                    .get(&codex_id)
                    .cloned()
                    .filter(|p| cfg.providers.contains_key(p));
                let last_seen_unix_ms = v.last_request_unix_ms.max(v.last_discovered_unix_ms);
                serde_json::json!({
                    "id": codex_id,
                    "wt_session": v.wt_session,
                    "codex_session_id": v.codex_session_id,
                    "reported_model_provider": v.last_reported_model_provider,
                    "reported_base_url": v.last_reported_base_url,
                    "last_seen_unix_ms": last_seen_unix_ms,
                    "active": active,
                    "preferred_provider": pref,
                    "verified": v.confirmed_router
                })
            })
            .collect::<Vec<_>>();
        sessions
    };

    serde_json::json!({
      "listen": { "host": cfg.listen.host, "port": cfg.listen.port },
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

