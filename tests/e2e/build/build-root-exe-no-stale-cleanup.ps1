param()

$ErrorActionPreference = 'Stop'

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\\..\\..')).Path
$ScriptPath = Join-Path $RepoRoot 'tools\build\build-root-exe.ps1'
if (-not (Test-Path $ScriptPath)) { throw "Missing script: $ScriptPath" }

$out = Join-Path $RepoRoot 'user-data\\tmp\\build-root-exe.no-stale-cleanup.out.log'
$err = Join-Path $RepoRoot 'user-data\\tmp\\build-root-exe.no-stale-cleanup.err.log'
Remove-Item -LiteralPath $out, $err -Force -ErrorAction SilentlyContinue

$p = Start-Process -FilePath 'powershell.exe' -ArgumentList @(
  '-NoProfile',
  '-ExecutionPolicy', 'Bypass',
  '-File', $ScriptPath,
  '-NoCopy'
) -WorkingDirectory $RepoRoot -NoNewWindow -PassThru -RedirectStandardOutput $out -RedirectStandardError $err

$p.WaitForExit()

$stdout = ''
$stderr = ''
try { $stdout = Get-Content $out -Raw } catch {}
try { $stderr = Get-Content $err -Raw } catch {}

if ($stdout -match 'Build mutex is busy; inspecting stale') {
  throw "Unexpected stale-process cleanup for normal local build. stdout=`n$stdout`n`nstderr=`n$stderr"
}

Write-Host "[build-root-exe-no-stale-cleanup.e2e] PASS"
