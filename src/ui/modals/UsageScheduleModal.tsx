import type { AppViewModel } from "../app/useAppViewModel";
import { ModalBackdrop } from "../components/ModalBackdrop";

type UsageScheduleModalProps = {
  vm: AppViewModel;
};

export function UsageScheduleModal({ vm }: UsageScheduleModalProps) {
  const {
    usageScheduleModalOpen,
    setUsageScheduleModalOpen,
    usageScheduleProvider,
    setUsageScheduleProvider,
    usageScheduleRows,
    usageScheduleLoading,
    usageScheduleSaveStatusText,
    usageScheduleProviderOptions,
    addUsageScheduleRow,
    updateUsageScheduleRow,
    deleteUsageScheduleRow,
    saveUsageScheduleRows,
  } = vm;

  if (!usageScheduleModalOpen) return null;

  return (
    <ModalBackdrop
      className="aoModalBackdrop aoModalBackdropTop"
      onClose={() => setUsageScheduleModalOpen(false)}
    >
      <div
        className="aoModal aoModalWide aoUsageScheduleModal"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="aoModalHeader">
          <div>
            <div className="aoModalTitle">Pricing Timeline</div>
            <div className="aoModalSub">
              Define historical pricing periods used in estimate fallback.
            </div>
          </div>
          <button
            className="aoBtn"
            onClick={() => setUsageScheduleModalOpen(false)}
          >
            Close
          </button>
        </div>

        <div className="aoModalBody">
          <div className="aoRow" style={{ marginBottom: 10, gap: 10 }}>
            <span className="aoMiniLabel">Provider</span>
            <select
              className="aoSelect"
              value={usageScheduleProvider}
              onChange={(event) => {
                const providerName = event.target.value;
                setUsageScheduleProvider(providerName);
              }}
            >
              {usageScheduleProviderOptions.map((providerName) => (
                <option key={providerName} value={providerName}>
                  {providerName}
                </option>
              ))}
            </select>
            <button className="aoTinyBtn" onClick={addUsageScheduleRow}>
              Add Row
            </button>
            <button
              className="aoTinyBtn"
              onClick={() => {
                void saveUsageScheduleRows();
              }}
            >
              Save All
            </button>
            <span className="aoHint">{usageScheduleSaveStatusText}</span>
          </div>

          {usageScheduleLoading ? (
            <div className="aoHint">Loading...</div>
          ) : usageScheduleRows.length ? (
            <table className="aoUsageScheduleTable">
              <thead>
                <tr>
                  <th>Provider</th>
                  <th>Mode</th>
                  <th>Start</th>
                  <th>End</th>
                  <th>Amount (USD)</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {usageScheduleRows.map((row, index) => (
                  <tr key={`${row.provider}-${row.id}-${index}`}>
                    <td>{row.provider}</td>
                    <td>
                      <select
                        className="aoSelect"
                        value={row.mode}
                        onChange={(event) => {
                          updateUsageScheduleRow(index, {
                            mode: (event.target.value || "package_total") as
                              | "per_request"
                              | "package_total",
                          });
                        }}
                      >
                        <option value="per_request">Per Request</option>
                        <option value="package_total">Package Total</option>
                      </select>
                    </td>
                    <td>
                      <input
                        className="aoInput"
                        type="datetime-local"
                        value={row.startText}
                        onChange={(event) => {
                          updateUsageScheduleRow(index, {
                            startText: event.target.value,
                          });
                        }}
                      />
                    </td>
                    <td>
                      <input
                        className="aoInput"
                        type="datetime-local"
                        value={row.endText}
                        onChange={(event) => {
                          updateUsageScheduleRow(index, {
                            endText: event.target.value,
                          });
                        }}
                      />
                    </td>
                    <td>
                      <input
                        className="aoInput"
                        type="number"
                        min="0"
                        step="0.0001"
                        value={row.amountText}
                        onChange={(event) => {
                          updateUsageScheduleRow(index, {
                            amountText: event.target.value,
                          });
                        }}
                      />
                    </td>
                    <td>
                      <button
                        className="aoTinyBtn"
                        onClick={() => deleteUsageScheduleRow(index)}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="aoHint">No timeline rows yet.</div>
          )}
        </div>
      </div>
    </ModalBackdrop>
  );
}
