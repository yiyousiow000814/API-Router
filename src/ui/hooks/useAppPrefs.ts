import { invoke } from '@tauri-apps/api/core'
import { useEffect, type MutableRefObject } from 'react'

type UseAppPrefsOptions = {
  devAutoOpenHistory: boolean
  setUsageHistoryModalOpen: (next: boolean) => void
  autoSaveTimersRef: MutableRefObject<Record<string, number>>
  setProviderPanelsOpen: (value: Record<string, boolean>) => void
  providerPanelsOpen: Record<string, boolean>
  clearErrorsBeforeMs: number
  setClearErrorsBeforeMs: (value: number) => void
  codexSwapDir1: string
  codexSwapDir2: string
  codexSwapApplyBoth: boolean
  setCodexSwapDir1: (value: string | ((prev: string) => string)) => void
  setCodexSwapDir2: (value: string) => void
  setCodexSwapApplyBoth: (value: boolean) => void
  codexSwapDir1Ref: MutableRefObject<string>
  codexSwapDir2Ref: MutableRefObject<string>
  codexSwapApplyBothRef: MutableRefObject<boolean>
  swapPrefsLoadedRef: MutableRefObject<boolean>
}

export function useAppPrefs({
  devAutoOpenHistory,
  setUsageHistoryModalOpen,
  autoSaveTimersRef,
  setProviderPanelsOpen,
  providerPanelsOpen,
  clearErrorsBeforeMs,
  setClearErrorsBeforeMs,
  codexSwapDir1,
  codexSwapDir2,
  codexSwapApplyBoth,
  setCodexSwapDir1,
  setCodexSwapDir2,
  setCodexSwapApplyBoth,
  codexSwapDir1Ref,
  codexSwapDir2Ref,
  codexSwapApplyBothRef,
  swapPrefsLoadedRef,
}: UseAppPrefsOptions) {
  useEffect(() => {
    if (!devAutoOpenHistory) return
    setUsageHistoryModalOpen(true)
  }, [devAutoOpenHistory, setUsageHistoryModalOpen])

  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      const savedProviderPanels = window.localStorage.getItem('ao.providerPanelsOpen')
      if (!savedProviderPanels) return
      const parsed = JSON.parse(savedProviderPanels) as Record<string, boolean>
      if (parsed && typeof parsed === 'object') setProviderPanelsOpen(parsed)
    } catch (e) {
      console.warn('Failed to load UI prefs', e)
    }
  }, [setProviderPanelsOpen])

  useEffect(() => {
    return () => {
      Object.keys(autoSaveTimersRef.current).forEach((key) => {
        window.clearTimeout(autoSaveTimersRef.current[key])
      })
      autoSaveTimersRef.current = {}
    }
  }, [autoSaveTimersRef])

  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      const d1 = window.localStorage.getItem('ao.codexSwap.dir1') ?? ''
      const d2 = window.localStorage.getItem('ao.codexSwap.dir2') ?? ''
      const both = (window.localStorage.getItem('ao.codexSwap.applyBoth') ?? '') === '1'
      setCodexSwapDir1(d1)
      setCodexSwapDir2(d2)
      setCodexSwapApplyBoth(both)
      if (!d1.trim()) {
        invoke<string>('codex_cli_default_home')
          .then((p) => setCodexSwapDir1((prev) => (prev.trim() ? prev : p)))
          .catch(() => {})
      }
      swapPrefsLoadedRef.current = true
    } catch (e) {
      console.warn('Failed to load Codex swap prefs', e)
      swapPrefsLoadedRef.current = true
    }
  }, [setCodexSwapApplyBoth, setCodexSwapDir1, setCodexSwapDir2, swapPrefsLoadedRef])

  useEffect(() => {
    codexSwapDir1Ref.current = codexSwapDir1
  }, [codexSwapDir1, codexSwapDir1Ref])
  useEffect(() => {
    codexSwapDir2Ref.current = codexSwapDir2
  }, [codexSwapDir2, codexSwapDir2Ref])
  useEffect(() => {
    codexSwapApplyBothRef.current = codexSwapApplyBoth
  }, [codexSwapApplyBoth, codexSwapApplyBothRef])

  useEffect(() => {
    if (typeof window === 'undefined') return
    if (!swapPrefsLoadedRef.current) return
    try {
      window.localStorage.setItem('ao.codexSwap.dir1', codexSwapDir1)
      window.localStorage.setItem('ao.codexSwap.dir2', codexSwapDir2)
      window.localStorage.setItem('ao.codexSwap.applyBoth', codexSwapApplyBoth ? '1' : '0')
    } catch (e) {
      console.warn('Failed to save Codex swap prefs', e)
    }
  }, [codexSwapApplyBoth, codexSwapDir1, codexSwapDir2, swapPrefsLoadedRef])

  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      const saved = window.localStorage.getItem('ao.clearErrorsBeforeMs')
      if (!saved) return
      const n = Number(saved)
      if (Number.isFinite(n) && n > 0) setClearErrorsBeforeMs(n)
    } catch (e) {
      console.warn('Failed to load UI prefs', e)
    }
  }, [setClearErrorsBeforeMs])

  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem('ao.providerPanelsOpen', JSON.stringify(providerPanelsOpen))
    } catch (e) {
      console.warn('Failed to save provider panels', e)
    }
  }, [providerPanelsOpen])

  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      if (!clearErrorsBeforeMs) {
        window.localStorage.removeItem('ao.clearErrorsBeforeMs')
        return
      }
      window.localStorage.setItem('ao.clearErrorsBeforeMs', String(clearErrorsBeforeMs))
    } catch (e) {
      console.warn('Failed to save UI prefs', e)
    }
  }, [clearErrorsBeforeMs])
}
