import { useCallback, useEffect, useRef } from 'react'

type TopPage =
  | 'dashboard'
  | 'usage_statistics'
  | 'usage_requests'
  | 'provider_switchboard'
  | 'event_log'
  | 'web_codex'

type RefreshOwner = TopPage | 'any'

type RefreshGuard = () => boolean

type BackgroundTask = {
  key: string
  owner: RefreshOwner
  generation: number
  run: (guard: RefreshGuard) => Promise<void> | void
}

export function appendPendingRefreshKey(order: string[], key: string): string[] {
  return order.includes(key) ? order : [...order, key]
}

export function shouldApplyRefreshResult(
  activePage: TopPage,
  owner: RefreshOwner,
  generation: number,
  latestGeneration: number,
): boolean {
  if (generation !== latestGeneration) return false
  return owner === 'any' || activePage === owner
}

export function useRefreshScheduler(activePage: TopPage) {
  const activePageRef = useRef<TopPage>(activePage)
  const latestGenerationByKeyRef = useRef<Record<string, number>>({})
  const pendingTaskByKeyRef = useRef<Map<string, BackgroundTask>>(new Map())
  const pendingOrderRef = useRef<string[]>([])
  const drainingRef = useRef(false)

  useEffect(() => {
    activePageRef.current = activePage
  }, [activePage])

  const nextGeneration = useCallback((key: string) => {
    const next = (latestGenerationByKeyRef.current[key] ?? 0) + 1
    latestGenerationByKeyRef.current[key] = next
    return next
  }, [])

  const createGuard = useCallback(
    (key: string, owner: RefreshOwner, generation: number): RefreshGuard =>
      () =>
        shouldApplyRefreshResult(
          activePageRef.current,
          owner,
          generation,
          latestGenerationByKeyRef.current[key] ?? 0,
        ),
    [],
  )

  const drainBackgroundQueue = useCallback(() => {
    if (drainingRef.current) return
    drainingRef.current = true
    queueMicrotask(async () => {
      try {
        while (pendingOrderRef.current.length > 0) {
          const key = pendingOrderRef.current.shift()
          if (!key) continue
          const task = pendingTaskByKeyRef.current.get(key)
          pendingTaskByKeyRef.current.delete(key)
          if (!task) continue
          const guard = createGuard(task.key, task.owner, task.generation)
          if (!guard()) {
            continue
          }
          await task.run(guard)
        }
      } finally {
        drainingRef.current = false
        if (pendingOrderRef.current.length > 0) {
          drainBackgroundQueue()
        }
      }
    })
  }, [createGuard])

  const runPrimaryRefresh = useCallback(
    (
      key: string,
      owner: RefreshOwner,
      run: (guard: RefreshGuard) => Promise<void> | void,
    ) => {
      const generation = nextGeneration(key)
      const guard = createGuard(key, owner, generation)
      return Promise.resolve(run(guard))
    },
    [createGuard, nextGeneration],
  )

  const enqueueBackgroundRefresh = useCallback(
    (
      key: string,
      owner: RefreshOwner,
      run: (guard: RefreshGuard) => Promise<void> | void,
    ) => {
      const generation = nextGeneration(key)
      pendingTaskByKeyRef.current.set(key, {
        key,
        owner,
        generation,
        run,
      })
      pendingOrderRef.current = appendPendingRefreshKey(pendingOrderRef.current, key)
      drainBackgroundQueue()
    },
    [drainBackgroundQueue, nextGeneration],
  )

  return {
    runPrimaryRefresh,
    enqueueBackgroundRefresh,
  }
}
