import { useEffect, useMemo, useRef, useState } from 'react'
import { fmtWhen } from '../utils/format'
import { GATEWAY_WINDOWS_HOST, GATEWAY_WSL2_HOST } from '../constants'
import { recordUiTrace } from '../tauriCore'
import './SessionsTable.css'

type SessionRow = {
  id: string
  wt_session?: string | null
  codex_session_id?: string | null
  agent_parent_session_id?: string | null
  reported_model_provider?: string | null
  reported_model?: string | null
  reported_base_url?: string | null
  last_seen_unix_ms: number
  active: boolean
  preferred_provider?: string | null
  current_provider?: string | null
  current_reason?: string | null
  verified?: boolean
  is_agent?: boolean
  is_review?: boolean
}

type Props = {
  sessions: SessionRow[]
  providers: string[]
  globalPreferred: string
  routeMode?: 'follow_preferred_auto' | 'balanced_auto'
  wslGatewayHost?: string
  updating: Record<string, boolean>
  onSetPreferred: (sessionId: string, provider: string | null) => void
  allowPreferredChanges?: boolean
}

export function sessionPreferredPlaceholderLabel(
  globalPreferred: string,
  routeMode: 'follow_preferred_auto' | 'balanced_auto' = 'follow_preferred_auto',
): string {
  if (routeMode === 'balanced_auto') {
    return '(follow balanced mode)'
  }
  return `(follow global: ${globalPreferred})`
}

export function isWslSessionRow(
  s: Pick<SessionRow, 'wt_session' | 'reported_base_url'>,
  wslGatewayHost: string = GATEWAY_WSL2_HOST,
): boolean {
  const wt = (s.wt_session ?? '').trim().toLowerCase()
  if (wt.startsWith('wsl:')) return true

  const base = (s.reported_base_url ?? '').trim().toLowerCase()
  if (!base) return false
  let host = ''
  try {
    host = new URL(base).hostname.toLowerCase()
  } catch {
    host = ''
  }
  if (!host) return false
  if (
    host === GATEWAY_WINDOWS_HOST.toLowerCase() ||
    host === 'localhost' ||
    host === '::1'
  ) {
    return false
  }
  const normalizedWslHost = (wslGatewayHost.trim() || GATEWAY_WSL2_HOST).toLowerCase()
  return host === normalizedWslHost
}

export function compareSessionRowsByOriginThenLastSeen(
  left: Pick<SessionRow, 'id' | 'wt_session' | 'reported_base_url' | 'last_seen_unix_ms'>,
  right: Pick<SessionRow, 'id' | 'wt_session' | 'reported_base_url' | 'last_seen_unix_ms'>,
  wslGatewayHost: string = GATEWAY_WSL2_HOST,
): number {
  const leftIsWsl = isWslSessionRow(left, wslGatewayHost)
  const rightIsWsl = isWslSessionRow(right, wslGatewayHost)
  if (leftIsWsl !== rightIsWsl) return leftIsWsl ? 1 : -1
  // Keep session order stable across refresh ticks; avoid rows jumping as last_seen moves.
  return left.id.localeCompare(right.id)
}

type DisplaySessionRow = {
  row: SessionRow
  parentMainSessionId?: string
}

export type SessionsTableRenderTraceSummary = {
  input_count: number
  always_visible_count: number
  verified_row_count: number
  unverified_row_count: number
  active_count: number
  agent_count: number
  review_count: number
  verified_row_ids_preview: string[]
  unverified_row_ids_preview: string[]
}

export function summarizeSessionsTableRender(
  sessions: SessionRow[],
  alwaysVisibleIds: Set<string>,
  verifiedRows: DisplaySessionRow[],
  unverifiedRows: DisplaySessionRow[],
): SessionsTableRenderTraceSummary {
  return {
    input_count: sessions.length,
    always_visible_count: alwaysVisibleIds.size,
    verified_row_count: verifiedRows.length,
    unverified_row_count: unverifiedRows.length,
    active_count: sessions.filter((session) => session.active).length,
    agent_count: sessions.filter((session) => session.is_agent === true).length,
    review_count: sessions.filter((session) => session.is_review === true).length,
    verified_row_ids_preview: verifiedRows.slice(0, 12).map((entry) => entry.row.id),
    unverified_row_ids_preview: unverifiedRows.slice(0, 12).map((entry) => entry.row.id),
  }
}

