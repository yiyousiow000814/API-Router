import { useCallback, useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import type { Status } from '../types'

// ---------------------------------------------------------------------------
// Domain types (mirroring the backend)
// ---------------------------------------------------------------------------

export interface WatchdogSummary {
  healthy: boolean
  last_incident_kind: string | null
  incident_count: number
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

// ---------------------------------------------------------------------------
// Section 1 — Watchdog
// ---------------------------------------------------------------------------

interface WatchdogSectionProps {
  summary: WatchdogSummary | null
  loading: boolean
}

function WatchdogSection({ summary, loading }: WatchdogSectionProps) {
  const healthy = summary?.healthy ?? null
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
        <div className="aoKvp">
          <span className="aoKey">incidents</span>
          <span className="aoVal">{summary.incident_count}</span>
          {summary.last_incident_kind ? (
            <>
              <span className="aoKey">last incident</span>
              <span className="aoVal">{summary.last_incident_kind}</span>
            </>
          ) : null}
        </div>
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
    <div className="aoKvp">
      <span className="aoKey">{label}</span>
      <span className="aoVal">
        {ec.count}
        {ec.last_unix_ms ? (
          <span className="aoHint" style={{ marginLeft: 8 }}>{fmtTs(ec.last_unix_ms)}</span>
        ) : null}
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
        <p className="aoHint">No WebTransport data available.</p>
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
          <div className="aoKvp">
            <span className="aoKey">ws_error</span>
            <span className="aoVal aoValSmall" style={{ color: 'var(--ao-danger)' }}>
              {snapshot.ws_error_observed.count} {fmtTs(snapshot.ws_error_observed.last_unix_ms)}
              {snapshot.ws_error_observed.latest_detail
                ? ` — ${snapshot.ws_error_observed.latest_detail}`
                : null}
            </span>
          </div>
        )}
        {fmtRow('ws_close', {
          last_unix_ms: snapshot.ws_close_observed.last_unix_ms,
          count: snapshot.ws_close_observed.count,
        })}
        {snapshot.ws_close_observed.latest_close_code != null && (
          <div className="aoKvp">
            <span className="aoKey">close_code</span>
            <span className="aoVal">{snapshot.ws_close_observed.latest_close_code}</span>
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
}

interface PeerDiagsSectionProps {
  status: Status
}

function PeerDiagsSection({ status }: PeerDiagsSectionProps) {
  const [peers, setPeers] = useState<PeerDiagEntry[]>([])
  const [fetchErrors, setFetchErrors] = useState<Record<string, string>>({})
  const [refreshing, setRefreshing] = useState(false)

  const fetchPeerDiags = useCallback(async () => {
    setRefreshing(true)
    try {
      const knownPeers = status.lan_sync?.peers ?? []
      if (knownPeers.length === 0) {
        setPeers([])
        return
      }

      const results = await Promise.allSettled(
        knownPeers.map((peer) =>
          invoke<LanDiagnosticsResponsePacket>('get_remote_peer_diagnostics', {
            peerNodeId: peer.node_id,
            domains: ['watchdog'],
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
            | { healthy: boolean; last_incident_kind: string | null; incident_count: number }
            | undefined
          entries.push({
            node_id: peer.node_id,
            node_name: peer.node_name,
            health: wd?.healthy === false ? 'error' : wd?.healthy === true ? 'ok' : 'unknown',
            last_incident: wd?.last_incident_kind ?? null,
            fetched_at: Date.now(),
          })
        } else {
          errors[peer.node_id] = String(result.reason ?? 'fetch failed')
          entries.push({
            node_id: peer.node_id,
            node_name: peer.node_name,
            health: 'unknown',
            last_incident: null,
            fetched_at: Date.now(),
          })
        }
      })

      setPeers(entries)
      setFetchErrors(errors)
    } finally {
      setRefreshing(false)
    }
  }, [status.lan_sync?.peers])

  useEffect(() => {
    void fetchPeerDiags()
  }, [fetchPeerDiags])

  const knownPeers = status.lan_sync?.peers ?? []

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
            className="aoTinyBtn"
            onClick={() => { void fetchPeerDiags() }}
            disabled={refreshing}
            title="Refresh peer diagnostics"
          >
            {refreshing ? '…' : '↻'}
          </button>
        </div>
      </div>
      {knownPeers.length === 0 ? (
        <p className="aoHint">No LAN peers discovered yet.</p>
      ) : (
        <div style={{ display: 'grid', gap: 6 }}>
          {peers.map((peer) => (
            <div
              key={peer.node_id}
              style={{
                display: 'grid',
                gridTemplateColumns: 'minmax(0,1fr) auto',
                gap: 8,
                alignItems: 'center',
                padding: '8px 10px',
                borderRadius: 10,
                border: '1px solid rgba(13,18,32,0.08)',
                background: 'rgba(255,255,255,0.5)',
              }}
            >
              <div>
                <div style={{ fontSize: 13, fontWeight: 700, color: 'rgba(13,18,32,0.86)' }}>
                  {peer.node_name}
                </div>
                <div className="aoHint" style={{ fontSize: 11 }}>
                  {peer.node_id.slice(0, 12)} · fetched {fmtAge(peer.fetched_at)}
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}>
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
          ))}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// MonitoringPanel root
// ---------------------------------------------------------------------------

interface MonitoringPanelProps {
  status: Status
  gatewayTokenPreview: string
}

export function MonitoringPanel({ status }: MonitoringPanelProps) {
  const [watchdog, setWatchdog] = useState<WatchdogSummary | null>(null)
  const [wtSnapshot, setWtSnapshot] = useState<WebTransportDomainSnapshot | null>(null)

  // ---- Watchdog: poll every 10s ------------------------------------------------
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setInterval> | null = null

    const load = async () => {
      try {
        const result = await invoke<WatchdogSummary>('get_watchdog_summary')
        if (!cancelled) setWatchdog(result)
      } catch {
        // silently ignore — panel stays at last known state or null
      }
    }

    void load()
    timer = setInterval(() => { void load() }, 10_000)
    return () => {
      cancelled = true
      if (timer) clearInterval(timer)
    }
  }, [])

  // ---- WebTransport: poll every 5s --------------------------------------------
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setInterval> | null = null

    const load = async () => {
      try {
        const result = await invoke<WebTransportDomainSnapshot>('get_web_transport_snapshot')
        if (!cancelled) setWtSnapshot(result)
      } catch {
        // silently ignore
      }
    }

    void load()
    timer = setInterval(() => { void load() }, 5_000)
    return () => {
      cancelled = true
      if (timer) clearInterval(timer)
    }
  }, [])

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
        gap: 14,
        padding: '0 4px 20px',
      }}
    >
      <WatchdogSection summary={watchdog} loading={false} />
      <WebTransportSection snapshot={wtSnapshot} loading={false} />
      <PeerDiagsSection status={status} />
    </div>
  )
}