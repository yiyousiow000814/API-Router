import { normalizeGatewayPort } from '../utils/gatewayUrl'

export type TailscaleStatus = {
  installed: boolean
  connected: boolean
  dnsName: string | null
  ipv4: string[]
  reachableIpv4: string[]
  gatewayReachable: boolean
  needsGatewayRestart: boolean
  downloadUrl: string
}

type AccessStateInput = {
  listenPort?: number | null
  tailscale: TailscaleStatus | null
  tailscaleLoading: boolean
}

export type WebCodexAccessState = {
  gatewayPort: number
  localUrl: string
  previewUrl: string
  phoneDnsUrl: string
  phoneIpUrl: string
  phoneUrl: string
  phoneQrValue: string
  phoneReady: boolean
  phoneStateClass: 'is-ready' | 'is-setup'
  phoneHostLabel: string
  setupText: string
  showInstallAction: boolean
}

type TailscaleStatusInput = Partial<Omit<TailscaleStatus, 'ipv4' | 'reachableIpv4'>> & {
  ipv4?: readonly string[]
  reachableIpv4?: readonly string[]
}

const DEFAULT_DOWNLOAD_URL = 'https://tailscale.com/download'
const DEV_PREVIEW_TAILSCALE_STATUS = {
  installed: true,
  connected: true,
  dnsName: 'desktop-kk6sa2d-1.tail997985.ts.net',
  ipv4: ['100.64.208.117'],
  downloadUrl: DEFAULT_DOWNLOAD_URL,
} as const

export function isDevPreviewRuntime() {
  if (!import.meta.env.DEV) return false
  if (typeof window === 'undefined') return false
  const w = window as unknown as { __TAURI__?: { core?: { invoke?: unknown } } }
  return !Boolean(w.__TAURI__?.core?.invoke)
}

export function shortenHost(host: string) {
  if (host.length <= 34) return host
  return `${host.slice(0, 18)}...${host.slice(-12)}`
}

export function normalizeTailscaleStatus(
  status: TailscaleStatusInput | null | undefined,
): TailscaleStatus {
  return {
    installed: status?.installed ?? false,
    connected: status?.connected ?? false,
    dnsName: status?.dnsName?.trim() || null,
    ipv4: status?.ipv4 ? [...status.ipv4] : [],
    reachableIpv4: status?.reachableIpv4 ? [...status.reachableIpv4] : [],
    gatewayReachable: status?.gatewayReachable ?? false,
    needsGatewayRestart: status?.needsGatewayRestart ?? false,
    downloadUrl: status?.downloadUrl || DEFAULT_DOWNLOAD_URL,
  }
}

export function buildDevPreviewTailscaleStatus(state: 'on' | 'off'): TailscaleStatus {
  if (state === 'on') {
    return normalizeTailscaleStatus({
      ...DEV_PREVIEW_TAILSCALE_STATUS,
      reachableIpv4: [...DEV_PREVIEW_TAILSCALE_STATUS.ipv4],
      gatewayReachable: true,
    })
  }
  return normalizeTailscaleStatus(null)
}

export function deriveWebCodexAccessState({
  listenPort,
  tailscale,
  tailscaleLoading,
}: AccessStateInput): WebCodexAccessState {
  const gatewayPort = normalizeGatewayPort(listenPort)
  const localUrl = `http://127.0.0.1:${gatewayPort}/codex-web`
  const previewUrl = 'http://127.0.0.1:5173/codex-web'
  const effectiveTailscale = normalizeTailscaleStatus(tailscale)
  const tailscaleHost = effectiveTailscale.dnsName || effectiveTailscale.ipv4[0] || ''
  const tailscaleIp = effectiveTailscale.ipv4[0] || ''
  const reachableTailscaleIp = effectiveTailscale.reachableIpv4[0] || ''
  const phoneDnsUrl =
    tailscaleHost && effectiveTailscale.gatewayReachable ? `http://${tailscaleHost}:${gatewayPort}/codex-web` : ''
  const phoneIpUrl = reachableTailscaleIp ? `http://${reachableTailscaleIp}:${gatewayPort}/codex-web` : ''
  const phoneUrl = phoneIpUrl || phoneDnsUrl
  const phoneReady = Boolean(
    !tailscaleLoading &&
      effectiveTailscale.installed &&
      effectiveTailscale.connected &&
      effectiveTailscale.gatewayReachable &&
      phoneUrl,
  )

  let setupText = 'Tailscale is connected, but this phone address is not reachable yet.'
  if (!effectiveTailscale.installed) {
    setupText = 'Install Tailscale on this computer and your phone, then join the same tailnet.'
  } else if (!effectiveTailscale.connected) {
    setupText = 'Join this computer and your phone to the same tailnet, then scan again.'
  } else if (effectiveTailscale.needsGatewayRestart) {
    setupText = 'API Router started before the Tailscale listener was ready. Restart API Router once, then scan again.'
  }

  return {
    gatewayPort,
    localUrl,
    previewUrl,
    phoneDnsUrl,
    phoneIpUrl,
    phoneUrl,
    phoneQrValue: phoneUrl || localUrl,
    phoneReady,
    phoneStateClass: phoneReady ? 'is-ready' : 'is-setup',
    phoneHostLabel: reachableTailscaleIp || tailscaleIp || shortenHost(tailscaleHost) || 'Phone',
    setupText,
    showInstallAction: !effectiveTailscale.installed,
  }
}
