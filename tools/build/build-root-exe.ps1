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
$DefaultSrcUpdaterExe = Join-Path $RepoRoot 'src-tauri\target\release\api_router_updater.exe'
$DefaultDstExe = Join-Path $RepoRoot 'API Router.exe'
$DefaultDstUpdaterExe = Join-Path $RepoRoot 'API Router Updater.exe'
$DefaultDstTestExe = Join-Path $RepoRoot 'API Router [TEST].exe'
$SrcExe = Resolve-BuildArtifactPath 'API_ROUTER_BUILD_SRC_EXE_PATH' $DefaultSrcExe
$SrcUpdaterExe = Resolve-BuildArtifactPath 'API_ROUTER_BUILD_SRC_UPDATER_EXE_PATH' $DefaultSrcUpdaterExe
$DstExe = Resolve-BuildArtifactPath 'API_ROUTER_BUILD_DST_EXE_PATH' $DefaultDstExe
$DstUpdaterExe = Resolve-BuildArtifactPath 'API_ROUTER_BUILD_DST_UPDATER_EXE_PATH' $DefaultDstUpdaterExe
$DstTestExe = Resolve-BuildArtifactPath 'API_ROUTER_BUILD_DST_TEST_EXE_PATH' $DefaultDstTestExe
$StartFilePath = Resolve-BuildArtifactPath 'API_ROUTER_BUILD_START_FILE_PATH' $DstExe
$RemoteUpdateTargetRef = [string][System.Environment]::GetEnvironmentVariable('API_ROUTER_REMOTE_UPDATE_TARGET_REF')
$RemoteUpdateToGitSha = [string][System.Environment]::GetEnvironmentVariable('API_ROUTER_REMOTE_UPDATE_TO_GIT_SHA')
$RemoteUpdateRequiresFreshBuild = -not [string]::IsNullOrWhiteSpace($RemoteUpdateTargetRef) -or -not [string]::IsNullOrWhiteSpace($RemoteUpdateToGitSha)
$SkipReleaseBuild = (([string][System.Environment]::GetEnvironmentVariable('API_ROUTER_BUILD_SKIP_RELEASE_BUILD')).Trim() -eq '1') -and -not $RemoteUpdateRequiresFreshBuild
$SkipPrereleaseChecks = ([string][System.Environment]::GetEnvironmentVariable('API_ROUTER_BUILD_SKIP_PRERELEASE_CHECKS')).Trim() -eq '1'
$UsesArtifactPathOverrides = @(
  'API_ROUTER_BUILD_SRC_EXE_PATH',
  'API_ROUTER_BUILD_SRC_UPDATER_EXE_PATH',
  'API_ROUTER_BUILD_DST_EXE_PATH',
  'API_ROUTER_BUILD_DST_UPDATER_EXE_PATH',
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
$NodeCli = [string][System.Environment]::GetEnvironmentVariable('API_ROUTER_BUILD_NODE_PATH')
if ([string]::IsNullOrWhiteSpace($NodeCli)) {
  $NodeCli = 'node.exe'
} else {
  $NodeCli = $NodeCli.Trim()
}

$RunWithWinSdkCli = Resolve-BuildToolPath `
  -EnvVarName 'API_ROUTER_BUILD_RUN_WITH_WIN_SDK_PATH' `
  -DefaultPath (Join-Path $RepoRoot 'tools\windows\run-with-win-sdk.mjs') `
  -Label 'Windows SDK wrapper'
$RootExeChecksCli = Resolve-BuildToolPath `
  -EnvVarName 'API_ROUTER_BUILD_CHECKS_PATH' `
  -DefaultPath (Join-Path $RepoRoot 'tools\build\run-root-exe-checks.mjs') `
  -Label 'Root EXE checks entry'
$TauriCliEntry = Resolve-BuildToolPath `
  -EnvVarName 'API_ROUTER_BUILD_TAURI_ENTRY_PATH' `
  -DefaultPath (Join-Path $RepoRoot 'node_modules\@tauri-apps\cli\tauri.js') `
  -Label 'Tauri CLI entry'

function Get-RemoteUpdateStatusPath {
  $path = [string]$env:API_ROUTER_REMOTE_UPDATE_STATUS_PATH
  if ([string]::IsNullOrWhiteSpace($path)) { return $null }
  return $path
}

function Get-RemoteUpdateLogPath {
  $path = [string]$env:API_ROUTER_REMOTE_UPDATE_LOG_PATH
  if ([string]::IsNullOrWhiteSpace($path)) { return $null }
  return $path.Trim()
}

function Get-RepoUserDataDir {
  $path = [string]$env:API_ROUTER_USER_DATA_DIR
  if (-not [string]::IsNullOrWhiteSpace($path)) { return $path.Trim() }
  return Join-Path $RepoRoot 'user-data'
}

function Get-TextFileTail([string]$Path, [int]$MaxChars) {
  if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path)) { return $null }
  try {
    $text = Get-Content -LiteralPath $Path -Raw -ErrorAction Stop
    if ($null -eq $text) { return $null }
    if ($text.Length -le $MaxChars) { return $text.Trim() }
    return $text.Substring($text.Length - $MaxChars).Trim()
  } catch {
    return "failed to read ${Path}: $($_.Exception.Message)"
  }
}

function Write-RuntimeStartupDiagnostics([string]$Reason) {
  $userDataDir = Get-RepoUserDataDir
  Write-RemoteUpdateLog "Runtime startup diagnostics after ${Reason}: user_data_dir=$userDataDir"
  foreach ($fileName in @('app-startup.json', 'gateway-bootstrap.json', 'gateway-startup.json')) {
    $path = Join-Path $userDataDir $fileName
    $tail = Get-TextFileTail -Path $path -MaxChars 4000
    if ([string]::IsNullOrWhiteSpace($tail)) {
      Write-RemoteUpdateLog "Runtime startup diagnostics ${fileName}: <missing or empty>"
    } else {
      Write-RemoteUpdateLog "Runtime startup diagnostics ${fileName}: $tail"
    }
  }
}

function Clear-RuntimeStartupDiagnostics {
  $userDataDir = Get-RepoUserDataDir
  foreach ($fileName in @('app-startup.json', 'gateway-bootstrap.json', 'gateway-startup.json')) {
    $path = Join-Path $userDataDir $fileName
    try {
      if (Test-Path -LiteralPath $path) {
        Remove-Item -LiteralPath $path -Force -ErrorAction Stop
        Write-RemoteUpdateLog "Cleared stale runtime startup diagnostic: $path"
      }
    } catch {
      Write-RemoteUpdateLog "Failed to clear runtime startup diagnostic ${path}: $($_.Exception.Message)"
    }
  }
}

function Format-StartupStageSummary($Payload) {
  try {
    $stages = @($Payload.stages)
    if ($stages.Count -eq 0) { return 'recent startup stages: <none>' }
    $start = [Math]::Max(0, $stages.Count - 8)
    $items = @()
    for ($i = $start; $i -lt $stages.Count; $i++) {
      $stage = $stages[$i]
      $name = [string]$stage.stage
      $elapsed = [string]$stage.elapsedMs
      $detail = ([string]$stage.detail).Trim()
      if ($detail.Length -gt 120) {
        $detail = $detail.Substring(0, 120) + '...'
      }
      if ([string]::IsNullOrWhiteSpace($detail)) {
        $items += "$name@${elapsed}ms"
      } else {
        $items += "$name@${elapsed}ms($detail)"
      }
    }
    return 'recent startup stages: ' + ($items -join ' -> ')
  } catch {
    return "recent startup stages unavailable: $($_.Exception.Message)"
  }
}

function Get-RuntimeStartupDiagnosisSummary {
  $userDataDir = Get-RepoUserDataDir
  $appStartupPath = Join-Path $userDataDir 'app-startup.json'
  $appStartup = Get-TextFileTail -Path $appStartupPath -MaxChars 12000
  if ([string]::IsNullOrWhiteSpace($appStartup)) {
    return 'startup diagnostics missing; app-startup.json was not written'
  }
  $stageSummary = ''
  try {
    $payload = $appStartup | ConvertFrom-Json
    $stageSummary = '; ' + (Format-StartupStageSummary $payload)
  } catch {
    $stageSummary = '; app-startup parse failed: ' + $_.Exception.Message
  }
  if ($appStartup.Contains('"stage": "build_state_open_store_start"') -and -not $appStartup.Contains('"stage": "build_state_open_store_ok"')) {
    return 'startup blocked while opening local store; app-startup reached build_state_open_store_start but not build_state_open_store_ok' + $stageSummary
  }
  if ($appStartup.Contains('"stage": "build_state_secret_store_start"') -and -not $appStartup.Contains('"stage": "build_state_secret_store_ok"')) {
    return 'startup blocked while opening secrets store; app-startup reached build_state_secret_store_start but not build_state_secret_store_ok' + $stageSummary
  }
  if ($appStartup.Contains('"stage": "build_state_load_config_start"') -and -not $appStartup.Contains('"stage": "build_state_load_config_ok"')) {
    return 'startup blocked while loading config; app-startup reached build_state_load_config_start but not build_state_load_config_ok' + $stageSummary
  }
  if ($appStartup.Contains('"stage": "build_state_updater_daemon_start"') -and -not $appStartup.Contains('"stage": "build_state_updater_daemon_ok"')) {
    return 'startup blocked while starting updater daemon; app-startup reached build_state_updater_daemon_start but not build_state_updater_daemon_ok' + $stageSummary
  }
  if ($appStartup.Contains('"stage": "gateway_prepare_enter"') -and -not $appStartup.Contains('"stage": "prepare_gateway_listeners"')) {
    return 'startup blocked while preparing gateway listeners' + $stageSummary
  }
  return 'startup diagnostics available; inspect app-startup.json tail for the last completed stage' + $stageSummary
}

function Read-RepoTomlSectionValue {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Section,
    [Parameter(Mandatory = $true)]
    [string]$Key
  )

  $configPath = Join-Path (Get-RepoUserDataDir) 'config.toml'
  if (-not (Test-Path -LiteralPath $configPath)) { return $null }
  $inSection = $false
  foreach ($line in Get-Content -LiteralPath $configPath) {
    $trimmed = $line.Trim()
    if ($trimmed -match '^\[(.+)\]\s*$') {
      $inSection = ([string]$Matches[1]) -eq $Section
      continue
    }
    if (-not $inSection) { continue }
    $escapedKey = [regex]::Escape($Key)
    if ($trimmed -match "^$escapedKey\s*=\s*(.+)$") {
      $value = ([string]$Matches[1]).Trim()
      if ($value -match '^"([^"]*)"') { return [string]$Matches[1] }
      return (($value -split '#', 2)[0]).Trim()
    }
  }
  return $null
}

function Get-ConfiguredListenPort {
  $port = [string]$env:API_ROUTER_REMOTE_UPDATE_LISTEN_PORT
  if (-not [string]::IsNullOrWhiteSpace($port)) { return [int]$port.Trim() }
  $configured = Read-RepoTomlSectionValue -Section 'listen' -Key 'port'
  if (-not [string]::IsNullOrWhiteSpace($configured)) { return [int]$configured.Trim() }
  return 4000
}

function Get-ConfiguredListenHost {
  $hostValue = [string]$env:API_ROUTER_REMOTE_UPDATE_LISTEN_HOST
  if (-not [string]::IsNullOrWhiteSpace($hostValue)) { return $hostValue.Trim() }
  $configured = Read-RepoTomlSectionValue -Section 'listen' -Key 'host'
  if (-not [string]::IsNullOrWhiteSpace($configured)) { return $configured.Trim() }
  return '127.0.0.1'
}

function Get-ApiRouterRuntimeHealthTimeoutSeconds {
  $value = [string]$env:API_ROUTER_REMOTE_UPDATE_HEALTH_TIMEOUT_SECONDS
  if ([string]::IsNullOrWhiteSpace($value)) {
    $remoteTargetRef = [string]$env:API_ROUTER_REMOTE_UPDATE_TARGET_REF
    $remoteToGitSha = [string]$env:API_ROUTER_REMOTE_UPDATE_TO_GIT_SHA
    if (-not [string]::IsNullOrWhiteSpace($remoteTargetRef) -or -not [string]::IsNullOrWhiteSpace($remoteToGitSha)) {
      return 120
    }
    return 30
  }
  try {
    $parsed = [int]$value.Trim()
    if ($parsed -gt 0) { return $parsed }
  } catch {
  }
  Write-RemoteUpdateLog "Ignoring invalid API_ROUTER_REMOTE_UPDATE_HEALTH_TIMEOUT_SECONDS value: $value"
  return 30
}

function Get-RemoteUpdateLanSecret {
  $secret = [string]$env:API_ROUTER_REMOTE_UPDATE_LAN_SECRET
  if (-not [string]::IsNullOrWhiteSpace($secret)) { return $secret.Trim() }
  $secretsPath = Join-Path (Get-RepoUserDataDir) 'secrets.json'
  if (-not (Test-Path -LiteralPath $secretsPath)) { return $null }
  try {
    $payload = Get-Content -LiteralPath $secretsPath -Raw | ConvertFrom-Json
    $storedSecret = [string]$payload.lan_trust_secret
    if (-not [string]::IsNullOrWhiteSpace($storedSecret)) { return $storedSecret.Trim() }
  } catch {
    Write-RemoteUpdateLog ("Failed to read LAN trust secret for updater daemon: " + $_.Exception.Message)
  }
  return $null
}

function Get-RemoteUpdateBuildResultPath {
  $path = [string]$env:API_ROUTER_REMOTE_UPDATE_BUILD_RESULT_PATH
  if (-not [string]::IsNullOrWhiteSpace($path)) { return $path }
  $logPath = Get-RemoteUpdateLogPath
  if (-not [string]::IsNullOrWhiteSpace($logPath)) {
    $parent = Split-Path -Parent $logPath
    if ($parent) {
      return (Join-Path $parent 'lan-remote-update-build-result.json')
    }
  }
  return $null
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

function Get-RepoGitHeadSha {
  try {
    $output = & git -C $RepoRoot rev-parse HEAD 2>$null
    if ($LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace([string]$output)) {
      return ([string]$output).Trim()
    }
  } catch {
    Write-RemoteUpdateLog ("Failed to resolve git HEAD sha: " + $_.Exception.Message)
  }
  return $null
}

function Get-RecordedRuntimeSha([string]$Name) {
  try {
    $path = Join-Path (Join-Path $RepoRoot 'runtime') "$Name.json"
    if (-not (Test-Path -LiteralPath $path)) { return $null }
    $payload = Get-Content -LiteralPath $path -Raw -ErrorAction Stop | ConvertFrom-Json
    $sha = [string]$payload.gitSha
    if (-not [string]::IsNullOrWhiteSpace($sha)) { return $sha.Trim() }
  } catch {
    Write-RemoteUpdateLog ("Failed to read recorded runtime ${Name} sha: " + $_.Exception.Message)
  }
  return $null
}

function Normalize-VersionSha([string]$Sha, [string]$Fallback) {
  if (-not [string]::IsNullOrWhiteSpace($Sha) -and $Sha.Trim() -ine 'unknown') { return $Sha.Trim() }
  if (-not [string]::IsNullOrWhiteSpace($Fallback) -and $Fallback.Trim() -ine 'unknown') { return $Fallback.Trim() }
  $headSha = Get-RepoGitHeadSha
  if (-not [string]::IsNullOrWhiteSpace($headSha)) { return $headSha }
  return 'unknown'
}

function Invoke-UpdaterCommand {
  param(
    [Parameter(Mandatory = $true)]
    [string[]]$ArgumentList,
    [Parameter(Mandatory = $true)]
    [string]$FailureMessage,
    [string]$PreferredUpdaterPath = ''
  )

  $updaterPath = if ($PreferredUpdaterPath -and (Test-Path -LiteralPath $PreferredUpdaterPath)) {
    $PreferredUpdaterPath
  } elseif (Test-Path -LiteralPath $DstUpdaterExe) {
    $DstUpdaterExe
  } elseif (Test-Path -LiteralPath $SrcUpdaterExe) {
    $SrcUpdaterExe
  } else {
    throw "API Router Updater.exe is missing; cannot run updater command"
  }
  Invoke-BuildCommand -FilePath $updaterPath -ArgumentList $ArgumentList -FailureLabel $FailureMessage -UseProcessExitCode
}

function Get-UpdaterBindAddress {
  $port = [string]$env:API_ROUTER_REMOTE_UPDATE_UPDATER_PORT
  if ([string]::IsNullOrWhiteSpace($port)) {
    $listenPort = Get-ConfiguredListenPort
    $updaterPort = $listenPort + 1
    if ($updaterPort -gt 65535) { return $null }
    $port = [string]$updaterPort
    $env:API_ROUTER_REMOTE_UPDATE_UPDATER_PORT = $port
  }
  return "0.0.0.0:$($port.Trim())"
}

function Get-LocalHttpHealthProbeHost {
  $hostValue = Get-ConfiguredListenHost
  if ($hostValue.StartsWith('[') -and $hostValue.EndsWith(']') -and $hostValue.Length -gt 2) {
    $hostValue = $hostValue.Substring(1, $hostValue.Length - 2)
  }

  $lowerHost = $hostValue.ToLowerInvariant()
  if (
    [string]::IsNullOrWhiteSpace($hostValue) -or
    $lowerHost -eq '0.0.0.0' -or
    $lowerHost -eq '::' -or
    $lowerHost -eq '*' -or
    $lowerHost -eq '+'
  ) {
    return '127.0.0.1'
  }

  if ($hostValue.Contains(':')) {
    return "[$hostValue]"
  }
  return $hostValue
}

function Get-LocalHttpHealthUrl {
  $port = [string](Get-ConfiguredListenPort)
  if ([string]::IsNullOrWhiteSpace($port)) { return $null }
  $hostValue = Get-LocalHttpHealthProbeHost
  return "http://$($hostValue):$($port.Trim())/health"
}

function Get-LocalHttpStatusUrl {
  $port = [string](Get-ConfiguredListenPort)
  if ([string]::IsNullOrWhiteSpace($port)) { return $null }
  $hostValue = Get-LocalHttpHealthProbeHost
  return "http://$($hostValue):$($port.Trim())/status"
}

function Get-ExpectedRuntimeGitSha {
  $expected = Normalize-VersionSha $env:API_ROUTER_REMOTE_UPDATE_CURRENT_GIT_SHA $env:API_ROUTER_REMOTE_UPDATE_TO_GIT_SHA
  if ($expected -eq 'unknown') {
    $expected = Normalize-VersionSha $env:API_ROUTER_REMOTE_UPDATE_TARGET_REF ''
  }
  if ($expected -eq 'unknown') { return $null }
  return $expected
}

function Get-UpdaterDaemonRoot {
  return Join-Path (Join-Path $RepoRoot 'runtime') 'updater-daemon'
}

function Get-UpdaterDaemonStatePath {
  return Join-Path (Join-Path $RepoRoot 'runtime') 'updater-state.json'
}

function Get-UpdaterDaemonExePath {
  $toSha = Normalize-VersionSha $env:API_ROUTER_REMOTE_UPDATE_TO_GIT_SHA $env:API_ROUTER_REMOTE_UPDATE_TARGET_REF
  return Join-Path (Join-Path (Get-UpdaterDaemonRoot) $toSha) 'API Router Updater.exe'
}

function Normalize-PathForComparison {
  param([string]$Path)

  if ([string]::IsNullOrWhiteSpace($Path)) { return $null }
  try {
    return [System.IO.Path]::GetFullPath($Path).TrimEnd(
      [System.IO.Path]::DirectorySeparatorChar,
      [System.IO.Path]::AltDirectorySeparatorChar
    )
  } catch {
    return $Path.Trim().TrimEnd('\', '/')
  }
}

function Test-UpdaterDaemonProcessPath {
  param([string]$ProcessPath)

  $normalizedProcessPath = Normalize-PathForComparison $ProcessPath
  if (-not $normalizedProcessPath) { return $false }

  $normalizedRootUpdater = Normalize-PathForComparison $DstUpdaterExe
  if ($normalizedRootUpdater -and $normalizedProcessPath -ieq $normalizedRootUpdater) {
    return $true
  }

  $normalizedDaemonRoot = Normalize-PathForComparison (Get-UpdaterDaemonRoot)
  if (-not $normalizedDaemonRoot) { return $false }

  $daemonRootWithSeparator = $normalizedDaemonRoot + [System.IO.Path]::DirectorySeparatorChar
  return $normalizedProcessPath.StartsWith($daemonRootWithSeparator, [System.StringComparison]::OrdinalIgnoreCase)
}

function Get-ProcessExecutablePath {
  param([Parameter(Mandatory = $true)]$Process)

  try {
    return [string]$Process.Path
  } catch {
    return $null
  }
}

function Stop-RunningUpdaterDaemon {
  $statePath = Get-UpdaterDaemonStatePath
  if (Test-Path -LiteralPath $statePath) {
    try {
      $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
      if ($state -and $state.pid) {
        $statePid = [int]$state.pid
        if ($statePid -gt 0) {
          $stateProcess = Get-Process -Id $statePid -ErrorAction SilentlyContinue
          $stateProcessPath = if ($stateProcess) { Get-ProcessExecutablePath $stateProcess } else { $null }
          if ($stateProcess -and (Test-UpdaterDaemonProcessPath $stateProcessPath)) {
            Wait-UpdaterDaemonIdle -State $state | Out-Null
            Stop-Process -InputObject $stateProcess -Force -ErrorAction SilentlyContinue
          } elseif ($stateProcess) {
            Write-RemoteUpdateLog "Ignoring stale updater daemon PID $statePid with path: $stateProcessPath"
          }
        }
      }
    } catch {
      Write-RemoteUpdateLog ("Failed to stop updater daemon by state file: " + $_.Exception.Message)
      if ($_.Exception.Message -like 'updater daemon is busy*') { throw }
    }
  }

  Wait-UpdaterDaemonIdle | Out-Null
  try {
    Get-Process -ErrorAction SilentlyContinue | Where-Object {
      $candidatePath = Get-ProcessExecutablePath $_
      Test-UpdaterDaemonProcessPath $candidatePath
    } | Stop-Process -Force -ErrorAction SilentlyContinue
  } catch {
    Write-RemoteUpdateLog ("Failed to stop updater daemon by process path: " + $_.Exception.Message)
  }
}

function Install-UpdaterDaemonRuntime {
  $daemonExe = Get-UpdaterDaemonExePath
  $daemonDir = Split-Path -Parent $daemonExe
  if ($daemonDir) {
    New-Item -ItemType Directory -Force -Path $daemonDir | Out-Null
  }
  Copy-WithRetry $DstUpdaterExe $daemonExe
  Write-RemoteUpdateLog "Installed updater daemon runtime executable: $daemonExe"
  return $daemonExe
}

function Invoke-JsonHttpGet {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Uri,
    [hashtable]$Headers = @{},
    [int]$TimeoutSeconds = 3
  )

  $response = Invoke-WebRequest `
    -Uri $Uri `
    -Headers $Headers `
    -UseBasicParsing `
    -TimeoutSec $TimeoutSeconds `
    -ErrorAction Stop
  if ($response.StatusCode -lt 200 -or $response.StatusCode -ge 300) {
    throw "http $($response.StatusCode)"
  }
  if ([string]::IsNullOrWhiteSpace([string]$response.Content)) {
    return $null
  }
  return $response.Content | ConvertFrom-Json
}

