<#
.SYNOPSIS
  Small console multi-select list (TUI), meant to be dot-sourced.

.DESCRIPTION
  Shows a scrollable list in the console. Keys:
    Up/Down, PgUp/PgDn, Home/End   move
    Space                          mark / unmark the current item
    a                              mark all items matching the filter (or unmark them if all are marked)
    g                              switch between list and folder tree (only with -Tree)
    Left/Right                     tree: collapse / expand the folder (Left on an entry: jump to its folder)
    n                              unmark everything
    d                              mark all matching flagged items (only with -Flag)
    f, /                           live filter, Enter or Esc leaves the filter input
    Enter                          done
    Esc / q                        cancel

  Returns an object with `Cancelled` (bool) and `Items` (the marked items, in
  their original order). Needs an interactive console.

.PARAMETER Items
  The entries to choose from: strings, or objects (PSCustomObject) with
    Text    the line shown in the list (and matched by the filter)
    Label   optional, the name shown in the tree instead of Text
    Path    optional, the folders of the entry in the tree (string[]); without
            it the tree is built by splitting Text at \ and /
    Marked  optional, $true to start with the entry marked
  Flag, Preview and Action receive the item as passed in, and the result
  contains the marked items as passed in.

.PARAMETER Title
  Header line above the list.

.PARAMETER Flag
  Optional scriptblock that receives an item and returns $true for items that
  should be highlighted in red (for example entries that no longer exist).

.PARAMETER FlagLabel
  Name of the flagged group, used in the help line and status line.

.PARAMETER Tree
  Treat the items as paths and allow g to show them as a folder tree instead
  of a flat list. Folders that only contain one folder are shown as one row
  (C:\Users\me\src), Space on a folder marks everything below it, and a
  folder is red when everything below it is flagged.

.PARAMETER Preview
  Optional scriptblock that receives the item under the cursor and returns up
  to 5 lines of text. Shown below the list; toggled on and off with p (on by
  default). Results are cached per item.

.PARAMETER NoFlagKey
  Only color the flagged items red, without the d key that marks them. Use it
  when flagged means "careful" rather than "good candidate".

.PARAMETER Action
  Extra keys, as @{ 'v' = @{ Label = 'diff'; Run = { param($item) ... } } }.
  The key shows up in the help bar. Run gets the item under the cursor and
  runs in the normal console (so it can open a pager); the list is redrawn
  afterwards. Keys that are already used by the list are ignored.

.EXAMPLE
  . "$PSScriptRoot\..\lib\Select-ConsoleItem.ps1"
  $r = Select-ConsoleItem -Items $paths -Flag { param($p) -not (Test-Path -LiteralPath $p) } -FlagLabel missing
  if (-not $r.Cancelled) { $r.Items }
#>

