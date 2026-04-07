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
  $timestamp = [DateTimeOffset]::UtcNow.ToString('dd-MM-yyyy HH:mm:ss.fff UTC')
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
  $json = $payload | ConvertTo-Json -Depth 6
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($statusPath, $json, $utf8NoBom)
}

function Show-RemoteUpdateNotification {
  param(
    [Parameter(Mandatory = $true)]
    [string]$TargetRef
  )

  try {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing

    $trimmedTarget = $TargetRef.Trim()
    $shortTarget = if ($trimmedTarget.Length -gt 8) { $trimmedTarget.Substring(0, 8) } else { $trimmedTarget }
    $title = 'API Router update in progress'
    $body = if ([string]::IsNullOrWhiteSpace($shortTarget)) {
      'API Router is installing a remote update and will restart automatically when it finishes.'
    } else {
      "API Router is installing remote update $shortTarget and will restart automatically when it finishes."
    }

    $script:RemoteUpdateNotifyIcon = New-Object System.Windows.Forms.NotifyIcon
    $script:RemoteUpdateNotifyIcon.Icon = [System.Drawing.SystemIcons]::Information
    $script:RemoteUpdateNotifyIcon.Visible = $true
    $script:RemoteUpdateNotifyIcon.BalloonTipIcon = [System.Windows.Forms.ToolTipIcon]::Info
    $script:RemoteUpdateNotifyIcon.BalloonTipTitle = $title
    $script:RemoteUpdateNotifyIcon.BalloonTipText = $body
    $script:RemoteUpdateNotifyIcon.ShowBalloonTip(10000)
    Write-RemoteUpdateLog "Windows notification shown: $title ($body)"
  } catch {
    Write-RemoteUpdateLog "Windows notification failed: $($_.Exception.Message)"
  }
}

function Assert-CleanWorktree {
  $statusLines = & git status --porcelain=v1 2>&1
  if ($LASTEXITCODE -ne 0) {
    $summary = Format-CommandOutputSummary $statusLines
    if ($summary) {
      throw "git status failed. Output: $summary"
    }
    throw 'git status failed'
  }
  if ($statusLines) {
    $summary = Format-CommandOutputSummary $statusLines
    if ($summary) {
      throw "worktree is dirty; refusing remote self-update. Pending changes: $summary"
    }
    throw 'worktree is dirty; refusing remote self-update'
  }
}

function Resolve-CheckoutTarget([string]$Ref) {
  if (Test-GitRevisionExists "refs/heads/$Ref") {
    return @{ Mode = 'local_branch'; Value = $Ref }
  }

  if (Test-GitRevisionExists "refs/remotes/origin/$Ref") {
    return @{ Mode = 'remote_branch'; Value = $Ref }
  }

  if (Test-GitRevisionExists $Ref) {
    return @{ Mode = 'detached'; Value = $Ref }
  }

  throw "cannot resolve git ref: $Ref"
}

function Step-Detail([string]$Label, [string]$Detail = '') {
  if ($Detail) {
    return "${Label}: $Detail"
  }
  return $Label
}

function Format-CommandOutputSummary($Output) {
  if ($null -eq $Output) { return '' }
  $lines = @(
    $Output |
      ForEach-Object { Normalize-CommandOutputLine $_.ToString() } |
      Where-Object { $_ }
  )
  if ($lines.Count -eq 0) { return '' }
  $text = ($lines | Select-Object -Last 6) -join ' | '
  if (-not $text) { return '' }
  $text = [regex]::Replace($text, '\s+', ' ')
  if ($text.Length -gt 800) {
    return $text.Substring($text.Length - 800)
  }
  return $text
}

function Normalize-CommandOutputLine([string]$Line) {
  if (-not $Line) { return '' }
  $normalized = [regex]::Replace($Line, '\x1b\[[0-9;?]*[ -/]*[@-~]', '')
  $normalized = [regex]::Replace($normalized, '\s+', ' ').Trim()
  if (-not $normalized) { return '' }
  if ($normalized -match '^(vite v\d|\s*transforming|computing gzip size|\s*dist/|\s*target/release/|warning:|Finished `release` profile)') {
    return ''
  }
  return $normalized
}

function Write-CommandOutputLog($Output, [switch]$LogOnSuccess) {
  if ($null -eq $Output) { return }
  if (-not $LogOnSuccess) { return }
  foreach ($line in ($Output | ForEach-Object { Normalize-CommandOutputLine $_.ToString() })) {
    if ($line) {
      Write-RemoteUpdateLog $line
    }
  }
}

