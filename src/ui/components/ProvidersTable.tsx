import { fmtAmount, fmtPct, fmtUsd, fmtWhen, pctOf } from '../utils/format'
import type { Config, Status, UsageStatistics, UsageStatisticsOverview } from '../types'
import { simulateQuotaForDisplay } from '../utils/quotaSimulation'

const mono = 'ui-monospace, "Cascadia Mono", "Consolas", monospace'

export type LastErrorJump = {
  provider: string
  unixMs: number
  message: string
  eventId?: string | null
}

export function findLastErrorEventId(
  events: Status['recent_events'],
  target: { provider: string; unixMs: number; message: string },
): string | null {
  const providerNeedle = target.provider.trim().toLowerCase()
  const messageNeedle = target.message.trim()
  const candidates = (events ?? []).filter((event) => event.provider.trim().toLowerCase() === providerNeedle && event.level === 'error')
  if (!candidates.length) return null
  const exactMessage = candidates.filter((event) => event.message.trim() === messageNeedle)
  const pool = exactMessage.length ? exactMessage : candidates
  const targetUnixMs = Number(target.unixMs) || 0
  const closest = [...pool].sort((a, b) => Math.abs(a.unix_ms - targetUnixMs) - Math.abs(b.unix_ms - targetUnixMs))[0]
  return closest?.id ?? null
}

type Props = {
  providers: string[]
  status: Status
  config?: Config | null
  usageStatistics?: UsageStatistics | UsageStatisticsOverview | null
  refreshingProviders: Record<string, boolean>
  onRefreshQuota: (provider: string) => void
  onOpenLastErrorInEventLog: (payload: LastErrorJump) => void
}

