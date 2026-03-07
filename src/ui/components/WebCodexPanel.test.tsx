import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { WebCodexPanel } from './WebCodexPanel'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async () => ({
    installed: false,
    connected: false,
    dnsName: null,
    ipv4: [],
    downloadUrl: 'https://tailscale.com/download',
  })),
}))

describe('WebCodexPanel', () => {
  it('renders the live gateway port instead of hard-coded 4000', () => {
    const html = renderToStaticMarkup(<WebCodexPanel listenPort={4312} />)

    expect(html).toContain('http://127.0.0.1:4312/codex-web')
    expect(html).toContain('<code>4312</code> (App)')
  })
})
