---
"phoebe-agent": patch
---

Fix twelve problems in the shipped `checks`, `conflicts`, `research`, `reviews` and `issues` prompts, all found when CodeRabbit reviewed tenants' vendored copies.

- `checks` now gets the PR's base as `{{BASE_BRANCH}}` and runs its baseline check there, not on the default branch. A test that is red on `main` but green on a feature branch is now the PR's to fix. Both `checks` and `conflicts` run the targets that actually failed on the baseline. Re-running an `nx affected`-style gate on a clean checkout selects nothing and passes, which tells you nothing.
- The `checks` flaky path passes the run ID to `gh run rerun`. Without one, `gh` refuses to run without a TTY.
- When the host stops on a conflicted blocker merge, `conflicts` now commits it and runs the rest of the merge order before verifying. Before, it could push with the base merge never run.
- `research` commits a doc only after the gate passes, writes the map pointer before closing the ticket, re-checks the map body before overwriting it, and treats a missing map as a blocker. It no longer closes a ticket no map indexes.
- `reviews` fetches threads with `gh api graphql --paginate`, so a failed page fails the fetch instead of passing for the last one. It no longer needs `jq`, which the container image does not ship. It also judges unresolved outdated threads against the current code instead of skipping them. A stuck run now posts `## Review feedback not handled` (`{{REVIEWS_FAILURE_HEADING}}`), and the engine records that run as failed, even if it pushed something first.
- In `issues` and `research`, a blocked run also adds the native GitHub issue dependency when the repo's wayfinder skill tracks blockers that way.

Tenants that vendor the prompts should copy the new versions in. An older override still renders, since every placeholder it uses still has a value.
