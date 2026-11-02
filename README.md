# utility-scripts

[![Last Commit](https://img.shields.io/github/last-commit/Friedinger/utility-scripts?style=flat-square&color=orange)](https://github.com/Friedinger/utility-scripts/commits/main)
[![License: MIT](https://img.shields.io/github/license/Friedinger/utility-scripts?style=flat-square&color=yellow)](LICENSE)

Small utility scripts for the gaps my usual tools leave behind. Written in
TypeScript for Node.js and running on Windows, Linux and macOS; one topic per
folder, each with its own README.

## Installation

Needs Node.js 24 or newer (the repo pins its version in `mise.toml`). Node runs
the TypeScript sources directly, there is no build step.

```sh
git clone https://github.com/Friedinger/utility-scripts.git
cd utility-scripts
npm install
npm link
```

`npm link` puts the commands on your `PATH`. To update, `git pull` (and
`npm install` when dependencies changed).

## [mise-forget](src/mise-forget/README.md)

[mise](https://mise.jdx.dev) remembers every config file it has ever seen, so
archived or deleted projects keep showing up in `mise ls --all-sources`, and
mise has no command to forget them.

`mise-forget` does that: an interactive list (filter, folder tree, preview) to
mark the entries to drop, or paths / `--missing` for scripted use. Removed
entries go to the trash, so a mistake is easy to undo.

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

Still PowerShell (Windows only) for now; the port to TypeScript is next.

## Development

```sh
npm test        # vitest
npm run lint    # prettier, eslint, tsc
npm run fix     # prettier and eslint with fixes
```

## License

[MIT License](LICENSE) © 2026 Friedinger
