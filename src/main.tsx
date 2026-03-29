import React from 'react'
import ReactDOM from 'react-dom/client'
import './style.css'
import { BootstrapApp } from './ui/BootstrapApp'
import { flushQueuedStartupStages, recordStartupStage } from './ui/startupTrace'

const root = ReactDOM.createRoot(document.getElementById('app')!)
flushQueuedStartupStages()
recordStartupStage('frontend_main_module_start')
recordStartupStage('frontend_create_root')

root.render(
  <React.StrictMode>
    <BootstrapApp />
  </React.StrictMode>,
)
recordStartupStage('frontend_shell_render_called')

if (typeof window !== 'undefined') {
  window.requestAnimationFrame(() => {
    recordStartupStage('frontend_main_first_raf')
    window.requestAnimationFrame(() => {
      recordStartupStage('frontend_main_second_raf')
    })
  })
  window.addEventListener(
    'load',
    () => {
      recordStartupStage('frontend_window_load', document.readyState)
    },
    { once: true },
  )
}