function Get-UpdaterStatusUrlFromState {
  param([object]$State = $null)

  $port = $null
  if ($State -and $State.bind) {
    $bind = [string]$State.bind
    if ($bind -match ':(\d+)$') {
      $port = $Matches[1]
    }
  }
  if ([string]::IsNullOrWhiteSpace([string]$port)) {
    $port = [string]$env:API_ROUTER_REMOTE_UPDATE_UPDATER_PORT
  }
  if ([string]::IsNullOrWhiteSpace([string]$port)) {
    $listenPort = Get-ConfiguredListenPort
    $updaterPort = $listenPort + 1
    if ($updaterPort -gt 65535) { return $null }
    $port = [string]$updaterPort
  }
  return "http://127.0.0.1:$($port.Trim())/status"
}

function Wait-UpdaterDaemonIdle {
  param(
    [object]$State = $null,
    [int]$TimeoutSeconds = 60
  )

  $secret = Get-RemoteUpdateLanSecret
  if ([string]::IsNullOrWhiteSpace($secret)) {
    Write-RemoteUpdateLog 'Updater daemon idle probe skipped; LAN trust secret is unavailable.'
    return
  }
  $statusUrl = Get-UpdaterStatusUrlFromState -State $State
  if ([string]::IsNullOrWhiteSpace($statusUrl)) {
    Write-RemoteUpdateLog 'Updater daemon idle probe skipped; updater status URL is unavailable.'
    return
  }
  $headers = @{
    'x-api-router-lan-node-id' = if ($env:API_ROUTER_REMOTE_UPDATE_REQUESTER_NODE_ID) { $env:API_ROUTER_REMOTE_UPDATE_REQUESTER_NODE_ID } else { 'remote-update-worker' }
    'x-api-router-lan-secret' = $secret.Trim()
  }
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  $loggedBusy = $false
  while ([DateTime]::UtcNow -lt $deadline) {
    try {
      $payload = Invoke-JsonHttpGet -Uri $statusUrl -Headers $headers -TimeoutSeconds 2
      if (-not $payload -or $payload.ok -ne $true -or $payload.busy -ne $true) {
        return
      }
      if (-not $loggedBusy) {
        $operationName = if ($payload.activeOperation -and $payload.activeOperation.name) { [string]$payload.activeOperation.name } else { 'unknown' }
        Write-RemoteUpdateLog "Waiting for updater daemon active operation before stop: $operationName"
        $loggedBusy = $true
      }
    } catch {
      Write-RemoteUpdateLog ("Updater daemon idle probe failed; proceeding with stop: " + $_.Exception.Message)
      return
    }
    Start-Sleep -Milliseconds 500
  }
  throw "updater daemon is busy after ${TimeoutSeconds}s; refusing to stop it during active rollback"
}

