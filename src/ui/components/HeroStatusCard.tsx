import type { Status } from '../types'

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
      <div className="aoTokenRow">
        <div className="aoStatLabel">Gateway token</div>
        <div className="aoTokenRowRight">
          <div className="aoVal aoValSmall">{gatewayTokenPreview}</div>
          <button
            className="aoIconBtn"
            title="Copy gateway token"
            aria-label="Copy gateway token"
            onClick={onCopyToken}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M9 9h9a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2Z" />
              <path d="M15 9V7a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
            </svg>
          </button>
          <button className="aoBtn" onClick={onShowRotate}>
            Show / Rotate
          </button>
        </div>
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