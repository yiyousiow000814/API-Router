param()

$ErrorActionPreference = 'Stop'

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\\..\\..')).Path
$ScriptPath = Join-Path $RepoRoot 'tools\build\build-root-exe.ps1'
if (-not (Test-Path $ScriptPath)) { throw "Missing script: $ScriptPath" }

$tempRoot = Join-Path $RepoRoot 'user-data\tmp\build-root-exe-success-exitcode'
$fakeBin = Join-Path $tempRoot 'fake-bin'
$fakeSrcExe = Join-Path $tempRoot 'src\api_router.exe'
$fakeDstExe = Join-Path $tempRoot 'out\API Router.exe'
$fakeDstTestExe = Join-Path $tempRoot 'out\API Router [TEST].exe'
$fakeStartPath = Join-Path $fakeBin 'start-ok.cmd'
$stdoutPath = Join-Path $tempRoot 'stdout.log'
$logPath = Join-Path $tempRoot 'diagnostics\lan-remote-update.log'
$resultPath = Join-Path $tempRoot 'diagnostics\lan-remote-update-build-result.json'
$fakeTscPath = Join-Path $fakeBin 'tsc.cmd'
$fakeVitePath = Join-Path $fakeBin 'vite.cmd'

Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $fakeBin, (Split-Path -Parent $fakeSrcExe), (Split-Path -Parent $fakeDstExe) | Out-Null

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
exit /b 0
'@

Set-Content -LiteralPath $fakeStartPath -Encoding Ascii -Value @'
@echo off
exit /b 0
'@

Set-Content -LiteralPath $fakeSrcExe -Encoding Ascii -Value 'fake exe payload'

$env:PATH = "$fakeBin;$env:PATH"
$env:API_ROUTER_BUILD_NPM_PATH = $fakeNpmPath
$env:API_ROUTER_BUILD_TSC_PATH = $fakeTscPath
$env:API_ROUTER_BUILD_VITE_PATH = $fakeVitePath
$env:API_ROUTER_BUILD_SRC_EXE_PATH = $fakeSrcExe
$env:API_ROUTER_BUILD_DST_EXE_PATH = $fakeDstExe
$env:API_ROUTER_BUILD_DST_TEST_EXE_PATH = $fakeDstTestExe
$env:API_ROUTER_BUILD_START_FILE_PATH = $fakeStartPath
$env:API_ROUTER_REMOTE_UPDATE_LOG_PATH = $logPath

& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $ScriptPath -StartHidden *> $stdoutPath
$scriptExitCode = $LASTEXITCODE
$out = ''
try { $out = Get-Content -LiteralPath $stdoutPath -Raw } catch {}

if ($scriptExitCode -ne 0) {
  throw "Expected build-root-exe.ps1 success path to exit 0 even after best-effort taskkill misses. exit=$scriptExitCode`nstdout=`n$out"
}
if (-not (Test-Path -LiteralPath $fakeDstExe)) {
  throw "Expected canonical EXE copy at $fakeDstExe"
}
if (-not (Test-Path -LiteralPath $fakeDstTestExe)) {
  throw "Expected TEST EXE copy at $fakeDstTestExe"
}
if ($out -notmatch 'Starting:\s+.+start-ok\.cmd') {
  throw "Expected restart target in stdout. stdout=`n$out"
}
if (-not (Test-Path -LiteralPath $logPath)) {
  throw "Expected diagnostics log at $logPath"
}
$log = Get-Content -LiteralPath $logPath -Raw
if ($log -notmatch 'Build script final state: result=succeeded; had_failure=false;') {
  throw "Expected final success diagnostics in build log.`n$log"
}
if (-not (Test-Path -LiteralPath $resultPath)) {
  throw "Expected build result marker at $resultPath"
}
$result = Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json
if ([string]$result.result -ne 'succeeded') {
  throw "Expected build result marker to report success.`n$($result | ConvertTo-Json -Depth 4)"
}

Write-Host '[build-root-exe-success-exitcode.e2e] PASS'
