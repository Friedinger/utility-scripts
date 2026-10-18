<#
.SYNOPSIS
  Creates throwaway Git repos in every situation Sync-GitRepos.ps1 handles, for trying it out.

.DESCRIPTION
  Builds a sandbox with local "remotes" (bare repos) and clones of them under
  <Path>\root. Nothing outside the sandbox is touched. Run it again to get a
  fresh sandbox; an existing one is deleted first.

  The clones (each one in the state Sync-GitRepos.ps1 finds it):
    behind          origin has a new commit, the clone is clean
    merged-branch   on a feature branch that was merged on origin
    squash-merged   a local branch that was squash-merged on origin, upstream deleted
    unmerged-gone   a local branch with unmerged work, upstream deleted
    diverged        local main and origin/main both have new commits
    dirty-overlap   local changes in a file that the update also changes
    dirty-clean     local changes in a file that the update does not touch
    wip-branch      on a branch with unmerged work, main is behind
    npm             behind, has package.json and node_modules

.PARAMETER Path
  Where to build the sandbox. Must end in "sync-git-repos-sandbox" (it is
  deleted and recreated). Default: in the temp folder.

.EXAMPLE
  .\New-SyncTestRepos.ps1
  .\New-SyncTestRepos.ps1 -Path D:\Scratch\sync-git-repos-sandbox
  ..\Sync-GitRepos.ps1 "$env:TEMP\sync-git-repos-sandbox\root"
#>

param(
    [string]$Path = (Join-Path ([System.IO.Path]::GetTempPath()) 'sync-git-repos-sandbox')
)

$ErrorActionPreference = 'Stop'

if ((Split-Path $Path -Leaf) -ne 'sync-git-repos-sandbox') {
    throw "The path must end in 'sync-git-repos-sandbox', got: $Path"
}
# A virus scanner can hold freshly written repo files for a moment, so retry briefly.
function Invoke-Retry {
    param([scriptblock]$Do, [int]$Attempts = 6)
    for ($i = 1; ; $i++) {
        try { return & $Do }
        catch {
            if ($i -ge $Attempts) { throw }
            Start-Sleep -Milliseconds 700
        }
    }
}

if (Test-Path -LiteralPath $Path) { Invoke-Retry { Remove-Item -LiteralPath $Path -Recurse -Force } }
New-Item -ItemType Directory $Path | Out-Null
$Path = (Resolve-Path $Path).Path

function G {
    $gitArgs = $args
    Invoke-Retry {
        $out = & git -c user.name=test -c user.email=test@example.com @gitArgs 2>&1
        if ($LASTEXITCODE -ne 0) { throw "git $($gitArgs -join ' ') failed: $($out -join ' ')" }
    }
}

# Remote + a seed clone (to push "upstream" changes) + the clone that gets synced.
function New-TestRepo {
    param([string]$Name, [string]$Parent = 'root')
    Push-Location $Path
    try {
        G init -q --bare "remotes\$Name.git" -b main
        G clone -q "remotes\$Name.git" "seeds\$Name"
        Push-Location "seeds\$Name"
        Set-Content f.txt "a`nb`nc"
        Set-Content g.txt g
        G add -A
        G commit -m init
        G push -q origin HEAD:main
        Pop-Location
        New-Item -ItemType Directory -Force $Parent | Out-Null
        G clone -q "remotes\$Name.git" "$Parent\$Name"
    }
    finally { Pop-Location }
}

# Runs a block inside the seed clone (upstream side) or the synced clone.
function In-Seed { param($Name, [scriptblock]$Do) Push-Location "$Path\seeds\$Name"; try { G pull -q --ff-only origin main; & $Do } finally { Pop-Location } }
function In-Repo { param($Name, [scriptblock]$Do) Push-Location "$Path\root\$Name"; try { & $Do } finally { Pop-Location } }

foreach ($n in 'behind', 'merged-branch', 'squash-merged', 'unmerged-gone', 'diverged', 'dirty-overlap', 'dirty-clean', 'wip-branch', 'npm') {
    New-TestRepo $n
}

In-Seed 'behind' { Set-Content g.txt g1; G commit -am 'upstream change'; G push -q origin HEAD:main }

In-Repo 'merged-branch' { G checkout -b feat/a; Set-Content a.txt a; G add -A; G commit -m a; G push -q -u origin feat/a }
In-Seed 'merged-branch' { G fetch -q; G merge --no-ff -m merge origin/feat/a; G push -q origin HEAD:main }

In-Repo 'squash-merged' { G checkout -b feat/squash; Set-Content s1.txt 1; G add -A; G commit -m s1; Set-Content s2.txt 2; G add -A; G commit -m s2; G push -q -u origin feat/squash; G checkout main }
In-Seed 'squash-merged' { G fetch -q; G merge --squash origin/feat/squash; G commit -m 'squash merge'; G push -q origin HEAD:main; G push -q origin --delete feat/squash }

In-Repo 'unmerged-gone' { G checkout -b wip; Set-Content w.txt w; G add -A; G commit -m w; G push -q -u origin wip; G checkout main }
In-Seed 'unmerged-gone' { G push -q origin --delete wip; Set-Content g.txt g2; G commit -am 'upstream change'; G push -q origin HEAD:main }

In-Repo 'diverged' { Set-Content local.txt l; G add -A; G commit -m 'local commit on main' }
In-Seed 'diverged' { Set-Content remote.txt r; G add -A; G commit -m 'upstream commit'; G push -q origin HEAD:main }

In-Seed 'dirty-overlap' { Set-Content f.txt "A`nb`nc"; G commit -am 'upstream change'; G push -q origin HEAD:main }
In-Repo 'dirty-overlap' { Set-Content f.txt "a`nb`nC" }

In-Seed 'dirty-clean' { Set-Content g.txt g3; G commit -am 'upstream change'; G push -q origin HEAD:main }
In-Repo 'dirty-clean' { Set-Content f.txt "a`nb`nZ" }

In-Repo 'wip-branch' { G checkout -b wip2; Set-Content w2.txt w; G add -A; G commit -m 'work in progress' }
In-Seed 'wip-branch' { Set-Content g.txt g4; G commit -am 'upstream change'; G push -q origin HEAD:main }

In-Seed 'npm' { Set-Content package.json '{"name":"x","version":"1.0.0"}'; G add -A; G commit -m 'add package.json'; G push -q origin HEAD:main }
In-Repo 'npm' { G pull -q --ff-only; New-Item -ItemType Directory node_modules | Out-Null; Add-Content .git\info\exclude "node_modules`npackage-lock.json" }
In-Seed 'npm' { Set-Content package.json '{"name":"x","version":"1.0.1"}'; G commit -am 'bump version'; G push -q origin HEAD:main }

Write-Host ''
Write-Host "Sandbox ready: $Path\root" -ForegroundColor Green
$sync = Join-Path (Split-Path $PSScriptRoot -Parent) 'Sync-GitRepos.ps1'
Write-Host 'Try it with:' -ForegroundColor Cyan
Write-Host "  & '$sync' '$Path\root'"
Write-Host 'Remove it with Remove-SyncTestRepos.ps1 (same folder as this script).' -ForegroundColor DarkGray
