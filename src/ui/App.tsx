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
      supports_responses: boolean
      has_key: boolean
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
  const [err, setErr] = useState<string>('')
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

  const containerRef = useRef<HTMLDivElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)

  const providers = useMemo(() => Object.keys(status?.providers ?? {}), [status])

  async function refresh() {
    try {
      const s = await invoke<Status>('get_status')
      setStatus(s)
      setOverride(s.manual_override ?? '')
      const c = await invoke<Config>('get_config')
      setConfig(c)
      setErr('')
    } catch (e) {
      setErr(String(e))
    }
  }

  const events = useMemo(() => (status?.recent_events ?? []).slice(0, eventsMax), [status, eventsMax])

  async function applyOverride(next: string) {
    await invoke('set_manual_override', { provider: next === '' ? null : next })
    await refresh()
  }

  async function setPreferred(next: string) {
    await invoke('set_preferred_provider', { provider: next })
    await refresh()
  }

  async function saveProvider(name: string) {
    if (!config) return
    const p = config.providers[name]
    await invoke('upsert_provider', {
      name,
      displayName: p.display_name,
      baseUrl: p.base_url,
      supportsResponses: p.supports_responses,
    })
    await refresh()
  }

  async function deleteProvider(name: string) {
    await invoke('delete_provider', { name })
    await refresh()
  }

  async function saveKey() {
    const provider = keyModal.provider
    const key = keyModal.value
    if (!provider || !key) return
    await invoke('set_provider_key', { provider, key })
    setKeyModal({ open: false, provider: '', value: '' })
    await refresh()
  }

  async function clearKey(name: string) {
    await invoke('clear_provider_key', { provider: name })
    await refresh()
  }

  async function addProvider() {
    const name = newProviderName.trim()
    const baseUrl = newProviderBaseUrl.trim()
    if (!name || !baseUrl) return

    await invoke('upsert_provider', {
      name,
      displayName: name,
      baseUrl,
      supportsResponses: true,
    })
    setNewProviderName('')
    setNewProviderBaseUrl('')
    await refresh()
  }

  useEffect(() => {
    void refresh()
    const t = setInterval(() => void refresh(), 1500)
    return () => clearInterval(t)
  }, [])

  return (
    <div className="aoRoot" ref={containerRef}>
      <div className="aoScale">
        <div className="aoShell" ref={contentRef}>
          <div className="aoBrand">
            <img className="aoMark" src="/ao-icon.png" alt="Agent Orchestrator icon" />
            <div>
              <div className="aoTitle">Agent Orchestrator</div>
              <div className="aoSubtitle">Local gateway + smart failover for Codex</div>
            </div>
          </div>

          {err ? <div className="aoErrorBanner">UI error: {err}</div> : null}

          {!status ? (
            <div className="aoHint">Loading…</div>
          ) : (
            <>
              <div className="aoTop">
                <div className="aoCard">
                  <div className="aoCardHeader">
                    <div className="aoCardTitle">Status</div>
                    <span className="aoPill">
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
                    <div className="aoCardTitle">Routing</div>
                    <span className="aoPill">
                      <span className={override === '' ? 'aoDot' : 'aoDot aoDotBad'} />
                      <span className="aoPillText">{override === '' ? 'auto' : 'locked'}</span>
                    </span>
                  </div>
                  <div className="aoRow">
                    <select className="aoSelect" value={override} onChange={(e) => setOverride(e.target.value)}>
                      <option value="">Auto (preferred + failover)</option>
                      {providers.map((p) => (
                        <option key={p} value={p}>
                          Lock to: {p}
                        </option>
                      ))}
                    </select>
                    <button className="aoBtn aoBtnPrimary" onClick={() => void applyOverride(override)}>
                      Apply
                    </button>
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
                    <div className="aoHint">keys are stored in Windows Credential Manager</div>
                  </div>

                  <div className="aoCard" style={{ paddingBottom: 12 }}>
                    <div className="aoRow" style={{ flexWrap: 'wrap' }}>
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

                    <div className="aoRow" style={{ flexWrap: 'wrap', marginTop: 10 }}>
                      <div className="aoHint" style={{ minWidth: 120 }}>
                        Add provider
                      </div>
                      <input
                        className="aoInput"
                        placeholder="name"
                        value={newProviderName}
                        onChange={(e) => setNewProviderName(e.target.value)}
                      />
                      <input
                        className="aoInput"
                        style={{ width: 360 }}
                        placeholder="base_url (e.g. http://127.0.0.1:4001 or https://api.example.com)"
                        value={newProviderBaseUrl}
                        onChange={(e) => setNewProviderBaseUrl(e.target.value)}
                      />
                      <button className="aoBtn aoBtnPrimary" onClick={() => void addProvider()}>
                        Add
                      </button>
                    </div>
                  </div>

                  <table className="aoTable" style={{ marginTop: 10 }}>
                    <thead>
                      <tr>
                        <th style={{ width: 120 }}>Name</th>
                        <th>Base URL</th>
                        <th style={{ width: 190 }}>Capabilities</th>
                        <th style={{ width: 90 }}>Key</th>
                        <th style={{ width: 340, textAlign: 'right' }}>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {Object.entries(config.providers).map(([name, p]) => (
                        <tr key={name}>
                          <td style={{ fontFamily: 'ui-monospace, "Cascadia Mono", "Consolas", monospace' }}>{name}</td>
                          <td>
                            <input
                              className="aoInput"
                              style={{ width: '100%' }}
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
                          <td>
                            <div className="aoRow" style={{ gap: 10 }}>
                              <label className="aoCheckbox">
                                <input
                                  type="checkbox"
                                  checked={p.supports_responses}
                                  onChange={(e) =>
                                    setConfig((c) =>
                                      c
                                        ? {
                                            ...c,
                                            providers: {
                                              ...c.providers,
                                              [name]: { ...c.providers[name], supports_responses: e.target.checked },
                                            },
                                          }
                                        : c,
                                    )
                                  }
                                />
                                responses
                              </label>
                            </div>
                          </td>
                          <td>{p.has_key ? 'set' : 'empty'}</td>
                          <td>
                            <div className="aoActions">
                              <button className="aoBtn" onClick={() => void saveProvider(name)}>
                                Save
                              </button>
                              <button
                                className="aoBtn"
                                onClick={() => setKeyModal({ open: true, provider: name, value: '' })}
                              >
                                Set key
                              </button>
                              <button className="aoBtn" onClick={() => void clearKey(name)}>
                                Clear key
                              </button>
                              <button className="aoBtn aoBtnDanger" onClick={() => void deleteProvider(name)}>
                                Delete
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
              Stored in Windows Credential Manager.
            </div>
            <input
              className="aoInput"
              style={{ width: '100%', height: 36, borderRadius: 12 }}
              placeholder="Paste API key…"
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
    </div>
  )
}
