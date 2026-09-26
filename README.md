# utility-scripts

Small utility scripts for the gaps my usual tools leave behind. Mostly
PowerShell, one topic per subfolder.

## mise-tracked-configs

`remove-mise-tracked.ps1` removes an entry from mise's tracked-configs cache.

mise remembers every config file it has ever seen, in every directory you have
been in. Entries for archived or deleted projects therefore stick around and
keep showing up in `mise ls --all-sources`. `mise trust` / `mise untrust` do not
help here — they manage a different list (`trusted-configs`), and mise ships no
command for removing tracked entries at all. This script deletes the entry.

### Requirements

- [mise](https://mise.jdx.dev) on `PATH`
- PowerShell 5.1 (`powershell`) or 7 (`pwsh`)

### Usage

Double-click `remove-mise-tracked.cmd` for the interactive version, or call the
script directly.

```powershell
# interactive: lists all tracked configs, then asks for one
.\remove-mise-tracked.ps1

# pick the path directly, still asks to confirm
.\remove-mise-tracked.ps1 'C:\path\to\mise.toml'

# skip the confirmation (-Force, or -y)
.\remove-mise-tracked.ps1 'C:\path\to\mise.toml' -y
```

Matching is exact, but case-insensitive. Press Enter or Ctrl+C to abort.

Note that mise re-adds the entry as soon as you `cd` into that project, so this
is only useful for projects you are done with.

## sync-repos

`sync-repos.ps1` keeps every project folder on its default branch and up to
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
.\sync-repos.ps1

# syncs a specific folder, and npm install/ci where a repo was updated
.\sync-repos.ps1 C:\Projects -InstallDeps
```

Double-click `sync-repos.cmd` for the same, defaulting to the folder it's
placed in (copy or shortcut it into whichever folder you want to sync).

If `C:\path\to\your\personal\bin` (or wherever you keep your personal `PATH`) has
a `sync-repos.cmd` shim pointing at this script, `sync-repos` also works from
any terminal, in the current directory, without cloning this repo.
