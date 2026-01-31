import { fmtAmount, fmtPct, fmtUsd, fmtWhen, pctOf } from '../utils/format'
import type { Status } from '../types'

const mono = 'ui-monospace, "Cascadia Mono", "Consolas", monospace'

type Props = {
  providers: string[]
  status: Status
  refreshingProviders: Record<string, boolean>
  onRefreshQuota: (provider: string) => void
}

export function ProvidersTable({ providers, status, refreshingProviders, onRefreshQuota }: Props) {
  return (
    <table className="aoTable aoTableFixed">
      <thead>
        <tr>
          <th style={{ width: 140 }}>Name</th>
          <th style={{ width: 120 }}>Healthy</th>
          <th style={{ width: 90 }}>Failures</th>
          <th style={{ width: 170 }}>Cooldown</th>
          <th style={{ width: 170 }}>Last OK</th>
          <th>Last Error</th>
          <th style={{ width: 240 }}>Usage</th>
        </tr>
      </thead>
      <tbody>
        {providers.map((p) => {
          const h = status.providers[p]
          const q = status.quota?.[p]
          const kind = (q?.kind ?? 'none') as 'none' | 'token_stats' | 'budget_info'
          const cooldownActive = h.cooldown_until_unix_ms > Date.now()
          const isActive = (status.active_provider ?? null) === p
          const healthLabel =
            isActive
              ? 'effective'
              : h.status === 'healthy'
                ? 'yes'
                : h.status === 'unhealthy'
                  ? 'no'
                  : h.status === 'cooldown'
                    ? 'cooldown'
                    : 'unknown'
          const dotClass =
            isActive
              ? 'aoDot'
              : h.status === 'healthy'
                ? 'aoDot'
                : h.status === 'cooldown'
                  ? 'aoDot'
                  : h.status === 'unhealthy'
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
                    <div className="aoUsageLine">
                      daily: ${fmtUsd(q?.daily_spent_usd)} / ${fmtUsd(q?.daily_budget_usd)}
                    </div>
                    {q?.weekly_spent_usd != null || q?.weekly_budget_usd != null ? (
                      <div className="aoUsageLine">
                        weekly: ${fmtUsd(q?.weekly_spent_usd)} / ${fmtUsd(q?.weekly_budget_usd)}
                      </div>
                    ) : (
                      <div className="aoUsageLine">
                        monthly: ${fmtUsd(q?.monthly_spent_usd)} / ${fmtUsd(q?.monthly_budget_usd)}
                      </div>
                    )}
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

          return (
            <tr key={p}>
              <td style={{ fontFamily: mono }}>{p}</td>
              <td>
                <span className={`aoPill ${isActive ? 'aoPulse' : ''}`.trim()}>
                  <span className={dotClass} />
                  <span className="aoPillText">{healthLabel}</span>
                </span>
              </td>
              <td>{h.consecutive_failures}</td>
              <td>{cooldownActive ? fmtWhen(h.cooldown_until_unix_ms) : '-'}</td>
              <td>{fmtWhen(h.last_ok_at_unix_ms)}</td>
              <td className="aoCellWrap">{h.last_error ? h.last_error : '-'}</td>
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
