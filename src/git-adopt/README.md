# git-adopt

`git-adopt` makes you the author of other people's commits on the current
branch and signs them with your own key. Typical case: an AI agent such as
Claude built a feature branch in the cloud, with its own author and signing
key, and before merging you want the commits under your name and signature.
Works on Windows, Linux and macOS.

Since Git runs any `git-<name>` command it finds on the `PATH`, it is also
available as `git adopt`.

## What it does

1. **Fetch.** Fetches origin's default branch (detected via `origin/HEAD`, so
   `main`, `master` or anything else) and the branch's upstream. If the
   upstream has commits the local branch does not, it stops: pull first.
2. **Choose.** Lists the commits between the base and `HEAD` (oldest first).
   Commits where you are not the author or not the committer are pre-marked
   and shown in red; your identity comes from `user.name` and `user.email`.
   Signatures do not matter here, the agent signs its commits too.
3. **Rewrite.** Marked commits get you as author (the author date stays),
   every commit is committed and signed by you. Commits before the first
   marked one stay exactly as they are, same hash. Commits after it get a new
   hash anyway (their parent changes), so they are signed again too, with
   their author unchanged.
4. **Push** with `--force-with-lease` against the upstream state from before,
   so commits pushed in the meantime are never overwritten.

Every commit keeps its tree, so there are no conflicts, merge commits stay
merge commits, and the working tree, index and uncommitted changes are left
alone. There is no rebase onto the newest default branch: when the branch is
behind, `git-adopt` only says so.

Before anything is rewritten, it signs a throwaway commit to check that
signing works. The old state of the branch is kept in
`refs/adopt/backup/<branch>`:

```sh
git reset --keep refs/adopt/backup/<branch>
```

It refuses to run on a detached `HEAD` or while a rebase, merge, cherry-pick,
revert or bisect is in progress.

## The interactive list

The keys are the same as in
[mise-forget](../mise-forget/README.md#the-interactive-list), plus:

- `d` marks all commits that are not yours
- `g` groups the commits by author; `Space` on an author marks or unmarks all
  of their commits (the filter `f` works too, it matches the author name)
- `s` opens `git show` for the commit under the cursor

The preview shows author, committer, signature and changed files. After the
list, `git-adopt` shows the plan (`keep`, `adopt`, `re-sign` per commit) and
asks before rewriting, then asks whether to push.

## Requirements

- Signing set up in Git, e.g. for SSH keys:

  ```sh
  git config --global gpg.format ssh
  git config --global user.signingkey ~/.ssh/id_ed25519.pub
  ```

  Commits are always signed (`-S`), `commit.gpgsign` is not needed. With a
  passphrase, an SSH agent is recommended. To see signatures as checked in the
  preview, set `gpg.ssh.allowedSignersFile`.

- Node.js 24 or newer, see the [installation](../../README.md#installation)

## Usage

```sh
# list, plan, question, rewrite, ask to push
git adopt

# only pre-mark Claude's commits
git adopt --author noreply@anthropic.com

# show the plan, change nothing
git adopt --dry-run

# no list and no questions: adopt the pre-marked commits and push
git adopt --yes --push

# compare against another branch, e.g. for stacked pull requests
git adopt --base origin/feature/first-part
```

`git adopt --help` lists all options. Without a terminal, `--yes` (or
`--dry-run`) is required.
