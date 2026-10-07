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
    - optionally runs npm install, but only when the repo was updated and
      already had node_modules installed before

.PARAMETER Root
  Folder to search for repos. Default: current folder.

.PARAMETER InstallDeps
  Controls npm install (npm ci if a package-lock.json is present) after a repo
  is updated, so node_modules matches the newly pulled package.json/lockfile.
  Only relevant for repos that already had node_modules.
  Omitted: ask per repo whenever an install would be relevant.
  $true: always install for every relevant repo, no prompts.
  $false: never install, no prompts.

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

$rootFull = (Resolve-Path $Root).Path.TrimEnd('\', '/')

function Get-RelativeName {
    param([string]$FullPath)
    return $FullPath.Substring($rootFull.Length).TrimStart('\', '/')
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

function Install-Dependencies {
    param(
        [string]$Name,
        [string]$Path,
        [bool]$WasUpdated,
        [bool]$HadNodeModules,
        [Nullable[bool]]$InstallDeps
    )

    # Returns $true if an install was attempted and failed, $false otherwise.
    if (-not $WasUpdated -or -not $HadNodeModules) { return $false }
    if (-not (Test-Path (Join-Path $Path "package.json"))) { return $false }

    $shouldInstall = $InstallDeps
    if ($null -eq $shouldInstall) {
        $answer = Read-Host "[$Name] run npm install? (y/N)"
        $shouldInstall = $answer -match '^(y|yes)$'
    }

    if (-not $shouldInstall) {
        Write-Host "[$Name] npm install skipped" -ForegroundColor DarkGray
        return $false
    }

    if (Test-Path (Join-Path $Path "package-lock.json")) {
        Write-Host "[$Name] running npm ci..." -ForegroundColor Cyan
        npm ci --silent 2>$null | Out-Null
    }
    else {
        Write-Host "[$Name] running npm install..." -ForegroundColor Cyan
        npm install --silent 2>$null | Out-Null
    }

    if ($LASTEXITCODE -ne 0) {
        Write-Host "[$Name] npm install FAILED" -ForegroundColor Red
        return $true
    }

    Write-Host "[$Name] dependencies installed" -ForegroundColor Green
    return $false
}

$repos = @(Find-Repos -Path $rootFull -Depth $MaxDepth)

if ($repos.Count -eq 0) {
    Write-Host "No git repos found under $rootFull." -ForegroundColor Yellow
}

foreach ($d in $repos) {
    $name = Get-RelativeName $d.FullName
    $path = $d.FullName

    # .git not (fully) local: skip silently, nothing gets downloaded.
    if (-not (Test-GitDirLocal -RepoPath $path)) { continue }

    Push-Location $path
    try {
        git fetch --quiet --prune 2>$null
        if ($LASTEXITCODE -ne 0) {
            Write-Host "[$name] git fetch FAILED (offline? auth issue?)" -ForegroundColor Red
            continue
        }

        $branch = git rev-parse --abbrev-ref HEAD 2>$null
        $status = git status --porcelain 2>$null

        $defaultBranch = Get-DefaultBranch

        if (-not $defaultBranch) {
            Write-Host "[$name] no default branch detected (currently on '$branch')" -ForegroundColor Yellow
            continue
        }

        if ($status) {
            Write-Host "[$name] SKIPPED: uncommitted changes on '$branch'" -ForegroundColor Yellow
            continue
        }

        if ($branch -ne $defaultBranch) {
            git checkout $defaultBranch --quiet 2>$null
            if ($LASTEXITCODE -ne 0) {
                Write-Host "[$name] failed to check out '$defaultBranch'" -ForegroundColor Red
                continue
            }
            Write-Host "[$name] switched from '$branch' to '$defaultBranch'" -ForegroundColor Cyan
        }

        $hadNodeModules = Test-Path (Join-Path $path "node_modules")

        $before = git rev-parse HEAD
        git pull --ff-only --quiet 2>$null
        $pullExit = $LASTEXITCODE
        $after = git rev-parse HEAD
        $wasUpdated = $false

        if ($pullExit -ne 0) {
            Write-Host "[$name] PULL FAILED on '$defaultBranch' (diverged? -> check manually)" -ForegroundColor Red
        }
        elseif ($before -ne $after) {
            Write-Host "[$name] updated: $($before.Substring(0,7)) -> $($after.Substring(0,7))" -ForegroundColor Green
            $wasUpdated = $true
        }
        else {
            Write-Host "[$name] already up to date on '$defaultBranch'" -ForegroundColor DarkGray
        }

        Install-Dependencies -Name $name -Path $path -WasUpdated $wasUpdated -HadNodeModules $hadNodeModules -InstallDeps $InstallDeps | Out-Null

        $mergedBranches = git branch --merged $defaultBranch 2>$null |
            ForEach-Object { $_.Trim().TrimStart('* ').Trim() } |
            Where-Object { $_ -and $_ -ne $defaultBranch }

        foreach ($b in $mergedBranches) {
            git branch -d $b --quiet 2>$null
            if ($LASTEXITCODE -eq 0) {
                Write-Host "[$name] deleted merged branch '$b'" -ForegroundColor DarkCyan
            }
        }
    }
    finally {
        Pop-Location
    }
}

Write-Host ""
Write-Host "Done." -ForegroundColor White
