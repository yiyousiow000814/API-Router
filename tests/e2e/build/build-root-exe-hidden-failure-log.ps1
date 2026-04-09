param()

$ErrorActionPreference = 'Stop'

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\\..\\..')).Path
$ScriptPath = Join-Path $RepoRoot 'tools\build\build-root-exe.ps1'
if (-not (Test-Path $ScriptPath)) { throw "Missing script: $ScriptPath" }

$tempRoot = Join-Path $RepoRoot 'user-data\tmp\build-root-exe-hidden-failure-log'
$fakeBin = Join-Path $tempRoot 'fake-bin'
$statusPath = Join-Path $tempRoot 'diagnostics\lan-remote-update-status.json'
$logPath = Join-Path $tempRoot 'diagnostics\lan-remote-update.log'
$resultPath = Join-Path $tempRoot 'diagnostics\lan-remote-update-build-result.json'
$stdoutPath = Join-Path $tempRoot 'stdout.log'
$stderrPath = Join-Path $tempRoot 'stderr.log'
$fakeTscPath = Join-Path $fakeBin 'tsc.cmd'
$fakeVitePath = Join-Path $fakeBin 'vite.cmd'

Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $fakeBin, (Split-Path -Parent $statusPath) | Out-Null

$fakeNpmPath = Join-Path $fakeBin 'npm.cmd'
Set-Content -LiteralPath $fakeNpmPath -Encoding Ascii -Value @'
@echo off
if "%1"=="run" if "%2"=="check:gateway-provider-id" exit /b 0
if "%1"=="run" if "%2"=="check:line-endings" exit /b 0
if "%1"=="run" if "%2"=="check:web-codex-assets" exit /b 0
if "%1"=="run" if "%2"=="tauri" exit /b 0
echo unexpected fake npm invocation %*
exit /b 9
'@

Set-Content -LiteralPath $fakeTscPath -Encoding Ascii -Value @'
@echo off
exit /b 0
'@

Set-Content -LiteralPath $fakeVitePath -Encoding Ascii -Value @'
@echo off
echo vite v7.3.1 building client environment for production...
echo 210 modules transformed.
>&2 echo error during build: EPERM: operation not permitted, rename dist\assets\app.js
exit /b 1
'@

$initialStatus = @{
  state = 'running'
  target_ref = 'deadbeef'
  request_id = 'ru_test'
  detail = 'Building frontend: Running npm run build'
  accepted_at_unix_ms = 1
  started_at_unix_ms = 2
  finished_at_unix_ms = $null
  updated_at_unix_ms = 3
  timeline = @()
} | ConvertTo-Json -Depth 6
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($statusPath, $initialStatus, $utf8NoBom)

$env:API_ROUTER_REMOTE_UPDATE_STATUS_PATH = $statusPath
$env:API_ROUTER_REMOTE_UPDATE_LOG_PATH = $logPath
$env:API_ROUTER_REMOTE_UPDATE_BUILD_RESULT_PATH = $resultPath
$env:PATH = "$fakeBin;$env:PATH"
$env:API_ROUTER_BUILD_NPM_PATH = $fakeNpmPath
$env:API_ROUTER_BUILD_TSC_PATH = $fakeTscPath
$env:API_ROUTER_BUILD_VITE_PATH = $fakeVitePath

$p = Start-Process -FilePath 'powershell.exe' -ArgumentList @(
  '-NoProfile',
  '-ExecutionPolicy', 'Bypass',
  '-File', $ScriptPath,
  '-NoCopy',
  '-StartHidden'
) -WorkingDirectory $RepoRoot -NoNewWindow -PassThru -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath

$p.WaitForExit()

if ($p.ExitCode -eq 0) {
  throw 'Expected build-root-exe.ps1 to fail when fake npm build exits 1'
}
if (-not (Test-Path $logPath)) {
  throw "Expected diagnostics log at $logPath"
}

$log = Get-Content -LiteralPath $logPath -Raw
if ($log -notmatch 'vite build stderr tail:') {
  throw "Expected stderr tail marker in diagnostics log.`n$log"
}
if ($log -notmatch 'error during build: EPERM: operation not permitted, rename dist\\assets\\app\.js') {
  throw "Expected real stderr failure line in diagnostics log.`n$log"
}
if ($log -notmatch 'Building frontend assets: vite build failed: error during build: EPERM: operation not permitted, rename dist\\assets\\app\.js') {
  throw "Expected cleaned failure summary in diagnostics log.`n$log"
}
if ($log -notmatch 'Checking provider ids: Running npm run check:gateway-provider-id') {
  throw "Expected granular provider id step in diagnostics log.`n$log"
}
if ($log -notmatch 'Checking line endings: Running npm run check:line-endings') {
  throw "Expected granular line ending step in diagnostics log.`n$log"
}
if ($log -notmatch 'Checking web assets: Running npm run check:web-codex-assets') {
  throw "Expected granular web asset step in diagnostics log.`n$log"
}
if ($log -notmatch 'TypeScript compile: Running tsc') {
  throw "Expected granular TypeScript step in diagnostics log.`n$log"
}
if ($log -notmatch 'Building frontend assets: Running vite build') {
  throw "Expected granular vite step in diagnostics log.`n$log"
}
if ($log -notmatch 'Build script final state: result=failed; had_failure=true;') {
  throw "Expected final failure diagnostics in diagnostics log.`n$log"
}
if (-not (Test-Path -LiteralPath $resultPath)) {
  throw "Expected build result marker at $resultPath"
}
$result = Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json
if ([string]$result.result -ne 'failed') {
  throw "Expected build result marker to report failure.`n$($result | ConvertTo-Json -Depth 4)"
}

Write-Host '[build-root-exe-hidden-failure-log.e2e] PASS'
