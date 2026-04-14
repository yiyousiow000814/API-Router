export type ProviderHealth = {
  status: 'unknown' | 'healthy' | 'unhealthy' | 'cooldown' | 'closed'
  consecutive_failures: number
  cooldown_until_unix_ms: number
  last_error: string
  last_ok_at_unix_ms: number
  last_fail_at_unix_ms: number
  last_error_event_id?: string | null
}

export type Status = {
  listen: { host: string; port: number }
  config_revision?: string
  wsl_gateway_host?: string
  local_network_online?: boolean
  local_network_source?: string
  local_network_last_error?: string | null
  preferred_provider: string
  manual_override: string | null
  providers: Record<string, ProviderHealth>
  metrics: Record<string, { ok_requests: number; error_requests: number; total_tokens: number }>
  // Dashboard snapshot window (small/recent only), not full Event Log history.
  recent_events: Array<{
    id?: string
    provider: string
    level: string
    unix_ms: number
    code: string
    message: string
    fields: Record<string, unknown> | null
  }>
  client_sessions?: Array<{
    id: string
    wt_session?: string
    codex_session_id?: string | null
    agent_parent_session_id?: string | null
    reported_model_provider?: string | null
    reported_model?: string | null
    reported_base_url?: string | null
    last_seen_unix_ms: number
    active: boolean
    preferred_provider?: string | null
    current_provider?: string | null
    current_reason?: string | null
    verified?: boolean
    is_agent?: boolean
    is_review?: boolean
  }>
  active_provider?: string | null
  active_reason?: string | null
  active_provider_counts?: Record<string, number>
  quota: Record<
    string,
    {
      kind: 'none' | 'token_stats' | 'budget_info' | 'balance_info'
      updated_at_unix_ms: number
      remaining: number | null
      today_used: number | null
      today_added: number | null
      daily_spent_usd: number | null
      daily_budget_usd: number | null
      weekly_spent_usd?: number | null
      weekly_budget_usd?: number | null
      monthly_spent_usd: number | null
      monthly_budget_usd: number | null
      package_expires_at_unix_ms?: number | null
      last_error: string
      effective_usage_base?: string | null
      effective_usage_source?: string | null
      producer_node_id?: string | null
      producer_node_name?: string | null
      applied_from_node_id?: string | null
      applied_from_node_name?: string | null
      applied_at_unix_ms?: number
    }
  >
  ledgers: Record<
    string,
    {
      since_last_quota_refresh_requests?: number
      since_last_quota_refresh_total_tokens: number
      last_reset_unix_ms: number
    }
  >
  last_activity_unix_ms: number
  codex_account: {
    ok: boolean
    checked_at_unix_ms?: number
    signed_in?: boolean
    remaining?: string | null
    limit_5h_remaining?: string | null
    limit_5h_reset_at?: string | null
    limit_weekly_remaining?: string | null
    limit_weekly_reset_at?: string | null
    code_review_remaining?: string | null
    code_review_reset_at?: string | null
    unlimited?: boolean | null
    error?: string
  }
  tailscale?: {
    installed: boolean
    connected: boolean
    backend_state?: string | null
    dns_name?: string | null
    ipv4: string[]
    reachable_ipv4: string[]
    gateway_reachable: boolean
    needs_gateway_restart: boolean
    status_error?: string | null
    bootstrap?: {
      last_stage?: string | null
      last_detail?: string | null
      updated_at_unix_ms?: number | null
    } | null
  }
  lan_sync?: {
    enabled: boolean
    discovery_port: number
    heartbeat_interval_ms: number
    peer_stale_after_ms: number
    last_peer_heartbeat_received_unix_ms?: number
    last_peer_heartbeat_source?: string | null
    local_node: {
      node_id: string
      node_name: string
      listen_addr?: string | null
      capabilities: string[]
      tailscale?: Status['tailscale']
      version_inventory?: string[]
      build_identity?: {
        app_version: string
        build_git_sha: string
        build_git_short_sha: string
        build_git_commit_unix_ms?: number | null
      }
      version_sync?: {
        target_ref?: string | null
        git_worktree_clean: boolean
        update_to_local_build_allowed: boolean
        blocked_reason?: string | null
      }
      remote_update_status?: {
        state: 'accepted' | 'running' | 'failed' | 'succeeded' | string
        target_ref: string
        request_id?: string | null
        reason_code?: string | null
        requester_node_id?: string | null
        requester_node_name?: string | null
        worker_script?: string | null
        detail?: string | null
        accepted_at_unix_ms?: number
        started_at_unix_ms?: number | null
        finished_at_unix_ms?: number | null
        updated_at_unix_ms?: number
        timeline?: Array<{
          unix_ms?: number
          phase?: string | null
          label?: string | null
          detail?: string | null
          source?: string | null
          state?: string | null
        }>
      } | null
      sync_contracts?: Record<string, number>
      provider_fingerprints: string[]
    }
    peers: Array<{
      node_id: string
      node_name: string
      listen_addr: string
      last_heartbeat_unix_ms: number
      capabilities: string[]
      tailscale?: Status['tailscale']
      version_inventory?: string[]
      build_identity?: {
        app_version: string
        build_git_sha: string
        build_git_short_sha: string
        build_git_commit_unix_ms?: number | null
      }
      remote_update_readiness?: {
        ready: boolean
        blocked_reason?: string | null
        checked_at_unix_ms?: number
      } | null
      remote_update_status?: {
        state: 'accepted' | 'running' | 'failed' | 'succeeded' | string
        target_ref: string
        request_id?: string | null
        reason_code?: string | null
        requester_node_id?: string | null
        requester_node_name?: string | null
        worker_script?: string | null
        detail?: string | null
        accepted_at_unix_ms?: number
        started_at_unix_ms?: number | null
        finished_at_unix_ms?: number | null
        updated_at_unix_ms?: number
        timeline?: Array<{
          unix_ms?: number
          phase?: string | null
          label?: string | null
          detail?: string | null
          source?: string | null
          state?: string | null
        }>
      } | null
      sync_contracts?: Record<string, number>
      provider_fingerprints: string[]
      followed_source_node_id?: string | null
      trusted?: boolean
      pair_state?: 'trusted' | 'incoming_request' | 'requested' | 'pin_required' | null
      pair_request_id?: string | null
      sync_blocked_domains?: string[]
      sync_diagnostics?: Array<{
        domain: string
        status: 'ok' | 'blocked' | string
        local_contract_version: number
        peer_contract_version: number
        blocked_reason?: string | null
      }>
      build_matches_local?: boolean
    }>
  }
  shared_quota_owners?: Array<{
    provider: string
    shared_provider_id: string
    shared_provider_fingerprint: string
    owner_node_id: string
    owner_node_name: string
    local_is_owner: boolean
    contender_count: number
  }>
}

