import { renderToStaticMarkup } from 'react-dom/server'
import fs from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { WebCodexPanel } from './WebCodexPanel'
import { deriveWebCodexAccessState, normalizeTailscaleStatus } from './webCodexAccessModel'

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
    expect(html).toContain('class="webCodexPhoneInfo is-setup"')
    expect(html).toContain('class="webCodexPhoneInfoStage"')
    expect(html).toContain('class="webCodexPhoneActionsStage"')
  })

  it('keeps qr framing and button labels optically centered', () => {
    const html = renderToStaticMarkup(<WebCodexPanel listenPort={4312} />)
    const css = fs.readFileSync(new URL('./WebCodexPanel.css', import.meta.url), 'utf8')

    expect(html).toContain('class="webCodexButtonLabel"')
    expect(css).toContain('place-items: center;')
    expect(css).toContain('box-sizing: border-box;')
    expect(css).toContain('transform: translateY(-0.5px);')
    expect(css).toContain('align-self: center;')
    expect(css).toContain('opacity 180ms ease')
    expect(css).toContain('transform 180ms ease')
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

  it('keeps one phone qr shell so state changes do not remount the qr block', () => {
    const html = renderToStaticMarkup(<WebCodexPanel listenPort={4312} />)

    expect(html).toContain('class="webCodexPhoneShell is-setup"')
    expect(html).toContain('class="webCodexPhoneCopy webCodexPhoneCopyReady"')
    expect(html).toContain('class="webCodexPhoneCopy webCodexPhoneCopySetup"')
    expect(html).toContain('class="webCodexPhoneSetupActions"')
    expect(html).toContain('class="webCodexStatePill"')
    expect(html).not.toContain('class="webCodexPhoneReady"')
    expect(html).not.toContain('class="webCodexPhoneSetup"')
  })

  it('avoids dev preview loading flicker while toggling tailscale states', () => {
    const source = fs.readFileSync(new URL('./WebCodexPanel.tsx', import.meta.url), 'utf8')

    expect(source).toContain("const effectiveTailscaleLoading = devPreview ? false : tailscaleLoading")
    expect(source).toContain("if (devPreview) return () => { cancelled = true }")
  })

  it('only marks phone ready when the gateway is actually reachable on tailscale', () => {
    const connectedButUnreachable = deriveWebCodexAccessState({
      listenPort: 4312,
      tailscale: normalizeTailscaleStatus({
        installed: true,
        connected: true,
        dnsName: 'desktop.tail.ts.net',
        ipv4: ['100.64.0.4'],
        reachableIpv4: [],
        gatewayReachable: false,
      }),
      tailscaleLoading: false,
    })

    const reachable = deriveWebCodexAccessState({
      listenPort: 4312,
      tailscale: normalizeTailscaleStatus({
        installed: true,
        connected: true,
        dnsName: 'desktop.tail.ts.net',
        ipv4: ['100.64.0.4'],
        reachableIpv4: ['100.64.0.8'],
        gatewayReachable: true,
      }),
      tailscaleLoading: false,
    })

    expect(connectedButUnreachable.phoneReady).toBe(false)
    expect(connectedButUnreachable.phoneUrl).toBe('')
    expect(reachable.phoneReady).toBe(true)
    expect(reachable.phoneUrl).toBe('http://100.64.0.8:4312/codex-web')
  })

  it('shows a restart hint instead of pretending the phone path is ready when tailscale came up late', () => {
    const state = deriveWebCodexAccessState({
      listenPort: 4312,
      tailscale: normalizeTailscaleStatus({
        installed: true,
        connected: true,
        dnsName: 'desktop.tail.ts.net',
        ipv4: ['100.64.0.4'],
        gatewayReachable: false,
        needsGatewayRestart: true,
      }),
      tailscaleLoading: false,
    })

    expect(state.phoneReady).toBe(false)
    expect(state.setupText).toContain('API Router started before the Tailscale listener was ready.')
    expect(state.setupText).toContain('Restart API Router once, then scan again.')
  })

  it('remaps qr particles across value changes instead of rebuilding from scratch', () => {
    const source = fs.readFileSync(new URL('./WebCodexQrMorph.tsx', import.meta.url), 'utf8')

    expect(source).toContain('function remapParticles(value: string, size: number, previous: Particle[]): Particle[]')
    expect(source).toContain('const previousSorted = spatialSort(previous, (item) => item.x, (item) => item.y)')
    expect(source).toContain('const nextSorted = spatialSort(next, (item) => item.qrX, (item) => item.qrY)')
    expect(source).toContain('if (value === activeValueRef.current && particlesRef.current.length) return')
    expect(source).toContain('particlesRef.current = remapParticles(activeValueRef.current, size, particlesRef.current)')
  })

  it('uses a shared ambient field instead of tethering setup particles to each qr point', () => {
    const source = fs.readFileSync(new URL('./WebCodexQrMorph.tsx', import.meta.url), 'utf8')

    expect(source).toContain('ambientX: number')
    expect(source).toContain('ambientY: number')
    expect(source).toContain('burstX: number')
    expect(source).toContain('burstY: number')
    expect(source).toContain('depth: number')
    expect(source).toContain('type QrModule = {')
    expect(source).toContain('const AMBIENT_SAFE_INSET = 0.14')
    expect(source).toContain('function createAmbientAnchor(index: number, total: number, size: number, seed: number)')
    expect(source).toContain('const ambient = createAmbientAnchor(particles.length, total, size, seed)')
    expect(source).toContain('const targetX = p.qrX + p.burstX * disperse + driftMixX')
    expect(source).not.toContain('drawFrameWire')
    expect(source).not.toContain('projectFrameGeometry')
  })

  it('defers qr value swaps until the particles have dispersed on ready to setup transitions', () => {
    const source = fs.readFileSync(new URL('./WebCodexQrMorph.tsx', import.meta.url), 'utf8')

    expect(source).toContain('const VALUE_SWAP_RELEASE_READYNESS = 0.32')
    expect(source).toContain('const isHiding = !ready && currentReadiness > VALUE_SWAP_RELEASE_READYNESS')
    expect(source).toContain('pendingValueRef.current = value')
    expect(source).toContain('readiness <= VALUE_SWAP_RELEASE_READYNESS')
  })

  it('keeps qr particles inside a safer inset so the frame does not clip the cloud edges', () => {
    const source = fs.readFileSync(new URL('./WebCodexQrMorph.tsx', import.meta.url), 'utf8')

    expect(source).toContain('const margin = size * 0.12')
    expect(source).toContain('function clampToInset(value: number, size: number)')
    expect(source).toContain('x: clampToInset(center + Math.cos(angle) * radius + jitterX, size)')
    expect(source).toContain('y: clampToInset(center + Math.sin(angle) * radius + jitterY, size)')
  })

  it('renders setup particles as crisp edge points without the old blur layer', () => {
    const source = fs.readFileSync(new URL('./WebCodexQrMorph.tsx', import.meta.url), 'utf8')

    expect(source).not.toContain('dust: HTMLCanvasElement')
    expect(source).not.toContain('ctx.drawImage(sprites.dust')
    expect(source).toContain('ctx.drawImage(sprites.core')
    expect(source).toContain('modulesRef.current = buildQrModules(activeValueRef.current, size)')
    expect(source).toContain('ctx.fillRect(')
  })

  it('uses a centered cloud flow in setup mode instead of noisy per-particle wandering', () => {
    const source = fs.readFileSync(new URL('./WebCodexQrMorph.tsx', import.meta.url), 'utf8')

    expect(source).toContain('driftBiasX: number')
    expect(source).toContain('driftBiasY: number')
    expect(source).toContain('driftRadius: number')
    expect(source).toContain('driftSeed: number')
    expect(source).toContain('const cloudCenterX = size * 0.5 + Math.cos(nowSeconds * 0.21) * size * 0.025')
    expect(source).toContain('const cloudCenterY = size * 0.5 + Math.sin(nowSeconds * 0.17) * size * 0.02')
    expect(source).toContain('const flowPhase = nowSeconds * (0.26 + p.scale * 0.03) + p.driftSeed * 0.41')
    expect(source).toContain('const orbitPhase = nowSeconds * (0.14 + p.depth * 0.025) + p.depthPhase')
    expect(source).toContain('const centerFalloff = Math.max(0.18, 1 - centerDist / (size * 0.34))')
    expect(source).toContain('const streamX =')
    expect(source).toContain('const streamY =')
    expect(source).toContain('const orbitX = -centerDy * (0.012 + centerFalloff * 0.018) + Math.cos(orbitPhase) * 0.7')
    expect(source).toContain('const settleX = (cloudCenterX - p.ambientX) * 0.018')
    expect(source).toContain('const driftMixX = (streamX + orbitX + settleX) * disperse')
    expect(source).toContain('const driftMixY = (streamY + orbitY + settleY) * disperse')
    expect(source).not.toContain('swayPhase')
    expect(source).not.toContain('const swayX =')
  })

  it('uses simple direct burst vectors so qr transitions read as immediate gather and disperse motion', () => {
    const source = fs.readFileSync(new URL('./WebCodexQrMorph.tsx', import.meta.url), 'utf8')

    expect(source).toContain('burstX: ambient.x - qrX')
    expect(source).toContain('burstY: ambient.y - qrY')
    expect(source).toContain('const targetY = p.qrY + p.burstY * disperse + driftMixY')
    expect(source).not.toContain('const burstLift =')
    expect(source).not.toContain('const transitX =')
  })

  it('keeps depth variation through size and alpha instead of fake glow fade layers', () => {
    const source = fs.readFileSync(new URL('./WebCodexQrMorph.tsx', import.meta.url), 'utf8')

    expect(source).toContain('const coreSize = 1.12 + p.scale * 0.84 + p.depth * 0.58 + sharpen * 1.02')
    expect(source).toContain('const coreAlpha = 0.18 + p.depth * 0.08 + organize * 0.06')
    expect(source).not.toContain('const glowAlpha =')
    expect(source).not.toContain("ctx.fillStyle = 'rgba(255,255,255,0.9)'")
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
