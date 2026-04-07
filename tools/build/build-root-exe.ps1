param(
  [switch]$NoCopy,
  [switch]$TestProfile,
  [switch]$StartHidden
)

$ErrorActionPreference = 'Stop'

function Assert-LastExitOk([string]$Step) {
  if ($LASTEXITCODE -ne 0) { throw "$Step failed with exit code $LASTEXITCODE" }
}

function Reset-LastExitCode {
  $global:LASTEXITCODE = 0
}

$ProgressPreference = 'SilentlyContinue'

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\\..')).Path

function Resolve-BuildArtifactPath([string]$EnvVarName, [string]$DefaultPath) {
  $override = [string][System.Environment]::GetEnvironmentVariable($EnvVarName)
  if (-not [string]::IsNullOrWhiteSpace($override)) {
    return $override.Trim()
  }
  return $DefaultPath
}

$DefaultSrcExe = Join-Path $RepoRoot 'src-tauri\target\release\api_router.exe'
$DefaultDstExe = Join-Path $RepoRoot 'API Router.exe'
$DefaultDstTestExe = Join-Path $RepoRoot 'API Router [TEST].exe'
$SrcExe = Resolve-BuildArtifactPath 'API_ROUTER_BUILD_SRC_EXE_PATH' $DefaultSrcExe
$DstExe = Resolve-BuildArtifactPath 'API_ROUTER_BUILD_DST_EXE_PATH' $DefaultDstExe
$DstTestExe = Resolve-BuildArtifactPath 'API_ROUTER_BUILD_DST_TEST_EXE_PATH' $DefaultDstTestExe
$StartFilePath = Resolve-BuildArtifactPath 'API_ROUTER_BUILD_START_FILE_PATH' $DstExe
$UsesArtifactPathOverrides = @(
  'API_ROUTER_BUILD_SRC_EXE_PATH',
  'API_ROUTER_BUILD_DST_EXE_PATH',
  'API_ROUTER_BUILD_DST_TEST_EXE_PATH',
  'API_ROUTER_BUILD_START_FILE_PATH'
) | Where-Object {
  -not [string]::IsNullOrWhiteSpace([string][System.Environment]::GetEnvironmentVariable($_))
} | Select-Object -First 1
$UsesArtifactPathOverrides = [bool]$UsesArtifactPathOverrides

Write-Host "RepoRoot: $RepoRoot"

function Resolve-BuildToolPath([string]$EnvVarName, [string]$DefaultPath, [string]$Label) {
  $override = [string][System.Environment]::GetEnvironmentVariable($EnvVarName)
  if (-not [string]::IsNullOrWhiteSpace($override)) {
    return $override.Trim()
  }
  if (Test-Path -LiteralPath $DefaultPath) {
    return $DefaultPath
  }
  throw "$Label tool missing: $DefaultPath"
}

$NpmCli = [string][System.Environment]::GetEnvironmentVariable('API_ROUTER_BUILD_NPM_PATH')
if ([string]::IsNullOrWhiteSpace($NpmCli)) {
  $NpmCli = 'npm.cmd'
} else {
  $NpmCli = $NpmCli.Trim()
}

$TypeScriptCli = Resolve-BuildToolPath `
  -EnvVarName 'API_ROUTER_BUILD_TSC_PATH' `
  -DefaultPath (Join-Path $RepoRoot 'node_modules\.bin\tsc.cmd') `
  -Label 'TypeScript compiler'
$ViteCli = Resolve-BuildToolPath `
  -EnvVarName 'API_ROUTER_BUILD_VITE_PATH' `
  -DefaultPath (Join-Path $RepoRoot 'node_modules\.bin\vite.cmd') `
  -Label 'Vite CLI'

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
  if (-not (Test-Path $StartFilePath)) {
    Write-Warning "Missing start target: $StartFilePath (cannot restart)"
    return
  }
  $env:API_ROUTER_PROFILE = $null
  if ($TestProfile) { $env:API_ROUTER_PROFILE = 'test' }
  $arguments = @()
  if ($StartHidden) { $arguments += '--start-hidden' }
  Write-Host "Starting: $StartFilePath"
  if ($arguments.Count -gt 0) {
    Start-Process -FilePath $StartFilePath -ArgumentList $arguments -WorkingDirectory $RepoRoot | Out-Null
  } else {
    Start-Process -FilePath $StartFilePath -WorkingDirectory $RepoRoot | Out-Null
  }
  Reset-LastExitCode
}

