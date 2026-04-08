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

type PendingRefreshStore = Map<string, BackgroundTask>

export function appendPendingRefreshKey(order: string[], key: string): string[] {
  return order.includes(key) ? order : [...order, key]
}

export function takePendingRefreshBatch(
  order: string[],
  tasks: PendingRefreshStore,
): BackgroundTask[] {
  const batch: BackgroundTask[] = []
  for (const key of order) {
    const task = tasks.get(key)
    if (!task) continue
    tasks.delete(key)
    batch.push(task)
  }
  return batch
}

export async function runPendingRefreshBatch(
  batch: BackgroundTask[],
  createGuard: (key: string, owner: RefreshOwner, generation: number) => RefreshGuard,
): Promise<void> {
  await Promise.allSettled(
    batch.map(async (task) => {
      const guard = createGuard(task.key, task.owner, task.generation)
      if (!guard()) return
      await task.run(guard)
    }),
  )
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
          const order = pendingOrderRef.current
          pendingOrderRef.current = []
          const batch = takePendingRefreshBatch(order, pendingTaskByKeyRef.current)
          if (batch.length === 0) {
            continue
          }
          await runPendingRefreshBatch(batch, createGuard)
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
