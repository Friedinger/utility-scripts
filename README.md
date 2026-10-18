# utility-scripts

[![Last Commit](https://img.shields.io/github/last-commit/Friedinger/utility-scripts?style=flat-square&color=orange)](https://github.com/Friedinger/utility-scripts/commits/main)
[![License: MIT](https://img.shields.io/github/license/Friedinger/utility-scripts?style=flat-square&color=yellow)](LICENSE)

Small utility scripts for the gaps my usual tools leave behind. Mostly
PowerShell, one topic per subfolder, each with its own README.

## [mise-tracked-configs](mise-tracked-configs/README.md)

[mise](https://mise.jdx.dev) remembers every config file it has ever seen, so
archived or deleted projects keep showing up in `mise ls --all-sources`, and
mise has no command to forget them.

`Remove-MiseTrackedConfig.ps1` does that: an interactive list (filter, folder
tree, preview) to mark the entries to drop, or `-Path` / `-Missing` for scripted
use. Removed entries go to the recycle bin, so a mistake is easy to undo.

## [sync-git-repos](sync-git-repos/README.md)

With a lot of projects in one folder, getting every repo back to its default
branch and up to date is tedious, and the leftovers (merged branches, branches
you forgot you were still on) pile up.

`Sync-GitRepos.ps1` goes through all repos under a folder, fast-forwards the
default branch, and never overwrites uncommitted work. Whatever needs a
decision (deleting squash-merged branches, switching back to the default branch,
resetting a diverged `main`, running `npm install`) is collected into one list
at the end instead of interrupting the run. It also skips repos that are only
online in OneDrive, so nothing gets downloaded.

## License

[MIT License](LICENSE) © 2026 Friedinger
