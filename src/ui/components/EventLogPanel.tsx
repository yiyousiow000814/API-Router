import { invoke } from '@tauri-apps/api/core'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Status } from '../types'
import { DashboardEventsSection } from './DashboardEventsSection'
import './EventLogPanel.css'

type Props = {
  events: Status['recent_events']
}

type EventLevel = 'info' | 'warning' | 'error'
type DateAnchor = 'from' | 'to'
type EventLogEntry = Status['recent_events'][number]
type EventLogChartHover = {
  x: number
  y: number
  dayStartMs: number
  infos: number
  warnings: number
  errors: number
}

const MS_PER_DAY = 24 * 60 * 60 * 1000
const CHART_WINDOW_DAYS = 60
const EVENT_LOG_TABLE_LIMIT = 200
const EVENT_LOG_FETCH_LIMIT = 2000
const ALL_LEVELS: EventLevel[] = ['info', 'warning', 'error']
const EVENT_LOG_UI_STATE: {
  selectedLevels: EventLevel[]
  searchText: string
  dateFrom: string
  dateTo: string
} = {
  selectedLevels: [...ALL_LEVELS],
  searchText: '',
  dateFrom: '',
  dateTo: '',
}

function startOfDayMs(unixMs: number): number {
  const d = new Date(unixMs)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

function formatShortDay(unixMs: number): string {
  return new Date(unixMs).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  })
}

function startOfMonthMs(unixMs: number): number {
  const d = new Date(unixMs)
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime()
}

function addMonths(unixMs: number, delta: number): number {
  const d = new Date(unixMs)
  return new Date(d.getFullYear(), d.getMonth() + delta, 1).getTime()
}

function addDays(unixMs: number, delta: number): number {
  const d = new Date(unixMs)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + delta).getTime()
}

function dayIndex(unixMs: number): number {
  const d = new Date(unixMs)
  return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / MS_PER_DAY)
}

function dayStartToIso(unixMs: number): string {
  const d = new Date(unixMs)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function fmtDayMonthYear(unixMs: number): string {
  const d = new Date(unixMs)
  const day = String(d.getDate()).padStart(2, '0')
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const y = d.getFullYear()
  return `${day}-${m}-${y}`
}

function buildSearchText(e: Status['recent_events'][number]): string {
  const fields = e.fields ?? {}
  const codexSession = typeof fields['codex_session_id'] === 'string' ? fields['codex_session_id'] : ''
  const legacySession = typeof fields['session_id'] === 'string' ? fields['session_id'] : ''
  const wtSession = typeof fields['wt_session'] === 'string' ? fields['wt_session'] : ''
  return `${e.provider} ${e.level} ${e.code} ${e.message} ${codexSession} ${legacySession} ${wtSession}`.toLowerCase()
}

function parseDateInputToDayStart(dateText: string): number | null {
  const t = dateText.trim()
  if (!t) return null
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t)
  if (!m) return null
  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  const dt = new Date(year, month - 1, day)
  if (Number.isNaN(dt.getTime())) return null
  if (dt.getFullYear() !== year || dt.getMonth() + 1 !== month || dt.getDate() !== day) return null
  return new Date(dt.getFullYear(), dt.getMonth(), dt.getDate()).getTime()
}

