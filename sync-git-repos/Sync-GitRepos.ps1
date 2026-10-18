<#
.SYNOPSIS
  Brings all Git repos under a root folder up to date with their default branch.

.DESCRIPTION
  Walks the folder tree recursively (stops descending at each repo, ignores
  node_modules and hidden folders). For each repo found:
    - silently skips it if its .git folder is not fully local (OneDrive online-only)
    - git fetch --prune
    - detects the repo's actual default branch (via origin/HEAD, not a hardcoded main/master guess)
    - skips repos with uncommitted changes (nothing is ever overwritten)
    - checks out the default branch (only if clean) and pulls via --ff-only
    - deletes local branches that are already fully merged into the default branch
    - reports repos with no default branch detected or with diverged history

  Every repo gets one result line (Updated / Current / Skipped / Failed). After
  all repos are done, the repos that were updated and already had node_modules
  are offered for npm install in one list (npm ci if a package-lock.json is
  present), then a summary shows the counts and what needs attention.

.PARAMETER Root
  Folder to search for repos. Default: current folder.

.PARAMETER InstallDeps
  Controls npm install after the sync, so node_modules matches the newly
  pulled package.json/lockfile. Only relevant for repos that were updated and
  already had node_modules.
  Omitted: pick the repos in an interactive list after the sync.
  $true: install for every relevant repo, no list.
  $false: never install, no list.

.PARAMETER MaxDepth
  How many folder levels below Root to search for repos (1 = direct subfolders
  only). Default: unlimited.

.EXAMPLE
  Sync-GitRepos.ps1
  Sync-GitRepos.ps1 C:\Projects -InstallDeps:$true
  Sync-GitRepos.ps1 C:\Projects -InstallDeps:$false -MaxDepth 2
#>

param(
    [string]$Root = (Get-Location).Path,
    [Nullable[bool]]$InstallDeps = $null,
    [int]$MaxDepth = [int]::MaxValue
)

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

. (Join-Path $PSScriptRoot '..\lib\Select-ConsoleItem.ps1')

