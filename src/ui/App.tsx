import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import './App.css'

type ProviderHealth = {
  status: 'unknown' | 'healthy' | 'unhealthy' | 'cooldown'
  consecutive_failures: number
  cooldown_until_unix_ms: number
  last_error: string
  last_ok_at_unix_ms: number
  last_fail_at_unix_ms: number
}

type Status = {
  listen: { host: string; port: number }
  preferred_provider: string
  manual_override: string | null
  providers: Record<string, ProviderHealth>
  metrics: Record<string, { ok_requests: number; error_requests: number; total_tokens: number }>
  recent_events: Array<{ provider: string; level: string; unix_ms: number; message: string }>
  quota: Record<
    string,
    {
      kind: 'none' | 'token_stats' | 'budget_info'
      updated_at_unix_ms: number
      remaining: number | null
      today_used: number | null
      today_added: number | null
      daily_spent_usd: number | null
      daily_budget_usd: number | null
      monthly_spent_usd: number | null
      monthly_budget_usd: number | null
      last_error: string
    }
  >
  ledgers: Record<
    string,
    {
      since_last_quota_refresh_total_tokens: number
      last_reset_unix_ms: number
    }
  >
  last_activity_unix_ms: number
  codex_account: {
    ok: boolean
    checked_at_unix_ms?: number
    signed_in?: boolean
    remaining?: string | null
    unlimited?: boolean | null
    error?: string
  }
}

type Config = {
  listen: { host: string; port: number }
  routing: {
    preferred_provider: string
    auto_return_to_preferred: boolean
    preferred_stable_seconds: number
    failure_threshold: number
    cooldown_seconds: number
    request_timeout_seconds: number
  }
  providers: Record<
    string,
    {
      display_name: string
      base_url: string
      usage_adapter?: string
      usage_base_url?: string | null
      has_key: boolean
      key_preview?: string | null
      has_usage_token?: boolean
    }
  >
}

function fmtWhen(unixMs: number): string {
  if (!unixMs) return '-'
  const d = new Date(unixMs)
  // day-month-year, per repo conventions.
  const dd = String(d.getDate()).padStart(2, '0')
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const yyyy = d.getFullYear()
  const hh = String(d.getHours()).padStart(2, '0')
  const min = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  return `${dd}-${mm}-${yyyy} ${hh}:${min}:${ss}`
}

function pctOf(part?: number | null, total?: number | null): number | null {
  if (part == null || total == null) return null
  if (!Number.isFinite(part) || !Number.isFinite(total) || total <= 0) return null
  const pct = (part / total) * 100
  if (!Number.isFinite(pct)) return null
  return Math.max(0, Math.min(100, pct))
}

function fmtPct(pct: number | null): string {
  if (pct == null) return '-'
  const v = pct < 1 ? 0 : Math.floor(pct)
  return `${v}%`
}

function fmtAmount(value?: number | null): string {
  if (value == null || !Number.isFinite(value)) return '-'
  return Math.round(value).toLocaleString()
}

function parsePct(value?: string | null): string | null {
  if (!value) return null
  const match = String(value).match(/(\d+(?:\.\d+)?)\s*%/)
  if (!match) return null
  const num = Math.max(0, Math.min(100, Number(match[1])))
  if (!Number.isFinite(num)) return null
  return `${Math.floor(num)}%`
}

const devStatus: Status = {
  listen: { host: '127.0.0.1', port: 4000 },
  preferred_provider: 'provider_1',
  manual_override: null,
  providers: {
    provider_1: {
      status: 'healthy',
      consecutive_failures: 0,
      cooldown_until_unix_ms: 0,
      last_error: '',
      last_ok_at_unix_ms: Date.now() - 120000,
      last_fail_at_unix_ms: 0,
    },
    provider_2: {
      status: 'unknown',
      consecutive_failures: 1,
      cooldown_until_unix_ms: Date.now() + 300000,
      last_error: 'endpoint not found',
      last_ok_at_unix_ms: Date.now() - 3600000,
      last_fail_at_unix_ms: Date.now() - 240000,
    },
  },
  metrics: {
    provider_1: { ok_requests: 210, error_requests: 3, total_tokens: 128400 },
    provider_2: { ok_requests: 12, error_requests: 2, total_tokens: 3400 },
  },
  recent_events: [],
  quota: {
    provider_1: {
      kind: 'token_stats',
      updated_at_unix_ms: Date.now() - 90000,
      remaining: 8320,
      today_used: 2680,
      today_added: 11000,
      daily_spent_usd: null,
      daily_budget_usd: null,
      monthly_spent_usd: null,
      monthly_budget_usd: null,
      last_error: '',
    },
    provider_2: {
      kind: 'budget_info',
      updated_at_unix_ms: Date.now() - 420000,
      remaining: null,
      today_used: null,
      today_added: null,
      daily_spent_usd: 1.4,
      daily_budget_usd: 5,
      monthly_spent_usd: 12.3,
      monthly_budget_usd: 40,
      last_error: '',
    },
  },
  ledgers: {},
  last_activity_unix_ms: Date.now() - 30000,
  codex_account: {
    ok: true,
    checked_at_unix_ms: Date.now() - 90000,
    signed_in: true,
    remaining: '13%',
    unlimited: false,
  },
}

