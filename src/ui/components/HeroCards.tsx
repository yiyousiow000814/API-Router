import type { Config, Status } from '../types'
import { fmtWhen, parsePct } from '../utils/format'

type HeroStatusProps = {
  status: Status
  gatewayTokenPreview: string
  onCopyToken: () => void
  onShowRotate: () => void
}

export function HeroStatusCard({
  status,
  gatewayTokenPreview,
  onCopyToken,
  onShowRotate,
}: HeroStatusProps) {
  return (
    <div className="aoCard aoHeroCard aoHeroStatus">
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
        <button className="aoIconBtn" title="Copy gateway token" aria-label="Copy gateway token" onClick={onCopyToken}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M9 9h9a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2Z" />
            <path d="M15 9V7a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
          </svg>
        </button>
        <button className="aoBtn" onClick={onShowRotate}>
          Show / Rotate
        </button>
      </div>
      <div className="aoHint">
        Put this into{' '}
        <span style={{ fontFamily: 'ui-monospace, "Cascadia Mono", "Consolas", monospace' }}>
          .codex/auth.json
        </span>{' '}
        as
        <span style={{ fontFamily: 'ui-monospace, "Cascadia Mono", "Consolas", monospace' }}>
          {' '}
          OPENAI_API_KEY
        </span>
        .
      </div>
    </div>
  )
}

type HeroCodexProps = {
  status: Status
  onLoginLogout: () => void
  onRefresh: () => void
}

export function HeroCodexCard({ status, onLoginLogout, onRefresh }: HeroCodexProps) {
  return (
    <div className="aoCard aoHeroCard aoHeroCodex">
      <div className="aoCardHeader">
        <div className="aoCardTitle">Codex (Auth)</div>
        <span className={`aoPill ${status.codex_account?.signed_in ? 'aoPulse' : ''}`.trim()}>
          <span className={status.codex_account?.signed_in ? 'aoDot' : 'aoDot aoDotBad'} />
          <span className="aoPillText">{status.codex_account?.signed_in ? 'signed in' : 'signed out'}</span>
        </span>
      </div>
      <div className="aoKvp">
        <div className="aoKey">Checked</div>
        <div className="aoVal">
          {status.codex_account?.checked_at_unix_ms ? fmtWhen(status.codex_account.checked_at_unix_ms) : '-'}
        </div>
      </div>
      <div className="aoDivider" />
      <div className="aoLimitGrid">
        <div className="aoLimitCard">
          <div className="aoMiniLabel">5-hour limit</div>
          <div className="aoLimitValue">
            {status.codex_account?.limit_5h_remaining ?? (parsePct(status.codex_account?.remaining) ?? '-')}
          </div>
        </div>
        <div className="aoLimitCard">
          <div className="aoMiniLabel">Weekly limit</div>
          <div className="aoLimitValue">
            {status.codex_account?.limit_weekly_remaining ?? (parsePct(status.codex_account?.remaining) ?? '-')}
          </div>
        </div>
        <div className="aoLimitCard">
          <div className="aoMiniLabel">Code review</div>
          <div className="aoLimitValue">
            {status.codex_account?.code_review_remaining ?? status.codex_account?.limit_5h_remaining ?? '-'}
          </div>
        </div>
      </div>
      <div className="aoHeroActions" style={{ marginTop: 15 }}>
        <button
          className={`aoBtn ${status.codex_account?.signed_in ? 'aoBtnDanger' : ''}`.trim()}
          onClick={onLoginLogout}
        >
          {status.codex_account?.signed_in ? 'Log out' : 'Log in'}
        </button>
        <button className="aoBtn aoBtnPrimary" onClick={onRefresh}>
          Refresh
        </button>
      </div>
      {status.codex_account?.error ? (
        <div className="aoHint" style={{ marginTop: 8, color: 'rgba(145, 12, 43, 0.92)' }}>
          {status.codex_account.error}
        </div>
      ) : null}
    </div>
  )
}

type HeroRoutingProps = {
  config: Config | null
  providers: string[]
  override: string
  onOverrideChange: (next: string) => void
  onPreferredChange: (next: string) => void
}

export function HeroRoutingCard({
  config,
  providers,
  override,
  onOverrideChange,
  onPreferredChange,
}: HeroRoutingProps) {
  return (
    <div className="aoCard aoHeroCard aoHeroRouting">
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
            <select className="aoSelect" value={override} onChange={(e) => onOverrideChange(e.target.value)}>
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
              onChange={(e) => onPreferredChange(e.target.value)}
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
  )
}
