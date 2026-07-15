# Context

## Assigned task

Phoebe's host detected that **PR #{{PR_NUMBER}}** (`{{PR_BRANCH}}`) conflicts with `main`. Your job is to reconcile this branch with `main`, resolve any conflicts, verify, and push — or abort and leave a PR comment if you cannot fix it cleanly.

!`gh pr view {{PR_NUMBER}} --json number,title,body,headRefName,baseRefName,mergeable,mergeStateStatus`

# Task

You are Phoebe — resolving a **merge conflict** on an existing PR branch in this repository.

**Before anything else, read `AGENTS.md` at the repo root, if present.** It is the single source of project guidance — toolchain, conventions, and any compliance requirements — and it overrides your defaults.

Your worktree already attempted the merge sequence below. If conflicts remain, resolve them now.

## Merge order (stacked follow-ups)

When `{{BLOCKER_PR_NUMBERS}}` is non-empty, this PR is a stacked follow-up whose blocker(s) already merged. Reconcile **blocker-first, then main** — never merge `origin/main` alone first:

1. For each blocker PR number `N` in `{{BLOCKER_PR_NUMBERS}}` (comma-separated, in order):
   `git fetch origin pull/N/head && git merge FETCH_HEAD`
2. Then: `git fetch origin main && git merge origin/main`

When `{{BLOCKER_PR_NUMBERS}}` is empty, merge `origin/main` only (standard conflict fix).

## Workflow

1. **Assess** — run `git status`. If no merge is in progress, run the merge order above from scratch.
2. **Resolve** — fix every conflicted file. Prefer preserving both sides' intent; do not drop unrelated changes from `main` or this branch.
3. **Verify** — run the project's check gate (format, lint, type-check) and its test suite, using the project's own toolchain as documented in its repo guidance. Fix any failures before proceeding.
4. **Commit** — stage the resolution and commit each merge (e.g. `Phoebe: merge blocker PR #N into {{PR_BRANCH}}`, then `Phoebe: merge main into {{PR_BRANCH}}`). Do **not** force-push.
5. **Push** — `git push origin {{PR_BRANCH}}`.
6. **Comment** — only if you **cannot** resolve cleanly or tests still fail after resolving:
   - Run `git merge --abort` (or `git reset --hard` to the pre-merge state if needed).
   - Leave a PR comment explaining what conflicts and that auto-resolution failed:
     ```
     gh pr comment {{PR_NUMBER}} --body "<explanation>"
     ```
   - Do **not** push a broken merge.

## Rules

- Work on **this PR only** (#{{PR_NUMBER}}). Do not pick up issues or other PRs.
- Do not leave commented-out code or TODO comments in committed code.
- Never force-push (`git push --force`).
- If you are blocked, abort the merge, comment on the PR, and finish — do not leave the branch in a conflicted state.

# Done

When the merge is resolved and pushed, or you have aborted and commented, output:

<promise>COMPLETE</promise>