const devConfig: Config = {
  listen: { host: '127.0.0.1', port: 4000 },
  routing: {
    preferred_provider: 'provider_1',
    auto_return_to_preferred: true,
    preferred_stable_seconds: 120,
    failure_threshold: 2,
    cooldown_seconds: 120,
    request_timeout_seconds: 120,
  },
  providers: {
    provider_1: {
      display_name: 'provider_1',
      base_url: 'https://code.ppchat.vip/v1',
      usage_adapter: 'ppchat',
      usage_base_url: 'https://code.ppchat.vip',
      has_key: true,
      key_preview: 'sk-pp********c61',
      has_usage_token: false,
    },
    provider_2: {
      display_name: 'provider_2',
      base_url: 'https://codex-api.packycode.com/v1',
      usage_adapter: 'packycode',
      usage_base_url: 'https://codex-api.packycode.com',
      has_key: true,
      key_preview: 'sk-pk********mN5',
      has_usage_token: true,
    },
  },
}

export default function App() {
  const isDevPreview = useMemo(() => {
    if (!import.meta.env.DEV) return false
    if (typeof window === 'undefined') return false
    const w = window as unknown as { __TAURI__?: { core?: { invoke?: unknown } } }
    return !Boolean(w.__TAURI__?.core?.invoke)
  }, [])
  const [status, setStatus] = useState<Status | null>(null)
  const [config, setConfig] = useState<Config | null>(null)
  const [baselineBaseUrls, setBaselineBaseUrls] = useState<Record<string, string>>({})
  const [toast, setToast] = useState<string>('')
  const [override, setOverride] = useState<string>('') // '' => auto
  const [newProviderName, setNewProviderName] = useState<string>('')
  const [newProviderBaseUrl, setNewProviderBaseUrl] = useState<string>('')
  const [providerPanelsOpen, setProviderPanelsOpen] = useState<Record<string, boolean>>({})
  const [keyModal, setKeyModal] = useState<{ open: boolean; provider: string; value: string }>({
    open: false,
    provider: '',
    value: '',
  })
  const [usageBaseModal, setUsageBaseModal] = useState<{ open: boolean; provider: string; value: string }>({
    open: false,
    provider: '',
    value: '',
  })
  const overrideDirtyRef = useRef<boolean>(false)
  const [gatewayTokenPreview, setGatewayTokenPreview] = useState<string>('')
  const [gatewayTokenReveal, setGatewayTokenReveal] = useState<string>('')
  const [gatewayModalOpen, setGatewayModalOpen] = useState<boolean>(false)

  const containerRef = useRef<HTMLDivElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const toastTimerRef = useRef<number | null>(null)

  const providers = useMemo(() => Object.keys(status?.providers ?? {}), [status])
  const nextProviderPlaceholder = useMemo(() => {
    const keys = Object.keys(config?.providers ?? {})
    let maxN = 0
    for (const k of keys) {
      const m = /^provider_(\d+)$/.exec(k)
      if (!m) continue
      const n = Number(m[1])
      if (Number.isFinite(n) && n > maxN) maxN = n
    }
    return `provider_${maxN > 0 ? maxN + 1 : 1}`
  }, [config])

  function flashToast(msg: string, kind: 'info' | 'error' = 'info') {
    setToast(msg)
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current)
    const ms = kind === 'error' ? 5200 : 2400
    toastTimerRef.current = window.setTimeout(() => setToast(''), ms)
  }

  async function refreshStatus() {
    if (isDevPreview) {
      setStatus(devStatus)
      return
    }
    try {
      const s = await invoke<Status>('get_status')
      setStatus(s)
      if (!overrideDirtyRef.current) setOverride(s.manual_override ?? '')
    } catch (e) {
      console.error(e)
    }
  }

  async function refreshConfig() {
    if (isDevPreview) {
      setConfig(devConfig)
      setBaselineBaseUrls(
        Object.fromEntries(Object.entries(devConfig.providers).map(([name, p]) => [name, p.base_url])),
      )
      setGatewayTokenPreview('ao_dev********7f2a')
      return
    }
    try {
      const c = await invoke<Config>('get_config')
      setConfig(c)
      setBaselineBaseUrls(
        Object.fromEntries(Object.entries(c.providers).map(([name, p]) => [name, p.base_url])),
      )
      const p = await invoke<string>('get_gateway_token_preview')
      setGatewayTokenPreview(p)
    } catch (e) {
      console.error(e)
    }
  }

  async function applyOverride(next: string) {
    try {
      await invoke('set_manual_override', { provider: next === '' ? null : next })
      overrideDirtyRef.current = false
      flashToast(next === '' ? 'Routing: auto' : `Routing locked`)
      await refreshStatus()
    } catch (e) {
      flashToast(String(e), 'error')
    }
  }

  async function setPreferred(next: string) {
    await invoke('set_preferred_provider', { provider: next })
    await refreshStatus()
    await refreshConfig()
  }

  async function saveProvider(name: string) {
    if (!config) return
    const p = config.providers[name]
    try {
      await invoke('upsert_provider', {
        name,
        displayName: p.display_name,
        baseUrl: p.base_url,
      })
      flashToast(`Saved: ${name}`)
      try {
        await invoke('probe_provider', { provider: name })
      } catch (e) {
        flashToast(String(e), 'error')
      }
      try {
        await invoke('refresh_quota', { provider: name })
      } catch (e) {
        flashToast(String(e), 'error')
      }
      await refreshStatus()
      await refreshConfig()
    } catch (e) {
      flashToast(String(e), 'error')
    }
  }

  async function deleteProvider(name: string) {
    try {
      await invoke('delete_provider', { name })
      flashToast(`Deleted: ${name}`)
      await refreshStatus()
      await refreshConfig()
    } catch (e) {
      flashToast(String(e), 'error')
    }
  }

  async function saveKey() {
    const provider = keyModal.provider
    const key = keyModal.value
    if (!provider || !key) return
    try {
      await invoke('set_provider_key', { provider, key })
      setKeyModal({ open: false, provider: '', value: '' })
      flashToast(`Key set: ${provider}`)
      try {
        await invoke('probe_provider', { provider })
      } catch (e) {
        flashToast(String(e), 'error')
      }
      try {
        await invoke('refresh_quota', { provider })
      } catch (e) {
        flashToast(String(e), 'error')
      }
      await refreshStatus()
      await refreshConfig()
    } catch (e) {
      flashToast(String(e), 'error')
    }
  }

  async function clearKey(name: string) {
    try {
      await invoke('clear_provider_key', { provider: name })
      flashToast(`Key cleared: ${name}`)
      await refreshStatus()
      await refreshConfig()
    } catch (e) {
      flashToast(String(e), 'error')
    }
  }

  async function refreshQuota(name: string) {
    try {
      await invoke('refresh_quota', { provider: name })
      await refreshStatus()
      flashToast(`Usage refreshed: ${name}`)
    } catch (e) {
      flashToast(String(e), 'error')
    }
  }

  async function refreshQuotaAll() {
    try {
      await invoke('refresh_quota_all')
      await refreshStatus()
      flashToast('Usage refreshed')
    } catch (e) {
      flashToast(String(e), 'error')
    }
  }

  async function saveUsageBaseUrl() {
    const provider = usageBaseModal.provider
    const url = usageBaseModal.value.trim()
    if (!provider || !url) return
    try {
      await invoke('set_usage_base_url', { provider, url })
      setUsageBaseModal({ open: false, provider: '', value: '' })
      flashToast(`Usage base saved: ${provider}`)
      await refreshConfig()
      await refreshStatus()
    } catch (e) {
      flashToast(String(e), 'error')
    }
  }

  async function clearUsageBaseUrl(name: string) {
    try {
      await invoke('clear_usage_base_url', { provider: name })
      flashToast(`Usage base cleared: ${name}`)
      await refreshConfig()
      await refreshStatus()
    } catch (e) {
      flashToast(String(e), 'error')
    }
  }

  async function addProvider() {
    const name = newProviderName.trim()
    const baseUrl = newProviderBaseUrl.trim()
    if (!name || !baseUrl) return

    try {
      await invoke('upsert_provider', {
        name,
        displayName: name,
        baseUrl,
      })
      setNewProviderName('')
      setNewProviderBaseUrl('')
      flashToast(`Added: ${name}`)
      await refreshStatus()
      await refreshConfig()
    } catch (e) {
      flashToast(String(e), 'error')
    }
  }

  useEffect(() => {
    if (isDevPreview) {
      setStatus(devStatus)
      setConfig(devConfig)
      setBaselineBaseUrls(
        Object.fromEntries(Object.entries(devConfig.providers).map(([name, p]) => [name, p.base_url])),
      )
      setGatewayTokenPreview('ao_dev********7f2a')
      return
    }
    void refreshStatus()
    void refreshConfig()
    // Fetch usage once when opening the app (then only refresh during active gateway usage, or manually).
    const once = window.setTimeout(() => void refreshQuotaAll(), 850)
    const t = setInterval(() => void refreshStatus(), 1500)
    return () => {
      clearInterval(t)
      window.clearTimeout(once)
    }
  }, [])

  const isProviderOpen = useCallback(
    (name: string) => providerPanelsOpen[name] ?? true,
    [providerPanelsOpen],
  )

  const toggleProviderOpen = useCallback((name: string) => {
    setProviderPanelsOpen((prev) => ({ ...prev, [name]: !(prev[name] ?? true) }))
  }, [])

  return (
    <div className="aoRoot" ref={containerRef}>
      <div className="aoScale">
        <div className="aoShell" ref={contentRef}>
          {toast ? (
            <div className="aoToast" role="status" aria-live="polite">
              {toast}
            </div>
          ) : null}
          <div className="aoBrand">
            <img className="aoMark" src="/ao-icon.png" alt="Agent Orchestrator icon" />
            <div>
              <div className="aoTitle">Agent Orchestrator</div>
              <div className="aoSubtitle">Local gateway + smart failover for Codex</div>
            </div>
          </div>

          {/* Surface errors via toast to avoid layout shifts. */}

          {!status ? (
            <div className="aoHint">Loading…</div>
          ) : (
            <>
              <div className="aoHero">
                <div className="aoCard aoHeroCard">
                  <div className="aoCardHeader">
                    <div className="aoCardTitle">Status</div>
                    <span className="aoPill aoPulse">
                      <span className="aoDot" />
                      <span className="aoPillText">running</span>
                    </span>
                  </div>
                  <div className="aoStatGrid">
                    <div className="aoStatLabel">Gateway</div>
                    <div className="aoStatValue">
                      {status.listen.host}:{status.listen.port}
                    </div>
                    <div className="aoStatLabel">Preferred</div>
                    <div className="aoStatValue">{status.preferred_provider}</div>
                    <div className="aoStatLabel">Override</div>
                    <div className="aoStatValue">{status.manual_override ?? '(auto)'}</div>
                  </div>
                  <div className="aoDivider" />
                  <div className="aoRow aoRowWrap">
                    <div className="aoHint" style={{ minWidth: 120 }}>
                      Gateway token
                    </div>
                    <div className="aoVal aoValSmall">{gatewayTokenPreview}</div>
                    <button
                      className="aoBtn"
                      onClick={() => {
                        setGatewayModalOpen(true)
                        setGatewayTokenReveal('')
                      }}
                    >
                      Show / Rotate
                    </button>
                  </div>
                  <div className="aoHint">
                    Put this into{' '}
                    <span style={{ fontFamily: 'ui-monospace, \"Cascadia Mono\", \"Consolas\", monospace' }}>
                      .codex/auth.json
                    </span>{' '}
                    as
                    <span style={{ fontFamily: 'ui-monospace, \"Cascadia Mono\", \"Consolas\", monospace' }}>
                      {' '}
                      OPENAI_API_KEY
                    </span>
                    .
                  </div>
                </div>

                <div className="aoCard aoHeroCard">
                  <div className="aoCardHeader">
                    <div className="aoCardTitle">Codex (Auth)</div>
                    <span className={`aoPill ${status.codex_account?.signed_in ? 'aoPulse' : ''}`.trim()}>
                      <span className={status.codex_account?.signed_in ? 'aoDot' : 'aoDot aoDotBad'} />
                      <span className="aoPillText">
                        {status.codex_account?.signed_in ? 'signed in' : 'signed out'}
                      </span>
                    </span>
                  </div>
                  <div className="aoKvp">
                    <div className="aoKey">Checked</div>
                    <div className="aoVal">
                      {status.codex_account?.checked_at_unix_ms
                        ? fmtWhen(status.codex_account.checked_at_unix_ms)
                        : '-'}
                    </div>
                  </div>
                  <div className="aoDivider" />
                  <div className="aoLimitGrid">
                    <div className="aoLimitCard">
                      <div className="aoMiniLabel">5-hour limit</div>
                      <div className="aoLimitValue">
                        -
                      </div>
                    </div>
                    <div className="aoLimitCard">
                      <div className="aoMiniLabel">Weekly limit</div>
                      <div className="aoLimitValue">
                        {parsePct(status.codex_account?.remaining) ?? '-'}
                      </div>
                    </div>
                    <div className="aoLimitCard">
                      <div className="aoMiniLabel">Code review</div>
                      <div className="aoLimitValue">
                        -
                      </div>
                    </div>
                  </div>
                  <div className="aoHeroActions" style={{ marginTop: 15 }}>
                    <button
                      className={`aoBtn ${status.codex_account?.signed_in ? 'aoBtnDanger' : ''}`.trim()}
                      onClick={async () => {
                        try {
                          if (status.codex_account?.signed_in) {
                            await invoke('codex_account_logout')
                            flashToast('Codex logged out')
                          } else {
                            await invoke('codex_account_login')
                            flashToast('Codex login opened in browser')
                          }
                        } catch (e) {
                          flashToast(String(e), 'error')
                        }
                      }}
                    >
                      {status.codex_account?.signed_in ? 'Log out' : 'Log in'}
                    </button>
                    <button
                      className="aoBtn aoBtnPrimary"
                      onClick={async () => {
                        try {
                          await invoke('codex_account_refresh')
                          flashToast('Checking…')
                        } catch (e) {
                          flashToast(String(e), 'error')
                        }
                      }}
                    >
                      Refresh
                    </button>
                  </div>
                  {status.codex_account?.error ? (
                    <div className="aoHint" style={{ marginTop: 8, color: 'rgba(145, 12, 43, 0.92)' }}>
                      {status.codex_account.error}
                    </div>
                  ) : null}
                </div>

                <div className="aoCard aoHeroCard">
                  <div className="aoCardHeader">
                    <div className="aoCardTitle">Routing</div>
                    <span className={`aoPill ${override === '' ? 'aoPulse' : ''}`.trim()}>
                      <span className={override === '' ? 'aoDot' : 'aoDot aoDotBad'} />
                      <span className="aoPillText">{override === '' ? 'auto' : 'locked'}</span>
                    </span>
                  </div>
                  {config ? (
                    <div className="aoRoutingGrid">
                      <label className="aoRoutingRow">
                        <span className="aoMiniLabel">Mode</span>
                        <select
                          className="aoSelect"
                          value={override}
                          onChange={(e) => {
                            setOverride(e.target.value)
                            overrideDirtyRef.current = true
                            void applyOverride(e.target.value)
                          }}
                        >
                          <option value="">Auto</option>
                          {providers.map((p) => (
                            <option key={p} value={p}>
                              {p}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="aoRoutingRow">
                        <span className="aoMiniLabel">Preferred</span>
                        <select
                          className="aoSelect"
                          value={config.routing.preferred_provider}
                          onChange={(e) => void setPreferred(e.target.value)}
                        >
                          {Object.keys(config.providers).map((p) => (
                            <option key={p} value={p}>
                              {p}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                  ) : (
                    <div className="aoHint" style={{ marginTop: 8 }}>
                      Loading…
                    </div>
                  )}
                  <div className="aoHint" style={{ marginTop: 8 }}>
                    Tip: closing the window hides to tray. Use tray menu to show/quit.
                  </div>
                </div>
              </div>

              <div className="aoSection">
                <div className="aoSectionHeader aoSectionHeaderStack">
                  <h3 className="aoH3">Providers</h3>
                </div>
                <table className="aoTable aoTableFixed">
                  <thead>
                    <tr>
                      <th style={{ width: 140 }}>Name</th>
                      <th style={{ width: 120 }}>Healthy</th>
                      <th style={{ width: 90 }}>Failures</th>
                      <th style={{ width: 170 }}>Cooldown</th>
                      <th style={{ width: 170 }}>Last OK</th>
                      <th style={{ width: 240 }}>Usage</th>
                      <th>Last Error</th>
                    </tr>
                  </thead>
                  <tbody>
                    {providers.map((p) => {
                      const h = status.providers[p]
                      const q = status?.quota?.[p]
                      const kind = (q?.kind ?? 'none') as 'none' | 'token_stats' | 'budget_info'
                      const cooldownActive = h.cooldown_until_unix_ms > Date.now()
                      const healthLabel =
                        h.status === 'healthy'
                          ? 'yes'
                          : h.status === 'unhealthy'
                            ? 'no'
                            : h.status === 'cooldown'
                              ? 'cooldown'
                              : 'unknown'
                      const dotClass =
                        h.status === 'healthy'
                          ? 'aoDot'
                          : h.status === 'cooldown'
                            ? 'aoDot'
                            : h.status === 'unhealthy'
                              ? 'aoDot aoDotBad'
                              : 'aoDot aoDotBad'
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
                                <div className="aoUsageLine">remaining: {fmtPct(remainingPct)}</div>
                                <div className="aoUsageLine">
                                  today: {fmtAmount(used)} / {fmtAmount(total)} ({fmtPct(usedPct)})
                                </div>
                                <div className="aoUsageActions">
                                  <button className="aoTinyBtn" onClick={() => void refreshQuota(p)}>
                                    Refresh
                                  </button>
                                </div>
                              </div>
                            )
                          })()
                        ) : kind === 'budget_info' ? (
                          <div className="aoUsageMini">
                            <div className="aoUsageLine">
                              daily: ${q?.daily_spent_usd ?? '-'} / ${q?.daily_budget_usd ?? '-'}
                            </div>
                            <div className="aoUsageLine">
                              monthly: ${q?.monthly_spent_usd ?? '-'} / ${q?.monthly_budget_usd ?? '-'}
                            </div>
                            <div className="aoUsageActions">
                              <button className="aoTinyBtn" onClick={() => void refreshQuota(p)}>
                                Refresh
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div className="aoUsageMini">
                            <span className="aoHint">-</span>
                            <div className="aoUsageActions">
                              <button className="aoTinyBtn" onClick={() => void refreshQuota(p)}>
                                Refresh
                              </button>
                            </div>
                          </div>
                        )
                      return (
                        <tr key={p}>
                          <td style={{ fontFamily: 'ui-monospace, "Cascadia Mono", "Consolas", monospace' }}>{p}</td>
                          <td>
                            <span className="aoPill">
                              <span className={dotClass} />
                              <span className="aoPillText">{healthLabel}</span>
                            </span>
                          </td>
                          <td>{h.consecutive_failures}</td>
                          <td>{cooldownActive ? fmtWhen(h.cooldown_until_unix_ms) : '-'}</td>
                          <td>{fmtWhen(h.last_ok_at_unix_ms)}</td>
                          <td>{usageNode}</td>
                          <td className="aoCellWrap">{h.last_error ? h.last_error : '-'}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>

              {config ? (
                <div className="aoSection">
                  <div className="aoSectionHeader">
                    <h3 className="aoH3">Config</h3>
                    <div className="aoHint">keys are stored in ./user-data/secrets.json (gitignored)</div>
                  </div>

                <div className="aoCard aoConfigCard">
                  <div className="aoConfigDeck">
                    <div className="aoConfigPanel">
                      <div className="aoMiniTitle">Add provider</div>
                      <div className="aoAddProviderRow">
                        <input
                          className="aoInput"
                          placeholder={nextProviderPlaceholder}
                          value={newProviderName}
                          onChange={(e) => setNewProviderName(e.target.value)}
                        />
                        <input
                          className="aoInput"
                          placeholder="Base URL (e.g. http://127.0.0.1:4001)"
                          value={newProviderBaseUrl}
                          onChange={(e) => setNewProviderBaseUrl(e.target.value)}
                        />
                        <button className="aoBtn aoBtnPrimary" onClick={() => void addProvider()}>
                          Add
                        </button>
                      </div>
                    </div>
                  </div>
                </div>

                  <div className="aoProviderConfigList">
                    {Object.entries(config.providers).map(([name, p]) => (
                      <div className="aoProviderConfigCard" key={name}>
                        <div className="aoProviderConfigBody">
                          <div className="aoProviderField aoProviderLeft">
                            <div className="aoProviderHeadRow">
                              <div className="aoProviderName">{name}</div>
                              <div className="aoProviderHeadActions">
                                {p.base_url !== (baselineBaseUrls[name] ?? '') ? (
                                  <button className="aoActionBtn" title="Save" onClick={() => void saveProvider(name)}>
                                    <svg viewBox="0 0 24 24" aria-hidden="true">
                                      <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z" />
                                      <path d="M17 21v-8H7v8" />
                                      <path d="M7 3v5h8" />
                                    </svg>
                                    <span>Save</span>
                                  </button>
                                ) : null}
                                <button
                                  className="aoActionBtn"
                                  title="Set key"
                                  onClick={() => setKeyModal({ open: true, provider: name, value: '' })}
                                >
                                  <svg viewBox="0 0 24 24" aria-hidden="true">
                                    <g transform="rotate(-28 12 12)">
                                      <circle cx="7.2" cy="12" r="3.2" />
                                      <circle cx="7.2" cy="12" r="1.15" />
                                      <path d="M10.8 12H21" />
                                      <path d="M17.2 12v2.4" />
                                      <path d="M19.2 12v3.4" />
                                    </g>
                                  </svg>
                                  <span>Key</span>
                                </button>
                                <button className="aoActionBtn" title="Clear key" onClick={() => void clearKey(name)}>
                                  <svg viewBox="0 0 24 24" aria-hidden="true">
                                    <path d="m7 21-4-4a2 2 0 0 1 0-3l10-10a2 2 0 0 1 3 0l5 5a2 2 0 0 1 0 3l-8 8" />
                                    <path d="M6 18h8" />
                                  </svg>
                                  <span>Clear</span>
                                </button>
                                <button
                                  className="aoActionBtn aoActionBtnDanger"
                                  title="Delete provider"
                                  aria-label="Delete provider"
                                  onClick={() => void deleteProvider(name)}
                                >
                                  <svg viewBox="0 0 24 24" aria-hidden="true">
                                    <path d="M3 6h18" />
                                    <path d="M8 6V4h8v2" />
                                    <path d="M19 6 18 20H6L5 6" />
                                    <path d="M10 11v6" />
                                    <path d="M14 11v6" />
                                  </svg>
                                </button>
                                <button
                                  className="aoTinyBtn aoToggleBtn"
                                  onClick={() => toggleProviderOpen(name)}
                                >
                                  {isProviderOpen(name) ? 'Hide' : 'Show'}
                                </button>
                              </div>
                            </div>
                            {isProviderOpen(name) ? null : (
                              <div className="aoHint">Details hidden</div>
                            )}
                            {isProviderOpen(name) ? (
                              <>
                                <div className="aoMiniLabel">Base URL</div>
                                <input
                                  className="aoInput aoUrlInput"
                                  value={p.base_url}
                                  onChange={(e) =>
                                    setConfig((c) =>
                                      c
                                        ? {
                                            ...c,
                                            providers: {
                                              ...c.providers,
                                              [name]: { ...c.providers[name], base_url: e.target.value },
                                            },
                                          }
                                        : c,
                                    )
                                  }
                                />
                                <div className="aoMiniLabel">Key</div>
                                <div className="aoKeyValue">
                                  {p.has_key ? (p.key_preview ? p.key_preview : 'set') : 'empty'}
                                </div>
                              </>
                            ) : null}
                          </div>
                          <div className="aoProviderField aoProviderRight">
                            {isProviderOpen(name) ? (
                              <>
                                <div className="aoMiniLabel">Usage controls</div>
                                <div className="aoUsageBtns">
                                  <button
                                    className="aoTinyBtn"
                                    onClick={() =>
                                      setUsageBaseModal({
                                        open: true,
                                        provider: name,
                                        value: p.usage_base_url ?? '',
                                      })
                                    }
                                  >
                                    Usage Base
                                  </button>
                                  {p.usage_base_url ? (
                                    <button className="aoTinyBtn" onClick={() => void clearUsageBaseUrl(name)}>
                                      Clear
                                    </button>
                                  ) : null}
                                </div>
                                <div className="aoHint">
                                  Usage base sets the usage endpoint. If empty, we use the provider base URL.
                                </div>
                                <div className="aoHint">
                                  updated:{' '}
                                  {status?.quota?.[name]?.updated_at_unix_ms
                                    ? fmtWhen(status.quota[name].updated_at_unix_ms)
                                    : 'never'}
                                </div>
                                {status?.quota?.[name]?.last_error ? (
                                  <div className="aoUsageErr">{status.quota[name].last_error}</div>
                                ) : null}
                              </>
                            ) : null}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

            </>
          )}
        </div>
      </div>

      {keyModal.open ? (
        <div className="aoModalBackdrop" role="dialog" aria-modal="true">
          <div className="aoModal">
            <div className="aoModalTitle">Set API key</div>
            <div className="aoModalSub">
              Provider:{' '}
              <span style={{ fontFamily: 'ui-monospace, \"Cascadia Mono\", \"Consolas\", monospace' }}>
                {keyModal.provider}
              </span>
              <br />
              Stored in ./user-data/secrets.json (gitignored).
            </div>
            <input
              className="aoInput"
              style={{ width: '100%', height: 36, borderRadius: 12 }}
              placeholder="Paste API key..."
              value={keyModal.value}
              onChange={(e) => setKeyModal((m) => ({ ...m, value: e.target.value }))}
            />
            <div className="aoModalActions">
              <button className="aoBtn" onClick={() => setKeyModal({ open: false, provider: '', value: '' })}>
                Cancel
              </button>
              <button className="aoBtn aoBtnPrimary" onClick={() => void saveKey()} disabled={!keyModal.value}>
                Save
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {usageBaseModal.open ? (
        <div className="aoModalBackdrop" role="dialog" aria-modal="true">
          <div className="aoModal">
            <div className="aoModalTitle">Usage base URL</div>
            <div className="aoModalSub">
              Provider:{' '}
              <span style={{ fontFamily: 'ui-monospace, \"Cascadia Mono\", \"Consolas\", monospace' }}>
                {usageBaseModal.provider}
              </span>
              <br />
              Override the usage endpoint used for quota/usage fetch. If empty, we use the provider base URL.
            </div>
            <input
              className="aoInput"
              style={{ width: '100%', height: 36, borderRadius: 12 }}
              placeholder="https://..."
              value={usageBaseModal.value}
              onChange={(e) => setUsageBaseModal((m) => ({ ...m, value: e.target.value }))}
            />
            <div className="aoModalActions">
              <button className="aoBtn" onClick={() => setUsageBaseModal({ open: false, provider: '', value: '' })}>
                Cancel
              </button>
              <button className="aoBtn" onClick={() => void clearUsageBaseUrl(usageBaseModal.provider)}>
                Clear
              </button>
              <button className="aoBtn aoBtnPrimary" onClick={() => void saveUsageBaseUrl()} disabled={!usageBaseModal.value.trim()}>
                Save
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {gatewayModalOpen ? (
        <div className="aoModalBackdrop" role="dialog" aria-modal="true">
          <div className="aoModal">
            <div className="aoModalTitle">Codex gateway token</div>
            <div className="aoModalSub">
              Set <span style={{ fontFamily: 'ui-monospace, \"Cascadia Mono\", \"Consolas\", monospace' }}>OPENAI_API_KEY</span> in{' '}
              <span style={{ fontFamily: 'ui-monospace, \"Cascadia Mono\", \"Consolas\", monospace' }}>.codex/auth.json</span> to this value.
              <br />
              Stored in <span style={{ fontFamily: 'ui-monospace, \"Cascadia Mono\", \"Consolas\", monospace' }}>./user-data/secrets.json</span>.
            </div>
            <input
              className="aoInput"
              style={{ width: '100%', height: 36, borderRadius: 12 }}
              readOnly
              value={gatewayTokenReveal || gatewayTokenPreview}
              onFocus={(e) => e.currentTarget.select()}
            />
            <div className="aoModalActions">
              <button
                className="aoBtn"
                onClick={() => {
                  setGatewayModalOpen(false)
                  setGatewayTokenReveal('')
                }}
              >
                Close
              </button>
              <button
                className="aoBtn"
                onClick={async () => {
                  const t = await invoke<string>('get_gateway_token')
                  setGatewayTokenReveal(t)
                }}
              >
                Reveal
              </button>
              <button
                className="aoBtn aoBtnDanger"
                onClick={async () => {
                  const t = await invoke<string>('rotate_gateway_token')
                  setGatewayTokenReveal(t)
                  const p = await invoke<string>('get_gateway_token_preview')
                  setGatewayTokenPreview(p)
                  flashToast('Gateway token rotated')
                }}
              >
                Rotate
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
