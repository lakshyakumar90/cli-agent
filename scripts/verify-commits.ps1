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

if (Test-Path $work) { Remove-Item $work -Recurse -Force }
New-Item -ItemType Directory -Path $work | Out-Null

$results = @()

foreach ($commit in $list) {
  $short = $commit.Substring(0, 7)
  $dir = Join-Path $work $short
  Write-Output "=== $short ==="

  & git -C $root worktree add --detach $dir $commit 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) {
    $results += "$short WORKTREE-FAILED"
    continue
  }

  Push-Location $dir
  $ok = $true
  $why = ""

  & pnpm install --prefer-offline --ignore-scripts 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { $ok = $false; $why = "install" }

  if ($ok) {
    & pnpm check-types 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { $ok = $false; $why = "types" }
  }

  if ($ok) {
    & pnpm test 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { $ok = $false; $why = "test" }
  }

  if ($ok) {
    & pnpm build 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { $ok = $false; $why = "build" }
  }

  Pop-Location

  & git -C $root worktree remove --force $dir 2>&1 | Out-Null

  if ($ok) {
    $results += "$short OK"
    Write-Output "$short OK"
  } else {
    $results += "$short FAILED ($why)"
    Write-Output "$short FAILED ($why)"
  }
}

Write-Output ""
Write-Output "=== the summary ==="
$results | ForEach-Object { Write-Output $_ }
