param(
    [int]$Samples = 120,
    [int]$IntervalSeconds = 5,
    [string]$OutputPath = ""
)

$ErrorActionPreference = "Stop"

if (-not $OutputPath) {
    $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $OutputPath = Join-Path $PSScriptRoot "wsl-memory-watch-$timestamp.log"
}

$wslConfigPath = Join-Path $env:USERPROFILE ".wslconfig"
$wslConfig = if (Test-Path $wslConfigPath) { Get-Content $wslConfigPath -Raw } else { "<missing>" }

@(
    "# WSL memory watch"
    "# Started: $(Get-Date -Format s)"
    "# Samples: $Samples"
    "# IntervalSeconds: $IntervalSeconds"
    "# Host .wslconfig:"
    $wslConfig.TrimEnd()
    ""
) | Set-Content -Path $OutputPath

for ($i = 1; $i -le $Samples; $i++) {
    $stamp = Get-Date -Format s
    Add-Content -Path $OutputPath -Value "===== sample $i / $Samples @ $stamp ====="

    try {
        $meminfo = wsl -e cat /proc/meminfo 2>&1
        Add-Content -Path $OutputPath -Value $meminfo
    } catch {
        Add-Content -Path $OutputPath -Value "meminfo failed: $($_.Exception.Message)"
    }

    Add-Content -Path $OutputPath -Value ""

    try {
        $topProcs = wsl -e sh -lc "ps -eo pid,ppid,comm,rss,%mem,%cpu,args --sort=-rss | head -n 20" 2>&1
        Add-Content -Path $OutputPath -Value $topProcs
    } catch {
        Add-Content -Path $OutputPath -Value "process list failed: $($_.Exception.Message)"
    }

    Add-Content -Path $OutputPath -Value ""

    if ($i -lt $Samples) {
        Start-Sleep -Seconds $IntervalSeconds
    }
}

Write-Output "Saved WSL memory watch log to $OutputPath"
