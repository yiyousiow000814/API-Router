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
  activity_window_minutes?: number
  activity_bucket_minutes?: number
  activity_buckets?: Array<{
    bucket_start_unix_ms: number
    bucket_end_unix_ms: number
    count: number
  }>
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
const WATCHDOG_ACTIVITY_WINDOW_MINUTES = 12 * 60
const WATCHDOG_ACTIVITY_BUCKET_MINUTES = 5
const WATCHDOG_ACTIVITY_BUCKET_COUNT =
  WATCHDOG_ACTIVITY_WINDOW_MINUTES / WATCHDOG_ACTIVITY_BUCKET_MINUTES
const WEB_TRANSPORT_RECENT_WINDOW_MINUTES = 15
const WEB_TRANSPORT_RECENT_WINDOW_MS = WEB_TRANSPORT_RECENT_WINDOW_MINUTES * 60_000

const DEV_PREVIEW_WEB_TRANSPORT_NOW_MS = Date.now()
const previewWebTransportMs = (offsetMs: number) => DEV_PREVIEW_WEB_TRANSPORT_NOW_MS - offsetMs

type WatchdogActivityBucket = NonNullable<WatchdogSummary['activity_buckets']>[number]

function buildWatchdogActivityBuckets(baseUnixMs: number, counts: number[]): WatchdogActivityBucket[] {
  const now = baseUnixMs
  const windowStart = now - WATCHDOG_ACTIVITY_WINDOW_MINUTES * 60_000
  return counts.map((count, index) => {
    const bucketStart = windowStart + index * WATCHDOG_ACTIVITY_BUCKET_MINUTES * 60_000
    return {
      bucket_start_unix_ms: bucketStart,
      bucket_end_unix_ms: bucketStart + WATCHDOG_ACTIVITY_BUCKET_MINUTES * 60_000,
      count,
    }
  })
}

function formatWatchdogActivityWindow(minutes: number): string {
  if (minutes % (24 * 60) === 0) {
    return `${minutes / (24 * 60)}d`
  }
  if (minutes % 60 === 0) {
    return `${minutes / 60}h`
  }
  return `${minutes}m`
}

function formatWatchdogActivityBucketAriaLabel(bucket: WatchdogActivityBucket): string {
  const incidentLabel =
    bucket.count === 0 ? 'No incidents' : `${bucket.count} incident${bucket.count === 1 ? '' : 's'}`
  return `Watchdog activity bucket, ${incidentLabel}, ${formatWatchdogActivityBucketTimeRange(bucket.bucket_start_unix_ms, bucket.bucket_end_unix_ms)}`
}

function formatWatchdogActivityBucketTimeRange(startUnixMs: number, endUnixMs: number): string {
  const start = new Date(startUnixMs)
  const end = new Date(endUnixMs)
  const sameDay =
    start.getFullYear() === end.getFullYear() &&
    start.getMonth() === end.getMonth() &&
    start.getDate() === end.getDate()

  if (sameDay) {
    return `${start.toLocaleDateString()} ${start.toLocaleTimeString()} - ${end.toLocaleTimeString()}`
  }

  return `${start.toLocaleString()} - ${end.toLocaleString()}`
}

function formatWatchdogActivityBucketDetail(bucket: WatchdogActivityBucket): string {
  if (bucket.count === 0) return 'No incidents'
  return `${bucket.count} incident${bucket.count === 1 ? '' : 's'}`
}

function getWatchdogLatestActivityBucketCount(summary: WatchdogSummary | null | undefined): number | null {
  const latestBucket = summary?.activity_buckets?.at(-1)
  if (!latestBucket) return null
  return Number.isFinite(latestBucket.count) ? latestBucket.count : null
}

function makeWatchdogActivityCounts(spikes: Array<[number, number]>): number[] {
  const counts = Array.from({ length: WATCHDOG_ACTIVITY_BUCKET_COUNT }, () => 0)
  for (const [index, value] of spikes) {
    if (index < 0 || index >= counts.length) continue
    counts[index] = value
  }
  return counts
}

function getWatchdogActivityTone(count: number): { background: string; boxShadow: string } {
  if (count >= 5) {
    return {
      background: 'rgba(255,94,125,0.88)',
      boxShadow: 'inset 0 0 0 1px rgba(255,94,125,0.14)',
    }
  }
  if (count > 0) {
    return {
      background: 'rgba(255,182,72,0.92)',
      boxShadow: 'inset 0 0 0 1px rgba(255,182,72,0.16)',
    }
  }
  return {
    background: 'rgba(50,180,100,0.34)',
    boxShadow: 'inset 0 0 0 1px rgba(50,180,100,0.10)',
  }
}