export type CodexSwapStatus = {
  ok: boolean
  overall: 'original' | 'swapped' | 'mixed' | 'error'
  dirs: Array<{
    cli_home: string
    state: string
  }>
}

export type ProviderSwitchboardStatus = {
  ok: boolean
  mode: 'gateway' | 'official' | 'provider' | 'mixed'
  model_provider?: string | null
  dirs?: Array<{
    cli_home: string
    mode: string
    model_provider?: string | null
  }>
  provider_options?: string[]
}

export type LanRemoteUpdateDebugResponse = {
  ok: boolean
  version: number
  node_id: string
  node_name: string
  remote_update_readiness: {
    ready: boolean
    blocked_reason?: string | null
    checked_at_unix_ms?: number
  }
  remote_update_status?: {
    state: 'accepted' | 'running' | 'failed' | 'succeeded' | string
    target_ref: string
    request_id?: string | null
    reason_code?: string | null
    requester_node_id?: string | null
    requester_node_name?: string | null
    worker_script?: string | null
    detail?: string | null
    accepted_at_unix_ms?: number
    started_at_unix_ms?: number | null
    finished_at_unix_ms?: number | null
    updated_at_unix_ms?: number
    timeline?: Array<{
      unix_ms?: number
      phase?: string | null
      label?: string | null
      detail?: string | null
      source?: string | null
      state?: string | null
    }>
  } | null
  status_path?: string | null
  status_file_exists: boolean
  log_path?: string | null
  log_file_exists: boolean
  log_tail_source?: 'file' | 'timeline' | 'none' | string
  log_tail?: string | null
  worker_bootstrap_observed?: boolean
  worker_script_probe?: {
    path: string
    exists: boolean
    modified_at_unix_ms?: number | null
    size_bytes?: number | null
    bootstrap_marker_present: boolean
    no_tag_fetch_present: boolean
  } | null
  local_build_identity: {
    app_version: string
    build_git_sha: string
    build_git_short_sha: string
    build_git_commit_unix_ms?: number | null
  }
  local_version_sync: {
    target_ref?: string | null
    git_worktree_clean: boolean
    update_to_local_build_allowed: boolean
    blocked_reason?: string | null
  }
}

