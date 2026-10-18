# mise-tracked-configs

`Remove-MiseTrackedConfig.ps1` removes entries from mise's tracked-configs cache.

mise remembers every config file it has ever seen, in every directory you have
been in. Entries for archived or deleted projects therefore stick around and
keep showing up in `mise ls --all-sources`. `mise trust` / `mise untrust` do not
help here — they manage a different list (`trusted-configs`), and mise ships no
command for removing tracked entries at all. This script deletes the entries.

## Requirements

- [mise](https://mise.jdx.dev) on `PATH`
- PowerShell 5.1 (`powershell`) or 7 (`pwsh`)

## Usage

Double-click `Remove-MiseTrackedConfig.cmd` for the interactive version, or call the
script directly.

```powershell
# interactive list: mark entries, then review and confirm
.\Remove-MiseTrackedConfig.ps1

# direct, still lists the entries and asks to confirm
.\Remove-MiseTrackedConfig.ps1 'C:\path\to\mise.toml'

# several paths and wildcards
.\Remove-MiseTrackedConfig.ps1 'D:\Archive\*', 'C:\old\mise.toml'

# everything whose config file no longer exists (optionally narrowed by -Path)
.\Remove-MiseTrackedConfig.ps1 -Missing

# skip the confirmation (-Force, or -y), or just preview with -WhatIf
.\Remove-MiseTrackedConfig.ps1 -Missing -y
.\Remove-MiseTrackedConfig.ps1 -Missing -WhatIf

# delete for good instead of using the recycle bin
.\Remove-MiseTrackedConfig.ps1 -Missing -Permanent
```

## The interactive list

Entries that no longer exist are red. The list is the shared picker in
[`../lib/Select-ConsoleItem.ps1`](../lib/Select-ConsoleItem.ps1), which
[Sync-GitRepos](../sync-git-repos/README.md) uses as well.

| Key | Action |
| --- | --- |
| `↑` `↓` `PgUp` `PgDn` | move |
| `Space` | mark / unmark |
| `a` / `n` | mark all matching the filter (all without one) / unmark all |
| `g` | switch between flat list and folder tree |
| `←` `→` | tree: collapse / expand a folder (`Space` on a folder marks everything below) |
| `d` | mark all missing entries |
| `p` | preview on / off (modified date and first lines of the config) |
| `f` / `/` | live filter (`Enter` or `Esc` leaves it) |
| `Enter` | done, then review and confirm |
| `Esc` / `q` / `Ctrl+C` | cancel |

## Removing

Removed entries go to the recycle bin by default (restoring a file brings the entry
back). The confirmation offers recycle bin (Enter), permanent or no; `-Force` uses
the recycle bin, `-Permanent` deletes for good. Matching is case-insensitive.

Note that mise re-adds the entry as soon as you `cd` into that project, so this
is only useful for projects you are done with.
