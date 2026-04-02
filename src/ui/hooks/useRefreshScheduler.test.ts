import { describe, expect, it, vi } from 'vitest'

import {
  appendPendingRefreshKey,
  runPendingRefreshBatch,
  shouldApplyRefreshResult,
  takePendingRefreshBatch,
} from './useRefreshScheduler'

describe('useRefreshScheduler helpers', () => {
  it('deduplicates pending refresh keys while preserving order', () => {
    expect(appendPendingRefreshKey([], 'status')).toEqual(['status'])
    expect(appendPendingRefreshKey(['status'], 'status')).toEqual(['status'])
    expect(appendPendingRefreshKey(['status'], 'config')).toEqual(['status', 'config'])
  })

  it('applies results only when the generation is current', () => {
    expect(shouldApplyRefreshResult('dashboard', 'any', 2, 2)).toBe(true)
    expect(shouldApplyRefreshResult('dashboard', 'any', 1, 2)).toBe(false)
  })

  it('drops page-owned results after the user leaves that page', () => {
    expect(shouldApplyRefreshResult('dashboard', 'dashboard', 3, 3)).toBe(true)
    expect(shouldApplyRefreshResult('usage_requests', 'dashboard', 3, 3)).toBe(false)
  })

  it('takes one batch in queue order and clears claimed tasks', () => {
    const tasks = new Map([
      ['status', { key: 'status', owner: 'any' as const, generation: 1, run: vi.fn() }],
      ['config', { key: 'config', owner: 'any' as const, generation: 2, run: vi.fn() }],
    ])

    const batch = takePendingRefreshBatch(['status', 'missing', 'config'], tasks)

    expect(batch.map((task) => task.key)).toEqual(['status', 'config'])
    expect(tasks.size).toBe(0)
  })

  it('runs one pending batch concurrently', async () => {
    let resolveFirst!: () => void
    const firstGate = new Promise<void>((resolve) => {
      resolveFirst = resolve
    })
    const firstStarted = vi.fn()
    const secondStarted = vi.fn()
    const batch = [
      {
        key: 'status',
        owner: 'any' as const,
        generation: 1,
        run: async () => {
          firstStarted()
          await firstGate
        },
      },
      {
        key: 'config',
        owner: 'any' as const,
        generation: 1,
        run: async () => {
          secondStarted()
        },
      },
    ]

    const pending = runPendingRefreshBatch(batch, () => () => true)
    await Promise.resolve()

    expect(firstStarted).toHaveBeenCalledTimes(1)
    expect(secondStarted).toHaveBeenCalledTimes(1)

    resolveFirst()
    await pending
  })
})
