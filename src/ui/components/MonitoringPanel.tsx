import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import type { Status } from '../types'
import './DashboardPanel.css'

// ---------------------------------------------------------------------------
// Domain types (mirroring the backend)
// ---------------------------------------------------------------------------

export interface WatchdogSummary {
  healthy: boolean
  last_incident_kind: string | null
  last_incident_unix_ms?: number | null
  last_incident_file?: string | null
  incident_count: number
  recent_incidents?: Array<{
    unix_ms: number
    kind: string
    file: string
  }>
}

export interface EventCount {
  last_unix_ms: number
  count: number
}

export interface EventCountWithDetail {
  last_unix_ms: number
  count: number
  latest_detail: string | null
}

export interface WebTransportDomainSnapshot {
  ws_open_observed: EventCount
  ws_error_observed: EventCountWithDetail
  ws_close_observed: { last_unix_ms: number; count: number; latest_close_code: number | null }
  ws_reconnect_scheduled: EventCount
  ws_reconnect_attempted: EventCount
  http_fallback_engaged: EventCount
  thread_refresh_failed: EventCount
  active_thread_poll_failed: EventCount
  live_notification_gap_observed: EventCount
}

export interface LanDiagnosticsResponsePacket {
  version: number
  node_id: string
  node_name: string
  sent_at_unix_ms: number
  domains: Record<string, unknown>
}

type TailscaleSummary = NonNullable<Status['tailscale']>

const DEV_PREVIEW_WATCHDOG_SUMMARY: WatchdogSummary = {
  healthy: false,
  incident_count: 3,
  last_incident_kind: 'heartbeat-stall',
  last_incident_unix_ms: 1_700_000_002_000,
  last_incident_file: 'ui-freeze-1700000002000-heartbeat-stall.json',
  recent_incidents: [
    {
      unix_ms: 1_700_000_002_000,
      kind: 'heartbeat-stall',
      file: 'ui-freeze-1700000002000-heartbeat-stall.json',
    },
    {
      unix_ms: 1_700_000_001_000,
      kind: 'slow-refresh',
      file: 'slow-refresh-1700000001000-status.json',
    },
    {
      unix_ms: 1_700_000_000_000,
      kind: 'frame-stall',
      file: 'frame-stall-1700000000000-render-blocked.json',
    },
  ],
}

const DEV_PREVIEW_WEBTRANSPORT_SNAPSHOT: WebTransportDomainSnapshot = {
  ws_open_observed: { count: 4, last_unix_ms: 1_700_000_002_500 },
  ws_error_observed: {
    count: 2,
    last_unix_ms: 1_700_000_002_000,
    latest_detail: 'ECONNRESET',
  },
  ws_close_observed: {
    count: 2,
    last_unix_ms: 1_700_000_002_100,
    latest_close_code: 1006,
  },
  ws_reconnect_scheduled: { count: 3, last_unix_ms: 1_700_000_002_150 },
  ws_reconnect_attempted: { count: 3, last_unix_ms: 1_700_000_002_220 },
  http_fallback_engaged: { count: 1, last_unix_ms: 1_700_000_001_500 },
  thread_refresh_failed: { count: 1, last_unix_ms: 1_700_000_001_200 },
  active_thread_poll_failed: { count: 0, last_unix_ms: 0 },
  live_notification_gap_observed: { count: 1, last_unix_ms: 1_700_000_001_800 },
}

const DEV_PREVIEW_TAILSCALE_SUMMARY: TailscaleSummary = {
  installed: true,
  connected: true,
  backend_state: 'Running',
  dns_name: 'desk-monitor.tail.ts.net',
  ipv4: ['100.64.0.8'],
  reachable_ipv4: ['100.64.0.8'],
  gateway_reachable: true,
  needs_gateway_restart: false,
  status_error: null,
  bootstrap: {
    last_stage: 'listener-ready',
    last_detail: 'overlay listener bound to tailscale address',
    updated_at_unix_ms: 1_700_000_002_400,
  },
}

