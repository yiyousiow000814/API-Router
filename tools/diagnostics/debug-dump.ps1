[CmdletBinding()]
param(
    [string]$BaseUrl = "http://127.0.0.1:4000",
    [string]$UserDataDir = "",
    [string]$OutDir = ""
)

$ErrorActionPreference = "Stop"

function Resolve-RepoRoot {
    param([string]$StartDir)
    $dir = Resolve-Path -LiteralPath $StartDir
    while ($dir) {
        if (Test-Path -LiteralPath (Join-Path $dir "user-data")) {
            return $dir
        }
        $parent = Split-Path -Parent $dir
        if (-not $parent -or $parent -eq $dir) {
            break
        }
        $dir = $parent
    }
    throw "Failed to locate repo root from '$StartDir'."
}

function Write-JsonFile {
    param(
        [string]$Path,
        $Value
    )
    $parent = Split-Path -Parent $Path
    if ($parent) {
        New-Item -ItemType Directory -Force -Path $parent | Out-Null
    }
    $Value | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $Path
}

function Copy-IfExists {
    param(
        [string]$Source,
        [string]$Destination
    )
    if (Test-Path -LiteralPath $Source) {
        $parent = Split-Path -Parent $Destination
        if ($parent) {
            New-Item -ItemType Directory -Force -Path $parent | Out-Null
        }
        Copy-Item -LiteralPath $Source -Destination $Destination -Force
        return $true
    }
    return $false
}

$repoRoot = Resolve-RepoRoot -StartDir $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($UserDataDir)) {
    $UserDataDir = Join-Path $repoRoot "user-data"
}

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
if ([string]::IsNullOrWhiteSpace($OutDir)) {
    $OutDir = Join-Path $repoRoot ("debug-dump-" + $timestamp)
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$summary = [ordered]@{
    capturedAt = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
    baseUrl = $BaseUrl
    userDataDir = $UserDataDir
    repoRoot = $repoRoot
    env = [ordered]@{
        API_ROUTER_PROFILE = $env:API_ROUTER_PROFILE
        API_ROUTER_USER_DATA_DIR = $env:API_ROUTER_USER_DATA_DIR
        AO_USER_DATA_DIR = $env:AO_USER_DATA_DIR
    }
    files = [ordered]@{}
    http = [ordered]@{}
}

try {
    $health = Invoke-RestMethod -Uri ($BaseUrl.TrimEnd("/") + "/health") -TimeoutSec 5
    Write-JsonFile -Path (Join-Path $OutDir "health.json") -Value $health
    $summary.http.health = "ok"
}
catch {
    $summary.http.health = $_.Exception.Message
}

try {
    $status = Invoke-RestMethod -Uri ($BaseUrl.TrimEnd("/") + "/status") -TimeoutSec 10
    Write-JsonFile -Path (Join-Path $OutDir "status.json") -Value $status
    $summary.http.status = "ok"
}
catch {
    $summary.http.status = $_.Exception.Message
}

$filesToCopy = @(
    @{ Source = (Join-Path $UserDataDir "app-startup.json"); Destination = "app-startup.json" },
    @{ Source = (Join-Path $UserDataDir "diagnostics\lan-peer-diagnostics.log"); Destination = "diagnostics\lan-peer-diagnostics.log" },
    @{ Source = (Join-Path $UserDataDir "diagnostics\lan-remote-update-status.json"); Destination = "diagnostics\lan-remote-update-status.json" },
    @{ Source = (Join-Path $UserDataDir "diagnostics\lan-remote-update.log"); Destination = "diagnostics\lan-remote-update.log" },
    @{ Source = (Join-Path $UserDataDir "logs\codex-web-live.ndjson"); Destination = "logs\codex-web-live.ndjson" }
)

$uiFreezeDir = Join-Path $UserDataDir "diagnostics"
if (Test-Path -LiteralPath $uiFreezeDir) {
    Get-ChildItem -LiteralPath $uiFreezeDir -Filter "ui-freeze-*.json" -File -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTimeUtc -Descending |
        Select-Object -First 10 |
        ForEach-Object {
            $filesToCopy += @{
                Source = $_.FullName
                Destination = ("diagnostics\" + $_.Name)
            }
        }
}

foreach ($file in $filesToCopy) {
    $copied = Copy-IfExists -Source $file.Source -Destination (Join-Path $OutDir $file.Destination)
    $summary.files[$file.Destination] = if ($copied) { "copied" } else { "missing" }
}

Write-JsonFile -Path (Join-Path $OutDir "summary.json") -Value $summary

Write-Host "Debug dump written to: $OutDir"