function Wait-UpdaterDaemonReady {
  param(
    [Parameter(Mandatory = $true)]
    [string]$StatusUrl,
    [Parameter(Mandatory = $true)]
    [hashtable]$Headers,
    [int]$TimeoutSeconds = 10
  )

  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  $lastDetail = ''
  $lastLoggedDetail = ''
  while ([DateTime]::UtcNow -lt $deadline) {
    try {
      $payload = Invoke-JsonHttpGet -Uri $StatusUrl -Headers $Headers -TimeoutSeconds 2
      if ($payload -and $payload.ok -eq $true) {
        Write-RemoteUpdateLog "Updater daemon readiness check passed: $StatusUrl"
        return
      }
      $lastDetail = "unexpected updater status payload"
    } catch {
      $lastDetail = $_.Exception.Message
    }
    Start-Sleep -Milliseconds 300
  }
  throw "updater daemon did not become ready: $lastDetail"
}

function Start-UpdaterDaemonForRemoteRollback {
  $bind = Get-UpdaterBindAddress
  $secret = Get-RemoteUpdateLanSecret
  if ([string]::IsNullOrWhiteSpace($bind) -or [string]::IsNullOrWhiteSpace($secret)) {
    Write-RemoteUpdateLog 'Updater daemon start skipped; remote updater port or LAN trust secret is missing.'
    return
  }
  if (-not (Test-Path -LiteralPath $DstUpdaterExe)) {
    throw "API Router Updater.exe is missing after install: $DstUpdaterExe"
  }
  $env:API_ROUTER_REMOTE_UPDATE_LAN_SECRET = $secret.Trim()
  if ([string]::IsNullOrWhiteSpace([string]$env:API_ROUTER_USER_DATA_DIR)) {
    $env:API_ROUTER_USER_DATA_DIR = Get-RepoUserDataDir
  }
  $daemonExe = Install-UpdaterDaemonRuntime

  try {
    Enter-BuildStep -Phase 'start_updater_daemon' -Label 'Starting updater daemon' -Detail "Binding independent rollback endpoint on $bind"
    $headers = @{
      'x-api-router-lan-node-id' = if ($env:API_ROUTER_REMOTE_UPDATE_REQUESTER_NODE_ID) { $env:API_ROUTER_REMOTE_UPDATE_REQUESTER_NODE_ID } else { 'remote-update-worker' }
      'x-api-router-lan-secret' = $secret.Trim()
    }
    $statusUrl = "http://127.0.0.1:$($env:API_ROUTER_REMOTE_UPDATE_UPDATER_PORT.Trim())/status"
    try {
      Wait-UpdaterDaemonReady -StatusUrl $statusUrl -Headers $headers -TimeoutSeconds 2
      return
    } catch {
      Write-RemoteUpdateLog ("Existing updater daemon probe missed; starting daemon: " + $_.Exception.Message)
    }

    $arguments = @('serve', '--repo-root', $RepoRoot, '--bind', $bind)
    Start-Process `
      -FilePath $daemonExe `
      -ArgumentList $arguments `
      -WorkingDirectory $RepoRoot `
      -WindowStyle Hidden | Out-Null
    Reset-LastExitCode
    Wait-UpdaterDaemonReady -StatusUrl $statusUrl -Headers $headers -TimeoutSeconds 10
  } finally {
    $env:API_ROUTER_REMOTE_UPDATE_LAN_SECRET = $null
  }
}