export function ProvidersTable({
  providers,
  status,
  config = null,
  usageStatistics = null,
  refreshingProviders,
  onRefreshQuota,
  onOpenLastErrorInEventLog,
}: Props) {
  const ONE_DAY_MS = 24 * 60 * 60 * 1000
  const fmtDateOnly = (unixMs: number): string => fmtWhen(unixMs).split(' ')[0] ?? '-'
  const isExpiryUrgent = (unixMs: number): boolean => Number.isFinite(unixMs) && unixMs > 0 && unixMs - Date.now() <= ONE_DAY_MS
  const localNetworkOffline = status.local_network_online === false

  return (
    <table className="aoTable aoTableFixed">
      <thead>
        <tr>
          <th style={{ width: 140 }}>Name</th>
          <th className="aoCellCenter" style={{ width: 120 }}>
            Healthy
          </th>
          <th className="aoCellCenter" style={{ width: 90 }}>
            Failures
          </th>
          <th className="aoCellCenter" style={{ width: 170 }}>
            Cooldown
          </th>
          <th style={{ width: 170 }}>Last OK</th>
          <th>Last Error</th>
          <th style={{ width: 240 }}>Usage</th>
        </tr>
      </thead>
      <tbody>
        {providers.map((p) => {
          const h = status.providers[p]
          const isOffline = localNetworkOffline
          const q = simulateQuotaForDisplay(
            p,
            status.quota?.[p],
            status.projected_ledgers?.[p] ?? status.ledgers?.[p],
            usageStatistics,
          )
          const kind = (q?.kind ?? 'none') as 'none' | 'token_stats' | 'budget_info' | 'balance_info'
          const quotaHardCap = config?.providers?.[p]?.quota_hard_cap ?? { daily: true, weekly: true, monthly: true }
          const isClosed = h.status === 'closed'
          const cooldownActive = !isClosed && h.cooldown_until_unix_ms > Date.now()
          const retryDue = !isClosed && h.status === 'unhealthy' && !cooldownActive
          const isActive = (status.active_provider_counts?.[p] ?? 0) > 0
          const healthLabel =
            isClosed
              ? 'closed'
              : isOffline
                ? 'offline'
                : isActive
                ? 'effective'
                : retryDue
                  ? 'retry'
                : h.status === 'healthy'
                  ? 'yes'
                  : h.status === 'unhealthy' || h.status === 'cooldown'
                    ? 'no'
                    : 'unknown'
          const dotClass =
            isClosed
              ? 'aoDot aoDotBad'
              : isOffline
                ? 'aoDot aoDotMuted'
                : isActive
                ? 'aoDot'
                : retryDue
                  ? 'aoDot aoDotMuted'
                : h.status === 'healthy'
                  ? 'aoDot'
                  : h.status === 'unhealthy' || h.status === 'cooldown'
                    ? 'aoDot aoDotBad'
                    : 'aoDot aoDotMuted'

          const usageNode =
            kind === 'token_stats' ? (
              (() => {
                const total = q?.today_added ?? null
                const remaining = q?.remaining ?? null
                const used = q?.today_used ?? (total != null && remaining != null ? total - remaining : null)
                const usedPct = pctOf(used ?? null, total)
                const remainingPct = pctOf(remaining ?? null, total)
                return (
                  <div className="aoUsageMini">
                    <div className="aoUsageSplit">
                      <div className="aoUsageText">
                        <div className="aoUsageLine">remaining: {fmtPct(remainingPct)}</div>
                        <div className="aoUsageLine">
                          today: {fmtAmount(used)} / {fmtAmount(total)} ({fmtPct(usedPct)})
                        </div>
                      </div>
                      <button
                        className={`aoUsageRefreshBtn${refreshingProviders[p] ? ' aoUsageRefreshBtnSpin' : ''}`}
                        title="Refresh usage"
                        aria-label="Refresh usage"
                        onClick={() => onRefreshQuota(p)}
                      >
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                          <path d="M23 4v6h-6" />
                          <path d="M1 20v-6h6" />
                          <path d="M3.5 9a9 9 0 0 1 14.1-3.4L23 10" />
                          <path d="M1 14l5.3 5.3A9 9 0 0 0 20.5 15" />
                        </svg>
                      </button>
                    </div>
                  </div>
                )
              })()
            ) : kind === 'budget_info' ? (
              <div className="aoUsageMini">
                <div className="aoUsageSplit">
                  <div className="aoUsageText">
                    {(() => {
                      const usageLines: Array<{ key: string; content: string }> = []
                      const hasDailySpent = q?.daily_spent_usd != null
                      const hasDailyBudget = q?.daily_budget_usd != null
                      if (quotaHardCap.daily && (hasDailySpent || hasDailyBudget)) {
                        const dailyContent =
                          hasDailySpent && hasDailyBudget
                            ? `daily: $${fmtUsd(q?.daily_spent_usd)} / $${fmtUsd(q?.daily_budget_usd)}`
                            : hasDailySpent
                              ? `daily: $${fmtUsd(q?.daily_spent_usd)}`
                              : `daily budget: $${fmtUsd(q?.daily_budget_usd)}`
                        usageLines.push({
                          key: 'daily',
                          content: dailyContent,
                        })
                      }
                      const hasWeeklySpent = q?.weekly_spent_usd != null
                      const hasWeeklyBudget = q?.weekly_budget_usd != null
                      const hasMonthlySpent = q?.monthly_spent_usd != null
                      const hasMonthlyBudget = q?.monthly_budget_usd != null
                      const hasMonthly = hasMonthlySpent || hasMonthlyBudget

                      // Prefer weekly only when upstream actually reports weekly (spent + budget).
                      // Some providers keep the weekly budget field but stop reporting weekly spent
                      // when weekly is deprecated; in that case we show monthly instead.
                      const shouldShowWeekly = hasWeeklySpent && hasWeeklyBudget

                      if (quotaHardCap.weekly && shouldShowWeekly) {
                        usageLines.push({
                          key: 'weekly',
                          content: `weekly: $${fmtUsd(q?.weekly_spent_usd)} / $${fmtUsd(q?.weekly_budget_usd)}`,
                        })
                      } else if (quotaHardCap.monthly && hasMonthly) {
                        const monthlyContent =
                          hasMonthlySpent && hasMonthlyBudget
                            ? `monthly: $${fmtUsd(q?.monthly_spent_usd)} / $${fmtUsd(q?.monthly_budget_usd)}`
                            : hasMonthlySpent
                              ? `used: $${fmtUsd(q?.monthly_spent_usd)}`
                              : `monthly budget: $${fmtUsd(q?.monthly_budget_usd)}`
                        usageLines.push({
                          key: 'monthly',
                          content: monthlyContent,
                        })
                      } else if (quotaHardCap.weekly && hasWeeklyBudget) {
                        usageLines.push({
                          key: 'weekly-na',
                          content: `weekly: n/a / $${fmtUsd(q?.weekly_budget_usd)}`,
                        })
                      }

                      if (usageLines.length === 0) {
                        return <span className="aoHint">-</span>
                      }

                      return usageLines.map((line) => (
                        <div key={line.key} className="aoUsageLine">
                          {line.content}
                        </div>
                      ))
                    })()}
                  </div>
                  <button
                    className={`aoUsageRefreshBtn${refreshingProviders[p] ? ' aoUsageRefreshBtnSpin' : ''}`}
                    title="Refresh usage"
                    aria-label="Refresh usage"
                    onClick={() => onRefreshQuota(p)}
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M23 4v6h-6" />
                      <path d="M1 20v-6h6" />
                      <path d="M3.5 9a9 9 0 0 1 14.1-3.4L23 10" />
                      <path d="M1 14l5.3 5.3A9 9 0 0 0 20.5 15" />
                    </svg>
                  </button>
                </div>
              </div>
            ) : (
              <div className="aoUsageMini">
                <div className="aoUsageSplit">
                  <div className="aoUsageText">
                    <span className="aoHint">-</span>
                  </div>
                  <button
                    className={`aoUsageRefreshBtn${refreshingProviders[p] ? ' aoUsageRefreshBtnSpin' : ''}`}
                    title="Refresh usage"
                    aria-label="Refresh usage"
                    onClick={() => onRefreshQuota(p)}
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M23 4v6h-6" />
                      <path d="M1 20v-6h6" />
                      <path d="M3.5 9a9 9 0 0 1 14.1-3.4L23 10" />
                      <path d="M1 14l5.3 5.3A9 9 0 0 0 20.5 15" />
                    </svg>
                  </button>
                </div>
              </div>
            )

            const lastErrorMessage = h.last_error?.trim() ?? ''
            const lastErrorAt = h.last_fail_at_unix_ms
            // Show each provider's own latest failure in-place. Event Log jump remains best-effort:
            // the Event Log page re-runs a provider+message+time search against its full loaded window.
            const providerIsHealthy = h.status === 'healthy'
            const showLastError =
              lastErrorAt > 0 &&
              lastErrorMessage.length > 0 &&
              (!providerIsHealthy || lastErrorAt >= (h.last_ok_at_unix_ms ?? 0))

            return (
              <tr key={p}>
                <td style={{ fontFamily: mono }}>
                  <div>{p}</div>
                  {q?.package_expires_at_unix_ms ? (
                    <div
                      className="aoHint"
                      style={{
                        marginTop: 2,
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        color: isExpiryUrgent(q.package_expires_at_unix_ms) ? 'rgba(145, 12, 43, 0.92)' : undefined,
                      }}
                      title={`package ends: ${fmtWhen(q.package_expires_at_unix_ms)}`}
                    >
                      ends: {fmtDateOnly(q.package_expires_at_unix_ms)}
                    </div>
                  ) : null}
                </td>
                <td className="aoCellCenter">
                  <div className="aoCellCenterInner">
                    <span className={`aoPill ${isActive && !isOffline ? 'aoPulse' : ''}`.trim()}>
                      <span className={dotClass} />
                      <span className="aoPillText">{healthLabel}</span>
                    </span>
                  </div>
                </td>
                <td className="aoCellCenter">{h.consecutive_failures}</td>
                <td className="aoCellCenter">{cooldownActive ? fmtWhen(h.cooldown_until_unix_ms) : '-'}</td>
                <td>{fmtWhen(h.last_ok_at_unix_ms)}</td>
                <td>
                  {showLastError ? (
                    <span className="aoLastErrorCell">
                      <span className="aoLastErrorTime">{fmtWhen(lastErrorAt)}</span>
                      <button
                        className="aoLastErrorViewBtn"
                        onClick={() =>
                          onOpenLastErrorInEventLog({
                            provider: p,
                            unixMs: lastErrorAt,
                            message: h.last_error,
                            eventId: findLastErrorEventId(status.recent_events, {
                              provider: p,
                              unixMs: lastErrorAt,
                              message: h.last_error,
                            }),
                          })
                        }
                        title="Open in Event Log"
                      >
                        View
                      </button>
                    </span>
                  ) : (
                    '-'
                  )}
                </td>
                <td className="aoUsageCell">
                  <div className="aoUsageCellInner">{usageNode}</div>
                </td>
              </tr>
            )
          })}
      </tbody>
    </table>
  )
}
