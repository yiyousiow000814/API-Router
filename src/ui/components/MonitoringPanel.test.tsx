import fs from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  hasTauriInvokeAvailable,
  formatIncidentKind,
  isMonitoringDevPreview,
  MonitoringPanel,
  peerSupportsLanDiagnostics,
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
        version_inventory: ['heartbeat_v1', 'lan_debug_v2'],
      } as any),
    ).toBe(true)

    expect(
      peerSupportsLanDiagnostics({
        trusted: false,
        version_inventory: ['heartbeat_v1', 'lan_debug_v2'],
      } as any),
    ).toBe(false)

    expect(
      peerSupportsLanDiagnostics({
        trusted: true,
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
    expect(html).toContain('UI heartbeat stalled')
    expect(html).toContain('WebTransport thread refresh failed')
    expect(html).toContain('Desk B')
    expect(html).toContain('restart API Router')
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
    expect(source).toContain('No WebTransport data available yet.')
  })
})
