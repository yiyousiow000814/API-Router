import { invoke } from '@tauri-apps/api/core'
import { useEffect, useMemo, useState } from 'react'
import { devTailscaleStatus } from '../devMockData'
import { normalizeGatewayPort } from '../utils/gatewayUrl'
import { WebCodexQrMorph } from './WebCodexQrMorph'
import './WebCodexPanel.css'

type TailscaleStatus = {
  installed: boolean
  connected: boolean
  dnsName: string | null
  ipv4: string[]
  downloadUrl: string
}

type Props = {
  listenPort?: number | null
}

function isDevPreviewRuntime() {
  if (!import.meta.env.DEV) return false
  if (typeof window === 'undefined') return false
  const w = window as unknown as { __TAURI__?: { core?: { invoke?: unknown } } }
  return !Boolean(w.__TAURI__?.core?.invoke)
}

function shortenHost(host: string) {
  if (host.length <= 34) return host
  return `${host.slice(0, 18)}...${host.slice(-12)}`
}

export function WebCodexPanel({ listenPort }: Props) {
  const qrSize = 132
  const [tailscale, setTailscale] = useState<TailscaleStatus | null>(null)
  const [tailscaleLoading, setTailscaleLoading] = useState<boolean>(true)
  const devPreview = useMemo(() => isDevPreviewRuntime(), [])
  const devFlags = useMemo(
    () => (typeof window === 'undefined' ? new URLSearchParams() : new URLSearchParams(window.location.search)),
    [],
  )
  const initialDevState = devFlags.get('tailscale') === 'off' ? 'off' : 'on'
  const [devPreviewTailscaleState, setDevPreviewTailscaleState] = useState<'on' | 'off'>(initialDevState)
  const gatewayPort = String(normalizeGatewayPort(listenPort))
  const localUrl = useMemo(() => `http://127.0.0.1:${gatewayPort}/codex-web`, [gatewayPort])
  const previewUrl = useMemo(() => 'http://127.0.0.1:5173/codex-web', [])

  useEffect(() => {
    let cancelled = false
    setTailscaleLoading(true)

    if (devPreview) {
      setTailscale(devPreviewTailscaleState === 'on'
        ? {
            ...devTailscaleStatus,
            ipv4: [...devTailscaleStatus.ipv4],
          }
        : {
            installed: false,
            connected: false,
            dnsName: null,
            ipv4: [],
            downloadUrl: 'https://tailscale.com/download',
          })
      setTailscaleLoading(false)
      return () => {
        cancelled = true
      }
    }

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
  }, [devPreview, devPreviewTailscaleState])

  const tailscaleHost = useMemo(() => {
    if (!tailscale) return ''
    if (tailscale.dnsName?.trim()) return tailscale.dnsName.trim()
    if (tailscale.ipv4?.length) return tailscale.ipv4[0]
    return ''
  }, [tailscale])
  const tailscaleIp = useMemo(() => tailscale?.ipv4?.[0] || '', [tailscale])
  const phoneDnsUrl = useMemo(() => {
    if (!tailscaleHost) return ''
    return `http://${tailscaleHost}:${gatewayPort}/codex-web`
  }, [tailscaleHost, gatewayPort])
  const phoneIpUrl = useMemo(() => {
    if (!tailscaleIp) return ''
    return `http://${tailscaleIp}:${gatewayPort}/codex-web`
  }, [tailscaleIp, gatewayPort])
  const phoneUrl = phoneIpUrl || phoneDnsUrl
  const phoneReady = !!(!tailscaleLoading && tailscale?.installed && tailscale?.connected && phoneUrl)

  return (
    <section className="aoPanel webCodexAccess">
      <div className="webCodexPage">
        <div className="webCodexHero">
            <div className="webCodexHeroCopy">
              <div className="webCodexHeroEyebrow">Web Codex</div>
              <h2 className="webCodexHeroTitle">Web Codex</h2>
              <div className="webCodexHeroCaption">Desk to phone, one thread.</div>
            </div>
          {devPreview ? (
            <div className="webCodexPreviewToggle" role="tablist" aria-label="Tailscale preview states">
              <button
                className={`webCodexPreviewToggleBtn${devPreviewTailscaleState === 'on' ? ' is-active' : ''}`}
                onClick={() => setDevPreviewTailscaleState('on')}
              >
                Tailscale ready
              </button>
              <button
                className={`webCodexPreviewToggleBtn${devPreviewTailscaleState === 'off' ? ' is-active' : ''}`}
                onClick={() => setDevPreviewTailscaleState('off')}
              >
                Not installed
              </button>
            </div>
          ) : null}
        </div>

        <div className="webCodexLayout">
          <div className="webCodexDesktopCard">
            <div className="webCodexDesktopMain">
              <div className="webCodexCardLabel">Desktop</div>
              <code className="webCodexPrimaryUrl">{localUrl}</code>
              <a className="webCodexCta webCodexDesktopAction" href={localUrl} target="_blank" rel="noreferrer">
                <span className="webCodexButtonLabel">Open in browser</span>
              </a>
            </div>
            <div className="webCodexDesktopFoot">
              <span className="webCodexDesktopPreviewLabel">Preview</span>
              <code className="webCodexDesktopPreviewUrl">{previewUrl}</code>
            </div>
          </div>

          <div className="webCodexPhoneCard">
            <div className="webCodexCardHead">
              <div className="webCodexCardHeadCopy">
                <div className="webCodexCardLabel">Phone</div>
                <div className="webCodexCardTitle">Scan to open</div>
              </div>
              {phoneReady ? <div className="webCodexStatePill">Tailscale ready</div> : null}
            </div>

            {phoneReady ? (
              <div className="webCodexPhoneReady">
                <div className="webCodexQrFrame">
                  <WebCodexQrMorph ready={phoneReady} value={phoneUrl} size={qrSize} />
                </div>
                <div className="webCodexPhoneInfo">
                  <div className="webCodexPhoneHost">{tailscaleIp || shortenHost(tailscaleHost)}</div>
                  <code className="webCodexPhoneUrl">{phoneUrl}</code>
                  {phoneDnsUrl && phoneIpUrl ? <div className="webCodexPhoneFallback">DNS {phoneDnsUrl}</div> : null}
                </div>
              </div>
            ) : (
              <div className="webCodexPhoneSetup">
                <div className="webCodexQrFrame is-ambient">
                  <WebCodexQrMorph ready={phoneReady} value={phoneUrl || localUrl} size={qrSize} />
                </div>
                <div className="webCodexPhoneInfo">
                  <div className="webCodexPhoneHost">Phone</div>
                  <div className="webCodexPhoneSetupText">
                    Install Tailscale on this computer and your phone, then join the same tailnet.
                  </div>
                  <a
                    className="webCodexCta webCodexInstallBtn"
                    href={tailscale?.downloadUrl || 'https://tailscale.com/download'}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <span className="webCodexButtonLabel">Install Tailscale</span>
                  </a>
                </div>
              </div>
            )}
          </div>
        </div>

        {tailscaleLoading ? <div className="aoHint">Checking Tailscale status...</div> : null}
      </div>
    </section>
  )
}