$rootFull = (Resolve-Path $Root).Path.TrimEnd('\', '/')

$results = [System.Collections.Generic.List[object]]::new()
$npmCandidates = [ordered]@{}
$offlineCount = 0

function Get-RelativeName {
    param([string]$FullPath)
    return $FullPath.Substring($rootFull.Length).TrimStart('\', '/')
}

# One output line: "Label:     name  (detail)", the whole line in one color.
function Write-Result {
    param([string]$Label, [string]$Name, [string]$Detail, [string]$Color)
    $text = '{0,-11} {1}' -f "${Label}:", $Name
    if ($Detail) { $text += "  ($Detail)" }
    Write-Host $text -ForegroundColor $Color
}

# Records the outcome of a repo for the summary and prints its result line.
function Add-Result {
    param([ValidateSet('Updated', 'Current', 'Skipped', 'Failed')][string]$State, [string]$Name, [string]$Detail)
    $color = @{ Updated = 'Green'; Current = 'DarkGray'; Skipped = 'Yellow'; Failed = 'Red' }[$State]
    $results.Add([pscustomobject]@{ State = $State; Name = $Name; Detail = $Detail; Color = $color })
    Write-Result $State $Name $Detail $color
}

function Test-CloudOnly {
    param([System.IO.FileSystemInfo]$Item)
    # Offline | RecallOnOpen | RecallOnDataAccess: OneDrive placeholder, content not local
    return ([int]$Item.Attributes -band (0x1000 -bor 0x40000 -bor 0x400000)) -ne 0
}

function Test-GitDirLocal {
    param([string]$RepoPath)

    # $true if .git is fully available locally (nothing in it is an OneDrive online-only placeholder).
    $gitItem = Get-Item -LiteralPath (Join-Path $RepoPath ".git") -Force
    if (Test-CloudOnly $gitItem) { return $false }
    if ($gitItem -isnot [System.IO.DirectoryInfo]) { return $true }

    $stack = New-Object System.Collections.Generic.Stack[System.IO.DirectoryInfo]
    $stack.Push($gitItem)
    while ($stack.Count -gt 0) {
        $dir = $stack.Pop()
        try { $items = @($dir.EnumerateFileSystemInfos()) } catch { continue }
        foreach ($item in $items) {
            if (Test-CloudOnly $item) { return $false }
            if ($item -is [System.IO.DirectoryInfo]) { $stack.Push($item) }
        }
    }
    return $true
}

function Find-Repos {
    param([string]$Path, [int]$Depth)

    foreach ($d in Get-ChildItem -Path $Path -Directory -ErrorAction SilentlyContinue) {
        if ($d.Name -eq 'node_modules') { continue }

        if (Test-CloudOnly $d) {
            continue
        }

        if (Test-Path (Join-Path $d.FullName ".git")) {
            $d
        }
        elseif ($Depth -gt 1) {
            Find-Repos -Path $d.FullName -Depth ($Depth - 1)
        }
    }
}

function Get-DefaultBranch {
    $ref = git symbolic-ref refs/remotes/origin/HEAD 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $ref) {
        git remote set-head origin -a --quiet 2>$null
        $ref = git symbolic-ref refs/remotes/origin/HEAD 2>$null
    }
    if ($LASTEXITCODE -eq 0 -and $ref) {
        return ($ref -replace '^refs/remotes/origin/', '')
    }

    foreach ($candidate in @("main", "master")) {
        git show-ref --verify --quiet "refs/heads/$candidate" 2>$null
        if ($LASTEXITCODE -eq 0) { return $candidate }
    }
    return $null
}

# The lines shown next to the npm install list: what changed in package.json / the lockfile.
function Get-NpmPreview {
    param([string]$Name)
    $c = $npmCandidates[$Name]
    $diff = @(git -C $c.Path diff --stat $c.Before $c.After -- package.json package-lock.json 2>$null)
    if ($diff.Count -eq 0) { return 'package.json and lockfile unchanged' }
    $diff | ForEach-Object { $_.Trim() }
}

function Invoke-NpmInstall {
    param([string]$Name, [string]$Path)

    $cmd = if (Test-Path (Join-Path $Path "package-lock.json")) { 'npm ci' } else { 'npm install' }
    Write-Result 'Installing' $Name $cmd 'Cyan'

    Push-Location $Path
    try {
        if ($cmd -eq 'npm ci') { npm ci --silent 2>$null | Out-Null }
        else { npm install --silent 2>$null | Out-Null }
        $ok = $LASTEXITCODE -eq 0
    }
    finally {
        Pop-Location
    }

    if ($ok) { Write-Result 'Installed' $Name '' 'Green' }
    else { Add-Result 'Failed' $Name "$cmd failed" }
}

$repos = @(Find-Repos -Path $rootFull -Depth $MaxDepth)

if ($repos.Count -eq 0) {
    Write-Host "No git repos found under $rootFull." -ForegroundColor Yellow
    exit 0
}

Write-Host ''
Write-Host "Syncing $($repos.Count) $(if ($repos.Count -eq 1) { 'repo' } else { 'repos' }) under ${rootFull}:" -ForegroundColor Cyan
Write-Host ''

foreach ($d in $repos) {
    $name = Get-RelativeName $d.FullName
    $path = $d.FullName

    # .git not (fully) local: skip silently, nothing gets downloaded.
    if (-not (Test-GitDirLocal -RepoPath $path)) { $offlineCount++; continue }

    Push-Location $path
    try {
        git fetch --quiet --prune 2>$null
        if ($LASTEXITCODE -ne 0) {
            Add-Result 'Failed' $name 'git fetch failed, offline or auth issue?'
            continue
        }

        $branch = git rev-parse --abbrev-ref HEAD 2>$null
        $status = git status --porcelain 2>$null

        $defaultBranch = Get-DefaultBranch

        if (-not $defaultBranch) {
            Add-Result 'Skipped' $name "no default branch detected, currently on '$branch'"
            continue
        }

        if ($status) {
            Add-Result 'Skipped' $name "uncommitted changes on '$branch'"
            continue
        }

        $switchedFrom = $null
        if ($branch -ne $defaultBranch) {
            git checkout $defaultBranch --quiet 2>$null
            if ($LASTEXITCODE -ne 0) {
                Add-Result 'Failed' $name "could not check out '$defaultBranch'"
                continue
            }
            $switchedFrom = $branch
        }

        $hadNodeModules = Test-Path (Join-Path $path "node_modules")

        $before = git rev-parse HEAD
        git pull --ff-only --quiet 2>$null
        $pullExit = $LASTEXITCODE
        $after = git rev-parse HEAD

        $switchNote = if ($switchedFrom) { ", was on '$switchedFrom'" } else { '' }

        if ($pullExit -ne 0) {
            Add-Result 'Failed' $name "pull failed on '$defaultBranch', diverged? check manually$switchNote"
        }
        elseif ($before -ne $after) {
            Add-Result 'Updated' $name "$($before.Substring(0,7)) -> $($after.Substring(0,7))$switchNote"
            if ($hadNodeModules -and (Test-Path (Join-Path $path "package.json"))) {
                $npmCandidates[$name] = @{ Path = $path; Before = $before; After = $after }
            }
        }
        else {
            Add-Result 'Current' $name "on '$defaultBranch'$switchNote"
        }

        $mergedBranches = git branch --merged $defaultBranch 2>$null |
            ForEach-Object { $_.Trim().TrimStart('* ').Trim() } |
            Where-Object { $_ -and $_ -ne $defaultBranch }

        foreach ($b in $mergedBranches) {
            git branch -d $b --quiet 2>$null
            if ($LASTEXITCODE -eq 0) {
                Write-Result 'Cleaned' $name "deleted merged branch '$b'" 'DarkCyan'
            }
        }
    }
    finally {
        Pop-Location
    }
}

# npm install for the repos that were updated and already had node_modules.
$toInstall = @()
if ($npmCandidates.Count -gt 0) {
    if ($InstallDeps -eq $true) {
        $toInstall = @($npmCandidates.Keys)
    }
    elseif ($null -eq $InstallDeps) {
        Write-Host ''
        if ([Console]::IsInputRedirected -or [Console]::IsOutputRedirected) {
            Write-Host 'npm install skipped, no interactive console.' -ForegroundColor DarkGray
        }
        else {
            $pick = Select-ConsoleItem -Items @($npmCandidates.Keys) -Tree `
                -Title "npm install: updated repos with node_modules ($($npmCandidates.Count))" `
                -Preview ${function:Get-NpmPreview}
            if ($pick.Cancelled -or $pick.Items.Count -eq 0) {
                Write-Host 'npm install skipped.' -ForegroundColor DarkGray
            }
            else {
                $toInstall = @($pick.Items)
            }
        }
    }
}

if ($toInstall.Count -gt 0) {
    Write-Host ''
    foreach ($n in $toInstall) {
        Invoke-NpmInstall -Name $n -Path $npmCandidates[$n].Path
    }
}

# Summary
function Get-Count([string]$State) { @($results | Where-Object { $_.State -eq $State }).Count }

$failed = Get-Count 'Failed'
$skipped = Get-Count 'Skipped'
$summary = "Updated: $(Get-Count 'Updated'), current: $(Get-Count 'Current'), skipped: $skipped, failed: $failed"
if ($offlineCount -gt 0) { $summary += ", online-only: $offlineCount" }
$summaryColor = if ($failed) { 'Red' } elseif ($skipped) { 'Yellow' } else { 'Green' }

Write-Host ''
Write-Host $summary -ForegroundColor $summaryColor

$attention = @($results | Where-Object { $_.State -in 'Skipped', 'Failed' })
if ($attention.Count -gt 0) {
    Write-Host ''
    Write-Host 'Needs attention:' -ForegroundColor Yellow
    foreach ($r in $attention) {
        Write-Host "  $($r.Name)  ($($r.Detail))" -ForegroundColor $r.Color
    }
}
