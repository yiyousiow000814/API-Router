import fs from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  hasTauriInvokeAvailable,
  formatIncidentKind,
  formatTailscaleProbeEvidence,
  getWebTransportHeroMetaRows,
  isMonitoringDevPreview,
  MonitoringPanel,
  getWebTransportHealth,
  getWebTransportObservedErrorDetail,
  getWatchdogStatusPresentation,
  peerSupportsLanDiagnostics,
  type WatchdogSummary,
  type WebTransportDomainSnapshot,
} from './MonitoringPanel'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}))

describe('MonitoringPanel', () => {
  const previousWindow = globalThis.window

  afterEach(() => {
    if (previousWindow === undefined) {
      Reflect.deleteProperty(globalThis, 'window')
    } else {
      globalThis.window = previousWindow
    }
  })

  it('renders a waiting hint instead of crashing before live status arrives', () => {
    const html = renderToStaticMarkup(<MonitoringPanel status={null} gatewayTokenPreview="" />)

    expect(html).toContain('Remote Peers')
    expect(html).toContain('Waiting for live gateway status.')
  })

  it('detects when Tauri invoke is unavailable', () => {
    Reflect.deleteProperty(globalThis, 'window')
    expect(hasTauriInvokeAvailable()).toBe(false)

    ;(globalThis as { window?: unknown }).window = {
      __TAURI__: { core: { invoke: () => {} } },
    }
    expect(hasTauriInvokeAvailable()).toBe(true)
  })

  it('only fetches peer diagnostics from trusted peers that advertise lan_debug_v2', () => {
    expect(
      peerSupportsLanDiagnostics({
        trusted: true,
        capabilities: ['heartbeat_v1', 'lan_debug_v2'],
        version_inventory: ['heartbeat_v1'],
      } as any),
    ).toBe(true)

    expect(
      peerSupportsLanDiagnostics({
        trusted: false,
        capabilities: ['heartbeat_v1', 'lan_debug_v2'],
        version_inventory: ['heartbeat_v1', 'lan_debug_v2'],
      } as any),
    ).toBe(false)

    expect(
      peerSupportsLanDiagnostics({
        trusted: true,
        capabilities: ['heartbeat_v1'],
        version_inventory: ['heartbeat_v1'],
      } as any),
    ).toBe(false)
  })

  it('shows a desktop-only hint for remote peers outside the Tauri runtime', () => {
    const html = renderToStaticMarkup(
      <MonitoringPanel
        status={{
          lan_sync: { peers: [] },
        } as any}
        gatewayTokenPreview=""
      />,
    )

    expect(html).toContain('Remote peer diagnostics are available in the Tauri desktop app only.')
  })

  it('uses simulated monitor data in the 5173 preview shell', () => {
    ;(globalThis as { window?: unknown }).window = {
      location: { port: '5173' },
    }

    expect(isMonitoringDevPreview()).toBe(true)

    const html = renderToStaticMarkup(
      <MonitoringPanel
        status={{
          listen: { host: '127.0.0.1', port: 4312 },
          lan_sync: { peers: [] },
        } as any}
        gatewayTokenPreview=""
      />,
    )

    expect(html).toContain('Preview data')
    expect(html).toContain('Gateway reachable')
    expect(html).toContain('desk-monitor.tail.ts.net')
    expect(html).toContain('Degraded')
    expect(html).toContain('Web Codex thread refresh failed')
    expect(html).toContain('Desk B')
    expect(html).toContain(
      'Tried: C:\\Program Files\\Tailscale\\tailscale.exe (not found) → C:\\Program Files\\Tailscale\\tailscale.exe (found)',
    )
  })

  it('returns healthy once webtransport signals fall outside the recent window', () => {
    const now = 1_700_000_000_000
    const baseSnapshot: WebTransportDomainSnapshot = {
      ws_open_observed: { count: 1, last_unix_ms: now - 2 * 60_000 },
      ws_error_observed: { count: 1, last_unix_ms: now - 2 * 60_000, latest_detail: 'ECONNRESET' },
      ws_close_observed: { count: 1, last_unix_ms: now - 2 * 60_000, latest_close_code: 1006 },
      ws_reconnect_scheduled: { count: 1, last_unix_ms: now - 2 * 60_000 },
      ws_reconnect_attempted: { count: 1, last_unix_ms: now - 2 * 60_000 },
      http_fallback_engaged: { count: 0, last_unix_ms: 0 },
      thread_refresh_failed: { count: 0, last_unix_ms: 0 },
      active_thread_poll_failed: { count: 0, last_unix_ms: 0 },
      live_notification_gap_observed: { count: 0, last_unix_ms: 0 },
      api_request_failed: { count: 0, last_unix_ms: 0, latest_detail: null },
      thread_missing_observed: { count: 0, last_unix_ms: 0, latest_detail: null },
    }

    expect(getWebTransportHealth(baseSnapshot, now)).toBe('degraded')
    expect(
      getWebTransportHealth(
        {
          ...baseSnapshot,
          ws_error_observed: { ...baseSnapshot.ws_error_observed, last_unix_ms: now - 16 * 60_000 },
          ws_close_observed: { ...baseSnapshot.ws_close_observed, last_unix_ms: now - 16 * 60_000 },
        },
        now,
      ),
    ).toBe('healthy')
  })

  it('falls back to websocket close detail when error detail is missing', () => {
    const snapshot: WebTransportDomainSnapshot = {
      ws_open_observed: { count: 1, last_unix_ms: 1 },
      ws_error_observed: { count: 1, last_unix_ms: 2, latest_detail: null },
      ws_close_observed: {
        count: 1,
        last_unix_ms: 2,
        latest_close_code: 1006,
        latest_close_reason: 'server restart',
        latest_close_was_clean: false,
      },
      ws_reconnect_scheduled: { count: 0, last_unix_ms: 0 },
      ws_reconnect_attempted: { count: 0, last_unix_ms: 0 },
      http_fallback_engaged: { count: 0, last_unix_ms: 0 },
      thread_refresh_failed: { count: 0, last_unix_ms: 0 },
      active_thread_poll_failed: { count: 0, last_unix_ms: 0 },
      live_notification_gap_observed: { count: 0, last_unix_ms: 0 },
      api_request_failed: { count: 0, last_unix_ms: 0, latest_detail: null },
      thread_missing_observed: { count: 0, last_unix_ms: 0, latest_detail: null },
    }

    expect(getWebTransportObservedErrorDetail(snapshot)).toBe('Closed: server restart (code 1006)')
  })

  it('explains abnormal websocket close codes without a reason', () => {
    const snapshot: WebTransportDomainSnapshot = {
      ws_open_observed: { count: 1, last_unix_ms: 1 },
      ws_error_observed: { count: 1, last_unix_ms: 2, latest_detail: null },
      ws_close_observed: {
        count: 1,
        last_unix_ms: 2,
        latest_close_code: 1006,
        latest_close_reason: null,
        latest_close_was_clean: false,
      },
      ws_reconnect_scheduled: { count: 0, last_unix_ms: 0 },
      ws_reconnect_attempted: { count: 0, last_unix_ms: 0 },
      http_fallback_engaged: { count: 0, last_unix_ms: 0 },
      thread_refresh_failed: { count: 0, last_unix_ms: 0 },
      active_thread_poll_failed: { count: 0, last_unix_ms: 0 },
      live_notification_gap_observed: { count: 0, last_unix_ms: 0 },
      api_request_failed: { count: 0, last_unix_ms: 0, latest_detail: null },
      thread_missing_observed: { count: 0, last_unix_ms: 0, latest_detail: null },
    }

    expect(getWebTransportObservedErrorDetail(snapshot)).toBe(
      'Abnormal close (1006): the browser did not receive a normal close reason',
    )
  })

  it('deduplicates the close detail row when it matches the latest error detail', () => {
    const snapshot: WebTransportDomainSnapshot = {
      ws_open_observed: { count: 1, last_unix_ms: 1 },
      ws_error_observed: { count: 1, last_unix_ms: 2, latest_detail: null },
      ws_close_observed: {
        count: 1,
        last_unix_ms: 2,
        latest_close_code: 1006,
        latest_close_reason: null,
        latest_close_was_clean: false,
      },
      ws_reconnect_scheduled: { count: 0, last_unix_ms: 0 },
      ws_reconnect_attempted: { count: 0, last_unix_ms: 0 },
      http_fallback_engaged: { count: 0, last_unix_ms: 0 },
      thread_refresh_failed: { count: 0, last_unix_ms: 0 },
      active_thread_poll_failed: { count: 0, last_unix_ms: 0 },
      live_notification_gap_observed: { count: 0, last_unix_ms: 0 },
      api_request_failed: { count: 0, last_unix_ms: 0, latest_detail: null },
      thread_missing_observed: { count: 0, last_unix_ms: 0, latest_detail: null },
    }

    expect(getWebTransportHeroMetaRows(snapshot, 2)).toEqual([
      {
        key: 'error',
        label: 'Latest error',
        value: 'Abnormal close (1006): the browser did not receive a normal close reason',
      },
      {
        key: 'close',
        label: 'Latest close code',
        value: '1006',
      },
    ])
  })

  it('treats recent codex api failures as degraded web codex health', () => {
    const now = 1_700_000_000_000
    const snapshot: WebTransportDomainSnapshot = {
      ws_open_observed: { count: 1, last_unix_ms: now - 2 * 60_000 },
      ws_error_observed: { count: 0, last_unix_ms: 0, latest_detail: null },
      ws_close_observed: { count: 0, last_unix_ms: 0, latest_close_code: null },
      ws_reconnect_scheduled: { count: 0, last_unix_ms: 0 },
      ws_reconnect_attempted: { count: 0, last_unix_ms: 0 },
      http_fallback_engaged: { count: 0, last_unix_ms: 0 },
      thread_refresh_failed: { count: 0, last_unix_ms: 0 },
      active_thread_poll_failed: { count: 0, last_unix_ms: 0 },
      live_notification_gap_observed: { count: 0, last_unix_ms: 0 },
      api_request_failed: {
        count: 1,
        last_unix_ms: now - 60_000,
        latest_detail: 'POST /codex/turns/start -> HTTP 502: thread not found',
      },
      thread_missing_observed: {
        count: 1,
        last_unix_ms: now - 60_000,
        latest_detail: 'thread not found: thread-1',
      },
    }

    expect(getWebTransportHealth(snapshot, now)).toBe('degraded')
    expect(getWebTransportHeroMetaRows(snapshot, now)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: 'Latest API error',
          value: 'POST /codex/turns/start -> HTTP 502: thread not found',
        }),
        expect.objectContaining({
          label: 'Latest missing thread',
          value: 'thread not found: thread-1',
        }),
      ]),
    )
  })

  it('treats watchdog health as the latest activity bucket only', () => {
    const baseSummary: WatchdogSummary = {
      healthy: false,
      incident_count: 3,
      activity_window_minutes: 720,
      activity_bucket_minutes: 5,
      activity_buckets: [
        { bucket_start_unix_ms: 1_700_000_000_000, bucket_end_unix_ms: 1_700_000_300_000, count: 2 },
        { bucket_start_unix_ms: 1_700_000_300_000, bucket_end_unix_ms: 1_700_000_600_000, count: 0 },
      ],
      last_incident_kind: 'heartbeat-stall',
      last_incident_detail: 'UI heartbeat stalled',
      last_incident_unix_ms: 1_700_000_100_000,
      last_incident_file: 'ui-freeze-1700000100000-heartbeat-stall.json',
      recent_incidents: [],
    }

    expect(getWatchdogStatusPresentation(baseSummary)).toEqual({
      tone: 'healthy',
      label: 'healthy',
      pulse: true,
    })

    expect(
      getWatchdogStatusPresentation({
        ...baseSummary,
        activity_buckets: [
          { bucket_start_unix_ms: 1_700_000_000_000, bucket_end_unix_ms: 1_700_000_300_000, count: 0 },
          { bucket_start_unix_ms: 1_700_000_300_000, bucket_end_unix_ms: 1_700_000_600_000, count: 2 },
        ],
      }),
    ).toEqual({
      tone: 'warn',
      label: 'Attention',
    })
  })

  it('formats incident kinds into human-readable labels', () => {
    expect(formatIncidentKind('heartbeat-stall')).toBe('UI heartbeat stalled')
    expect(formatIncidentKind('slow-refresh')).toBe('Remote diagnostics refresh too slow')
    expect(formatIncidentKind('invoke-error')).toBe('Remote diagnostics request failed')
    expect(formatIncidentKind('custom-case')).toBe('Custom Case')
  })

  it('renders recent watchdog incidents when the backend provides them', () => {
    const html = renderToStaticMarkup(
      <MonitoringPanel
        status={null}
        gatewayTokenPreview=""
      />,
    )

    expect(html).toContain('Remote Peers')
  })

  it('formats tailscale probe evidence when the CLI is not detected', () => {
    expect(
      formatTailscaleProbeEvidence({
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
        command_source: 'standard_install_root',
        probe: {
          attempts: [
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
          selected_command_path: null,
          selected_command_source: null,
        },
        bootstrap: null,
      } as any),
    ).toBe('C:\\Program Files\\Tailscale\\tailscale.exe (standard install root)')
  })

  it('formats tailscale probe evidence from the service image path source', () => {
    expect(
      formatTailscaleProbeEvidence({
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
          ],
          selected_command_path: 'C:\\Program Files\\Tailscale\\tailscale.exe',
          selected_command_source: 'service_image_path',
        },
        bootstrap: null,
      } as any),
    ).toBe('C:\\Program Files\\Tailscale\\tailscale.exe (service image path)')
  })

  it('shows snapshot failed rather than not installed when status polling falls back', () => {
    const html = renderToStaticMarkup(
      <MonitoringPanel
        status={{
          tailscale: {
            installed: false,
            connected: false,
            backend_state: null,
            dns_name: null,
            ipv4: [],
            reachable_ipv4: [],
            gateway_reachable: false,
            needs_gateway_restart: false,
            status_error: 'tailscale_snapshot_failed',
            command_path: '',
            command_source: '',
            probe: {
              attempts: [],
              selected_command_path: null,
              selected_command_source: null,
            },
            bootstrap: null,
          } as any,
          lan_sync: { peers: [] },
        } as any}
        gatewayTokenPreview=""
      />,
    )

    expect(html).toContain('Snapshot failed')
    expect(html).not.toContain('Not installed')
  })

  it('keeps remote peer polling and refresh controls aligned with the dashboard refresh affordance', () => {
    const source = fs.readFileSync(new URL('./MonitoringPanel.tsx', import.meta.url), 'utf8')

    expect(source).toContain('window.setInterval(() => {')
    expect(source).toContain('}, 30_000)')
    expect(source).toContain('aoUsageRefreshBtn aoUsageRefreshBtnMini')
    expect(source).toContain("aria-label=\"Fetch diagnostics from all peers\"")
    expect(source).toContain('onAnimationIteration={handleRefreshSpinIteration}')
    expect(source).not.toContain('MIN_REFRESH_SPIN_MS')
    expect(source).toContain("domains: ['watchdog', 'webtransport', 'tailscale']")
    expect(source).toContain('tailscale: ts ?? peer.tailscale ?? null')
    expect(source).toContain('No Tailscale data from this peer.')
    expect(source).toContain('borderColor: getLocalDomainAccent(expandedLocalDomain)')
    expect(source).toContain('boxShadow: getLocalDomainGlow(expandedLocalDomain)')
    expect(source).toContain('Summary')
    expect(source).toContain('Recent activity')
    expect(source).toContain('aoWatchdogTimeline')
    expect(source).toContain('aoWatchdogTimelineTooltip')
    expect(source).toContain('WATCHDOG_ACTIVITY_WINDOW_MINUTES = 12 * 60')
    expect(source).toContain('activity_window_minutes')
    expect(source).toContain('formatWatchdogActivityWindow')
    expect(source).toContain('formatWatchdogActivityBucketAriaLabel')
    expect(source).toContain('formatWatchdogActivityBucketTimeRange')
    expect(source).toContain('WebTransportMetricCard')
    expect(source).toContain('getWebTransportStatusPresentation')
    expect(source).toContain('getWebTransportStatusDetail')
    expect(source).toContain('getWatchdogStatusPresentation')
    expect(source).toContain('getTailscaleStatusPresentation')
    expect(source).toContain('formatTailscaleProbeEvidence')
    expect(source).toContain('formatTailscaleProbeTrail')
    expect(source).toContain('formatTailscaleProbeStatus')
    expect(source).toContain('formatTailscaleProbeAttempt')
    expect(source).toContain('StatusDot')
    expect(source).toContain('label="healthy"')
    expect(source).not.toContain('label="ok"')
    expect(source).toContain('Socket activity')
    expect(source).toContain('Reconnect loop')
    expect(source).toContain('Event details')
    expect(source).toContain('getWebTransportHealth')
    expect(source).toContain("watchdog: 'rgba(255,94,125,0.42)'")
    expect(source.indexOf('<TailscaleSection summary={peer.tailscale ?? null} loading={false} />')).toBeGreaterThan(
      -1,
    )
    expect(source.indexOf('WebTransportSection snapshot={peer.webtransport} loading={false}')).toBeGreaterThan(-1)
    expect(source.indexOf('WatchdogSection summary={peer.watchdog} loading={false}')).toBeGreaterThan(-1)
    expect(source.indexOf('<TailscaleSection summary={peer.tailscale ?? null} loading={false} />')).toBeLessThan(
      source.indexOf('WebTransportSection snapshot={peer.webtransport} loading={false}'),
    )
    expect(source.indexOf('WebTransportSection snapshot={peer.webtransport} loading={false}')).toBeLessThan(
      source.indexOf('WatchdogSection summary={peer.watchdog} loading={false}'),
    )
    expect(source).toContain('Recent incidents')
    expect(source).toContain('No Web Codex data available yet.')
    expect(source).toContain('command_path')
    expect(source).toContain('command_source')
    expect(source).toContain('Probe:')
    expect(source).toContain('Tried:')
    expect(source).toContain('whiteSpace: \'pre-line\'')
  })
})