export function sessionsTableRenderTraceSignature(
  sessions: SessionRow[],
  alwaysVisibleIds: Set<string>,
  verifiedRows: DisplaySessionRow[],
  unverifiedRows: DisplaySessionRow[],
): string {
  const encodeRows = (rows: DisplaySessionRow[]) =>
    rows
      .map((entry) =>
        [
          entry.row.id,
          entry.parentMainSessionId ?? '',
          entry.row.current_provider ?? '',
          entry.row.current_reason ?? '',
          entry.row.preferred_provider ?? '',
          entry.row.active ? '1' : '0',
          entry.row.verified === false ? '0' : '1',
          entry.row.is_agent === true ? '1' : '0',
          entry.row.is_review === true ? '1' : '0',
        ].join('|'),
      )
      .join('\n')

  return [
    `input:${sessions.length}`,
    `always:${[...alwaysVisibleIds].sort().join(',')}`,
    `verified:${encodeRows(verifiedRows)}`,
    `unverified:${encodeRows(unverifiedRows)}`,
  ].join('\n---\n')
}

function sessionIdsAlwaysVisible(rows: SessionRow[]): Set<string> {
  const ids = new Set<string>()
  for (const row of rows) {
    const isAgentOrReview = row.is_agent === true || row.is_review === true
    if (!isAgentOrReview) continue
    ids.add(row.id)
    const parentMainSessionId = (row.agent_parent_session_id ?? '').trim()
    if (parentMainSessionId) {
      ids.add(parentMainSessionId)
    }
  }
  return ids
}

export function arrangeSessionRowsByMainParent(
  rows: SessionRow[],
  wslGatewayHost: string = GATEWAY_WSL2_HOST,
): DisplaySessionRow[] {
  const sortedRows = [...rows].sort((left, right) =>
    compareSessionRowsByOriginThenLastSeen(left, right, wslGatewayHost),
  )
  const mainRowsById = new Map(
    sortedRows
      .filter((row) => !(row.is_agent === true || row.is_review === true))
      .map((row) => [row.id, row]),
  )
  const childRowsByMainSessionId = new Map<string, SessionRow[]>()
  const rootRows: SessionRow[] = []

  for (const row of sortedRows) {
    const isAgentOrReview = row.is_agent === true || row.is_review === true
    const parentMainSessionId = (row.agent_parent_session_id ?? '').trim()
    const parentMainRow = parentMainSessionId ? mainRowsById.get(parentMainSessionId) : undefined
    const parentReadyForChild =
      !!parentMainRow &&
      parentMainRow.verified !== false &&
      !!(parentMainRow.current_provider ?? '').trim()
    if (isAgentOrReview && parentReadyForChild) {
      const rowsForMainSession = childRowsByMainSessionId.get(parentMainSessionId) ?? []
      rowsForMainSession.push(row)
      childRowsByMainSessionId.set(parentMainSessionId, rowsForMainSession)
      continue
    }
    rootRows.push(row)
  }

  const displayRows: DisplaySessionRow[] = []
  for (const row of rootRows) {
    displayRows.push({ row })
    const childRows = childRowsByMainSessionId
      .get(row.id)
      ?.sort((left, right) =>
        compareSessionRowsByOriginThenLastSeen(left, right, wslGatewayHost),
      ) ?? []
    for (const childRow of childRows) {
      displayRows.push({ row: childRow, parentMainSessionId: row.id })
    }
  }
  return displayRows
}

