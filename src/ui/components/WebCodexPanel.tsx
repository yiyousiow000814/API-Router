import { invoke } from '@tauri-apps/api/core'
import { useEffect, useState } from 'react'
import { WebCodexQrMorph } from './WebCodexQrMorph'
import {
  buildDevPreviewTailscaleStatus,
  deriveWebCodexAccessState,
  isDevPreviewRuntime,
  type TailscaleStatus,
} from './webCodexAccessModel'
import './WebCodexPanel.css'

type Props = {
  listenPort?: number | null
}

const TAILSCALE_REFRESH_MS = 5000

function buildFallbackTailscaleStatus(): TailscaleStatus {
  return {
    installed: false,
    connected: false,
    dnsName: null,
    ipv4: [],
    reachableIpv4: [],
    gatewayReachable: false,
    needsGatewayRestart: false,
    downloadUrl: 'https://tailscale.com/download',
  }
}

export function WebCodexPanel({ listenPort }: Props) {
  const qrSize = 132
  const [tailscale, setTailscale] = useState<TailscaleStatus | null>(null)
  const [tailscaleLoading, setTailscaleLoading] = useState<boolean>(true)
  const devPreview = isDevPreviewRuntime()
  const initialDevState =
    typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('tailscale') === 'off'
      ? 'off'
      : 'on'
  const [devPreviewTailscaleState, setDevPreviewTailscaleState] = useState<'on' | 'off'>(initialDevState)
  const devPreviewStatus = devPreview ? buildDevPreviewTailscaleStatus(devPreviewTailscaleState) : null

  useEffect(() => {
    let cancelled = false
    if (devPreview) return () => { cancelled = true }
    setTailscaleLoading(true)

    const refreshTailscale = async () => {
      try {
        const value = await invoke<TailscaleStatus>('tailscale_status')
        if (cancelled) return
        setTailscale(value)
      } catch {
        if (cancelled) return
        setTailscale(buildFallbackTailscaleStatus())
      } finally {
        if (cancelled) return
        setTailscaleLoading(false)
      }
    }

    void refreshTailscale()
    const refreshTimer = window.setInterval(() => {
      void refreshTailscale()
    }, TAILSCALE_REFRESH_MS)

    return () => {
      cancelled = true
      window.clearInterval(refreshTimer)
    }
  }, [devPreview])

  const effectiveTailscale = devPreview ? devPreviewStatus : tailscale
  const effectiveTailscaleLoading = devPreview ? false : tailscaleLoading
  const accessState = deriveWebCodexAccessState({
    listenPort,
    tailscale: effectiveTailscale,
    tailscaleLoading: effectiveTailscaleLoading,
  })

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
              <code className="webCodexPrimaryUrl">{accessState.localUrl}</code>
              <a
                className="webCodexCta webCodexDesktopAction"
                href={accessState.localUrl}
                target="_blank"
                rel="noreferrer"
              >
                <span className="webCodexButtonLabel">Open in browser</span>
              </a>
            </div>
            <div className="webCodexDesktopFoot">
              <span className="webCodexDesktopPreviewLabel">Preview</span>
              <code className="webCodexDesktopPreviewUrl">{accessState.previewUrl}</code>
            </div>
          </div>

          <div className="webCodexPhoneCard">
            <div className="webCodexCardHead">
              <div className="webCodexCardHeadCopy">
                <div className="webCodexCardLabel">Phone</div>
                <div className="webCodexCardTitle">Scan to open</div>
              </div>
              <div className={`webCodexStatePill${accessState.phoneReady ? ' is-visible' : ''}`}>Tailscale ready</div>
            </div>

            <div className={`webCodexPhoneShell ${accessState.phoneStateClass}`}>
              <div className={`webCodexQrFrame${accessState.phoneReady ? '' : ' is-ambient'}`}>
                <WebCodexQrMorph ready={accessState.phoneReady} value={accessState.phoneQrValue} size={qrSize} />
              </div>
              <div className={`webCodexPhoneInfo ${accessState.phoneStateClass}`}>
                <div className="webCodexPhoneInfoStage">
                  <div className="webCodexPhoneCopy webCodexPhoneCopyReady">
                    <div className="webCodexPhoneHost">{accessState.phoneHostLabel}</div>
                    <code className="webCodexPhoneUrl">{accessState.phoneUrl || accessState.localUrl}</code>
                    {accessState.phoneDnsUrl && accessState.phoneIpUrl ? (
                      <div className="webCodexPhoneFallback">DNS {accessState.phoneDnsUrl}</div>
                    ) : null}
                  </div>
                  <div className="webCodexPhoneCopy webCodexPhoneCopySetup">
                    <div className="webCodexPhoneHost">Phone</div>
                    <div className="webCodexPhoneSetupText">{accessState.setupText}</div>
                  </div>
                </div>
                <div className="webCodexPhoneActionsStage">
                  <div className="webCodexPhoneActionsReady" aria-hidden={!accessState.phoneReady} />
                  <div className="webCodexPhoneSetupActions">
                    {accessState.showInstallAction ? (
                      <a
                        className="webCodexCta webCodexInstallBtn"
                        href={effectiveTailscale?.downloadUrl || 'https://tailscale.com/download'}
                        target="_blank"
                        rel="noreferrer"
                      >
                        <span className="webCodexButtonLabel">Install Tailscale</span>
                      </a>
                    ) : null}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
