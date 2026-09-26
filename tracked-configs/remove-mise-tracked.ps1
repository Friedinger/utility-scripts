param(
    [Parameter(Position = 0)]
    [string]$Path,

    [Alias('y')]
    [switch]$Force,

    [string]$StateDir
)

$ErrorActionPreference = 'Stop'

try {
    if ($Force -and -not $Path) {
        throw '-Force needs a path.'
    }
    $interactive = -not $Path

    $override = [bool]$StateDir
    if (-not $override) {
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

    if ($override) {
        $tracked = @(Get-ChildItem -LiteralPath $StateDir -File |
            ForEach-Object { (Get-Content -LiteralPath $_.FullName -Raw).Trim() })
    } else {
        $tracked = @(mise config ls --tracked-configs |
            ForEach-Object { $_.Trim() } | Where-Object { $_ })
    }
    $tracked = @($tracked | Sort-Object -Unique)

    if ($tracked.Count -eq 0) {
        Write-Host 'No tracked configs found.'
        exit 0
    }

    if ($interactive) {
        Write-Host ''
        Write-Host "Tracked configs ($($tracked.Count)):" -ForegroundColor Cyan
        Write-Host ''
        $tracked | ForEach-Object { Write-Host "  $_" }
    }

    while ($true) {
        if ($interactive) {
            Write-Host ''
            $t = Read-Host 'Path to remove'
            if ([string]::IsNullOrWhiteSpace($t)) {
                Write-Host 'Aborted.'
                exit 0
            }
            $t = $t.Trim()
        }
        else {
            $t = $Path.Trim()
        }

        $hit = $tracked | Where-Object { $_ -eq $t } | Select-Object -First 1
        if ($hit) {
            $target = $hit
            break
        }

        Write-Host "Not in the list: $t" -ForegroundColor Red
        if (-not $interactive) {
            exit 1
        }
    }

    Write-Host ''
    Write-Host "About to remove: $target" -ForegroundColor Yellow
    if (-not $Force) {
        $conf = Read-Host 'Really remove? (y/N)'
        if ($conf -notmatch '^(y|yes)$') {
            Write-Host 'Aborted, nothing removed.'
            exit 0
        }
    }

    $victims = @(Get-ChildItem -LiteralPath $StateDir -File |
        Where-Object { (Get-Content -LiteralPath $_.FullName -Raw).Trim() -eq $target })
    if ($victims.Count -eq 0) {
        throw "Entry not found in directory: $target"
    }
    $victims | Remove-Item -Force

    $left = @(Get-ChildItem -LiteralPath $StateDir -File |
        Where-Object { (Get-Content -LiteralPath $_.FullName -Raw).Trim() -eq $target })
    if ($left.Count -gt 0) {
        throw "Removal failed, entry is still there: $target"
    }

    Write-Host ''
    Write-Host "Removed: $target" -ForegroundColor Green
}
catch {
    Write-Host ''
    Write-Host "Error: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