function Backup-CurrentRuntimeForRollback {
  $recordedCurrentSha = Get-RecordedRuntimeSha 'current'
  $fromSha = Normalize-VersionSha $env:API_ROUTER_REMOTE_UPDATE_FROM_GIT_SHA $recordedCurrentSha
  if (-not (Test-Path -LiteralPath $DstExe)) {
    Write-RemoteUpdateLog "Rollback backup skipped; current runtime does not exist: $DstExe"
    return $null
  }
  Enter-BuildStep -Phase 'backing_up' -Label 'Backing up runtime' -Detail "Saving rollback version $fromSha"
  Invoke-UpdaterCommand `
    -PreferredUpdaterPath $SrcUpdaterExe `
    -ArgumentList @('backup', '--repo-root', $RepoRoot, '--git-sha', $fromSha, '--source', $DstExe) `
    -FailureMessage 'updater backup'
  $env:API_ROUTER_REMOTE_UPDATE_PREVIOUS_GIT_SHA = $fromSha
  $env:API_ROUTER_REMOTE_UPDATE_ROLLBACK_AVAILABLE = '1'
  Write-RemoteUpdateLog "Rollback backup saved by updater: sha=$fromSha"
  return $fromSha
}

function Record-InstalledRuntimeVersion {
  $targetFallback = if (-not [string]::IsNullOrWhiteSpace([string]$env:API_ROUTER_REMOTE_UPDATE_TARGET_REF)) {
    [string]$env:API_ROUTER_REMOTE_UPDATE_TARGET_REF
  } else {
    Get-RepoGitHeadSha
  }
  $toSha = Normalize-VersionSha $env:API_ROUTER_REMOTE_UPDATE_TO_GIT_SHA $targetFallback
  Invoke-UpdaterCommand `
    -PreferredUpdaterPath $DstUpdaterExe `
    -ArgumentList @('record-current', '--repo-root', $RepoRoot, '--git-sha', $toSha, '--source', $DstExe) `
    -FailureMessage 'updater record current'
  $env:API_ROUTER_REMOTE_UPDATE_CURRENT_GIT_SHA = $toSha
  Write-RemoteUpdateLog "Installed runtime version recorded by updater: sha=$toSha"
}

