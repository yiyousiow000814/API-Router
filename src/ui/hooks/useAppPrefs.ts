import { invoke } from '@tauri-apps/api/core'
import { useEffect, type MutableRefObject } from 'react'
import { normalizePathForCompare } from '../utils/path'

type UseAppPrefsOptions = {
  isDevPreview: boolean
  devAutoOpenHistory: boolean
  setUsageHistoryModalOpen: (next: boolean) => void
  autoSaveTimersRef: MutableRefObject<Record<string, number>>
  setProviderPanelsOpen: (value: Record<string, boolean>) => void
  providerPanelsOpen: Record<string, boolean>
  codexSwapDir1: string
  codexSwapDir2: string
  codexSwapUseWindows: boolean
  codexSwapUseWsl: boolean
  setCodexSwapDir1: (value: string | ((prev: string) => string)) => void
  setCodexSwapDir2: (value: string) => void
  setCodexSwapUseWindows: (value: boolean) => void
  setCodexSwapUseWsl: (value: boolean) => void
  codexSwapDir1Ref: MutableRefObject<string>
  codexSwapDir2Ref: MutableRefObject<string>
  codexSwapUseWindowsRef: MutableRefObject<boolean>
  codexSwapUseWslRef: MutableRefObject<boolean>
  swapPrefsLoadedRef: MutableRefObject<boolean>
}

type CodexCliDirectories = {
  windows_enabled?: boolean
  windows_home?: string
  wsl2_enabled?: boolean
  wsl2_home?: string
  windowsEnabled?: boolean
  windowsHome?: string
  wsl2Enabled?: boolean
  wsl2Home?: string
}

const boolPref = (value: unknown, fallback: boolean) =>
  typeof value === 'boolean' ? value : fallback

const stringPref = (value: unknown, fallback: string) =>
  typeof value === 'string' ? value : fallback