export type Config = {
  listen: { host: string; port: number }
  routing: {
    preferred_provider: string
    session_preferred_providers?: Record<string, string>
    route_mode?: 'follow_preferred_auto' | 'balanced_auto'
    auto_return_to_preferred: boolean
    preferred_stable_seconds: number
    failure_threshold: number
    cooldown_seconds: number
    request_timeout_seconds: number
  }
  providers: Record<
    string,
    {
      display_name: string
      base_url: string
      group?: string | null
      supports_websockets?: boolean
      usage_adapter?: string
      usage_base_url?: string | null
      quota_hard_cap?: {
        daily: boolean
        weekly: boolean
        monthly: boolean
      }
      disabled?: boolean
      manual_pricing_mode?: 'per_request' | 'package_total' | null
      manual_pricing_amount_usd?: number | null
      manual_pricing_expires_at_unix_ms?: number | null
      manual_gap_fill_mode?: 'per_request' | 'total' | 'per_day_average' | null
      manual_gap_fill_amount_usd?: number | null
      account_email?: string | null
      has_key: boolean
      key_preview?: string | null
      key_storage?: 'auth_json' | 'config_toml_experimental_bearer_token'
      has_usage_token?: boolean
      has_usage_login?: boolean
      borrowed?: boolean
      editable?: boolean
      source_node_id?: string | null
      shared_provider_id?: string | null
      local_copy_state?: 'copied' | 'linked' | null
    }
  >
  provider_order?: string[]
  config_source?: {
    mode: 'local' | 'follow'
    followed_node_id?: string | null
    sources: Array<{
      kind: 'local' | 'peer'
      node_id: string
      node_name: string
      active: boolean
      online?: boolean
      trusted?: boolean
      pair_state?: 'trusted' | 'incoming_request' | 'requested' | 'pin_required' | null
      pair_request_id?: string | null
      follow_allowed: boolean
      follow_blocked_reason?: string | null
      using_count: number
      capabilities?: string[]
      version_inventory?: string[]
      build_identity?: {
        app_version: string
        build_git_sha: string
        build_git_short_sha: string
        build_git_commit_unix_ms?: number | null
      } | null
      sync_contracts?: Record<string, number>
      build_matches_local?: boolean
      remote_update_status?: {
        state: 'accepted' | 'running' | 'failed' | 'succeeded' | string
        target_ref: string
        request_id?: string | null
        reason_code?: string | null
        requester_node_id?: string | null
        requester_node_name?: string | null
        worker_script?: string | null
        detail?: string | null
        accepted_at_unix_ms?: number
        started_at_unix_ms?: number | null
        finished_at_unix_ms?: number | null
        updated_at_unix_ms?: number
        timeline?: Array<{
          unix_ms?: number
          phase?: string | null
          label?: string | null
          detail?: string | null
          source?: string | null
          state?: string | null
        }>
      } | null
      sync_blocked_domains?: string[]
      version_sync_required?: boolean
      version_sync_reason?: string | null
      same_version_update_allowed?: boolean
      same_version_update_blocked_reason?: string | null
    }>
  }
}

export type UsageModelStatisticsRow = {
  model: string
  requests: number
  input_tokens: number
  output_tokens: number
  total_tokens: number
  share_pct: number
  estimated_total_cost_usd: number
  estimated_avg_request_cost_usd: number
  estimated_cost_request_count: number
}

export type UsageProviderStatisticsRow = {
  provider: string
  api_key_ref?: string | null
  requests: number
  total_tokens: number
  tokens_per_request?: number | null
  estimated_total_cost_usd: number
  estimated_avg_request_cost_usd?: number | null
  usd_per_million_tokens?: number | null
  estimated_daily_cost_usd?: number | null
  total_used_cost_usd?: number | null
  pricing_source?: string | null
  estimated_cost_request_count: number
}

export type UsageTimelinePoint = {
  bucket_unix_ms: number
  requests: number
  total_tokens: number
  cache_creation_tokens?: number
  cache_read_tokens?: number
}

export type UsageStatisticsOverview = {
  ok: boolean
  generated_at_unix_ms: number
  window_hours: number
  bucket_seconds: number
  summary: {
    total_requests: number
    total_tokens: number
    input_tokens: number
    output_tokens: number
    active_window_hours?: number
    cache_creation_tokens?: number
    cache_read_tokens?: number
    unique_models: number
    top_model?: {
      model: string
      requests: number
      share_pct: number
    } | null
    estimated_total_cost_usd: number
    estimated_daily_cost_usd?: number
    by_provider: UsageProviderStatisticsRow[]
    timeline: UsageTimelinePoint[]
  }
}

export type UsageStatistics = UsageStatisticsOverview & {
  filter?: {
    nodes?: string[] | null
    providers?: string[] | null
    models?: string[] | null
    origins?: string[] | null
  }
  catalog?: {
    nodes?: string[]
    providers: string[]
    models: string[]
    origins?: string[]
  }
  summary: UsageStatisticsOverview['summary'] & {
    by_model: UsageModelStatisticsRow[]
  }
}
