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
  last_incident_detail?: string | null
  last_incident_unix_ms?: number | null
  last_incident_file?: string | null
  incident_count: number
  recent_incidents?: Array<{
    unix_ms: number
    kind: string
    file: string
    detail?: string | null
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
type LanPeerStatus = NonNullable<Status['lan_sync']>['peers'][number]

const LAN_DIAGNOSTICS_CAPABILITY = 'lan_debug_v2'

const DEV_PREVIEW_WATCHDOG_SUMMARY: WatchdogSummary = {
  healthy: false,
  incident_count: 3,
  last_incident_kind: 'heartbeat-stall',
  last_incident_detail: 'UI heartbeat stalled',
  last_incident_unix_ms: 1_700_000_002_000,
  last_incident_file: 'ui-freeze-1700000002000-heartbeat-stall.json',
  recent_incidents: [
    {
      unix_ms: 1_700_000_002_000,
      kind: 'heartbeat-stall',
      file: 'ui-freeze-1700000002000-heartbeat-stall.json',
      detail: 'UI heartbeat stalled',
    },
    {
      unix_ms: 1_700_000_001_000,
      kind: 'slow-refresh',
      file: 'slow-refresh-1700000001000-status.json',
      detail: 'Status poll interval refresh too slow',
    },
    {
      unix_ms: 1_700_000_000_000,
      kind: 'frame-stall',
      file: 'frame-stall-1700000000000-render-blocked.json',
      detail: 'UI frame stalled',
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
      last_incident_detail: 'UI heartbeat stalled',
      last_incident_unix_ms: 1_700_000_001_800,
      last_incident_file: 'ui-freeze-1700000001800-heartbeat-stall.json',
      recent_incidents: [
        {
          unix_ms: 1_700_000_001_800,
          kind: 'heartbeat-stall',
          file: 'ui-freeze-1700000001800-heartbeat-stall.json',
          detail: 'UI heartbeat stalled',
        },
        {
          unix_ms: 1_700_000_001_500,
          kind: 'frame-stall',
          file: 'frame-stall-1700000001500-render-blocked.json',
          detail: 'UI frame stalled',
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
      last_incident_detail: null,
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

export function formatIncidentKind(kind: string | null | undefined): string {
  if (!kind) return 'Incident'
  switch (kind) {
    case 'heartbeat-stall':
      return 'UI heartbeat stalled'
    case 'slow-refresh':
      return 'Remote diagnostics refresh too slow'
    case 'slow-invoke':
      return 'Remote diagnostics request too slow'
    case 'invoke-error':
      return 'Remote diagnostics request failed'
    case 'frame-stall':
      return 'UI main thread stalled'
    case 'status':
      return 'Status snapshot issue'
    default:
      return kind
        .replace(/[-_]+/g, ' ')
        .replace(/\b\w/g, (match) => match.toUpperCase())
    }
}

export function peerSupportsLanDiagnostics(peer: LanPeerStatus): boolean {
  return Boolean(peer.trusted && (peer.version_inventory ?? []).includes(LAN_DIAGNOSTICS_CAPABILITY))
}

function lanDiagnosticsUnavailableReason(peer: LanPeerStatus): string {
  if (!peer.trusted) {
    return 'Peer is not trusted for LAN diagnostics.'
  }
  if (!(peer.version_inventory ?? []).includes(LAN_DIAGNOSTICS_CAPABILITY)) {
    return 'Peer does not advertise LAN diagnostics yet.'
  }
  return ''
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

type LocalDomain = 'tailscale' | 'webtransport' | 'watchdog'

const LOCAL_DOMAIN_ACCENTS: Record<LocalDomain, string> = {
  tailscale: 'rgba(23,115,200,0.42)',
  webtransport: 'rgba(130,80,220,0.42)',
  watchdog: 'rgba(255,94,125,0.42)',
}

function getLocalDomainAccent(domain: LocalDomain | null | undefined): string {
  if (!domain) return 'var(--ao-line)'
  return LOCAL_DOMAIN_ACCENTS[domain]
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
  /** When false, hides the Recent incidents list (used in Local Node detail to avoid
   *  duplicating Active Abnormal Conditions). Peer diagnostics keep it visible. */
  showIncidents?: boolean
}

function WatchdogSection({ summary, loading, showIncidents = true }: WatchdogSectionProps) {
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
                <span className="aoVal">
                  {summary.last_incident_detail ?? formatIncidentKind(summary.last_incident_kind)}
                </span>
                <span className="aoKey">last seen</span>
                <span className="aoVal">{fmtDateTime(summary.last_incident_unix_ms ?? 0)}</span>
                <span className="aoKey">last file</span>
                <span className="aoVal aoValSmall">{summary.last_incident_file ?? '—'}</span>
              </>
            ) : null}
          </div>
          {showIncidents && recentIncidents.length > 0 ? (
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
                    <span style={{ fontSize: 12, fontWeight: 700, color: 'rgba(13,18,32,0.88)' }}>
                      {incident.detail ?? formatIncidentKind(incident.kind)}
                    </span>
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
// Section 3 — Tailscale
// ---------------------------------------------------------------------------

interface TailscaleSectionProps {
  summary: TailscaleSummary | null
  loading: boolean
}

function TailscaleSection({ summary, loading }: TailscaleSectionProps) {
  const host = summary?.dns_name?.trim() || summary?.reachable_ipv4[0] || summary?.ipv4[0] || '—'
  if (loading && !summary) {
    return (
      <div className="aoCard" style={{ padding: '12px 14px' }}>
        <div className="aoCardHeader">
          <div className="aoCardTitle">Tailscale</div>
          <span className="aoHint">loading…</span>
        </div>
      </div>
    )
  }
  if (!summary) {
    return (
      <div className="aoCard" style={{ padding: '12px 14px' }}>
        <div className="aoCardHeader">
          <div className="aoCardTitle">Tailscale</div>
        </div>
        <p className="aoHint">No Tailscale data from this peer.</p>
      </div>
    )
  }
  return (
    <div className="aoCard" style={{ padding: '12px 14px' }}>
      <div className="aoCardHeader">
        <div className="aoCardTitle">Tailscale</div>
        <span className={`aoPill${summary.gateway_reachable ? ' aoPulse' : ''}`}>
          {summary.gateway_reachable ? (
            <>
              <span className="aoDot" />
              <span className="aoPillText">reachable</span>
            </>
          ) : summary.installed === false ? (
            <>
              <span className="aoDot aoDotBad" />
              <span className="aoPillText">missing</span>
            </>
          ) : summary.connected === false ? (
            <>
              <span className="aoDot aoDotBad" />
              <span className="aoPillText">disconnected</span>
            </>
          ) : (
            <span className="aoPillText">ok</span>
          )}
        </span>
      </div>
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
    </div>
  )
}

// ---------------------------------------------------------------------------
// Section 3 — Remote Peer Diagnostics (each peer = its own card)
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
  const [refreshSpinActive, setRefreshSpinActive] = useState(false)
  const [refreshSpinStopRequested, setRefreshSpinStopRequested] = useState(false)
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

  const startRefreshSpin = useCallback(() => {
    setRefreshSpinActive(true)
    setRefreshSpinStopRequested(false)
  }, [])

  const requestRefreshSpinStop = useCallback(() => {
    setRefreshSpinStopRequested(true)
  }, [])

  const handleRefreshSpinIteration = useCallback(() => {
    if (!refreshSpinStopRequested) return
    setRefreshSpinActive(false)
    setRefreshSpinStopRequested(false)
  }, [refreshSpinStopRequested])

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
    startRefreshSpin()
    setRefreshing(true)
    try {
      const knownPeers = peersRef.current
      if (knownPeers.length === 0) {
        setPeers([])
        return
      }

      const fetchablePeers = knownPeers.filter(peerSupportsLanDiagnostics)
      const results = await Promise.allSettled(
        fetchablePeers.map((peer) =>
          invoke<LanDiagnosticsResponsePacket>('get_remote_peer_diagnostics', {
            peerNodeId: peer.node_id,
            domains: ['watchdog', 'webtransport', 'tailscale'],
          }),
        ),
      )

      const entries: PeerDiagEntry[] = []
      const errors: Record<string, string> = {}
      const fetchableResults = new Map(fetchablePeers.map((peer, idx) => [peer.node_id, results[idx]] as const))
      const now = Date.now()

      knownPeers.forEach((peer) => {
        const result = fetchableResults.get(peer.node_id)
        if (!result) {
          errors[peer.node_id] = lanDiagnosticsUnavailableReason(peer)
          entries.push({
            node_id: peer.node_id,
            node_name: peer.node_name,
            health: 'unknown',
            last_incident: null,
            fetched_at: now,
            tailscale: peer.tailscale ?? null,
            watchdog: null,
            webtransport: null,
          })
          return
        }
        if (result.status === 'fulfilled') {
          const diag = result.value
          const wd = diag.domains?.watchdog as
            | { healthy: boolean; last_incident_kind: string | null; incident_count: number; last_incident_unix_ms?: number | null; last_incident_file?: string | null; recent_incidents?: Array<{ unix_ms: number; kind: string; file: string }> }
            | undefined
          const wts = diag.domains?.webtransport as WebTransportDomainSnapshot | undefined
          const ts = diag.domains?.tailscale as TailscaleSummary | undefined
          entries.push({
            node_id: peer.node_id,
            node_name: peer.node_name,
            health: wd?.healthy === false ? 'error' : wd?.healthy === true ? 'ok' : 'unknown',
            last_incident: wd?.last_incident_kind ?? null,
            fetched_at: now,
            tailscale: ts ?? peer.tailscale ?? null,
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
            fetched_at: now,
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
      requestRefreshSpinStop()
    }
  }, [hasTauriInvoke, isDevPreview, requestRefreshSpinStop, startRefreshSpin])

  useEffect(() => {
    void fetchPeerDiags()
    const timer = window.setInterval(() => {
      void fetchPeerDiags()
    }, 30_000)
    return () => window.clearInterval(timer)
  }, [fetchPeerDiags])

  const knownPeers = isDevPreview ? previewPeers : (status?.lan_sync?.peers ?? [])

  const fetchAll = useCallback(() => { void fetchPeerDiags() }, [fetchPeerDiags])

  return (
    <div>
      {/* Section header */}
      <div className="aoSectionHeader">
        <div className="aoMiniLabel" style={{ fontSize: 12, letterSpacing: '0.1em' }}>
          Remote Peers
          {knownPeers.length > 0 && (
            <span style={{ marginLeft: 6, color: 'rgba(13,18,32,0.4)' }}>({knownPeers.length})</span>
          )}
        </div>
        <button
          className={`aoUsageRefreshBtn aoUsageRefreshBtnMini${refreshing || refreshSpinActive ? ' aoUsageRefreshBtnSpin' : ''}`}
          onClick={fetchAll}
          disabled={refreshing || refreshSpinActive || !hasTauriInvoke || isDevPreview}
          title="Fetch diagnostics from all peers"
          aria-label="Fetch diagnostics from all peers"
          style={{ opacity: (!hasTauriInvoke || isDevPreview) ? 0.4 : 1 }}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true" onAnimationIteration={handleRefreshSpinIteration}>
            <path d="M23 4v6h-6" />
            <path d="M1 20v-6h6" />
            <path d="M3.5 9a9 9 0 0 1 14.1-3.4L23 10" />
            <path d="M1 14l5.3 5.3A9 9 0 0 0 20.5 15" />
          </svg>
        </button>
      </div>

      {!status ? (
        <div className="aoCard" style={{ padding: '12px 14px' }}>
          <span className="aoHint">Waiting for live gateway status.</span>
        </div>
      ) : !hasTauriInvoke && !isDevPreview ? (
        <div className="aoCard" style={{ padding: '12px 14px' }}>
          <span className="aoHint">Remote peer diagnostics are available in the Tauri desktop app only.</span>
        </div>
      ) : knownPeers.length === 0 ? (
        <div className="aoCard" style={{ padding: '12px 14px' }}>
          <span className="aoHint">No LAN peers discovered yet.</span>
        </div>
      ) : (
        /* Each peer = its own card */
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {peers.map((peer) => {
            const isExpanded = expandedPeers.has(peer.node_id)
            const peerStatus = isDevPreview ? null : status?.lan_sync?.peers?.find(p => p.node_id === peer.node_id)
            const listenAddr = peerStatus?.listen_addr || peer.node_id.slice(0, 12)

            return (
              <div key={peer.node_id} className="aoMonPeerCard">
                {/* Peer card header — always visible */}
                <div className="aoMonPeerCardHeader">
                  {/* Left: name + address */}
                  <div className="aoMonPeerCardMeta">
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span className="aoMonPeerCardName">{peer.node_name}</span>
                      <span className={`aoPill${peer.health === 'ok' ? ' aoPulse' : peer.health === 'error' ? '' : ''}`} style={{ fontSize: 10 }}>
                        {peer.health === 'ok' ? (
                          <><span className="aoDot" style={{ width: 5, height: 5 }} /><span className="aoPillText">ok</span></>
                        ) : peer.health === 'error' ? (
                          <><span className="aoDot aoDotBad" style={{ width: 5, height: 5 }} /><span className="aoPillText">error</span></>
                        ) : (
                          <span className="aoPillText">unknown</span>
                        )}
                      </span>
                    </div>
                    <div className="aoMonPeerCardId">
                      {listenAddr} · fetched {fmtAge(peer.fetched_at)}
                    </div>
                    {peer.tailscale && (
                      <div className="aoHint" style={{ fontSize: 11, marginTop: 2 }}>
                        {getTailscaleDetail(peer.tailscale)}
                      </div>
                    )}
                  </div>

                  {/* Right: domain dots + expand */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    {/* Domain status dots */}
                    <div className="aoMonPeerDomainDots">
                      <span className="aoMonPeerDomainDot" title="Tailscale">
                        <span
                          className="aoDot"
                          style={{
                            width: 6,
                            height: 6,
                            background: peer.tailscale?.gateway_reachable
                              ? undefined
                              : peer.tailscale?.connected
                              ? 'var(--ao-warn, rgba(255,182,72,0.9))'
                              : 'rgba(13,18,32,0.2)',
                          }}
                        />
                        <span>TS</span>
                      </span>
                      <span className="aoMonPeerDomainDot" title="Watchdog">
                        <span
                          className="aoDot"
                          style={{
                            width: 6,
                            height: 6,
                            background: peer.watchdog?.healthy === false
                              ? 'var(--ao-danger, rgba(255,94,125,0.9))'
                              : peer.watchdog?.healthy === true
                              ? undefined
                              : 'rgba(13,18,32,0.2)',
                          }}
                        />
                        <span>WD</span>
                      </span>
                      <span className="aoMonPeerDomainDot" title="WebTransport">
                        <span
                          className="aoDot"
                          style={{
                            width: 6,
                            height: 6,
                            background: peer.webtransport?.ws_error_observed.count === 0
                              ? undefined
                              : 'var(--ao-danger, rgba(255,94,125,0.9))',
                          }}
                        />
                        <span>WS</span>
                      </span>
                    </div>

                    {/* Expand/collapse chevron */}
                    <button
                      type="button"
                      onClick={() => togglePeer(peer.node_id)}
                      style={{
                        appearance: 'none',
                        background: 'none',
                        border: 'none',
                        padding: 4,
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        color: 'rgba(13,18,32,0.4)',
                      }}
                      aria-label={isExpanded ? 'Collapse peer diagnostics' : 'Expand peer diagnostics'}
                      title={isExpanded ? 'Collapse' : 'Expand details'}
                    >
                      <svg
                        viewBox="0 0 24 24"
                        aria-hidden="true"
                        style={{
                          width: 16,
                          height: 16,
                          flexShrink: 0,
                          transition: 'transform 150ms',
                          transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)',
                        }}
                      >
                        <path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </button>
                  </div>
                </div>

                {/* Error message */}
                {fetchErrors[peer.node_id] ? (
                  <div style={{ fontSize: 11, color: 'var(--ao-danger)', padding: '2px 0' }}>
                    Fetch error: {fetchErrors[peer.node_id]}
                  </div>
                ) : null}

                {/* Expanded diagnostics */}
                {isExpanded && (
                  <div className="aoMonPeerExpanded">
                    <TailscaleSection summary={peer.tailscale ?? null} loading={false} />
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

// ---------------------------------------------------------------------------
// Tailscale Detail View (full-width, used in expanded Local Node view)
// ---------------------------------------------------------------------------

function TailscaleDetailView({ summary }: { summary: TailscaleSummary | null }) {
  const host = summary?.dns_name?.trim() || summary?.reachable_ipv4[0] || summary?.ipv4[0] || '—'
  if (!summary) {
    return <p className="aoHint">No tailscale data available.</p>
  }
  return (
    <div>
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
  const [expandedLocalDomain, setExpandedLocalDomain] = useState<LocalDomain | null>(null)

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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '0 4px 20px' }}>
      {isDevPreview ? (
        <div
          className="aoCard"
          style={{
            padding: '10px 14px',
            border: '1px solid rgba(242, 193, 77, 0.42)',
            background: 'linear-gradient(180deg, rgba(255, 248, 225, 0.96), rgba(255, 252, 243, 0.98))',
          }}
        >
          <span style={{ fontSize: 12, fontWeight: 600, color: 'rgba(13,18,32,0.72)' }}>
            Preview data — simulated monitor diagnostics for the 5173 preview shell.
          </span>
        </div>
      ) : null}

      {/* ── Section 1: Local Node ── */}
      <div>
        <div className="aoSectionHeader">
          <div className="aoMiniLabel" style={{ fontSize: 12, letterSpacing: '0.1em' }}>Local Node</div>
        </div>
        {expandedLocalDomain ? (
          /* Full-width detail view when a domain is expanded */
          <div
            className="aoCard"
            style={{
              padding: '14px 16px',
              borderColor: getLocalDomainAccent(expandedLocalDomain),
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: 'rgba(13,18,32,0.88)' }}>
                {expandedLocalDomain === 'tailscale' ? 'Tailscale' :
                 expandedLocalDomain === 'webtransport' ? 'WebTransport' :
                 'Watchdog'} — Details
              </div>
              <button
                type="button"
                onClick={() => setExpandedLocalDomain(null)}
                style={{
                  appearance: 'none',
                  background: 'rgba(13,18,32,0.04)',
                  border: '1px solid rgba(13,18,32,0.10)',
                  borderRadius: 8,
                  padding: '5px 12px',
                  cursor: 'pointer',
                  fontSize: 12,
                  fontWeight: 600,
                  color: 'rgba(13,18,32,0.65)',
                  fontFamily: 'inherit',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 5,
                }}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" aria-hidden="true" style={{ flexShrink: 0, color: 'rgba(13,18,32,0.5)' }}>
                  <path d="M15 18l-6-6 6-6" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                Back
              </button>
            </div>
            {expandedLocalDomain === 'tailscale' && (
              <TailscaleDetailView summary={tailscale} />
            )}
            {expandedLocalDomain === 'webtransport' && (
              <WebTransportSection snapshot={wtSnapshot} loading={false} />
            )}
            {expandedLocalDomain === 'watchdog' && (
              <WatchdogSection summary={watchdog} loading={false} />
            )}
          </div>
        ) : (
          /* Compact card grid */
          <div className="aoMonLocalNode">
            {/* Tailscale card */}
            <div className="aoMonLocalCard" style={{ boxShadow: 'inset 3px 0 0 rgba(23,115,200,0.75)' }}>
              <div className="aoMonLocalCardHeader">
                <span className="aoMonLocalCardTitle">Tailscale</span>
                {tailscale ? (
                  <span className={`aoPill${tailscale.gateway_reachable ? ' aoPulse' : ''}`}>
                    {tailscale.gateway_reachable ? (
                      <><span className="aoDot" /><span className="aoPillText">ok</span></>
                    ) : tailscale.installed === false ? (
                      <span className="aoPillText">not installed</span>
                    ) : tailscale.connected === false ? (
                      <span className="aoPillText">offline</span>
                    ) : (
                      <><span className="aoDot aoDotBad" /><span className="aoPillText">attention</span></>
                    )}
                  </span>
                ) : (
                  <span className="aoHint" style={{ fontSize: 11 }}>—</span>
                )}
              </div>
              <div className="aoMonLocalCardBody">
                {tailscale ? (
                  <>
                    <div>{getTailscaleHeadline(tailscale)}</div>
                    <div style={{ marginTop: 2, fontSize: 11 }}>
                      {tailscale.dns_name || tailscale.ipv4[0] || '—'}
                    </div>
                  </>
                ) : (
                  <div>No tailscale data available.</div>
                )}
              </div>
              <button
                type="button"
                onClick={() => setExpandedLocalDomain('tailscale')}
                style={{
                  appearance: 'none',
                  background: 'none',
                  border: 'none',
                  padding: '4px 0 0',
                  marginTop: 'auto',
                  cursor: 'pointer',
                  fontSize: 11,
                  fontWeight: 600,
                  color: 'var(--ao-accent, rgba(26,115,232,0.85))',
                  fontFamily: 'inherit',
                  textAlign: 'left',
                }}
              >
                View details →
              </button>
            </div>
            {/* WebTransport card */}
            <div className="aoMonLocalCard" style={{ boxShadow: 'inset 3px 0 0 rgba(130,80,220,0.75)' }}>
              <div className="aoMonLocalCardHeader">
                <span className="aoMonLocalCardTitle">WebTransport</span>
                {wtSnapshot ? (
                  <span className={`aoPill${wtSnapshot.ws_error_observed.count === 0 ? ' aoPulse' : ''}`}>
                    {wtSnapshot.ws_error_observed.count === 0 ? (
                      <><span className="aoDot" /><span className="aoPillText">ok</span></>
                    ) : (
                      <><span className="aoDot aoDotBad" /><span className="aoPillText">{wtSnapshot.ws_error_observed.count} error</span></>
                    )}
                  </span>
                ) : (
                  <span className="aoHint" style={{ fontSize: 11 }}>—</span>
                )}
              </div>
              <div className="aoMonLocalCardBody">
                {wtSnapshot ? (
                  <>
                    <div>
                      {wtSnapshot.ws_error_observed.count === 0 ? 'Connection stable' : `${wtSnapshot.ws_error_observed.count} error(s)`}
                    </div>
                    {wtSnapshot.http_fallback_engaged.count > 0 && (
                      <div style={{ marginTop: 2, fontSize: 11, color: 'var(--ao-danger)' }}>
                        {wtSnapshot.http_fallback_engaged.count} HTTP fallback(s)
                      </div>
                    )}
                  </>
                ) : (
                  <div>No WebTransport data yet.</div>
                )}
              </div>
              <button
                type="button"
                onClick={() => setExpandedLocalDomain('webtransport')}
                style={{
                  appearance: 'none',
                  background: 'none',
                  border: 'none',
                  padding: '4px 0 0',
                  marginTop: 'auto',
                  cursor: 'pointer',
                  fontSize: 11,
                  fontWeight: 600,
                  color: 'var(--ao-accent, rgba(26,115,232,0.85))',
                  fontFamily: 'inherit',
                  textAlign: 'left',
                }}
              >
                View details →
              </button>
            </div>
            {/* Watchdog card */}
            <div className="aoMonLocalCard" style={{ boxShadow: 'inset 3px 0 0 rgba(255,94,125,0.8)' }}>
              <div className="aoMonLocalCardHeader">
                <span className="aoMonLocalCardTitle">Watchdog</span>
                {watchdog !== null ? (
                  <span className={`aoPill${watchdog.healthy ? ' aoPulse' : ''}`}>
                    {watchdog.healthy ? (
                      <><span className="aoDot" /><span className="aoPillText">ok</span></>
                    ) : (
                      <><span className="aoDot aoDotBad" /><span className="aoPillText">unhealthy</span></>
                    )}
                  </span>
                ) : (
                  <span className="aoHint" style={{ fontSize: 11 }}>—</span>
                )}
              </div>
              <div className="aoMonLocalCardBody">
                {watchdog !== null ? (
                  <>
                    <div>
                      {watchdog.healthy
                        ? 'All systems healthy'
                        : `${watchdog.incident_count} incident(s), last: ${formatIncidentKind(watchdog.last_incident_kind)}`}
                    </div>
                    {watchdog.last_incident_unix_ms && (
                      <div style={{ marginTop: 2, fontSize: 11 }}>
                        {fmtAge(watchdog.last_incident_unix_ms ?? 0)}
                      </div>
                    )}
                  </>
                ) : (
                  <div>No watchdog data available.</div>
                )}
              </div>
              <button
                type="button"
                onClick={() => setExpandedLocalDomain('watchdog')}
                style={{
                  appearance: 'none',
                  background: 'none',
                  border: 'none',
                  padding: '4px 0 0',
                  marginTop: 'auto',
                  cursor: 'pointer',
                  fontSize: 11,
                  fontWeight: 600,
                  color: 'var(--ao-accent, rgba(26,115,232,0.85))',
                  fontFamily: 'inherit',
                  textAlign: 'left',
                }}
              >
                View details →
              </button>
            </div>
            {/* LAN card */}
            <div className="aoMonLocalCard" style={{ boxShadow: 'inset 3px 0 0 rgba(50,180,100,0.7)' }}>
              <div className="aoMonLocalCardHeader">
                <span className="aoMonLocalCardTitle">LAN</span>
                <span className="aoPill aoPulse">
                  <span className="aoDot" />
                  <span className="aoPillText">ok</span>
                </span>
              </div>
              <div className="aoMonLocalCardBody">
                <div>{status?.lan_sync?.peers?.length ?? 0} peer(s) discovered</div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ── Section 2: Active Abnormal Conditions ── */}
      <ActiveAbnormalConditions
        watchdog={watchdog}
        wtSnapshot={wtSnapshot}
        tailscale={tailscale}
      />

      {/* ── Section 3: Remote Peers ── */}
      <PeerDiagsSection status={status} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Section 2 — Active Abnormal Conditions
// ---------------------------------------------------------------------------

interface AbnormCondProps {
  watchdog: WatchdogSummary | null
  wtSnapshot: WebTransportDomainSnapshot | null
  tailscale: TailscaleSummary | null
}

function ActiveAbnormalConditions({ watchdog, wtSnapshot, tailscale }: AbnormCondProps) {
  type CondSeverity = 'warn' | 'error'
  type CondDomain = 'wd' | 'wt' | 'ts' | 'lan'
  type Cond = { kind: string; severity: CondSeverity; domain: CondDomain; detail: string; age?: string }

  const conditions: Cond[] = []

  // Watchdog
  if (watchdog && !watchdog.healthy && watchdog.last_incident_kind) {
    conditions.push({
      kind: watchdog.last_incident_detail ?? formatIncidentKind(watchdog.last_incident_kind),
      severity: 'error',
      domain: 'wd',
      detail: watchdog.last_incident_file ?? '',
      age: watchdog.last_incident_unix_ms ? fmtAge(watchdog.last_incident_unix_ms) : undefined,
    })
  }

  // WebTransport
  if (wtSnapshot) {
    if (wtSnapshot.ws_error_observed.count > 0) {
      conditions.push({
        kind: 'WebSocket error',
        severity: 'error',
        domain: 'wt',
        detail: wtSnapshot.ws_error_observed.latest_detail ?? '',
        age: wtSnapshot.ws_error_observed.last_unix_ms ? fmtAge(wtSnapshot.ws_error_observed.last_unix_ms) : undefined,
      })
    }
    if (wtSnapshot.http_fallback_engaged.count > 0) {
      conditions.push({
        kind: 'HTTP fallback',
        severity: 'warn',
        domain: 'wt',
        detail: '',
        age: wtSnapshot.http_fallback_engaged.last_unix_ms ? fmtAge(wtSnapshot.http_fallback_engaged.last_unix_ms) : undefined,
      })
    }
    if (wtSnapshot.thread_refresh_failed.count > 0) {
      conditions.push({
        kind: 'WebTransport thread refresh failed',
        severity: 'error',
        domain: 'wt',
        detail: `${wtSnapshot.thread_refresh_failed.count} failure(s)`,
        age: wtSnapshot.thread_refresh_failed.last_unix_ms ? fmtAge(wtSnapshot.thread_refresh_failed.last_unix_ms) : undefined,
      })
    }
  }

  // Tailscale
  if (tailscale) {
    if (tailscale.installed === false) {
      conditions.push({
        kind: 'Not installed',
        severity: 'warn',
        domain: 'ts',
        detail: 'Install Tailscale to enable remote access',
        age: undefined,
      })
    } else if (tailscale.connected === false) {
      conditions.push({
        kind: 'Not connected',
        severity: 'error',
        domain: 'ts',
        detail: tailscale.status_error ?? 'Connect to the tailnet',
        age: undefined,
      })
    } else if (tailscale.needs_gateway_restart) {
      conditions.push({
        kind: 'Needs restart',
        severity: 'error',
        domain: 'ts',
        detail: 'Restart API Router to restore gateway binding',
        age: undefined,
      })
    } else if (!tailscale.gateway_reachable) {
      conditions.push({
        kind: 'Gateway unreachable',
        severity: 'warn',
        domain: 'ts',
        detail: tailscale.status_error ?? '',
        age: tailscale.bootstrap?.updated_at_unix_ms ? fmtAge(tailscale.bootstrap.updated_at_unix_ms) : undefined,
      })
    } else if (tailscale.status_error?.trim()) {
      conditions.push({
        kind: 'Status error',
        severity: 'warn',
        domain: 'ts',
        detail: tailscale.status_error.trim(),
        age: undefined,
      })
    }
  }

  return (
    <div>
      <div className="aoSectionHeader">
        <div className="aoMiniLabel" style={{ fontSize: 12, letterSpacing: '0.1em' }}>
          Active Abnormal Conditions
          {conditions.length > 0 && (
            <span style={{ marginLeft: 6, fontSize: 11, fontWeight: 700, color: 'var(--ao-danger)' }}>
              ({conditions.length})
            </span>
          )}
        </div>
      </div>
      {conditions.length === 0 ? (
        <div className="aoCard" style={{ padding: '12px 14px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="rgba(13,18,32,0.4)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
              <polyline points="22 4 12 14.01 9 11.01" />
            </svg>
            <span style={{ fontSize: 12, color: 'rgba(13,18,32,0.55)' }}>No active abnormal conditions</span>
          </div>
        </div>
      ) : (
        <div className="aoMonAbnormalList">
          {conditions.map((cond, i) => (
            <div
              key={i}
              className="aoMonAbnormalItem"
            >
              <div className="aoMonAbnormalRail" aria-hidden="true">
                <span
                  className="aoMonAbnormalRailDot"
                  style={{
                    background:
                      cond.domain === 'wd'
                        ? 'rgba(255,94,125,0.8)'
                        : cond.domain === 'wt'
                          ? 'rgba(130,80,220,0.78)'
                          : cond.domain === 'ts'
                            ? 'rgba(23,115,200,0.78)'
                            : 'rgba(50,180,100,0.72)',
                    boxShadow:
                      cond.domain === 'wd'
                        ? 'inset 0 0 0 1px rgba(255,94,125,0.18)'
                        : cond.domain === 'wt'
                          ? 'inset 0 0 0 1px rgba(130,80,220,0.18)'
                          : cond.domain === 'ts'
                            ? 'inset 0 0 0 1px rgba(23,115,200,0.18)'
                            : 'inset 0 0 0 1px rgba(50,180,100,0.18)',
                  }}
                />
              </div>
              <div className="aoMonAbnormalText" style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'rgba(13,18,32,0.82)' }}>{cond.kind}</div>
                {cond.detail ? (
                  <div className="aoHint" style={{ fontSize: 11, marginTop: 1 }}>{cond.detail}</div>
                ) : null}
              </div>
              {/* Right: domain label + age */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                <span style={{
                  display: 'inline-block',
                  padding: '0 5px',
                  borderRadius: 999,
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: '0.06em',
                  textTransform: 'uppercase',
                  lineHeight: 1.5,
                  border: `1px solid ${
                    cond.domain === 'wd' ? 'rgba(255,94,125,0.45)' :
                    cond.domain === 'wt' ? 'rgba(130,80,220,0.45)' :
                    cond.domain === 'ts' ? 'rgba(23,115,200,0.45)' :
                    'rgba(50,180,100,0.45)'
                  }`,
                  background: `rgba(${
                    cond.domain === 'wd' ? '255,94,125' :
                    cond.domain === 'wt' ? '130,80,220' :
                    cond.domain === 'ts' ? '23,115,200' :
                    '50,180,100'
                  }, 0.08)`,
                  color: `rgba(${
                    cond.domain === 'wd' ? '200,30,80' :
                    cond.domain === 'wt' ? '100,55,180' :
                    cond.domain === 'ts' ? '15,90,170' :
                    '35,150,80'
                  }, 0.95)`,
                }}>
                  {cond.domain === 'wd' ? 'WD' : cond.domain === 'wt' ? 'WT' : cond.domain === 'ts' ? 'TS' : 'LAN'}
                </span>
                {cond.age ? (
                  <span className="aoMonAbnormalAge">{cond.age}</span>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
