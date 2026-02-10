import { invoke } from "@tauri-apps/api/core";
import "./App.css";
import { useAppViewModel } from "./app/useAppViewModel";
import { CodexSwapModal } from "./components/CodexSwapModal";
import { ConfigModal } from "./components/ConfigModal";
import { GatewayTokenModal } from "./components/GatewayTokenModal";
import { InstructionModal } from "./components/InstructionModal";
import { KeyModal } from "./components/KeyModal";
import { UsageBaseModal } from "./components/UsageBaseModal";
import { UsageHistoryModal } from "./modals/UsageHistoryModal";
import { UsagePricingModal } from "./modals/UsagePricingModal";
import { UsageScheduleModal } from "./modals/UsageScheduleModal";
import { DashboardPage } from "./pages/DashboardPage";
import { ProviderSwitchboardPage } from "./pages/ProviderSwitchboardPage";
import { UsageStatisticsPage } from "./pages/UsageStatisticsPage";
import { normalizePathForCompare } from "./utils/path";

export default function App() {
  const vm = useAppViewModel();

  return (
    <div className="aoRoot" ref={vm.containerRef}>
      <div className="aoScale">
        <div className="aoShell" ref={vm.contentRef}>
          {vm.toast ? (
            <div className="aoToast" role="status" aria-live="polite">
              {vm.toast}
            </div>
          ) : null}

          <div className="aoBrand">
            <div className="aoBrandLeft">
              <img
                className="aoMark"
                src="/ao-icon.png"
                alt="API Router icon"
              />
              <div>
                <div className="aoTitle">API Router</div>
                <div className="aoSubtitle">
                  Local gateway + smart failover for Codex
                </div>
              </div>
            </div>
            <div className="aoBrandRight">
              <div className="aoTopNav" role="tablist" aria-label="Main pages">
                <button
                  className={`aoTopNavBtn${vm.activePage === "dashboard" ? " is-active" : ""}`}
                  role="tab"
                  aria-selected={vm.activePage === "dashboard"}
                  onClick={() => vm.switchPage("dashboard")}
                >
                  <svg
                    className="aoTopNavIcon"
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                  >
                    <rect x="4" y="4" width="6.5" height="6.5" rx="1.2" />
                    <rect x="13.5" y="4" width="6.5" height="6.5" rx="1.2" />
                    <rect x="4" y="13.5" width="6.5" height="6.5" rx="1.2" />
                    <rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.2" />
                  </svg>
                  <span>Dashboard</span>
                </button>
                <button
                  className={`aoTopNavBtn${vm.activePage === "usage_statistics" ? " is-active" : ""}`}
                  role="tab"
                  aria-selected={vm.activePage === "usage_statistics"}
                  onClick={() => vm.switchPage("usage_statistics")}
                >
                  <svg
                    className="aoTopNavIcon"
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                  >
                    <path d="M4 19.5h16" />
                    <path d="M7 17.5V9.5" />
                    <path d="M12 17.5V5.5" />
                    <path d="M17 17.5V12.5" />
                    <path d="M5.5 6.5 9 9l4-3.5 4 2.5" />
                  </svg>
                  <span>Usage Statistics</span>
                </button>
                <button
                  className={`aoTopNavBtn${vm.activePage === "provider_switchboard" ? " is-active" : ""}`}
                  role="tab"
                  aria-selected={vm.activePage === "provider_switchboard"}
                  onClick={() => vm.switchPage("provider_switchboard")}
                >
                  <svg
                    className="aoTopNavIcon"
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                  >
                    <path d="M4 7h11" />
                    <path d="M4 17h16" />
                    <circle cx="17" cy="7" r="3" />
                    <circle cx="9" cy="17" r="3" />
                  </svg>
                  <span>Provider Switchboard</span>
                </button>
              </div>
              <button
                className="aoTinyBtn"
                onClick={() => vm.setInstructionModalOpen(true)}
              >
                Getting Started
              </button>
            </div>
          </div>

          <div
            className={`aoMainArea${vm.activePage === "dashboard" ? "" : " aoMainAreaFill"}`}
            ref={vm.mainAreaRef}
          >
            {vm.activePage === "usage_statistics" ? (
              <UsageStatisticsPage vm={vm} />
            ) : vm.activePage === "provider_switchboard" ? (
              <ProviderSwitchboardPage vm={vm} />
            ) : (
              <DashboardPage vm={vm} />
            )}
          </div>
        </div>
      </div>

      <KeyModal
        open={vm.keyModal.open}
        provider={vm.keyModal.provider}
        value={vm.keyModal.value}
        onChange={(value) => vm.setKeyModal((prev) => ({ ...prev, value }))}
        onCancel={() =>
          vm.setKeyModal({ open: false, provider: "", value: "" })
        }
        onSave={() => {
          void vm.saveKey(vm.keyModal.provider, vm.keyModal.value);
        }}
      />

      <UsageBaseModal
        open={vm.usageBaseModal.open}
        provider={vm.usageBaseModal.provider}
        value={vm.usageBaseModal.value}
        explicitValue={vm.usageBaseModal.explicitValue}
        onChange={(value) =>
          vm.setUsageBaseModal((prev) => ({
            ...prev,
            value,
            auto: false,
            explicitValue: value,
          }))
        }
        onCancel={() =>
          vm.setUsageBaseModal({
            open: false,
            provider: "",
            value: "",
            auto: false,
            explicitValue: "",
            effectiveValue: "",
          })
        }
        onClear={() => {
          void vm.clearUsageBaseUrl(vm.usageBaseModal.provider);
        }}
        onSave={() => {
          void vm.saveUsageBaseUrl();
        }}
      />

      <InstructionModal
        open={vm.instructionModalOpen}
        onClose={() => vm.setInstructionModalOpen(false)}
        codeText={`model_provider = "api_router"

[model_providers.api_router]
name = "API Router"
base_url = "http://127.0.0.1:4000/v1"
wire_api = "responses"
requires_openai_auth = true`}
      />

      <ConfigModal
        open={vm.configModalOpen}
        config={vm.config}
        allProviderPanelsOpen={vm.allProviderPanelsOpen}
        setAllProviderPanels={vm.setAllProviderPanels}
        newProviderName={vm.newProviderName}
        newProviderBaseUrl={vm.newProviderBaseUrl}
        nextProviderPlaceholder={vm.nextProviderPlaceholder}
        setNewProviderName={vm.setNewProviderName}
        setNewProviderBaseUrl={vm.setNewProviderBaseUrl}
        onAddProvider={() => {
          void vm.addProvider();
        }}
        onClose={() => vm.setConfigModalOpen(false)}
        providerListRef={vm.providerListRef}
        orderedConfigProviders={vm.orderedConfigProviders}
        dragPreviewOrder={vm.dragPreviewOrder}
        draggingProvider={vm.draggingProvider}
        dragCardHeight={vm.dragCardHeight}
        renderProviderCard={vm.renderProviderCard}
      />

      <GatewayTokenModal
        open={vm.gatewayModalOpen}
        tokenPreview={vm.gatewayTokenPreview}
        tokenReveal={vm.gatewayTokenReveal}
        onClose={() => {
          vm.setGatewayModalOpen(false);
          vm.setGatewayTokenReveal("");
        }}
        onReveal={async () => {
          const token = await invoke<string>("get_gateway_token");
          vm.setGatewayTokenReveal(token);
        }}
        onRotate={async () => {
          const rotated = await invoke<string>("rotate_gateway_token");
          vm.setGatewayTokenReveal(rotated);
          const preview = await invoke<string>("get_gateway_token_preview");
          vm.setGatewayTokenPreview(preview);
          vm.flashToast("Gateway token rotated");
        }}
      />

      <UsageHistoryModal vm={vm} />
      <UsagePricingModal vm={vm} />
      <UsageScheduleModal vm={vm} />

      <CodexSwapModal
        open={vm.codexSwapModalOpen}
        dir1={vm.codexSwapDir1}
        dir2={vm.codexSwapDir2}
        applyBoth={vm.codexSwapApplyBoth}
        onChangeDir1={(value) => {
          vm.setCodexSwapDir1(value);
          const dir1 = value.trim();
          const dir2 = vm.codexSwapDir2.trim();
          if (
            dir1 &&
            dir2 &&
            normalizePathForCompare(dir1) === normalizePathForCompare(dir2)
          ) {
            vm.setCodexSwapApplyBoth(false);
          }
        }}
        onChangeDir2={(value) => {
          vm.setCodexSwapDir2(value);
          if (!value.trim()) vm.setCodexSwapApplyBoth(false);
          const dir1 = vm.codexSwapDir1.trim();
          const dir2 = value.trim();
          if (
            dir1 &&
            dir2 &&
            normalizePathForCompare(dir1) === normalizePathForCompare(dir2)
          ) {
            vm.setCodexSwapApplyBoth(false);
          }
        }}
        onChangeApplyBoth={(value) => {
          const dir1 = vm.codexSwapDir1.trim();
          const dir2 = vm.codexSwapDir2.trim();
          if (
            value &&
            dir1 &&
            dir2 &&
            normalizePathForCompare(dir1) === normalizePathForCompare(dir2)
          ) {
            vm.flashToast("Dir 2 must be different from Dir 1", "error");
            vm.setCodexSwapApplyBoth(false);
            return;
          }
          vm.setCodexSwapApplyBoth(value);
        }}
        onCancel={() => vm.setCodexSwapModalOpen(false)}
        onApply={() => {
          void (async () => {
            try {
              const dir1 = vm.codexSwapDir1.trim();
              const dir2 = vm.codexSwapDir2.trim();
              if (vm.codexSwapApplyBoth && !dir1)
                throw new Error("Dir 1 is required when applying both dirs");
              if (vm.codexSwapApplyBoth && !dir2)
                throw new Error("Dir 2 is empty");
              if (
                vm.codexSwapApplyBoth &&
                dir2 &&
                normalizePathForCompare(dir1) === normalizePathForCompare(dir2)
              ) {
                throw new Error("Dir 2 must be different from Dir 1");
              }
              const homes = vm.resolveCliHomes(
                dir1,
                dir2,
                vm.codexSwapApplyBoth,
              );
              await vm.toggleCodexSwap(homes);
              vm.setCodexSwapModalOpen(false);
            } catch (error) {
              vm.flashToast(String(error), "error");
            }
          })();
        }}
      />
    </div>
  );
}
