import { useEffect, useMemo, useState } from 'react'
import type { Config } from '../types'
import { ModalBackdrop } from './ModalBackdrop'
import type { QuotaHardCapField } from '../hooks/providerActions/useProviderUsageActions'

type Props = {
  open: boolean
  config: Config | null
  orderedConfigProviders: string[]
  focusProvider?: string | null
  onClose: () => void
  onAssignGroup: (providers: string[], group: string | null) => Promise<void>
  onOpenUsageBase: (provider: string, current: string | null | undefined) => Promise<void>
  onClearUsageBase: (provider: string) => Promise<void>
  onSetHardCap: (provider: string, field: QuotaHardCapField, enabled: boolean) => Promise<void>
}

function orderedProviders(config: Config, ordered: string[]): string[] {
  const names = Object.keys(config.providers ?? {})
  const fromOrder = ordered.filter((name) => names.includes(name))
  const leftovers = names.filter((name) => !fromOrder.includes(name))
  return [...fromOrder, ...leftovers]
}

export function ProviderGroupManagerModal({
  open,
  config,
  orderedConfigProviders,
  focusProvider,
  onClose,
  onAssignGroup,
  onOpenUsageBase,
  onClearUsageBase,
  onSetHardCap,
}: Props) {
  const [selectedProviders, setSelectedProviders] = useState<string[]>([])
  const [groupDraft, setGroupDraft] = useState('')
  const [activeGroup, setActiveGroup] = useState('')

  const providerNames = useMemo(
    () => (config ? orderedProviders(config, orderedConfigProviders) : []),
    [config, orderedConfigProviders],
  )
  const groups = useMemo(() => {
    if (!config) return new Map<string, string[]>()
    const grouped = new Map<string, string[]>()
    for (const provider of providerNames) {
      const group = (config.providers?.[provider]?.group ?? '').trim()
      if (!group) continue
      const members = grouped.get(group) ?? []
      members.push(provider)
      grouped.set(group, members)
    }
    return grouped
  }, [config, providerNames])
  const groupOptions = useMemo(() => [...groups.keys()].sort((a, b) => a.localeCompare(b)), [groups])
  const activeGroupMembers = useMemo(() => groups.get(activeGroup) ?? [], [activeGroup, groups])
  const groupRepresentative = activeGroupMembers[0] ?? ''
  const representativeProvider = groupRepresentative ? config?.providers?.[groupRepresentative] : undefined
  const representativeUsageBase = representativeProvider?.usage_base_url ?? null
  const representativeHardCap = representativeProvider?.quota_hard_cap ?? { daily: true, weekly: true, monthly: true }

  useEffect(() => {
    if (!open || !config) return
    if (focusProvider && providerNames.includes(focusProvider)) {
      setSelectedProviders([focusProvider])
      const nextGroup = (config.providers?.[focusProvider]?.group ?? '').trim()
      setGroupDraft(nextGroup)
      setActiveGroup(nextGroup)
      return
    }
    setSelectedProviders([])
    setGroupDraft('')
    setActiveGroup((prev) => (prev && groupOptions.includes(prev) ? prev : groupOptions[0] ?? ''))
  }, [config, focusProvider, groupOptions, open, providerNames])

  useEffect(() => {
    if (!config) return
    setSelectedProviders((prev) =>
      prev.filter((provider) => !(config.providers?.[provider]?.group ?? '').trim()),
    )
  }, [config])

  if (!open || !config) return null

  return (
    <ModalBackdrop onClose={onClose}>
      <div className="aoModal aoModalWide" onClick={(event) => event.stopPropagation()}>
        <div className="aoModalHeader">
          <div className="aoModalTitle">Group Manager</div>
          <button className="aoBtn" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="aoModalBody">
          <div className="aoGroupManagerLayout">
            <div className="aoCard aoGroupManagerCard">
              <div className="aoMiniTitle">Assign Providers</div>
              <div className="aoHint">Select providers, then assign one group name in batch.</div>
              <div className="aoGroupManagerAssignRow">
                <input
                  className="aoInput"
                  list="ao-group-options"
                  placeholder="Group name"
                  value={groupDraft}
                  onChange={(event) => setGroupDraft(event.target.value)}
                />
                <datalist id="ao-group-options">
                  {groupOptions.map((group) => (
                    <option key={`group-option-${group}`} value={group} />
                  ))}
                </datalist>
                <button
                  className="aoBtn aoBtnPrimary"
                  disabled={selectedProviders.length === 0 || groupDraft.trim().length === 0}
                  onClick={() => void onAssignGroup(selectedProviders, groupDraft.trim() || null)}
                >
                  Apply
                </button>
                <button
                  className="aoBtn"
                  disabled={selectedProviders.length === 0}
                  onClick={() => setSelectedProviders([])}
                >
                  Reset
                </button>
              </div>
              <div className="aoGroupManagerProviderList">
                {providerNames.map((provider) => {
                  const selected = selectedProviders.includes(provider)
                  const currentGroup = (config.providers?.[provider]?.group ?? '').trim()
                  const grouped = Boolean(currentGroup)
                  return (
                    <label
                      key={`provider-group-row-${provider}`}
                      className={`aoGroupManagerProviderRow${grouped ? ' aoGroupManagerProviderRowDisabled' : ''}`}
                    >
                      <input
                        type="checkbox"
                        checked={selected}
                        disabled={grouped}
                        onChange={(event) =>
                          setSelectedProviders((prev) => {
                            if (event.target.checked) return [...new Set([...prev, provider])]
                            return prev.filter((name) => name !== provider)
                          })
                        }
                      />
                      <span className="aoProviderName">{provider}</span>
                      <span className="aoHint">{currentGroup || '-'}</span>
                    </label>
                  )
                })}
              </div>
            </div>

            <div className="aoCard aoGroupManagerCard">
              <div className="aoMiniTitle">Group Usage Controls</div>
              <div className="aoGroupManagerAssignRow">
                <select
                  className="aoInput"
                  value={activeGroup}
                  onChange={(event) => setActiveGroup(event.target.value)}
                >
                  <option value="">Select group</option>
                  {groupOptions.map((group) => (
                    <option key={`group-select-${group}`} value={group}>
                      {group}
                    </option>
                  ))}
                </select>
                <button
                  className="aoBtn"
                  disabled={activeGroupMembers.length === 0}
                  onClick={() => setSelectedProviders(activeGroupMembers)}
                >
                  Select Members
                </button>
                <button
                  className="aoBtn"
                  disabled={activeGroupMembers.length === 0}
                  onClick={async () => {
                    await onAssignGroup(activeGroupMembers, null)
                    setActiveGroup('')
                  }}
                >
                  Close Group
                </button>
              </div>

              {activeGroupMembers.length > 0 ? (
                <>
                  <div className="aoHint">Members: {activeGroupMembers.join(' / ')}</div>
                  <div className="aoUsageBtns">
                    <button
                      className="aoTinyBtn"
                      onClick={() => void onOpenUsageBase(groupRepresentative, representativeUsageBase)}
                    >
                      Usage Base
                    </button>
                    <button className="aoTinyBtn" onClick={() => void onClearUsageBase(groupRepresentative)}>
                      Clear
                    </button>
                  </div>
                  <div className="aoUsageHardCapGrid">
                    {(['daily', 'weekly', 'monthly'] as QuotaHardCapField[]).map((period) => (
                      <label key={`group-hard-cap-${period}`} className="aoUsageHardCapItem">
                        <input
                          type="checkbox"
                          checked={Boolean(representativeHardCap[period])}
                          onChange={(event) =>
                            void onSetHardCap(groupRepresentative, period, event.target.checked)
                          }
                        />
                        <span>{period} hard cap</span>
                      </label>
                    ))}
                  </div>
                </>
              ) : (
                <div className="aoHint">Select a group to manage usage base and hard cap in one place.</div>
              )}
            </div>
          </div>
        </div>
      </div>
    </ModalBackdrop>
  )
}
