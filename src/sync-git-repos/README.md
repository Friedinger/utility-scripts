# sync-git-repos

`sync-git-repos` keeps every project folder on its default branch and up to
date. Works on Windows, Linux and macOS.

It works for every Git repo under a root folder (searched recursively, not
descending into repos, `node_modules` or hidden folders) in three steps.

**1. Sync, no questions.** It fetches all repos in parallel, detects each
repo's actual default branch (via `origin/HEAD`, works for `main`, `master` or
anything else) and fast-forwards it. If another branch is checked out, the
default branch is updated without switching. Local changes are kept as long as
they do not touch files the update changes. Branches already fully merged are
deleted. Every repo gets one result line (`Updated`, `Up to date`, `Skipped`,
`Failed`).

**2. Review, one list.** Everything that needs a decision is collected into a
single folder tree, grouped by repo, with the sensible entries already marked:

| Entry                                                                                     | Pre-marked |
| ----------------------------------------------------------------------------------------- | ---------- |
| Delete a branch whose changes are already in the default branch (squash or rebase merged) | yes        |
| Switch to the default branch and delete the current branch, because it is done            | yes        |
| Delete a branch whose upstream is gone but which has commits not in the default branch    | no, red    |
| Switch to the default branch, leaving a branch with unmerged work                         | no         |
| Reset a diverged default branch to origin (local commits go to a `backup/...` branch)     | no, red    |
| Stash local changes, update, restore them (when they touch incoming files)                | no         |
| `npm install` for updated repos that already had `node_modules`                           | no         |

The keys are the same as in
[mise-forget](../mise-forget/README.md#the-interactive-list),
plus `v` for the full diff of the entry under the cursor (in git's pager).

**3. Run and summary.** The marked entries run, then a summary counts the
results and lists the repos that still need attention. Nothing happens to an
entry you do not mark, and uncommitted changes are never discarded.

Works inside OneDrive on Windows: repos whose `.git` folder is not fully
available locally (and online-only folders) are silently skipped, so nothing
gets downloaded for them.

## Requirements

- Git 2.38 or newer (to recognize squash-merged branches)
- Node.js 24 or newer, see the [installation](../../README.md#installation)

## Usage

```sh
# syncs the current folder's subfolders
sync-git-repos

# syncs a specific folder, npm installs every updated repo without asking
sync-git-repos ~/Projects --install-deps

# never npm install, and only do the pre-marked cleanup entries without the list
sync-git-repos ~/Projects --no-install-deps --cleanup

# sync only, no cleanup and no list
sync-git-repos ~/Projects --no-install-deps --no-cleanup

# only look two folder levels deep
sync-git-repos ~/Projects --max-depth 2
```

`sync-git-repos --help` lists all options. Without a terminal (e.g. in a
script), the open decisions are skipped.

## Trying it out

To try it without touching real repos, build a sandbox of throwaway repos in
every situation the tool handles (behind, merged and squash-merged branches,
diverged `main`, local changes, ...) in the temp folder:

```sh
npm run sandbox
```

It prints the command to run. Run it again for a fresh sandbox, or delete it
with `npm run sandbox -- --remove`. The tests use the same sandbox.
