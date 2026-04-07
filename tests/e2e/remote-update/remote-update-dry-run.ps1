param(
  [string]$TargetRef = '',
  [switch]$SkipBuild,
  [int]$WindowPollMilliseconds = 50
)

$ErrorActionPreference = 'Stop'

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$RemoteUpdateScript = Join-Path $RepoRoot 'src-tauri\src\lan_sync\remote_update\lan-remote-update.ps1'
if (-not (Test-Path -LiteralPath $RemoteUpdateScript)) {
  throw "Missing remote update script: $RemoteUpdateScript"
}

if ([string]::IsNullOrWhiteSpace($TargetRef)) {
  $TargetRef = (& git -C $RepoRoot branch --show-current).Trim()
  if ([string]::IsNullOrWhiteSpace($TargetRef)) {
    $TargetRef = (& git -C $RepoRoot rev-parse HEAD).Trim()
  }
}
if ([string]::IsNullOrWhiteSpace($TargetRef)) {
  throw 'Could not resolve a target ref for dry-run remote update.'
}

$tempRoot = Join-Path $RepoRoot 'user-data\tmp\remote-update-dry-run'
$fakeBin = Join-Path $tempRoot 'fake-bin'
$fakeSrcExe = Join-Path $tempRoot 'src\api_router.exe'
$fakeDstExe = Join-Path $tempRoot 'out\API Router.exe'
$fakeDstTestExe = Join-Path $tempRoot 'out\API Router [TEST].exe'
$fakeStartPath = Join-Path $fakeBin 'start-api-router-dry-run.cmd'
$stdoutPath = Join-Path $tempRoot 'remote-update-stdout.log'
$stderrPath = Join-Path $tempRoot 'remote-update-stderr.log'
$statusPath = Join-Path $tempRoot 'diagnostics\lan-remote-update-status.json'
$logPath = Join-Path $tempRoot 'diagnostics\lan-remote-update.log'
$buildResultPath = Join-Path $tempRoot 'diagnostics\lan-remote-update-build-result.json'
$windowLogPath = Join-Path $tempRoot 'diagnostics\remote-update-window-poll.log'

Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path `
  $fakeBin,
  (Split-Path -Parent $fakeSrcExe),
  (Split-Path -Parent $fakeDstExe),
  (Split-Path -Parent $statusPath) | Out-Null

Set-Content -LiteralPath $fakeStartPath -Encoding Ascii -Value @'
@echo off
exit /b 0
'@
Set-Content -LiteralPath $fakeSrcExe -Encoding Ascii -Value 'remote update dry-run fake exe payload'

if ($SkipBuild) {
  $fakeNpmPath = Join-Path $fakeBin 'npm.cmd'
  $fakeTscPath = Join-Path $fakeBin 'tsc.cmd'
  $fakeVitePath = Join-Path $fakeBin 'vite.cmd'
  Set-Content -LiteralPath $fakeNpmPath -Encoding Ascii -Value @'
@echo off
if "%1"=="run" if "%2"=="check:gateway-provider-id" exit /b 0
if "%1"=="run" if "%2"=="check:line-endings" exit /b 0
if "%1"=="run" if "%2"=="check:web-codex-assets" exit /b 0
if "%1"=="run" if "%2"=="tauri" exit /b 0
echo unexpected fake npm invocation %*
exit /b 9
'@
  Set-Content -LiteralPath $fakeTscPath -Encoding Ascii -Value "@echo off`r`nexit /b 0`r`n"
  Set-Content -LiteralPath $fakeVitePath -Encoding Ascii -Value "@echo off`r`nexit /b 0`r`n"
  $env:API_ROUTER_BUILD_NPM_PATH = $fakeNpmPath
  $env:API_ROUTER_BUILD_TSC_PATH = $fakeTscPath
  $env:API_ROUTER_BUILD_VITE_PATH = $fakeVitePath
}

$env:API_ROUTER_USER_DATA_DIR = $tempRoot
$env:API_ROUTER_REMOTE_UPDATE_STATUS_PATH = $statusPath
$env:API_ROUTER_REMOTE_UPDATE_LOG_PATH = $logPath
$env:API_ROUTER_REMOTE_UPDATE_BUILD_RESULT_PATH = $buildResultPath
$env:API_ROUTER_REMOTE_UPDATE_REQUEST_ID = 'remote-update-dry-run'
$env:API_ROUTER_REMOTE_UPDATE_REQUESTER_NODE_ID = 'local-dry-run'
$env:API_ROUTER_REMOTE_UPDATE_REQUESTER_NODE_NAME = $env:COMPUTERNAME
$env:API_ROUTER_BUILD_SRC_EXE_PATH = $fakeSrcExe
$env:API_ROUTER_BUILD_DST_EXE_PATH = $fakeDstExe
$env:API_ROUTER_BUILD_DST_TEST_EXE_PATH = $fakeDstTestExe
$env:API_ROUTER_BUILD_START_FILE_PATH = $fakeStartPath

$monitorScript = {
  param(
    [string]$LogPath,
    [int]$PollMilliseconds
  )
  $ErrorActionPreference = 'SilentlyContinue'
  $seen = @{}
  Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object {
    $seen["$($_.Id)|$($_.MainWindowHandle)|$($_.MainWindowTitle)"] = $true
  }
  while ($true) {
    $processes = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 }
    foreach ($process in $processes) {
      $key = "$($process.Id)|$($process.MainWindowHandle)|$($process.MainWindowTitle)"
      if ($seen.ContainsKey($key)) { continue }
      $seen[$key] = $true
      $path = ''
      $cmd = ''
      try { $path = $process.Path } catch {}
      try {
        $cim = Get-CimInstance Win32_Process -Filter "ProcessId=$($process.Id)"
        if ($cim) { $cmd = [string]$cim.CommandLine }
      } catch {}
      $timestamp = [DateTimeOffset]::UtcNow.ToString('dd-MM-yyyy HH:mm:ss.fff UTC')
      Add-Content -LiteralPath $LogPath -Encoding UTF8 -Value ("[{0}] pid={1}; name={2}; hwnd={3}; title={4}; path={5}; cmd={6}" -f `
          $timestamp,
          $process.Id,
          $process.ProcessName,
          $process.MainWindowHandle,
          $process.MainWindowTitle,
          $path,
          $cmd)
    }
    Start-Sleep -Milliseconds $PollMilliseconds
  }
}

