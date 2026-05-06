$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$vendorRoot = Join-Path $repoRoot 'third_party\codex-web'
$sourceUrl = 'https://github.com/0xcaff/codex-web.git'
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('api-router-codex-web-' + [System.Guid]::NewGuid().ToString('N'))

if (Test-Path $tempRoot) {
  Remove-Item -LiteralPath $tempRoot -Recurse -Force
}

New-Item -ItemType Directory -Path $tempRoot | Out-Null

try {
  git clone --depth 1 $sourceUrl $tempRoot | Out-Host
  $commit = (git -C $tempRoot rev-parse HEAD).Trim()

  if (Test-Path $vendorRoot) {
    Remove-Item -LiteralPath $vendorRoot -Recurse -Force
  }

  New-Item -ItemType Directory -Path (Split-Path -Parent $vendorRoot) -Force | Out-Null
  Copy-Item -LiteralPath $tempRoot -Destination $vendorRoot -Recurse -Force

  $gitDir = Join-Path $vendorRoot '.git'
  if (Test-Path $gitDir) {
    Remove-Item -LiteralPath $gitDir -Recurse -Force
  }

  $metadata = [ordered]@{
    name = 'codex-web'
    source = 'https://github.com/0xcaff/codex-web'
    commit = $commit
    cloned_at = (Get-Date).ToString('dd-MM-yyyy')
    notes = @(
      'Vendored upstream copy. Keep changes here minimal and patch-oriented.'
      'Upstream currently prepares browser assets from a hosted macOS Codex Desktop zip.'
    )
  } | ConvertTo-Json -Depth 4

  Set-Content -LiteralPath (Join-Path $vendorRoot '.api-router-vendor.json') -Value $metadata -Encoding utf8NoBOM
  Write-Host "Synced third_party/codex-web at $commit"
}
finally {
  if (Test-Path $tempRoot) {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force
  }
}
