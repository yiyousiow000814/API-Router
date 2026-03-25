import { renderToStaticMarkup } from 'react-dom/server'
import fs from 'node:fs'
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

vi.mock('qrcode', () => ({
  default: {
    create: vi.fn(() => ({
      modules: {
        size: 21,
        get: (row: number, col: number) => (row + col) % 2 === 0,
      },
    })),
  },
}))

describe('WebCodexPanel', () => {
  it('renders the live gateway port instead of hard-coded 4000', () => {
    const html = renderToStaticMarkup(<WebCodexPanel listenPort={4312} />)

    expect(html).toContain('http://127.0.0.1:4312/codex-web')
    expect(html).toContain('Open in browser')
    expect(html).toContain('http://127.0.0.1:5173/codex-web')
  })

  it('keeps the panel focused on desktop phone and preview entry points', () => {
    const html = renderToStaticMarkup(<WebCodexPanel listenPort={4312} />)

    expect(html).toContain('Web Codex')
    expect(html).toContain('Desk to phone, one thread.')
    expect(html).toContain('Desktop')
    expect(html).toContain('Phone')
    expect(html).toContain('Preview')
    expect(html).toContain('Install Tailscale')
  })

  it('uses dedicated content columns so actions stay aligned to the card text', () => {
    const html = renderToStaticMarkup(<WebCodexPanel listenPort={4312} />)

    expect(html).toContain('class="webCodexDesktopMain"')
    expect(html).toContain('class="webCodexDesktopFoot"')
    expect(html).toContain('class="webCodexCardHeadCopy"')
    expect(html).toContain('class="webCodexPhoneInfo"')
  })

  it('keeps qr framing and button labels optically centered', () => {
    const html = renderToStaticMarkup(<WebCodexPanel listenPort={4312} />)
    const css = fs.readFileSync(new URL('./WebCodexPanel.css', import.meta.url), 'utf8')

    expect(html).toContain('class="webCodexButtonLabel"')
    expect(css).toContain('place-items: center;')
    expect(css).toContain('box-sizing: border-box;')
    expect(css).toContain('transform: translateY(-0.5px);')
    expect(css).toContain('align-self: center;')
  })

  it('stacks the desktop preview under the primary action instead of pinning it to the card bottom', () => {
    const css = fs.readFileSync(new URL('./WebCodexPanel.css', import.meta.url), 'utf8')

    expect(css).toContain('.webCodexDesktopCard {')
    expect(css).toContain('align-content: start;')
    expect(css).not.toContain('grid-template-rows: minmax(0, 1fr) auto;')
  })

  it('uses one shared CTA style instead of mixing dashboard button variants', () => {
    const html = renderToStaticMarkup(<WebCodexPanel listenPort={4312} />)
    const css = fs.readFileSync(new URL('./WebCodexPanel.css', import.meta.url), 'utf8')

    expect(html).toContain('class="webCodexCta webCodexDesktopAction"')
    expect(html).toContain('class="webCodexCta webCodexInstallBtn"')
    expect(html).not.toContain('aoBtnPrimary webCodexInstallBtn')
    expect(css).toContain('.webCodexCta {')
  })

  it('removes old verbose routing and duplicated status copy', () => {
    const html = renderToStaticMarkup(<WebCodexPanel listenPort={4312} />)

    expect(html).not.toContain('Open the gateway, not a maze of cards.')
    expect(html).not.toContain('Open from here.')
    expect(html).not.toContain('Gateway :4312')
    expect(html).not.toContain('Phone Ready')
    expect(html).not.toContain('Fallback ')
  })
})
