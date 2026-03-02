param()

$ErrorActionPreference = 'Stop'

# Validate the "always restart" guarantee:
# - We deliberately do NOT build/copy here (too slow / environment-specific)
# - We verify the script always *attempts* to restart even when an early failure occurs
#
# This runs fast and is safe to execute in CI/local.

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$ScriptPath = Join-Path $RepoRoot 'scripts\build-root-exe.ps1'

if (-not (Test-Path $ScriptPath)) { throw "Missing script: $ScriptPath" }

# Force an early failure by removing npm.cmd from PATH.
$env:PATH = "C:\\__missing__"

$p = Start-Process -FilePath 'powershell.exe' -ArgumentList @(
  '-NoProfile',
  '-ExecutionPolicy', 'Bypass',
  '-File', $ScriptPath,
  '-NoCopy'
) -WorkingDirectory $RepoRoot -NoNewWindow -PassThru -RedirectStandardOutput (Join-Path $RepoRoot 'user-data\\tmp\\build-root-exe.e2e.out.log') -RedirectStandardError (Join-Path $RepoRoot 'user-data\\tmp\\build-root-exe.e2e.err.log')

$p.WaitForExit()

$out = ''
$err = ''
try { $out = Get-Content (Join-Path $RepoRoot 'user-data\\tmp\\build-root-exe.e2e.out.log') -Raw } catch {}
try { $err = Get-Content (Join-Path $RepoRoot 'user-data\\tmp\\build-root-exe.e2e.err.log') -Raw } catch {}

if (($out -notmatch 'Starting:\s+.+API Router\.exe') -and ($out -notmatch 'API Router already running\.')) {
  throw "Expected restart attempt not found in stdout. stdout=`n$out`n`nstderr=`n$err"
}

Write-Host "[build-root-exe.e2e] PASS"
