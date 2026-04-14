import type { Status } from '../types'
import { GATEWAY_WINDOWS_HOST, GATEWAY_WSL2_HOST } from '../constants'

type HeroStatusProps = {
  status: Status
  gatewayTokenPreview: string
  onCopyToken: () => void
  onShowRotate: () => void
}

export function lanPeersSummary(status: Status): string {
  const lanPeers = status.lan_sync?.peers ?? []
  const aliveLabel = `${lanPeers.length} alive`
  const updateAvailableCount = lanPeers.filter((peer) => peer.build_matches_local === false).length
  if (updateAvailableCount <= 0) return aliveLabel
  const updateLabel = updateAvailableCount === 1 ? 'update available' : `${updateAvailableCount} updates available`
  return `${aliveLabel} (${updateLabel})`
}

export function tailscaleSummary(status: Status): string {
  const tailscale = status.tailscale
  if (!tailscale) return 'Unknown'
  const host = tailscale.dns_name?.trim() || tailscale.reachable_ipv4[0] || tailscale.ipv4[0] || ''
  if (!tailscale.installed) return 'Not installed'
  if (!tailscale.connected) {
    if (tailscale.status_error === 'tailscale_not_found') return 'CLI not found'
    if (tailscale.status_error === 'tailscale_not_connected') return 'Installed, not connected'
    return 'Disconnected'
  }
  if (tailscale.gateway_reachable) {
    return host ? `Reachable via ${host}` : 'Reachable'
  }
  if (tailscale.needs_gateway_restart) return 'Connected, restart API Router'
  if (tailscale.status_error?.trim()) return tailscale.status_error.trim()
  return 'Connected, gateway unreachable'
}

function peerTailscaleStateLabel(peer: NonNullable<Status['lan_sync']>['peers'][number]): string | null {
  const tailscale = peer.tailscale
  if (!tailscale) return null
  if (!tailscale.installed) return 'not installed'
  if (!tailscale.connected) return 'not connected'
  if (tailscale.gateway_reachable) return null
  if (tailscale.needs_gateway_restart) return 'needs restart'
  return 'gateway unreachable'
}

export function lanPeerTailscaleSummary(status: Status): string | null {
  const peers = status.lan_sync?.peers ?? []
  const issues = peers
    .map((peer) => {
      const label = peerTailscaleStateLabel(peer)
      return label ? `${peer.node_name}: ${label}` : null
    })
    .filter((value): value is string => Boolean(value))
  if (issues.length <= 0) return null
  if (issues.length === 1) return issues[0]
  if (issues.length === 2) return issues.join(' | ')
  return `${issues[0]} | ${issues[1]} | +${issues.length - 2} more`
}

export function HeroStatusCard({
  status,
  gatewayTokenPreview,
  onCopyToken,
  onShowRotate,
}: HeroStatusProps) {
  const wslGatewayHost = status.wsl_gateway_host?.trim() || GATEWAY_WSL2_HOST
  const lanNode = status.lan_sync?.local_node
  return (
    <div className="aoCard aoHeroCard aoHeroStatus">
      <div className="aoCardHeader">
        <div className="aoCardTitle">Gateway</div>
        <span className="aoPill aoPulse">
          <span className="aoDot" />
          <span className="aoPillText">running</span>
        </span>
      </div>
      <div className="aoStatGrid">
        <div className="aoStatLabel">Base URL (Wins)</div>
        <div className="aoStatValue">
          http://{GATEWAY_WINDOWS_HOST}:{status.listen.port}/v1
        </div>
        <div className="aoStatLabel">Base URL (WSL2)</div>
        <div className="aoStatValue">
          http://{wslGatewayHost}:{status.listen.port}/v1
        </div>
        {lanNode ? (
          <>
            <div className="aoStatLabel">LAN node</div>
            <div className="aoStatValue">
              {lanNode.node_name} · {lanNode.node_id.slice(0, 8)}
            </div>
            <div className="aoStatLabel">LAN peers</div>
            <div className="aoStatValue">{lanPeersSummary(status)}</div>
          </>
        ) : null}
      </div>
      <div className="aoDivider" />
      <div className="aoTokenRow">
        <div className="aoStatLabel">Gateway token</div>
        <div className="aoTokenRowRight">
          <div className="aoVal aoValSmall">{gatewayTokenPreview}</div>
          <button
            className="aoIconBtn"
            title="Copy gateway token"
            aria-label="Copy gateway token"
            onClick={onCopyToken}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M9 9h9a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2Z" />
              <path d="M15 9V7a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
            </svg>
          </button>
          <button className="aoBtn" onClick={onShowRotate}>
            Rotate
          </button>
        </div>
      </div>
      <div className="aoHint">
        Put this into{' '}
        <span style={{ fontFamily: 'ui-monospace, "Cascadia Mono", "Consolas", monospace' }}>
          .codex/auth.json
        </span>{' '}
        as
        <span style={{ fontFamily: 'ui-monospace, "Cascadia Mono", "Consolas", monospace' }}>
          {' '}
          OPENAI_API_KEY
        </span>
        .
      </div>
    </div>
  )
}
