# sync-git-repos

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
single folder tree, grouped by repo, with the sensible entries already marked:

| Entry | Pre-marked |
| --- | --- |
| Delete a branch whose changes are already in the default branch (squash or rebase merged) | yes |
| Switch to the default branch and delete the current branch, because it is done | yes |
| Delete a branch whose upstream is gone but which has commits not in the default branch | no, red |
| Switch to the default branch, leaving a branch with unmerged work | no |
| Reset a diverged default branch to origin (local commits go to a `backup/...` branch) | no, red |
| Stash local changes, update, restore them (when they touch incoming files) | no |
| `npm install` for updated repos that already had `node_modules` | no |

The keys are the same as in
[Remove-MiseTrackedConfig](../mise-tracked-configs/README.md#the-interactive-list),
plus `v` for the full diff of the entry under the cursor (in git's pager).

**3. Run and summary.** The marked entries run, then a summary counts the
results and lists the repos that still need attention. Nothing happens to an
entry you do not mark, and uncommitted changes are never discarded.

Works inside OneDrive: repos whose `.git` folder is not fully available
locally (and online-only folders) are silently skipped, so nothing gets
downloaded for them.

## Requirements

- Git (2.38 or newer to recognize squash-merged branches), and Node/npm if you use `-InstallDeps`
- PowerShell 5.1 (`powershell`) or 7 (`pwsh`)

## Usage

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

Double-click `Sync-GitRepos.cmd` for the same, defaulting to the folder it's
placed in (copy or shortcut it into whichever folder you want to sync).

If `C:\path\to\your\personal\bin` (or wherever you keep your personal `PATH`) has
a `Sync-GitRepos.cmd` shim pointing at this script, `Sync-GitRepos` also works from
any terminal, in the current directory, without cloning this repo.

## Trying it out

To try it without touching real repos, `test\New-SyncTestRepos.ps1` builds a
sandbox of throwaway repos in every situation the script handles (behind,
merged and squash-merged branches, diverged `main`, local changes, ...) in the
temp folder and prints the command to run. Run it again for a fresh sandbox, or
delete it with `test\Remove-SyncTestRepos.ps1`.
