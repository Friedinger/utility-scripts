<#
.SYNOPSIS
  Brings all Git repos under a root folder up to date with their default branch.

.DESCRIPTION
  For each subfolder containing .git:
    - git fetch --prune
    - detects the repo's actual default branch (via origin/HEAD, not a hardcoded main/master guess)
    - skips repos with uncommitted changes (nothing is ever overwritten)
    - checks out the default branch (only if clean) and pulls via --ff-only
    - deletes local branches that are already fully merged into the default branch
    - reports repos with no default branch detected or with diverged history
    - optionally runs npm install for repos with a package.json, but only when
      the repo was actually updated or node_modules is missing
    - prints a summary of repos that need attention at the end

.PARAMETER Root
  Folder containing the project folders. Default: current folder.

.PARAMETER InstallDeps
  Controls npm install (npm ci if a package-lock.json is present) after a repo
  is updated, so node_modules matches the newly pulled package.json/lockfile.
  Omitted: ask per repo whenever an install would be relevant.
  $true: always install for every relevant repo, no prompts.
  $false: never install, no prompts.

.EXAMPLE
  sync-repos.ps1
  sync-repos.ps1 C:\Projects -InstallDeps:$true
  sync-repos.ps1 C:\Projects -InstallDeps:$false
#>

param(
    [string]$Root = (Get-Location).Path,
    [Nullable[bool]]$InstallDeps = $null
)

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

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
        [Nullable[bool]]$InstallDeps
    )

    # Returns $true if an install was attempted and failed, $false otherwise.
    if (-not (Test-Path (Join-Path $Path "package.json"))) { return $false }

    $nodeModulesMissing = -not (Test-Path (Join-Path $Path "node_modules"))
    if (-not $WasUpdated -and -not $nodeModulesMissing) { return $false }

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

$dirs = Get-ChildItem -Path $Root -Directory
$issues = New-Object System.Collections.Generic.List[string]

foreach ($d in $dirs) {
    $name = $d.Name
    $path = $d.FullName
    $gitDir = Join-Path $path ".git"

    if (-not (Test-Path $gitDir)) {
        Write-Host "[$name] skipped (not a git repo)" -ForegroundColor DarkGray
        continue
    }

    Push-Location $path
    try {
        git fetch --quiet --prune 2>$null
        if ($LASTEXITCODE -ne 0) {
            Write-Host "[$name] git fetch FAILED (offline? auth issue?)" -ForegroundColor Red
            $issues.Add("[$name] git fetch failed")
            continue
        }

        $branch = git rev-parse --abbrev-ref HEAD 2>$null
        $status = git status --porcelain 2>$null

        $defaultBranch = Get-DefaultBranch

        if (-not $defaultBranch) {
            Write-Host "[$name] no default branch detected (currently on '$branch')" -ForegroundColor Yellow
            $issues.Add("[$name] no default branch detected")
            continue
        }

        if ($status) {
            Write-Host "[$name] SKIPPED: uncommitted changes on '$branch'" -ForegroundColor Yellow
            $issues.Add("[$name] uncommitted changes on '$branch'")
            continue
        }

        if ($branch -ne $defaultBranch) {
            git checkout $defaultBranch --quiet 2>$null
            if ($LASTEXITCODE -ne 0) {
                Write-Host "[$name] failed to check out '$defaultBranch'" -ForegroundColor Red
                $issues.Add("[$name] failed to check out '$defaultBranch'")
                continue
            }
            Write-Host "[$name] switched from '$branch' to '$defaultBranch'" -ForegroundColor Cyan
        }

        $before = git rev-parse HEAD
        git pull --ff-only --quiet 2>$null
        $pullExit = $LASTEXITCODE
        $after = git rev-parse HEAD
        $wasUpdated = $false

        if ($pullExit -ne 0) {
            Write-Host "[$name] PULL FAILED on '$defaultBranch' (diverged? -> check manually)" -ForegroundColor Red
            $issues.Add("[$name] pull failed on '$defaultBranch' (diverged?)")
        }
        elseif ($before -ne $after) {
            Write-Host "[$name] updated: $($before.Substring(0,7)) -> $($after.Substring(0,7))" -ForegroundColor Green
            $wasUpdated = $true
        }
        else {
            Write-Host "[$name] already up to date on '$defaultBranch'" -ForegroundColor DarkGray
        }

        $installFailed = Install-Dependencies -Name $name -Path $path -WasUpdated $wasUpdated -InstallDeps $InstallDeps
        if ($installFailed) {
            $issues.Add("[$name] npm install failed")
        }

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
if ($issues.Count -gt 0) {
    Write-Host "Needs attention:" -ForegroundColor Yellow
    foreach ($issue in $issues) {
        Write-Host "  - $issue" -ForegroundColor Yellow
    }
}
else {
    Write-Host "No issues." -ForegroundColor Green
}

Write-Host ""
Write-Host "Done." -ForegroundColor White
