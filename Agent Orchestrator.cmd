@echo off
setlocal

rem Convenience launcher so you don't have to dig into src-tauri\target\...
set "EXE=%~dp0src-tauri\target\release\agent_orchestrator.exe"

if exist "%EXE%" (
  start "" "%EXE%"
  exit /b 0
)

echo Agent Orchestrator is not built yet.
echo Run (in this folder):
echo   npm install
echo   npm run tauri build
echo Then re-run this launcher.
pause
exit /b 1

