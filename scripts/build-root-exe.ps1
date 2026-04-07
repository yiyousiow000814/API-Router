param(
  [switch]$NoCopy,
  [switch]$TestProfile,
  [switch]$StartHidden
)

$ErrorActionPreference = 'Stop'

function Assert-LastExitOk([string]$Step) {
  if ($LASTEXITCODE -ne 0) { throw "$Step failed with exit code $LASTEXITCODE" }
}

$ProgressPreference = 'SilentlyContinue'

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$SrcExe = Join-Path $RepoRoot 'src-tauri\target\release\api_router.exe'
$DstExe = Join-Path $RepoRoot 'API Router.exe'
$DstTestExe = Join-Path $RepoRoot 'API Router [TEST].exe'

Write-Host "RepoRoot: $RepoRoot"

function Is-ApiRouterRunning {
  try {
    $p = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and ($_.Path -ieq $DstExe) } | Select-Object -First 1
    return [bool]$p
  } catch {
    return $false
  }
}

function Start-ApiRouter {
  if (Is-ApiRouterRunning) {
    Write-Host "API Router already running."
    return
  }
  if (-not (Test-Path $DstExe)) {
    Write-Warning "Missing root exe: $DstExe (cannot restart)"
    return
  }
  $env:API_ROUTER_PROFILE = $null
  if ($TestProfile) { $env:API_ROUTER_PROFILE = 'test' }
  $arguments = @()
  if ($StartHidden) { $arguments += '--start-hidden' }
  Write-Host "Starting: $DstExe"
  if ($arguments.Count -gt 0) {
    Start-Process -FilePath $DstExe -ArgumentList $arguments -WorkingDirectory $RepoRoot | Out-Null
  } else {
    Start-Process -FilePath $DstExe -WorkingDirectory $RepoRoot | Out-Null
  }
}

function Stop-RunningApiRouter {
  # Best-effort: if the root EXE is running, replacing it will fail with EPERM/EBUSY.
  # We stop by both image name and by exact path.
  try { Stop-Process -Name 'API Router' -Force -ErrorAction SilentlyContinue } catch {}
  try { Stop-Process -Name 'API Router [TEST]' -Force -ErrorAction SilentlyContinue } catch {}
  try { Stop-Process -Name 'api_router' -Force -ErrorAction SilentlyContinue } catch {}
  try {
    Get-Process -ErrorAction SilentlyContinue | Where-Object {
      $_.Path -and (($_.Path -ieq $DstExe) -or ($_.Path -ieq $DstTestExe) -or ($_.Path -ieq $SrcExe))
    } | Stop-Process -Force -ErrorAction SilentlyContinue
  } catch {}

  if ($IsWindows) {
    try { & taskkill.exe /F /IM 'API Router.exe' /T | Out-Null } catch {}
    try { & taskkill.exe /F /IM 'API Router [TEST].exe' /T | Out-Null } catch {}
    try { & taskkill.exe /F /IM 'api_router.exe' /T | Out-Null } catch {}
  }
}

function Copy-WithRetry([string]$From, [string]$To) {
  $attempts = 8
  for ($i = 1; $i -le $attempts; $i++) {
    try {
      Copy-Item -Force $From $To
      return
    } catch {
      if ($i -eq $attempts) { throw }
      Stop-RunningApiRouter
      Start-Sleep -Milliseconds (250 + ($i * 150))
    }
  }
}

$hadFailure = $false
try {
  # Build frontend (tsc + vite build). Note: tauri build runs this again via beforeBuildCommand,
  # but we keep this here so failures surface early and with clearer output.
  Write-Host "Running: npm run build"
  & npm.cmd run build
  Assert-LastExitOk 'npm run build'

  # Build tauri app (produces src-tauri/target/release/api_router.exe).
  Write-Host "Running: npm run tauri -- build --no-bundle"
  & npm.cmd run tauri -- build --no-bundle
  Assert-LastExitOk 'tauri build'

  if (-not $NoCopy) {
    if (-not (Test-Path $SrcExe)) { throw "Missing built exe: $SrcExe" }

    Stop-RunningApiRouter
    Copy-WithRetry $SrcExe $DstExe
    Copy-WithRetry $SrcExe $DstTestExe
    Write-Host "Wrote: $DstExe"
    Write-Host "Wrote: $DstTestExe"
  }
} catch {
  $hadFailure = $true
  Write-Error $_
} finally {
  # Always ensure API Router is running again. This is critical: if it is closed,
  # Codex sessions are stopped.
  Start-ApiRouter
}

if ($hadFailure) {
  exit 1
}