$monitor = Start-Job -ScriptBlock $monitorScript -ArgumentList $windowLogPath, $WindowPollMilliseconds
try {
  $process = Start-Process -FilePath 'powershell.exe' -ArgumentList @(
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', $RemoteUpdateScript,
    '-TargetRef', $TargetRef
  ) -WorkingDirectory $RepoRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath

  $process.WaitForExit()
  try { $process.Refresh() } catch {}
  $exitCode = $process.ExitCode
} finally {
  Stop-Job -Job $monitor -ErrorAction SilentlyContinue | Out-Null
  Remove-Job -Job $monitor -Force -ErrorAction SilentlyContinue | Out-Null
}

$status = if (Test-Path -LiteralPath $statusPath) {
  Get-Content -LiteralPath $statusPath -Raw
} else {
  ''
}
$log = if (Test-Path -LiteralPath $logPath) {
  Get-Content -LiteralPath $logPath -Raw
} else {
  ''
}
$windowLog = if (Test-Path -LiteralPath $windowLogPath) {
  Get-Content -LiteralPath $windowLogPath -Raw
} else {
  ''
}

if ($exitCode -ne 0) {
  $stderr = ''
  try { $stderr = Get-Content -LiteralPath $stderrPath -Raw } catch {}
  throw "Remote update dry-run failed with exit code $exitCode.`nstatus=`n$status`nlog=`n$log`nstderr=`n$stderr"
}
if (-not (Test-Path -LiteralPath $fakeDstExe)) {
  throw "Expected dry-run copy destination at $fakeDstExe"
}
if ($status -notmatch '"state"\s*:\s*"succeeded"') {
  throw "Expected dry-run remote update status to succeed.`n$status`nlog=`n$log"
}

Write-Host "[remote-update-dry-run.e2e] PASS"
Write-Host "TargetRef: $TargetRef"
Write-Host "Diagnostics: $logPath"
Write-Host "Status: $statusPath"
Write-Host "Build result: $buildResultPath"
Write-Host "Window poll: $windowLogPath"
if ($windowLog) {
  Write-Host "Visible windows observed:"
  $windowLog -split "\r?\n" | Where-Object { $_ } | Select-Object -Last 20 | ForEach-Object {
    Write-Host $_
  }
}
