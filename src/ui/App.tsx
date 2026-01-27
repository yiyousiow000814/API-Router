import { useEffect, useMemo, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'

type ProviderHealth = {
  is_healthy: boolean
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
      supports_chat_completions: boolean
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
      supportsChatCompletions: p.supports_chat_completions,
    })
    await refresh()
  }

  async function deleteProvider(name: string) {
    await invoke('delete_provider', { name })
    await refresh()
  }

  async function setKey(name: string) {
    const key = window.prompt(`Set API key for provider "${name}" (stored in Windows Credential Manager):`, '')
    if (!key) return
    await invoke('set_provider_key', { provider: name, key })
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
      supportsChatCompletions: true,
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
    <div style={{ maxWidth: 980, margin: '0 auto', padding: 24 }}>
      <h2 style={{ marginTop: 0 }}>Agent Orchestrator</h2>

      {err ? (
        <div style={{ padding: 12, border: '1px solid #a33', background: '#2a0f0f' }}>
          UI error: {err}
        </div>
      ) : null}

      {!status ? (
        <div>Loading…</div>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            <div style={{ padding: 12, border: '1px solid #333', borderRadius: 8, minWidth: 260 }}>
              <div>
                Gateway: {status.listen.host}:{status.listen.port}
              </div>
              <div>Preferred: {status.preferred_provider}</div>
              <div>Manual override: {status.manual_override ?? '(auto)'}</div>
            </div>

            <div style={{ padding: 12, border: '1px solid #333', borderRadius: 8, minWidth: 260 }}>
              <div style={{ marginBottom: 8 }}>Routing</div>
              <select value={override} onChange={(e) => setOverride(e.target.value)}>
                <option value="">Auto (preferred + failover)</option>
                {providers.map((p) => (
                  <option key={p} value={p}>
                    Lock to: {p}
                  </option>
                ))}
              </select>
              <button style={{ marginLeft: 8 }} onClick={() => void applyOverride(override)}>
                Apply
              </button>
            </div>
          </div>

          <h3>Providers</h3>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', borderBottom: '1px solid #333', padding: '8px 4px' }}>Name</th>
                <th style={{ textAlign: 'left', borderBottom: '1px solid #333', padding: '8px 4px' }}>Healthy</th>
                <th style={{ textAlign: 'left', borderBottom: '1px solid #333', padding: '8px 4px' }}>Failures</th>
                <th style={{ textAlign: 'left', borderBottom: '1px solid #333', padding: '8px 4px' }}>Tokens</th>
                <th style={{ textAlign: 'left', borderBottom: '1px solid #333', padding: '8px 4px' }}>Cooldown</th>
                <th style={{ textAlign: 'left', borderBottom: '1px solid #333', padding: '8px 4px' }}>Last OK</th>
                <th style={{ textAlign: 'left', borderBottom: '1px solid #333', padding: '8px 4px' }}>Last Error</th>
              </tr>
            </thead>
            <tbody>
              {providers.map((p) => {
                const h = status.providers[p]
                const m = status.metrics?.[p]
                const cooldownActive = h.cooldown_until_unix_ms > Date.now()
                return (
                  <tr key={p}>
                    <td style={{ padding: '6px 4px', borderBottom: '1px solid #222' }}>{p}</td>
                    <td style={{ padding: '6px 4px', borderBottom: '1px solid #222' }}>
                      {h.is_healthy ? 'yes' : 'no'}
                    </td>
                    <td style={{ padding: '6px 4px', borderBottom: '1px solid #222' }}>
                      {h.consecutive_failures}
                    </td>
                    <td style={{ padding: '6px 4px', borderBottom: '1px solid #222' }}>
                      {m ? m.total_tokens : 0}
                    </td>
                    <td style={{ padding: '6px 4px', borderBottom: '1px solid #222' }}>
                      {cooldownActive ? `until ${fmtWhen(h.cooldown_until_unix_ms)}` : '-'}
                    </td>
                    <td style={{ padding: '6px 4px', borderBottom: '1px solid #222' }}>{fmtWhen(h.last_ok_at_unix_ms)}</td>
                    <td style={{ padding: '6px 4px', borderBottom: '1px solid #222' }}>
                      {h.last_error ? h.last_error : '-'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>

          {config ? (
            <>
              <h3>Config</h3>
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
                <div>Preferred provider:</div>
                <select value={config.routing.preferred_provider} onChange={(e) => void setPreferred(e.target.value)}>
                  {Object.keys(config.providers).map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
              </div>

              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12, alignItems: 'center' }}>
                <div>Add provider:</div>
                <input
                  placeholder="name"
                  value={newProviderName}
                  onChange={(e) => setNewProviderName(e.target.value)}
                />
                <input
                  style={{ minWidth: 340 }}
                  placeholder="base_url (e.g. http://127.0.0.1:4001 or https://api.example.com)"
                  value={newProviderBaseUrl}
                  onChange={(e) => setNewProviderBaseUrl(e.target.value)}
                />
                <button onClick={() => void addProvider()}>Add</button>
              </div>

              <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 12 }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: 'left', borderBottom: '1px solid #333', padding: '8px 4px' }}>Name</th>
                    <th style={{ textAlign: 'left', borderBottom: '1px solid #333', padding: '8px 4px' }}>Base URL</th>
                    <th style={{ textAlign: 'left', borderBottom: '1px solid #333', padding: '8px 4px' }}>Capabilities</th>
                    <th style={{ textAlign: 'left', borderBottom: '1px solid #333', padding: '8px 4px' }}>Key</th>
                    <th style={{ textAlign: 'left', borderBottom: '1px solid #333', padding: '8px 4px' }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(config.providers).map(([name, p]) => (
                    <tr key={name}>
                      <td style={{ padding: '6px 4px', borderBottom: '1px solid #222' }}>{name}</td>
                      <td style={{ padding: '6px 4px', borderBottom: '1px solid #222' }}>
                        <input
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
                      <td style={{ padding: '6px 4px', borderBottom: '1px solid #222' }}>
                        <label style={{ marginRight: 8 }}>
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
                          />{' '}
                          responses
                        </label>
                        <label>
                          <input
                            type="checkbox"
                            checked={p.supports_chat_completions}
                            onChange={(e) =>
                              setConfig((c) =>
                                c
                                  ? {
                                      ...c,
                                      providers: {
                                        ...c.providers,
                                        [name]: { ...c.providers[name], supports_chat_completions: e.target.checked },
                                      },
                                    }
                                  : c,
                              )
                            }
                          />{' '}
                          chat
                        </label>
                      </td>
                      <td style={{ padding: '6px 4px', borderBottom: '1px solid #222' }}>{p.has_key ? 'set' : 'empty'}</td>
                      <td style={{ padding: '6px 4px', borderBottom: '1px solid #222' }}>
                        <button onClick={() => void saveProvider(name)}>Save</button>
                        <button style={{ marginLeft: 6 }} onClick={() => void setKey(name)}>
                          Set key
                        </button>
                        <button style={{ marginLeft: 6 }} onClick={() => void clearKey(name)}>
                          Clear key
                        </button>
                        <button style={{ marginLeft: 6 }} onClick={() => void deleteProvider(name)}>
                          Delete
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : null}

          <h3>Recent Events</h3>
          <ol>
            {status.recent_events.map((e, i) => (
              <li key={i}>
                {fmtWhen(e.unix_ms)} [{e.level}] {e.provider}: {e.message}
              </li>
            ))}
          </ol>
        </>
      )}
    </div>
  )
}
