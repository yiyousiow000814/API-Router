import { useEffect, useMemo, useState } from 'react'
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

function orderedProviders(config: Config, ordered: string[]): string[] {
  const names = Object.keys(config.providers ?? {})
  const fromOrder = ordered.filter((name) => names.includes(name))
  const leftovers = names.filter((name) => !fromOrder.includes(name))
  return [...fromOrder, ...leftovers]
}

function formatProviderCount(count: number): string {
  return `${count} ${count === 1 ? 'provider' : 'providers'}`
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
  const [selectedProviders, setSelectedProviders] = useState<string[]>([])
  const [selectedGroupMembers, setSelectedGroupMembers] = useState<Record<string, string[]>>({})
  const [groupUsageBaseDrafts, setGroupUsageBaseDrafts] = useState<Record<string, string>>({})
  const [groupDraft, setGroupDraft] = useState('')

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
  const groupEntries = useMemo(
    () => [...groups.entries()].map(([name, members]) => ({ name, members })),
    [groups],
  )
  const ungroupedProviders = useMemo(
    () => providerNames.filter((provider) => !(config?.providers?.[provider]?.group ?? '').trim()),
    [config, providerNames],
  )

  useEffect(() => {
    if (!open || !config) return
    if (focusProvider && providerNames.includes(focusProvider)) {
      const focusGroup = (config.providers?.[focusProvider]?.group ?? '').trim()
      if (focusGroup) {
        setSelectedProviders([])
        setGroupDraft(focusGroup)
        setSelectedGroupMembers({ [focusGroup]: [focusProvider] })
      } else {
        setSelectedProviders([focusProvider])
        setGroupDraft('')
        setSelectedGroupMembers({})
      }
    } else {
      setSelectedProviders([])
      setGroupDraft('')
      setSelectedGroupMembers({})
    }
  }, [config, focusProvider, open, providerNames])

  useEffect(() => {
    if (!config) return
    setSelectedProviders((prev) =>
      prev.filter((provider) => !(config.providers?.[provider]?.group ?? '').trim()),
    )
  }, [config])

  useEffect(() => {
    if (!config) return
    setSelectedGroupMembers((prev) => {
      const next: Record<string, string[]> = {}
      for (const [groupName, members] of Object.entries(prev)) {
        const currentMembers = new Set(groups.get(groupName) ?? [])
        const kept = members.filter((member) => currentMembers.has(member))
        if (kept.length) {
          next[groupName] = kept
        }
      }
      return next
    })
  }, [config, groups])

  useEffect(() => {
    if (!open || !config) return
    setGroupUsageBaseDrafts(() => {
      const next: Record<string, string> = {}
      groupEntries.forEach(({ name, members }) => {
        const representative = members[0] ?? ''
        const representativeUsageBase = (config.providers?.[representative]?.usage_base_url ?? '').trim()
        const inferredUsageBase = inferGroupUsageBase(config, members) ?? ''
        next[name] = representativeUsageBase || inferredUsageBase
      })
      return next
    })
  }, [config, groupEntries, open])

  if (!open || !config) return null

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
              <div className="aoGroupManagerAssignRow">
                <input
                  className="aoInput"
                  placeholder="Group name"
                  value={groupDraft}
                  onChange={(event) => setGroupDraft(event.target.value)}
                />
                <button
                  className="aoBtn aoBtnPrimary"
                  disabled={selectedProviders.length === 0 || groupDraft.trim().length === 0}
                  onClick={async () => {
                    await onAssignGroup(selectedProviders, groupDraft.trim() || null)
                    setSelectedProviders([])
                    setGroupDraft('')
                  }}
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
                  const groupRepresentative = members[0] ?? ''
                  const representativeProvider = groupRepresentative ? config.providers?.[groupRepresentative] : undefined
                  const representativeHardCap = representativeProvider?.quota_hard_cap ?? {
                    daily: true,
                    weekly: true,
                    monthly: true,
                  }
                  const normalizedUsageBases = new Set(
                    members.map((provider) => (config.providers?.[provider]?.usage_base_url ?? '').trim()),
                  )
                  const hasMixedUsageBase = normalizedUsageBases.size > 1
                  const selectedMembers = selectedGroupMembers[name] ?? []
                  const usageBaseDraft = groupUsageBaseDrafts[name] ?? ''
                  const showUsageBaseWarning =
                    members.length > 1 && (hasMixedUsageBase || usageBaseDraft.trim().length === 0)
                  return (
                    <div key={`group-card-${name}`} className="aoGroupManagerGroupCard">
                      <div className="aoGroupManagerGroupHead">
                        <div className="aoProviderGroupTag">{name}</div>
                        <div className="aoHint">{formatProviderCount(members.length)}</div>
                      </div>

                      <div className="aoGroupManagerProviderList">
                        {members.map((provider) => {
                          const checked = selectedMembers.includes(provider)
                          return (
                            <label key={`group-member-row-${name}-${provider}`} className="aoGroupManagerProviderRow">
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={(event) =>
                                  setSelectedGroupMembers((prev) => {
                                    const current = prev[name] ?? []
                                    const next = event.target.checked
                                      ? [...new Set([...current, provider])]
                                      : current.filter((item) => item !== provider)
                                    return { ...prev, [name]: next }
                                  })
                                }
                              />
                              <span className="aoProviderName">{provider}</span>
                            </label>
                          )
                        })}
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
                          disabled={!groupRepresentative}
                          onClick={() => {
                            setGroupUsageBaseDrafts((prev) => ({ ...prev, [name]: '' }))
                            void onClearUsageBase(groupRepresentative)
                          }}
                        >
                          Clear
                        </button>
                        <button
                          className="aoBtn aoBtnPrimary"
                          disabled={!groupRepresentative}
                          onClick={() => void onSetUsageBase(groupRepresentative, usageBaseDraft)}
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
                                checked={Boolean(representativeHardCap[period])}
                                onChange={(event) =>
                                  void onSetHardCap(groupRepresentative, period, event.target.checked)
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
                          className="aoBtn"
                          disabled={selectedMembers.length === 0}
                          onClick={async () => {
                            await onAssignGroup(selectedMembers, null)
                            setSelectedGroupMembers((prev) => ({ ...prev, [name]: [] }))
                          }}
                        >
                          Kick Selected
                        </button>
                        <button
                          className="aoBtn"
                          disabled={members.length === 0}
                          onClick={async () => {
                            await onAssignGroup(members, null)
                            setSelectedGroupMembers((prev) => ({ ...prev, [name]: [] }))
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