export function EventLogPanel({ events }: Props) {
  const [sourceEvents, setSourceEvents] = useState<EventLogEntry[]>(() =>
    [...events].sort((a, b) => b.unix_ms - a.unix_ms),
  )
  const [selectedLevels, setSelectedLevels] = useState<EventLevel[]>(() => {
    const levels = EVENT_LOG_UI_STATE.selectedLevels.filter((level) => ALL_LEVELS.includes(level))
    return levels.length ? levels : [...ALL_LEVELS]
  })
  const [searchText, setSearchText] = useState<string>(EVENT_LOG_UI_STATE.searchText)
  const [dateFrom, setDateFrom] = useState<string>(EVENT_LOG_UI_STATE.dateFrom)
  const [dateTo, setDateTo] = useState<string>(EVENT_LOG_UI_STATE.dateTo)
  const [openDatePicker, setOpenDatePicker] = useState<boolean>(false)
  const [dateAnchor, setDateAnchor] = useState<DateAnchor>('from')
  const [pickerDateFrom, setPickerDateFrom] = useState<string>(EVENT_LOG_UI_STATE.dateFrom)
  const [pickerDateTo, setPickerDateTo] = useState<string>(EVENT_LOG_UI_STATE.dateTo)
  const [pickerMonthStartMs, setPickerMonthStartMs] = useState<number>(startOfMonthMs(Date.now()))
  const [chartHover, setChartHover] = useState<EventLogChartHover | null>(null)
  const datePickerRef = useRef<HTMLDivElement | null>(null)
  const querySeqRef = useRef(0)
  const fromDayStart = parseDateInputToDayStart(dateFrom)
  const toDayStart = parseDateInputToDayStart(dateTo)

  const fetchEventLogEntries = useCallback(async (fromDay: number | null, toDay: number | null) => {
    const fromUnixMs = fromDay == null ? null : fromDay
    const toUnixMs = toDay == null ? null : addDays(toDay, 1) - 1
    const reqId = ++querySeqRef.current
    try {
      const rows = await invoke<EventLogEntry[]>('get_event_log_entries', {
        fromUnixMs,
        toUnixMs,
        limit: EVENT_LOG_FETCH_LIMIT,
      })
      if (querySeqRef.current !== reqId) return
      if (!Array.isArray(rows)) return
      setSourceEvents([...rows].sort((a, b) => b.unix_ms - a.unix_ms))
    } catch {
      // Keep the latest successful snapshot to avoid UI flicker when fetch transiently fails.
    }
  }, [])

  const now = Date.now()
  const defaultRangeEndDay = startOfDayMs(now)
  const hasDateFilter = fromDayStart != null || toDayStart != null
  const rangeStartDay = fromDayStart ?? defaultRangeEndDay
  const rangeEndDay = toDayStart ?? defaultRangeEndDay
  const effectiveStartDay = Math.min(rangeStartDay, rangeEndDay)
  const effectiveEndDay = Math.max(rangeStartDay, rangeEndDay)
  const minUnixMs = effectiveStartDay
  const maxUnixMs = addDays(effectiveEndDay, 1) - 1
  const searchNeedle = searchText.trim().toLowerCase()

  const timeFiltered = useMemo(() => {
    if (!hasDateFilter) return sourceEvents
    return sourceEvents.filter((e) => e.unix_ms >= minUnixMs && e.unix_ms <= maxUnixMs)
  }, [sourceEvents, hasDateFilter, minUnixMs, maxUnixMs])

  const searchFiltered = useMemo(() => {
    if (!searchNeedle) return timeFiltered
    return timeFiltered.filter((e) => buildSearchText(e).includes(searchNeedle))
  }, [timeFiltered, searchNeedle])

  const chartSourceEvents = useMemo(() => sourceEvents, [sourceEvents])

  const selectedLevelSet = useMemo(() => new Set(selectedLevels), [selectedLevels])
  const filteredEvents = useMemo(
    () =>
      searchFiltered.filter((e) => {
        const level: EventLevel = e.level === 'error' ? 'error' : e.level === 'warning' ? 'warning' : 'info'
        return selectedLevelSet.has(level)
      }),
    [searchFiltered, selectedLevelSet],
  )
  const tableEvents = useMemo(() => filteredEvents.slice(0, EVENT_LOG_TABLE_LIMIT), [filteredEvents])

  const dailyIssueCounts = useMemo(() => {
    let minEventDay = Number.POSITIVE_INFINITY
    let maxEventDay = Number.NEGATIVE_INFINITY
    for (const e of chartSourceEvents) {
      const day = startOfDayMs(e.unix_ms)
      if (day < minEventDay) minEventDay = day
      if (day > maxEventDay) maxEventDay = day
    }
    if (!Number.isFinite(minEventDay) || !Number.isFinite(maxEventDay)) {
      minEventDay = defaultRangeEndDay
      maxEventDay = defaultRangeEndDay
    }
    const spanDays = Math.max(1, dayIndex(maxEventDay) - dayIndex(minEventDay) + 1)
    const chartStartDay = spanDays >= CHART_WINDOW_DAYS ? addDays(maxEventDay, -(CHART_WINDOW_DAYS - 1)) : minEventDay

    const rows = Array.from({ length: CHART_WINDOW_DAYS }, (_, idx) => {
      const dayStartMs = addDays(chartStartDay, idx)
      return { dayStartMs, infos: 0, warnings: 0, errors: 0 }
    })
    const rowByDay = new Map(rows.map((r) => [r.dayStartMs, r]))
    for (const e of chartSourceEvents) {
      const dayStart = startOfDayMs(e.unix_ms)
      const row = rowByDay.get(dayStart)
      if (!row) continue
      if (e.level !== 'error' && e.level !== 'warning') row.infos += 1
      if (e.level === 'warning') row.warnings += 1
      if (e.level === 'error') row.errors += 1
    }
    return rows
  }, [chartSourceEvents, defaultRangeEndDay])

  const maxStackCount = useMemo(
    () => dailyIssueCounts.reduce((max, row) => Math.max(max, row.infos, row.warnings, row.errors), 0),
    [dailyIssueCounts],
  )

  const totalInfos = useMemo(
    () => dailyIssueCounts.reduce((sum, row) => sum + row.infos, 0),
    [dailyIssueCounts],
  )
  const totalWarnings = useMemo(
    () => dailyIssueCounts.reduce((sum, row) => sum + row.warnings, 0),
    [dailyIssueCounts],
  )
  const totalErrors = useMemo(
    () => dailyIssueCounts.reduce((sum, row) => sum + row.errors, 0),
    [dailyIssueCounts],
  )

  const rangeStart = dailyIssueCounts[0]?.dayStartMs ?? effectiveStartDay
  const rangeEnd = dailyIssueCounts[dailyIssueCounts.length - 1]?.dayStartMs ?? effectiveEndDay

  const eventDayCounts = useMemo(() => {
    const out = new Map<number, number>()
    for (const e of sourceEvents) {
      const day = startOfDayMs(e.unix_ms)
      out.set(day, (out.get(day) ?? 0) + 1)
    }
    return out
  }, [sourceEvents])
  const eventDayLevelCounts = useMemo(() => {
    const out = new Map<number, { infos: number; warnings: number; errors: number }>()
    for (const e of sourceEvents) {
      const day = startOfDayMs(e.unix_ms)
      const row = out.get(day) ?? { infos: 0, warnings: 0, errors: 0 }
      if (e.level === 'error') row.errors += 1
      else if (e.level === 'warning') row.warnings += 1
      else row.infos += 1
      out.set(day, row)
    }
    return out
  }, [sourceEvents])
  const latestEventDay = useMemo(() => {
    if (!sourceEvents.length) return null
    let maxUnixMs = sourceEvents[0]?.unix_ms ?? 0
    for (const e of sourceEvents) {
      if (e.unix_ms > maxUnixMs) maxUnixMs = e.unix_ms
    }
    return startOfDayMs(maxUnixMs)
  }, [sourceEvents])

  const monthCells = useMemo(() => {
    const targetMonth = new Date(pickerMonthStartMs).getMonth()
    const startDow = new Date(pickerMonthStartMs).getDay()
    const gridStart = addDays(pickerMonthStartMs, -startDow)
    return Array.from({ length: 42 }, (_, idx) => {
      const dayStartMs = addDays(gridStart, idx)
      return {
        dayStartMs,
        inMonth: new Date(dayStartMs).getMonth() === targetMonth,
      }
    })
  }, [pickerMonthStartMs])

  useEffect(() => {
    if (!openDatePicker) return
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null
      if (!target) return
      if (datePickerRef.current?.contains(target)) return
      setOpenDatePicker(false)
    }
    window.addEventListener('mousedown', onPointerDown)
    return () => window.removeEventListener('mousedown', onPointerDown)
  }, [openDatePicker])

  const pickerFromDayStart = parseDateInputToDayStart(pickerDateFrom)
  const pickerToDayStart = parseDateInputToDayStart(pickerDateTo)
  const allLevelsSelected = selectedLevels.length === ALL_LEVELS.length
  const todayDayStart = startOfDayMs(Date.now())
  const showTodayHint = pickerFromDayStart == null && pickerToDayStart == null
  const reopenFromAnchor = () => {
    setDateAnchor('from')
    setOpenDatePicker(true)
  }
  const resetToFromAnchor = (iso: string) => {
    setPickerDateFrom(iso)
    setPickerDateTo('')
    setDateAnchor('to')
    setOpenDatePicker(true)
  }

  useEffect(() => {
    EVENT_LOG_UI_STATE.selectedLevels = [...selectedLevels]
  }, [selectedLevels])
  useEffect(() => {
    EVENT_LOG_UI_STATE.searchText = searchText
  }, [searchText])
  useEffect(() => {
    EVENT_LOG_UI_STATE.dateFrom = dateFrom
  }, [dateFrom])
  useEffect(() => {
    EVENT_LOG_UI_STATE.dateTo = dateTo
  }, [dateTo])
  useEffect(() => {
    if (!sourceEvents.length && events.length) {
      setSourceEvents([...events].sort((a, b) => b.unix_ms - a.unix_ms))
    }
  }, [events, sourceEvents.length])
  useEffect(() => {
    void fetchEventLogEntries(fromDayStart, toDayStart)
  }, [fetchEventLogEntries, fromDayStart, toDayStart])
  useEffect(() => {
    const timer = window.setInterval(() => {
      void fetchEventLogEntries(fromDayStart, toDayStart)
    }, 15_000)
    return () => window.clearInterval(timer)
  }, [fetchEventLogEntries, fromDayStart, toDayStart])
  useEffect(() => {
    if (!openDatePicker) return
    setDateFrom(pickerDateFrom)
    setDateTo(pickerDateTo)
  }, [openDatePicker, pickerDateFrom, pickerDateTo])

  return (
    <div className="aoEventLogLayout">
      <div className="aoSectionHeader">
        <div className="aoRow">
          <h3 className="aoH3">Event Log</h3>
        </div>
      </div>

      <div className="aoEventLogChartCard">
        <div className="aoEventLogChartHead">
          <span className="aoMiniLabel">Daily Events</span>
          <span className="aoHint">
            Info {totalInfos} · Warnings {totalWarnings} · Errors {totalErrors}
          </span>
        </div>
        <div
          className="aoEventLogChartPlot"
          style={{ gridTemplateColumns: `repeat(${Math.max(1, dailyIssueCounts.length)}, minmax(0, 1fr))` }}
          onMouseMove={(event) => {
            const target = event.target as Element | null
            const activeBar = target?.closest?.('[data-has-events="1"]')
            if (!activeBar) setChartHover(null)
          }}
          onMouseLeave={() => setChartHover(null)}
        >
          {dailyIssueCounts.map((row) => {
            const stackTotal = row.infos + row.warnings + row.errors
            const barSeries = [
              { key: 'info', value: row.infos, className: 'aoEventLogBarInfo' },
              { key: 'warning', value: row.warnings, className: 'aoEventLogBarWarning' },
              { key: 'error', value: row.errors, className: 'aoEventLogBarError' },
            ]
              .filter((series) => series.value > 0)
              .sort((a, b) => b.value - a.value)
            return (
              <div
                key={row.dayStartMs}
                className={`aoEventLogBarGroup${stackTotal === 0 ? ' is-empty' : ''}`}
                data-has-events={stackTotal > 0 ? '1' : undefined}
                onMouseMove={stackTotal === 0 ? undefined : (event) => {
                  const plotRect = event.currentTarget.parentElement?.getBoundingClientRect()
                  if (!plotRect) return
                  setChartHover({
                    x: event.clientX - plotRect.left,
                    y: event.clientY - plotRect.top,
                    dayStartMs: row.dayStartMs,
                    infos: row.infos,
                    warnings: row.warnings,
                    errors: row.errors,
                  })
                }}
              >
                <div className="aoEventLogBarWrap">
                  <div className="aoEventLogBarStack">
                    {barSeries.map((series, layerIdx) => {
                      const layerHeight = maxStackCount > 0 ? Math.max(2, Math.round((series.value / maxStackCount) * 100)) : 0
                      const layerWidth = Math.max(40, 100 - layerIdx * 20)
                      return (
                        <div
                          key={series.key}
                          className={`aoEventLogBarSegment ${series.className}`}
                          style={{ height: `${layerHeight}%`, width: `${layerWidth}%`, zIndex: `${layerIdx + 1}` }}
                        />
                      )
                    })}
                  </div>
                </div>
              </div>
            )
          })}
          {chartHover ? (
            <div className="aoEventLogTooltip" style={{ left: `${chartHover.x}px`, top: `${chartHover.y}px` }}>
              <div className="aoEventLogTooltipTitle">{formatShortDay(chartHover.dayStartMs)}</div>
              <div className="aoEventLogTooltipRow">
                <i className="aoEventLogLegendDot aoEventLogBarInfo" />
                <span>Info</span>
                <b>{chartHover.infos}</b>
              </div>
              <div className="aoEventLogTooltipRow">
                <i className="aoEventLogLegendDot aoEventLogBarWarning" />
                <span>Warnings</span>
                <b>{chartHover.warnings}</b>
              </div>
              <div className="aoEventLogTooltipRow">
                <i className="aoEventLogLegendDot aoEventLogBarError" />
                <span>Errors</span>
                <b>{chartHover.errors}</b>
              </div>
            </div>
          ) : null}
        </div>
        <div className="aoEventLogChartMeta">
          <span>{formatShortDay(rangeStart)}</span>
          <div className="aoEventLogLegend">
            <span className="aoEventLogLegendItem">
              <i className="aoEventLogLegendDot aoEventLogBarInfo" />Info
            </span>
            <span className="aoEventLogLegendItem">
              <i className="aoEventLogLegendDot aoEventLogBarWarning" />Warning
            </span>
            <span className="aoEventLogLegendItem">
              <i className="aoEventLogLegendDot aoEventLogBarError" />Error
            </span>
          </div>
          <span>{formatShortDay(rangeEnd)}</span>
        </div>
      </div>

      <div className="aoEventLogToolbar">
        <div className="aoEventLogToolbarGroup aoEventLogFilterGroup" role="group" aria-label="Event level filter">
          <button
            className={`aoTinyBtn aoUsageActionBtn${allLevelsSelected ? ' aoUsageWindowBtnActive' : ''}`}
            onClick={() => setSelectedLevels([...ALL_LEVELS])}
            aria-pressed={allLevelsSelected}
          >
            All
          </button>
          <span className="aoEventLogFilterDivider" aria-hidden="true" />
          {ALL_LEVELS.map((level) => (
            <button
              key={level}
              className={`aoTinyBtn aoUsageActionBtn${!allLevelsSelected && selectedLevelSet.has(level) ? ' aoUsageWindowBtnActive' : ''}`}
              onClick={() =>
                setSelectedLevels((prev) => {
                  const prevIsAll = prev.length === ALL_LEVELS.length
                  if (prevIsAll) return [level]
                  if (prev.includes(level)) {
                    if (prev.length === 1) return [...ALL_LEVELS]
                    return prev.filter((item) => item !== level)
                  }
                  return [...prev, level]
                })
              }
              aria-pressed={!allLevelsSelected && selectedLevelSet.has(level)}
            >
              {level}
            </button>
          ))}
        </div>

        <input
          className="aoInput aoEventLogSearch"
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
          placeholder="Search message / provider / session / code..."
          aria-label="Search events"
        />

        <div className="aoEventLogToolbarGroup aoEventLogDateRange" role="group" aria-label="Date range filter">
          <div className="aoEventLogDatePickerWrap" ref={datePickerRef}>
            <button
              className={`aoInput aoEventLogDateInput aoEventLogDateTrigger${fromDayStart ? ' has-value' : ''}${openDatePicker && dateAnchor === 'from' ? ' is-active' : ''}`}
              onClick={() => {
                const sameAnchorOpen = openDatePicker && dateAnchor === 'from'
                if (sameAnchorOpen) {
                  setOpenDatePicker(false)
                  return
                }
                if (!openDatePicker) {
                  setPickerDateFrom(dateFrom)
                  setPickerDateTo(dateTo)
                }
                const base = fromDayStart ?? toDayStart ?? latestEventDay ?? startOfDayMs(Date.now())
                setPickerMonthStartMs(startOfMonthMs(base))
                setDateAnchor('from')
                setOpenDatePicker(true)
              }}
              aria-haspopup="dialog"
              aria-expanded={openDatePicker && dateAnchor === 'from'}
            >
              {fromDayStart ? fmtDayMonthYear(fromDayStart) : <span className="aoEventLogDatePlaceholder">From</span>}
            </button>
            <button
              className={`aoInput aoEventLogDateInput aoEventLogDateTrigger${toDayStart ? ' has-value' : ''}${openDatePicker && dateAnchor === 'to' ? ' is-active' : ''}`}
              onClick={() => {
                const sameAnchorOpen = openDatePicker && dateAnchor === 'to'
                if (sameAnchorOpen) {
                  setOpenDatePicker(false)
                  return
                }
                if (!openDatePicker) {
                  setPickerDateFrom(dateFrom)
                  setPickerDateTo(dateTo)
                }
                const base = toDayStart ?? fromDayStart ?? latestEventDay ?? startOfDayMs(Date.now())
                setPickerMonthStartMs(startOfMonthMs(base))
                setDateAnchor('to')
                setOpenDatePicker(true)
              }}
              aria-haspopup="dialog"
              aria-expanded={openDatePicker && dateAnchor === 'to'}
            >
              {toDayStart ? fmtDayMonthYear(toDayStart) : <span className="aoEventLogDatePlaceholder">To</span>}
            </button>
            {openDatePicker ? (
              <div className="aoEventLogDatePopover" role="dialog" aria-label="Select date range">
                <div className="aoEventLogDatePopoverHead">
                  <button
                    className="aoEventLogDateNavBtn"
                    onClick={() => setPickerMonthStartMs((prev) => addMonths(prev, -1))}
                    aria-label="Previous month"
                  >
                    {'<'}
                  </button>
                  <span className="aoEventLogDateTitle">
                    {new Date(pickerMonthStartMs).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}
                  </span>
                  <button
                    className="aoEventLogDateNavBtn"
                    onClick={() => setPickerMonthStartMs((prev) => addMonths(prev, 1))}
                    aria-label="Next month"
                  >
                    {'>'}
                  </button>
                </div>
                <div className="aoEventLogDateWeekdays">
                  {['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map((w) => (
                    <span key={w}>{w}</span>
                  ))}
                </div>
                <div className="aoEventLogDateGrid">
                  {monthCells.map((cell) => {
                    const hasRecord = (eventDayCounts.get(cell.dayStartMs) ?? 0) > 0
                    const levelCounts = eventDayLevelCounts.get(cell.dayStartMs) ?? { infos: 0, warnings: 0, errors: 0 }
                    const isStart = pickerFromDayStart === cell.dayStartMs
                    const isEnd = pickerToDayStart === cell.dayStartMs
                    const inRange =
                      pickerFromDayStart != null &&
                      pickerToDayStart != null &&
                      cell.dayStartMs > Math.min(pickerFromDayStart, pickerToDayStart) &&
                      cell.dayStartMs < Math.max(pickerFromDayStart, pickerToDayStart)
                    return (
                      <button
                        key={cell.dayStartMs}
                        className={`aoEventLogDateCell${cell.inMonth ? '' : ' is-out'}${showTodayHint && cell.dayStartMs === todayDayStart ? ' is-today' : ''}${isStart ? ' is-start' : ''}${isEnd ? ' is-end' : ''}${inRange ? ' is-range' : ''}`}
                        onClick={() => {
                          const iso = dayStartToIso(cell.dayStartMs)
                          if (pickerFromDayStart != null && pickerToDayStart != null) {
                            resetToFromAnchor(iso)
                            return
                          }
                          if (dateAnchor === 'from') {
                            setPickerDateFrom(iso)
                            if (pickerToDayStart != null && pickerToDayStart < cell.dayStartMs) {
                              setPickerDateTo(iso)
                            }
                            setDateAnchor('to')
                            setOpenDatePicker(true)
                            return
                          }

                          if (pickerFromDayStart == null) {
                            setPickerDateTo(iso)
                            reopenFromAnchor()
                            return
                          }

                          if (cell.dayStartMs < pickerFromDayStart) {
                            setPickerDateFrom(iso)
                            setPickerDateTo(dayStartToIso(pickerFromDayStart))
                          } else {
                            setPickerDateTo(iso)
                          }
                          setDateAnchor('to')
                          setOpenDatePicker(true)
                        }}
                        title={
                          hasRecord
                            ? `Info ${levelCounts.infos} · Warning ${levelCounts.warnings} · Error ${levelCounts.errors}`
                            : 'No records'
                        }
                      >
                        <span>{new Date(cell.dayStartMs).getDate()}</span>
                        {hasRecord ? (
                          <span className="aoEventLogDateDots" aria-hidden="true">
                            {levelCounts.infos > 0 ? <i className="aoEventLogDateDot aoEventLogDateDotInfo" /> : null}
                            {levelCounts.warnings > 0 ? <i className="aoEventLogDateDot aoEventLogDateDotWarning" /> : null}
                            {levelCounts.errors > 0 ? <i className="aoEventLogDateDot aoEventLogDateDotError" /> : null}
                          </span>
                        ) : null}
                      </button>
                    )
                  })}
                </div>
                <div className="aoEventLogDatePopoverFoot">
                  <div className="aoEventLogDatePopoverFootGroup">
                    <button
                      className="aoTinyBtn aoUsageActionBtn"
                      onClick={() => {
                        setPickerDateFrom('')
                        setPickerDateTo('')
                      }}
                    >
                      Clear
                    </button>
                    <button
                      className="aoTinyBtn aoUsageActionBtn"
                      onClick={() => {
                        const today = dayStartToIso(startOfDayMs(Date.now()))
                        if (!pickerFromDayStart || pickerToDayStart) {
                          setPickerDateFrom(today)
                          setPickerDateTo('')
                          setDateAnchor('to')
                          return
                        }
                        if (startOfDayMs(Date.now()) < pickerFromDayStart) {
                          setPickerDateTo(dayStartToIso(pickerFromDayStart))
                          setPickerDateFrom(today)
                        } else {
                          setPickerDateTo(today)
                        }
                      }}
                    >
                      Today
                    </button>
                  </div>
                  <div className="aoEventLogDatePopoverFootGroup">
                    <button
                      className="aoTinyBtn aoUsageActionBtn"
                      onClick={() => {
                        setOpenDatePicker(false)
                      }}
                    >
                      OK
                    </button>
                  </div>
                </div>
              </div>
            ) : null}
          </div>
          <button
            className="aoTinyBtn aoUsageActionBtn aoEventLogDateClear"
            disabled={!dateFrom && !dateTo}
            onClick={() => {
              setDateFrom('')
              setDateTo('')
            }}
          >
            Clear
          </button>
        </div>
      </div>

      <DashboardEventsSection
        title="Event Log"
        showHeader={false}
        splitByLevel={false}
        scrollInside
        scrollPersistKey="event_log_table"
        visibleEvents={tableEvents}
      />
    </div>
  )
}