function Restore-PreviousRuntime {
  $previousSha = Normalize-VersionSha $env:API_ROUTER_REMOTE_UPDATE_PREVIOUS_GIT_SHA ''
  if ($previousSha -eq 'unknown') {
    throw 'previous runtime sha is unknown; cannot rollback'
  }
  Enter-BuildStep -Phase 'rolling_back' -Label 'Rolling back runtime' -Detail "Restoring previous version $previousSha"
  Invoke-UpdaterCommand `
    -PreferredUpdaterPath $SrcUpdaterExe `
    -ArgumentList @('rollback', '--repo-root', $RepoRoot, '--start-hidden') `
    -FailureMessage 'updater rollback'
  $env:API_ROUTER_REMOTE_UPDATE_CURRENT_GIT_SHA = $previousSha
  Update-RemoteUpdateTimelineStep -Phase 'rolled_back' -Label 'Rolled back runtime' -Detail "Rolled back to $previousSha" -State 'rolled_back' -FinishedAtUnixMs ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
  Write-RemoteUpdateLog "Rolled back runtime to $previousSha"
}

function Write-BuildExitDiagnostics([string]$Result) {
  $restartWarningSummary = if ($null -ne $restartWarning) {
    $restartWarning.Exception.Message
  } else {
    'none'
  }
  $currentPhase = if ($script:CurrentBuildStepPhase) { $script:CurrentBuildStepPhase } else { 'none' }
  $currentLabel = if ($script:CurrentBuildStepLabel) { $script:CurrentBuildStepLabel } else { 'none' }
  $currentDetail = if ($script:CurrentBuildStepDetail) { $script:CurrentBuildStepDetail } else { 'none' }
  Write-RemoteUpdateLog ("Build script final state: result={0}; had_failure={1}; restart_warning={2}; last_exit_code={3}; success_flag={4}; current_phase={5}; current_label={6}; current_detail={7}" -f `
      $Result,
      $hadFailure.ToString().ToLowerInvariant(),
      $restartWarningSummary,
      $LASTEXITCODE,
      $?.ToString().ToLowerInvariant(),
      $currentPhase,
      $currentLabel,
      $currentDetail)
}

function Write-BuildResultMarker([string]$Result) {
  $resultPath = Get-RemoteUpdateBuildResultPath
  if (-not $resultPath) { return }

  try {
    $parent = Split-Path -Parent $resultPath
    if ($parent) {
      New-Item -ItemType Directory -Force -Path $parent | Out-Null
    }
    $payload = [ordered]@{
      result = $Result
      had_failure = $hadFailure
      last_exit_code = $LASTEXITCODE
      success_flag = $?
      current_phase = if ($script:CurrentBuildStepPhase) { $script:CurrentBuildStepPhase } else { $null }
      current_label = if ($script:CurrentBuildStepLabel) { $script:CurrentBuildStepLabel } else { $null }
      current_detail = if ($script:CurrentBuildStepDetail) { $script:CurrentBuildStepDetail } else { $null }
      written_at_unix_ms = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    }
    $json = $payload | ConvertTo-Json -Depth 4
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($resultPath, $json, $utf8NoBom)
  } catch {
    Write-RemoteUpdateLog ("Failed to write build result marker: " + $_.Exception.Message)
  }
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
    $status.from_git_sha = if ($env:API_ROUTER_REMOTE_UPDATE_FROM_GIT_SHA) { $env:API_ROUTER_REMOTE_UPDATE_FROM_GIT_SHA } else { $status.from_git_sha }
    $status.to_git_sha = if ($env:API_ROUTER_REMOTE_UPDATE_TO_GIT_SHA) { $env:API_ROUTER_REMOTE_UPDATE_TO_GIT_SHA } else { $status.to_git_sha }
    $status.current_git_sha = if ($env:API_ROUTER_REMOTE_UPDATE_CURRENT_GIT_SHA) { $env:API_ROUTER_REMOTE_UPDATE_CURRENT_GIT_SHA } else { $status.current_git_sha }
    $status.previous_git_sha = if ($env:API_ROUTER_REMOTE_UPDATE_PREVIOUS_GIT_SHA) { $env:API_ROUTER_REMOTE_UPDATE_PREVIOUS_GIT_SHA } else { $status.previous_git_sha }
    if ($env:API_ROUTER_REMOTE_UPDATE_PROGRESS_PERCENT) {
      $status.progress_percent = [int]$env:API_ROUTER_REMOTE_UPDATE_PROGRESS_PERCENT
    }
    $status.rollback_available = ([string]$env:API_ROUTER_REMOTE_UPDATE_ROLLBACK_AVAILABLE -eq '1')
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
  $progressByPhase = @{
    skip_prerelease_checks = 50
    run_prebuild_checks = 50
    build_release_binary = 65
    build_updater_binary = 70
    reuse_release_binary = 65
    backing_up = 72
    start_updater_daemon = 76
    install_release_binary = 78
    restart_api_router = 88
    health_checking = 94
    rolling_back = 96
    rolled_back = 100
  }
  if ($progressByPhase.ContainsKey($Phase)) {
    $env:API_ROUTER_REMOTE_UPDATE_PROGRESS_PERCENT = [string]$progressByPhase[$Phase]
  }
  Write-Host "${Label}: $Detail"
  Write-RemoteUpdateLog "${Label}: $Detail"
  Update-RemoteUpdateTimelineStep -Phase $Phase -Label $Label -Detail "${Label}: $Detail"
}

function Get-StageDurationText([int64]$StartedAtUnixMs) {
  $elapsedMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $StartedAtUnixMs
  if ($elapsedMs -lt 0) {
    $elapsedMs = 0
  }
  return ('{0:N1}s' -f ($elapsedMs / 1000.0))
}

function Is-ApiRouterRunning {
  try {
    $p = Get-ApiRouterRuntimeProcesses | Select-Object -First 1
    return [bool]$p
  } catch {
    return $false
  }
}

function Format-ProcessSummary([object[]]$Processes) {
  if (-not $Processes -or $Processes.Count -eq 0) { return '<none>' }
  return (($Processes | ForEach-Object {
        $path = if ($_.Path) { $_.Path } else { '<unknown path>' }
        "pid=$($_.Id) path=$path"
      }) -join '; ')
}

