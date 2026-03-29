import { Suspense, lazy, startTransition, useEffect, useState } from 'react'
import { LoadingSurface } from './components/LoadingSurface'
import { recordStartupStage } from './startupTrace'

const LazyApp = lazy(async () => {
  recordStartupStage('frontend_app_import_requested')
  const module = await import('./App')
  recordStartupStage('frontend_app_import_resolved')
  return { default: module.default }
})

function StartupShell() {
  return (
    <div className="aoStartupShell" role="status" aria-live="polite">
      <div className="aoStartupCard">
        <LoadingSurface
          eyebrow="API Router"
          title="Starting your local gateway"
          detail="Restoring the last workspace state, refreshing provider status, and warming up the control surface."
        />
      </div>
    </div>
  )
}

export function BootstrapApp() {
  const [shouldLoadApp, setShouldLoadApp] = useState(false)

  useEffect(() => {
    recordStartupStage('frontend_bootstrap_mounted')
    const rafId = window.requestAnimationFrame(() => {
      recordStartupStage('frontend_bootstrap_first_raf')
      startTransition(() => {
        setShouldLoadApp(true)
      })
      recordStartupStage('frontend_app_mount_scheduled')
    })
    return () => {
      window.cancelAnimationFrame(rafId)
    }
  }, [])

  if (!shouldLoadApp) {
    return <StartupShell />
  }

  return (
    <Suspense fallback={<StartupShell />}>
      <LazyApp />
    </Suspense>
  )
}