export function SessionsTable({
  sessions,
  providers,
  globalPreferred,
  routeMode = 'follow_preferred_auto',
  wslGatewayHost = GATEWAY_WSL2_HOST,
  updating,
  onSetPreferred,
  allowPreferredChanges = true,
}: Props) {
  function codexSessionIdOnly(raw: string | null | undefined): string | null {
    const v = (raw ?? '').trim()
    if (!v) return null
    // Legacy synthetic ids can be WT_SESSION-derived (e.g. `wsl:<wt-session>`).
    // Keep UI strict: Codex session column only shows real Codex session ids.
    if (v.toLowerCase().startsWith('wsl:')) return null
    return v
  }

  function isWslSession(s: SessionRow): boolean {
    return isWslSessionRow(s, wslGatewayHost)
  }

  function codexProviderLabel(s: SessionRow): string {
    const verified = s.verified !== false
    const isAgent = s.is_agent === true
    const isReview = isAgent && s.is_review === true
    if (isReview) return 'review'
    if (isAgent) return 'agents'
    // If session is still unverified and we have no base_url evidence, provider id is often just
    // startup config hint and can be misleading.
    if (!verified && !(s.reported_base_url ?? '').trim()) return '-'
    return s.reported_model_provider ?? '-'
  }

  const alwaysVisibleIds = sessionIdsAlwaysVisible(sessions)
  const verifiedRows = arrangeSessionRowsByMainParent(
    sessions.filter((s) => s.verified !== false || alwaysVisibleIds.has(s.id)),
    wslGatewayHost,
  )
  const unverifiedRows = arrangeSessionRowsByMainParent(
    sessions.filter((s) => s.verified === false && !alwaysVisibleIds.has(s.id)),
    wslGatewayHost,
  )
  const displayTrace = useMemo(
    () => ({
      summary: summarizeSessionsTableRender(
        sessions,
        alwaysVisibleIds,
        verifiedRows,
        unverifiedRows,
      ),
      signature: sessionsTableRenderTraceSignature(
        sessions,
        alwaysVisibleIds,
        verifiedRows,
        unverifiedRows,
      ),
    }),
    [alwaysVisibleIds, sessions, unverifiedRows, verifiedRows],
  )
  const lastDisplayTraceSignatureRef = useRef<string | null>(null)
  useEffect(() => {
    if (lastDisplayTraceSignatureRef.current === displayTrace.signature) return
    lastDisplayTraceSignatureRef.current = displayTrace.signature
    recordUiTrace('sessions.table_render', displayTrace.summary)
  }, [displayTrace])
  const [showUnverified, setShowUnverified] = useState(false)

  const renderSessionRows = (rows: DisplaySessionRow[]) => {
    const mainProviderBySessionId = new Map(
      rows
        .filter((entry) => !entry.parentMainSessionId)
        .map((entry) => [entry.row.id, (entry.row.current_provider ?? '').trim()]),
    )
    const mainReasonBySessionId = new Map(
      rows
        .filter((entry) => !entry.parentMainSessionId)
        .map((entry) => [entry.row.id, (entry.row.current_reason ?? '').trim()]),
    )
    const mainCodexProviderBySessionId = new Map(
      rows
        .filter((entry) => !entry.parentMainSessionId)
        .map((entry) => [entry.row.id, codexProviderLabel(entry.row)]),
    )
    const mainIsWslBySessionId = new Map(
      rows
        .filter((entry) => !entry.parentMainSessionId)
        .map((entry) => [entry.row.id, isWslSession(entry.row)]),
    )
    return rows.map((entry) => {
      const s = entry.row
      const parentMainSessionId = entry.parentMainSessionId
      const isChildRow = !!parentMainSessionId
      const verified = s.verified !== false
      const inheritedMainProvider = isChildRow
        ? mainProviderBySessionId.get(parentMainSessionId) ?? ''
        : ''
      const inheritedMainReason = isChildRow
        ? mainReasonBySessionId.get(parentMainSessionId) ?? ''
        : ''
      const currentProviderRaw = isChildRow ? inheritedMainProvider : (s.current_provider ?? '')
      const currentProvider = currentProviderRaw.trim() || '-'
      const currentReasonRaw = isChildRow ? inheritedMainReason : (s.current_reason ?? '')
      const currentReason = currentReasonRaw.trim()
      const codexSession = codexSessionIdOnly(s.codex_session_id)
      const wt = s.wt_session ?? '-'
      const isAgent = s.is_agent === true
      const codexProvider = isChildRow
        ? (mainCodexProviderBySessionId.get(parentMainSessionId) ?? codexProviderLabel(s))
        : codexProviderLabel(s)
      const modelName = s.reported_model ?? '-'
      const wsl = isChildRow
        ? (mainIsWslBySessionId.get(parentMainSessionId) ?? isWslSession(s))
        : isWslSession(s)
      const originClass = wsl ? 'aoSessionsIdWsl2' : 'aoSessionsIdWindows'
      const sessionIdClass = isChildRow ? `${originClass} aoSessionsIdChild` : originClass
      const originBadgeClass = wsl
        ? 'aoSessionOriginBadge aoSessionOriginBadgeWsl'
        : 'aoSessionOriginBadge aoSessionOriginBadgeWindows'
      const originLabel = wsl ? 'WSL2' : 'WIN'
      const rowClass = [
        !isChildRow && isAgent
          ? (wsl ? 'aoSessionRowAgent aoSessionRowAgentWsl' : 'aoSessionRowAgent')
          : '',
        isChildRow ? 'aoSessionRowChild' : '',
      ]
        .join(' ')
        .trim()
      const childRoleLabel = isAgent
        ? s.is_review === true
          ? 'REVIEW'
          : 'AGENT'
        : null
      const title = isChildRow
        ? `WT_SESSION: ${wt}\nparent main session: ${parentMainSessionId}`
        : `WT_SESSION: ${wt}`
      return (
        <tr key={s.id} className={rowClass || undefined}>
          <td className="aoSessionsMono">
            {codexSession ? (
              <div className={sessionIdClass} title={title}>
                {!isChildRow && <span className={originBadgeClass}>{originLabel}</span>}
                {childRoleLabel && (
                  <span className="aoSessionChildRoleBadge">{childRoleLabel}</span>
                )}
                {codexSession}
              </div>
            ) : (
              <div className={sessionIdClass} title={title}>-</div>
            )}
          </td>
          <td className="aoSessionsCellCenter">
            <div className="aoSessionsCellCenterInner">
              <span className="aoPill">
                <span className={verified && s.active ? 'aoDot' : 'aoDot aoDotMuted'} />
                <span className="aoPillText">{verified ? (s.active ? 'active' : 'idle') : 'unverified'}</span>
              </span>
            </div>
          </td>
          <td>{fmtWhen(s.last_seen_unix_ms)}</td>
          <td className="aoSessionsMono">{codexProvider}</td>
          <td className="aoSessionsMono">{modelName}</td>
          <td className="aoSessionsMono" title={currentReason}>{currentProvider}</td>
          <td>
            <div className="aoSessionsActions">
              <select
                className="aoSelect aoSessionsPreferredSelect"
                value={s.preferred_provider ?? ''}
                disabled={!!updating[s.id] || !allowPreferredChanges || !verified || !codexSession || isAgent}
                onChange={(e) => {
                  const v = e.target.value
                  onSetPreferred(s.id, v ? v : null)
                }}
              >
                <option value="">{sessionPreferredPlaceholderLabel(globalPreferred, routeMode)}</option>
                {providers.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </div>
          </td>
        </tr>
      )
    })
  }

  return (
    <table className="aoTable aoTableFixed">
      <thead>
        <tr>
          <th style={{ width: 200 }}>Codex session</th>
          <th className="aoSessionsCellCenter" style={{ width: 110 }}>
            State
          </th>
          <th style={{ width: 150 }}>Last seen</th>
          <th style={{ width: 160 }}>Codex provider</th>
          <th style={{ width: 130 }}>Model</th>
          <th>Current provider</th>
          <th style={{ width: 260 }}>Preferred provider</th>
        </tr>
      </thead>
      <tbody>
        {sessions.length ? (
          <>
            {verifiedRows.length ? (
              renderSessionRows(verifiedRows)
            ) : (
              <tr>
                <td colSpan={7} className="aoHint">
                  No verified sessions yet.
                </td>
              </tr>
            )}

            {!!unverifiedRows.length && (
              <tr>
                <td colSpan={7} className="aoHint">
                  <button
                    type="button"
                    className="aoIconGhost"
                    style={{ padding: 0, marginRight: 8 }}
                    onClick={() => setShowUnverified((v) => !v)}
                    aria-label={showUnverified ? 'Hide unverified sessions' : 'Show unverified sessions'}
                    title={showUnverified ? 'Hide unverified sessions' : 'Show unverified sessions'}
                  >
                    {showUnverified ? '[-]' : '[+]'}
                  </button>
                  <button
                    type="button"
                    className="aoHint"
                    style={{
                      background: 'transparent',
                      border: 'none',
                      padding: 0,
                      cursor: 'pointer',
                    }}
                    onClick={() => setShowUnverified((v) => !v)}
                  >
                    Unverified (no request yet): {unverifiedRows.length}
                  </button>
                </td>
              </tr>
            )}

            {showUnverified && (
              <>
                <tr>
                  <td colSpan={7} className="aoHint">
                    Discovered in Windows Terminal, but API Router can&apos;t confirm their base_url yet. They&apos;ll become verified after the first request goes through the gateway.
                  </td>
                </tr>
                {renderSessionRows(unverifiedRows)}
              </>
            )}
          </>
        ) : (
          <tr>
            <td colSpan={7} className="aoHint">
              No sessions yet. Start Codex from Windows Terminal. If Codex is configured to use API Router, it should appear here even before the first request.
            </td>
          </tr>
        )}
      </tbody>
    </table>
  )
}
