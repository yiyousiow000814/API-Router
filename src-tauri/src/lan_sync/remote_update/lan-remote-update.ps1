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

function Get-RemoteUpdateBuildResultPath {
  $explicit = $env:API_ROUTER_REMOTE_UPDATE_BUILD_RESULT_PATH
  if ($explicit) { return $explicit }
  if (-not $env:API_ROUTER_USER_DATA_DIR) { return $null }
  return Join-Path $env:API_ROUTER_USER_DATA_DIR 'diagnostics\lan-remote-update-build-result.json'
}

function Reset-RemoteUpdateBuildResult {
  $resultPath = Get-RemoteUpdateBuildResultPath
  if (-not $resultPath) { return }
  Remove-Item -LiteralPath $resultPath -Force -ErrorAction SilentlyContinue
}

function Read-RemoteUpdateBuildResult {
  $resultPath = Get-RemoteUpdateBuildResultPath
  if (-not $resultPath -or -not (Test-Path -LiteralPath $resultPath)) {
    return $null
  }
  try {
    return Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json
  } catch {
    Write-RemoteUpdateLog ("Failed to read build result marker: " + $_.Exception.Message)
    return $null
  }
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
    from_git_sha = if ($env:API_ROUTER_REMOTE_UPDATE_FROM_GIT_SHA) { $env:API_ROUTER_REMOTE_UPDATE_FROM_GIT_SHA } else { $null }
    to_git_sha = if ($env:API_ROUTER_REMOTE_UPDATE_TO_GIT_SHA) { $env:API_ROUTER_REMOTE_UPDATE_TO_GIT_SHA } else { $null }
    current_git_sha = if ($env:API_ROUTER_REMOTE_UPDATE_CURRENT_GIT_SHA) { $env:API_ROUTER_REMOTE_UPDATE_CURRENT_GIT_SHA } else { $null }
    previous_git_sha = if ($env:API_ROUTER_REMOTE_UPDATE_PREVIOUS_GIT_SHA) { $env:API_ROUTER_REMOTE_UPDATE_PREVIOUS_GIT_SHA } else { $null }
    progress_percent = if ($env:API_ROUTER_REMOTE_UPDATE_PROGRESS_PERCENT) { [int]$env:API_ROUTER_REMOTE_UPDATE_PROGRESS_PERCENT } else { $null }
    rollback_available = ([string]$env:API_ROUTER_REMOTE_UPDATE_ROLLBACK_AVAILABLE -eq '1')
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

function Read-RemoteUpdateStatus {
  $statusPath = Get-RemoteUpdateStatusPath
  if (-not $statusPath -or -not (Test-Path -LiteralPath $statusPath)) {
    return $null
  }
  try {
    return Get-Content -LiteralPath $statusPath -Raw | ConvertFrom-Json
  } catch {
    Write-RemoteUpdateLog ("Failed to read remote update status marker: " + $_.Exception.Message)
    return $null
  }
}

function Set-RemoteUpdateProgress([int]$Percent) {
  $bounded = [Math]::Max(0, [Math]::Min(100, $Percent))
  $env:API_ROUTER_REMOTE_UPDATE_PROGRESS_PERCENT = [string]$bounded
}

function Get-CurrentGitSha {
  try {
    $sha = (& git rev-parse HEAD 2>$null)
    if ($LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace([string]$sha)) {
      return ([string]$sha).Trim()
    }
  } catch {
  }
  return $null
}

function Show-RemoteUpdateNotification {
  param(
    [Parameter(Mandatory = $true)]
    [string]$TargetRef
  )

  try {
    $trimmedTarget = $TargetRef.Trim()
    $shortTarget = if ($trimmedTarget.Length -gt 8) { $trimmedTarget.Substring(0, 8) } else { $trimmedTarget }
    $title = 'API Router update in progress'
    $body = if ([string]::IsNullOrWhiteSpace($shortTarget)) {
      'API Router is installing a remote update and will restart automatically when it finishes.'
    } else {
      "API Router is installing remote update $shortTarget and will restart automatically when it finishes."
    }

    $notificationScript = @'
param(
  [Parameter(Mandatory = $true)]
  [string]$PayloadPath
)

$ErrorActionPreference = 'Stop'
$payload = Get-Content -LiteralPath $PayloadPath -Raw | ConvertFrom-Json
$Title = [string]$payload.title
$Body = [string]$payload.body
$LogPath = [string]$payload.log_path

function Write-HelperLog([string]$Message) {
  if ([string]::IsNullOrWhiteSpace($LogPath)) { return }
  $timestamp = [DateTimeOffset]::UtcNow.ToString('dd-MM-yyyy HH:mm:ss.fff UTC')
  Add-Content -Path $LogPath -Value "[$timestamp] [notification-helper] $Message" -Encoding UTF8
}

try {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  $notifyIcon = New-Object System.Windows.Forms.NotifyIcon
  $notifyIcon.Icon = [System.Drawing.SystemIcons]::Information
  $notifyIcon.Visible = $true
  $notifyIcon.BalloonTipIcon = [System.Windows.Forms.ToolTipIcon]::Info
  $notifyIcon.BalloonTipTitle = $Title
  $notifyIcon.BalloonTipText = $Body
  $notifyIcon.ShowBalloonTip(10000)
  Write-HelperLog "ShowBalloonTip invoked: $Title ($Body)"
  $deadline = [DateTime]::UtcNow.AddSeconds(12)
  while ([DateTime]::UtcNow -lt $deadline) {
    [System.Windows.Forms.Application]::DoEvents()
    Start-Sleep -Milliseconds 100
  }
} catch {
  Write-HelperLog ("failed: " + $_.Exception.Message)
  exit 1
} finally {
  if ($notifyIcon) {
    $notifyIcon.Visible = $false
    $notifyIcon.Dispose()
  }
  Remove-Item -LiteralPath $PayloadPath -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue
}
'@

    $helperPath = Join-Path ([System.IO.Path]::GetTempPath()) ("api-router-remote-update-notify-{0}.ps1" -f ([guid]::NewGuid().ToString('N')))
    $payloadPath = Join-Path ([System.IO.Path]::GetTempPath()) ("api-router-remote-update-notify-{0}.json" -f ([guid]::NewGuid().ToString('N')))
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($helperPath, $notificationScript, $utf8NoBom)
    $logPath = Get-RemoteUpdateLogPath
    $payload = [ordered]@{
      title = $title
      body = $body
      log_path = if ($logPath) { $logPath } else { '' }
    } | ConvertTo-Json -Depth 3
    [System.IO.File]::WriteAllText($payloadPath, $payload, $utf8NoBom)
    $arguments = @(
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-Sta',
      '-File', $helperPath,
      '-PayloadPath', $payloadPath
    )
    $process = Start-Process -FilePath 'powershell.exe' `
      -ArgumentList $arguments `
      -WorkingDirectory $RepoRoot `
      -WindowStyle Hidden `
      -PassThru
    Write-RemoteUpdateLog "Windows notification helper launched: pid=$($process.Id); title=$title; body=$body; helper=$helperPath; payload=$payloadPath"
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

function Test-CommandOutputNoiseLine([string]$Line) {
  if (-not $Line) { return $true }
  return (
    $Line -match '^(vite v\d|\s*transforming|rendering chunks|computing gzip size|\s*dist/|\s*target/release/|warning:|Finished `release` profile)' -or
    $Line -match '^>\s*api-router@' -or
    $Line -match '^>\s*node\s+' -or
    $Line -match '^Line ending check passed' -or
    $Line -match '^\[check-[^\]]+\]\s+ok' -or
    $Line -match '^\d+\s+modules transformed\.?$' -or
    $Line -match '\bgzip:\s*\d' -or
    $Line -match '\bbuilt in \d' -or
    $Line -match '^At [A-Z]:\\' -or
    $Line -match '^At line:\d+' -or
    $Line -match '^CategoryInfo:' -or
    $Line -match '^FullyQualifiedErrorId' -or
    $Line -match '^Microsoft\.PowerShell\.' -or
    $Line -match '^Write-Error\b'
  )
}

function Format-CommandOutputSummary($Output) {
  if ($null -eq $Output) { return '' }
  $lines = @(
    $Output |
      ForEach-Object { Normalize-CommandOutputLine $_.ToString() } |
      Where-Object { $_ -and -not (Test-CommandOutputNoiseLine $_) }
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
  $normalized = [regex]::Replace($Line, '[^\u0009\u000A\u000D\u0020-\u007E]', ' ')
  $normalized = [regex]::Replace($normalized, '\x1b\[[0-9;?]*[ -/]*[@-~]', '')
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

function Format-ProcessFailureMessage([string]$FailureMessage, [string]$Summary, [int]$ExitCode) {
  if ($Summary) {
    return "${FailureMessage}: $Summary"
  }
  if ($ExitCode -gt 0) {
    return "${FailureMessage} with exit code $ExitCode"
  }
  return $FailureMessage
}

function Get-ProcessExitCodeOrNull {
  param(
    [Parameter(Mandatory = $true)]
    [System.Diagnostics.Process]$Process
  )

  try {
    $Process.Refresh()
  } catch {
  }
  try {
    return [Nullable[int]]$Process.ExitCode
  } catch {
    Write-RemoteUpdateLog ("Reading hidden process exit code failed: " + $_.Exception.Message)
    return $null
  }
}

function Format-HiddenProcessArgumentToken([string]$Argument) {
  if ($null -eq $Argument) { return '' }
  if ($Argument.Length -eq 0) { return '""' }
  if ($Argument -notmatch '[\s"]') { return $Argument }
  return '"' + $Argument.Replace('"', '\"') + '"'
}

function Format-HiddenProcessArgumentString {
  param([string[]]$ArgumentList)

  $tokens = @()
  foreach ($argument in $ArgumentList) {
    $token = Format-HiddenProcessArgumentToken $argument
    if ($token) { $tokens += $token }
  }
  return ($tokens -join ' ')
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
    throw (Format-ProcessFailureMessage $FailureMessage $summary $exitCode)
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

  # Remote update must stay visually silent on the peer machine.
  # Any nested PowerShell/cmd process launched from this worker must use hidden window style,
  # otherwise Windows can flash transient consoles during update/build/install stages.
  $stdoutPath = [System.IO.Path]::GetTempFileName()
  $stderrPath = [System.IO.Path]::GetTempFileName()
  $buildResultPath = Get-RemoteUpdateBuildResultPath
  $previousBuildResultPath = $env:API_ROUTER_REMOTE_UPDATE_BUILD_RESULT_PATH
  try {
    Reset-RemoteUpdateBuildResult
    if ($buildResultPath) {
      $env:API_ROUTER_REMOTE_UPDATE_BUILD_RESULT_PATH = $buildResultPath
    }
    Write-RemoteUpdateLog "Invoking hidden process: file=$FilePath args=$($ArgumentList -join ' ')"
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $FilePath
    $startInfo.Arguments = Format-HiddenProcessArgumentString -ArgumentList $ArgumentList
    $startInfo.WorkingDirectory = $RepoRoot
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $process = [System.Diagnostics.Process]::Start($startInfo)
    Write-RemoteUpdateLog "Hidden process started: pid=$($process.Id); file=$FilePath"
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    $process.WaitForExit()
    $exitCode = Get-ProcessExitCodeOrNull -Process $process
    $stdoutClosed = $stdoutTask.Wait(5000)
    $stderrClosed = $stderrTask.Wait(5000)
    if (-not $stdoutClosed -or -not $stderrClosed) {
      Write-RemoteUpdateLog ("Hidden process output stream did not close after process exit: stdout_closed={0}; stderr_closed={1}" -f `
          $stdoutClosed.ToString().ToLowerInvariant(),
          $stderrClosed.ToString().ToLowerInvariant())
    }
    $stdout = if ($stdoutClosed) { $stdoutTask.Result } else { '' }
    $stderr = if ($stderrClosed) { $stderrTask.Result } else { '' }
    if (-not $stdoutClosed) {
      try { $process.StandardOutput.Dispose() } catch {}
    }
    if (-not $stderrClosed) {
      try { $process.StandardError.Dispose() } catch {}
    }
    [System.IO.File]::WriteAllText($stdoutPath, [string]$stdout, [System.Text.UTF8Encoding]::new($false))
    [System.IO.File]::WriteAllText($stderrPath, [string]$stderr, [System.Text.UTF8Encoding]::new($false))
    $combinedOutput = @()
    if ($stdout) { $combinedOutput += $stdout -split "\r?\n" }
    if ($stderr) { $combinedOutput += $stderr -split "\r?\n" }
    $stdoutSummary = Format-CommandOutputSummary ($stdout -split "\r?\n")
    $stderrSummary = Format-CommandOutputSummary ($stderr -split "\r?\n")
    $buildResult = Read-RemoteUpdateBuildResult
    Write-RemoteUpdateLog ("Hidden process completed: file={0}; exit_code={1}; success_flag={2}; last_exit_code={3}; stdout_summary={4}; stderr_summary={5}" -f `
        $FilePath,
        $(if ($null -eq $exitCode) { '<null>' } else { $exitCode }),
        $?.ToString().ToLowerInvariant(),
        $LASTEXITCODE,
        $(if ($stdoutSummary) { $stdoutSummary } else { '<none>' }),
        $(if ($stderrSummary) { $stderrSummary } else { '<none>' }))
    Write-CommandOutputLog $combinedOutput
    if ($null -eq $exitCode) {
      if ($buildResult -and [string]$buildResult.result -eq 'succeeded') {
        Write-RemoteUpdateLog "Hidden process exit_code was <null>, but build result marker reported success. Treating nested build as succeeded."
        return
      }
      Write-RemoteUpdateLog "Hidden process exit_code was <null> and no success marker was available."
    }
    if (($null -ne $exitCode) -and ($exitCode -eq 0)) {
      return
    }
    if (($null -eq $exitCode) -and $buildResult -and [string]$buildResult.result -eq 'failed') {
      Write-RemoteUpdateLog "Hidden process exit_code was <null> and build result marker reported failure."
    }
    if (($null -ne $exitCode) -or $buildResult) {
      $summary = Format-CommandOutputSummary $combinedOutput
      $stdoutTail = Format-CommandOutputSummary ($stdout -split "\r?\n" | Select-Object -Last 20)
      $stderrTail = Format-CommandOutputSummary ($stderr -split "\r?\n" | Select-Object -Last 20)
      if ($summary) {
        Write-RemoteUpdateLog "Command failed output: $summary"
      }
      if ($stdoutTail) {
        Write-RemoteUpdateLog "Hidden process stdout tail: $stdoutTail"
      }
      if ($stderrTail) {
        Write-RemoteUpdateLog "Hidden process stderr tail: $stderrTail"
      }
      if ($buildResult) {
        Write-RemoteUpdateLog ("Hidden process build marker: result={0}; had_failure={1}; last_exit_code={2}; current_phase={3}; current_label={4}" -f `
            $buildResult.result,
            $buildResult.had_failure,
            $buildResult.last_exit_code,
            $buildResult.current_phase,
            $buildResult.current_label)
      }
      throw (Format-ProcessFailureMessage $FailureMessage $summary $exitCode)
    }
    throw "$FailureMessage; hidden process exited without a usable exit code or build result marker"
  } finally {
    if ($null -eq $previousBuildResultPath) {
      Remove-Item Env:\API_ROUTER_REMOTE_UPDATE_BUILD_RESULT_PATH -ErrorAction SilentlyContinue
    } else {
      $env:API_ROUTER_REMOTE_UPDATE_BUILD_RESULT_PATH = $previousBuildResultPath
    }
    Remove-Item -LiteralPath $stdoutPath -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $stderrPath -ErrorAction SilentlyContinue
  }
}

$startedAtUnixMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$currentStep = 'Bootstrapping worker'
$RepoRoot = $null

try {
Write-RemoteUpdateLog "Starting remote self-update for target ref $TargetRef"
$env:API_ROUTER_REMOTE_UPDATE_TARGET_REF = $TargetRef
Write-RemoteUpdateStatus -State 'running' -TargetRef $TargetRef -Detail (Step-Detail $currentStep "Bootstrapping remote self-update worker.") -Phase 'bootstrap' -Label 'Bootstrapping worker' -StartedAtUnixMs $startedAtUnixMs
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..\..')).Path
Set-Location $RepoRoot
$env:API_ROUTER_REMOTE_UPDATE_FROM_GIT_SHA = Get-CurrentGitSha
$env:API_ROUTER_REMOTE_UPDATE_CURRENT_GIT_SHA = $env:API_ROUTER_REMOTE_UPDATE_FROM_GIT_SHA
$env:API_ROUTER_REMOTE_UPDATE_ROLLBACK_AVAILABLE = '0'
Set-RemoteUpdateProgress 5
Start-Sleep -Seconds 1

$currentStep = 'Preparing worker'
Write-RemoteUpdateStatus -State 'running' -TargetRef $TargetRef -Detail (Step-Detail $currentStep "Starting remote self-update worker.") -Phase 'worker_started' -Label 'Worker started' -StartedAtUnixMs $startedAtUnixMs

$currentStep = 'Checking git worktree'
Set-RemoteUpdateProgress 10
Write-RemoteUpdateLog $currentStep
Write-RemoteUpdateStatus -State 'running' -TargetRef $TargetRef -Detail (Step-Detail $currentStep) -Phase 'git_status' -Label 'Checking git worktree' -StartedAtUnixMs $startedAtUnixMs
Assert-CleanWorktree

$currentStep = 'Fetching from origin'
Set-RemoteUpdateProgress 20
Write-RemoteUpdateLog $currentStep
Write-RemoteUpdateStatus -State 'running' -TargetRef $TargetRef -Detail (Step-Detail $currentStep) -Phase 'git_fetch' -Label 'Fetching from origin' -StartedAtUnixMs $startedAtUnixMs
Invoke-RemoteUpdateCommand -FailureMessage 'git fetch failed' -Command { git fetch origin --prune }

$currentStep = 'Resolving target ref'
Set-RemoteUpdateProgress 30
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

$env:API_ROUTER_REMOTE_UPDATE_TO_GIT_SHA = Get-CurrentGitSha
$env:API_ROUTER_REMOTE_UPDATE_CURRENT_GIT_SHA = $env:API_ROUTER_REMOTE_UPDATE_TO_GIT_SHA
Set-RemoteUpdateProgress 45

$currentStep = 'Building EXE'
$buildScriptPath = Join-Path $RepoRoot 'tools\build\build-root-exe.ps1'
if (-not (Test-Path $buildScriptPath)) {
  throw "missing build-root-exe script: $buildScriptPath"
}
Write-RemoteUpdateLog "${currentStep}: $buildScriptPath"
Write-RemoteUpdateStatus -State 'running' -TargetRef $TargetRef -Detail (Step-Detail $currentStep 'Running Windows EXE build and restart script') -Phase 'build_exe' -Label 'Building EXE' -StartedAtUnixMs $startedAtUnixMs
Show-RemoteUpdateNotification -TargetRef $TargetRef
Invoke-HiddenProcess -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $buildScriptPath, '-StartHidden') -FailureMessage 'tools/build/build-root-exe.ps1 failed'
Write-RemoteUpdateLog "build-root-exe.ps1 hidden invocation returned success to remote update worker."
$env:API_ROUTER_REMOTE_UPDATE_CURRENT_GIT_SHA = $env:API_ROUTER_REMOTE_UPDATE_TO_GIT_SHA
$env:API_ROUTER_REMOTE_UPDATE_PREVIOUS_GIT_SHA = $env:API_ROUTER_REMOTE_UPDATE_FROM_GIT_SHA
$env:API_ROUTER_REMOTE_UPDATE_ROLLBACK_AVAILABLE = '1'
Set-RemoteUpdateProgress 100

$currentStep = 'Completed'
Write-RemoteUpdateLog 'Remote self-update completed successfully.'
Write-RemoteUpdateStatus -State 'succeeded' -TargetRef $TargetRef -Detail (Step-Detail $currentStep 'Remote self-update completed successfully.') -Phase 'completed' -Label 'Remote update completed' -StartedAtUnixMs $startedAtUnixMs -FinishedAtUnixMs ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
} catch {
  $message = $_.Exception.Message
  Write-RemoteUpdateLog "$currentStep failed: $message"
  Write-RemoteUpdateLog ("Worker catch diagnostics: current_step={0}; success_flag={1}; last_exit_code={2}; exception_type={3}" -f `
      $currentStep,
      $?.ToString().ToLowerInvariant(),
      $LASTEXITCODE,
      $_.Exception.GetType().FullName)
  $existingStatus = Read-RemoteUpdateStatus
  $buildResult = Read-RemoteUpdateBuildResult
  if ($existingStatus -and [string]$existingStatus.state -eq 'rolled_back' -and $buildResult -and [string]$buildResult.result -eq 'rolled_back') {
    Write-RemoteUpdateLog 'Preserving rolled_back status written by nested build script.'
  } else {
    Write-RemoteUpdateStatus -State 'failed' -TargetRef $TargetRef -Detail (Step-Detail $currentStep $message) -Phase 'failed' -Label "$currentStep failed" -StartedAtUnixMs $startedAtUnixMs -FinishedAtUnixMs ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
  }
  throw
}
