<#
.SYNOPSIS
  Removes entries from mise's tracked-configs cache.

.DESCRIPTION
  mise remembers every config file it has ever seen, in every directory you
  have been in. Entries for archived or deleted projects therefore stick
  around and keep showing up in `mise ls --all-sources`. `mise trust` /
  `mise untrust` do not help here — they manage a different list
  (trusted-configs), and mise ships no command for removing tracked entries
  at all. This script deletes the entries directly from mise's state directory.

  Without -Path and -Missing, opens an interactive list: mark entries with
  Space, filter with /, mark all entries whose file no longer exists with d.
  Entries that no longer exist are shown in red.

  In every mode the entries about to be removed are listed first and need a
  confirmation, unless -Force is given.

.PARAMETER Path
  One or more tracked config paths to remove. Wildcards (* ?) are allowed,
  e.g. 'D:\Archive\*'. Matching is case-insensitive.

.PARAMETER Missing
  Only consider entries whose config file no longer exists. Alone: removes
  all of them. Together with -Path: only those matches that are missing.

.PARAMETER Force
  Skip the confirmation prompt. Requires -Path or -Missing. Alias: -y.

.PARAMETER StateDir
  Override the tracked-configs directory instead of asking `mise doctor`
  for it. Mainly useful for testing.

.EXAMPLE
  Remove-MiseTrackedConfig.ps1
  Remove-MiseTrackedConfig.ps1 'C:\path\to\mise.toml'
  Remove-MiseTrackedConfig.ps1 'D:\Archive\*' -Missing
  Remove-MiseTrackedConfig.ps1 -Missing -y
  Remove-MiseTrackedConfig.ps1 -Missing -WhatIf
#>

[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Position = 0)]
    [string[]]$Path,

    [switch]$Missing,

    [Alias('y')]
    [switch]$Force,

    [string]$StateDir
)

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot '..\lib\Select-ConsoleItem.ps1')

function Test-ConfigMissing([string]$p) {
    -not (Test-Path -LiteralPath $p)
}

try {
    if ($Force -and -not $Path -and -not $Missing) {
        throw '-Force needs -Path or -Missing.'
    }
    $interactive = -not $Path -and -not $Missing

    if (-not $StateDir) {
        if (-not (Get-Command mise -ErrorAction SilentlyContinue)) {
            throw 'mise not found on PATH.'
        }
        $info = mise doctor --json | ConvertFrom-Json
        if (-not $info.dirs.state) {
            throw 'mise doctor --json returned no dirs.state.'
        }
        $StateDir = Join-Path $info.dirs.state 'tracked-configs'
    }

    if (-not (Test-Path -LiteralPath $StateDir -PathType Container)) {
        throw "Directory not found: $StateDir"
    }

    # Read every entry file once: tracked path -> the file(s) that record it.
    $entries = @{}
    foreach ($f in Get-ChildItem -LiteralPath $StateDir -File) {
        $p = (Get-Content -LiteralPath $f.FullName -Raw).Trim()
        if (-not $p) { continue }
        if (-not $entries.ContainsKey($p)) { $entries[$p] = [System.Collections.Generic.List[string]]::new() }
        $entries[$p].Add($f.FullName)
    }
    $tracked = @($entries.Keys | Sort-Object)

    if ($tracked.Count -eq 0) {
        Write-Host 'No tracked configs found.'
        exit 0
    }

    # Work out what to remove.
    if ($interactive) {
        $pick = Select-ConsoleItem -Items $tracked -Title "Tracked configs ($($tracked.Count))" `
            -Flag ${function:Test-ConfigMissing} -FlagLabel 'missing'
        if ($pick.Cancelled) {
            Write-Host 'Aborted, nothing removed.'
            exit 0
        }
        $targets = @($pick.Items)
    }
    else {
        $candidates = $tracked
        if ($Path) {
            $unmatched = @()
            $matched = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
            foreach ($pattern in $Path) {
                $pattern = $pattern.Trim()
                $wild = [WildcardPattern]::ContainsWildcardCharacters($pattern)
                $hits = @($tracked | Where-Object { $_ -eq $pattern -or ($wild -and $_ -like $pattern) })
                if ($hits.Count -eq 0) { $unmatched += $pattern }
                foreach ($h in $hits) { [void]$matched.Add($h) }
            }
            foreach ($u in $unmatched) { Write-Host "Not in the list: $u" -ForegroundColor Red }
            $candidates = @($tracked | Where-Object { $matched.Contains($_) })
        }
        if ($Missing) {
            $candidates = @($candidates | Where-Object { Test-ConfigMissing $_ })
        }
        $targets = @($candidates)
        if ($targets.Count -eq 0) {
            Write-Host 'Nothing to remove.'
            exit $(if ($unmatched) { 1 } else { 0 })
        }
    }

    if ($targets.Count -eq 0) {
        Write-Host 'Nothing marked, nothing removed.'
        exit 0
    }

    # Always show the final list before removing.
    Write-Host ''
    Write-Host "About to remove $($targets.Count) $(if ($targets.Count -eq 1) { 'entry' } else { 'entries' }):" -ForegroundColor Yellow
    Write-Host ''
    foreach ($t in $targets) {
        if (Test-ConfigMissing $t) {
            Write-Host "  $t" -NoNewline
            Write-Host '  (missing)' -ForegroundColor DarkGray
        }
        else {
            Write-Host "  $t"
        }
    }

    if (-not $Force -and -not $WhatIfPreference) {
        Write-Host ''
        $conf = Read-Host "Really remove $($targets.Count)? (y/N)"
        if ($conf -notmatch '^(y|yes)$') {
            Write-Host 'Aborted, nothing removed.'
            exit 0
        }
    }

    # Remove, one entry at a time so a failure does not stop the rest.
    Write-Host ''
    $removed = 0
    $failed = 0
    foreach ($t in $targets) {
        if (-not $PSCmdlet.ShouldProcess($t, 'Remove tracked config')) { continue }
        try {
            $entries[$t] | ForEach-Object { Remove-Item -LiteralPath $_ -Force }
            if (@($entries[$t] | Where-Object { Test-Path -LiteralPath $_ }).Count -gt 0) {
                throw 'entry is still there'
            }
            Write-Host "Removed: $t" -ForegroundColor Green
            $removed++
        }
        catch {
            Write-Host "Failed:  $t ($($_.Exception.Message))" -ForegroundColor Red
            $failed++
        }
    }

    if (-not $WhatIfPreference) {
        Write-Host ''
        $color = if ($failed) { 'Red' } else { 'Green' }
        Write-Host "Removed: $removed, failed: $failed" -ForegroundColor $color
    }
    if ($failed) { exit 1 }
}
catch {
    Write-Host ''
    Write-Host "Error: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
