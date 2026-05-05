param()

$ErrorActionPreference = 'Stop'

# Validate the "always restart" guarantee:
# - We deliberately do NOT build/copy here (too slow / environment-specific)
# - We verify the script always *attempts* to restart even when an early failure occurs
#
# This runs fast and is safe to execute in CI/local.

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\\..\\..')).Path
$ScriptPath = Join-Path $RepoRoot 'tools\build\build-root-exe.ps1'

if (-not (Test-Path $ScriptPath)) { throw "Missing script: $ScriptPath" }

 $probeOut = Join-Path $RepoRoot 'user-data\\tmp\\build-root-exe.recovery-probe.out.log'
 $probeErr = Join-Path $RepoRoot 'user-data\\tmp\\build-root-exe.recovery-probe.err.log'
 $probeArgs = @(
   '-NoProfile',
   '-ExecutionPolicy', 'Bypass',
   '-File', $ScriptPath,
   '-NoCopy',
   '-TestProfile'
 )

 Remove-Item -LiteralPath $probeOut, $probeErr -Force -ErrorAction SilentlyContinue
 $previousProbe = [string][System.Environment]::GetEnvironmentVariable('API_ROUTER_BUILD_MUTEX_RECOVERY_PROBE')
 [System.Environment]::SetEnvironmentVariable('API_ROUTER_BUILD_MUTEX_RECOVERY_PROBE', '1')
 try {
   $probe = Start-Process -FilePath 'powershell.exe' -ArgumentList $probeArgs `
   -WorkingDirectory $RepoRoot -NoNewWindow -PassThru `
   -RedirectStandardOutput $probeOut -RedirectStandardError $probeErr
 } finally {
   if ([string]::IsNullOrEmpty($previousProbe)) {
     [System.Environment]::SetEnvironmentVariable('API_ROUTER_BUILD_MUTEX_RECOVERY_PROBE', $null)
   } else {
     [System.Environment]::SetEnvironmentVariable('API_ROUTER_BUILD_MUTEX_RECOVERY_PROBE', $previousProbe)
   }
 }

 Start-Sleep -Seconds 2

 $secondOut = Join-Path $RepoRoot 'user-data\\tmp\\build-root-exe.e2e.out.log'
 $secondErr = Join-Path $RepoRoot 'user-data\\tmp\\build-root-exe.e2e.err.log'
 Remove-Item -LiteralPath $secondOut, $secondErr -Force -ErrorAction SilentlyContinue

$secondScript = Join-Path $RepoRoot 'user-data\\tmp\\build-root-exe-restart-second.ps1'
Set-Content -LiteralPath $secondScript -Encoding Ascii -Value @"
& '$ScriptPath' -NoCopy
exit `$LASTEXITCODE
"@

$p = Start-Process -FilePath 'powershell.exe' -ArgumentList @(
  '-NoProfile',
  '-ExecutionPolicy', 'Bypass',
  '-File', $secondScript
) -WorkingDirectory $RepoRoot -NoNewWindow -PassThru -RedirectStandardOutput $secondOut -RedirectStandardError $secondErr

$p.WaitForExit()
try { $probe.WaitForExit() } catch {}

 $out = ''
 $err = ''
 try { $out = Get-Content $secondOut -Raw } catch {}
 try { $err = Get-Content $secondErr -Raw } catch {}
 $probeOutText = ''
 $probeErrText = ''
 try { $probeOutText = Get-Content $probeOut -Raw } catch {}
 try { $probeErrText = Get-Content $probeErr -Raw } catch {}

if ($p.ExitCode -ne 0) {
  throw "Expected second build to recover after stale mutex cleanup. stdout=`n$out`n`nstderr=`n$err`n`nprobe_out=`n$probeOutText`n`nprobe_err=`n$probeErrText"
}

 if (($out -notmatch 'Build mutex acquired after stale process cleanup') -and ($out -notmatch 'Build mutex is busy; inspecting stale')) {
   throw "Expected stale-process cleanup evidence in stdout. stdout=`n$out`n`nstderr=`n$err`n`nprobe_out=`n$probeOutText`n`nprobe_err=`n$probeErrText"
 }

Write-Host "[build-root-exe-restart.e2e] PASS"
