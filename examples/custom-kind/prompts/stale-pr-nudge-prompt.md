# Nudge a stale pull request

PR #{{PR_NUMBER}} (branch `{{PR_BRANCH}}`, targeting `{{DEFAULT_BRANCH}}`) has
had no review-thread activity since {{LAST_ACTIVITY_AT}}.

You are running in an empty directory, not a checkout of the repository, so
every `gh` call must name the repo with `-R {{REPO_SLUG}}`.

1. Read the PR: `gh pr view {{PR_NUMBER}} -R {{REPO_SLUG}} --comments`.
2. Summarize in two or three sentences what the PR does and what it appears to
   be waiting on (review, a failing check, an unanswered question).
3. Post ONE comment on the PR (`gh pr comment {{PR_NUMBER}} -R {{REPO_SLUG}}`)
   asking the humans for a decision — merge, review, or close. Be brief and
   concrete. End the comment with this exact line:

   {{NUDGE_MARKER}}

Do not push commits, do not edit the PR, do not comment on anything else.