const DEV_PREVIEW_REMOTE_PEERS: PeerDiagEntry[] = [
  {
    node_id: 'node-desk-b',
    node_name: 'Desk B',
    health: 'error',
    last_incident: 'heartbeat-stall',
    fetched_at: Date.now() - 2_000,
    tailscale: {
      installed: true,
      connected: true,
      backend_state: 'Running',
      dns_name: 'desk-b.tail.ts.net',
      ipv4: ['100.64.0.18'],
      reachable_ipv4: [],
      gateway_reachable: false,
      needs_gateway_restart: true,
      status_error: null,
      bootstrap: {
        last_stage: 'gateway-bind-pending',
        last_detail: 'listener will bind after next app restart',
        updated_at_unix_ms: 1_700_000_001_200,
      },
    },
    watchdog: {
      healthy: false,
      incident_count: 2,
      last_incident_kind: 'heartbeat-stall',
      last_incident_unix_ms: 1_700_000_001_800,
      last_incident_file: 'ui-freeze-1700000001800-heartbeat-stall.json',
      recent_incidents: [
        {
          unix_ms: 1_700_000_001_800,
          kind: 'heartbeat-stall',
          file: 'ui-freeze-1700000001800-heartbeat-stall.json',
        },
        {
          unix_ms: 1_700_000_001_500,
          kind: 'frame-stall',
          file: 'frame-stall-1700000001500-render-blocked.json',
        },
      ],
    },
    webtransport: {
      ws_open_observed: { count: 1, last_unix_ms: 1_700_000_001_700 },
      ws_error_observed: {
        count: 1,
        last_unix_ms: 1_700_000_001_750,
        latest_detail: 'ENOTFOUND',
      },
      ws_close_observed: {
        count: 1,
        last_unix_ms: 1_700_000_001_760,
        latest_close_code: 1006,
      },
      ws_reconnect_scheduled: { count: 2, last_unix_ms: 1_700_000_001_770 },
      ws_reconnect_attempted: { count: 2, last_unix_ms: 1_700_000_001_775 },
      http_fallback_engaged: { count: 1, last_unix_ms: 1_700_000_001_600 },
      thread_refresh_failed: { count: 1, last_unix_ms: 1_700_000_001_620 },
      active_thread_poll_failed: { count: 0, last_unix_ms: 0 },
      live_notification_gap_observed: { count: 0, last_unix_ms: 0 },
    },
  },
  {
    node_id: 'node-laptop-c',
    node_name: 'Laptop C',
    health: 'ok',
    last_incident: null,
    fetched_at: Date.now() - 8_000,
    tailscale: {
      installed: false,
      connected: false,
      backend_state: null,
      dns_name: null,
      ipv4: [],
      reachable_ipv4: [],
      gateway_reachable: false,
      needs_gateway_restart: false,
      status_error: 'tailscale_not_found',
      bootstrap: null,
    },
    watchdog: {
      healthy: true,
      incident_count: 0,
      last_incident_kind: null,
      recent_incidents: [],
    },
    webtransport: {
      ws_open_observed: { count: 0, last_unix_ms: 0 },
      ws_error_observed: { count: 0, last_unix_ms: 0, latest_detail: null },
      ws_close_observed: { count: 0, last_unix_ms: 0, latest_close_code: null },
      ws_reconnect_scheduled: { count: 0, last_unix_ms: 0 },
      ws_reconnect_attempted: { count: 0, last_unix_ms: 0 },
      http_fallback_engaged: { count: 0, last_unix_ms: 0 },
      thread_refresh_failed: { count: 0, last_unix_ms: 0 },
      active_thread_poll_failed: { count: 0, last_unix_ms: 0 },
      live_notification_gap_observed: { count: 0, last_unix_ms: 0 },
    },
  },
]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtAge(unixMs: number): string {
  if (!unixMs) return '—'
  const secs = Math.floor((Date.now() - unixMs) / 1000)
  if (secs < 60) return `${secs}s ago`
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

function fmtTs(unixMs: number): string {
  if (!unixMs) return '—'
  return new Date(unixMs).toLocaleTimeString()
}

function fmtDateTime(unixMs: number): string {
  if (!unixMs) return '—'
  return new Date(unixMs).toLocaleString()
}

function getTailscaleHeadline(summary: TailscaleSummary | null | undefined): string {
  if (!summary) return 'Unknown'
  if (!summary.installed) return 'Not installed'
  if (!summary.connected) return 'Not connected'
  if (summary.gateway_reachable) return 'Gateway reachable'
  if (summary.needs_gateway_restart) return 'Restart required'
  return 'Gateway unreachable'
}

function getTailscaleDetail(summary: TailscaleSummary | null | undefined): string {
  if (!summary) return 'No tailscale diagnostics available.'
  if (!summary.installed) return 'Install Tailscale on this device.'
  if (!summary.connected) return summary.status_error?.trim() || 'Connect this device to the tailnet.'
  const host = summary.dns_name?.trim() || summary.reachable_ipv4[0] || summary.ipv4[0] || 'No host'
  if (summary.gateway_reachable) return host
  if (summary.needs_gateway_restart) return `${host} · restart API Router`
  if (summary.status_error?.trim()) return `${host} · ${summary.status_error.trim()}`
  return `${host} · gateway unreachable`
}

export function isMonitoringDevPreview() {
  if (typeof window === 'undefined') return false
  if (hasTauriInvokeAvailable()) return false
  return window.location.port === '5173'
}

export function hasTauriInvokeAvailable(): boolean {
  if (typeof window === 'undefined') return false
  const w = window as unknown as {
    __TAURI__?: { core?: { invoke?: unknown } }
    __TAURI_INTERNALS__?: { invoke?: unknown }
  }
  return typeof w.__TAURI__?.core?.invoke === 'function' || typeof w.__TAURI_INTERNALS__?.invoke === 'function'
}

// ---------------------------------------------------------------------------
// Section 1 — Watchdog
// ---------------------------------------------------------------------------

interface WatchdogSectionProps {
  summary: WatchdogSummary | null
  loading: boolean
}

function WatchdogSection({ summary, loading }: WatchdogSectionProps) {
  const healthy = summary?.healthy ?? null
  const recentIncidents = summary?.recent_incidents ?? []
  return (
    <div className="aoCard" style={{ padding: '12px 14px' }}>
      <div className="aoCardHeader">
        <div className="aoCardTitle">Watchdog</div>
        {loading ? (
          <span className="aoHint">loading…</span>
        ) : (
          <span className={`aoPill${healthy === true ? ' aoPulse' : ''}`}>
            {healthy === true ? (
              <>
                <span className="aoDot" />
                <span className="aoPillText">healthy</span>
              </>
            ) : healthy === false ? (
              <>
                <span className="aoDot aoDotBad" />
                <span className="aoPillText">unhealthy</span>
              </>
            ) : (
              <span className="aoPillText">unknown</span>
            )}
          </span>
        )}
      </div>
      {summary ? (
        <>
          <div className="aoKvp">
            <span className="aoKey">incidents</span>
            <span className="aoVal">{summary.incident_count}</span>
            {summary.last_incident_kind ? (
              <>
                <span className="aoKey">last incident</span>
                <span className="aoVal">{summary.last_incident_kind}</span>
                <span className="aoKey">last seen</span>
                <span className="aoVal">{fmtDateTime(summary.last_incident_unix_ms ?? 0)}</span>
                <span className="aoKey">last file</span>
                <span className="aoVal aoValSmall">{summary.last_incident_file ?? '—'}</span>
              </>
            ) : null}
          </div>
          {recentIncidents.length > 0 ? (
            <div style={{ display: 'grid', gap: 6, marginTop: 10 }}>
              <div className="aoHint" style={{ fontSize: 11, fontWeight: 700 }}>Recent incidents</div>
              {recentIncidents.map((incident) => (
                <div
                  key={incident.file}
                  style={{
                    display: 'grid',
                    gap: 2,
                    padding: '8px 10px',
                    borderRadius: 10,
                    border: '1px solid rgba(13,18,32,0.08)',
                    background: 'rgba(255,255,255,0.52)',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                    <span style={{ fontSize: 12, fontWeight: 700, color: 'rgba(13,18,32,0.88)' }}>{incident.kind}</span>
                    <span className="aoHint" style={{ fontSize: 10 }}>{fmtDateTime(incident.unix_ms)}</span>
                  </div>
                  <div className="aoHint" style={{ fontSize: 10 }}>{incident.file}</div>
                </div>
              ))}
            </div>
          ) : null}
        </>
      ) : (
        !loading && <p className="aoHint">No watchdog data available.</p>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Section 2 — WebTransport
// ---------------------------------------------------------------------------

interface WtSectionProps {
  snapshot: WebTransportDomainSnapshot | null
  loading: boolean
}

function fmtRow(label: string, ec: EventCount | undefined) {
  if (!ec) return null
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(0,1fr) auto',
        gap: 12,
        alignItems: 'start',
      }}
    >
      <span className="aoKey" style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{label}</span>
      <span className="aoVal" style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
        <span>{ec.count}</span>
        {ec.last_unix_ms ? (
          <span className="aoHint" style={{ marginLeft: 8 }}>{fmtTs(ec.last_unix_ms)}</span>
        ) : (
          <span className="aoHint" style={{ marginLeft: 8 }}>—</span>
        )}
      </span>
    </div>
  )
}

function WebTransportSection({ snapshot, loading }: WtSectionProps) {
  if (loading && !snapshot) {
    return (
      <div className="aoCard" style={{ padding: '12px 14px' }}>
        <div className="aoCardHeader">
          <div className="aoCardTitle">WebTransport</div>
          <span className="aoHint">loading…</span>
        </div>
      </div>
    )
  }
  if (!snapshot) {
    return (
      <div className="aoCard" style={{ padding: '12px 14px' }}>
        <div className="aoCardHeader">
          <div className="aoCardTitle">WebTransport</div>
        </div>
        <p className="aoHint">No WebTransport data available yet.</p>
        <p className="aoHint" style={{ marginTop: 8 }}>
          Open Web Codex from the desktop app and trigger a connection or reconnect cycle to populate this panel.
        </p>
      </div>
    )
  }
  return (
    <div className="aoCard" style={{ padding: '12px 14px' }}>
      <div className="aoCardHeader">
        <div className="aoCardTitle">WebTransport</div>
        <span className="aoHint" style={{ fontSize: 11 }}>
          polled every 5s
        </span>
      </div>
      <div style={{ display: 'grid', gap: 4 }}>
        {fmtRow('ws_open', snapshot.ws_open_observed)}
        {snapshot.ws_error_observed.count > 0 && (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'minmax(0,1fr) auto',
              gap: 12,
              alignItems: 'start',
            }}
          >
            <span className="aoKey" style={{ minWidth: 0, overflowWrap: 'anywhere' }}>ws_error</span>
            <span className="aoVal aoValSmall" style={{ color: 'var(--ao-danger)', textAlign: 'right' }}>
              <span>{snapshot.ws_error_observed.count}</span>
              <span className="aoHint" style={{ marginLeft: 8 }}>{fmtTs(snapshot.ws_error_observed.last_unix_ms)}</span>
              {snapshot.ws_error_observed.latest_detail ? (
                <span style={{ display: 'block', marginTop: 2, overflowWrap: 'anywhere' }}>
                  {snapshot.ws_error_observed.latest_detail}
                </span>
              ) : null}
            </span>
          </div>
        )}
        {fmtRow('ws_close', {
          last_unix_ms: snapshot.ws_close_observed.last_unix_ms,
          count: snapshot.ws_close_observed.count,
        })}
        {snapshot.ws_close_observed.latest_close_code != null && (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'minmax(0,1fr) auto',
              gap: 12,
              alignItems: 'start',
            }}
          >
            <span className="aoKey">close_code</span>
            <span className="aoVal" style={{ textAlign: 'right' }}>{snapshot.ws_close_observed.latest_close_code}</span>
          </div>
        )}
        {fmtRow('ws_reconnect_scheduled', snapshot.ws_reconnect_scheduled)}
        {fmtRow('ws_reconnect_attempted', snapshot.ws_reconnect_attempted)}
        {fmtRow('http_fallback', snapshot.http_fallback_engaged)}
        {fmtRow('thread_refresh_failed', snapshot.thread_refresh_failed)}
        {fmtRow('active_thread_poll_failed', snapshot.active_thread_poll_failed)}
        {fmtRow('live_notification_gap', snapshot.live_notification_gap_observed)}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Section 3 — Remote Peer Diagnostics
// ---------------------------------------------------------------------------

interface PeerDiagEntry {
  node_id: string
  node_name: string
  health: 'ok' | 'error' | 'unknown'
  last_incident: string | null
  fetched_at: number
  tailscale: TailscaleSummary | null
  watchdog: WatchdogSummary | null
  webtransport: WebTransportDomainSnapshot | null
}

interface PeerDiagsSectionProps {
  status: Status | null
}

function PeerDiagsSection({ status }: PeerDiagsSectionProps) {
  const hasTauriInvoke = useMemo(() => hasTauriInvokeAvailable(), [])
  const isDevPreview = useMemo(() => isMonitoringDevPreview(), [])
  const previewPeers = useMemo(
    () =>
      DEV_PREVIEW_REMOTE_PEERS.map((peer) => ({
        node_id: peer.node_id,
        node_name: peer.node_name,
      })),
    [],
  )
  const [peers, setPeers] = useState<PeerDiagEntry[]>(() => (isDevPreview ? DEV_PREVIEW_REMOTE_PEERS : []))
  const [fetchErrors, setFetchErrors] = useState<Record<string, string>>({})
  const [refreshing, setRefreshing] = useState(false)
  const [expandedPeers, setExpandedPeers] = useState<Set<string>>(new Set())
  const togglePeer = useCallback((nodeId: string) => {
    setExpandedPeers(prev => {
      const next = new Set(prev)
      if (next.has(nodeId)) {
        next.delete(nodeId)
      } else {
        next.add(nodeId)
      }
      return next
    })
  }, [])
  // Use ref to avoid recreating fetchPeerDiags on every status poll (BUG-0002 fix)
  const peersRef = useRef(status?.lan_sync?.peers ?? [])
  peersRef.current = status?.lan_sync?.peers ?? []

  const fetchPeerDiags = useCallback(async () => {
    if (isDevPreview) {
      setPeers(DEV_PREVIEW_REMOTE_PEERS)
      setFetchErrors({})
      return
    }
    if (!hasTauriInvoke) {
      setPeers([])
      setFetchErrors({})
      return
    }
    setRefreshing(true)
    try {
      const knownPeers = peersRef.current
      if (knownPeers.length === 0) {
        setPeers([])
        return
      }

      const results = await Promise.allSettled(
        knownPeers.map((peer) =>
          invoke<LanDiagnosticsResponsePacket>('get_remote_peer_diagnostics', {
            peerNodeId: peer.node_id,
            domains: ['watchdog', 'webtransport'],
          }),
        ),
      )

      const entries: PeerDiagEntry[] = []
      const errors: Record<string, string> = {}

      knownPeers.forEach((peer, idx) => {
        const result = results[idx]
        if (result.status === 'fulfilled') {
          const diag = result.value
          const wd = diag.domains?.watchdog as
            | { healthy: boolean; last_incident_kind: string | null; incident_count: number; last_incident_unix_ms?: number | null; last_incident_file?: string | null; recent_incidents?: Array<{ unix_ms: number; kind: string; file: string }> }
            | undefined
          const wts = diag.domains?.webtransport as WebTransportDomainSnapshot | undefined
          entries.push({
            node_id: peer.node_id,
            node_name: peer.node_name,
            health: wd?.healthy === false ? 'error' : wd?.healthy === true ? 'ok' : 'unknown',
            last_incident: wd?.last_incident_kind ?? null,
            fetched_at: Date.now(),
            tailscale: peer.tailscale ?? null,
            watchdog: wd ?? null,
            webtransport: wts ?? null,
          })
        } else {
          errors[peer.node_id] = String(result.reason ?? 'fetch failed')
          entries.push({
            node_id: peer.node_id,
            node_name: peer.node_name,
            health: 'unknown',
            last_incident: null,
            fetched_at: Date.now(),
            tailscale: peer.tailscale ?? null,
            watchdog: null,
            webtransport: null,
          })
        }
      })

      setPeers(entries)
      setFetchErrors(errors)
    } finally {
      setRefreshing(false)
    }
  }, [hasTauriInvoke, isDevPreview])

  useEffect(() => {
    void fetchPeerDiags()
    const timer = window.setInterval(() => {
      void fetchPeerDiags()
    }, 30_000)
    return () => window.clearInterval(timer)
  }, [fetchPeerDiags])

  const knownPeers = isDevPreview ? previewPeers : (status?.lan_sync?.peers ?? [])

  return (
    <div className="aoCard" style={{ padding: '12px 14px' }}>
      <div className="aoCardHeader">
        <div className="aoCardTitle">
          Remote Peers
          {knownPeers.length > 0 && (
            <span style={{ marginLeft: 8, fontWeight: 400, color: 'rgba(13,18,32,0.5)' }}>
              ({knownPeers.length})
            </span>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span className="aoHint" style={{ fontSize: 11 }}>
            polled every 30s
          </span>
          <button
            className={`aoUsageRefreshBtn aoUsageRefreshBtnMini${refreshing ? ' aoUsageRefreshBtnSpin' : ''}`}
            onClick={() => { void fetchPeerDiags() }}
            disabled={refreshing}
            title="Refresh peer diagnostics"
            aria-label="Refresh peer diagnostics"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M23 4v6h-6" />
              <path d="M1 20v-6h6" />
              <path d="M3.5 9a9 9 0 0 1 14.1-3.4L23 10" />
              <path d="M1 14l5.3 5.3A9 9 0 0 0 20.5 15" />
            </svg>
          </button>
        </div>
      </div>
      {!status ? (
        <p className="aoHint">Waiting for live gateway status.</p>
      ) : !hasTauriInvoke && !isDevPreview ? (
        <p className="aoHint">Remote peer diagnostics are available in the Tauri desktop app only.</p>
      ) : knownPeers.length === 0 ? (
        <p className="aoHint">No LAN peers discovered yet.</p>
      ) : (
        <div style={{ display: 'grid', gap: 6 }}>
          {peers.map((peer) => {
            const isExpanded = expandedPeers.has(peer.node_id)
            return (
              <div key={peer.node_id}>
                {/* Peer row — clickable to expand/collapse */}
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'minmax(0,1fr) auto',
                    gap: 8,
                    alignItems: 'center',
                    padding: '8px 10px',
                    borderRadius: 10,
                    border: '1px solid rgba(13,18,32,0.08)',
                    background: 'rgba(255,255,255,0.5)',
                    cursor: 'pointer',
                  }}
                  onClick={() => togglePeer(peer.node_id)}
                  role="button"
                  aria-expanded={isExpanded}
                  tabIndex={0}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') togglePeer(peer.node_id) }}
                >
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: 'rgba(13,18,32,0.86)' }}>
                      {peer.node_name}
                    </div>
                    <div className="aoHint" style={{ fontSize: 11 }}>
                      {peer.node_id.slice(0, 12)} · fetched {fmtAge(peer.fetched_at)}
                    </div>
                    <div className="aoHint" style={{ fontSize: 10, marginTop: 4 }}>
                      Tailscale: {getTailscaleDetail(peer.tailscale)}
                    </div>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span className={`aoPill${peer.health === 'ok' ? ' aoPulse' : ''}`} style={{ fontSize: 11 }}>
                        {peer.health === 'ok' ? (
                          <>
                            <span className="aoDot" style={{ width: 6, height: 6 }} />
                            <span className="aoPillText">ok</span>
                          </>
                        ) : peer.health === 'error' ? (
                          <>
                            <span className="aoDot aoDotBad" style={{ width: 6, height: 6 }} />
                            <span className="aoPillText">error</span>
                          </>
                        ) : (
                          <span className="aoPillText">unknown</span>
                        )}
                      </span>
                      {/* Expand/collapse chevron */}
                      <svg
                        viewBox="0 0 24 24"
                        aria-hidden="true"
                        style={{
                          width: 16,
                          height: 16,
                          flexShrink: 0,
                          transition: 'transform 150ms',
                          transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)',
                          color: 'rgba(13,18,32,0.4)',
                        }}
                      >
                        <path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </div>
                    {peer.last_incident ? (
                      <span className="aoHint" style={{ fontSize: 10, maxWidth: 160, textAlign: 'right' }}>
                        {peer.last_incident}
                      </span>
                    ) : null}
                    {fetchErrors[peer.node_id] ? (
                      <span
                        style={{ fontSize: 10, color: 'var(--ao-danger)', maxWidth: 160, textAlign: 'right' }}
                      >
                        {fetchErrors[peer.node_id]}
                      </span>
                    ) : null}
                  </div>
                </div>
                {/* Expanded diagnostics */}
                {isExpanded && (
                  <div style={{ display: 'grid', gap: 8, padding: '8px 0 4px 12px', borderLeft: '2px solid rgba(13,18,32,0.12)', marginLeft: 8 }}>
                    {peer.watchdog ? (
                      <WatchdogSection summary={peer.watchdog} loading={false} />
                    ) : (
                      <div className="aoCard" style={{ padding: '12px 14px' }}>
                        <div className="aoCardHeader">
                          <div className="aoCardTitle">Watchdog</div>
                        </div>
                        <p className="aoHint">No watchdog data from this peer.</p>
                      </div>
                    )}
                    {peer.webtransport ? (
                      <WebTransportSection snapshot={peer.webtransport} loading={false} />
                    ) : (
                      <div className="aoCard" style={{ padding: '12px 14px' }}>
                        <div className="aoCardHeader">
                          <div className="aoCardTitle">WebTransport</div>
                        </div>
                        <p className="aoHint">No WebTransport data from this peer.</p>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

interface TailscaleSectionProps {
  summary: TailscaleSummary | null
  loading: boolean
}

function TailscaleSection({ summary, loading }: TailscaleSectionProps) {
  const host = summary?.dns_name?.trim() || summary?.reachable_ipv4[0] || summary?.ipv4[0] || '—'
  return (
    <div className="aoCard" style={{ padding: '12px 14px' }}>
      <div className="aoCardHeader">
        <div className="aoCardTitle">Tailscale</div>
        {loading ? (
          <span className="aoHint">loading…</span>
        ) : (
          <span className={`aoPill${summary?.gateway_reachable ? ' aoPulse' : ''}`}>
            {summary?.gateway_reachable ? (
              <>
                <span className="aoDot" />
                <span className="aoPillText">reachable</span>
              </>
            ) : summary?.installed === false ? (
              <span className="aoPillText">not installed</span>
            ) : summary?.connected === false ? (
              <span className="aoPillText">offline</span>
            ) : (
              <>
                <span className="aoDot aoDotBad" />
                <span className="aoPillText">attention</span>
              </>
            )}
          </span>
        )}
      </div>
      {summary ? (
        <div className="aoKvp">
          <span className="aoKey">state</span>
          <span className="aoVal">{getTailscaleHeadline(summary)}</span>
          <span className="aoKey">host</span>
          <span className="aoVal aoValSmall">{host}</span>
          <span className="aoKey">ipv4</span>
          <span className="aoVal aoValSmall">{summary.ipv4.join(', ') || '—'}</span>
          <span className="aoKey">reachable</span>
          <span className="aoVal aoValSmall">{summary.reachable_ipv4.join(', ') || '—'}</span>
          <span className="aoKey">backend</span>
          <span className="aoVal">{summary.backend_state || '—'}</span>
          {summary.bootstrap?.last_stage ? (
            <>
              <span className="aoKey">bootstrap</span>
              <span className="aoVal aoValSmall">
                {summary.bootstrap.last_stage}
                {summary.bootstrap.last_detail ? ` · ${summary.bootstrap.last_detail}` : ''}
              </span>
            </>
          ) : null}
          {summary.status_error ? (
            <>
              <span className="aoKey">detail</span>
              <span className="aoVal aoValSmall" style={{ color: 'var(--ao-danger)' }}>
                {summary.status_error}
              </span>
            </>
          ) : null}
        </div>
      ) : (
        !loading && <p className="aoHint">No tailscale data available.</p>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// MonitoringPanel root
// ---------------------------------------------------------------------------

interface MonitoringPanelProps {
  status: Status | null
  gatewayTokenPreview: string
}

export function MonitoringPanel({ status }: MonitoringPanelProps) {
  const hasTauriInvoke = useMemo(() => hasTauriInvokeAvailable(), [])
  const isDevPreview = useMemo(() => isMonitoringDevPreview(), [])
  const [watchdog, setWatchdog] = useState<WatchdogSummary | null>(() => (
    isDevPreview ? DEV_PREVIEW_WATCHDOG_SUMMARY : null
  ))
  const [wtSnapshot, setWtSnapshot] = useState<WebTransportDomainSnapshot | null>(() => (
    isDevPreview ? DEV_PREVIEW_WEBTRANSPORT_SNAPSHOT : null
  ))
  const [tailscale, setTailscale] = useState<TailscaleSummary | null>(() => (
    isDevPreview ? DEV_PREVIEW_TAILSCALE_SUMMARY : (status?.tailscale ?? null)
  ))

  // Poll local diagnostics (watchdog + webtransport + tailscale) every 5s
  useEffect(() => {
    if (isDevPreview) {
      setWatchdog(DEV_PREVIEW_WATCHDOG_SUMMARY)
      setWtSnapshot(DEV_PREVIEW_WEBTRANSPORT_SNAPSHOT)
      setTailscale(DEV_PREVIEW_TAILSCALE_SUMMARY)
      return
    }
    if (!hasTauriInvoke) {
      setWatchdog(null)
      setWtSnapshot(null)
      setTailscale(status?.tailscale ?? null)
      return
    }
    let cancelled = false
    let timer: ReturnType<typeof setInterval> | null = null

    const load = async () => {
      try {
        const result = await invoke<Record<string, unknown>>('get_local_diagnostics', {
          domains: ['watchdog', 'webtransport', 'tailscale'],
        })
        if (cancelled) return
        if (result.watchdog) {
          setWatchdog(result.watchdog as WatchdogSummary)
        }
        if (result.webtransport) {
          setWtSnapshot(result.webtransport as WebTransportDomainSnapshot)
        }
        if (result.tailscale) {
          setTailscale(result.tailscale as TailscaleSummary)
        }
      } catch {
        // silently ignore — panel stays at last known state or null
      }
    }

    void load()
    timer = setInterval(() => { void load() }, 5_000)
    return () => {
      cancelled = true
      if (timer) clearInterval(timer)
    }
  }, [hasTauriInvoke, isDevPreview, status?.tailscale])

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
        gap: 14,
        padding: '0 4px 20px',
      }}
    >
      {isDevPreview ? (
        <div
          className="aoCard"
          style={{
            gridColumn: '1 / -1',
            padding: '12px 14px',
            border: '1px solid rgba(242, 193, 77, 0.42)',
            background: 'linear-gradient(180deg, rgba(255, 248, 225, 0.96), rgba(255, 252, 243, 0.98))',
          }}
        >
          <div className="aoCardHeader">
            <div className="aoCardTitle">Preview data</div>
          </div>
          <p className="aoHint" style={{ color: 'rgba(13,18,32,0.72)' }}>
            Simulated monitor diagnostics for the 5173 preview shell.
          </p>
        </div>
      ) : null}
      <TailscaleSection summary={tailscale} loading={false} />
      <WatchdogSection summary={watchdog} loading={false} />
      <WebTransportSection snapshot={wtSnapshot} loading={false} />
      <PeerDiagsSection status={status} />
    </div>
  )
}
