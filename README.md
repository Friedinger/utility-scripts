# mise-helpers

Small PowerShell helpers for [mise](https://mise.jdx.dev) — for the things mise
itself has no command for.

## tracked-configs

`remove-mise-tracked.ps1` removes an entry from mise's tracked-configs cache.

mise remembers every config file it has ever seen, in every directory you have
been in. Entries for archived or deleted projects therefore stick around and
keep showing up in `mise ls --all-sources`. `mise trust` / `mise untrust` do not
help here — they manage a different list (`trusted-configs`), and mise ships no
command for removing tracked entries at all. This script deletes the entry.

### Requirements

- [mise](https://mise.jdx.dev) on `PATH`
- PowerShell 7 (`pwsh`)

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
