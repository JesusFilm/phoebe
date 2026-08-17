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

When the edit lands on `main`, the workflow sweeps open threads and re-labels
them, so a newly-vouched contributor's existing tickets update without anyone
touching them.

The sweep fans out one job per thread, and GitHub caps a matrix at 256 jobs — so
it covers every open issue and PR **up to that ceiling**. Past it, the run labels
the newest 256 and logs the numbers it skipped; because the listing is
newest-first, a re-run selects the same batch, so the skipped ones are cleared
with `/recheck-vouch` rather than by waiting. At this repo's volume the cap is
theoretical, and every other trigger is unbounded.

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

## One container = one trust domain

A single Phoebe container can serve **many repos** as tenants (a workspace root
and its child checkouts).
Every tenant's engine child runs as the same unprivileged user (uid 10001), and
that is a deliberate isolation boundary with one sharp edge.

**What is isolated (by mechanism).** The supervisor hands each engine child a
**deny-by-default, tenant-only environment** (`buildEngineChildEnv`): it holds
that tenant's `GH_TOKEN` and provider key and nothing else — never another
tenant's secrets, never the deployment's engine-clone credential. And every
Phoebe process — the supervisor, every engine child, and the agent itself — runs
on a node binary that is shipped non-readable (mode `0711`): the vendored cursor
node (protecting the agent process) and the image's system node (protecting the
supervisor and engine children). Non-readable + root-owned triggers `AT_SECURE`,
making every exec **non-dumpable**: a prompt-injected agent in one tenant cannot
read any sibling's `/proc/<pid>/environ` to lift its secrets from memory. Runtime
blast radius is the same as a single-repo deployment.

**What is _not_ isolated (the accepted residual).** Because all tenants share one
uid, filesystem permissions cannot distinguish them at rest: a prompt-injected
agent in tenant A **can read tenant B's `/etc/phoebe/<child>/.env` off disk**. Delivering
real at-rest separation would need per-tenant OS users (rootless user
namespaces — the documented "model B" upgrade), which an unprivileged container
cannot set up.

The deployment env-file (`/etc/phoebe/.env`) is **not** part of this residual:
`compose.yml` masks it with a `/dev/null` bind mount, so the file is empty
inside the container even though the deployment root is mounted read-only. The
residual is only the per-tenant `.env` files at `/etc/phoebe/<child>/.env` —
each is readable by sibling tenants sharing the same uid.

**So the constraint is a policy, and it is first-class:**

> **Co-locate in one container only repos whose mutual compromise is already
> acceptable** — the same org, the same token scope, the same trust domain.

`phoebe init --tenant` prints this on every run, precisely when adding a tenant
makes it relevant. The moment you need to co-locate **mutually-untrusted**
tenants, one container is no longer enough — give them separate containers (or
adopt model B). This is the named trigger for that upgrade.

**The App key is a third secret class.** Under the App arm (`PHOEBE_APP_ID` /
`PHOEBE_APP_KEY_B64`) the deployment holds a private key whose blast radius spans
the App's entire installation set — strictly wider than any tenant's `GH_TOKEN` or
the engine-clone credential. Anyone who holds the key can mint fresh installation
tokens for **every** repo the App is installed on.

> **Install a deployment's App only on the repos it serves.**

This is the same kind of statement as the co-location constraint above: both are
first-class policies because the runtime boundary is not a full security boundary.
See [`github-app-mode.md` §2](github-app-mode.md#2-what-the-app-arm-costs-you) for
the full blast-radius accounting.
