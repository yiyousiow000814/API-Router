param()

$ErrorActionPreference = 'Stop'

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$RemoteUpdateScript = Join-Path $RepoRoot 'src-tauri\src\lan_sync\remote_update\lan-remote-update.ps1'
if (-not (Test-Path -LiteralPath $RemoteUpdateScript)) {
  throw "Missing remote update script: $RemoteUpdateScript"
}
$BuildRootExeScript = Join-Path $RepoRoot 'tools\build\build-root-exe.ps1'
if (-not (Test-Path -LiteralPath $BuildRootExeScript)) {
  throw "Missing build script: $BuildRootExeScript"
}

function Get-FunctionBlock {
  param(
    [Parameter(Mandatory = $true)]
    [AllowEmptyString()]
    [string[]]$Content,
    [Parameter(Mandatory = $true)]
    [string]$Name,
    [switch]$Optional
  )

  $start = -1
  for ($index = 0; $index -lt $Content.Count; $index++) {
    if ($Content[$index] -match "^\s*function\s+$([Regex]::Escape($Name))\s*\{") {
      $start = $index
      break
    }
  }

  if ($start -lt 0) {
    if ($Optional) { return @() }
    throw "Could not find function $Name in script content"
  }

  $depth = 0
  $block = New-Object System.Collections.Generic.List[string]
  for ($index = $start; $index -lt $Content.Count; $index++) {
    $line = $Content[$index]
    $block.Add($line)
    $depth += ([regex]::Matches($line, '\{')).Count
    $depth -= ([regex]::Matches($line, '\}')).Count
    if ($depth -eq 0) { return $block.ToArray() }
  }

  throw "Could not parse complete function $Name from script content"
}

function Assert-RemoteUpdateLogWriterHandlesLockedFile {
  param(
    [Parameter(Mandatory = $true)]
    [string]$ScriptPath,
    [Parameter(Mandatory = $true)]
    [string[]]$FunctionNames,
    [Parameter(Mandatory = $true)]
    [string]$TempRoot,
    [Parameter(Mandatory = $true)]
    [string]$ExpectedUnlockedText
  )

  $content = Get-Content -LiteralPath $ScriptPath
  $functions = @()
  Remove-Item Function:\Get-RemoteUpdateLogPath -ErrorAction SilentlyContinue
  Remove-Item Function:\Get-BuildLogPath -ErrorAction SilentlyContinue
  Remove-Item Function:\Add-RemoteUpdateLogLine -ErrorAction SilentlyContinue
  Remove-Item Function:\Write-RemoteUpdateLog -ErrorAction SilentlyContinue
  foreach ($name in $FunctionNames) {
    $functions += Get-FunctionBlock -Content $content -Name $name -Optional:($name -eq 'Add-RemoteUpdateLogLine')
  }
  $functionText = $functions -join "`n"

  $logPath = Join-Path $TempRoot 'diagnostics\lan-remote-update.log'
  Remove-Item -LiteralPath $TempRoot -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $logPath) | Out-Null
  Set-Content -LiteralPath $logPath -Encoding UTF8 -Value 'locked log'

  $env:API_ROUTER_REMOTE_UPDATE_LOG_PATH = $logPath
  $env:API_ROUTER_USER_DATA_DIR = $TempRoot

  $lockStream = [System.IO.File]::Open(
    $logPath,
    [System.IO.FileMode]::Open,
    [System.IO.FileAccess]::ReadWrite,
    [System.IO.FileShare]::None
  )
  try {
    try {
      & ([scriptblock]::Create($functionText + "`nWrite-RemoteUpdateLog 'log attempt while another process owns the file'"))
    } catch {
      throw "Expected remote update logging in $ScriptPath to be non-fatal while the log file is locked, but it threw: $($_.Exception.Message)"
    }
  } finally {
    $lockStream.Dispose()
  }

  $escapedText = $ExpectedUnlockedText -replace "'", "''"
  & ([scriptblock]::Create($functionText + "`nWrite-RemoteUpdateLog '$escapedText'"))
  $log = Get-Content -LiteralPath $logPath -Raw
  if ($log -notmatch [Regex]::Escape($ExpectedUnlockedText)) {
    throw "Expected remote update logging in $ScriptPath to append after the lock is released.`n$log"
  }

  return $logPath
}

$workerLogPath = Assert-RemoteUpdateLogWriterHandlesLockedFile `
  -ScriptPath $RemoteUpdateScript `
  -FunctionNames @('Get-RemoteUpdateLogPath', 'Add-RemoteUpdateLogLine', 'Write-RemoteUpdateLog') `
  -TempRoot (Join-Path $RepoRoot 'user-data\tmp\remote-update-log-lock\worker') `
  -ExpectedUnlockedText 'worker log attempt after lock release'

$buildLogPath = Assert-RemoteUpdateLogWriterHandlesLockedFile `
  -ScriptPath $BuildRootExeScript `
  -FunctionNames @('Get-RemoteUpdateLogPath', 'Get-BuildLogPath', 'Add-RemoteUpdateLogLine', 'Write-RemoteUpdateLog') `
  -TempRoot (Join-Path $RepoRoot 'user-data\tmp\remote-update-log-lock\build') `
  -ExpectedUnlockedText 'build log attempt after lock release'

Write-Host '[remote-update-log-lock.e2e] PASS'
Write-Host "Worker diagnostics: $workerLogPath"
Write-Host "Build diagnostics: $buildLogPath"