function Select-ConsoleItem {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [object[]]$Items,

        [string]$Title = 'Select items',

        [scriptblock]$Flag,

        [string]$FlagLabel = 'flagged',

        [scriptblock]$Preview,

        [switch]$Tree,

        [hashtable]$Action,

        [switch]$NoFlagKey
    )

    if ([Console]::IsInputRedirected -or [Console]::IsOutputRedirected) {
        throw 'Select-ConsoleItem needs an interactive console.'
    }

    # Items are strings, or objects with Text (and optionally Label, Path, Marked).
    $source = @($Items)
    $texts = [string[]]::new($source.Count)
    $labels = [string[]]::new($source.Count)
    $paths = [object[]]::new($source.Count)
    $selected = [System.Collections.Generic.HashSet[int]]::new()
    for ($i = 0; $i -lt $source.Count; $i++) {
        $it = $source[$i]
        if ($it -is [string]) {
            $texts[$i] = $it
        }
        else {
            $props = $it.PSObject.Properties
            $texts[$i] = [string]$it.Text
            if ($props['Label']) { $labels[$i] = [string]$it.Label }
            if ($props['Path']) { $paths[$i] = @($it.Path) }
            if ($props['Marked'] -and $it.Marked) { [void]$selected.Add($i) }
        }
    }

    $flags = [bool[]]::new($texts.Count)
    if ($Flag) {
        for ($i = 0; $i -lt $texts.Count; $i++) {
            $flags[$i] = [bool](& $Flag $source[$i])
        }
    }
    $flagCount = @($flags | Where-Object { $_ }).Count

    $treeMode = $false
    $collapsed = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $pendingIdx = -1

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
        [Math]::Max($previewRows + 3, [Math]::Min($texts.Count + $previewRows, [Console]::WindowHeight - 6))
    } else {
        [Math]::Max(3, [Math]::Min($texts.Count, [Console]::WindowHeight - 6))
    }
    $total = $region + 4

    function Get-Visible {
        if ($texts.Count -eq 0) { return @() }
        if (-not $filter) { return @(0..($texts.Count - 1)) }
        @(0..($texts.Count - 1) | Where-Object {
            $texts[$_].IndexOf($filter, [StringComparison]::OrdinalIgnoreCase) -ge 0
        })
    }

    function New-TreeNode([string]$name, [string]$path) {
        @{
            Name  = $name
            Path  = $path
            Dirs  = [System.Collections.Generic.Dictionary[string, object]]::new([StringComparer]::OrdinalIgnoreCase)
            Files = [System.Collections.Generic.List[object]]::new()
            All   = [System.Collections.Generic.List[int]]::new()
        }
    }

    # Appends the rows of one tree level: folders first (chains of single-child
    # folders are shown as one row), then the entries. Collapsed folders hide their children.
    function Add-TreeRows($node, [int]$depth, [int]$parent, $out) {
        foreach ($name in @($node.Dirs.Keys | Sort-Object)) {
            $d = $node.Dirs[$name]
            $label = $name
            while ($d.Dirs.Count -eq 1 -and $d.Files.Count -eq 0) {
                $only = @($d.Dirs.Values)[0]
                $label += '\' + $only.Name
                $d = $only
            }
            if ($d.Dirs.Count -eq 0 -and $d.Files.Count -eq 1) {
                # A folder with a single entry is shown as that entry, no extra level.
                $f = $d.Files[0]
                $out.Add([pscustomobject]@{
                    Kind = 'item'; Index = $f.Index; Text = "$label\$($f.Label)"; Depth = $depth; Id = $null
                    Leaves = @($f.Index); Open = $false; Parent = $parent
                })
                continue
            }
            $open = -not $collapsed.Contains($d.Path)
            $out.Add([pscustomobject]@{
                Kind = 'dir'; Index = -1; Text = $label; Depth = $depth; Id = $d.Path
                Leaves = $d.All.ToArray(); Open = $open; Parent = $parent
            })
            if ($open) { Add-TreeRows $d ($depth + 1) ($out.Count - 1) $out }
        }
        foreach ($f in @($node.Files | Sort-Object { $_.Label })) {
            $out.Add([pscustomobject]@{
                Kind = 'item'; Index = $f.Index; Text = $f.Label; Depth = $depth; Id = $null
                Leaves = @($f.Index); Open = $false; Parent = $parent
            })
        }
    }

    # The rows to draw: one per shown item, or a folder tree of them.
    function Get-Rows($visible) {
        if (-not $treeMode) {
            return @($visible | ForEach-Object {
                [pscustomobject]@{
                    Kind = 'item'; Index = $_; Text = $texts[$_]; Depth = 0; Id = $null
                    Leaves = @($_); Open = $false; Parent = -1
                }
            })
        }
        $root = New-TreeNode '' ''
        foreach ($idx in $visible) {
            if ($paths[$idx]) {
                # Explicit folders (so names like feature/x are not split), the label is the entry.
                $leafLabel = if ($labels[$idx]) { $labels[$idx] } else { $texts[$idx] }
                $segs = @($paths[$idx]) + $leafLabel
            }
            else {
                $segs = @($texts[$idx] -split '[\\/]' | Where-Object { $_ })
                if ($segs.Count -eq 0) { $segs = @($texts[$idx]) }
            }
            $node = $root
            $node.All.Add($idx)
            for ($s = 0; $s -lt $segs.Count - 1; $s++) {
                if (-not $node.Dirs.ContainsKey($segs[$s])) {
                    $node.Dirs[$segs[$s]] = New-TreeNode $segs[$s] "$($node.Path)\$($segs[$s])"
                }
                $node = $node.Dirs[$segs[$s]]
                $node.All.Add($idx)
            }
            $node.Files.Add([pscustomobject]@{ Index = $idx; Label = $segs[-1] })
        }
        $out = [System.Collections.Generic.List[object]]::new()
        Add-TreeRows $root 0 -1 $out
        $out.ToArray()
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
            $rows = @(Get-Rows $visible)
            if ($pendingIdx -ge 0) {
                # Keep the same entry under the cursor after switching list <-> tree.
                for ($q = 0; $q -lt $rows.Count; $q++) {
                    if ($rows[$q].Kind -eq 'item' -and $rows[$q].Index -eq $pendingIdx) { $cursor = $q; break }
                }
                $pendingIdx = -1
            }
            $listRows = if ($previewOn) { $region - $previewRows } else { $region }
            if ($cursor -ge $rows.Count) { $cursor = [Math]::Max(0, $rows.Count - 1) }
            if ($cursor -lt $offset) { $offset = $cursor }
            if ($cursor -ge $offset + $listRows) { $offset = $cursor - $listRows + 1 }

            # The filter lives in the title line, so the header needs no extra row.
            $titleText = $Title
            if ($filtering) { $titleText += "   filter: $filter▏" }
            elseif ($filter) { $titleText += "   filter: $filter  (f to edit)" }
            & $line 0 $titleText Cyan $null
            # Help bar, wrapped onto two lines at a key boundary.
            $keys = [System.Collections.Generic.List[string]]::new()
            $keys.AddRange([string[]]@('[↑↓] move', '[Space] mark', '[a] all matching', '[n] none'))
            if ($flagCount -gt 0 -and -not $NoFlagKey) { $keys.Add("[d] $FlagLabel") }
            if ($Tree -and $treeMode) { $keys.AddRange([string[]]@('[←→] fold', '[g] list')) }
            elseif ($Tree) { $keys.Add('[g] tree') }
            if ($Preview) { $keys.Add('[p] preview') }
            if ($Action) { foreach ($ak in $Action.Keys) { $keys.Add("[$ak] $($Action[$ak].Label)") } }
            $keys.AddRange([string[]]@('[f] filter', '[Enter] done', '[Esc/Ctrl+C] cancel'))
            $help1 = ''
            $help2 = ''
            foreach ($hk in $keys) {
                if (-not $help2 -and ($help1.Length + $hk.Length + 3) -le $width) { $help1 += $(if ($help1) { ' · ' } else { '' }) + $hk }
                else { $help2 += $(if ($help2) { ' · ' } else { '' }) + $hk }
            }
            & $line 1 $help1 DarkGray $null
            & $line 2 $help2 DarkGray $null

            for ($r = 0; $r -lt $listRows; $r++) {
                $vi = $offset + $r
                if ($vi -ge $rows.Count) {
                    & $line (3 + $r) '' $null $null
                    continue
                }
                $row = $rows[$vi]
                $arrow = if ($vi -eq $cursor) { '>' } else { ' ' }
                $bg = if ($vi -eq $cursor) { 'DarkGray' } else { $null }
                $indent = '  ' * $row.Depth
                $on = @($row.Leaves | Where-Object { $selected.Contains($_) }).Count
                $all = $on -eq $row.Leaves.Count
                if ($row.Kind -eq 'dir') {
                    $mark = if ($on -eq 0) { '[ ]' } elseif ($all) { '[x]' } else { '[-]' }
                    $glyph = if ($row.Open) { '▾' } else { '▸' }
                    $allFlagged = [bool]$Flag -and @($row.Leaves | Where-Object { -not $flags[$_] }).Count -eq 0
                    $fg = if ($allFlagged) { 'Red' } elseif ($all) { 'Green' } else { 'Cyan' }
                    $text = "$arrow $indent$mark $glyph $($row.Text)  ($($row.Leaves.Count))"
                }
                else {
                    $mark = if ($all) { '[x]' } else { '[ ]' }
                    $fg = if ($flags[$row.Index]) { 'Red' } elseif ($all) { 'Green' } else { $null }
                    $pad = if ($treeMode) { '  ' } else { '' }
                    $text = "$arrow $indent$mark $pad$($row.Text)"
                }
                & $line (3 + $r) $text $fg $bg
            }

            # Rows below the list: preview, or blank when it is off.
            $pv = @()
            if ($previewOn -and $rows.Count -gt 0) {
                $curRow = $rows[$cursor]
                if ($curRow.Kind -eq 'dir') {
                    $pv = @("$($curRow.Leaves.Count) entries in this folder")
                }
                else {
                    $ci = $curRow.Index
                    if (-not $previewCache.ContainsKey($ci)) {
                        $previewCache[$ci] = try { @(& $Preview $source[$ci] | Select-Object -First ($previewRows - 1)) } catch { @('(preview failed)') }
                    }
                    $pv = @($previewCache[$ci])
                }
            }
            for ($r = $listRows; $r -lt $region; $r++) {
                $k = $r - $listRows
                if (-not $previewOn) { & $line (3 + $r) '' $null $null }
                elseif ($k -eq 0) { & $line (3 + $r) '── preview ──' DarkCyan $null }
                elseif ($k - 1 -lt $pv.Count) { & $line (3 + $r) "  $($pv[$k - 1] -replace "`t", '  ')" DarkGray $null }
                else { & $line (3 + $r) '' $null $null }
            }

            $first = if ($rows.Count) { $offset + 1 } else { 0 }
            $last = [Math]::Min($offset + $listRows, $rows.Count)
            $status = "$($selected.Count) marked · rows $first-$last of $($rows.Count) · on row $(if ($rows.Count) { $cursor + 1 } else { 0 })"
            if ($treeMode) { $status += ' · tree' }
            if ($filter) { $status += " (filter matches $($visible.Count) of $($texts.Count) entries)" }
            elseif ($last -lt $rows.Count) { $status += ' (↓ for more)' }
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
                'DownArrow' { if ($cursor -lt $rows.Count - 1) { $cursor++ } }
                'PageUp'    { $cursor = [Math]::Max(0, $cursor - $listRows) }
                'PageDown'  { $cursor = [Math]::Min([Math]::Max(0, $rows.Count - 1), $cursor + $listRows) }
                'Home'      { $cursor = 0 }
                'End'       { $cursor = [Math]::Max(0, $rows.Count - 1) }
                'LeftArrow' {
                    # Collapse the folder, or jump to the parent folder.
                    if ($treeMode -and $rows.Count) {
                        $row = $rows[$cursor]
                        if ($row.Kind -eq 'dir' -and $row.Open) { [void]$collapsed.Add($row.Id) }
                        elseif ($row.Parent -ge 0) { $cursor = $row.Parent }
                    }
                }
                'RightArrow' {
                    # Expand the folder, or step into it.
                    if ($treeMode -and $rows.Count) {
                        $row = $rows[$cursor]
                        if ($row.Kind -eq 'dir' -and -not $row.Open) { [void]$collapsed.Remove($row.Id) }
                        elseif ($row.Kind -eq 'dir' -and $cursor -lt $rows.Count - 1) { $cursor++ }
                    }
                }
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
                    # An entry toggles itself, a folder toggles everything below it.
                    if ($rows.Count -gt 0) {
                        $leaves = $rows[$cursor].Leaves
                        $allOn = @($leaves | Where-Object { -not $selected.Contains($_) }).Count -eq 0
                        foreach ($l in $leaves) { if ($allOn) { [void]$selected.Remove($l) } else { [void]$selected.Add($l) } }
                    }
                }
                'a' {
                    $allOn = $visible.Count -gt 0 -and @($visible | Where-Object { -not $selected.Contains($_) }).Count -eq 0
                    foreach ($v in $visible) { if ($allOn) { [void]$selected.Remove($v) } else { [void]$selected.Add($v) } }
                }
                'g' {
                    if ($Tree) {
                        $pendingIdx = if ($rows.Count -and $rows[$cursor].Kind -eq 'item') { $rows[$cursor].Index } else { -1 }
                        $treeMode = -not $treeMode
                        $cursor = 0
                        $offset = 0
                    }
                }
                'n' { $selected.Clear() }
                'd' { if ($Flag -and -not $NoFlagKey) { foreach ($v in $visible) { if ($flags[$v]) { [void]$selected.Add($v) } } } }
                { $_ -in "f", "/" } { $filtering = $true }
                'p' { if ($Preview) { $previewOn = -not $previewOn } }
                'q' { $cancelled = $true; $done = $true }
                default {
                    $ak = "$($key.KeyChar)".ToLowerInvariant()
                    if ($Action -and $ak -and $Action.ContainsKey($ak) -and $rows.Count -gt 0 -and $rows[$cursor].Kind -eq 'item') {
                        # Leave the list, run the action in the normal console (it may open a
                        # pager), then reserve the list area again and redraw.
                        [Console]::SetCursorPosition(0, $top + $total)
                        [Console]::CursorVisible = $oldCursorVisible
                        [Console]::TreatControlCAsInput = $oldCtrlC
                        try { & $Action[$ak].Run $source[$rows[$cursor].Index] | Out-Host }
                        catch {
                            Write-Host "Action failed: $($_.Exception.Message)" -ForegroundColor Red
                            Write-Host 'Press any key...' -ForegroundColor DarkGray
                            [void][Console]::ReadKey($true)
                        }
                        [Console]::CursorVisible = $false
                        [Console]::TreatControlCAsInput = $true
                        1..$total | ForEach-Object { Write-Host '' }
                        $top = [Console]::CursorTop - $total
                    }
                }
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
        Items     = @($selected | Sort-Object | ForEach-Object { $source[$_] })
    }
}
