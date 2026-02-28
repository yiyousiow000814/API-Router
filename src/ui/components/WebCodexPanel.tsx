import { invoke } from '@tauri-apps/api/core'
import { useEffect, useMemo, useState } from 'react'

type TailscaleStatus = {
  installed: boolean
  connected: boolean
  dnsName: string | null
  ipv4: string[]
  downloadUrl: string
}

export function WebCodexPanel() {
  const [tailscale, setTailscale] = useState<TailscaleStatus | null>(null)
  const [tailscaleLoading, setTailscaleLoading] = useState<boolean>(true)
  const gatewayPort = '4000'
  const appWebCodexUrl = useMemo(() => `http://127.0.0.1:${gatewayPort}/codex-web`, [gatewayPort])
  const appWsUrl = useMemo(() => `ws://127.0.0.1:${gatewayPort}/codex/ws?token=YOUR_GATEWAY_TOKEN`, [gatewayPort])
  const sandboxWebCodexUrl = useMemo(() => 'http://127.0.0.1:5173/sandbox/codex-web', [])
  const sandboxQuickUrl = useMemo(() => 'http://127.0.0.1:5173/codex-web', [])

  useEffect(() => {
    let cancelled = false
    setTailscaleLoading(true)
    void invoke<TailscaleStatus>('tailscale_status')
      .then((value) => {
        if (cancelled) return
        setTailscale(value)
      })
      .catch(() => {
        if (cancelled) return
        setTailscale({
          installed: false,
          connected: false,
          dnsName: null,
          ipv4: [],
          downloadUrl: 'https://tailscale.com/download',
        })
      })
      .finally(() => {
        if (cancelled) return
        setTailscaleLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const tailscaleHost = useMemo(() => {
    if (!tailscale) return ''
    if (tailscale.dnsName && tailscale.dnsName.trim()) return tailscale.dnsName.trim()
    if (tailscale.ipv4?.length) return tailscale.ipv4[0]
    return ''
  }, [tailscale])
  const tailscaleIp = useMemo(() => tailscale?.ipv4?.[0] || '', [tailscale])
  const tailscaleWebUrl = useMemo(() => {
    if (!tailscaleHost) return ''
    return `http://${tailscaleHost}:${gatewayPort}/codex-web`
  }, [tailscaleHost, gatewayPort])
  const tailscaleWebUrlByIp = useMemo(() => {
    if (!tailscaleIp) return ''
    return `http://${tailscaleIp}:${gatewayPort}/codex-web`
  }, [tailscaleIp, gatewayPort])
  const tailscaleWsUrl = useMemo(() => {
    if (!tailscaleHost) return ''
    return `ws://${tailscaleHost}:${gatewayPort}/codex/ws?token=YOUR_GATEWAY_TOKEN`
  }, [tailscaleHost, gatewayPort])
  const tailscaleTemplateUrl = useMemo(() => `http://<your-device>.ts.net:${gatewayPort}/codex-web`, [gatewayPort])

  return (
    <section className="aoPanel">
      <div className="aoPanelHead">
        <div className="aoPanelTitle">Web Codex Access</div>
        <div className="aoPanelHint">Tailscale-ready links for phone and desktop</div>
      </div>
      <div className="aoPanelBody" style={{ display: 'grid', gap: 10 }}>
        {tailscaleLoading ? (
          <div className="aoCard">
            <div className="aoHint">Checking Tailscale status...</div>
          </div>
        ) : null}

        {!tailscaleLoading && tailscale && (!tailscale.installed || !tailscale.connected || !tailscaleHost) ? (
          <div className="aoCard">
            <div className="aoCardHeader">
              <div className="aoCardTitle">Step 1: Install Tailscale</div>
            </div>
            <div className="aoHint">
              Tailscale is not ready on this machine yet.
            </div>
            <div className="aoRow" style={{ marginTop: 10 }}>
              <a
                className="aoBtn aoBtnPrimary"
                href={tailscale.downloadUrl}
                target="_blank"
                rel="noreferrer"
                style={{ borderRadius: 999, paddingInline: 16 }}
              >
                Download Tailscale
              </a>
            </div>
            <ol className="aoHint" style={{ marginTop: 10, paddingLeft: 18 }}>
              <li>Install Tailscale on computer and phone.</li>
              <li>Sign in to the same tailnet on both devices.</li>
              <li>On computer, run <code>tailscale up</code> once.</li>
              <li>Reopen this tab and URLs will auto-fill.</li>
            </ol>
          </div>
        ) : null}

        <div className="aoCard">
          <div className="aoCardHeader">
            <div className="aoCardTitle">Ports</div>
          </div>
          <ul className="aoHint" style={{ margin: 0, paddingLeft: 18 }}>
            <li><code>4000</code> (App): real gateway + real Web Codex. Desktop open: <code>{appWebCodexUrl}</code>.</li>
            <li><code>5173</code> (Dev): sandbox preview (read-only). Desktop open: <code>{sandboxWebCodexUrl}</code>.</li>
            <li>Quick sandbox alias: <code>{sandboxQuickUrl}</code>.</li>
          </ul>
        </div>

        {!tailscaleLoading && tailscale && tailscale.installed && tailscale.connected && tailscaleHost ? (
          <>
        <div className="aoCard">
          <div className="aoCardHeader">
            <div className="aoCardTitle">Access URL</div>
          </div>
          <div className="aoKvp">
            <div className="aoKey">Tailscale</div>
            <div className="aoKvpRight">
              <code className="aoVal">{tailscaleWebUrl}</code>
            </div>
            <div className="aoKey">Tailscale IP</div>
            <div className="aoKvpRight">
              <code className="aoVal">{tailscaleWebUrlByIp || '(no Tailscale IPv4 found)'}</code>
            </div>
            <div className="aoKey">Tailscale Template</div>
            <div className="aoKvpRight">
              <code className="aoVal">{tailscaleTemplateUrl}</code>
            </div>
            <div className="aoKey">Local</div>
            <div className="aoKvpRight">
              <code className="aoVal">{appWebCodexUrl}</code>
            </div>
            <div className="aoKey">Tailscale WS</div>
            <div className="aoKvpRight">
              <code className="aoVal">{tailscaleWsUrl}</code>
            </div>
            <div className="aoKey">Local WS</div>
            <div className="aoKvpRight">
              <code className="aoVal">{appWsUrl}</code>
            </div>
          </div>
        </div>

        <div className="aoCard">
          <div className="aoCardHeader">
            <div className="aoCardTitle">How To Connect (Phone)</div>
          </div>
          <ol className="aoHint" style={{ margin: 0, paddingLeft: 18 }}>
            <li>Start API Router (gateway on port <code>4000</code>) and keep this machine online.</li>
            <li>Ensure phone + computer are logged into the same Tailscale account/tailnet.</li>
            <li>Open <code>{tailscaleWebUrl}</code> on phone browser (or use <code>{tailscaleWebUrlByIp}</code>).</li>
            <li>Paste Gateway Token, click Connect.</li>
            <li>Use Codex on phone directly (threads, resume, slash, attachments, approvals).</li>
          </ol>
        </div>

        <div className="aoCard">
          <div className="aoCardHeader">
            <div className="aoCardTitle">How To Connect (Desktop)</div>
          </div>
          <ol className="aoHint" style={{ margin: 0, paddingLeft: 18 }}>
            <li>Real mode: open <code>{appWebCodexUrl}</code>.</li>
            <li>Sandbox mode (read-only): open <code>{sandboxWebCodexUrl}</code>.</li>
            <li>If using <code>5173</code>, keep Vite dev server running.</li>
          </ol>
        </div>

        <div className="aoCard">
          <div className="aoCardHeader">
            <div className="aoCardTitle">Notes</div>
          </div>
          <ul className="aoHint" style={{ margin: 0, paddingLeft: 18 }}>
            <li>Web Codex runs independently at <code>/codex-web</code>, not inside the dashboard UI.</li>
            <li>This tab now provides entry and setup guidance only (no embedded iframe).</li>
            <li>Protocol switching is automatic: HTTP → WS, HTTPS → WSS.</li>
          </ul>
        </div>
          </>
        ) : null}
      </div>
    </section>
  )
}