export function useAppPrefs({
  isDevPreview,
  devAutoOpenHistory,
  setUsageHistoryModalOpen,
  autoSaveTimersRef,
  setProviderPanelsOpen,
  providerPanelsOpen,
  codexSwapDir1,
  codexSwapDir2,
  codexSwapUseWindows,
  codexSwapUseWsl,
  setCodexSwapDir1,
  setCodexSwapDir2,
  setCodexSwapUseWindows,
  setCodexSwapUseWsl,
  codexSwapDir1Ref,
  codexSwapDir2Ref,
  codexSwapUseWindowsRef,
  codexSwapUseWslRef,
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
    let cancelled = false
    const loadPrefs = async () => {
      try {
        const d1 = window.localStorage.getItem('ao.codexSwap.dir1') ?? ''
        const d2 = window.localStorage.getItem('ao.codexSwap.dir2') ?? ''
        if (isDevPreview) {
          const mockWindowsHome = 'C:\\Users\\<user>\\.codex'
          const mockWslHome = '\\\\wsl.localhost\\Ubuntu\\home\\<user>\\.codex'
          setCodexSwapDir1(d1.trim() ? d1 : mockWindowsHome)
          setCodexSwapDir2(d2.trim() ? d2 : mockWslHome)
          setCodexSwapUseWindows(true)
          setCodexSwapUseWsl(true)
          swapPrefsLoadedRef.current = true
          return
        }
        const backendPrefsRaw = await invoke<CodexCliDirectories>('codex_cli_directories_get').catch(() => null)
        const backendHasSavedPrefs = Boolean(
          backendPrefsRaw &&
            (backendPrefsRaw.windows_enabled ||
              backendPrefsRaw.windowsEnabled ||
              backendPrefsRaw.wsl2_enabled ||
              backendPrefsRaw.wsl2Enabled ||
              stringPref(backendPrefsRaw.windows_home ?? backendPrefsRaw.windowsHome, '').trim() ||
              stringPref(backendPrefsRaw.wsl2_home ?? backendPrefsRaw.wsl2Home, '').trim()),
        )
        const backendPrefs = backendHasSavedPrefs ? backendPrefsRaw : null
        const legacyApplyBoth = (window.localStorage.getItem('ao.codexSwap.applyBoth') ?? '') === '1'
        const useWindowsRaw = window.localStorage.getItem('ao.codexSwap.useWindows')
        const useWslRaw = window.localStorage.getItem('ao.codexSwap.useWsl')
        const backendWindowsHome = stringPref(backendPrefs?.windows_home ?? backendPrefs?.windowsHome, '')
        const backendWslHome = stringPref(backendPrefs?.wsl2_home ?? backendPrefs?.wsl2Home, '')
        const initialWindowsHome = backendWindowsHome.trim() ? backendWindowsHome : d1
        const initialWslHome = backendWslHome.trim() ? backendWslHome : d2
        const useWindows =
          backendPrefs == null
            ? useWindowsRaw == null
              ? Boolean(d1.trim())
              : useWindowsRaw === '1'
            : boolPref(backendPrefs.windows_enabled ?? backendPrefs.windowsEnabled, false)
        const useWsl =
          backendPrefs == null
            ? useWslRaw == null
              ? legacyApplyBoth || Boolean(d2.trim())
              : useWslRaw === '1'
            : boolPref(backendPrefs.wsl2_enabled ?? backendPrefs.wsl2Enabled, false)
        const shouldAutoEnableWindows = backendPrefs == null && useWindowsRaw == null && !d1.trim()
        const shouldAutoEnableWsl = backendPrefs == null && useWslRaw == null && !d2.trim()
        let discoveredWindowsHome = initialWindowsHome.trim()
        let discoveredWslHome = ''
        let windowsDiscoveryResolved = Boolean(initialWindowsHome.trim())
        const applyAutoEnableWsl = () => {
          if (cancelled) return
          if (!shouldAutoEnableWsl) return
          if (!windowsDiscoveryResolved) return
          setCodexSwapUseWsl(!discoveredWindowsHome && Boolean(discoveredWslHome))
        }
        if (cancelled) return
        setCodexSwapDir1(initialWindowsHome)
        setCodexSwapDir2(initialWslHome)
        setCodexSwapUseWindows(useWindows)
        setCodexSwapUseWsl(useWsl)
        if (!initialWindowsHome.trim()) {
          invoke<string>('codex_cli_default_home')
            .then((p) => {
              if (cancelled) return
              discoveredWindowsHome = p.trim()
              windowsDiscoveryResolved = true
              setCodexSwapDir1((prev) => (prev.trim() ? prev : p))
              if (shouldAutoEnableWindows) setCodexSwapUseWindows(Boolean(discoveredWindowsHome))
              applyAutoEnableWsl()
            })
            .catch(() => {
              windowsDiscoveryResolved = true
              applyAutoEnableWsl()
            })
        }
        if (!initialWslHome.trim()) {
          invoke<string>('codex_cli_default_wsl_home')
            .then((p) => {
              if (cancelled) return
              const resolved =
                normalizePathForCompare(p) === normalizePathForCompare(initialWindowsHome) ? '' : p
              discoveredWslHome = resolved.trim()
              setCodexSwapDir2(resolved)
              applyAutoEnableWsl()
            })
            .catch(() => {})
        }
        swapPrefsLoadedRef.current = true
      } catch (e) {
        console.warn('Failed to load Codex swap prefs', e)
        swapPrefsLoadedRef.current = true
      }
    }
    void loadPrefs()
    return () => {
      cancelled = true
    }
  }, [isDevPreview, setCodexSwapDir1, setCodexSwapDir2, setCodexSwapUseWindows, setCodexSwapUseWsl, swapPrefsLoadedRef])

  useEffect(() => {
    codexSwapDir1Ref.current = codexSwapDir1
  }, [codexSwapDir1, codexSwapDir1Ref])
  useEffect(() => {
    codexSwapDir2Ref.current = codexSwapDir2
  }, [codexSwapDir2, codexSwapDir2Ref])
  useEffect(() => {
    codexSwapUseWindowsRef.current = codexSwapUseWindows
  }, [codexSwapUseWindows, codexSwapUseWindowsRef])
  useEffect(() => {
    codexSwapUseWslRef.current = codexSwapUseWsl
  }, [codexSwapUseWsl, codexSwapUseWslRef])

  useEffect(() => {
    if (typeof window === 'undefined') return
    if (!swapPrefsLoadedRef.current) return
    try {
      window.localStorage.setItem('ao.codexSwap.dir1', codexSwapDir1)
      window.localStorage.setItem('ao.codexSwap.dir2', codexSwapDir2)
      window.localStorage.setItem('ao.codexSwap.useWindows', codexSwapUseWindows ? '1' : '0')
      window.localStorage.setItem('ao.codexSwap.useWsl', codexSwapUseWsl ? '1' : '0')
      if (!isDevPreview) {
        void invoke('codex_cli_directories_set', {
          windowsEnabled: codexSwapUseWindows,
          windowsHome: codexSwapDir1,
          wsl2Enabled: codexSwapUseWsl,
          wsl2Home: codexSwapDir2,
        }).catch((e) => {
          console.warn('Failed to save backend Codex swap prefs', e)
        })
      }
    } catch (e) {
      console.warn('Failed to save Codex swap prefs', e)
    }
  }, [isDevPreview, codexSwapUseWindows, codexSwapUseWsl, codexSwapDir1, codexSwapDir2, swapPrefsLoadedRef])

  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem('ao.providerPanelsOpen', JSON.stringify(providerPanelsOpen))
    } catch (e) {
      console.warn('Failed to save provider panels', e)
    }
  }, [providerPanelsOpen])
}