function Test-GitRevisionExists {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Spec
  )

  $exitCode = $null
  $previousErrorActionPreference = $ErrorActionPreference
  $nativeErrorActionPreferenceVariable = Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue
  $previousNativeErrorActionPreference = $null
  try {
    $ErrorActionPreference = 'Continue'
    if ($nativeErrorActionPreferenceVariable) {
      $previousNativeErrorActionPreference = [bool]$nativeErrorActionPreferenceVariable.Value
      $script:PSNativeCommandUseErrorActionPreference = $false
    }
    & git rev-parse --verify $Spec *> $null
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
    if ($nativeErrorActionPreferenceVariable) {
      $script:PSNativeCommandUseErrorActionPreference = $previousNativeErrorActionPreference
    }
  }

  return $exitCode -eq 0
}

function Invoke-RemoteUpdateCommand {
  param(
    [Parameter(Mandatory = $true)]
    [string]$FailureMessage,
    [Parameter(Mandatory = $true)]
    [scriptblock]$Command,
    [switch]$LogOnSuccess
  )

  $output = @()
  $exitCode = $null
  $previousErrorActionPreference = $ErrorActionPreference
  $nativeErrorActionPreferenceVariable = Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue
  $previousNativeErrorActionPreference = $null
  try {
    $ErrorActionPreference = 'Continue'
    if ($nativeErrorActionPreferenceVariable) {
      $previousNativeErrorActionPreference = [bool]$nativeErrorActionPreferenceVariable.Value
      $script:PSNativeCommandUseErrorActionPreference = $false
    }
    $output = & $Command 2>&1
    $exitCode = $LASTEXITCODE
  } catch {
    $summary = Format-CommandOutputSummary @($output + $_.Exception.Message)
    if ($summary) {
      throw "${FailureMessage}. Output: $summary"
    }
    throw $FailureMessage
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
    if ($nativeErrorActionPreferenceVariable) {
      $script:PSNativeCommandUseErrorActionPreference = $previousNativeErrorActionPreference
    }
  }
  Write-CommandOutputLog $output -LogOnSuccess:$LogOnSuccess
  if ($exitCode -ne 0) {
    $summary = Format-CommandOutputSummary $output
    if ($summary) {
      Write-RemoteUpdateLog "Command failed output: $summary"
    }
    if ($summary) {
      throw "${FailureMessage}. Output: $summary"
    }
    throw $FailureMessage
  }
}

