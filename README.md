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
.\Remove-MiseTrackedConfig.ps1 -Missing -Permanent
```

Keys in the interactive list (entries that no longer exist are red):

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

Removed entries go to the recycle bin by default (restoring a file brings the entry
back). The confirmation offers recycle bin (Enter), permanent or no; `-Force` uses
the recycle bin, `-Permanent` deletes for good. Matching is case-insensitive.
The list picker lives in `lib/Select-ConsoleItem.ps1` and can be reused by other
scripts.

Note that mise re-adds the entry as soon as you `cd` into that project, so this
is only useful for projects you are done with.

## Sync-GitRepos

`Sync-GitRepos.ps1` keeps every project folder on its default branch and up to
date.

It works for every Git repo under a root folder (searched recursively, not
descending into repos, `node_modules` or hidden folders) in three steps.

**1. Sync, no questions.** It fetches, detects the repo's actual default branch
(via `origin/HEAD`, works for `main`, `master` or anything else) and
fast-forwards it. If another branch is checked out, the default branch is
updated without switching. Local changes are kept as long as they do not touch
files the update changes. Branches already fully merged are deleted. Every repo
gets one result line (`Updated`, `Up to date`, `Skipped`, `Failed`).

**2. Review, one list.** Everything that needs a decision is collected into a
single folder tree, grouped by repo, with the sensible entries already marked
(same keys as in Remove-MiseTrackedConfig, `v` shows the full diff):

| Entry | Pre-marked |
| --- | --- |
| Delete a branch whose changes are already in the default branch (squash or rebase merged) | yes |
| Switch to the default branch and delete the current branch, because it is done | yes |
| Delete a branch whose upstream is gone but which has commits not in the default branch | no, red |
| Switch to the default branch, leaving a branch with unmerged work | no |
| Reset a diverged default branch to origin (local commits go to a `backup/...` branch) | no, red |
| Stash local changes, update, restore them (when they touch incoming files) | no |
| `npm install` for updated repos that already had `node_modules` | no |

**3. Run and summary.** The marked entries run, then a summary counts the
results and lists the repos that still need attention. Nothing happens to an
entry you do not mark, and uncommitted changes are never discarded.

Works inside OneDrive: repos whose `.git` folder is not fully available
locally (and online-only folders) are silently skipped, so nothing gets
downloaded for them.

### Requirements

- Git (2.38 or newer to recognize squash-merged branches), and Node/npm if you use `-InstallDeps`
- PowerShell 5.1 (`powershell`) or 7 (`pwsh`)

### Usage

```powershell
# syncs the current folder's subfolders
.\Sync-GitRepos.ps1

# syncs a specific folder, npm installs every updated repo without asking
.\Sync-GitRepos.ps1 C:\Projects -InstallDeps:$true

# never npm install, and only do the pre-marked cleanup entries without the list
.\Sync-GitRepos.ps1 C:\Projects -InstallDeps:$false -Cleanup:$true

# sync only, no cleanup and no list
.\Sync-GitRepos.ps1 C:\Projects -InstallDeps:$false -Cleanup:$false

# only look two folder levels deep
.\Sync-GitRepos.ps1 C:\Projects -MaxDepth 2
```

To try it out without touching real repos, `test\New-SyncTestRepos.ps1` builds
a sandbox of throwaway repos in every situation the script handles (behind,
merged and squash-merged branches, diverged `main`, local changes, ...) in the
temp folder and prints the command to run. Run it again for a fresh sandbox, or
delete it with `test\Remove-SyncTestRepos.ps1`.

Double-click `Sync-GitRepos.cmd` for the same, defaulting to the folder it's
placed in (copy or shortcut it into whichever folder you want to sync).

If `C:\path\to\your\personal\bin` (or wherever you keep your personal `PATH`) has
a `Sync-GitRepos.cmd` shim pointing at this script, `Sync-GitRepos` also works from
any terminal, in the current directory, without cloning this repo.
