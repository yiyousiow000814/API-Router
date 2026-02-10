import { invoke } from "@tauri-apps/api/core";
import { EventsTable } from "../components/EventsTable";
import {
  HeroCodexCard,
  HeroRoutingCard,
  HeroStatusCard,
} from "../components/HeroCards";
import { ProvidersTable } from "../components/ProvidersTable";
import { SessionsTable } from "../components/SessionsTable";
import type { AppViewModel } from "../app/useAppViewModel";

type DashboardPageProps = {
  vm: AppViewModel;
};

export function DashboardPage({ vm }: DashboardPageProps) {
  const {
    status,
    config,
    override,
    setOverride,
    overrideDirtyRef,
    gatewayTokenPreview,
    setGatewayTokenReveal,
    setGatewayModalOpen,
    setConfigModalOpen,
    setCodexSwapModalOpen,
    codexSwapDir1,
    codexSwapDir2,
    codexSwapApplyBoth,
    refreshingProviders,
    codexRefreshing,
    setCodexRefreshing,
    updatingSessionPref,
    providers,
    visibleEvents,
    canClearErrors,
    clearErrors,
    clientSessions,
    setSessionPreferred,
    codexSwapBadge,
    flashToast,
    resolveCliHomes,
    toggleCodexSwap,
    refreshStatus,
    applyOverride,
    setPreferred,
    refreshQuota,
  } = vm;

  if (!status) {
    return <div className="aoHint">Loading...</div>;
  }

  return (
    <>
      <div className="aoHero">
        <HeroStatusCard
          status={status}
          gatewayTokenPreview={gatewayTokenPreview}
          onCopyToken={() => {
            void (async () => {
              try {
                const token = await invoke<string>("get_gateway_token");
                await navigator.clipboard.writeText(token);
                flashToast("Gateway token copied");
              } catch (error) {
                flashToast(String(error), "error");
              }
            })();
          }}
          onShowRotate={() => {
            setGatewayModalOpen(true);
            setGatewayTokenReveal("");
          }}
        />
        <HeroCodexCard
          status={status}
          onLoginLogout={() => {
            void (async () => {
              try {
                if (status.codex_account?.signed_in) {
                  await invoke("codex_account_logout");
                  flashToast("Codex logged out");
                } else {
                  await invoke("codex_account_login");
                  flashToast("Codex login opened in browser");
                }
                await refreshStatus();
              } catch (error) {
                flashToast(String(error), "error");
              }
            })();
          }}
          onRefresh={() => {
            void (async () => {
              setCodexRefreshing(true);
              try {
                await invoke("codex_account_refresh");
                await refreshStatus();
              } catch (error) {
                flashToast(String(error), "error");
              } finally {
                setCodexRefreshing(false);
              }
            })();
          }}
          refreshing={codexRefreshing}
          onSwapAuthConfig={() => {
            void (async () => {
              try {
                const homes = resolveCliHomes(
                  codexSwapDir1,
                  codexSwapDir2,
                  codexSwapApplyBoth,
                );
                await toggleCodexSwap(homes);
              } catch (error) {
                flashToast(String(error), "error");
              }
            })();
          }}
          onSwapOptions={() => setCodexSwapModalOpen(true)}
          swapBadgeText={codexSwapBadge.badgeText}
          swapBadgeTitle={codexSwapBadge.badgeTitle}
        />
        <HeroRoutingCard
          config={config}
          providers={providers}
          override={override}
          onOverrideChange={(next: string) => {
            setOverride(next);
            overrideDirtyRef.current = true;
            void applyOverride(next);
          }}
          onPreferredChange={(next: string) => {
            void setPreferred(next);
          }}
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
        <ProvidersTable
          providers={providers}
          status={status}
          refreshingProviders={refreshingProviders}
          onRefreshQuota={(providerName) => {
            void refreshQuota(providerName);
          }}
        />
      </div>

      <div className="aoSection">
        <div className="aoSectionHeader">
          <div className="aoRow">
            <h3 className="aoH3">Sessions</h3>
          </div>
        </div>
        <SessionsTable
          sessions={clientSessions}
          providers={providers}
          globalPreferred={status.preferred_provider}
          updating={updatingSessionPref}
          onSetPreferred={(sessionId, providerName) => {
            void setSessionPreferred(sessionId, providerName);
          }}
        />
      </div>

      <div className="aoSection">
        <div className="aoSectionHeader">
          <div className="aoRow">
            <h3 className="aoH3">Events</h3>
          </div>
        </div>
        <EventsTable
          events={visibleEvents}
          canClearErrors={canClearErrors}
          onClearErrors={clearErrors}
        />
      </div>
    </>
  );
}