const DEV_PREVIEW_WATCHDOG_SUMMARY: WatchdogSummary = {
  healthy: false,
  incident_count: 3,
  activity_window_minutes: WATCHDOG_ACTIVITY_WINDOW_MINUTES,
  activity_bucket_minutes: WATCHDOG_ACTIVITY_BUCKET_MINUTES,
  activity_buckets: buildWatchdogActivityBuckets(
    1_700_000_000_000,
    makeWatchdogActivityCounts([
      [8, 1],
      [19, 2],
      [33, 1],
      [51, 3],
      [74, 2],
      [97, 4],
      [121, 2],
      [136, 1],
    ]),
  ),
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
  ws_open_observed: { count: 4, last_unix_ms: previewWebTransportMs(8 * 60_000) },
  ws_error_observed: {
    count: 0,
    last_unix_ms: 0,
    latest_detail: null,
  },
  ws_close_observed: {
    count: 0,
    last_unix_ms: 0,
    latest_close_code: null,
  },
  ws_reconnect_scheduled: { count: 3, last_unix_ms: previewWebTransportMs(3 * 60_000 + 30_000) },
  ws_reconnect_attempted: { count: 3, last_unix_ms: previewWebTransportMs(3 * 60_000 + 5_000) },
  http_fallback_engaged: { count: 0, last_unix_ms: 0 },
  thread_refresh_failed: { count: 1, last_unix_ms: previewWebTransportMs(9 * 60_000) },
  active_thread_poll_failed: { count: 0, last_unix_ms: 0 },
  live_notification_gap_observed: { count: 0, last_unix_ms: 0 },
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
  command_path: 'C:\\Program Files\\Tailscale\\tailscale.exe',
  command_source: 'standard_install_root',
  probe: {
    attempts: [
      {
        command_path: 'C:\\Program Files\\Tailscale\\tailscale.exe',
        source: 'service_image_path',
        outcome: 'not_found',
      },
      {
        command_path: 'C:\\Program Files\\Tailscale\\tailscale.exe',
        source: 'standard_install_root',
        outcome: 'found',
      },
    ],
    selected_command_path: 'C:\\Program Files\\Tailscale\\tailscale.exe',
    selected_command_source: 'standard_install_root',
  },
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
    health: 'degraded',
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
      command_path: 'C:\\Program Files\\Tailscale\\tailscale.exe',
      command_source: 'standard_install_root',
      probe: {
        attempts: [
          {
            command_path: 'C:\\Program Files\\Tailscale\\tailscale.exe',
            source: 'standard_install_root',
            outcome: 'found',
          },
        ],
        selected_command_path: 'C:\\Program Files\\Tailscale\\tailscale.exe',
        selected_command_source: 'standard_install_root',
      },
      bootstrap: {
        last_stage: 'gateway-bind-pending',
        last_detail: 'listener will bind after next app restart',
        updated_at_unix_ms: 1_700_000_001_200,
      },
    },
    watchdog: {
      healthy: false,
      incident_count: 2,
      activity_window_minutes: WATCHDOG_ACTIVITY_WINDOW_MINUTES,
      activity_bucket_minutes: WATCHDOG_ACTIVITY_BUCKET_MINUTES,
      activity_buckets: buildWatchdogActivityBuckets(
        1_700_000_000_000,
        makeWatchdogActivityCounts([
          [18, 1],
          [37, 2],
          [65, 1],
          [91, 2],
          [113, 1],
        ]),
      ),
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
      ws_open_observed: { count: 1, last_unix_ms: previewWebTransportMs(5 * 60_000) },
      ws_error_observed: {
        count: 1,
        last_unix_ms: previewWebTransportMs(4 * 60_000 + 30_000),
        latest_detail: 'ENOTFOUND',
      },
      ws_close_observed: {
        count: 1,
        last_unix_ms: previewWebTransportMs(4 * 60_000 + 20_000),
        latest_close_code: 1006,
      },
      ws_reconnect_scheduled: { count: 2, last_unix_ms: previewWebTransportMs(4 * 60_000 + 10_000) },
      ws_reconnect_attempted: { count: 2, last_unix_ms: previewWebTransportMs(4 * 60_000 + 5_000) },
      http_fallback_engaged: { count: 1, last_unix_ms: previewWebTransportMs(8 * 60_000) },
      thread_refresh_failed: { count: 1, last_unix_ms: previewWebTransportMs(8 * 60_000 + 20_000) },
      active_thread_poll_failed: { count: 0, last_unix_ms: 0 },
      live_notification_gap_observed: { count: 0, last_unix_ms: 0 },
    },
  },
  {
    node_id: 'node-laptop-c',
    node_name: 'Laptop C',
    health: 'healthy',
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
      command_path: 'C:\\Program Files\\Tailscale\\tailscale.exe',
      command_source: 'service_image_path',
      probe: {
        attempts: [
          {
            command_path: 'C:\\Program Files\\Tailscale\\tailscale.exe',
            source: 'service_image_path',
            outcome: 'not_found',
          },
          {
            command_path: 'C:\\Program Files\\Tailscale\\tailscale.exe',
            source: 'standard_install_root',
            outcome: 'not_found',
          },
          {
            command_path: 'tailscale',
            source: 'path',
            outcome: 'not_found',
          },
        ],
        selected_command_path: 'C:\\Program Files\\Tailscale\\tailscale.exe',
        selected_command_source: 'service_image_path',
      },
      bootstrap: null,
    },
    watchdog: {
      healthy: true,
      incident_count: 0,
      activity_window_minutes: WATCHDOG_ACTIVITY_WINDOW_MINUTES,
      activity_bucket_minutes: WATCHDOG_ACTIVITY_BUCKET_MINUTES,
      activity_buckets: buildWatchdogActivityBuckets(
        1_700_000_000_000,
        makeWatchdogActivityCounts([]),
      ),
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

type StatusTone = 'healthy' | 'degraded' | 'warn' | 'unknown'

type StatusPresentation = {
  tone: StatusTone
  label: string
  pulse?: boolean
}

type StatusTheme = {
  pillClass: string
  dotClass: string
  dotStyle?: {
    background: string
    boxShadow?: string
  }
}

const STATUS_THEME: Record<StatusTone, StatusTheme> = {
  healthy: {
    pillClass: '',
    dotClass: 'aoDot',
  },
  degraded: {
    pillClass: ' aoPillDanger',
    dotClass: 'aoDot aoDotBad',
  },
  warn: {
    pillClass: ' aoPillWarn',
    dotClass: 'aoDot aoDotMuted',
    dotStyle: {
      background: 'var(--ao-warn, rgba(255,182,72,0.92))',
      boxShadow: '0 0 0 3px rgba(255, 182, 72, 0.16)',
    },
  },
  unknown: {
    pillClass: '',
    dotClass: 'aoDot aoDotMuted',
    dotStyle: {
      background: 'rgba(13,18,32,0.2)',
      boxShadow: '0 0 0 3px rgba(13, 18, 32, 0.08)',
    },
  },
}

function getStatusTheme(tone: StatusTone): StatusTheme {
  return STATUS_THEME[tone]
}

function StatusDot({
  tone,
  size = 6,
  title,
}: {
  tone: StatusTone
  size?: number
  title?: string
}) {
  const theme = getStatusTheme(tone)
  return (
    <span
      title={title}
      className={theme.dotClass}
      style={{
        width: size,
        height: size,
        ...theme.dotStyle,
      }}
    />
  )
}

function StatusBadge({
  tone,
  label,
  pulse = false,
}: {
  tone: StatusTone
  label: string
  pulse?: boolean
}) {
  const theme = getStatusTheme(tone)

  return (
    <span className={`aoPill${pulse ? ' aoPulse' : ''}${theme.pillClass}`} style={{ fontSize: 10 }}>
      <StatusDot tone={tone} />
      <span className="aoPillText">{label}</span>
    </span>
  )
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
  return Boolean(peer.trusted && (peer.capabilities ?? []).includes(LAN_DIAGNOSTICS_CAPABILITY))
}

function lanDiagnosticsUnavailableReason(peer: LanPeerStatus): string {
  if (!peer.trusted) {
    return 'Peer is not trusted for LAN diagnostics.'
  }
  if (!(peer.capabilities ?? []).includes(LAN_DIAGNOSTICS_CAPABILITY)) {
    return 'Peer does not advertise LAN diagnostics yet.'
  }
  return ''
}

function getTailscaleHeadline(summary: TailscaleSummary | null | undefined): string {
  if (!summary) return 'Unknown'
  if (!summary.installed) {
    switch (summary.status_error) {
      case 'tailscale_launch_blocked':
        return 'Launch blocked'
      case 'tailscale_launch_failed':
        return 'Launch failed'
      case 'tailscale_bad_json':
        return 'Bad status'
      case 'tailscale_not_found':
      default:
        return 'Not installed'
    }
  }
  if (!summary.connected) return 'Not connected'
  if (summary.gateway_reachable) return 'Gateway reachable'
  if (summary.needs_gateway_restart) return 'Restart required'
  return 'Gateway unreachable'
}

function getTailscaleStatusPresentation(summary: TailscaleSummary | null | undefined): StatusPresentation | null {
  if (!summary) return null
  if (summary.gateway_reachable) return { tone: 'healthy', label: 'healthy', pulse: true }
  if (summary.installed === false) {
    switch (summary.status_error) {
      case 'tailscale_launch_blocked':
        return { tone: 'warn', label: 'Launch blocked' }
      case 'tailscale_launch_failed':
        return { tone: 'warn', label: 'Launch failed' }
      case 'tailscale_bad_json':
        return { tone: 'warn', label: 'Bad status' }
      case 'tailscale_not_found':
      default:
        return { tone: 'unknown', label: 'not installed' }
    }
  }
  if (summary.connected === false) return { tone: 'degraded', label: 'offline' }
  return { tone: 'warn', label: 'Attention' }
}

type TailscaleProbeSource =
  | 'service_image_path'
  | 'registry_app_path'
  | 'registry_install_location'
  | 'standard_install_root'
  | 'path'

function formatTailscaleProbeSource(source: TailscaleProbeSource | string | null | undefined): string {
  switch (source) {
    case 'service_image_path':
    case 'service image path':
      return 'service image path'
    case 'registry_app_path':
    case 'registry app path':
      return 'registry app path'
    case 'registry_install_location':
    case 'registry install location':
      return 'registry install location'
    case 'standard_install_root':
    case 'standard install root':
      return 'standard install root'
    case 'path':
    case 'PATH':
      return 'PATH'
    default:
      return 'unknown'
  }
}

function formatTailscaleProbeOutcome(outcome: string | null | undefined): string {
  switch ((outcome || '').trim()) {
    case 'found':
      return 'found'
    case 'not_found':
      return 'not found'
    case 'launch_blocked':
      return 'launch blocked'
    case 'launch_failed':
      return 'launch failed'
    case 'not_connected':
      return 'not connected'
    case 'bad_json':
      return 'bad output'
    default:
      return 'unknown'
  }
}

function formatTailscaleProbeAttempt(attempt: NonNullable<TailscaleSummary['probe']>['attempts'][number]): string {
  const path = attempt.command_path?.trim() || 'tailscale'
  return `${path} (${formatTailscaleProbeOutcome(attempt.outcome)})`
}

export function formatTailscaleProbeEvidence(summary: TailscaleSummary | null | undefined): string | null {
  if (!summary) return null
  if (summary.installed) return null
  const path = summary.probe?.selected_command_path?.trim() || summary.command_path?.trim() || 'tailscale'
  const source = formatTailscaleProbeSource(
    summary.probe?.selected_command_source ?? summary.command_source ?? 'path',
  )
  return `${path} (${source})`
}

function formatTailscaleProbeTrail(summary: TailscaleSummary | null | undefined): string | null {
  const attempts = summary?.probe?.attempts ?? []
  if (attempts.length <= 0) return null
  return attempts
    .map((attempt) => formatTailscaleProbeAttempt(attempt))
    .join(' → ')
}

function formatTailscaleProbeStatus(summary: TailscaleSummary | null | undefined): string | null {
  const code = summary?.status_error?.trim()
  if (!code) return null
  switch (code) {
    case 'tailscale_not_found':
      return 'CLI not found'
    case 'tailscale_launch_blocked':
      return 'CLI launch blocked'
    case 'tailscale_launch_failed':
      return 'CLI launch failed'
    case 'tailscale_not_connected':
      return 'CLI not connected'
    case 'tailscale_bad_json':
      return 'CLI returned bad output'
    default:
      return code
  }
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

function getLocalDomainGlow(domain: LocalDomain | null | undefined): string {
  const accent = getLocalDomainAccent(domain)
  if (accent === 'var(--ao-line)') {
    return '0 1px 0 rgba(13,18,32,0.02)'
  }
  return `0 0 0 1px ${accent}, 0 10px 28px ${accent.replace('0.42', '0.08')}`
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
  const recentIncidents = summary?.recent_incidents ?? []
  const activityBuckets = summary?.activity_buckets ?? []
  const activityWindowMinutes = summary?.activity_window_minutes ?? WATCHDOG_ACTIVITY_WINDOW_MINUTES
  const activityBucketMinutes = summary?.activity_bucket_minutes ?? WATCHDOG_ACTIVITY_BUCKET_MINUTES
  const activityWindowLabel = formatWatchdogActivityWindow(activityWindowMinutes)
  const [hoveredBucket, setHoveredBucket] = useState<WatchdogActivityBucket | null>(null)
  const status = getWatchdogStatusPresentation(summary)
  return (
    <div className="aoCard" style={{ padding: '12px 14px' }}>
      <div className="aoCardHeader">
        <div className="aoCardTitle">Watchdog</div>
        {loading ? <span className="aoHint">loading…</span> : status ? <StatusBadge tone={status.tone} label={status.label} pulse={status.pulse} /> : <StatusBadge tone="unknown" label="unknown" />}
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
          {activityBuckets.length > 0 ? (
            <div style={{ display: 'grid', gap: 6, marginTop: 10 }}>
              <div className="aoHint" style={{ fontSize: 11, fontWeight: 700 }}>
                Recent activity
                <span style={{ marginLeft: 6, fontWeight: 600 }}>
                  last {activityWindowLabel} · {activityBucketMinutes}m bars
                </span>
              </div>
              <div
                className="aoWatchdogTimeline"
                aria-label={`Watchdog activity over the last ${activityWindowLabel}`}
              >
                {activityBuckets.map((bucket) => {
                  const tone = getWatchdogActivityTone(bucket.count)
                  return (
                    <div
                      key={bucket.bucket_start_unix_ms}
                      className="aoWatchdogTimelineBucket"
                      aria-label={formatWatchdogActivityBucketAriaLabel(bucket)}
                      onMouseEnter={() => setHoveredBucket(bucket)}
                      onMouseLeave={() => setHoveredBucket(null)}
                    >
                      {hoveredBucket?.bucket_start_unix_ms === bucket.bucket_start_unix_ms ? (
                        <div className="aoWatchdogTimelineTooltip" role="tooltip">
                          <div className="aoWatchdogTimelineTooltipTitle">Watchdog activity</div>
                          <div className="aoWatchdogTimelineTooltipText">
                            <div>{`Window: last ${activityWindowLabel} · ${activityBucketMinutes}m buckets`}</div>
                            <div>{`Time: ${formatWatchdogActivityBucketTimeRange(bucket.bucket_start_unix_ms, bucket.bucket_end_unix_ms)}`}</div>
                            <div>{`Incidents: ${formatWatchdogActivityBucketDetail(bucket)}`}</div>
                          </div>
                        </div>
                      ) : null}
                      <span
                        className="aoWatchdogTimelineBar"
                        style={{
                          background: tone.background,
                          boxShadow: tone.boxShadow,
                        }}
                      />
                    </div>
                  )
                })}
              </div>
            </div>
          ) : null}
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

function formatObservedCount(count: number, noun: string): string {
  return `${count} ${count === 1 ? noun : `${noun}s`}`
}

function getLatestUnixMs(values: Array<number | null | undefined>): number {
  return values.reduce<number>((max, value) => {
    const current = value ?? 0
    return current > max ? current : max
  }, 0)
}

function isRecentWebTransportSignal(unixMs: number | null | undefined, nowMs: number): boolean {
  return Boolean(unixMs && nowMs - unixMs <= WEB_TRANSPORT_RECENT_WINDOW_MS)
}

export type WebTransportHealth = 'healthy' | 'noisy' | 'degraded'

export function getWebTransportHealth(snapshot: WebTransportDomainSnapshot, nowMs = Date.now()): WebTransportHealth {
  if (
    isRecentWebTransportSignal(snapshot.ws_error_observed.last_unix_ms, nowMs) ||
    isRecentWebTransportSignal(snapshot.thread_refresh_failed.last_unix_ms, nowMs) ||
    isRecentWebTransportSignal(snapshot.active_thread_poll_failed.last_unix_ms, nowMs)
  ) {
    return 'degraded'
  }
  if (
    isRecentWebTransportSignal(snapshot.http_fallback_engaged.last_unix_ms, nowMs) ||
    isRecentWebTransportSignal(snapshot.live_notification_gap_observed.last_unix_ms, nowMs)
  ) {
    return 'noisy'
  }
  return 'healthy'
}

function getWebTransportStatusDetail(snapshot: WebTransportDomainSnapshot, nowMs = Date.now()): string {
  if (isRecentWebTransportSignal(snapshot.ws_error_observed.last_unix_ms, nowMs)) {
    const detail = snapshot.ws_error_observed.latest_detail?.trim()
    return detail ? `Latest error: ${detail}` : 'WebSocket errors detected'
  }
  if (isRecentWebTransportSignal(snapshot.thread_refresh_failed.last_unix_ms, nowMs)) {
    return 'Thread refresh failures detected'
  }
  if (isRecentWebTransportSignal(snapshot.active_thread_poll_failed.last_unix_ms, nowMs)) {
    return 'Active thread polling has failed'
  }
  if (isRecentWebTransportSignal(snapshot.http_fallback_engaged.last_unix_ms, nowMs)) {
    return 'HTTP fallback was used recently'
  }
  if (isRecentWebTransportSignal(snapshot.live_notification_gap_observed.last_unix_ms, nowMs)) {
    return 'Live notification gaps were observed'
  }
  return 'No recent transport errors'
}

function formatWebTransportErrorDetail(detail: string | null | undefined): string {
  const value = detail?.trim()
  return value || 'No error detail'
}

function getWebTransportStatusPresentation(
  snapshot: WebTransportDomainSnapshot | null | undefined,
  nowMs = Date.now(),
): StatusPresentation | null {
  if (!snapshot) return null
  const health = getWebTransportHealth(snapshot, nowMs)
  if (health === 'degraded') return { tone: 'degraded', label: 'Degraded' }
  if (health === 'noisy') return { tone: 'warn', label: 'Noisy' }
  return { tone: 'healthy', label: 'Healthy', pulse: true }
}

function getWebTransportRecentSignals(snapshot: WebTransportDomainSnapshot, nowMs: number) {
  const rows: Array<{ label: string; value: string; tone?: 'warn' | 'danger' }> = []

  if (isRecentWebTransportSignal(snapshot.thread_refresh_failed.last_unix_ms, nowMs) && snapshot.thread_refresh_failed.count > 0) {
    rows.push({
      label: 'Thread refresh failures',
      value: `${formatObservedCount(snapshot.thread_refresh_failed.count, 'failure')} · last ${fmtTs(snapshot.thread_refresh_failed.last_unix_ms)}`,
      tone: 'danger',
    })
  }
  if (isRecentWebTransportSignal(snapshot.active_thread_poll_failed.last_unix_ms, nowMs) && snapshot.active_thread_poll_failed.count > 0) {
    rows.push({
      label: 'Active thread poll failures',
      value: `${formatObservedCount(snapshot.active_thread_poll_failed.count, 'failure')} · last ${fmtTs(snapshot.active_thread_poll_failed.last_unix_ms)}`,
      tone: 'danger',
    })
  }
  if (isRecentWebTransportSignal(snapshot.http_fallback_engaged.last_unix_ms, nowMs) && snapshot.http_fallback_engaged.count > 0) {
    rows.push({
      label: 'HTTP fallback',
      value: `${formatObservedCount(snapshot.http_fallback_engaged.count, 'fallback')} · last ${fmtTs(snapshot.http_fallback_engaged.last_unix_ms)}`,
      tone: 'warn',
    })
  }
  if (
    isRecentWebTransportSignal(snapshot.live_notification_gap_observed.last_unix_ms, nowMs) &&
    snapshot.live_notification_gap_observed.count > 0
  ) {
    rows.push({
      label: 'Live notification gaps',
      value: `${formatObservedCount(snapshot.live_notification_gap_observed.count, 'gap')} · last ${fmtTs(snapshot.live_notification_gap_observed.last_unix_ms)}`,
      tone: 'warn',
    })
  }

  return rows
}

function WebTransportMetricCard({
  label,
  value,
  detail,
  tone = 'neutral',
}: {
  label: string
  value: string
  detail?: string | null
  tone?: 'neutral' | 'warn' | 'danger'
}) {
  return (
    <div className={`aoWebTransportCard aoWebTransportCard${tone[0].toUpperCase()}${tone.slice(1)}`}>
      <div className="aoWebTransportCardLabel">{label}</div>
      <div className="aoWebTransportCardValue">{value}</div>
      {detail ? <div className="aoWebTransportCardDetail">{detail}</div> : null}
    </div>
  )
}

export function getWatchdogStatusPresentation(summary: WatchdogSummary | null | undefined): StatusPresentation | null {
  if (!summary) return null
  const latestBucketCount = getWatchdogLatestActivityBucketCount(summary)
  if (latestBucketCount == null) {
    return summary.healthy ? { tone: 'healthy', label: 'healthy', pulse: true } : { tone: 'degraded', label: 'Degraded' }
  }
  if (latestBucketCount >= 5) return { tone: 'degraded', label: 'Degraded' }
  if (latestBucketCount > 0) return { tone: 'warn', label: 'Attention' }
  return { tone: 'healthy', label: 'healthy', pulse: true }
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
  const nowMs = Date.now()
  const status = getWebTransportStatusPresentation(snapshot, nowMs)
  const statusDetail = getWebTransportStatusDetail(snapshot, nowMs)
  const recentSignals = getWebTransportRecentSignals(snapshot, nowMs)
  const heroMetaLines = [
    isRecentWebTransportSignal(snapshot.ws_error_observed.last_unix_ms, nowMs) ? (
      <div key="error" className="aoWebTransportHeroMetaLine">
        <span className="aoHint">Latest error</span>
        <span className="aoWebTransportHeroMetaValue">{formatWebTransportErrorDetail(snapshot.ws_error_observed.latest_detail)}</span>
      </div>
    ) : null,
    isRecentWebTransportSignal(snapshot.ws_close_observed.last_unix_ms, nowMs) && snapshot.ws_close_observed.latest_close_code != null ? (
      <div key="close" className="aoWebTransportHeroMetaLine">
        <span className="aoHint">Latest close code</span>
        <span className="aoWebTransportHeroMetaValue">{snapshot.ws_close_observed.latest_close_code}</span>
      </div>
    ) : null,
  ].filter(Boolean)
  const latestActivity = getLatestUnixMs([
    snapshot.ws_open_observed.last_unix_ms,
    snapshot.ws_error_observed.last_unix_ms,
    snapshot.ws_close_observed.last_unix_ms,
    snapshot.ws_reconnect_scheduled.last_unix_ms,
    snapshot.ws_reconnect_attempted.last_unix_ms,
    snapshot.http_fallback_engaged.last_unix_ms,
    snapshot.thread_refresh_failed.last_unix_ms,
    snapshot.active_thread_poll_failed.last_unix_ms,
    snapshot.live_notification_gap_observed.last_unix_ms,
  ])
  return (
    <div className="aoCard" style={{ padding: '12px 14px' }}>
      <div className="aoCardHeader">
        <div className="aoCardTitle">WebTransport</div>
        {status ? <StatusBadge tone={status.tone} label={status.label} pulse={status.pulse} /> : null}
      </div>
      <div className="aoWebTransportHero">
        <div className="aoWebTransportHeroText">
          <div className="aoWebTransportHeroHeadline">{statusDetail}</div>
          <div className="aoWebTransportHeroSubhead">Last activity {fmtTs(latestActivity)}</div>
          <div className="aoWebTransportHeroSubhead">Polled every 5s</div>
        </div>
        {heroMetaLines.length > 0 ? <div className="aoWebTransportHeroMeta">{heroMetaLines}</div> : null}
      </div>
      <div className="aoWebTransportPanel">
        <div className="aoWebTransportSubsection">
          <div className="aoWebTransportSectionLabel">Summary</div>
          <div className="aoWebTransportCardGrid">
            <WebTransportMetricCard
              label="Socket activity"
              value={`${formatObservedCount(snapshot.ws_open_observed.count, 'open')} · ${formatObservedCount(snapshot.ws_close_observed.count, 'close')}`}
              detail={`Last seen ${fmtTs(getLatestUnixMs([
                snapshot.ws_open_observed.last_unix_ms,
                snapshot.ws_close_observed.last_unix_ms,
              ]))}`}
            />
            <WebTransportMetricCard
              label="Reconnect loop"
              value={`${formatObservedCount(snapshot.ws_reconnect_scheduled.count, 'scheduled')} · ${formatObservedCount(snapshot.ws_reconnect_attempted.count, 'attempt')}`}
              detail={`Last seen ${fmtTs(getLatestUnixMs([
                snapshot.ws_reconnect_scheduled.last_unix_ms,
                snapshot.ws_reconnect_attempted.last_unix_ms,
              ]))}`}
            />
            <WebTransportMetricCard
              label="Errors"
              value={formatObservedCount(snapshot.ws_error_observed.count, 'error')}
              detail={formatWebTransportErrorDetail(snapshot.ws_error_observed.latest_detail)}
              tone={isRecentWebTransportSignal(snapshot.ws_error_observed.last_unix_ms, nowMs) ? 'danger' : 'neutral'}
            />
            <WebTransportMetricCard
              label="Fallbacks"
              value={`${formatObservedCount(snapshot.http_fallback_engaged.count, 'HTTP fallback')} · ${formatObservedCount(snapshot.live_notification_gap_observed.count, 'gap')}`}
              detail={`Last seen ${fmtTs(getLatestUnixMs([
                snapshot.http_fallback_engaged.last_unix_ms,
                snapshot.live_notification_gap_observed.last_unix_ms,
              ]))}`}
              tone={
                isRecentWebTransportSignal(snapshot.http_fallback_engaged.last_unix_ms, nowMs) ||
                isRecentWebTransportSignal(snapshot.live_notification_gap_observed.last_unix_ms, nowMs)
                  ? 'warn'
                  : 'neutral'
              }
            />
          </div>
        </div>
        {recentSignals.length > 0 ? (
          <>
            <div className="aoWebTransportPanelDivider" />
            <div className="aoWebTransportSubsection">
              <div className="aoWebTransportSignalsSummary">Event details</div>
              <div className="aoWebTransportSignalsList">
                {recentSignals.map((signal) => (
                  <div
                    key={signal.label}
                    className={`aoWebTransportSignalRow${signal.tone ? ` aoWebTransportSignalRow${signal.tone[0].toUpperCase()}${signal.tone.slice(1)}` : ''}`}
                  >
                    <span className="aoWebTransportSignalLabel">{signal.label}</span>
                    <span className="aoWebTransportSignalValue">{signal.value}</span>
                  </div>
                ))}
              </div>
            </div>
          </>
        ) : null}
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
  const status = getTailscaleStatusPresentation(summary)
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
        {status ? <StatusBadge tone={status.tone} label={status.label} pulse={status.pulse} /> : <span className="aoHint">—</span>}
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
  health: 'healthy' | 'warn' | 'degraded' | 'unknown'
  last_incident: string | null
  fetched_at: number
  tailscale: TailscaleSummary | null
  watchdog: WatchdogSummary | null
  webtransport: WebTransportDomainSnapshot | null
}

function getPeerHealthPresentation(health: PeerDiagEntry['health']): StatusPresentation {
  if (health === 'healthy') return { tone: 'healthy', label: 'healthy', pulse: true }
  if (health === 'warn') return { tone: 'warn', label: 'Attention' }
  if (health === 'degraded') return { tone: 'degraded', label: 'Degraded' }
  return { tone: 'unknown', label: 'unknown' }
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
          const wdStatus = getWatchdogStatusPresentation(wd ?? null)
          entries.push({
            node_id: peer.node_id,
            node_name: peer.node_name,
            health:
              wdStatus?.tone === 'healthy'
                ? 'healthy'
                : wdStatus?.tone === 'warn'
                  ? 'warn'
                  : wdStatus?.tone === 'degraded'
                    ? 'degraded'
                    : 'unknown',
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
            const peerHealth = getPeerHealthPresentation(peer.health)
            const tailscaleStatus = getTailscaleStatusPresentation(peer.tailscale)
            const watchdogStatus = getWatchdogStatusPresentation(peer.watchdog)
            const webtransportStatus = peer.webtransport ? getWebTransportStatusPresentation(peer.webtransport) : null

            return (
              <div key={peer.node_id} className="aoMonPeerCard">
                {/* Peer card header — always visible */}
                <div className="aoMonPeerCardHeader">
                  {/* Left: name + address */}
                  <div className="aoMonPeerCardMeta">
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span className="aoMonPeerCardName">{peer.node_name}</span>
                      <StatusBadge tone={peerHealth.tone} label={peerHealth.label} pulse={peerHealth.pulse} />
                    </div>
                    <div className="aoMonPeerCardId">
                      {listenAddr} · fetched {fmtAge(peer.fetched_at)}
                    </div>
                  </div>

                  {/* Right: domain dots + expand */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    {/* Domain status dots */}
                    <div className="aoMonPeerDomainDots">
                      <span className="aoMonPeerDomainDot" title="Tailscale">
                        <StatusDot tone={tailscaleStatus?.tone ?? 'unknown'} />
                        <span>TS</span>
                      </span>
                      <span className="aoMonPeerDomainDot" title="Watchdog">
                        <StatusDot tone={watchdogStatus?.tone ?? 'unknown'} />
                        <span>WD</span>
                      </span>
                      <span className="aoMonPeerDomainDot" title="WebTransport">
                        <StatusDot tone={webtransportStatus?.tone ?? 'unknown'} />
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
  const probeEvidence = formatTailscaleProbeEvidence(summary)
  const probeTrail = formatTailscaleProbeTrail(summary)
  const probeStatus = formatTailscaleProbeStatus(summary)
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
        {probeEvidence ? (
          <>
            <span className="aoKey">probe</span>
            <span className="aoVal aoValSmall">{probeEvidence}</span>
          </>
        ) : null}
        {probeTrail ? (
          <>
            <span className="aoKey">checked</span>
            <span className="aoVal aoValSmall">{probeTrail}</span>
          </>
        ) : null}
        {probeStatus ? (
          <>
            <span className="aoKey">probe status</span>
            <span className="aoVal aoValSmall">{probeStatus}</span>
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
  const localTailscaleStatus = getTailscaleStatusPresentation(tailscale)
  const localWebTransportStatus = getWebTransportStatusPresentation(wtSnapshot)
  const localWatchdogStatus = getWatchdogStatusPresentation(watchdog)

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
              boxShadow: getLocalDomainGlow(expandedLocalDomain),
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
            <>
              {/* Tailscale card */}
            <div className="aoMonLocalCard" style={{ boxShadow: 'inset 3px 0 0 rgba(23,115,200,0.75)' }}>
              <div className="aoMonLocalCardHeader">
                <span className="aoMonLocalCardTitle">Tailscale</span>
                {localTailscaleStatus ? (
                  <StatusBadge tone={localTailscaleStatus.tone} label={localTailscaleStatus.label} pulse={localTailscaleStatus.pulse} />
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
                    {formatTailscaleProbeStatus(tailscale) ? (
                      <div style={{ marginTop: 2, fontSize: 11, color: 'rgba(13,18,32,0.56)', whiteSpace: 'pre-line' }}>
                        {formatTailscaleProbeStatus(tailscale)}
                      </div>
                    ) : null}
                    {formatTailscaleProbeEvidence(tailscale) ? (
                      <div style={{ marginTop: 2, fontSize: 11, color: 'rgba(13,18,32,0.56)', whiteSpace: 'pre-line' }}>
                        Probe: {formatTailscaleProbeEvidence(tailscale)}
                      </div>
                    ) : null}
                    {formatTailscaleProbeTrail(tailscale) ? (
                      <div style={{ marginTop: 2, fontSize: 11, color: 'rgba(13,18,32,0.56)', whiteSpace: 'pre-line' }}>
                        Tried: {formatTailscaleProbeTrail(tailscale)}
                      </div>
                    ) : null}
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
            <div
              className="aoMonLocalCard"
              style={{
                boxShadow:
                  localWebTransportStatus?.tone === 'degraded'
                    ? 'inset 3px 0 0 rgba(255,94,125,0.8)'
                    : localWebTransportStatus?.tone === 'warn'
                    ? 'inset 3px 0 0 rgba(255,182,72,0.78)'
                    : 'inset 3px 0 0 rgba(130,80,220,0.75)',
              }}
            >
              <div className="aoMonLocalCardHeader">
                <span className="aoMonLocalCardTitle">WebTransport</span>
                {wtSnapshot ? (
                  <StatusBadge
                    tone={localWebTransportStatus?.tone ?? 'unknown'}
                    label={localWebTransportStatus?.label ?? 'unknown'}
                    pulse={localWebTransportStatus?.pulse}
                  />
                ) : (
                  <span className="aoHint" style={{ fontSize: 11 }}>—</span>
                )}
              </div>
              <div className="aoMonLocalCardBody">
                {wtSnapshot ? (
                  <>
                    <div>{getWebTransportStatusDetail(wtSnapshot)}</div>
                    <div style={{ marginTop: 2, fontSize: 11, color: 'rgba(13,18,32,0.56)' }}>
                      Last activity {fmtAge(getLatestUnixMs([
                        wtSnapshot.ws_open_observed.last_unix_ms,
                        wtSnapshot.ws_error_observed.last_unix_ms,
                        wtSnapshot.ws_close_observed.last_unix_ms,
                        wtSnapshot.ws_reconnect_scheduled.last_unix_ms,
                        wtSnapshot.ws_reconnect_attempted.last_unix_ms,
                        wtSnapshot.http_fallback_engaged.last_unix_ms,
                        wtSnapshot.thread_refresh_failed.last_unix_ms,
                        wtSnapshot.active_thread_poll_failed.last_unix_ms,
                        wtSnapshot.live_notification_gap_observed.last_unix_ms,
                      ]))}
                    </div>
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
            <div
              className="aoMonLocalCard"
              style={{
                boxShadow: 'inset 3px 0 0 rgba(255,94,125,0.8)',
              }}
            >
              <div className="aoMonLocalCardHeader">
                <span className="aoMonLocalCardTitle">Watchdog</span>
                {localWatchdogStatus ? (
                  <StatusBadge tone={localWatchdogStatus.tone} label={localWatchdogStatus.label} pulse={localWatchdogStatus.pulse} />
                ) : (
                  <span className="aoHint" style={{ fontSize: 11 }}>—</span>
                )}
              </div>
              <div className="aoMonLocalCardBody">
                {watchdog !== null ? (
                  <>
                    <div>
                      {localWatchdogStatus?.tone === 'healthy'
                        ? 'All systems healthy'
                        : localWatchdogStatus?.tone === 'warn'
                          ? `Latest 5m bar shows attention (${watchdog.incident_count} incident(s))`
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
                <StatusBadge tone="healthy" label="healthy" pulse />
              </div>
              <div className="aoMonLocalCardBody">
                <div>{status?.lan_sync?.peers?.length ?? 0} peer(s) discovered</div>
              </div>
            </div>
            </>
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
  const watchdogStatus = getWatchdogStatusPresentation(watchdog)
  if (watchdog && watchdogStatus?.tone === 'degraded' && watchdog.last_incident_kind) {
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
    const nowMs = Date.now()
    if (isRecentWebTransportSignal(wtSnapshot.ws_error_observed.last_unix_ms, nowMs)) {
      conditions.push({
        kind: 'WebSocket error',
        severity: 'error',
        domain: 'wt',
        detail: wtSnapshot.ws_error_observed.latest_detail ?? '',
        age: wtSnapshot.ws_error_observed.last_unix_ms ? fmtAge(wtSnapshot.ws_error_observed.last_unix_ms) : undefined,
      })
    }
    if (isRecentWebTransportSignal(wtSnapshot.http_fallback_engaged.last_unix_ms, nowMs)) {
      conditions.push({
        kind: 'HTTP fallback',
        severity: 'warn',
        domain: 'wt',
        detail: '',
        age: wtSnapshot.http_fallback_engaged.last_unix_ms ? fmtAge(wtSnapshot.http_fallback_engaged.last_unix_ms) : undefined,
      })
    }
    if (isRecentWebTransportSignal(wtSnapshot.thread_refresh_failed.last_unix_ms, nowMs)) {
      conditions.push({
        kind: 'WebTransport thread refresh failed',
        severity: 'error',
        domain: 'wt',
        detail: `${wtSnapshot.thread_refresh_failed.count} failure(s)`,
        age: wtSnapshot.thread_refresh_failed.last_unix_ms ? fmtAge(wtSnapshot.thread_refresh_failed.last_unix_ms) : undefined,
      })
    }
    if (isRecentWebTransportSignal(wtSnapshot.active_thread_poll_failed.last_unix_ms, nowMs)) {
      conditions.push({
        kind: 'Active thread poll failed',
        severity: 'error',
        domain: 'wt',
        detail: `${wtSnapshot.active_thread_poll_failed.count} failure(s)`,
        age: wtSnapshot.active_thread_poll_failed.last_unix_ms ? fmtAge(wtSnapshot.active_thread_poll_failed.last_unix_ms) : undefined,
      })
    }
  }

  // Tailscale
  if (tailscale) {
    if (tailscale.installed === false) {
      const probeTrail = formatTailscaleProbeTrail(tailscale)
      const probeEvidence = formatTailscaleProbeEvidence(tailscale)
      const probeStatus = formatTailscaleProbeStatus(tailscale)
      const detailParts = ['Install Tailscale to enable remote access']
      if (probeStatus) detailParts.push(probeStatus)
      if (probeEvidence) detailParts.push(`Probe: ${probeEvidence}`)
      if (probeTrail) detailParts.push(`Tried: ${probeTrail}`)
      conditions.push({
        kind: getTailscaleHeadline(tailscale),
        severity: 'warn',
        domain: 'ts',
        detail: detailParts.join(' · '),
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
