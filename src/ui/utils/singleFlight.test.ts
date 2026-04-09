import { describe, expect, it, vi } from 'vitest'
import { runSingleFlight } from './singleFlight'

describe('runSingleFlight', () => {
  it('reuses the same in-flight promise for the same key', async () => {
    const inFlight = new Map<string, Promise<number>>()
    const run = vi.fn(async () => {
      await Promise.resolve()
      return 42
    })

    const first = runSingleFlight(inFlight, 'same', run)
    const second = runSingleFlight(inFlight, 'same', run)

    expect(first).toBe(second)
    await expect(first).resolves.toBe(42)
    expect(run).toHaveBeenCalledTimes(1)
    expect(inFlight.size).toBe(0)
  })

  it('allows a settled key to run again', async () => {
    const inFlight = new Map<string, Promise<number>>()
    const run = vi
      .fn<() => Promise<number>>()
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(2)

    await expect(runSingleFlight(inFlight, 'same', run)).resolves.toBe(1)
    await expect(runSingleFlight(inFlight, 'same', run)).resolves.toBe(2)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('keeps different keys independent', async () => {
    const inFlight = new Map<string, Promise<number>>()
    const runA = vi.fn(async () => 1)
    const runB = vi.fn(async () => 2)

    await expect(
      Promise.all([
        runSingleFlight(inFlight, 'a', runA),
        runSingleFlight(inFlight, 'b', runB),
      ]),
    ).resolves.toEqual([1, 2])
    expect(runA).toHaveBeenCalledTimes(1)
    expect(runB).toHaveBeenCalledTimes(1)
  })
})
