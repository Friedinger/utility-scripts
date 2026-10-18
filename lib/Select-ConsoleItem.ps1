<#
.SYNOPSIS
  Small console multi-select list (TUI), meant to be dot-sourced.

.DESCRIPTION
  Shows a scrollable list in the console. Keys:
    Up/Down, PgUp/PgDn, Home/End   move
    Space                          mark / unmark the current item
    a                              mark all items matching the filter (or unmark them if all are marked)
    n                              unmark everything
    d                              mark all matching flagged items (only with -Flag)
    /                              live filter, Enter or Esc leaves the filter input
    Enter                          done
    Esc / q                        cancel

  Returns an object with `Cancelled` (bool) and `Items` (the marked items, in
  their original order). Needs an interactive console.

.PARAMETER Items
  The entries to choose from.

.PARAMETER Title
  Header line above the list.

.PARAMETER Flag
  Optional scriptblock that receives an item and returns $true for items that
  should be highlighted in red (for example entries that no longer exist).

.PARAMETER FlagLabel
  Name of the flagged group, used in the help line and status line.

.PARAMETER Preview
  Optional scriptblock that receives the item under the cursor and returns up
  to 5 lines of text. Shown below the list; toggled on and off with p (on by
  default). Results are cached per item.

.EXAMPLE
  . "$PSScriptRoot\..\lib\Select-ConsoleItem.ps1"
  $r = Select-ConsoleItem -Items $paths -Flag { param($p) -not (Test-Path -LiteralPath $p) } -FlagLabel missing
  if (-not $r.Cancelled) { $r.Items }
#>

