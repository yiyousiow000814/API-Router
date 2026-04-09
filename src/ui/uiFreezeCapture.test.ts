import { describe, expect, it } from 'vitest'

import {
  extendMonitorUntil,
  shouldKeepFrameMonitorActive,
  shouldReportFrameStall,
} from './uiFreezeCapture'

describe('uiFreezeCapture helpers', () => {
  it('reports only stalls that exceed the threshold', () => {
    expect(shouldReportFrameStall(79)).toBe(false)
    expect(shouldReportFrameStall(80)).toBe(true)
    expect(shouldReportFrameStall(160)).toBe(true)
  })

  it('extends monitor windows without shrinking them', () => {
    expect(extendMonitorUntil(10_000, 4_000, 8_000)).toBe(12_000)
    expect(extendMonitorUntil(15_000, 4_000, 8_000)).toBe(15_000)
  })

  it('keeps the frame monitor active only while visible and in-window', () => {
    expect(shouldKeepFrameMonitorActive(true, 4_999, 5_000)).toBe(true)
    expect(shouldKeepFrameMonitorActive(true, 5_000, 5_000)).toBe(false)
    expect(shouldKeepFrameMonitorActive(false, 4_000, 5_000)).toBe(false)
  })
})
