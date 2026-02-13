import type { Dispatch, SetStateAction } from 'react'
import type { Config } from '../types'
import type { UsagePricingDraft, UsagePricingGroup, UsagePricingMode, UsagePricingSaveState } from '../types/usage'

export type UsagePricingCurrencyMenuState = {
  provider: string
  providers: string[]
  left: number
  top: number
  width: number
} | null

type Props = {
  group: UsagePricingGroup
  providerName: string
  providerCfg?: Config['providers'][string]
  draft: UsagePricingDraft
  groupState: UsagePricingSaveState
  setUsagePricingDrafts: Dispatch<SetStateAction<Record<string, UsagePricingDraft>>>
  queueUsagePricingAutoSaveForProviders: (providerNames: string[], draft: UsagePricingDraft) => void
  clearAutoSaveTimer: (key: string) => void
  setUsagePricingSaveStateForProviders: (providerNames: string[], state: UsagePricingSaveState) => void
  saveUsagePricingForProviders: (
    providerNames: string[],
    draft: UsagePricingDraft,
    options?: { silent?: boolean; skipPackageActivation?: boolean },
  ) => Promise<boolean>
  openUsageScheduleModal: (
    providerName: string,
    seedCurrency?: string,
    options?: { keepVisible?: boolean },
  ) => Promise<void>
  providerPreferredCurrency: (providerName: string) => string
  pricingDraftSignature: (draft: UsagePricingDraft) => string
  onMarkPricingSaved: (providerNames: string[], signature: string) => void
  usagePricingCurrencyMenu: UsagePricingCurrencyMenuState
  setUsagePricingCurrencyMenu: Dispatch<SetStateAction<UsagePricingCurrencyMenuState>>
  setUsagePricingCurrencyQuery: (value: string) => void
  normalizeCurrencyCode: (code: string) => string
  currencyLabel: (code: string) => string
}

export function UsagePricingRow({
  group,
  providerName,
  providerCfg,
  draft,
  groupState,
  setUsagePricingDrafts,
  queueUsagePricingAutoSaveForProviders,
  clearAutoSaveTimer,
  setUsagePricingSaveStateForProviders,
  saveUsagePricingForProviders,
  openUsageScheduleModal,
  providerPreferredCurrency,
  pricingDraftSignature,
  onMarkPricingSaved,
  usagePricingCurrencyMenu,
  setUsagePricingCurrencyMenu,
  setUsagePricingCurrencyQuery,
  normalizeCurrencyCode,
  currencyLabel,
}: Props) {
  const mode = draft.mode
  const scheduleManaged = mode === 'package_total'
  const amountDisabled = !providerCfg || mode === 'none' || scheduleManaged

  return (
    <div className="aoUsagePricingRow">
      <div className="aoUsagePricingProviderWrap">
        <div className="aoUsagePricingProvider">{group.displayName}</div>
        <div className="aoHint aoUsagePricingKeyHint">key: {group.keyLabel}</div>
      </div>
      <select
        className="aoSelect aoUsagePricingSelect aoUsagePricingMode"
        value={mode}
        disabled={!providerCfg}
        onChange={(e) => {
          const nextMode = (e.target.value as UsagePricingMode) ?? 'none'
          const nextDraft: UsagePricingDraft = {
            ...draft,
            mode: nextMode,
            amountText: nextMode === 'none' ? '' : draft.amountText,
          }
          setUsagePricingDrafts((prev) => {
            const next = { ...prev }
            group.providers.forEach((name) => {
              next[name] = nextDraft
            })
            return next
          })
          if (nextMode !== 'package_total') {
            queueUsagePricingAutoSaveForProviders(group.providers, nextDraft)
          } else {
            clearAutoSaveTimer(`pricing:${group.id}`)
            setUsagePricingSaveStateForProviders(group.providers, 'saving')
            void (async () => {
              const activated = await saveUsagePricingForProviders(group.providers, nextDraft, { silent: true })
              if (!activated) {
                await openUsageScheduleModal(providerName, providerPreferredCurrency(providerName))
                setUsagePricingSaveStateForProviders(group.providers, 'error')
              } else {
                onMarkPricingSaved(group.providers, pricingDraftSignature(nextDraft))
                setUsagePricingSaveStateForProviders(group.providers, 'saved')
              }
            })()
          }
        }}
      >
        <option value="none">Monthly credit</option>
        <option value="package_total">Monthly fee</option>
        <option value="per_request">$ / request</option>
      </select>
      {scheduleManaged ? (
        <>
          <button
            className="aoTinyBtn aoUsagePricingScheduleInline"
            disabled={!providerCfg}
            onClick={() => void openUsageScheduleModal(providerName, providerPreferredCurrency(providerName))}
          >
            Schedule
          </button>
          <div className="aoUsagePricingSchedulePlaceholder" />
        </>
      ) : (
        <>
          <input
            className="aoInput aoUsagePricingInput aoUsagePricingAmount"
            type="number"
            step="0.001"
            min="0"
            disabled={amountDisabled}
            placeholder="Amount"
            value={draft.amountText}
            onChange={(e) => {
              const nextDraft: UsagePricingDraft = {
                ...draft,
                amountText: e.target.value,
              }
              setUsagePricingDrafts((prev) => {
                const next = { ...prev }
                group.providers.forEach((name) => {
                  next[name] = nextDraft
                })
                return next
              })
              queueUsagePricingAutoSaveForProviders(group.providers, nextDraft)
            }}
          />
          <div className="aoUsagePricingCurrencyWrap">
            <button
              type="button"
              className="aoSelect aoUsagePricingCurrencyBtn"
              disabled={!providerCfg || amountDisabled}
              aria-haspopup="listbox"
              aria-expanded={usagePricingCurrencyMenu?.provider === providerName}
              onClick={(e) => {
                const button = e.currentTarget
                const rect = button.getBoundingClientRect()
                setUsagePricingCurrencyMenu((prev) => {
                  if (prev?.provider === providerName) {
                    setUsagePricingCurrencyQuery('')
                    return null
                  }
                  setUsagePricingCurrencyQuery('')
                  return {
                    provider: providerName,
                    providers: group.providers,
                    left: Math.max(8, Math.round(rect.left)),
                    top: Math.round(rect.bottom + 4),
                    width: Math.round(rect.width),
                  }
                })
              }}
            >
              <span>{currencyLabel(normalizeCurrencyCode(draft.currency))}</span>
              <span className="aoUsagePricingCurrencyChevron" aria-hidden="true">
                ▼
              </span>
            </button>
          </div>
        </>
      )}
      <div className="aoUsagePricingActions">
        <span className={`aoHint aoUsagePricingAutosave aoUsagePricingAutosave-${groupState}`}>
          {groupState === 'saving'
            ? 'Auto-saving...'
            : groupState === 'saved'
              ? 'Auto-saved'
              : groupState === 'error'
                ? 'Auto-save failed'
                : 'Auto-save'}
        </span>
      </div>
    </div>
  )
}