function Select-ConsoleItem {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string[]]$Items,

        [string]$Title = 'Select items',

        [scriptblock]$Flag,

        [string]$FlagLabel = 'flagged',

        [scriptblock]$Preview
    )

    if ([Console]::IsInputRedirected -or [Console]::IsOutputRedirected) {
        throw 'Select-ConsoleItem needs an interactive console.'
    }

    $items = @($Items)
    $flags = [bool[]]::new($items.Count)
    if ($Flag) {
        for ($i = 0; $i -lt $items.Count; $i++) {
            $flags[$i] = [bool](& $Flag $items[$i])
        }
    }
    $flagCount = @($flags | Where-Object { $_ }).Count

    $selected = [System.Collections.Generic.HashSet[int]]::new()
    $filter = ''
    $filtering = $false
    $cursor = 0
    $offset = 0
    $cancelled = $false
    $done = $false

    $width = [Math]::Max(20, [Console]::WindowWidth - 1)
    # The preview takes 6 rows (separator + 5 lines) from the bottom of the list region.
    $previewRows = 6
    $previewOn = [bool]$Preview
    $previewCache = @{}
    $region = if ($Preview) {
        [Math]::Max($previewRows + 3, [Math]::Min($items.Count + $previewRows, [Console]::WindowHeight - 6))
    } else {
        [Math]::Max(3, [Math]::Min($items.Count, [Console]::WindowHeight - 6))
    }
    $total = $region + 4

    function Get-Visible {
        if ($items.Count -eq 0) { return @() }
        if (-not $filter) { return @(0..($items.Count - 1)) }
        @(0..($items.Count - 1) | Where-Object {
            $items[$_].IndexOf($filter, [StringComparison]::OrdinalIgnoreCase) -ge 0
        })
    }

    $oldCursorVisible = [Console]::CursorVisible
    $oldCtrlC = [Console]::TreatControlCAsInput
    [Console]::CursorVisible = $false
    # Without this, Ctrl+C only flags a pipeline stop and the blocking ReadKey never returns.
    [Console]::TreatControlCAsInput = $true
    try {
        1..$total | ForEach-Object { Write-Host '' }
        $top = [Console]::CursorTop - $total

        $line = {
            param([int]$row, [string]$text, $fg, $bg)
            if ($text.Length -gt $width) { $text = $text.Substring(0, $width - 1) + '…' }
            [Console]::SetCursorPosition(0, $top + $row)
            $p = @{ Object = $text.PadRight($width); NoNewline = $true }
            if ($fg) { $p.ForegroundColor = $fg }
            if ($bg) { $p.BackgroundColor = $bg }
            Write-Host @p
        }

        while ($true) {
            $visible = @(Get-Visible)
            $listRows = if ($previewOn) { $region - $previewRows } else { $region }
            if ($cursor -ge $visible.Count) { $cursor = [Math]::Max(0, $visible.Count - 1) }
            if ($cursor -lt $offset) { $offset = $cursor }
            if ($cursor -ge $offset + $listRows) { $offset = $cursor - $listRows + 1 }

            & $line 0 $Title Cyan $null
            $help = '[↑↓] move · [Space] mark · [a] all matching · [n] none · '
            if ($flagCount -gt 0) { $help += "[d] $FlagLabel · " }
            if ($Preview) { $help += '[p] preview · ' }
            $help += '[/] filter · [Enter] done · [Esc/Ctrl+C] cancel'
            & $line 1 $help DarkGray $null
            $filterText = if ($filtering) { "filter: $filter▏" } elseif ($filter) { "filter: $filter  (/ to edit)" } else { '' }
            & $line 2 $filterText Yellow $null

            for ($r = 0; $r -lt $listRows; $r++) {
                $vi = $offset + $r
                if ($vi -ge $visible.Count) {
                    & $line (3 + $r) '' $null $null
                    continue
                }
                $idx = $visible[$vi]
                $mark = if ($selected.Contains($idx)) { '[x]' } else { '[ ]' }
                $arrow = if ($vi -eq $cursor) { '>' } else { ' ' }
                $fg = if ($flags[$idx]) { 'Red' } elseif ($selected.Contains($idx)) { 'Green' } else { $null }
                $bg = if ($vi -eq $cursor) { 'DarkGray' } else { $null }
                & $line (3 + $r) "$arrow $mark $($items[$idx])" $fg $bg
            }

            # Rows below the list: preview, or blank when it is off.
            $pv = @()
            if ($previewOn -and $visible.Count -gt 0) {
                $cur = $items[$visible[$cursor]]
                if (-not $previewCache.ContainsKey($cur)) {
                    $previewCache[$cur] = try { @(& $Preview $cur | Select-Object -First ($previewRows - 1)) } catch { @('(preview failed)') }
                }
                $pv = $previewCache[$cur]
            }
            for ($r = $listRows; $r -lt $region; $r++) {
                $k = $r - $listRows
                if (-not $previewOn) { & $line (3 + $r) '' $null $null }
                elseif ($k -eq 0) { & $line (3 + $r) '── preview ──' DarkCyan $null }
                elseif ($k - 1 -lt $pv.Count) { & $line (3 + $r) "  $($pv[$k - 1] -replace "`t", '  ')" DarkGray $null }
                else { & $line (3 + $r) '' $null $null }
            }

            $first = if ($visible.Count) { $offset + 1 } else { 0 }
            $last = [Math]::Min($offset + $listRows, $visible.Count)
            $status = "$($selected.Count) marked · rows $first-$last of $($visible.Count) · on row $(if ($visible.Count) { $cursor + 1 } else { 0 })"
            if ($filter) { $status += " (filter matches, $($items.Count) in total)" }
            elseif ($last -lt $visible.Count) { $status += ' (↓ for more)' }
            if ($flagCount -gt 0) { $status += " · $flagCount $FlagLabel (red)" }
            & $line ($total - 1) $status DarkCyan $null

            $key = [Console]::ReadKey($true)
            # Depending on the host, Ctrl+C arrives as a plain key instead of an interrupt.
            if ($key.Key -eq 'C' -and ($key.Modifiers -band [ConsoleModifiers]::Control)) {
                $cancelled = $true
                break
            }
            $handled = $true
            switch ($key.Key) {
                'UpArrow'   { if ($cursor -gt 0) { $cursor-- } }
                'DownArrow' { if ($cursor -lt $visible.Count - 1) { $cursor++ } }
                'PageUp'    { $cursor = [Math]::Max(0, $cursor - $listRows) }
                'PageDown'  { $cursor = [Math]::Min([Math]::Max(0, $visible.Count - 1), $cursor + $listRows) }
                'Home'      { $cursor = 0 }
                'End'       { $cursor = [Math]::Max(0, $visible.Count - 1) }
                'Enter'     { if ($filtering) { $filtering = $false } else { $done = $true } }
                'Escape'    { if ($filtering) { $filtering = $false } else { $cancelled = $true; $done = $true } }
                default     { $handled = $false }
            }
            if ($done) { break }
            if ($handled) { continue }

            if ($filtering) {
                if ($key.Key -eq 'Backspace') {
                    if ($filter.Length -gt 0) { $filter = $filter.Substring(0, $filter.Length - 1); $cursor = 0; $offset = 0 }
                } elseif ($key.KeyChar -and -not [char]::IsControl($key.KeyChar)) {
                    $filter += $key.KeyChar; $cursor = 0; $offset = 0
                }
                continue
            }

            switch ($key.KeyChar) {
                ' ' {
                    if ($visible.Count -gt 0) {
                        $idx = $visible[$cursor]
                        if (-not $selected.Remove($idx)) { [void]$selected.Add($idx) }
                    }
                }
                'a' {
                    $allOn = $visible.Count -gt 0 -and @($visible | Where-Object { -not $selected.Contains($_) }).Count -eq 0
                    foreach ($v in $visible) { if ($allOn) { [void]$selected.Remove($v) } else { [void]$selected.Add($v) } }
                }
                'n' { $selected.Clear() }
                'd' { if ($Flag) { foreach ($v in $visible) { if ($flags[$v]) { [void]$selected.Add($v) } } } }
                '/' { $filtering = $true }
                'p' { if ($Preview) { $previewOn = -not $previewOn } }
                'q' { $cancelled = $true; $done = $true }
            }
            if ($done) { break }
        }
    }
    finally {
        [Console]::SetCursorPosition(0, $top + $total)
        [Console]::CursorVisible = $oldCursorVisible
        [Console]::TreatControlCAsInput = $oldCtrlC
    }

    [pscustomobject]@{
        Cancelled = $cancelled
        Items     = @($selected | Sort-Object | ForEach-Object { $items[$_] })
    }
}
