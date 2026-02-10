import type { AppViewModel } from "../app/useAppViewModel";

type ProviderSwitchboardPageProps = {
  vm: AppViewModel;
};

export function ProviderSwitchboardPage({ vm }: ProviderSwitchboardPageProps) {
  const {
    setCodexSwapModalOpen,
    providerSwitchStatus,
    providerSwitchBusy,
    setProviderSwitchTarget,
    switchboardProviderCards,
    switchboardModeLabel,
    switchboardModelProviderLabel,
    switchboardTargetDirsLabel,
  } = vm;

  return (
    <>
      <div className="aoProviderSwitchboardHeader">
        <div>
          <div className="aoPagePlaceholderTitle">Provider Switchboard</div>
          <div className="aoHint">
            One-click switch for Codex auth/config target.
          </div>
          <div className="aoHint">
            Dashboard Swap and this page share the same target state.
          </div>
        </div>
        <div className="aoPill">
          <span className="aoDot" />
          <span className="aoPillText">{switchboardModeLabel}</span>
        </div>
      </div>

      <div className="aoSwitchThemeBand">
        <div className="aoSwitchThemeBandHead">
          <div className="aoMiniLabel">Current Target</div>
        </div>
        <div className="aoSwitchThemeSummary">
          <div className="aoSwitchThemeRow">
            <span className="aoSwitchThemeKey">Current Mode</span>
            <span className="aoSwitchThemeVal">{switchboardModeLabel}</span>
            <span className="aoSwitchThemeSep">|</span>
            <span className="aoSwitchThemeKey">Model Provider</span>
            <span className="aoSwitchThemeVal">
              {switchboardModelProviderLabel}
            </span>
          </div>
          <div className="aoSwitchThemeRow">
            <span className="aoSwitchThemeKey">Target Dirs</span>
            <span className="aoSwitchThemeVal aoSwitchMetaDirs">
              {switchboardTargetDirsLabel}
            </span>
          </div>
        </div>
      </div>

      <div className="aoSwitchboardBlock">
        <div className="aoSwitchboardSectionHead">
          <div className="aoMiniLabel">Quick Switch</div>
        </div>
        <div className="aoSwitchQuickGrid">
          <button
            className={`aoSwitchQuickBtn${providerSwitchStatus?.mode === "gateway" ? " is-active" : ""}`}
            disabled={providerSwitchBusy}
            onClick={() => {
              void setProviderSwitchTarget("gateway");
            }}
          >
            <span className="aoSwitchQuickTitle">Gateway</span>
            <span className="aoSwitchQuickSub">Use local API Router</span>
          </button>
          <button
            className={`aoSwitchQuickBtn${providerSwitchStatus?.mode === "official" ? " is-active" : ""}`}
            disabled={providerSwitchBusy}
            onClick={() => {
              void setProviderSwitchTarget("official");
            }}
          >
            <span className="aoSwitchQuickTitle">Official</span>
            <span className="aoSwitchQuickSub">Use official Codex auth</span>
          </button>
          <button
            className={`aoSwitchQuickBtn aoSwitchQuickBtnHint${providerSwitchStatus?.mode === "provider" ? " is-active" : ""}`}
            disabled
          >
            <span className="aoSwitchQuickTitle">Direct Providers</span>
            <span className="aoSwitchQuickSub">
              {providerSwitchStatus?.mode === "provider" &&
              providerSwitchStatus.model_provider
                ? `Active: ${providerSwitchStatus.model_provider}`
                : "Pick provider below"}
            </span>
          </button>
        </div>
        <div className="aoSwitchSubOptions">
          <div className="aoSwitchboardSectionHead">
            <div className="aoMiniLabel">Switch Options</div>
            <button
              type="button"
              className="aoTinyBtn"
              onClick={() => setCodexSwapModalOpen(true)}
            >
              Configure Dirs
            </button>
          </div>
          <div className="aoHint">Shared with Dashboard Swap settings.</div>
        </div>
      </div>

      <div className="aoSwitchboardBlock">
        <div className="aoSwitchboardSectionHead">
          <div className="aoMiniLabel">Direct Providers</div>
          <div className="aoHint">
            Includes remaining quota and progress view.
          </div>
        </div>
        <div className="aoSwitchProviderGrid">
          {switchboardProviderCards.length ? (
            switchboardProviderCards.map((providerItem) => (
              <button
                key={providerItem.name}
                className={`aoSwitchProviderBtn${providerSwitchStatus?.mode === "provider" && providerSwitchStatus?.model_provider === providerItem.name ? " is-active" : ""}`}
                disabled={providerSwitchBusy || !providerItem.hasKey}
                onClick={() => {
                  void setProviderSwitchTarget("provider", providerItem.name);
                }}
              >
                <span className="aoSwitchProviderHead">
                  <span>{providerItem.name}</span>
                  <span
                    className={`aoSwitchProviderKey${providerItem.hasKey ? " is-ready" : " is-missing"}`}
                  >
                    {providerItem.hasKey ? "key ready" : "missing key"}
                  </span>
                </span>
                <span className="aoSwitchProviderBase">
                  {providerItem.baseUrl || "base_url missing"}
                </span>
                <span className="aoSwitchProviderUsageBody">
                  <span className="aoSwitchProviderUsageHeadline">
                    {providerItem.usageHeadline}
                  </span>
                  <span className="aoSwitchProviderUsageDetail">
                    {providerItem.usageDetail}
                  </span>
                  {providerItem.usageSub ? (
                    <span className="aoSwitchProviderUsageSub">
                      {providerItem.usageSub}
                    </span>
                  ) : (
                    <span className="aoSwitchProviderUsageSub aoSwitchProviderUsageSubMuted">
                      No extra usage info
                    </span>
                  )}
                </span>
                <span className="aoSwitchProviderProgress">
                  <span
                    className={`aoSwitchProviderProgressFill${providerItem.usagePct == null ? " is-empty" : ""}`}
                    style={
                      providerItem.usagePct == null
                        ? undefined
                        : {
                            width: `${Math.max(4, Math.min(100, providerItem.usagePct))}%`,
                          }
                    }
                  />
                </span>
              </button>
            ))
          ) : (
            <span className="aoHint">No configured providers.</span>
          )}
        </div>
      </div>
    </>
  );
}
