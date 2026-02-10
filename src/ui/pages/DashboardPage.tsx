import { invoke } from '@tauri-apps/api/core'
import { EventsTable } from '../components/EventsTable'
import { HeroCodexCard, HeroRoutingCard, HeroStatusCard } from '../components/HeroCards'
import { ProvidersTable } from '../components/ProvidersTable'
import { SessionsTable } from '../components/SessionsTable'

export function DashboardPage(props: any) {
  const {
    applyOverride,
    canClearErrors,
    clearErrors,
    clientSessions,
    codexRefreshing,
    codexSwapApplyBoth,
    codexSwapBadge,
    codexSwapDir1,
    codexSwapDir2,
    config,
    flashToast,
    gatewayTokenPreview,
    override,
    overrideDirtyRef,
    providers,
    refreshingProviders,
    refreshQuota,
    refreshStatus,
    resolveCliHomes,
    setCodexRefreshing,
    setCodexSwapModalOpen,
    setConfigModalOpen,
    setGatewayModalOpen,
    setGatewayTokenReveal,
    setOverride,
    setPreferred,
    setSessionPreferred,
    status,
    toggleCodexSwap,
    updatingSessionPref,
    visibleEvents,
  } = props

  return (
            <>
              <div className="aoHero">
                <HeroStatusCard
                  status={status}
                  gatewayTokenPreview={gatewayTokenPreview}
                  onCopyToken={() => {
                    void (async () => {
                      try {
                        const tok = await invoke<string>('get_gateway_token')
                        await navigator.clipboard.writeText(tok)
                        flashToast('Gateway token copied')
                      } catch (e) {
                        flashToast(String(e), 'error')
                      }
                    })()
                  }}
                  onShowRotate={() => {
                    setGatewayModalOpen(true)
                    setGatewayTokenReveal('')
                  }}
                />
                <HeroCodexCard
                  status={status}
                  onLoginLogout={() => {
                    void (async () => {
                      try {
                        if (status.codex_account?.signed_in) {
                          await invoke('codex_account_logout')
                          flashToast('Codex logged out')
                        } else {
                          await invoke('codex_account_login')
                          flashToast('Codex login opened in browser')
                        }
                      } catch (e) {
                        flashToast(String(e), 'error')
                      }
                    })()
                  }}
                  onRefresh={() => {
                    void (async () => {
                      flashToast('Checking...')
                      setCodexRefreshing(true)
                      try {
                        await invoke('codex_account_refresh')
                        await refreshStatus()
                      } catch (e) {
                        flashToast(String(e), 'error')
                      } finally {
                        setCodexRefreshing(false)
                      }
                    })()
                  }}
                  refreshing={codexRefreshing}
                  onSwapAuthConfig={() => {
                    void (async () => {
                      try {
                        const homes = resolveCliHomes(codexSwapDir1, codexSwapDir2, codexSwapApplyBoth)
                        await toggleCodexSwap(homes)
                      } catch (e) {
                        flashToast(String(e), 'error')
                      }
                    })()
                  }}
                  onSwapOptions={() => setCodexSwapModalOpen(true)}
                  swapBadgeText={codexSwapBadge.badgeText}
                  swapBadgeTitle={codexSwapBadge.badgeTitle}
                />
                <HeroRoutingCard
                  config={config}
                  providers={providers}
                  override={override}
                  onOverrideChange={(next) => {
                    setOverride(next)
                    overrideDirtyRef.current = true
                    void applyOverride(next)
                  }}
                  onPreferredChange={(next) => void setPreferred(next)}
                />
              </div>

              <div className="aoSection">
                <div className="aoSectionHeader aoSectionHeaderStack">
                  <div className="aoRow">
                    <h3 className="aoH3">Providers</h3>
                    <button
                      className="aoIconGhost"
                      title="Config"
                      aria-label="Config"
                      onClick={() => setConfigModalOpen(true)}
                    >
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M12 20h9" />
                        <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5Z" />
                      </svg>
                    </button>
                  </div>
                </div>
                <ProvidersTable providers={providers} status={status} refreshingProviders={refreshingProviders} onRefreshQuota={(name) => void refreshQuota(name)} />
              </div>

              <div className="aoSection">
                <div className="aoSectionHeader">
                  <div className="aoRow">
                    <h3 className="aoH3">Sessions</h3>
                  </div>
                </div>
                <SessionsTable
                  sessions={clientSessions ?? []}
                  providers={providers}
                  globalPreferred={status.preferred_provider}
                  updating={updatingSessionPref}
                  onSetPreferred={(sessionId, provider) => void setSessionPreferred(sessionId, provider)}
                />
              </div>

              <div className="aoSection">
                <div className="aoSectionHeader">
                  <div className="aoRow">
                    <h3 className="aoH3">Events</h3>
                  </div>
                </div>
                <EventsTable events={visibleEvents} canClearErrors={canClearErrors} onClearErrors={clearErrors} />
              </div>
            </>
  )
}
