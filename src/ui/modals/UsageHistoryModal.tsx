import { invoke } from "@tauri-apps/api/core";
import { useMemo, useState } from "react";
import type { AppViewModel } from "../app/useAppViewModel";
import { ModalBackdrop } from "../components/ModalBackdrop";

type UsageHistoryModalProps = {
  vm: AppViewModel;
};

type RowDraft = {
  effectiveText: string;
  perReqText: string;
};

function fmtUsdMaybe(value?: number | null): string {
  if (value == null || !Number.isFinite(value)) return "-";
  if (Math.abs(value) >= 1000)
    return `$${value.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  if (Math.abs(value) >= 1) return `$${value.toFixed(2)}`;
  return `$${value.toFixed(4)}`;
}

function sourceText(value?: string | null): string {
  if (!value || value === "none") return "none";
  if (value === "manual_per_request" || value === "manual_total")
    return "manual";
  if (
    value === "tracked+manual_per_request" ||
    value === "tracked+manual_total"
  )
    return "tracked+manual";
  if (value === "scheduled_package_total") return "scheduled";
  return value;
}

export function UsageHistoryModal({ vm }: UsageHistoryModalProps) {
  const {
    usageHistoryModalOpen,
    setUsageHistoryModalOpen,
    usageHistoryRows,
    usageHistoryLoading,
    refreshUsageHistory,
    refreshUsageStatistics,
    clearUsageHistoryRow,
    flashToast,
  } = vm;

  const [drafts, setDrafts] = useState<Record<string, RowDraft>>({});
  const [saving, setSaving] = useState<Record<string, boolean>>({});

  const rows = useMemo(() => usageHistoryRows, [usageHistoryRows]);

  if (!usageHistoryModalOpen) return null;

  return (
    <ModalBackdrop
      className="aoModalBackdrop aoModalBackdropTop"
      onClose={() => setUsageHistoryModalOpen(false)}
    >
      <div
        className="aoModal aoModalWide aoUsageHistoryModal"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="aoModalHeader">
          <div>
            <div className="aoModalTitle">Daily History</div>
            <div className="aoModalSub">
              Edit per-day overrides when provider spend snapshots have gaps.
            </div>
          </div>
          <button
            className="aoBtn"
            onClick={() => setUsageHistoryModalOpen(false)}
          >
            Close
          </button>
        </div>

        <div className="aoModalBody">
          {usageHistoryLoading ? (
            <div className="aoHint">Loading...</div>
          ) : rows.length ? (
            <table className="aoUsageHistoryTable">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Provider</th>
                  <th>Req</th>
                  <th>Tokens</th>
                  <th>$ / req</th>
                  <th>Effective $</th>
                  <th>Source</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const key = `${row.provider}|${row.day_key}`;
                  const draft = drafts[key] ?? {
                    effectiveText:
                      row.effective_total_usd != null &&
                      Number.isFinite(row.effective_total_usd)
                        ? String(row.effective_total_usd)
                        : "",
                    perReqText:
                      row.effective_usd_per_req != null &&
                      Number.isFinite(row.effective_usd_per_req)
                        ? String(row.effective_usd_per_req)
                        : "",
                  };
                  const rowSaving = Boolean(saving[key]);

                  return (
                    <tr key={key}>
                      <td className="aoUsageHistoryDateCell">{row.day_key}</td>
                      <td className="aoUsageProviderName">{row.provider}</td>
                      <td>{(row.req_count ?? 0).toLocaleString()}</td>
                      <td>{(row.total_tokens ?? 0).toLocaleString()}</td>
                      <td>
                        <input
                          className="aoInput aoUsageHistoryInput"
                          type="number"
                          min="0"
                          step="0.0001"
                          value={draft.perReqText}
                          onChange={(event) => {
                            const value = event.target.value;
                            setDrafts((prev) => ({
                              ...prev,
                              [key]: {
                                ...draft,
                                perReqText: value,
                              },
                            }));
                          }}
                        />
                      </td>
                      <td>
                        <input
                          className="aoInput aoUsageHistoryInput"
                          type="number"
                          min="0"
                          step="0.001"
                          value={draft.effectiveText}
                          onChange={(event) => {
                            const value = event.target.value;
                            setDrafts((prev) => ({
                              ...prev,
                              [key]: {
                                ...draft,
                                effectiveText: value,
                              },
                            }));
                          }}
                        />
                      </td>
                      <td>{sourceText(row.source)}</td>
                      <td>
                        <div className="aoUsageHistoryActions">
                          <button
                            className="aoTinyBtn"
                            disabled={rowSaving}
                            onClick={() => {
                              void (async () => {
                                try {
                                  setSaving((prev) => ({
                                    ...prev,
                                    [key]: true,
                                  }));
                                  const effective = draft.effectiveText.trim();
                                  const perReq = draft.perReqText.trim();
                                  await invoke("set_spend_history_entry", {
                                    provider: row.provider,
                                    dayKey: row.day_key,
                                    totalUsedUsd: effective
                                      ? Number(effective)
                                      : null,
                                    usdPerReq: perReq ? Number(perReq) : null,
                                  });
                                  await refreshUsageHistory({ silent: true });
                                  await refreshUsageStatistics({
                                    silent: true,
                                  });
                                  flashToast(
                                    `Saved history: ${row.provider} ${row.day_key}`,
                                  );
                                } catch (error) {
                                  flashToast(String(error), "error");
                                } finally {
                                  setSaving((prev) => ({
                                    ...prev,
                                    [key]: false,
                                  }));
                                }
                              })();
                            }}
                          >
                            Save
                          </button>
                          <button
                            className="aoTinyBtn"
                            disabled={rowSaving}
                            onClick={() => {
                              void clearUsageHistoryRow(
                                row.provider,
                                row.day_key,
                              );
                            }}
                          >
                            Clear
                          </button>
                        </div>
                        <div className="aoHint">
                          current: {fmtUsdMaybe(row.effective_total_usd)} /{" "}
                          {fmtUsdMaybe(row.effective_usd_per_req)}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <div className="aoHint">No history yet.</div>
          )}
        </div>
      </div>
    </ModalBackdrop>
  );
}
