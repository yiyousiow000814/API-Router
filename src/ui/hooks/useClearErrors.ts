import { useCallback } from 'react'
import type { Dispatch, SetStateAction } from 'react'

import type { Status } from '../types'

export function useClearErrors(status: Status | null, setClearErrorsBeforeMs: Dispatch<SetStateAction<number>>) {
  return useCallback(() => {
    const events = status?.recent_events ?? []
    let maxErrorUnixMs = 0
    for (const event of events) {
      if (event.level !== 'error') continue
      if (event.unix_ms > maxErrorUnixMs) maxErrorUnixMs = event.unix_ms
    }
    if (!maxErrorUnixMs) return
    setClearErrorsBeforeMs((prev) => Math.max(prev, maxErrorUnixMs))
  }, [setClearErrorsBeforeMs, status])
}
