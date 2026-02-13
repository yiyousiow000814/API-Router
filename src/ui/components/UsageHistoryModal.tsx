import type { Dispatch, PointerEvent as ReactPointerEvent, RefObject, SetStateAction } from 'react'
import type { SpendHistoryRow } from '../devMockData'
import type { UsageHistoryDraft } from '../types/usage'
import { ModalBackdrop } from './ModalBackdrop'
import { UsageHistoryEditableUsdCell } from './UsageHistoryEditableUsdCell'
import { UsageHistoryColGroup } from './UsageHistoryColGroup'
import { UsageHistoryModalHeader } from './UsageHistoryModalHeader'
import { UsageHistoryModalHint } from './UsageHistoryModalHint'
import { UsageHistoryRowActions } from './UsageHistoryRowActions'
import { UsageHistoryTableHeader } from './UsageHistoryTableHeader'
import './UsageHistoryModal.css'

type Props = {
  open: boolean
  onClose: () => void
  usageHistoryLoading: boolean
  usageHistoryRows: SpendHistoryRow[]
  usageHistoryDrafts: Record<string, UsageHistoryDraft>
  usageHistoryEditCell: string | null
  setUsageHistoryDrafts: Dispatch<SetStateAction<Record<string, UsageHistoryDraft>>>
  setUsageHistoryEditCell: Dispatch<SetStateAction<string | null>>
  historyDraftFromRow: (row: SpendHistoryRow) => UsageHistoryDraft
  historyPerReqDisplayValue: (row: SpendHistoryRow) => number | null
  historyEffectiveDisplayValue: (row: SpendHistoryRow) => number | null
  formatUsdMaybe: (value: number | null | undefined) => string
  formatHistorySource: (source?: string | null) => string
  queueUsageHistoryAutoSave: (row: SpendHistoryRow, field: 'effective' | 'per_req') => void
  clearAutoSaveTimer: (key: string) => void
  saveUsageHistoryRow: (
    row: SpendHistoryRow,
    options?: { silent?: boolean; keepEditCell?: boolean; field?: 'effective' | 'per_req' },
  ) => Promise<void>
  onClearRow: (row: SpendHistoryRow) => Promise<void>
  usageHistoryTableSurfaceRef: RefObject<HTMLDivElement | null>
  usageHistoryTableWrapRef: RefObject<HTMLDivElement | null>
  usageHistoryScrollbarOverlayRef: RefObject<HTMLDivElement | null>
  usageHistoryScrollbarThumbRef: RefObject<HTMLDivElement | null>
  scheduleUsageHistoryScrollbarSync: () => void
  activateUsageHistoryScrollbarUi: () => void
  onUsageHistoryScrollbarPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void
  onUsageHistoryScrollbarPointerMove: (e: ReactPointerEvent<HTMLDivElement>) => void
  onUsageHistoryScrollbarPointerUp: (e: ReactPointerEvent<HTMLDivElement>) => void
  onUsageHistoryScrollbarLostPointerCapture: () => void
}