function Stop-RunningApiRouter {
  # Best-effort: if the root EXE is running, replacing it will fail with EPERM/EBUSY.
  # When test overrides point to temporary artifacts, never kill the user's real API Router by
  # image name. In that mode we only target exact overridden paths.
  if (-not $UsesArtifactPathOverrides) {
    try { Stop-Process -Name 'API Router' -Force -ErrorAction SilentlyContinue } catch {}
    try { Stop-Process -Name 'API Router [TEST]' -Force -ErrorAction SilentlyContinue } catch {}
    try { Stop-Process -Name 'api_router' -Force -ErrorAction SilentlyContinue } catch {}
  }
  try {
    Get-Process -ErrorAction SilentlyContinue | Where-Object {
      $_.Path -and (($_.Path -ieq $DstExe) -or ($_.Path -ieq $DstTestExe) -or ($_.Path -ieq $SrcExe))
    } | Stop-Process -Force -ErrorAction SilentlyContinue
  } catch {}

  if ($IsWindows -and -not $UsesArtifactPathOverrides) {
    try { & taskkill.exe /F /IM 'API Router.exe' /T | Out-Null } catch {}
    try { & taskkill.exe /F /IM 'API Router [TEST].exe' /T | Out-Null } catch {}
    try { & taskkill.exe /F /IM 'api_router.exe' /T | Out-Null } catch {}
    # taskkill returns non-zero when nothing matched. That is expected during a clean restart and
    # must not leak into the script exit code, otherwise remote update can be marked failed after
    # a successful install/restart purely because a best-effort kill missed an already-closed PID.
    Reset-LastExitCode
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

function Try-CopyOptionalArtifact([string]$From, [string]$To, [string]$Label) {
  try {
    Copy-WithRetry $From $To
    Write-Host "Wrote: $To"
    Write-RemoteUpdateLog "$Label installed: $To"
    return $true
  } catch {
    $message = $_.Exception.Message
    Write-Warning "$Label copy skipped: $message"
    Write-RemoteUpdateLog "$Label copy skipped: $message"
    return $false
  }
}

function Test-BuildOutputNoiseLine([string]$Line) {
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
    $Line -match '^Write-Error\b' -or
    $Line -match '^\+\s+Write-Error\b' -or
    $Line -match '^\+\s+~+$'
  )
}

function Normalize-BuildOutputLine([string]$Line) {
  if (-not $Line) { return '' }
  $normalized = [regex]::Replace($Line, '[^\u0009\u000A\u000D\u0020-\u007E]', ' ')
  $normalized = [regex]::Replace($normalized, '\x1b\[[0-9;?]*[ -/]*[@-~]', '')
  $normalized = [regex]::Replace($normalized, '\[[0-9;]{1,16}m', ' ')
  $normalized = [regex]::Replace($normalized, '\s+', ' ').Trim()
  return $normalized
}

function Get-BuildOutputLines($Output, [switch]$IncludeNoise) {
  if ($null -eq $Output) { return @() }
  return @(
    $Output |
      ForEach-Object { Normalize-BuildOutputLine ([string]$_) } |
      Where-Object {
        $_ -and ($IncludeNoise -or -not (Test-BuildOutputNoiseLine $_))
      }
  )
}

function Write-BuildFailureOutputDiagnostics(
  [string]$FailureLabel,
  [string[]]$StdoutLines,
  [string[]]$StderrLines
) {
  $stderrTail = @($StderrLines | Select-Object -Last 20)
  $stdoutTail = @($StdoutLines | Select-Object -Last 20)
  if ($stderrTail.Count -gt 0) {
    Write-RemoteUpdateLog "$FailureLabel stderr tail:"
    foreach ($line in $stderrTail) {
      Write-RemoteUpdateLog "  $line"
    }
  }
  if ($stdoutTail.Count -gt 0) {
    Write-RemoteUpdateLog "$FailureLabel stdout tail:"
    foreach ($line in $stdoutTail) {
      Write-RemoteUpdateLog "  $line"
    }
  }
}

function Format-BuildCommandOutputSummary($Output) {
  $lines = @(Get-BuildOutputLines $Output)
  if ($lines.Count -eq 0) { return '' }
  $text = ($lines | Select-Object -Last 8) -join ' | '
  if (-not $text) { return '' }
  if ($text.Length -gt 1200) {
    return $text.Substring($text.Length - 1200)
  }
  return $text
}

function Format-BuildFailureMessage([string]$FailureLabel, [string]$Summary, [int]$ExitCode) {
  if ($Summary) {
    return "$FailureLabel failed: $Summary"
  }
  if (Get-RemoteUpdateLogPath) {
    return "$FailureLabel failed; see lan-remote-update.log for stderr tail"
  }
  if ($ExitCode -gt 0) {
    return "$FailureLabel failed with exit code $ExitCode"
  }
  return "$FailureLabel failed"
}

function Invoke-BuildCommand {
  param(
    [Parameter(Mandatory = $true)]
    [string]$FilePath,
    [string[]]$ArgumentList = @(),
    [Parameter(Mandatory = $true)]
    [string]$FailureLabel
  )

  if (-not $StartHidden) {
    & $FilePath @ArgumentList
    if ($LASTEXITCODE -ne 0) {
      throw "$FailureLabel failed with exit code $LASTEXITCODE"
    }
    return
  }

  # Remote update launches this script with -StartHidden.
  # In that mode every nested npm/cmd invocation must remain hidden too, otherwise the peer
  # machine can flash 2-3 transient console windows during frontend and Tauri build steps.
  # Batch wrappers such as npm.cmd/vite.cmd must run under cmd.exe here; launching them directly
  # via Start-Process is not reliable on Windows and can fail before the underlying tool runs.
  $resolvedFilePath = $FilePath
  $resolvedArgumentList = @($ArgumentList)
  $resolvedArgumentString = $null
  $extension = [System.IO.Path]::GetExtension($FilePath)
  if ($extension -and @('.cmd', '.bat') -contains $extension.ToLowerInvariant()) {
    $quotedFilePath = "`"$FilePath`""
    $quotedArgs = @(
      $ArgumentList | ForEach-Object {
        if ($null -eq $_) { return }
        $arg = [string]$_
        if ($arg -match '[\s"]') {
          '"' + $arg.Replace('"', '\"') + '"'
        } else {
          $arg
        }
      }
    ) | Where-Object { $_ }
    $batchCommand = if ($quotedArgs.Count -gt 0) {
      "$quotedFilePath $($quotedArgs -join ' ')"
    } else {
      $quotedFilePath
    }
    $resolvedFilePath = $env:ComSpec
    if ([string]::IsNullOrWhiteSpace($resolvedFilePath)) {
      $resolvedFilePath = 'cmd.exe'
    }
    $resolvedArgumentString = "/d /s /c $batchCommand"
  }
  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $resolvedFilePath
  if (-not [string]::IsNullOrWhiteSpace($resolvedArgumentString)) {
    $startInfo.Arguments = $resolvedArgumentString
  } else {
    $startInfo.Arguments = Format-BuildArgumentString -ArgumentList $resolvedArgumentList
  }
  $startInfo.WorkingDirectory = $RepoRoot
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true

  $process = [System.Diagnostics.Process]::Start($startInfo)
  $stdout = $process.StandardOutput.ReadToEnd()
  $stderr = $process.StandardError.ReadToEnd()
  $process.WaitForExit()
  $stdoutLines = if ($stdout) { @($stdout -split "\r?\n") } else { @() }
  $stderrLines = if ($stderr) { @($stderr -split "\r?\n") } else { @() }
  $summary = Format-BuildCommandOutputSummary @($stderrLines + $stdoutLines)
  if (-not $summary) {
    $summary = Format-BuildCommandOutputSummary @($stdoutLines + $stderrLines)
  }
  if ($summary) {
    Write-RemoteUpdateLog "$FailureLabel output: $summary"
  }
  if ($process.ExitCode -ne 0) {
    # Hidden remote-update builds used to collapse genuine stderr into noisy vite progress
    # lines. Persist both streams here so future failures always leave actionable evidence.
    Write-BuildFailureOutputDiagnostics `
      -FailureLabel $FailureLabel `
      -StdoutLines (Get-BuildOutputLines $stdoutLines -IncludeNoise) `
      -StderrLines (Get-BuildOutputLines $stderrLines -IncludeNoise)
    throw (Format-BuildFailureMessage $FailureLabel $summary $process.ExitCode)
  }
}

function Format-BuildCommandPreview([string]$FilePath, [string[]]$ArgumentList) {
  $parts = @($FilePath)
  $parts += Format-BuildArgumentTokens -ArgumentList $ArgumentList
  return ($parts -join ' ').Trim()
}

function Format-BuildArgumentTokens([string[]]$ArgumentList) {
  $parts = @()
  if ($ArgumentList) {
    foreach ($arg in $ArgumentList) {
      if ($null -eq $arg) { continue }
      if ($arg -match '\s') {
        $parts += '"' + $arg.Replace('"', '\"') + '"'
      } else {
        $parts += $arg
      }
    }
  }
  return $parts
}

function Format-BuildArgumentString([string[]]$ArgumentList) {
  return ((Format-BuildArgumentTokens -ArgumentList $ArgumentList) -join ' ').Trim()
}

function Invoke-BuildStage {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Phase,
    [Parameter(Mandatory = $true)]
    [string]$Label,
    [Parameter(Mandatory = $true)]
    [string]$Detail,
    [Parameter(Mandatory = $true)]
    [string]$FilePath,
    [string[]]$ArgumentList = @(),
    [Parameter(Mandatory = $true)]
    [string]$FailureLabel
  )

  Enter-BuildStep -Phase $Phase -Label $Label -Detail $Detail
  $commandPreview = Format-BuildCommandPreview -FilePath $FilePath -ArgumentList $ArgumentList
  Write-Host "Running: $commandPreview"
  Write-RemoteUpdateLog "Command for ${Label}: $commandPreview"
  Invoke-BuildCommand -FilePath $FilePath -ArgumentList $ArgumentList -FailureLabel $FailureLabel
}

