# utility-scripts

Small utility scripts for the gaps my usual tools leave behind. Mostly
PowerShell, one topic per subfolder.

## mise-tracked-configs

`Remove-MiseTrackedConfig.ps1` removes entries from mise's tracked-configs cache.

mise remembers every config file it has ever seen, in every directory you have
been in. Entries for archived or deleted projects therefore stick around and
keep showing up in `mise ls --all-sources`. `mise trust` / `mise untrust` do not
help here — they manage a different list (`trusted-configs`), and mise ships no
command for removing tracked entries at all. This script deletes the entries.

### Requirements

- [mise](https://mise.jdx.dev) on `PATH`
- PowerShell 5.1 (`powershell`) or 7 (`pwsh`)

### Usage

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
.Remove-MiseTrackedConfig.ps1 -Missing -Permanent
```

Keys in the interactive list (entries that no longer exist are red):

| Key | Action |
| --- | --- |
| `↑` `↓` `PgUp` `PgDn` | move |
| `Space` | mark / unmark |
| `a` / `n` | mark all shown / unmark all |
| `d` | mark all missing entries |
| `p` | preview on / off (modified date and first lines of the config) |
| `/` | live filter (`Enter` or `Esc` leaves it) |
| `Enter` | done, then review and confirm |
| `Esc` / `q` | cancel |

Removed entries go to the recycle bin by default (restoring a file brings the entry
back). The confirmation offers recycle bin (Enter), permanent or no; `-Force` uses
the recycle bin, `-Permanent` deletes for good. Matching is case-insensitive. The list picker lives in `lib/Select-ConsoleItem.ps1`
and can be reused by other scripts.

Note that mise re-adds the entry as soon as you `cd` into that project, so this
is only useful for projects you are done with.

## Sync-GitRepos

`Sync-GitRepos.ps1` keeps every project folder on its default branch and up to
date.

For every Git repo under a root folder (searched recursively, not descending
into repos, `node_modules` or hidden folders), it fetches, detects the
repo's actual default branch (via `origin/HEAD`, works for `main`, `master` or
anything else), fast-forwards it, deletes local branches already merged into
it, and optionally runs `npm install`/`npm ci`. Repos with uncommitted changes
are left untouched.

Works inside OneDrive: repos whose `.git` folder is not fully available
locally (and online-only folders) are silently skipped, so nothing gets
downloaded for them. `npm install` is only offered when a repo was updated and
already had `node_modules`.

### Requirements

- Git, and Node/npm if you use `-InstallDeps`
- PowerShell 5.1 (`powershell`) or 7 (`pwsh`)

### Usage

```powershell
# syncs the current folder's subfolders
.\Sync-GitRepos.ps1

# syncs a specific folder, and npm install/ci where a repo was updated
.\Sync-GitRepos.ps1 C:\Projects -InstallDeps

# only look two folder levels deep
.\Sync-GitRepos.ps1 C:\Projects -MaxDepth 2
```

Double-click `Sync-GitRepos.cmd` for the same, defaulting to the folder it's
placed in (copy or shortcut it into whichever folder you want to sync).

If `C:\path\to\your\personal\bin` (or wherever you keep your personal `PATH`) has
a `Sync-GitRepos.cmd` shim pointing at this script, `Sync-GitRepos` also works from
any terminal, in the current directory, without cloning this repo.
