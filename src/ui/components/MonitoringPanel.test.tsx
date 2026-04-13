import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import { MonitoringPanel } from './MonitoringPanel'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}))

describe('MonitoringPanel', () => {
  it('renders a waiting hint instead of crashing before live status arrives', () => {
    const html = renderToStaticMarkup(<MonitoringPanel status={null} gatewayTokenPreview="" />)

    expect(html).toContain('Remote Peers')
    expect(html).toContain('Waiting for live gateway status.')
  })
})
