param(
  [Parameter(Mandatory = $true)]
  [string]$TargetRef
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Get-RemoteUpdateStatusPath {
  $explicit = $env:API_ROUTER_REMOTE_UPDATE_STATUS_PATH
  if ($explicit) { return $explicit }
  if (-not $env:API_ROUTER_USER_DATA_DIR) { return $null }
  return Join-Path $env:API_ROUTER_USER_DATA_DIR 'diagnostics\lan-remote-update-status.json'
}

function Get-RemoteUpdateLogPath {
  $explicit = $env:API_ROUTER_REMOTE_UPDATE_LOG_PATH
  if ($explicit) { return $explicit }
  if (-not $env:API_ROUTER_USER_DATA_DIR) { return $null }
  return Join-Path $env:API_ROUTER_USER_DATA_DIR 'diagnostics\lan-remote-update.log'
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
  $timestamp = [DateTimeOffset]::UtcNow.ToString('yyyy-MM-dd HH:mm:ss.fff UTC')
  Add-Content -Path $logPath -Value "[$timestamp] $Message" -Encoding UTF8
}

function Write-RemoteUpdateStatus {
  param(
    [Parameter(Mandatory = $true)]
    [string]$State,
    [Parameter(Mandatory = $true)]
    [string]$TargetRef,
    [string]$Detail = '',
    [string]$Phase = '',
    [string]$Label = '',
    [string]$Source = 'worker',
    [Nullable[Int64]]$StartedAtUnixMs = $null,
    [Nullable[Int64]]$FinishedAtUnixMs = $null
  )

  $statusPath = Get-RemoteUpdateStatusPath
  if (-not $statusPath) { return }
  $parent = Split-Path -Parent $statusPath
  if ($parent) {
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
  }
  $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $acceptedAt = $now
  $requestId = if ($env:API_ROUTER_REMOTE_UPDATE_REQUEST_ID) { $env:API_ROUTER_REMOTE_UPDATE_REQUEST_ID } else { $null }
  $timeline = @()
  if (Test-Path $statusPath) {
    try {
      $existing = Get-Content $statusPath -Raw | ConvertFrom-Json
      if ($existing.accepted_at_unix_ms) {
        $acceptedAt = [int64]$existing.accepted_at_unix_ms
      }
      if ($existing.request_id) {
        $requestId = [string]$existing.request_id
      }
      if ($existing.timeline) {
        $timeline = @($existing.timeline)
      }
    } catch {
    }
  }
  $timelineDetail = if ($Detail) { $Detail } else { $null }
  $timelinePhase = if ($Phase) { $Phase } else { $State }
  $timelineLabel = if ($Label) { $Label } else { $State }
  $timelineSource = if ($Source) { $Source } else { 'worker' }
  $lastTimeline = if ($timeline.Count -gt 0) { $timeline[-1] } else { $null }
  $isDuplicate = $false
  if ($lastTimeline) {
    $isDuplicate =
      ([string]$lastTimeline.phase -eq $timelinePhase) -and
      ([string]$lastTimeline.label -eq $timelineLabel) -and
      ([string]$lastTimeline.source -eq $timelineSource) -and
      ([string]$lastTimeline.state -eq $State) -and
      (([string]$lastTimeline.detail) -eq ([string]$timelineDetail))
  }
  if (-not $isDuplicate) {
    $timeline += [ordered]@{
      unix_ms = $now
      phase = $timelinePhase
      label = $timelineLabel
      detail = $timelineDetail
      source = $timelineSource
      state = $State
    }
  }
  if ($timeline.Count -gt 24) {
    $timeline = @($timeline | Select-Object -Last 24)
  }
  $payload = [ordered]@{
    state = $State
    target_ref = $TargetRef
    request_id = $requestId
    requester_node_id = if ($env:API_ROUTER_REMOTE_UPDATE_REQUESTER_NODE_ID) { $env:API_ROUTER_REMOTE_UPDATE_REQUESTER_NODE_ID } else { $null }
    requester_node_name = if ($env:API_ROUTER_REMOTE_UPDATE_REQUESTER_NODE_NAME) { $env:API_ROUTER_REMOTE_UPDATE_REQUESTER_NODE_NAME } else { $null }
    worker_script = $PSCommandPath
    worker_pid = $PID
    detail = if ($Detail) { $Detail } else { $null }
    accepted_at_unix_ms = $acceptedAt
    started_at_unix_ms = if ($StartedAtUnixMs -ne $null) { [int64]$StartedAtUnixMs } else { $null }
    finished_at_unix_ms = if ($FinishedAtUnixMs -ne $null) { [int64]$FinishedAtUnixMs } else { $null }
    updated_at_unix_ms = $now
    timeline = $timeline
  }
  $payload | ConvertTo-Json -Depth 6 | Set-Content -Path $statusPath -Encoding UTF8
}

function Assert-CleanWorktree {
  $statusLines = & git status --porcelain=v1
  if ($LASTEXITCODE -ne 0) {
    throw 'git status failed'
  }
  if ($statusLines) {
    throw 'worktree is dirty; refusing remote self-update'
  }
}

function Resolve-CheckoutTarget([string]$Ref) {
  & git rev-parse --verify "refs/heads/$Ref" *> $null
  if ($LASTEXITCODE -eq 0) { return @{ Mode = 'local_branch'; Value = $Ref } }

  & git rev-parse --verify "refs/remotes/origin/$Ref" *> $null
  if ($LASTEXITCODE -eq 0) { return @{ Mode = 'remote_branch'; Value = $Ref } }

  & git rev-parse --verify $Ref *> $null
  if ($LASTEXITCODE -eq 0) { return @{ Mode = 'detached'; Value = $Ref } }

  throw "cannot resolve git ref: $Ref"
}

function Step-Detail([string]$Label, [string]$Detail = '') {
  if ($Detail) {
    return "${Label}: $Detail"
  }
  return $Label
}

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..\..')).Path
Set-Location $RepoRoot

Start-Sleep -Seconds 1

$startedAtUnixMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$currentStep = 'Preparing worker'
Write-RemoteUpdateLog "Starting remote self-update for target ref $TargetRef"
Write-RemoteUpdateStatus -State 'running' -TargetRef $TargetRef -Detail (Step-Detail $currentStep "Starting remote self-update worker.") -Phase 'worker_started' -Label 'Worker started' -StartedAtUnixMs $startedAtUnixMs

try {
$currentStep = 'Checking git worktree'
Write-RemoteUpdateLog $currentStep
Write-RemoteUpdateStatus -State 'running' -TargetRef $TargetRef -Detail (Step-Detail $currentStep) -Phase 'git_status' -Label 'Checking git worktree' -StartedAtUnixMs $startedAtUnixMs
Assert-CleanWorktree

$currentStep = 'Fetching from origin'
Write-RemoteUpdateLog $currentStep
Write-RemoteUpdateStatus -State 'running' -TargetRef $TargetRef -Detail (Step-Detail $currentStep) -Phase 'git_fetch' -Label 'Fetching from origin' -StartedAtUnixMs $startedAtUnixMs
& git fetch origin --prune --tags
if ($LASTEXITCODE -ne 0) {
  throw 'git fetch failed'
}

$currentStep = 'Resolving target ref'
Write-RemoteUpdateLog "${currentStep}: $TargetRef"
Write-RemoteUpdateStatus -State 'running' -TargetRef $TargetRef -Detail (Step-Detail $currentStep "Target $TargetRef") -Phase 'resolve_target' -Label 'Resolving target ref' -StartedAtUnixMs $startedAtUnixMs
$target = Resolve-CheckoutTarget $TargetRef
if ($target.Mode -eq 'local_branch') {
  $currentStep = 'Checking out local branch'
  Write-RemoteUpdateLog "${currentStep}: $($target.Value)"
  Write-RemoteUpdateStatus -State 'running' -TargetRef $TargetRef -Detail (Step-Detail $currentStep $target.Value) -Phase 'checkout_local_branch' -Label 'Checking out local branch' -StartedAtUnixMs $startedAtUnixMs
  & git checkout $target.Value
  if ($LASTEXITCODE -ne 0) { throw "git checkout failed: $($target.Value)" }
  $currentStep = 'Pulling latest branch'
  Write-RemoteUpdateLog "${currentStep}: $($target.Value)"
  Write-RemoteUpdateStatus -State 'running' -TargetRef $TargetRef -Detail (Step-Detail $currentStep $target.Value) -Phase 'pull_branch' -Label 'Pulling latest branch' -StartedAtUnixMs $startedAtUnixMs
  & git pull --ff-only origin $target.Value
  if ($LASTEXITCODE -ne 0) { throw "git pull failed: $($target.Value)" }
} elseif ($target.Mode -eq 'remote_branch') {
  $currentStep = 'Checking out remote branch'
  Write-RemoteUpdateLog "${currentStep}: $($target.Value)"
  Write-RemoteUpdateStatus -State 'running' -TargetRef $TargetRef -Detail (Step-Detail $currentStep $target.Value) -Phase 'checkout_remote_branch' -Label 'Checking out remote branch' -StartedAtUnixMs $startedAtUnixMs
  & git checkout -B $target.Value "refs/remotes/origin/$($target.Value)"
  if ($LASTEXITCODE -ne 0) { throw "git checkout -B failed: $($target.Value)" }
} else {
  $currentStep = 'Checking out commit'
  Write-RemoteUpdateLog "${currentStep}: $($target.Value)"
  Write-RemoteUpdateStatus -State 'running' -TargetRef $TargetRef -Detail (Step-Detail $currentStep $target.Value) -Phase 'checkout_commit' -Label 'Checking out commit' -StartedAtUnixMs $startedAtUnixMs
  & git checkout --detach $target.Value
  if ($LASTEXITCODE -ne 0) { throw "git checkout --detach failed: $($target.Value)" }
}

$currentStep = 'Building checked EXE'
Write-RemoteUpdateLog "${currentStep}: npm run build:root-exe:checked"
Write-RemoteUpdateStatus -State 'running' -TargetRef $TargetRef -Detail (Step-Detail $currentStep 'Running npm run build:root-exe:checked') -Phase 'build_checked_exe' -Label 'Building checked EXE' -StartedAtUnixMs $startedAtUnixMs
& npm.cmd run build:root-exe:checked
if ($LASTEXITCODE -ne 0) {
  throw 'npm run build:root-exe:checked failed'
}
$currentStep = 'Completed'
Write-RemoteUpdateLog 'Remote self-update completed successfully.'
Write-RemoteUpdateStatus -State 'succeeded' -TargetRef $TargetRef -Detail (Step-Detail $currentStep 'Remote self-update completed successfully.') -Phase 'completed' -Label 'Remote update completed' -StartedAtUnixMs $startedAtUnixMs -FinishedAtUnixMs ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
} catch {
  $message = $_.Exception.Message
  Write-RemoteUpdateLog "$currentStep failed: $message"
  Write-RemoteUpdateStatus -State 'failed' -TargetRef $TargetRef -Detail (Step-Detail $currentStep $message) -Phase 'failed' -Label "$currentStep failed" -StartedAtUnixMs $startedAtUnixMs -FinishedAtUnixMs ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
  throw
}