function Get-ProcessCommandLineSummary([int[]]$ProcessIds) {
  if (-not $ProcessIds -or $ProcessIds.Count -eq 0) { return '<none>' }
  $items = @()
  foreach ($processId in $ProcessIds) {
    try {
      $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $processId" -ErrorAction Stop
      if ($proc) {
        $items += "pid=$processId parent=$($proc.ParentProcessId) exe=$($proc.ExecutablePath) command=$($proc.CommandLine)"
      } else {
        $items += "pid=$processId <missing cim process>"
      }
    } catch {
      $items += "pid=$processId <command line unavailable: $($_.Exception.Message)>"
    }
  }
  return ($items -join '; ')
}

function Get-ApiRouterRuntimeProcesses {
  $targetPath = Normalize-PathForComparison $DstExe
  if (-not $targetPath) { return @() }
  $seen = @{}
  $matches = @()
  try {
    $processMatches = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
        $candidatePath = Get-ProcessExecutablePath $_
        $normalizedCandidate = Normalize-PathForComparison $candidatePath
        $normalizedCandidate -and ($normalizedCandidate -ieq $targetPath)
      })
    foreach ($process in $processMatches) {
      $seen[[string]$process.Id] = $true
      $matches += $process
    }
  } catch {
    Write-RemoteUpdateLog ("Failed to inspect runtime processes via Get-Process: " + $_.Exception.Message)
  }
  try {
    $cimMatches = @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {
        $name = [string]$_.Name
        $commandLine = [string]$_.CommandLine
        if (($name -ine $AppExeName) -and ($commandLine.IndexOf($DstExe, [System.StringComparison]::OrdinalIgnoreCase) -lt 0)) {
          return $false
        }
        $normalizedCandidate = Normalize-PathForComparison $_.ExecutablePath
        if ($normalizedCandidate -and ($normalizedCandidate -ieq $targetPath)) { return $true }
        return (-not [string]::IsNullOrWhiteSpace($commandLine)) -and
          ($commandLine.IndexOf($DstExe, [System.StringComparison]::OrdinalIgnoreCase) -ge 0)
      })
    foreach ($process in $cimMatches) {
      $pidKey = [string]$process.ProcessId
      if ($seen.ContainsKey($pidKey)) { continue }
      $matches += [pscustomobject]@{
        Id       = [int]$process.ProcessId
        Path     = [string]$process.ExecutablePath
        HasExited = $false
      }
      $seen[$pidKey] = $true
    }
  } catch {
    Write-RemoteUpdateLog ("Failed to inspect runtime processes via CIM: " + $_.Exception.Message)
  }
  return @($matches)
}

function Get-ListenPortOwnerProcesses {
  $port = Get-ConfiguredListenPort
  if (-not $port) { return @() }
  try {
    $connections = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
    $pids = @($connections | ForEach-Object { $_.OwningProcess } | Where-Object { $_ } | Sort-Object -Unique)
    return @($pids | ForEach-Object {
        Get-Process -Id $_ -ErrorAction SilentlyContinue
      } | Where-Object { $_ })
  } catch {
    Write-RemoteUpdateLog ("Failed to inspect listen port owner: " + $_.Exception.Message)
    return @()
  }
}

function Get-RuntimePortOwnerDetail {
  $port = Get-ConfiguredListenPort
  $owners = @(Get-ListenPortOwnerProcesses)
  return "port $port listeners: $(Format-ProcessSummary $owners)"
}

function Wait-ApiRouterRuntimeStopped {
  param(
    [Nullable[int]]$TimeoutSeconds = $null
  )

  if ($TimeoutSeconds -eq $null) { $TimeoutSeconds = 10 }
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  $lastDetail = ''
  while ([DateTime]::UtcNow -lt $deadline) {
    $runtimeProcesses = @(Get-ApiRouterRuntimeProcesses | Where-Object { -not $_.HasExited })
    if ($runtimeProcesses.Count -eq 0) {
      Write-RemoteUpdateLog "Runtime stop check passed: repo root API Router.exe is not running."
      return
    }
    $lastDetail = Format-ProcessSummary $runtimeProcesses
    Start-Sleep -Milliseconds 250
  }
  throw "repo root API Router.exe did not stop: $lastDetail; $(Get-RuntimePortOwnerDetail)"
}

function Start-ApiRouter {
  param(
    [switch]$RequireNewProcess
  )

  if (Is-ApiRouterRunning) {
    if ($RequireNewProcess) {
      $runtimeProcesses = @(Get-ApiRouterRuntimeProcesses | Where-Object { -not $_.HasExited })
      throw "existing API Router.exe process is still running before restart: $(Format-ProcessSummary $runtimeProcesses); $(Get-RuntimePortOwnerDetail)"
    }
    Write-Host "API Router already running."
    return Get-ApiRouterRuntimeProcesses | Select-Object -First 1
  }
  if (-not (Test-Path $StartFilePath)) {
    Write-Warning "Missing start target: $StartFilePath (cannot restart)"
    return $null
  }
  $env:API_ROUTER_PROFILE = $null
  if ($TestProfile) { $env:API_ROUTER_PROFILE = 'test' }
  Clear-RuntimeStartupDiagnostics
  $arguments = @()
  if ($StartHidden) { $arguments += '--start-hidden' }
  Write-Host "Starting: $StartFilePath"
  $startOptions = @{
    FilePath = $StartFilePath
    WorkingDirectory = $RepoRoot
  }
  if ($StartHidden) {
    # Remote update restarts must stay visually silent. Keep this explicit so future
    # changes do not reintroduce a late console flash during the restart phase.
    $startOptions.WindowStyle = 'Hidden'
  }
  $startOptions.PassThru = $true
  $startedProcess = if ($arguments.Count -gt 0) {
    Start-Process @startOptions -ArgumentList $arguments
  } else {
    Start-Process @startOptions
  }
  Reset-LastExitCode
  if ($startedProcess) {
    Write-RemoteUpdateLog "Started API Router process: pid=$($startedProcess.Id); path=$StartFilePath"
    Write-RemoteUpdateLog "Started API Router command line: $(Get-ProcessCommandLineSummary @([int]$startedProcess.Id))"
  }
  return $startedProcess
}

function Wait-ApiRouterRuntimeProcessStarted {
  param(
    [Parameter(Mandatory = $false)]
    [object]$StartedProcess,
    [Nullable[int]]$TimeoutSeconds = $null
  )

  if ($TimeoutSeconds -eq $null) {
    $TimeoutSeconds = 15
  }
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  $stableSince = $null
  $lastDetail = ''
  $lastLoggedDetail = ''
  while ([DateTime]::UtcNow -lt $deadline) {
    try {
      if ($StartedProcess -and $StartedProcess.Id) {
        $startedById = Get-Process -Id $StartedProcess.Id -ErrorAction SilentlyContinue
        if ($null -eq $startedById -or $startedById.HasExited) {
          throw "started API Router process exited before HTTP health check: pid=$($StartedProcess.Id)"
        }
      }
      $alive = @(Get-ApiRouterRuntimeProcesses | Where-Object { -not $_.HasExited })
      if ($alive.Count -gt 0) {
        if ($null -eq $stableSince) {
          $stableSince = [DateTime]::UtcNow
          $pids = ($alive | ForEach-Object { $_.Id }) -join ','
          $lastDetail = "repo root API Router.exe process observed: pid=$pids"
          Write-RemoteUpdateLog $lastDetail
          Write-RemoteUpdateLog "Observed API Router command line: $(Get-ProcessCommandLineSummary @($alive | ForEach-Object { [int]$_.Id }))"
        } elseif ((([DateTime]::UtcNow) - $stableSince).TotalMilliseconds -ge 1500) {
          $pids = ($alive | ForEach-Object { $_.Id }) -join ','
          Write-RemoteUpdateLog "Runtime restart gate passed: repo root API Router.exe stayed alive; pid=$pids"
          Update-RemoteUpdateTimelineStep -Phase 'restart_verified' -Label 'Runtime process verified' -Detail "API Router.exe process is running: pid=$pids" -State 'running'
          return
        }
      } else {
        $stableSince = $null
        $lastDetail = 'repo root API Router.exe process is not running yet'
        if ($lastDetail -ne $lastLoggedDetail) {
          Write-RemoteUpdateLog "$lastDetail; $(Get-RuntimePortOwnerDetail)"
          $lastLoggedDetail = $lastDetail
        }
      }
    } catch {
      $lastDetail = $_.Exception.Message
      throw "runtime restart check failed: $lastDetail; $(Get-RuntimePortOwnerDetail)"
    }
    Start-Sleep -Milliseconds 250
  }
  if (-not $lastDetail) {
    $lastDetail = 'timed out waiting for repo root API Router.exe process'
  }
  throw "runtime restart check failed: $lastDetail; $(Get-RuntimePortOwnerDetail)"
}

