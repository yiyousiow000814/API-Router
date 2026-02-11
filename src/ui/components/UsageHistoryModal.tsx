import type { Dispatch, PointerEvent, ReactNode, RefObject, SetStateAction } from 'react'

import type { SpendHistoryRow } from '../types'
import { ModalBackdrop } from './ModalBackdrop'

type UsageHistoryDraft = {
  perReqText: string
  effectiveText: string
}

type SaveUsageHistoryRowOptions = {
  silent?: boolean
  keepEditCell?: boolean
  field?: 'per_req' | 'effective'
}

type Props = {
  open: boolean
  loading: boolean
  rows: SpendHistoryRow[]
  tableSurfaceRef: RefObject<HTMLDivElement | null>
  tableWrapRef: RefObject<HTMLDivElement | null>
  scrollbarOverlayRef: RefObject<HTMLDivElement | null>
  scrollbarThumbRef: RefObject<HTMLDivElement | null>
  renderColGroup: () => ReactNode
  onClose: () => void
  onBodyScroll: () => void
  onBodyWheel: () => void
  onBodyTouchMove: () => void
  drafts: Record<string, UsageHistoryDraft>
  editCell: string | null
  setEditCell: (next: string | null) => void
  setDrafts: Dispatch<SetStateAction<Record<string, UsageHistoryDraft>>>
  buildBaseDraft: (row: SpendHistoryRow) => UsageHistoryDraft
  perReqDisplay: (row: SpendHistoryRow) => number | null
  effectiveDisplay: (row: SpendHistoryRow) => number | null
  queueAutoSave: (row: SpendHistoryRow, field: 'per_req' | 'effective') => void
  clearAutoSaveTimer: (key: string) => void
  saveRow: (row: SpendHistoryRow, options?: SaveUsageHistoryRowOptions) => Promise<void>
  onClearRow: (row: SpendHistoryRow) => Promise<void>
  fmtUsdMaybe: (value: number | null | undefined) => string
  fmtHistorySource: (value: string | null | undefined) => string
  onScrollbarPointerDown: (event: PointerEvent<HTMLDivElement>) => void
  onScrollbarPointerMove: (event: PointerEvent<HTMLDivElement>) => void
  onScrollbarPointerUp: (event: PointerEvent<HTMLDivElement>) => void
  onScrollbarLostPointerCapture: (event: PointerEvent<HTMLDivElement>) => void
}

