# utility-scripts

Small utility scripts for the gaps my usual tools leave behind. Mostly
PowerShell, one topic per subfolder.

## mise-tracked-configs

`Remove-MiseTrackedConfig.ps1` removes an entry from mise's tracked-configs cache.

mise remembers every config file it has ever seen, in every directory you have
been in. Entries for archived or deleted projects therefore stick around and
keep showing up in `mise ls --all-sources`. `mise trust` / `mise untrust` do not
help here — they manage a different list (`trusted-configs`), and mise ships no
command for removing tracked entries at all. This script deletes the entry.

### Requirements

- [mise](https://mise.jdx.dev) on `PATH`
- PowerShell 5.1 (`powershell`) or 7 (`pwsh`)

### Usage

Double-click `Remove-MiseTrackedConfig.cmd` for the interactive version, or call the
script directly.

```powershell
# interactive: lists all tracked configs, then asks for one
.\Remove-MiseTrackedConfig.ps1

# pick the path directly, still asks to confirm
.\Remove-MiseTrackedConfig.ps1 'C:\path\to\mise.toml'

# skip the confirmation (-Force, or -y)
.\Remove-MiseTrackedConfig.ps1 'C:\path\to\mise.toml' -y
```

Matching is exact, but case-insensitive. Press Enter or Ctrl+C to abort.

Note that mise re-adds the entry as soon as you `cd` into that project, so this
is only useful for projects you are done with.

## Sync-GitRepos

`Sync-GitRepos.ps1` keeps every project folder on its default branch and up to
date.

For every Git repo directly under a root folder, it fetches, detects the
repo's actual default branch (via `origin/HEAD`, works for `main`, `master` or
anything else), fast-forwards it, deletes local branches already merged into
it, and optionally runs `npm install`/`npm ci`. Repos with uncommitted changes
are left untouched.

### Requirements

- Git, and Node/npm if you use `-InstallDeps`
- PowerShell 5.1 (`powershell`) or 7 (`pwsh`)

### Usage

```powershell
# syncs the current folder's subfolders
.\Sync-GitRepos.ps1

# syncs a specific folder, and npm install/ci where a repo was updated
.\Sync-GitRepos.ps1 C:\Projects -InstallDeps
```

Double-click `Sync-GitRepos.cmd` for the same, defaulting to the folder it's
placed in (copy or shortcut it into whichever folder you want to sync).

If `C:\path\to\your\personal\bin` (or wherever you keep your personal `PATH`) has
a `Sync-GitRepos.cmd` shim pointing at this script, `Sync-GitRepos` also works from
any terminal, in the current directory, without cloning this repo.
