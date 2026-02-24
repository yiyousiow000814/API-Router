import { useEffect, useMemo, useRef, useState } from 'react'
import type { Config } from '../types'
import { ModalBackdrop } from './ModalBackdrop'
import type { QuotaHardCapField } from '../hooks/providerActions/useProviderUsageActions'
import { QUOTA_HARD_CAP_PERIODS } from '../utils/providerBudgetWindows'
import { inferGroupUsageBase } from '../utils/groupUsageBase'

type Props = {
  open: boolean
  config: Config | null
  orderedConfigProviders: string[]
  focusProvider?: string | null
  onClose: () => void
  onAssignGroup: (providers: string[], group: string | null) => Promise<void>
  onSetUsageBase: (provider: string, url: string) => Promise<void>
  onClearUsageBase: (provider: string) => Promise<void>
  onSetHardCap: (provider: string, field: QuotaHardCapField, enabled: boolean) => Promise<void>
}

function orderedProviders(config: Config, ordered: string[], includeDisabled = false): string[] {
  const names = Object.keys(config.providers ?? {}).filter((name) =>
    includeDisabled ? true : !config.providers?.[name]?.disabled,
  )
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
  onSetUsageBase,
  onClearUsageBase,
  onSetHardCap,
}: Props) {
  const openInitKeyRef = useRef<string | null>(null)
  const [assignMode, setAssignMode] = useState<'new' | 'add'>('new')
  const [selectedProviders, setSelectedProviders] = useState<string[]>([])
  const [editingGroupName, setEditingGroupName] = useState<string | null>(null)
  const [groupUsageBaseDrafts, setGroupUsageBaseDrafts] = useState<Record<string, string>>({})
  const [groupDraft, setGroupDraft] = useState('')
  const [targetExistingGroup, setTargetExistingGroup] = useState('')

  const providerNames = useMemo(
    () => (config ? orderedProviders(config, orderedConfigProviders) : []),
    [config, orderedConfigProviders],
  )
  const allProviderNames = useMemo(
    () => (config ? orderedProviders(config, orderedConfigProviders, true) : []),
    [config, orderedConfigProviders],
  )
  const groups = useMemo(() => {
    if (!config) return new Map<string, string[]>()
    const grouped = new Map<string, string[]>()
    for (const provider of allProviderNames) {
      const group = (config.providers?.[provider]?.group ?? '').trim()
      if (!group) continue
      const members = grouped.get(group) ?? []
      members.push(provider)
      grouped.set(group, members)
    }
    return grouped
  }, [allProviderNames, config])
  const groupEntries = useMemo(
    () => [...groups.entries()].map(([name, members]) => ({ name, members })),
    [groups],
  )
  const groupNames = useMemo(() => groupEntries.map((entry) => entry.name), [groupEntries])
  const ungroupedProviders = useMemo(
    () => providerNames.filter((provider) => !(config?.providers?.[provider]?.group ?? '').trim()),
    [config, providerNames],
  )

  useEffect(() => {
    if (!open || !config) {
      openInitKeyRef.current = null
      return
    }
    const initKey = focusProvider && providerNames.includes(focusProvider) ? `focus:${focusProvider}` : 'none'
    if (openInitKeyRef.current === initKey) return
    openInitKeyRef.current = initKey
    if (focusProvider && providerNames.includes(focusProvider)) {
      const focusGroup = (config.providers?.[focusProvider]?.group ?? '').trim()
      if (focusGroup) {
        setSelectedProviders([])
        setTargetExistingGroup(focusGroup)
        setGroupDraft('')
        setEditingGroupName(null)
      } else {
        setSelectedProviders([focusProvider])
        setTargetExistingGroup(groupNames[0] ?? '')
        setGroupDraft('')
        setEditingGroupName(null)
      }
    } else {
      setSelectedProviders([])
      setTargetExistingGroup(groupNames[0] ?? '')
      setGroupDraft('')
      setEditingGroupName(null)
    }
  }, [config, focusProvider, groupNames, open, providerNames])

  useEffect(() => {
    if (!config) return
    setSelectedProviders((prev) =>
      prev.filter((provider) => !(config.providers?.[provider]?.group ?? '').trim()),
    )
  }, [config])

  useEffect(() => {
    if (!open || !config) {
      setGroupUsageBaseDrafts((prev) => (Object.keys(prev).length > 0 ? {} : prev))
      return
    }
    setGroupUsageBaseDrafts((prev) => {
      const next: Record<string, string> = {}
      groupEntries.forEach(({ name, members }) => {
        const representative = members[0] ?? ''
        const representativeUsageBase = (config.providers?.[representative]?.usage_base_url ?? '').trim()
        const inferredUsageBase = inferGroupUsageBase(config, members) ?? ''
        if (Object.prototype.hasOwnProperty.call(prev, name)) {
          next[name] = prev[name]
        } else {
          next[name] = representativeUsageBase || inferredUsageBase
        }
      })
      const prevKeys = Object.keys(prev)
      const nextKeys = Object.keys(next)
      if (
        prevKeys.length === nextKeys.length &&
        nextKeys.every((name) => Object.prototype.hasOwnProperty.call(prev, name) && prev[name] === next[name])
      ) {
        return prev
      }
      return next
    })
  }, [config, groupEntries, open])

  useEffect(() => {
    if (groupNames.length === 0) {
      setTargetExistingGroup('')
      if (assignMode === 'add') setAssignMode('new')
      return
    }
    if (!targetExistingGroup || !groupNames.includes(targetExistingGroup)) {
      setTargetExistingGroup(groupNames[0] ?? '')
    }
  }, [assignMode, groupNames, targetExistingGroup])

  useEffect(() => {
    if (!editingGroupName) return
    if (!groupNames.includes(editingGroupName)) {
      setEditingGroupName(null)
    }
  }, [editingGroupName, groupNames])

  if (!open || !config) return null

  const selectedGroupName =
    assignMode === 'new' ? groupDraft.trim() : targetExistingGroup.trim()
  const canApplyAssign = selectedProviders.length > 0 && selectedGroupName.length > 0

  return (
    <ModalBackdrop onClose={onClose}>
      <div className="aoModal aoModalWide aoGroupManagerModal" onClick={(event) => event.stopPropagation()}>
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
              <div className="aoGroupManagerAssignMode" data-mode={assignMode}>
                <span className="aoGroupManagerAssignModeSlider" aria-hidden="true" />
                <button
                  className={`aoGroupManagerAssignModeBtn${assignMode === 'new' ? ' is-active' : ''}`}
                  onClick={() => setAssignMode('new')}
                >
                  New Group
                </button>
                <button
                  className={`aoGroupManagerAssignModeBtn${assignMode === 'add' ? ' is-active' : ''}`}
                  disabled={groupNames.length === 0}
                  onClick={() => setAssignMode('add')}
                >
                  Add to Group
                </button>
              </div>
              <div className="aoGroupManagerAssignRow">
                {assignMode === 'new' ? (
                  <input
                    className="aoInput"
                    placeholder="Group name"
                    value={groupDraft}
                    onChange={(event) => setGroupDraft(event.target.value)}
                  />
                ) : (
                  <select
                    className="aoSelect"
                    value={targetExistingGroup}
                    onChange={(event) => setTargetExistingGroup(event.target.value)}
                    disabled={groupNames.length === 0}
                  >
                    {groupNames.map((name) => (
                      <option key={`assign-group-option-${name}`} value={name}>
                        {name}
                      </option>
                    ))}
                  </select>
                )}
                <button
                  className="aoBtn aoBtnPrimary"
                  disabled={!canApplyAssign}
                  onClick={async () => {
                    try {
                      await onAssignGroup(selectedProviders, selectedGroupName || null)
                      setSelectedProviders([])
                      if (assignMode === 'new') setGroupDraft('')
                    } catch {
                      // Keep current selection/input so users can retry after fixing the error.
                    }
                  }}
                >
                  Apply
                </button>
              </div>
              <div className="aoGroupManagerProviderList">
                {ungroupedProviders.map((provider) => {
                  const selected = selectedProviders.includes(provider)
                  return (
                    <label key={`provider-group-row-${provider}`} className="aoGroupManagerProviderRow">
                      <input
                        type="checkbox"
                        checked={selected}
                        onChange={(event) =>
                          setSelectedProviders((prev) => {
                            if (event.target.checked) return [...new Set([...prev, provider])]
                            return prev.filter((name) => name !== provider)
                          })
                        }
                      />
                      <span className="aoProviderName">{provider}</span>
                    </label>
                  )
                })}
                {ungroupedProviders.length === 0 ? <div className="aoHint">All providers are already assigned to groups.</div> : null}
              </div>
            </div>

            <div className="aoCard aoGroupManagerCard">
              <div className="aoMiniTitle">Group Usage Controls</div>
              <div className="aoGroupManagerGroupList">
                {groupEntries.map(({ name, members }) => {
                  const visibleMembers = members.filter((provider) => !config.providers?.[provider]?.disabled)
                  const groupActionTarget = visibleMembers[0] ?? members[0] ?? ''
                  const groupHardCap = QUOTA_HARD_CAP_PERIODS.reduce(
                    (acc, period) => {
                      acc[period] = members.every(
                        (provider) => config.providers?.[provider]?.quota_hard_cap?.[period] ?? true,
                      )
                      return acc
                    },
                    {} as Record<QuotaHardCapField, boolean>,
                  )
                  const groupHardCapMixed = QUOTA_HARD_CAP_PERIODS.reduce(
                    (acc, period) => {
                      const enabledCount = members.reduce(
                        (count, provider) =>
                          count + ((config.providers?.[provider]?.quota_hard_cap?.[period] ?? true) ? 1 : 0),
                        0,
                      )
                      acc[period] = enabledCount > 0 && enabledCount < members.length
                      return acc
                    },
                    {} as Record<QuotaHardCapField, boolean>,
                  )
                  const normalizedUsageBases = new Set(
                    members.map((provider) => (config.providers?.[provider]?.usage_base_url ?? '').trim()),
                  )
                  const hasMixedUsageBase = normalizedUsageBases.size > 1
                  const isEditingThisGroup = editingGroupName === name
                  const usageBaseDraft = groupUsageBaseDrafts[name] ?? ''
                  const showUsageBaseWarning =
                    members.length > 1 && (hasMixedUsageBase || usageBaseDraft.trim().length === 0)
                  return (
                    <div key={`group-card-${name}`} className="aoGroupManagerGroupCard">
                      <div className="aoGroupManagerGroupHead">
                        <div className="aoProviderGroupTag">{name}</div>
                        <button
                          className="aoGroupManagerEditLink"
                          onClick={() => setEditingGroupName((prev) => (prev === name ? null : name))}
                        >
                          {isEditingThisGroup ? 'Done' : 'Edit'}
                        </button>
                      </div>

                      <div className="aoGroupManagerProviderList">
                        {visibleMembers.map((provider) => {
                          return (
                            <div key={`group-member-row-${name}-${provider}`} className="aoGroupManagerMemberRow">
                              <span className="aoProviderName">{provider}</span>
                              {isEditingThisGroup ? (
                                <button
                                  className="aoGroupManagerMemberRemove"
                                  title={`Remove ${provider} from group`}
                                  aria-label={`Remove ${provider} from group`}
                                  onClick={() => void onAssignGroup([provider], null).catch(() => undefined)}
                                >
                                  ×
                                </button>
                              ) : null}
                            </div>
                          )
                        })}
                        {visibleMembers.length === 0 ? (
                          <div className="aoHint">All providers in this group are disabled.</div>
                        ) : null}
                      </div>

                      <div className="aoGroupUsageBaseRow">
                        <input
                          className="aoInput aoGroupUsageBaseInput"
                          placeholder="Usage base URL"
                          value={usageBaseDraft}
                          onChange={(event) =>
                            setGroupUsageBaseDrafts((prev) => ({ ...prev, [name]: event.target.value }))
                          }
                        />
                        <button
                          className="aoBtn"
                          disabled={!groupActionTarget}
                          onClick={() => {
                            setGroupUsageBaseDrafts((prev) => ({ ...prev, [name]: '' }))
                            void onClearUsageBase(groupActionTarget)
                          }}
                        >
                          Clear
                        </button>
                        <button
                          className="aoBtn aoBtnPrimary"
                          disabled={!groupActionTarget}
                          onClick={() => void onSetUsageBase(groupActionTarget, usageBaseDraft)}
                        >
                          Save
                        </button>
                      </div>

                      <div className="aoUsageTop">
                        <div className="aoUsageHardCapInline">
                          {QUOTA_HARD_CAP_PERIODS.map((period) => (
                            <label key={`group-hard-cap-${name}-${period}`} className="aoUsageHardCapItem">
                              <input
                                type="checkbox"
                                checked={Boolean(groupHardCap[period])}
                                disabled={!groupActionTarget}
                                ref={(input) => {
                                  if (!input) return
                                  input.indeterminate = groupHardCapMixed[period]
                                }}
                                onChange={(event) =>
                                  void onSetHardCap(groupActionTarget, period, event.target.checked)
                                }
                              />
                              <span>{period} hard cap</span>
                            </label>
                          ))}
                        </div>
                      </div>
                      {showUsageBaseWarning ? (
                        <div className="aoHint aoHintWarning">
                          Warning: Group members should share the same usage base URL (usage fetch endpoint, not provider base URL).
                        </div>
                      ) : null}

                      <div className="aoGroupManagerGroupActions">
                        <button
                          className="aoBtn aoBtnDangerSoft"
                          disabled={members.length === 0}
                          onClick={async () => {
                            try {
                              await onAssignGroup(members, null)
                              if (editingGroupName === name) {
                                setEditingGroupName(null)
                              }
                            } catch {
                              // Keep editing state unchanged on failure.
                            }
                          }}
                        >
                          Close Group
                        </button>
                      </div>
                    </div>
                  )
                })}
                {groupEntries.length === 0 ? <div className="aoHint">No groups yet. Assign providers on the left.</div> : null}
              </div>
            </div>
          </div>
        </div>
      </div>
    </ModalBackdrop>
  )
}