export function UsageHistoryModal({
  open,
  loading,
  rows,
  tableSurfaceRef,
  tableWrapRef,
  scrollbarOverlayRef,
  scrollbarThumbRef,
  renderColGroup,
  onClose,
  onBodyScroll,
  onBodyWheel,
  onBodyTouchMove,
  drafts,
  editCell,
  setEditCell,
  setDrafts,
  buildBaseDraft,
  perReqDisplay,
  effectiveDisplay,
  queueAutoSave,
  clearAutoSaveTimer,
  saveRow,
  onClearRow,
  fmtUsdMaybe,
  fmtHistorySource,
  onScrollbarPointerDown,
  onScrollbarPointerMove,
  onScrollbarPointerUp,
  onScrollbarLostPointerCapture,
}: Props) {
  if (!open) return null
  return (
    <ModalBackdrop className="aoModalBackdrop aoModalBackdropTop" onClose={onClose}>
      <div className="aoModal aoModalWide aoUsageHistoryModal" onClick={(e) => e.stopPropagation()}>
        <div className="aoModalHeader">
          <div>
            <div className="aoModalTitle">Daily History</div>
            <div className="aoModalSub">
              Edit per-day manual fixes. Use this when provider daily spend resets to zero and leaves cost gaps.
              Showing latest 180 days.
            </div>
          </div>
          <button className="aoBtn" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="aoModalBody">
          {loading && !rows.length ? (
            <div className="aoHint">Loading...</div>
          ) : rows.length ? (
            <div ref={tableSurfaceRef} className="aoUsageHistoryTableSurface">
              <div className="aoUsageHistoryTableHead" aria-hidden="true">
                <table className="aoUsageHistoryTable">
                  {renderColGroup()}
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Provider</th>
                      <th>API Key</th>
                      <th>Req</th>
                      <th>Tokens</th>
                      <th>$ / req</th>
                      <th>Effective $</th>
                      <th>Package $</th>
                      <th>Source</th>
                      <th>Action</th>
                    </tr>
                  </thead>
                </table>
              </div>
              <div className="aoUsageHistoryTableBody">
                <div
                  ref={tableWrapRef}
                  className="aoUsageHistoryTableWrap"
                  onScroll={onBodyScroll}
                  onWheel={onBodyWheel}
                  onTouchMove={onBodyTouchMove}
                >
                  <table className="aoUsageHistoryTable">
                    {renderColGroup()}
                    <tbody>
                      {rows.map((row) => {
                        const key = `${row.provider}|${row.day_key}`
                        const baseDraft = buildBaseDraft(row)
                        const draft = drafts[key] ?? baseDraft
                        const perReqValue = perReqDisplay(row)
                        const effectiveValue = effectiveDisplay(row)
                        const perReqEditing = editCell === `${key}|per_req`
                        const effectiveEditing = editCell === `${key}|effective`
                        return (
                          <tr key={key}>
                            <td className="aoUsageHistoryDateCell">{row.day_key}</td>
                            <td className="aoUsageProviderName">{row.provider}</td>
                            <td>{(row.api_key_ref ?? '-').trim() || '-'}</td>
                            <td>{(row.req_count ?? 0).toLocaleString()}</td>
                            <td>{(row.total_tokens ?? 0).toLocaleString()}</td>
                            <td>
                              <div className="aoUsageHistoryValueCell">
                                {perReqEditing ? (
                                  <input
                                    className="aoInput aoUsageHistoryInput"
                                    type="number"
                                    min="0"
                                    step="0.0001"
                                    placeholder="0"
                                    value={draft.perReqText}
                                    onChange={(e) => {
                                      setDrafts((prev) => ({
                                        ...prev,
                                        [key]: { ...draft, perReqText: e.target.value },
                                      }))
                                      queueAutoSave(row, 'per_req')
                                    }}
                                    onKeyDown={(e) => {
                                      if (e.key === 'Enter') {
                                        clearAutoSaveTimer('history:edit')
                                        setEditCell(null)
                                        void saveRow(row, { field: 'per_req' })
                                      } else if (e.key === 'Escape') {
                                        setDrafts((prev) => ({ ...prev, [key]: baseDraft }))
                                        setEditCell(null)
                                      }
                                    }}
                                    onBlur={() => {
                                      clearAutoSaveTimer('history:edit')
                                      setEditCell(null)
                                      void saveRow(row, { silent: true, keepEditCell: false, field: 'per_req' })
                                    }}
                                    autoFocus
                                  />
                                ) : (
                                  <span>{fmtUsdMaybe(perReqValue)}</span>
                                )}
                                {!perReqEditing ? (
                                  <button
                                    className="aoUsageHistoryEditBtn"
                                    title="Edit $/req"
                                    aria-label="Edit $/req"
                                    onClick={() => {
                                      setDrafts((prev) => ({ ...prev, [key]: draft }))
                                      setEditCell(`${key}|per_req`)
                                    }}
                                  >
                                    <svg viewBox="0 0 24 24" aria-hidden="true">
                                      <path d="M12 20h9" />
                                      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5Z" />
                                    </svg>
                                  </button>
                                ) : null}
                              </div>
                            </td>
                            <td>
                              <div className="aoUsageHistoryValueCell">
                                {effectiveEditing ? (
                                  <input
                                    className="aoInput aoUsageHistoryInput"
                                    type="number"
                                    min="0"
                                    step="0.001"
                                    placeholder="0"
                                    value={draft.effectiveText}
                                    onChange={(e) => {
                                      setDrafts((prev) => ({
                                        ...prev,
                                        [key]: { ...draft, effectiveText: e.target.value },
                                      }))
                                      queueAutoSave(row, 'effective')
                                    }}
                                    onKeyDown={(e) => {
                                      if (e.key === 'Enter') {
                                        clearAutoSaveTimer('history:edit')
                                        setEditCell(null)
                                        void saveRow(row, { field: 'effective' })
                                      } else if (e.key === 'Escape') {
                                        setDrafts((prev) => ({ ...prev, [key]: baseDraft }))
                                        setEditCell(null)
                                      }
                                    }}
                                    onBlur={() => {
                                      clearAutoSaveTimer('history:edit')
                                      setEditCell(null)
                                      void saveRow(row, { silent: true, keepEditCell: false, field: 'effective' })
                                    }}
                                    autoFocus
                                  />
                                ) : (
                                  <span>{fmtUsdMaybe(effectiveValue)}</span>
                                )}
                                {!effectiveEditing ? (
                                  <button
                                    className="aoUsageHistoryEditBtn"
                                    title="Edit effective"
                                    aria-label="Edit effective"
                                    onClick={() => {
                                      setDrafts((prev) => ({ ...prev, [key]: draft }))
                                      setEditCell(`${key}|effective`)
                                    }}
                                  >
                                    <svg viewBox="0 0 24 24" aria-hidden="true">
                                      <path d="M12 20h9" />
                                      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5Z" />
                                    </svg>
                                  </button>
                                ) : null}
                              </div>
                            </td>
                            <td>{fmtUsdMaybe(row.scheduled_package_total_usd ?? null)}</td>
                            <td>{fmtHistorySource(row.source)}</td>
                            <td>
                              <div className="aoUsageHistoryActions">
                                <button className="aoTinyBtn" onClick={() => void onClearRow(row)}>
                                  Clear
                                </button>
                              </div>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
                <div
                  ref={scrollbarOverlayRef}
                  className="aoUsageHistoryScrollbarOverlay"
                  aria-hidden="true"
                  onPointerDown={onScrollbarPointerDown}
                  onPointerMove={onScrollbarPointerMove}
                  onPointerUp={onScrollbarPointerUp}
                  onPointerCancel={onScrollbarPointerUp}
                  onLostPointerCapture={onScrollbarLostPointerCapture}
                >
                  <div ref={scrollbarThumbRef} className="aoUsageHistoryScrollbarThumb" />
                </div>
              </div>
            </div>
          ) : (
            <div className="aoHint">No history yet.</div>
          )}
        </div>
      </div>
    </ModalBackdrop>
  )
}
