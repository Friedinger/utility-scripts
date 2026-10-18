<#
.SYNOPSIS
  Brings all Git repos under a root folder up to date with their default branch.

.DESCRIPTION
  Walks the folder tree recursively (stops descending at each repo, ignores
  node_modules and hidden folders) and works in three steps.

  1. Sync, without any questions. For each repo:
       - silently skips it if its .git folder is not fully local (OneDrive online-only)
       - git fetch --prune
       - detects the repo's actual default branch (via origin/HEAD, not a hardcoded main/master guess)
       - fast-forwards the default branch. If another branch is checked out, the
         default branch is updated without switching (git fetch origin main:main).
         Local changes are kept; they only matter when they touch files the
         update changes.
       - deletes local branches that are already fully merged (git branch -d)
     Every repo gets one result line: Updated / Current / Skipped / Failed.

  2. Review. Everything that needs a decision is collected into ONE list
     (a folder tree, grouped by repo), with sensible entries already marked:
       - delete branches whose changes are already in the default branch
         (squash/rebase merged) or whose upstream is gone
       - switch from the current branch to the default branch (marked when the
         current branch is done, also deleting it)
       - reset a diverged default branch to origin, after creating a backup branch
       - stash local changes, update, restore them (when they touch incoming files)
       - npm install for updated repos that already had node_modules
     Nothing in the list happens unless it is marked, and risky entries are red
     and never pre-marked.

  3. The marked entries run, then a summary shows the counts and what still
     needs attention.

.PARAMETER Root
  Folder to search for repos. Default: current folder.

.PARAMETER Cleanup
  Controls the branch entries (delete, switch, reset, stash and update).
  Omitted: decide in the review list.
  $true: do exactly the entries that would be pre-marked, without the list.
  $false: none of these, nothing is shown.

.PARAMETER InstallDeps
  Controls npm install (npm ci if a package-lock.json is present) for repos
  that were updated and already had node_modules.
  Omitted: decide in the review list.
  $true: install for every such repo, no questions.
  $false: never install, nothing is shown.

.PARAMETER MaxDepth
  How many folder levels below Root to search for repos (1 = direct subfolders
  only). Default: unlimited.

.EXAMPLE
  Sync-GitRepos.ps1
  Sync-GitRepos.ps1 C:\Projects -InstallDeps:$true -Cleanup:$false
  Sync-GitRepos.ps1 C:\Projects -InstallDeps:$false -MaxDepth 2
#>

param(
    [string]$Root = (Get-Location).Path,
    [Nullable[bool]]$InstallDeps = $null,
    [Nullable[bool]]$Cleanup = $null,
    [int]$MaxDepth = [int]::MaxValue
)

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

. (Join-Path $PSScriptRoot '..\lib\Select-ConsoleItem.ps1')

$rootFull = (Resolve-Path $Root).Path.TrimEnd('\', '/')

$results = [System.Collections.Generic.List[object]]::new()
$reviewItems = [System.Collections.Generic.List[object]]::new()
$repoOrder = @{}
$counts = @{ Cleaned = 0; Reset = 0; Switched = 0 }
$offlineCount = 0
$lastResult = $null
$reviewHint = if ($Cleanup -eq $false) { '' } else { ', see review' }

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
    $script:lastResult = [pscustomobject]@{ State = $State; Name = $Name; Detail = $Detail; Color = $color }
    $results.Add($script:lastResult)
    Write-Result $(if ($State -eq 'Current') { 'Up to date' } else { $State }) $Name $Detail $color
}