function Wait-ApiRouterRuntimeHealthy {
  param(
    [Nullable[int]]$TimeoutSeconds = $null
  )

  if ($TimeoutSeconds -eq $null) {
    $TimeoutSeconds = Get-ApiRouterRuntimeHealthTimeoutSeconds
  }
  $healthUrl = Get-LocalHttpHealthUrl
  $statusUrl = Get-LocalHttpStatusUrl
  $expectedGitSha = Get-ExpectedRuntimeGitSha
  $detail = if ($healthUrl) { "Waiting for API Router HTTP health at $healthUrl" } else { 'Waiting for repo root API Router.exe process' }
  Enter-BuildStep -Phase 'health_checking' -Label 'Checking runtime health' -Detail $detail
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  $lastDetail = ''
  $lastLoggedDetail = ''
  while ([DateTime]::UtcNow -lt $deadline) {
    try {
      $processes = @(Get-ApiRouterRuntimeProcesses)
      if ($processes.Count -gt 0) {
        $alive = @($processes | Where-Object { -not $_.HasExited })
        if ($alive.Count -gt 0) {
          if ($healthUrl) {
            $payload = Invoke-JsonHttpGet -Uri $healthUrl -TimeoutSeconds 2
            if ($payload -and $payload.ok -eq $true) {
              if (-not [string]::IsNullOrWhiteSpace($expectedGitSha)) {
                if ([string]::IsNullOrWhiteSpace($statusUrl)) {
                  $lastDetail = "status endpoint unavailable while expecting build $expectedGitSha"
                  continue
                }
                $statusPayload = Invoke-JsonHttpGet -Uri $statusUrl -TimeoutSeconds 2
                $actualGitSha = [string]$statusPayload.lan_sync.local_node.build_identity.build_git_sha
                if ($actualGitSha.Trim() -ine $expectedGitSha.Trim()) {
                  $lastDetail = "runtime build sha $actualGitSha does not match expected $expectedGitSha"
                  if ($lastDetail -ne $lastLoggedDetail) {
                    Write-RemoteUpdateLog "$lastDetail; $(Get-RuntimePortOwnerDetail)"
                    $lastLoggedDetail = $lastDetail
                  }
                  continue
                }
                Write-RemoteUpdateLog "Runtime build check passed: $actualGitSha."
              }
              Write-RemoteUpdateLog "Runtime health check passed: $healthUrl returned ok=true."
              return
            }
            $lastDetail = "health endpoint returned unexpected payload"
            if ($lastDetail -ne $lastLoggedDetail) {
              Write-RemoteUpdateLog "$lastDetail; $(Get-RuntimePortOwnerDetail)"
              $lastLoggedDetail = $lastDetail
            }
          } else {
            Write-RemoteUpdateLog "Runtime health check passed: API Router.exe process is running."
            return
          }
        } else {
          $lastDetail = 'repo root API Router.exe process has exited'
        }
      } else {
        $lastDetail = 'repo root API Router.exe process is not running yet'
      }
    } catch {
      $lastDetail = $_.Exception.Message
      if ($lastDetail -ne $lastLoggedDetail) {
        Write-RemoteUpdateLog "Runtime health probe failed: $lastDetail; $(Get-RuntimePortOwnerDetail)"
        $lastLoggedDetail = $lastDetail
      }
    }
    Start-Sleep -Milliseconds 500
  }
  if (-not $lastDetail) {
    $lastDetail = 'timed out waiting for API Router.exe'
  }
  Write-RuntimeStartupDiagnostics "runtime health timeout"
  $startupDiagnosis = Get-RuntimeStartupDiagnosisSummary
  $failureDetail = "runtime health check failed: $lastDetail; $(Get-RuntimePortOwnerDetail); $startupDiagnosis"
  Update-RemoteUpdateTimelineStep `
    -Phase 'health_check_failed' `
    -Label 'Runtime health check failed' `
    -Detail $failureDetail `
    -State 'failed'
  throw $failureDetail
}

function Stop-RunningApiRouter {
  # Best-effort: if the root EXE is running, replacing it will fail with EPERM/EBUSY.
  # Only target exact executable paths so another checkout or raw Tauri artifact is not stopped.
  $runtimeProcesses = @(Get-ApiRouterRuntimeProcesses)
  if ($runtimeProcesses.Count -gt 0) {
    Write-RemoteUpdateLog "Stopping repo root API Router.exe process(es): $(Format-ProcessSummary $runtimeProcesses)"
    foreach ($process in $runtimeProcesses) {
      try {
        Stop-Process -Id ([int]$process.Id) -Force -ErrorAction Stop
      } catch {
        Write-RemoteUpdateLog "Failed to stop API Router.exe pid=$($process.Id): $($_.Exception.Message)"
      }
    }
  }
  try {
    Get-Process -ErrorAction SilentlyContinue | Where-Object {
      $_.Path -and (($_.Path -ieq $DstExe) -or ($_.Path -ieq $DstTestExe) -or ($_.Path -ieq $SrcExe))
    } | Stop-Process -Force -ErrorAction SilentlyContinue
  } catch {
    Write-RemoteUpdateLog ("Failed to stop secondary API Router processes: " + $_.Exception.Message)
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
      Wait-ApiRouterRuntimeStopped
      Start-Sleep -Milliseconds (250 + ($i * 150))
    }
  }
}

function Test-ArtifactUpToDate([string]$From, [string]$To) {
  if (-not (Test-Path -LiteralPath $From)) { return $false }
  if (-not (Test-Path -LiteralPath $To)) { return $false }
  try {
    $fromItem = Get-Item -LiteralPath $From
    $toItem = Get-Item -LiteralPath $To
    return $toItem.LastWriteTimeUtc -ge $fromItem.LastWriteTimeUtc
  } catch {
    return $false
  }
}