export function UsageHistoryModal({
  open,
  onClose,
  usageHistoryLoading,
  usageHistoryRows,
  usageHistoryDrafts,
  usageHistoryEditCell,
  setUsageHistoryDrafts,
  setUsageHistoryEditCell,
  historyDraftFromRow,
  historyPerReqDisplayValue,
  historyEffectiveDisplayValue,
  formatUsdMaybe,
  formatHistorySource,
  queueUsageHistoryAutoSave,
  clearAutoSaveTimer,
  saveUsageHistoryRow,
  onClearRow,
  usageHistoryTableSurfaceRef,
  usageHistoryTableWrapRef,
  usageHistoryScrollbarOverlayRef,
  usageHistoryScrollbarThumbRef,
  scheduleUsageHistoryScrollbarSync,
  activateUsageHistoryScrollbarUi,
  onUsageHistoryScrollbarPointerDown,
  onUsageHistoryScrollbarPointerMove,
  onUsageHistoryScrollbarPointerUp,
  onUsageHistoryScrollbarLostPointerCapture,
}: Props) {
  if (!open) return null

  return (
    <ModalBackdrop className="aoModalBackdrop aoModalBackdropTop" onClose={onClose}>
      <div className="aoModal aoModalWide aoUsageHistoryModal" onClick={(e) => e.stopPropagation()}>
        <UsageHistoryModalHeader onClose={onClose} />
        <div className="aoModalBody">
          {usageHistoryLoading && !usageHistoryRows.length ? (
            <UsageHistoryModalHint loading />
          ) : usageHistoryRows.length ? (
            <div ref={usageHistoryTableSurfaceRef} className="aoUsageHistoryTableSurface">
              <UsageHistoryTableHeader />
              <div className="aoUsageHistoryTableBody">
                <div
                  ref={usageHistoryTableWrapRef}
                  className="aoUsageHistoryTableWrap"
                  onScroll={() => {
                    scheduleUsageHistoryScrollbarSync()
                    activateUsageHistoryScrollbarUi()
                  }}
                  onWheel={() => {
                    scheduleUsageHistoryScrollbarSync()
                    activateUsageHistoryScrollbarUi()
                  }}
                  onTouchMove={activateUsageHistoryScrollbarUi}
                >
                  <table className="aoUsageHistoryTable">
                    <UsageHistoryColGroup />
                    <tbody>
                      {usageHistoryRows.map((row) => {
                        const key = `${row.provider}|${row.day_key}`
                        const baseDraft = historyDraftFromRow(row)
                        const draft = usageHistoryDrafts[key] ?? baseDraft
                        const perReqDisplay = historyPerReqDisplayValue(row)
                        const effectiveDisplay = historyEffectiveDisplayValue(row)
                        const effectiveEditing = usageHistoryEditCell === `${key}|effective`
                        const perReqEditing = usageHistoryEditCell === `${key}|per_req`
                        return (
                          <tr key={key}>
                            <td className="aoUsageHistoryDateCell">{row.day_key}</td>
                            <td className="aoUsageProviderName">{row.provider}</td>
                            <td>{(row.api_key_ref ?? '-').trim() || '-'}</td>
                            <td>{(row.req_count ?? 0).toLocaleString()}</td>
                            <td>{(row.total_tokens ?? 0).toLocaleString()}</td>
                            <td>
                              <UsageHistoryEditableUsdCell
                                row={row}
                                keyId={key}
                                field="per_req"
                                draft={draft}
                                baseDraft={baseDraft}
                                isEditing={perReqEditing}
                                displayValue={perReqDisplay}
                                formatUsdMaybe={formatUsdMaybe}
                                setUsageHistoryDrafts={setUsageHistoryDrafts}
                                setUsageHistoryEditCell={setUsageHistoryEditCell}
                                queueUsageHistoryAutoSave={queueUsageHistoryAutoSave}
                                clearAutoSaveTimer={clearAutoSaveTimer}
                                saveUsageHistoryRow={saveUsageHistoryRow}
                              />
                            </td>
                            <td>
                              <UsageHistoryEditableUsdCell
                                row={row}
                                keyId={key}
                                field="effective"
                                draft={draft}
                                baseDraft={baseDraft}
                                isEditing={effectiveEditing}
                                displayValue={effectiveDisplay}
                                formatUsdMaybe={formatUsdMaybe}
                                setUsageHistoryDrafts={setUsageHistoryDrafts}
                                setUsageHistoryEditCell={setUsageHistoryEditCell}
                                queueUsageHistoryAutoSave={queueUsageHistoryAutoSave}
                                clearAutoSaveTimer={clearAutoSaveTimer}
                                saveUsageHistoryRow={saveUsageHistoryRow}
                              />
                            </td>
                            <td>{formatUsdMaybe(row.scheduled_package_total_usd ?? null)}</td>
                            <td>{formatHistorySource(row.source)}</td>
                            <td>
                              <UsageHistoryRowActions row={row} onClearRow={onClearRow} />
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
                <div
                  ref={usageHistoryScrollbarOverlayRef}
                  className="aoUsageHistoryScrollbarOverlay"
                  aria-hidden="true"
                  onPointerDown={onUsageHistoryScrollbarPointerDown}
                  onPointerMove={onUsageHistoryScrollbarPointerMove}
                  onPointerUp={onUsageHistoryScrollbarPointerUp}
                  onPointerCancel={onUsageHistoryScrollbarPointerUp}
                  onLostPointerCapture={onUsageHistoryScrollbarLostPointerCapture}
                >
                  <div ref={usageHistoryScrollbarThumbRef} className="aoUsageHistoryScrollbarThumb" />
                </div>
              </div>
            </div>
          ) : (
            <UsageHistoryModalHint loading={false} />
          )}
        </div>
      </div>
    </ModalBackdrop>
  )
}