$hadFailure = $false
$restartWarning = $null
$script:CurrentBuildStepPhase = ''
$script:CurrentBuildStepLabel = ''
$script:CurrentBuildStepDetail = ''
try {
  # Split the frontend chain into explicit sub-steps so remote-update diagnostics can
  # identify the exact failing command instead of collapsing everything into "npm run build".
  Invoke-BuildStage `
    -Phase 'check_gateway_provider_id' `
    -Label 'Checking provider ids' `
    -Detail 'Running npm run check:gateway-provider-id' `
    -FilePath $NpmCli `
    -ArgumentList @('run', 'check:gateway-provider-id') `
    -FailureLabel 'gateway provider id check'

  Invoke-BuildStage `
    -Phase 'check_line_endings' `
    -Label 'Checking line endings' `
    -Detail 'Running npm run check:line-endings' `
    -FilePath $NpmCli `
    -ArgumentList @('run', 'check:line-endings') `
    -FailureLabel 'line ending check'

  Invoke-BuildStage `
    -Phase 'check_web_codex_assets' `
    -Label 'Checking web assets' `
    -Detail 'Running npm run check:web-codex-assets' `
    -FilePath $NpmCli `
    -ArgumentList @('run', 'check:web-codex-assets') `
    -FailureLabel 'web codex asset check'

  Invoke-BuildStage `
    -Phase 'build_typescript' `
    -Label 'TypeScript compile' `
    -Detail 'Running tsc' `
    -FilePath $TypeScriptCli `
    -ArgumentList @() `
    -FailureLabel 'TypeScript compile'

  Invoke-BuildStage `
    -Phase 'build_vite' `
    -Label 'Building frontend assets' `
    -Detail 'Running vite build' `
    -FilePath $ViteCli `
    -ArgumentList @('build') `
    -FailureLabel 'vite build'

  # Build tauri app (produces src-tauri/target/release/api_router.exe).
  Invoke-BuildStage `
    -Phase 'build_release_binary' `
    -Label 'Building release binary' `
    -Detail 'Running npm run tauri -- build --no-bundle' `
    -FilePath $NpmCli `
    -ArgumentList @('run', 'tauri', '--', 'build', '--no-bundle') `
    -FailureLabel 'tauri build'

  if (-not $NoCopy) {
    Enter-BuildStep -Phase 'install_release_binary' -Label 'Installing EXE' -Detail 'Replacing repo root API Router executables'
    if (-not (Test-Path $SrcExe)) { throw "Missing built exe: $SrcExe" }

    Stop-RunningApiRouter
    Copy-WithRetry $SrcExe $DstExe
    Write-Host "Wrote: $DstExe"
    Write-RemoteUpdateLog "Installed canonical runtime executable: $DstExe"
    # The canonical runtime is API Router.exe. The TEST copy is auxiliary and must not
    # turn a successful remote update into a failed one if that secondary artifact is locked.
    $null = Try-CopyOptionalArtifact $SrcExe $DstTestExe 'Optional TEST EXE'
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

# PowerShell can otherwise propagate a stale non-zero $LASTEXITCODE from best-effort native
# helpers such as taskkill.exe even when this script completed successfully.
Reset-LastExitCode
exit 0