function Get-Plural {
    param([int]$Count, [string]$Word)
    return "$Count $Word$(if ($Count -ne 1) { 's' })"
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

# Files with local changes: modified, staged and untracked (repo-relative, forward slashes).
function Get-LocalChanges {
    $files = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($f in @(git -c core.quotepath=false diff --name-only 2>$null)) { if ($f) { [void]$files.Add($f) } }
    foreach ($f in @(git -c core.quotepath=false diff --name-only --cached 2>$null)) { if ($f) { [void]$files.Add($f) } }
    foreach ($f in @(git -c core.quotepath=false ls-files --others --exclude-standard 2>$null)) { if ($f) { [void]$files.Add($f) } }
    return @($files)
}

# $true if merging the branch into the default branch would change nothing, i.e.
# its changes are already there (squash or rebase merged). Needs git 2.38+.
function Test-ContentInDefault {
    param([string]$Branch, [string]$DefaultBranch)
    $merged = @(git merge-tree --write-tree $DefaultBranch $Branch 2>$null)
    if ($LASTEXITCODE -ne 0 -or $merged.Count -eq 0) { return $false }
    $defaultTree = git rev-parse "${DefaultBranch}^{tree}" 2>$null
    return $merged[0] -eq $defaultTree
}

function Get-WorktreeBranches {
    @(git worktree list --porcelain 2>$null | ForEach-Object {
        if ($_ -match '^branch refs/heads/(.+)$') { $Matches[1] }
    })
}

# Runs git directly on the console (so its pager works), for the full-diff key.
function Show-GitPager {
    param([string]$RepoPath, [string[]]$GitArgs)
    $quoted = @('-C', $RepoPath) + $GitArgs | ForEach-Object { '"{0}"' -f $_ }
    Start-Process -FilePath git -ArgumentList $quoted -NoNewWindow -Wait
}

# Review list: one entry per decision.
function New-ReviewItem {
    param(
        [string]$Kind, [string]$Repo, [string]$RepoPath, [string]$Label,
        [bool]$Marked = $false, [bool]$Flagged = $false, [hashtable]$Data = @{}
    )
    $reviewItems.Add([pscustomobject]@{
        Kind = $Kind; Repo = $Repo; RepoPath = $RepoPath
        Class = $(if ($Kind -eq 'Npm') { 'npm' } else { 'cleanup' })
        Text = "${Repo}: $Label"; Label = $Label; Path = @($Repo -split '[\\/]' | Where-Object { $_ })
        Marked = $Marked; Flagged = $Flagged; Data = $Data
    })
}

# The lines shown below the review list.
function Get-ReviewPreview {
    param($Item)
    $p = $Item.RepoPath
    $d = $Item.Data
    switch ($Item.Kind) {
        'Stash' {
            "Local changes in files that the update touches: $($d.Overlap -join ', ')"
            git -C $p diff --stat HEAD -- $d.Overlap 2>$null | ForEach-Object { $_.Trim() }
        }
        'Reset' {
            "Local commits on '$($d.Default)' that origin does not have (kept in the backup branch):"
            git -C $p log --oneline -n 4 "origin/$($d.Default)..$($d.Default)" 2>$null | ForEach-Object { "  $_" }
        }
        'Delete' {
            if ($d.InDefault) { "No changes compared to '$($d.Default)', everything is already in it." }
            else { "Commits only on this branch, not in '$($d.Default)':" }
            if (-not $d.InDefault) { git -C $p log --oneline -n 4 "$($d.Default)..$($d.Branch)" 2>$null | ForEach-Object { "  $_" } }
            "Last commit: $(git -C $p log -1 --format='%cr, %s' $d.Branch 2>$null)"
        }
        'Switch' {
            "Currently on '$($d.Branch)'."
            if ($d.DeleteBranch) { "The branch is done and gets deleted after the switch." }
            else { "The branch is kept; it still has work that is not in '$($d.Default)'." }
        }
        'Npm' {
            $diff = @(git -C $p diff --stat $d.Before $d.After -- package.json package-lock.json 2>$null)
            if ($diff.Count -eq 0) { 'package.json and lockfile unchanged' }
            else { $diff | ForEach-Object { $_.Trim() } }
        }
    }
}

# The full diff for the v key, in git's pager.
function Show-ReviewDiff {
    param($Item)
    $p = $Item.RepoPath
    $d = $Item.Data
    switch ($Item.Kind) {
        'Stash'  { Show-GitPager $p (@('diff', 'HEAD', '--') + $d.Overlap) }
        'Reset'  { Show-GitPager $p @('log', '--stat', "origin/$($d.Default)..$($d.Default)") }
        'Delete' { Show-GitPager $p @('log', '-p', "$($d.Default)..$($d.Branch)") }
        'Switch' { Show-GitPager $p @('log', '-p', "$($d.Default)..$($d.Branch)") }
        'Npm'    { Show-GitPager $p @('diff', $d.Before, $d.After, '--', 'package.json', 'package-lock.json') }
    }
}

function Remove-Branch {
    param([string]$Name, [string]$Repo, [string]$Branch, [string]$Mode)
    $sha = git rev-parse --short $Branch 2>$null
    git branch $Mode $Branch --quiet 2>$null
    if ($LASTEXITCODE -eq 0) {
        $counts.Cleaned++
        Write-Result 'Cleaned' $Name "deleted '$Branch', was $sha" 'DarkCyan'
        return $true
    }
    Add-Result 'Failed' $Name "could not delete '$Branch'"
    return $false
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

# Runs one marked review entry.
function Invoke-ReviewItem {
    param($Item)
    $name = $Item.Repo
    $d = $Item.Data

    if ($Item.Kind -eq 'Npm') {
        Invoke-NpmInstall -Name $name -Path $Item.RepoPath
        return
    }

    Push-Location $Item.RepoPath
    try {
        switch ($Item.Kind) {
            'Stash' {
                git stash push -u -m "sync-git-repos $(Get-Date -Format 'yyyy-MM-dd HH:mm')" --quiet 2>$null
                if ($LASTEXITCODE -ne 0) { Add-Result 'Failed' $name 'could not stash local changes'; return }
                $before = git rev-parse --short HEAD
                git merge --ff-only "origin/$($d.Default)" --quiet 2>$null
                $mergeOk = $LASTEXITCODE -eq 0
                git stash pop --quiet 2>$null
                $popOk = $LASTEXITCODE -eq 0
                if (-not $mergeOk) {
                    Add-Result 'Failed' $name $(if ($popOk) { "could not update '$($d.Default)', local changes restored" } else { "could not update, local changes are in 'git stash list'" })
                }
                elseif (-not $popOk) {
                    Add-Result 'Failed' $name "updated, but restoring local changes conflicted, they are in 'git stash list'"
                }
                else {
                    $results.Remove($d.Record) | Out-Null
                    Add-Result 'Updated' $name "$before -> $(git rev-parse --short HEAD), local changes restored"
                }
            }
            'Reset' {
                $backup = "backup/$($d.Default)-$(Get-Date -Format 'yyyy-MM-dd')"
                git show-ref --verify --quiet "refs/heads/$backup" 2>$null
                if ($LASTEXITCODE -eq 0) { $backup += "-$(Get-Date -Format 'HHmmss')" }
                $old = git rev-parse --short $d.Default
                git branch $backup $d.Default --quiet 2>$null
                if ($LASTEXITCODE -ne 0) { Add-Result 'Failed' $name 'could not create the backup branch, nothing was reset'; return }
                if ($d.OnDefault) { git reset --hard "origin/$($d.Default)" --quiet 2>$null }
                else { git branch -f $d.Default "origin/$($d.Default)" --quiet 2>$null }
                if ($LASTEXITCODE -ne 0) { Add-Result 'Failed' $name "reset of '$($d.Default)' failed, backup is '$backup'"; return }
                $counts.Reset++
                $results.Remove($d.Record) | Out-Null
                Write-Result 'Reset' $name "'$($d.Default)' $old -> $(git rev-parse --short $d.Default), backup: $backup" 'Cyan'
                Add-Result 'Updated' $name "'$($d.Default)' matches origin again"
            }
            'Switch' {
                git checkout $d.Default --quiet 2>$null
                if ($LASTEXITCODE -ne 0) { Add-Result 'Failed' $name "could not switch to '$($d.Default)'"; return }
                $counts.Switched++
                Write-Result 'Switched' $name "'$($d.Branch)' -> '$($d.Default)'" 'Cyan'
                if ($d.DeleteBranch) { [void](Remove-Branch -Name $name -Repo $name -Branch $d.Branch -Mode '-D') }
            }
            'Delete' {
                [void](Remove-Branch -Name $name -Repo $name -Branch $d.Branch -Mode '-D')
            }
        }
    }
    finally {
        Pop-Location
    }
}

$repos = @(Find-Repos -Path $rootFull -Depth $MaxDepth)

if ($repos.Count -eq 0) {
    Write-Host "No git repos found under $rootFull." -ForegroundColor Yellow
    exit 0
}

Write-Host ''
Write-Host "Syncing $($repos.Count) $(if ($repos.Count -eq 1) { 'repo' } else { 'repos' }) under ${rootFull}:" -ForegroundColor Cyan
Write-Host ''

# Step 1: sync, no questions.
foreach ($d in $repos) {
    $name = Get-RelativeName $d.FullName
    $path = $d.FullName
    $repoOrder[$name] = $repoOrder.Count

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
        $defaultBranch = Get-DefaultBranch

        if (-not $defaultBranch) {
            Add-Result 'Skipped' $name "no default branch detected, currently on '$branch'"
            continue
        }

        $remoteRef = "origin/$defaultBranch"
        git rev-parse --verify --quiet "refs/remotes/$remoteRef" 2>$null | Out-Null
        if ($LASTEXITCODE -ne 0) {
            Add-Result 'Skipped' $name "'$remoteRef' not found"
            continue
        }

        $onDefault = $branch -eq $defaultBranch
        $localChanges = @(Get-LocalChanges)
        $hadNodeModules = Test-Path (Join-Path $path "node_modules")

        git show-ref --verify --quiet "refs/heads/$defaultBranch" 2>$null
        $hasLocalDefault = $LASTEXITCODE -eq 0
        $ahead = 0
        $behind = 1
        if ($hasLocalDefault) {
            $lr = (git rev-list --left-right --count "$defaultBranch...$remoteRef") -split '\s+'
            $ahead = [int]$lr[0]
            $behind = [int]$lr[1]
        }
        $before = if ($hasLocalDefault) { git rev-parse $defaultBranch } else { $null }
        $where = if ($onDefault) { '' } else { ", on '$branch'" }
        $updatedDefault = $false

        if ($ahead -gt 0 -and $behind -gt 0) {
            # Diverged: only a reset can fix it, and that is a decision for the review list.
            $detail = "'$defaultBranch' has diverged from origin ($(Get-Plural $ahead 'local commit'), $(Get-Plural $behind 'remote commit'))$where"
            if ($onDefault -and $localChanges.Count -gt 0) {
                Add-Result 'Skipped' $name "$detail, and local changes block a reset"
            }
            else {
                Add-Result 'Skipped' $name "$detail$reviewHint"
                New-ReviewItem -Kind 'Reset' -Repo $name -RepoPath $path -Flagged $true `
                    -Label "Reset '$defaultBranch' to origin (local commits are kept in a backup branch)" `
                    -Data @{ Default = $defaultBranch; OnDefault = $onDefault; Record = $lastResult }
            }
        }
        elseif ($behind -gt 0) {
            if ($onDefault) {
                $overlap = @()
                if ($localChanges.Count -gt 0) {
                    $incoming = @(git -c core.quotepath=false diff --name-only "$defaultBranch..$remoteRef" 2>$null)
                    $overlap = @($localChanges | Where-Object { $incoming -contains $_ })
                }
                if ($overlap.Count -gt 0) {
                    Add-Result 'Skipped' $name "local changes touch $($overlap.Count) incoming $(if ($overlap.Count -eq 1) { 'file' } else { 'files' })$reviewHint"
                    New-ReviewItem -Kind 'Stash' -Repo $name -RepoPath $path `
                        -Label "Stash local changes, update '$defaultBranch', restore them ($($overlap.Count) overlapping)" `
                        -Data @{ Default = $defaultBranch; Overlap = $overlap; Record = $lastResult }
                }
                else {
                    git merge --ff-only $remoteRef --quiet 2>$null
                    if ($LASTEXITCODE -eq 0) { $updatedDefault = $true }
                    else { Add-Result 'Failed' $name "fast-forward of '$defaultBranch' failed" }
                }
            }
            else {
                # Not checked out: move the branch without touching the working tree.
                git fetch origin "${defaultBranch}:${defaultBranch}" --quiet 2>$null
                if ($LASTEXITCODE -eq 0) { $updatedDefault = $true }
                else { Add-Result 'Failed' $name "could not update '$defaultBranch'$where" }
            }
        }
        else {
            $note = if ($ahead -gt 0) { ", $(Get-Plural $ahead 'local commit') not pushed" } else { '' }
            Add-Result 'Current' $name "'$defaultBranch'$note$where"
        }

        if ($updatedDefault) {
            $after = git rev-parse $defaultBranch
            $beforeText = if ($before) { $before.Substring(0, 7) } else { 'new' }
            $keep = if ($onDefault -and $localChanges.Count -gt 0) { ', local changes kept' } else { '' }
            Add-Result 'Updated' $name "$beforeText -> $($after.Substring(0, 7))$where$keep"
            if ($onDefault -and $hadNodeModules -and $before -and (Test-Path (Join-Path $path "package.json"))) {
                New-ReviewItem -Kind 'Npm' -Repo $name -RepoPath $path -Label 'npm install' `
                    -Data @{ Before = $before; After = $after }
            }
        }

        # Local branches: fully merged ones go right away, the rest are decisions.
        $worktreeBranches = @(Get-WorktreeBranches)
        $mergedBranches = @(git branch --merged $defaultBranch --format='%(refname:short)' 2>$null |
            Where-Object { $_ -and $_ -ne $defaultBranch -and $_ -ne $branch -and $worktreeBranches -notcontains $_ })
        foreach ($b in $mergedBranches) { [void](Remove-Branch -Name $name -Repo $name -Branch $b -Mode '-d') }

        $currentMerged = $false
        $currentInDefault = $false
        if (-not $onDefault -and $branch -ne 'HEAD') {
            git merge-base --is-ancestor $branch $defaultBranch 2>$null
            $currentMerged = $LASTEXITCODE -eq 0
            $currentInDefault = $currentMerged -or (Test-ContentInDefault -Branch $branch -DefaultBranch $defaultBranch)
        }

        foreach ($line in @(git for-each-ref --format='%(refname:short)|%(upstream:track)' refs/heads 2>$null)) {
            $b, $track = $line -split '\|', 2
            if (-not $b -or $b -eq $defaultBranch -or $b -eq $branch -or $worktreeBranches -contains $b) { continue }
            if ($mergedBranches -contains $b) { continue }

            $inDefault = Test-ContentInDefault -Branch $b -DefaultBranch $defaultBranch
            $gone = $track -eq '[gone]'
            if ($inDefault) {
                New-ReviewItem -Kind 'Delete' -Repo $name -RepoPath $path -Marked $true `
                    -Label "Delete branch '$b' (already in '$defaultBranch'$(if ($gone) { ', upstream gone' }))" `
                    -Data @{ Default = $defaultBranch; Branch = $b; InDefault = $true }
            }
            elseif ($gone) {
                $unique = git rev-list --count "${defaultBranch}..${b}" 2>$null
                New-ReviewItem -Kind 'Delete' -Repo $name -RepoPath $path -Flagged $true `
                    -Label "Delete branch '$b' (upstream gone, $(Get-Plural $unique 'commit') not in '$defaultBranch')" `
                    -Data @{ Default = $defaultBranch; Branch = $b; InDefault = $false }
            }
        }

        # Leaving the current branch for the default branch (only without local changes).
        if (-not $onDefault -and $localChanges.Count -eq 0) {
            if ($currentInDefault) {
                New-ReviewItem -Kind 'Switch' -Repo $name -RepoPath $path -Marked $true `
                    -Label "Switch to '$defaultBranch' and delete '$branch' (already in '$defaultBranch')" `
                    -Data @{ Default = $defaultBranch; Branch = $branch; DeleteBranch = $true }
            }
            else {
                New-ReviewItem -Kind 'Switch' -Repo $name -RepoPath $path `
                    -Label "Switch to '$defaultBranch' (leaves '$branch', which has unmerged work)" `
                    -Data @{ Default = $defaultBranch; Branch = $branch; DeleteBranch = $false }
            }
        }
    }
    finally {
        Pop-Location
    }
}

# Step 2: decisions. Entries of a class with an explicit $true/$false are settled by
# the parameter, the rest go into one list.
$toRun = [System.Collections.Generic.List[object]]::new()
$ask = [System.Collections.Generic.List[object]]::new()
foreach ($item in $reviewItems) {
    $setting = if ($item.Class -eq 'npm') { $InstallDeps } else { $Cleanup }
    if ($null -eq $setting) {
        $ask.Add($item)
    }
    elseif ($setting) {
        # npm: every entry; cleanup: only what would be pre-marked.
        if ($item.Class -eq 'npm' -or $item.Marked) { $toRun.Add($item) }
    }
}

if ($ask.Count -gt 0) {
    Write-Host ''
    if ([Console]::IsInputRedirected -or [Console]::IsOutputRedirected) {
        Write-Host "$($ask.Count) open decisions skipped, no interactive console." -ForegroundColor DarkGray
    }
    else {
        $repoCount = @($ask | ForEach-Object { $_.Repo } | Sort-Object -Unique).Count
        $pick = Select-ConsoleItem -Items $ask.ToArray() -Tree -NoFlagKey `
            -Title "Review: $($ask.Count) $(if ($ask.Count -eq 1) { 'decision' } else { 'decisions' }) in $repoCount $(if ($repoCount -eq 1) { 'repo' } else { 'repos' })" `
            -Flag { param($i) $i.Flagged } -FlagLabel 'needs care' `
            -Preview ${function:Get-ReviewPreview} `
            -Action @{ v = @{ Label = 'full diff'; Run = ${function:Show-ReviewDiff} } }
        if ($pick.Cancelled) { Write-Host 'Review cancelled, nothing changed.' -ForegroundColor DarkGray }
        else { foreach ($item in $pick.Items) { $toRun.Add($item) } }
    }
}

# Step 3: run what was marked, repo by repo.
if ($toRun.Count -gt 0) {
    $kindOrder = @{ Stash = 0; Reset = 1; Switch = 2; Delete = 3; Npm = 4 }
    Write-Host ''
    foreach ($item in @($toRun | Sort-Object { $repoOrder[$_.Repo] }, { $kindOrder[$_.Kind] })) {
        Invoke-ReviewItem -Item $item
    }
}

# Summary
function Get-Count([string]$State) { @($results | Where-Object { $_.State -eq $State }).Count }

$failed = Get-Count 'Failed'
$skipped = Get-Count 'Skipped'
$summary = "Updated: $(Get-Count 'Updated'), up to date: $(Get-Count 'Current'), skipped: $skipped, failed: $failed"
if ($counts.Cleaned -gt 0) { $summary += ", branches deleted: $($counts.Cleaned)" }
if ($counts.Reset -gt 0) { $summary += ", reset: $($counts.Reset)" }
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
