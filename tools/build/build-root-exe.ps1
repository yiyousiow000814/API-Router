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

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\\..')).Path
$SrcExe = Join-Path $RepoRoot 'src-tauri\target\release\api_router.exe'
$DstExe = Join-Path $RepoRoot 'API Router.exe'
$DstTestExe = Join-Path $RepoRoot 'API Router [TEST].exe'

Write-Host "RepoRoot: $RepoRoot"

function Get-RemoteUpdateStatusPath {
  $path = [string]$env:API_ROUTER_REMOTE_UPDATE_STATUS_PATH
  if ([string]::IsNullOrWhiteSpace($path)) { return $null }
  return $path
}

function Get-RemoteUpdateLogPath {
  $path = [string]$env:API_ROUTER_REMOTE_UPDATE_LOG_PATH
  if ([string]::IsNullOrWhiteSpace($path)) { return $null }
  return $path
}

function Write-RemoteUpdateLog {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Message
  )

  $logPath = Get-RemoteUpdateLogPath
  if (-not $logPath) { return }
  $parent = Split-Path -Parent $logPath
  if ($parent) {
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
  }
  $timestamp = [DateTimeOffset]::UtcNow.ToString('dd-MM-yyyy HH:mm:ss.fff UTC')
  Add-Content -Path $logPath -Value "[$timestamp] [build-root-exe] $Message" -Encoding UTF8
}

function Update-RemoteUpdateTimelineStep {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Phase,
    [Parameter(Mandatory = $true)]
    [string]$Label,
    [Parameter(Mandatory = $true)]
    [string]$Detail,
    [string]$State = 'running',
    [Nullable[Int64]]$FinishedAtUnixMs = $null
  )

  $statusPath = Get-RemoteUpdateStatusPath
  if (-not $statusPath -or -not (Test-Path $statusPath)) { return }

  try {
    $status = Get-Content -LiteralPath $statusPath -Raw | ConvertFrom-Json
    if ($null -eq $status) { return }
    $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $timeline = @($status.timeline)
    $entry = [ordered]@{
      unix_ms = $now
      phase = $Phase
      label = $Label
      detail = $Detail
      source = 'build_root_exe'
      state = $State
    }
    $lastEntry = if ($timeline.Count -gt 0) { $timeline[-1] } else { $null }
    $isDuplicate = $false
    if ($lastEntry) {
      $isDuplicate =
        ([string]$lastEntry.phase -eq $Phase) -and
        ([string]$lastEntry.label -eq $Label) -and
        ([string]$lastEntry.detail -eq $Detail) -and
        ([string]$lastEntry.source -eq 'build_root_exe') -and
        ([string]$lastEntry.state -eq $State)
    }
    if (-not $isDuplicate) {
      $timeline += $entry
      if ($timeline.Count -gt 24) {
        $timeline = @($timeline | Select-Object -Last 24)
      }
    }

    $status.state = $State
    $status.detail = $Detail
    $status.updated_at_unix_ms = $now
    if ($status.started_at_unix_ms -eq $null) {
      $status.started_at_unix_ms = $now
    }
    if ($FinishedAtUnixMs -ne $null) {
      $status.finished_at_unix_ms = [int64]$FinishedAtUnixMs
    }
    $status.timeline = $timeline

    $json = $status | ConvertTo-Json -Depth 8
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($statusPath, $json, $utf8NoBom)
  } catch {
    Write-RemoteUpdateLog ("Failed to append nested remote update step '$Phase': " + $_.Exception.Message)
  }
}

function Enter-BuildStep {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Phase,
    [Parameter(Mandatory = $true)]
    [string]$Label,
    [Parameter(Mandatory = $true)]
    [string]$Detail
  )

  $script:CurrentBuildStepPhase = $Phase
  $script:CurrentBuildStepLabel = $Label
  $script:CurrentBuildStepDetail = $Detail
  Write-Host "${Label}: $Detail"
  Write-RemoteUpdateLog "${Label}: $Detail"
  Update-RemoteUpdateTimelineStep -Phase $Phase -Label $Label -Detail "${Label}: $Detail"
}

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
$restartWarning = $null
$script:CurrentBuildStepPhase = ''
$script:CurrentBuildStepLabel = ''
$script:CurrentBuildStepDetail = ''
try {
  # Build frontend (tsc + vite build). Note: tauri build runs this again via beforeBuildCommand,
  # but we keep this here so failures surface early and with clearer output.
  Enter-BuildStep -Phase 'build_frontend' -Label 'Building frontend' -Detail 'Running npm run build'
  Write-Host "Running: npm run build"
  & npm.cmd run build
  Assert-LastExitOk 'npm run build'

  # Build tauri app (produces src-tauri/target/release/api_router.exe).
  Enter-BuildStep -Phase 'build_release_binary' -Label 'Building release binary' -Detail 'Running npm run tauri -- build --no-bundle'
  Write-Host "Running: npm run tauri -- build --no-bundle"
  & npm.cmd run tauri -- build --no-bundle
  Assert-LastExitOk 'tauri build'

  if (-not $NoCopy) {
    Enter-BuildStep -Phase 'install_release_binary' -Label 'Installing EXE' -Detail 'Replacing repo root API Router executables'
    if (-not (Test-Path $SrcExe)) { throw "Missing built exe: $SrcExe" }

    Stop-RunningApiRouter
    Copy-WithRetry $SrcExe $DstExe
    Copy-WithRetry $SrcExe $DstTestExe
    Write-Host "Wrote: $DstExe"
    Write-Host "Wrote: $DstTestExe"
    Write-RemoteUpdateLog "Installed root executables: $DstExe and $DstTestExe"
  }
} catch {
  $hadFailure = $true
  $failureContext = if ($script:CurrentBuildStepLabel) {
    "$($script:CurrentBuildStepLabel): $($_.Exception.Message)"
  } else {
    $_.Exception.Message
  }
  Write-RemoteUpdateLog "Build step failed: $failureContext"
  if ($script:CurrentBuildStepPhase -and $script:CurrentBuildStepLabel) {
    Update-RemoteUpdateTimelineStep `
      -Phase $script:CurrentBuildStepPhase `
      -Label "$($script:CurrentBuildStepLabel) failed" `
      -Detail $failureContext `
      -State 'running'
  }
  Write-Error $_
} finally {
  # Always ensure API Router is running again. This is critical: if it is closed,
  # Codex sessions are stopped.
  try {
    Enter-BuildStep -Phase 'restart_api_router' -Label 'Restarting API Router' -Detail 'Launching repo root API Router.exe'
    Start-ApiRouter
  } catch {
    $restartWarning = $_
    Write-RemoteUpdateLog ("Restart warning: " + $_.Exception.Message)
    Update-RemoteUpdateTimelineStep `
      -Phase 'restart_api_router' `
      -Label 'Restarting API Router' `
      -Detail ("Restarting API Router: " + $_.Exception.Message) `
      -State 'running'
    Write-Warning ("API Router restart after build failed: " + $_.Exception.Message)
  }
}

if ($hadFailure) {
  exit 1
}

if ($null -ne $restartWarning) {
  Write-Warning "Windows EXE build succeeded, but the restart attempt failed. See warning above."
}
