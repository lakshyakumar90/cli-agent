# Verify that every commit of the phase stands on its own.
#
# For each commit: a fresh worktree, a fresh install, the types, the
# tests and the build. A commit that does not pass is a broken step.

param(
  [string]$Commits
)

$ErrorActionPreference = "Continue"
$root = "C:\Lakshya\cli-agent"
$work = "C:\Lakshya\cli-agent-verify"

# The list may arrive as one comma-separated string or as an array.
$list = @()
foreach ($item in $Commits) {
  foreach ($part in ($item -split ",")) {
    $part = $part.Trim()
    if ($part.Length -gt 0) { $list += $part }
  }
}

if (Test-Path $work) {
  # A worktree that is still registered has to go through git first: the
  # files in it are held open by the tools that were running in it.
  & git -C $root worktree prune
  Get-ChildItem $work -Directory -ErrorAction SilentlyContinue | ForEach-Object {
    & git -C $root worktree remove --force $_.FullName 2>&1 | Out-Null
  }
  & git -C $root worktree prune
  Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
}
New-Item -ItemType Directory -Path $work -Force | Out-Null

$results = @()

foreach ($commit in $list) {
  $short = $commit.Substring(0, 7)
  $dir = Join-Path $work $short
  Write-Output "=== $short ==="

  & git -C $root worktree add --detach $dir $commit 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) {
    $results += "$short WORKTREE-FAILED"
    Write-Output "$short WORKTREE-FAILED"
    continue
  }

  Push-Location $dir
  $ok = $true
  $why = ""
  $log = Join-Path $work "$short.log"

  & pnpm install --prefer-offline --ignore-scripts *> $log
  if ($LASTEXITCODE -ne 0) { $ok = $false; $why = "install" }

  if ($ok) {
    & pnpm check-types *>> $log
    if ($LASTEXITCODE -ne 0) { $ok = $false; $why = "types" }
  }

  if ($ok) {
    & pnpm test *>> $log
    if ($LASTEXITCODE -ne 0) { $ok = $false; $why = "test" }
  }

  if ($ok) {
    & pnpm build *>> $log
    if ($LASTEXITCODE -ne 0) { $ok = $false; $why = "build" }
  }

  Pop-Location

  & git -C $root worktree remove --force $dir 2>&1 | Out-Null

  if ($ok) {
    $results += "$short OK"
    Write-Output "$short OK"
    Remove-Item $log -Force -ErrorAction SilentlyContinue
  } else {
    $results += "$short FAILED ($why)"
    Write-Output "$short FAILED ($why) - the log is in $log"
  }
}

Write-Output ""
Write-Output "=== the summary ==="
$results | ForEach-Object { Write-Output $_ }
