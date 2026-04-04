param(
  [Parameter(Mandatory = $true)]
  [string]$TargetRef
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Assert-CleanWorktree {
  $statusLines = & git status --porcelain=v1
  if ($LASTEXITCODE -ne 0) {
    throw 'git status failed'
  }
  if ($statusLines) {
    throw 'worktree is dirty; refusing remote self-update'
  }
}

function Resolve-CheckoutTarget([string]$Ref) {
  & git rev-parse --verify "refs/heads/$Ref" *> $null
  if ($LASTEXITCODE -eq 0) { return @{ Mode = 'local_branch'; Value = $Ref } }

  & git rev-parse --verify "refs/remotes/origin/$Ref" *> $null
  if ($LASTEXITCODE -eq 0) { return @{ Mode = 'remote_branch'; Value = $Ref } }

  & git rev-parse --verify $Ref *> $null
  if ($LASTEXITCODE -eq 0) { return @{ Mode = 'detached'; Value = $Ref } }

  throw "cannot resolve git ref: $Ref"
}

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $RepoRoot

Start-Sleep -Seconds 1

Assert-CleanWorktree

& git fetch origin --prune --tags
if ($LASTEXITCODE -ne 0) {
  throw 'git fetch failed'
}

$target = Resolve-CheckoutTarget $TargetRef
if ($target.Mode -eq 'local_branch') {
  & git checkout $target.Value
  if ($LASTEXITCODE -ne 0) { throw "git checkout failed: $($target.Value)" }
  & git pull --ff-only origin $target.Value
  if ($LASTEXITCODE -ne 0) { throw "git pull failed: $($target.Value)" }
} elseif ($target.Mode -eq 'remote_branch') {
  & git checkout -B $target.Value "refs/remotes/origin/$($target.Value)"
  if ($LASTEXITCODE -ne 0) { throw "git checkout -B failed: $($target.Value)" }
} else {
  & git checkout --detach $target.Value
  if ($LASTEXITCODE -ne 0) { throw "git checkout --detach failed: $($target.Value)" }
}

& npm.cmd run build:root-exe:checked
if ($LASTEXITCODE -ne 0) {
  throw 'npm run build:root-exe:checked failed'
}
