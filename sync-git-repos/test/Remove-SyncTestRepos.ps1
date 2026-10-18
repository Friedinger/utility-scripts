<#
.SYNOPSIS
  Deletes the sandbox that New-SyncTestRepos.ps1 created.

.PARAMETER Path
  The sandbox to delete. Must end in "sync-git-repos-sandbox" (a safety check,
  so this cannot be pointed at an arbitrary folder). Default: the one in the
  temp folder.

.EXAMPLE
  .\Remove-SyncTestRepos.ps1
  .\Remove-SyncTestRepos.ps1 -Path D:\Scratch\sync-git-repos-sandbox
#>

param(
    [string]$Path = (Join-Path ([System.IO.Path]::GetTempPath()) 'sync-git-repos-sandbox')
)

$ErrorActionPreference = 'Stop'

try {
    if ((Split-Path $Path -Leaf) -ne 'sync-git-repos-sandbox') {
        throw "The path must end in 'sync-git-repos-sandbox', got: $Path"
    }
    if (-not (Test-Path -LiteralPath $Path)) {
        Write-Host "Nothing to remove: $Path does not exist."
        exit 0
    }

    # A virus scanner can hold freshly written repo files for a moment, so retry briefly.
    for ($i = 1; ; $i++) {
        try { Remove-Item -LiteralPath $Path -Recurse -Force; break }
        catch {
            if ($i -ge 6) { throw }
            Start-Sleep -Milliseconds 700
        }
    }

    Write-Host "Removed: $Path" -ForegroundColor Green
}
catch {
    Write-Host "Error: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