function Invoke-HiddenProcess {
  param(
    [Parameter(Mandatory = $true)]
    [string]$FilePath,
    [Parameter(Mandatory = $true)]
    [string[]]$ArgumentList,
    [Parameter(Mandatory = $true)]
    [string]$FailureMessage
  )

  $stdoutPath = [System.IO.Path]::GetTempFileName()
  $stderrPath = [System.IO.Path]::GetTempFileName()
  try {
    $process = Start-Process -FilePath $FilePath `
      -ArgumentList $ArgumentList `
      -WorkingDirectory $RepoRoot `
      -NoNewWindow:$false `
      -WindowStyle Hidden `
      -RedirectStandardOutput $stdoutPath `
      -RedirectStandardError $stderrPath `
      -PassThru
    $process.WaitForExit()
    $stdout = if (Test-Path $stdoutPath) { Get-Content -Path $stdoutPath -Raw -ErrorAction SilentlyContinue } else { '' }
    $stderr = if (Test-Path $stderrPath) { Get-Content -Path $stderrPath -Raw -ErrorAction SilentlyContinue } else { '' }
    $combinedOutput = @()
    if ($stdout) { $combinedOutput += $stdout -split "\r?\n" }
    if ($stderr) { $combinedOutput += $stderr -split "\r?\n" }
    Write-CommandOutputLog $combinedOutput
    if ($process.ExitCode -ne 0) {
      $summary = Format-CommandOutputSummary $combinedOutput
      if ($summary) {
        Write-RemoteUpdateLog "Command failed output: $summary"
        throw "${FailureMessage}. Output: $summary"
      }
      throw $FailureMessage
    }
  } finally {
    Remove-Item -LiteralPath $stdoutPath -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $stderrPath -ErrorAction SilentlyContinue
  }
}

$startedAtUnixMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$currentStep = 'Bootstrapping worker'
$RepoRoot = $null

try {
Write-RemoteUpdateLog "Starting remote self-update for target ref $TargetRef"
Write-RemoteUpdateStatus -State 'running' -TargetRef $TargetRef -Detail (Step-Detail $currentStep "Bootstrapping remote self-update worker.") -Phase 'bootstrap' -Label 'Bootstrapping worker' -StartedAtUnixMs $startedAtUnixMs
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..\..')).Path
Set-Location $RepoRoot
Start-Sleep -Seconds 1

$currentStep = 'Preparing worker'
Write-RemoteUpdateStatus -State 'running' -TargetRef $TargetRef -Detail (Step-Detail $currentStep "Starting remote self-update worker.") -Phase 'worker_started' -Label 'Worker started' -StartedAtUnixMs $startedAtUnixMs

$currentStep = 'Checking git worktree'
Write-RemoteUpdateLog $currentStep
Write-RemoteUpdateStatus -State 'running' -TargetRef $TargetRef -Detail (Step-Detail $currentStep) -Phase 'git_status' -Label 'Checking git worktree' -StartedAtUnixMs $startedAtUnixMs
Assert-CleanWorktree

$currentStep = 'Fetching from origin'
Write-RemoteUpdateLog $currentStep
Write-RemoteUpdateStatus -State 'running' -TargetRef $TargetRef -Detail (Step-Detail $currentStep) -Phase 'git_fetch' -Label 'Fetching from origin' -StartedAtUnixMs $startedAtUnixMs
Invoke-RemoteUpdateCommand -FailureMessage 'git fetch failed' -Command { git fetch origin --prune }

$currentStep = 'Resolving target ref'
Write-RemoteUpdateLog "${currentStep}: $TargetRef"
Write-RemoteUpdateStatus -State 'running' -TargetRef $TargetRef -Detail (Step-Detail $currentStep "Target $TargetRef") -Phase 'resolve_target' -Label 'Resolving target ref' -StartedAtUnixMs $startedAtUnixMs
$target = Resolve-CheckoutTarget $TargetRef
if ($target.Mode -eq 'local_branch') {
  $currentStep = 'Checking out local branch'
  Write-RemoteUpdateLog "${currentStep}: $($target.Value)"
  Write-RemoteUpdateStatus -State 'running' -TargetRef $TargetRef -Detail (Step-Detail $currentStep $target.Value) -Phase 'checkout_local_branch' -Label 'Checking out local branch' -StartedAtUnixMs $startedAtUnixMs
  Invoke-RemoteUpdateCommand -FailureMessage "git checkout failed: $($target.Value)" -Command { git checkout $target.Value }
  $currentStep = 'Pulling latest branch'
  Write-RemoteUpdateLog "${currentStep}: $($target.Value)"
  Write-RemoteUpdateStatus -State 'running' -TargetRef $TargetRef -Detail (Step-Detail $currentStep $target.Value) -Phase 'pull_branch' -Label 'Pulling latest branch' -StartedAtUnixMs $startedAtUnixMs
  Invoke-RemoteUpdateCommand -FailureMessage "git pull failed: $($target.Value)" -Command { git pull --ff-only origin $target.Value }
} elseif ($target.Mode -eq 'remote_branch') {
  $currentStep = 'Checking out remote branch'
  Write-RemoteUpdateLog "${currentStep}: $($target.Value)"
  Write-RemoteUpdateStatus -State 'running' -TargetRef $TargetRef -Detail (Step-Detail $currentStep $target.Value) -Phase 'checkout_remote_branch' -Label 'Checking out remote branch' -StartedAtUnixMs $startedAtUnixMs
  Invoke-RemoteUpdateCommand -FailureMessage "git checkout -B failed: $($target.Value)" -Command { git checkout -B $target.Value "refs/remotes/origin/$($target.Value)" }
} else {
  $currentStep = 'Checking out commit'
  Write-RemoteUpdateLog "${currentStep}: $($target.Value)"
  Write-RemoteUpdateStatus -State 'running' -TargetRef $TargetRef -Detail (Step-Detail $currentStep $target.Value) -Phase 'checkout_commit' -Label 'Checking out commit' -StartedAtUnixMs $startedAtUnixMs
  Invoke-RemoteUpdateCommand -FailureMessage "git checkout --detach failed: $($target.Value)" -Command { git checkout --detach $target.Value }
}

$currentStep = 'Building EXE'
$buildScriptPath = Join-Path $RepoRoot 'tools\build\build-root-exe.ps1'
if (-not (Test-Path $buildScriptPath)) {
  throw "missing build-root-exe script: $buildScriptPath"
}
Write-RemoteUpdateLog "${currentStep}: $buildScriptPath"
Write-RemoteUpdateStatus -State 'running' -TargetRef $TargetRef -Detail (Step-Detail $currentStep 'Running Windows EXE build and restart script') -Phase 'build_exe' -Label 'Building EXE' -StartedAtUnixMs $startedAtUnixMs
Show-RemoteUpdateNotification -TargetRef $TargetRef
Invoke-HiddenProcess -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $buildScriptPath, '-StartHidden') -FailureMessage 'tools/build/build-root-exe.ps1 failed'

$currentStep = 'Completed'
Write-RemoteUpdateLog 'Remote self-update completed successfully.'
Write-RemoteUpdateStatus -State 'succeeded' -TargetRef $TargetRef -Detail (Step-Detail $currentStep 'Remote self-update completed successfully.') -Phase 'completed' -Label 'Remote update completed' -StartedAtUnixMs $startedAtUnixMs -FinishedAtUnixMs ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
} catch {
  $message = $_.Exception.Message
  Write-RemoteUpdateLog "$currentStep failed: $message"
  Write-RemoteUpdateStatus -State 'failed' -TargetRef $TargetRef -Detail (Step-Detail $currentStep $message) -Phase 'failed' -Label "$currentStep failed" -StartedAtUnixMs $startedAtUnixMs -FinishedAtUnixMs ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
  throw
}
