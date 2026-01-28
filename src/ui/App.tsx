import { useEffect, useMemo, useRef, useState } from 'react'
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
  official_web: {
    ok: boolean
    checked_at_unix_ms?: number
    signed_in?: boolean
    remaining?: number | null
    href?: string
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

export default function App() {
  const [status, setStatus] = useState<Status | null>(null)
  const [config, setConfig] = useState<Config | null>(null)
  const [baselineBaseUrls, setBaselineBaseUrls] = useState<Record<string, string>>({})
  const [toast, setToast] = useState<string>('')
  const [override, setOverride] = useState<string>('') // '' => auto
  const [newProviderName, setNewProviderName] = useState<string>('')
  const [newProviderBaseUrl, setNewProviderBaseUrl] = useState<string>('')
  const [showEvents, setShowEvents] = useState<boolean>(false)
  const [eventsMax, setEventsMax] = useState<number>(20)
  const [keyModal, setKeyModal] = useState<{ open: boolean; provider: string; value: string }>({
    open: false,
    provider: '',
    value: '',
  })
  const [usageTokenModal, setUsageTokenModal] = useState<{ open: boolean; provider: string; value: string }>({
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
    try {
      const s = await invoke<Status>('get_status')
      setStatus(s)
      if (!overrideDirtyRef.current) setOverride(s.manual_override ?? '')
    } catch (e) {
      console.error(e)
    }
  }

  async function refreshConfig() {
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

  const events = useMemo(() => (status?.recent_events ?? []).slice(0, eventsMax), [status, eventsMax])

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

  async function saveUsageToken() {
    const provider = usageTokenModal.provider
    const token = usageTokenModal.value
    if (!provider || !token) return
    try {
      await invoke('set_usage_token', { provider, token })
      setUsageTokenModal({ open: false, provider: '', value: '' })
      flashToast(`Usage token set: ${provider}`)
      await refreshStatus()
      await refreshConfig()
    } catch (e) {
      flashToast(String(e), 'error')
    }
  }

  async function clearUsageToken(name: string) {
    try {
      await invoke('clear_usage_token', { provider: name })
      flashToast(`Usage token cleared: ${name}`)
      await refreshStatus()
      await refreshConfig()
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
              <div className="aoTop">
                <div className="aoCard">
                  <div className="aoCardHeader">
                    <div className="aoCardTitle">Status</div>
                    <span className="aoPill aoPulse">
                      <span className="aoDot" />
                      <span className="aoPillText">running</span>
                    </span>
                  </div>
                  <div className="aoKvp">
                    <div className="aoKey">Gateway</div>
                    <div className="aoVal">
                      {status.listen.host}:{status.listen.port}
                    </div>
                    <div className="aoKey">Preferred</div>
                    <div className="aoVal">{status.preferred_provider}</div>
                    <div className="aoKey">Override</div>
                    <div className="aoVal">{status.manual_override ?? '(auto)'}</div>
                  </div>
                </div>

                <div className="aoCard">
                  <div className="aoCardHeader">
                    <div className="aoCardTitle">Official (Web)</div>
                    <span className={`aoPill ${status.official_web?.signed_in ? 'aoPulse' : ''}`.trim()}>
                      <span className={status.official_web?.signed_in ? 'aoDot' : 'aoDot aoDotBad'} />
                      <span className="aoPillText">{status.official_web?.signed_in ? 'signed in' : 'signed out'}</span>
                    </span>
                  </div>
                  <div className="aoKvp">
                    <div className="aoKey">Remaining</div>
                    <div className="aoVal">
                      {status.official_web?.remaining != null ? String(status.official_web.remaining) : '-'}
                    </div>
                    <div className="aoKey">Checked</div>
                    <div className="aoVal">
                      {status.official_web?.checked_at_unix_ms ? fmtWhen(status.official_web.checked_at_unix_ms) : '-'}
                    </div>
                  </div>
                  <div className="aoRow" style={{ marginTop: 10, justifyContent: 'flex-end' }}>
                    <button
                      className="aoBtn"
                      onClick={async () => {
                        try {
                          await invoke('official_web_open')
                          flashToast('Official web opened')
                        } catch (e) {
                          flashToast(String(e), 'error')
                        }
                      }}
                    >
                      Open
                    </button>
                    <button
                      className="aoBtn"
                      onClick={async () => {
                        try {
                          await invoke('official_web_close')
                          flashToast('Official web closed')
                        } catch (e) {
                          flashToast(String(e), 'error')
                        }
                      }}
                    >
                      Close
                    </button>
                    <button
                      className="aoBtn aoBtnPrimary"
                      onClick={async () => {
                        try {
                          await invoke('official_web_refresh')
                          flashToast('Checking…')
                        } catch (e) {
                          flashToast(String(e), 'error')
                        }
                      }}
                    >
                      Refresh
                    </button>
                  </div>
                  {status.official_web?.error ? (
                    <div className="aoHint" style={{ marginTop: 8, color: 'rgba(145, 12, 43, 0.92)' }}>
                      {status.official_web.error}
                    </div>
                  ) : null}
                </div>

                <div className="aoCard">
                  <div className="aoCardHeader">
                    <div className="aoCardTitle">Routing</div>
                    <span className={`aoPill ${override === '' ? 'aoPulse' : ''}`.trim()}>
                      <span className={override === '' ? 'aoDot' : 'aoDot aoDotBad'} />
                      <span className="aoPillText">{override === '' ? 'auto' : 'locked'}</span>
                    </span>
                  </div>
                  <div className="aoRow">
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
                  </div>
                  <div className="aoHint" style={{ marginTop: 8 }}>
                    Tip: closing the window hides to tray. Use tray menu to show/quit.
                  </div>
                </div>
              </div>

              <div className="aoSection">
                <div className="aoSectionHeader">
                  <h3 className="aoH3">Providers</h3>
                  <div className="aoHint">tokens are best-effort (from usage.total_tokens)</div>
                </div>
                <table className="aoTable">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Healthy</th>
                      <th>Failures</th>
                      <th>Tokens</th>
                      <th>Cooldown</th>
                      <th>Last OK</th>
                      <th>Last Error</th>
                    </tr>
                  </thead>
                  <tbody>
                    {providers.map((p) => {
                      const h = status.providers[p]
                      const m = status.metrics?.[p]
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
                          <td>{m ? m.total_tokens : 0}</td>
                          <td>{cooldownActive ? fmtWhen(h.cooldown_until_unix_ms) : '-'}</td>
                          <td>{fmtWhen(h.last_ok_at_unix_ms)}</td>
                          <td>{h.last_error ? h.last_error : '-'}</td>
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

                  <div className="aoCard" style={{ paddingBottom: 12 }}>
                    <div className="aoMiniGroup">
                      <div className="aoMiniTitle">Codex auth</div>
                      <div className="aoRow" style={{ flexWrap: 'wrap', marginTop: 8 }}>
                        <div className="aoHint" style={{ minWidth: 120 }}>
                          Gateway token
                        </div>
                        <div className="aoHint" style={{ fontFamily: 'ui-monospace, \"Cascadia Mono\", \"Consolas\", monospace' }}>
                          {gatewayTokenPreview}
                        </div>
                        <button className="aoBtn" onClick={() => setGatewayModalOpen(true)}>
                          Show / Rotate
                        </button>
                      </div>
                      <div className="aoHint" style={{ marginTop: 6 }}>
                        Put this into <span style={{ fontFamily: 'ui-monospace, \"Cascadia Mono\", \"Consolas\", monospace' }}>.codex/auth.json</span> as
                        <span style={{ fontFamily: 'ui-monospace, \"Cascadia Mono\", \"Consolas\", monospace' }}> OPENAI_API_KEY</span>.
                      </div>
                    </div>

                    <div className="aoMiniDivider" />

                    <div className="aoMiniGroup">
                      <div className="aoMiniTitle">Routing defaults</div>
                      <div className="aoRow" style={{ flexWrap: 'wrap', marginTop: 8 }}>
                        <div className="aoHint" style={{ minWidth: 120 }}>
                          Preferred provider
                        </div>
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
                      </div>
                    </div>

                    <div className="aoMiniDivider" />

                    <div className="aoMiniGroup">
                      <div className="aoMiniTitle">Add provider</div>
                      <div className="aoRow" style={{ flexWrap: 'wrap', marginTop: 8 }}>
                        <input
                          className="aoInput"
                          placeholder={nextProviderPlaceholder}
                          value={newProviderName}
                          onChange={(e) => setNewProviderName(e.target.value)}
                        />
                        <input
                          className="aoInput"
                          style={{ width: 360 }}
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

                  <table className="aoTable aoTableFixed" style={{ marginTop: 10 }}>
                    <thead>
                      <tr>
                        <th style={{ width: 130 }}>Name</th>
                        <th style={{ width: 240 }}>Base URL</th>
                        <th style={{ width: 210 }}>Key</th>
                        <th style={{ width: 260 }}>Usage</th>
                        <th style={{ width: 220, textAlign: 'right' }}>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {Object.entries(config.providers).map(([name, p]) => (
                        <tr key={name}>
                          <td style={{ fontFamily: 'ui-monospace, "Cascadia Mono", "Consolas", monospace' }}>{name}</td>
                          <td>
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
                          </td>
                          <td style={{ fontFamily: 'ui-monospace, "Cascadia Mono", "Consolas", monospace' }}>
                            {p.has_key ? (p.key_preview ? p.key_preview : 'set') : 'empty'}
                          </td>
                          <td>
                            {(() => {
                              const q = status?.quota?.[name]
                              const l = status?.ledgers?.[name]
                              const kind = (q?.kind ?? 'none') as 'none' | 'token_stats' | 'budget_info'
                              if (kind === 'none') return <span className="aoHint">-</span>
                              const updated = q?.updated_at_unix_ms ? fmtWhen(q.updated_at_unix_ms) : 'never'
                              const deltaTok = l?.since_last_quota_refresh_total_tokens ?? 0

                              if (q?.last_error) {
                                return (
                                  <div className="aoUsageCell">
                                    <div className="aoUsageTop">
                                      <span className="aoHint">usage</span>
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
                                        <button className="aoTinyBtn" onClick={() => void refreshQuota(name)}>
                                          Refresh
                                        </button>
                                      </div>
                                    </div>
                                    <div className="aoHint">updated: {updated}</div>
                                    <div className="aoUsageErr">{q.last_error}</div>
                                  </div>
                                )
                              }

                              if (kind === 'token_stats') {
                                return (
                                  <div className="aoUsageCell">
                                    <div className="aoUsageTop">
                                      <span className="aoHint">usage</span>
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
                                        <button className="aoTinyBtn" onClick={() => void refreshQuota(name)}>
                                          Refresh
                                        </button>
                                      </div>
                                    </div>
                                    <div className="aoUsageLine">remaining: {q?.remaining ?? '-'}</div>
                                    <div className="aoUsageLine">
                                      today: used {q?.today_used ?? '-'} / added {q?.today_added ?? '-'}
                                    </div>
                                    <div className="aoHint">updated: {updated} · +{deltaTok} tok</div>
                                  </div>
                                )
                              }

                              return (
                                <div className="aoUsageCell">
                                  <div className="aoUsageTop">
                                    <span className="aoHint">usage</span>
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
                                      <button
                                        className="aoTinyBtn"
                                        onClick={() => setUsageTokenModal({ open: true, provider: name, value: '' })}
                                      >
                                        Token
                                      </button>
                                      {p.has_usage_token ? (
                                        <button className="aoTinyBtn" onClick={() => void clearUsageToken(name)}>
                                          Clear
                                        </button>
                                      ) : null}
                                      <button className="aoTinyBtn" onClick={() => void refreshQuota(name)}>
                                        Refresh
                                      </button>
                                    </div>
                                  </div>
                                  <div className="aoUsageLine">
                                    daily: ${q?.daily_spent_usd ?? '-'} / ${q?.daily_budget_usd ?? '-'}
                                  </div>
                                  <div className="aoUsageLine">
                                    monthly: ${q?.monthly_spent_usd ?? '-'} / ${q?.monthly_budget_usd ?? '-'}
                                  </div>
                                  <div className="aoHint">updated: {updated} · +{deltaTok} tok</div>
                                </div>
                              )
                            })()}
                          </td>
                          <td>
                            <div className="aoActions">
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
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}

              <div className="aoSection">
                <div className="aoSectionHeader">
                  <h3 className="aoH3">Events</h3>
                  <div className="aoRow" style={{ gap: 8 }}>
                    <select
                      className="aoSelect"
                      value={String(eventsMax)}
                      onChange={(e) => setEventsMax(Number(e.target.value))}
                      title="Max events shown"
                    >
                      <option value="10">10</option>
                      <option value="20">20</option>
                      <option value="50">50</option>
                      <option value="100">100</option>
                    </select>
                    <button className="aoBtn" onClick={() => setShowEvents((v) => !v)}>
                      {showEvents ? 'Hide' : 'Show'}
                    </button>
                  </div>
                </div>
                {showEvents ? (
                  <div className="aoEventsBox">
                    <ol className="aoEventList">
                      {events.map((e, i) => (
                        <li key={i}>
                          {fmtWhen(e.unix_ms)} [{e.level}] {e.provider}: {e.message}
                        </li>
                      ))}
                    </ol>
                  </div>
                ) : (
                  <div className="aoHint">Hidden (keeps the window compact; click Show when debugging).</div>
                )}
              </div>
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

      {usageTokenModal.open ? (
        <div className="aoModalBackdrop" role="dialog" aria-modal="true">
          <div className="aoModal">
            <div className="aoModalTitle">Usage token</div>
            <div className="aoModalSub">
              Provider:{' '}
              <span style={{ fontFamily: 'ui-monospace, \"Cascadia Mono\", \"Consolas\", monospace' }}>
                {usageTokenModal.provider}
              </span>
              <br />
              Stored in <span style={{ fontFamily: 'ui-monospace, \"Cascadia Mono\", \"Consolas\", monospace' }}>./user-data/secrets.json</span>.
            </div>
            <input
              className="aoInput"
              style={{ width: '100%', height: 36, borderRadius: 12 }}
              placeholder="Paste token..."
              value={usageTokenModal.value}
              onChange={(e) => setUsageTokenModal((m) => ({ ...m, value: e.target.value }))}
            />
            <div className="aoModalActions">
              <button className="aoBtn" onClick={() => setUsageTokenModal({ open: false, provider: '', value: '' })}>
                Cancel
              </button>
              <button className="aoBtn aoBtnPrimary" onClick={() => void saveUsageToken()} disabled={!usageTokenModal.value}>
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
              Optional. If empty, we derive from the provider base_url.
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
