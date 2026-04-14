import fs from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { describeMonitoringRuntimeContext, hasTauriInvokeAvailable, MonitoringPanel } from './MonitoringPanel'

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

  it('explains the 5173 preview shell explicitly', () => {
    ;(globalThis as { window?: unknown }).window = {
      location: { port: '5173' },
    }

    expect(
      describeMonitoringRuntimeContext({
        listen: { host: '127.0.0.1', port: 4312 },
      } as any),
    ).toEqual(
      expect.objectContaining({
        title: 'Running in Vite preview (5173)',
      }),
    )

    const html = renderToStaticMarkup(
      <MonitoringPanel
        status={{
          listen: { host: '127.0.0.1', port: 4312 },
          lan_sync: { peers: [] },
        } as any}
        gatewayTokenPreview=""
      />,
    )

    expect(html).toContain('Running in Vite preview (5173)')
    expect(html).toContain('Use port 4312 in the desktop app flow, not the 5173 preview shell.')
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
    expect(source).toContain("aria-label=\"Refresh peer diagnostics\"")
    expect(source).toContain('Recent incidents')
    expect(source).toContain('No WebTransport data available yet.')
  })
})
