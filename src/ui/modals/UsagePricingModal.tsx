import type { AppViewModel } from "../app/useAppViewModel";
import { ModalBackdrop } from "../components/ModalBackdrop";

type UsagePricingModalProps = {
  vm: AppViewModel;
};

function saveStateText(value?: "idle" | "saving" | "saved" | "error"): string {
  if (value === "saving") return "Saving...";
  if (value === "saved") return "Saved";
  if (value === "error") return "Save failed";
  return "Idle";
}

export function UsagePricingModal({ vm }: UsagePricingModalProps) {
  const {
    config,
    providers,
    usagePricingModalOpen,
    setUsagePricingModalOpen,
    usagePricingDrafts,
    setUsagePricingDrafts,
    usagePricingSaveState,
    saveUsagePricingRow,
    openUsageScheduleModal,
  } = vm;

  if (!usagePricingModalOpen) return null;

  return (
    <ModalBackdrop
      className="aoModalBackdrop aoModalBackdropTop"
      onClose={() => setUsagePricingModalOpen(false)}
    >
      <div
        className="aoModal aoModalWide aoUsagePricingModal"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="aoModalHeader">
          <div>
            <div className="aoModalTitle">Base Pricing</div>
            <div className="aoModalSub">
              Configure default per-provider pricing for usage statistics when
              tracked spend is missing.
            </div>
          </div>
          <button
            className="aoBtn"
            onClick={() => setUsagePricingModalOpen(false)}
          >
            Close
          </button>
        </div>

        <div className="aoModalBody">
          <div className="aoUsagePricingGrid">
            {providers.map((providerName) => {
              const providerConfig = config?.providers?.[providerName];
              const draft = usagePricingDrafts[providerName] ?? {
                mode: (providerConfig?.manual_pricing_mode ?? "none") as
                  | "none"
                  | "per_request"
                  | "package_total",
                amountText:
                  providerConfig?.manual_pricing_amount_usd != null
                    ? String(providerConfig.manual_pricing_amount_usd)
                    : "",
              };
              const saveState = usagePricingSaveState[providerName] ?? "idle";
              const disableAmount = draft.mode === "none";

              return (
                <div key={providerName} className="aoUsagePricingRow">
                  <div className="aoUsagePricingProviderWrap">
                    <div className="aoUsagePricingProvider">{providerName}</div>
                    <div className="aoHint aoUsagePricingKeyHint">
                      mode source: manual_pricing
                    </div>
                  </div>

                  <select
                    className="aoSelect aoUsagePricingSelect aoUsagePricingMode"
                    value={draft.mode}
                    onChange={(event) => {
                      const mode = (event.target.value || "none") as
                        | "none"
                        | "per_request"
                        | "package_total";
                      setUsagePricingDrafts((prev) => ({
                        ...prev,
                        [providerName]: {
                          ...draft,
                          mode,
                          amountText: mode === "none" ? "" : draft.amountText,
                        },
                      }));
                    }}
                  >
                    <option value="none">Disabled</option>
                    <option value="per_request">Per Request</option>
                    <option value="package_total">Package Total</option>
                  </select>

                  <div className="aoUsagePricingAmountWrap">
                    <input
                      className="aoInput aoUsagePricingAmount"
                      type="number"
                      min="0"
                      step="0.0001"
                      placeholder="USD"
                      disabled={disableAmount}
                      value={draft.amountText}
                      onChange={(event) => {
                        const value = event.target.value;
                        setUsagePricingDrafts((prev) => ({
                          ...prev,
                          [providerName]: {
                            ...draft,
                            amountText: value,
                          },
                        }));
                      }}
                    />
                    <span className="aoUsagePricingCurrencyBtn">USD</span>
                  </div>

                  <div className="aoUsagePricingActionsWrap">
                    <button
                      className="aoTinyBtn"
                      onClick={() => {
                        void saveUsagePricingRow(providerName);
                      }}
                      disabled={saveState === "saving"}
                    >
                      Save
                    </button>
                    <button
                      className="aoTinyBtn"
                      onClick={() => {
                        void openUsageScheduleModal(providerName);
                      }}
                    >
                      Timeline
                    </button>
                    <span
                      className={`aoUsagePricingState aoUsagePricingState-${saveState}`}
                    >
                      {saveStateText(saveState)}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="aoHint" style={{ marginTop: 12 }}>
            Per Request uses USD/request. Package Total is monthly package
            amount and should be paired with Pricing Timeline.
          </div>
        </div>
      </div>
    </ModalBackdrop>
  );
}
