# Contributor trust (`vouch`)

> **Scope:** this is governance for the `JesusFilm/phoebe` repository itself, not
> a feature of the `phoebe-agent` package. Nothing here ships to consumers, and
> no config field turns it on. If you are installing Phoebe into your own repo,
> you can adopt the same pattern — the wiring is two files — but you don't have
> to, and Phoebe's behaviour does not depend on it.

## The problem

Phoebe is an AFK coding agent pointed at a **public** repo. It polls this tracker
for `ready-for-agent` issues and works them autonomously, and it sweeps open PRs.
Anyone can open an issue or a PR here. Nothing in the ticket itself tells a
reviewer — or an agent — whether the author is a maintainer, a known
contributor, or a drive-by.

[`mitchellh/vouch`](https://github.com/mitchellh/vouch) is a flat-file community
trust system: a list of handles in the repo, and composite GitHub Actions that
resolve any user against it. We adopt it as an **advisory signal**, the same way
[`pingdotgg/t3code`](https://github.com/pingdotgg/t3code) does.

## The two files

| File                          | What it is                                                                                  |
| ----------------------------- | ------------------------------------------------------------------------------------------- |
| `.github/VOUCHED.td`          | The trust list, in vouch's Trustdown format.                                                |
| `.github/workflows/vouch.yml` | Resolves an issue/PR author against the list and syncs one `vouch:*` label onto the thread. |

`src/vouched-file.test.ts` asserts the list's format, ordering, and uniqueness on
every PR — vouch reads the file over the API and never reports a parse error back
to us, so a malformed line would otherwise just make its author silently resolve
to `unknown`.

## Adding or denouncing a handle

Edit `.github/VOUCHED.td` and open a PR. The format is one handle per line,
sorted alphabetically:

```
# A line starting with `#` is a comment.
github:someone
-github:badactor Submitted AI slop
```

The first entry vouches; the leading `-` on the second denounces. Note that `#`
only opens a comment at the **start of a line** — on an entry line, everything
after the first space is free-text detail attached to the handle (above, the
reason for the denouncement). There is no trailing-comment syntax.

- **Collaborators with write access are trusted automatically** and need no
  entry. The current maintainers are listed anyway so the file states the trust
  set on its own, and so it survives a permission change.
- **Bots are trusted automatically and must not be listed.** `gh-check-user`
  returns early on any handle ending in `[bot]`, before it reads the file at
  all, so such an entry would be unreachable.
- Trust is case-insensitive — vouch lowercases handles before matching.
- The `github:` platform prefix is optional but is what the existing entries use.

When the edit lands on `main`, the workflow re-labels **every open issue and PR**,
so a newly-vouched contributor's existing threads update without anyone touching
them.

## What the workflow does

It runs on new/reopened issues, on PR activity (`opened`, `reopened`,
`synchronize`, `ready_for_review`, `converted_to_draft`), on a push to `main` that
touches the list, and on demand (below). It resolves the **author** — not the
commenter — and syncs exactly one managed label:

| Label             | vouch status                     | Means                                            |
| ----------------- | -------------------------------- | ------------------------------------------------ |
| `vouch:trusted`   | `bot`, `collaborator`, `vouched` | Trusted by repo permissions or by the list.      |
| `vouch:unvouched` | `unknown`                        | Not in the list. Not a judgement — just unknown. |
| `vouch:denounced` | `denounced`                      | Explicitly blocked by the list.                  |

The three labels are created and reconciled by the workflow itself, so there is
no manual `gh label create` step to remember. Labels the workflow does not own
(`ready-for-agent`, `bug`, …) are never touched.

To re-run the check on a single thread — after a vouch lands, or if a run
failed — comment:

```
/recheck-vouch
```

### What it deliberately does not do

**Nothing is closed, locked, or blocked.** `check-user` runs with
`allow-fail: true`, so an unvouched author reports through the label and never
turns a PR's checks red. Vouch ships `check-issue` / `check-pr` actions that can
auto-close, and we are not using them. Blocking can come later if spam actually
shows up; until then a hard gate mostly costs us legitimate first-time
contributors.

## How this relates to `ready-for-agent`

**The `ready-for-agent` label is the gate. Vouch labels are advisory.**

Phoebe picks up an issue when it carries `readyLabel` (default
`ready-for-agent`) — see [`operating.md`](operating.md). That label is already a
maintainer action and cannot be self-applied: GitHub only lets a user with
**triage or write permission** set labels on a public repo, so an unvouched
author cannot queue their own ticket for the agent no matter what they write in
it. Applying `ready-for-agent` **is** the vouch for that ticket.

That is why the engine has no vouch-awareness and no new config field. Adding an
author check to `src/orchestrator.ts` would gate the same door twice, and would
push a trust policy onto every consumer of the package — most of whom run Phoebe
against a private repo where the question does not arise.

What the vouch label buys us is the signal _before_ that decision: on the triage
list, `vouch:unvouched` marks the tickets to read carefully, and
`vouch:denounced` marks one that should not be labelled `ready-for-agent` at all.
The interaction to remember:

- An unvouched or denounced author's issue is **not workable** by Phoebe until a
  maintainer labels it — which is a deliberate, permissioned act.
- If a denounced author's ticket somehow carries `ready-for-agent`, that is a
  maintainer mistake, not a workflow failure. Remove the label to stop the agent;
  removing `readyLabel` is the documented pause lever.
- The vouch label on a **PR** is a review signal only. Phoebe's PR janitors scan
  by branch prefix and skip cross-repository PRs entirely (`isPrInScope` in
  `src/orchestrator.ts`), so a fork PR is already outside its reach.
