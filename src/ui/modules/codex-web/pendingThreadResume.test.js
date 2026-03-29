import { describe, expect, it } from 'vitest'

import { registerPendingThreadResume, waitPendingThreadResume } from './pendingThreadResume.js'

describe('pendingThreadResume', () => {
  it('registers and clears a resolved promise', async () => {
    const pending = new Map()
    let resolvePromise = null
    const promise = new Promise((resolve) => {
      resolvePromise = resolve
    })

    registerPendingThreadResume(pending, 'thread-1', promise)
    expect(pending.get('thread-1')).toBe(promise)

    resolvePromise?.()
    await promise
    await Promise.resolve()

    expect(pending.has('thread-1')).toBe(false)
  })

  it('swallows rejected resume waits and still clears the store', async () => {
    const pending = new Map()
    let rejectPromise = null
    const promise = new Promise((_resolve, reject) => {
      rejectPromise = reject
    })

    registerPendingThreadResume(pending, 'thread-2', promise)
    rejectPromise?.(new Error('resume failed'))
    await waitPendingThreadResume(pending, 'thread-2')
    await Promise.resolve()

    expect(pending.has('thread-2')).toBe(false)
  })

  it('treats missing thread ids as no-op waits', async () => {
    await expect(waitPendingThreadResume(new Map(), '')).resolves.toBeUndefined()
    await expect(waitPendingThreadResume(new Map(), 'missing')).resolves.toBeUndefined()
  })
})