function Try-CopyOptionalArtifact([string]$From, [string]$To, [string]$Label) {
  if (Test-ArtifactUpToDate $From $To) {
    Write-Host "Up to date: $To"
    Write-RemoteUpdateLog "$Label already up to date: $To"
    return $true
  }
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
  $stderrTail = @($StderrLines | Select-Object -Last 80)
  $stdoutTail = @($StdoutLines | Select-Object -Last 80)
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
    [string]$FailureLabel,
    [switch]$UseProcessExitCode
  )

  if (-not $StartHidden -and -not $UseProcessExitCode) {
    Reset-LastExitCode
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
  $startInfo.CreateNoWindow = [bool]$StartHidden
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true

  $process = [System.Diagnostics.Process]::Start($startInfo)
  $stdout = $process.StandardOutput.ReadToEnd()
  $stderr = $process.StandardError.ReadToEnd()
  $process.WaitForExit()
  $stdoutLines = if ($stdout) { @($stdout -split "\r?\n") } else { @() }
  $stderrLines = if ($stderr) { @($stderr -split "\r?\n") } else { @() }
  if (-not $StartHidden) {
    if ($stdout) { [Console]::Out.Write($stdout) }
    if ($stderr) { [Console]::Error.Write($stderr) }
  }
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
$script:BuildResult = 'succeeded'
$script:CurrentBuildStepPhase = ''
$script:CurrentBuildStepLabel = ''
$script:CurrentBuildStepDetail = ''
$script:RuntimeRollbackCandidate = $false
try {
  $buildStartedAtUnixMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  # Keep the outer checks explicit so remote-update diagnostics can point at the first
  # failing gate, but let Tauri own the frontend build itself.
  if ($SkipPrereleaseChecks) {
    Enter-BuildStep -Phase 'skip_prerelease_checks' -Label 'Skipping pre-build checks' -Detail 'Using results from the checked-build parallel preflight stage'
  } else {
    Invoke-BuildStage `
      -Phase 'run_prebuild_checks' `
      -Label 'Running pre-build checks' `
      -Detail 'Running the canonical root EXE checks entry' `
      -FilePath $NodeCli `
      -ArgumentList @($RootExeChecksCli) `
      -FailureLabel 'root exe checks'
  }

  if ($SkipReleaseBuild) {
    Enter-BuildStep -Phase 'reuse_release_binary' -Label 'Reusing release binary' -Detail 'Skipping Tauri app build; updater binary still builds in this script'
    if (-not (Test-Path $SrcExe)) { throw "Missing built exe: $SrcExe" }
  } else {
    # Build tauri app (produces src-tauri/target/release/api_router.exe).
    Invoke-BuildStage `
      -Phase 'build_release_binary' `
      -Label 'Building release binary' `
      -Detail 'Running direct Tauri build via Windows SDK wrapper' `
      -FilePath $NodeCli `
      -ArgumentList @($RunWithWinSdkCli, 'node', $TauriCliEntry, 'build', '--no-bundle') `
      -FailureLabel 'tauri build'
  }
  Invoke-BuildStage `
    -Phase 'build_updater_binary' `
    -Label 'Building updater binary' `
    -Detail 'Compiling independent API Router Updater.exe' `
    -FilePath $NodeCli `
    -ArgumentList @($RunWithWinSdkCli, 'cargo', 'build', '--manifest-path', (Join-Path $RepoRoot 'src-tauri\Cargo.toml'), '--release', '--bin', 'api_router_updater') `
    -FailureLabel 'updater build'
  Write-RemoteUpdateLog ("Primary build stages completed in {0}" -f (Get-StageDurationText $buildStartedAtUnixMs))

  if (-not $NoCopy) {
    Enter-BuildStep -Phase 'install_release_binary' -Label 'Installing EXE' -Detail 'Replacing repo root API Router executables'
    if (-not (Test-Path $SrcExe)) { throw "Missing built exe: $SrcExe" }
    if (-not (Test-Path $SrcUpdaterExe)) { throw "Missing built updater exe: $SrcUpdaterExe" }
    $null = Backup-CurrentRuntimeForRollback

    if (Test-ArtifactUpToDate $SrcExe $DstExe) {
      Write-Host "Up to date: $DstExe"
      Write-RemoteUpdateLog "Canonical runtime executable already up to date: $DstExe"
    } else {
      Stop-RunningApiRouter
      Wait-ApiRouterRuntimeStopped
      $script:RuntimeRollbackCandidate = $true
      Copy-WithRetry $SrcExe $DstExe
      Write-Host "Wrote: $DstExe"
      Write-RemoteUpdateLog "Installed canonical runtime executable: $DstExe"
    }
    Stop-RunningUpdaterDaemon
    Copy-WithRetry $SrcUpdaterExe $DstUpdaterExe
    Write-Host "Wrote: $DstUpdaterExe"
    Write-RemoteUpdateLog "Installed independent updater executable: $DstUpdaterExe"
    Start-UpdaterDaemonForRemoteRollback
    Record-InstalledRuntimeVersion
    # The canonical runtime is API Router.exe. The TEST copy is auxiliary and must not
    # turn a successful remote update into a failed one if that secondary artifact is locked.
    $null = Try-CopyOptionalArtifact $SrcExe $DstTestExe 'Optional TEST EXE'
  }
} catch {
  $hadFailure = $true
  $script:BuildResult = 'failed'
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
    if ($script:RuntimeRollbackCandidate -and $hadFailure) {
      throw 'post-install failure after replacing API Router.exe; forcing rollback before starting the new runtime'
    }
    $startedRuntimeProcess = Start-ApiRouter -RequireNewProcess:($script:RuntimeRollbackCandidate -and -not $NoCopy)
    if (-not $NoCopy) {
      Wait-ApiRouterRuntimeProcessStarted -StartedProcess $startedRuntimeProcess
      Wait-ApiRouterRuntimeHealthy
      $env:API_ROUTER_REMOTE_UPDATE_PROGRESS_PERCENT = '100'
      Update-RemoteUpdateTimelineStep -Phase 'health_check_succeeded' -Label 'Runtime health check passed' -Detail 'API Router.exe is running' -State 'running'
    }
  } catch {
    $runtimeValidationError = $_
    if ($script:RuntimeRollbackCandidate -and -not $NoCopy) {
      Write-RemoteUpdateLog ("Runtime validation failed; starting rollback: " + $runtimeValidationError.Exception.Message)
      try {
        Restore-PreviousRuntime
        Wait-ApiRouterRuntimeProcessStarted -StartedProcess $null
        Wait-ApiRouterRuntimeHealthy
        Update-RemoteUpdateTimelineStep -Phase 'rolled_back' -Label 'Rollback health check passed' -Detail "Rolled back to $env:API_ROUTER_REMOTE_UPDATE_CURRENT_GIT_SHA" -State 'rolled_back' -FinishedAtUnixMs ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
        $script:BuildResult = 'rolled_back'
        $hadFailure = $true
        $restartWarning = $runtimeValidationError
      } catch {
        $script:BuildResult = 'failed'
        $hadFailure = $true
        $restartWarning = $_
        Write-RemoteUpdateLog ("Rollback failed: " + $_.Exception.Message)
        Update-RemoteUpdateTimelineStep `
          -Phase 'rollback_failed' `
          -Label 'Rollback failed' `
          -Detail ("Rollback failed: " + $_.Exception.Message) `
          -State 'failed' `
          -FinishedAtUnixMs ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
      }
    } else {
      $restartWarning = $runtimeValidationError
      Write-RemoteUpdateLog ("Restart warning: " + $runtimeValidationError.Exception.Message)
      Update-RemoteUpdateTimelineStep `
        -Phase 'restart_api_router' `
        -Label 'Restarting API Router' `
        -Detail ("Restarting API Router: " + $runtimeValidationError.Exception.Message) `
        -State 'running'
      Write-Warning ("API Router restart after build failed: " + $runtimeValidationError.Exception.Message)
    }
  }
  Write-BuildExitDiagnostics $script:BuildResult
  Write-BuildResultMarker $script:BuildResult
}

if ($hadFailure) {
  exit 1
}

if ($null -ne $restartWarning) {
  Write-Warning "Windows EXE build succeeded, but the restart attempt failed. See warning above."
}

# PowerShell can otherwise propagate a stale non-zero $LASTEXITCODE from native
# build helpers even when this script completed successfully.
Reset-LastExitCode
exit 0
