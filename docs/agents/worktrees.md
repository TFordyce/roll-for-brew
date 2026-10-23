# Parallel work: git worktrees

Feature work runs in parallel agent sessions. One working tree per session: before its first write, a session creates its own worktree and branch. No session commits to a checkout another session is using.

## Why

A shared working tree races. Sessions stage each other's files, commits land on the wrong branch, and one session's rebase or reset moves the branch under the other. This happened on 23 Oct 2026: two fixes shared one checkout, and the second commit's parent changed mid-session.

## Convention

Before your first write:

```sh
git fetch origin
git worktree add ../roll-for-brew-<name> -b <branch> origin/master
cd ../roll-for-brew-<name>
```

- `<name>` is a short slug for the work (`docs-convention`, `595-reveal-hold`); `<branch>` follows the usual branch vocabulary (`fix/...`, `chore/...`, `port/...`).
- Stage only the files you wrote. Run `git status` before committing, even in your own worktree.
- A branch checked out in one worktree cannot be checked out in another; that is what keeps sessions apart.
- When the PR merges, remove the worktree: `git worktree remove ../roll-for-brew-<name>`.

Everything else (PRs, issues, review) is unchanged; see [issue-tracker.md](issue-tracker.md). Worktrees only change where the working tree lives.
