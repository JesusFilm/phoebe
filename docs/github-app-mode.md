# GitHub App mode

**Who this is for:** an operator deciding between the PAT and App credential
arms, or moving a deployment from one to the other. It answers what each arm
costs to provision and what it buys.

Phoebe's credential arm is set at deployment time. The **PAT arm** uses a
fine-grained personal access token you mint per tenant and store in each
tenant's `GH_TOKEN`. The **App arm** replaces that with a GitHub App whose
installation tokens Phoebe mints at runtime, one per tenant, over the
bootstrapper-to-child IPC channel.

Both arms ship. Neither is newer, and neither is more secure than the other. The
choice is about provisioning rather than permissions.

## 1. Which arm to use

One test:

- **One repo, or several repos under different owners** → **PAT arm**.
  A fine-grained PAT is scoped to one owner. If your tenants span
  `acme/widget`, `beta-org/core`, and your own personal repo, that is three
  separate PATs, and three separate tokens are what you have. App mode does not
  help here.
- **Several repos under one owner** → **App arm** may make sense,
  subject to [the costs below](#2-what-the-app-arm-costs-you).

PAT is the recommended default for solo deployments. App mode pays off for a
multi-tenant fleet within one installation. The App arm's installation budget
scales with repo and user count; the PAT arm's user budget is capped at 5,000
requests per hour no matter how many tokens that user mints.
See [Capacity](#5-capacity).

## 2. What the App arm costs you

Five asymmetries versus the PAT arm, each meaningful enough that you should
price them in before registering the App.

### One shared rate budget

Both arms pool tenants under one budget per credential scope — one user budget
for the PAT arm, one installation budget per App installation. Fine-grained PATs
minted by the same operator user all draw from that user's 5,000-request-per-hour
allowance; each token does not carry an independent budget. A fleet of N tenants
on N PATs minted by one operator shares one budget, not N. An App installation
also pools all its tenants under one installation budget, but that budget scales
with installed repos and users — up to 12,500 GraphQL points/hour for a standard
installation (REST also scales to 12,500 req/hr) and 10,000 GraphQL points/hour
for an Enterprise Cloud organisation (REST 15,000 req/hr). Fleets spanning
multiple owners land on separate installations with separate budgets. The
per-user PAT ceiling does not scale. A busy tenant spends from the same pool as
its siblings on either arm. See [Capacity](#5-capacity) for the arithmetic.

### Roughly fifty-minute effective run timeout

An installation token expires in exactly sixty minutes. Phoebe's default run
timeout is 45 minutes (`PHOEBE_RUN_TIMEOUT_MS`), which fits within the
lease. A static PAT has no such bound. If you raise `PHOEBE_RUN_TIMEOUT_MS`
past the token's remaining lifetime, the in-flight unit will start seeing 401s
before it finishes. Keep the run timeout below sixty minutes on the App arm.

### Notification and contribution shift

Every commit, PR comment, and issue comment is authored by the App's bot account
(`<app-name>[bot]`). Workflow-trigger emails go to the bot, not the operator.
Commit authorship graphs and contribution credit move off the operator account
entirely. This is permanent for commits: you cannot un-author a pushed commit
after the fact.

### App-key blast radius

The App private key authenticates the App itself, not a single tenant. Anyone
who holds it can mint tokens for every installation of that App, across every
tenant you have given it access to. A leaked PAT covers one tenant's
scope; a leaked App key covers the whole installation set. See
[Revoking](#6-revoking) for the floor on damage control.

### Permission widening needs per-installation approval

When you add a permission to the App after the initial install, the new
permission takes effect only after each installation approves it. Until an
installation approves, minting a token with the new permission fails with a
422, loudly rather than silently. But if you run a fleet of N tenants, a
permission change walks the fleet through a mixed period where some tenants have the new
grant and others do not. Any preflight must read the **installation's** grants,
not the App's. See [Registering the App](#3-registering-the-app) for the
five-permission table.

## 3. Registering the App

### Permissions

The App needs the same five grants that §2 of
[`phoebe-core-onboarding.md`](phoebe-core-onboarding.md#2-operator-github-token-a-fine-grained-pat)
requires for a fine-grained PAT:

| Permission    | Access         | Why                                                             |
| ------------- | -------------- | --------------------------------------------------------------- |
| Metadata      | Read-only      | Mandatory for every other permission.                           |
| Contents      | Read and write | Clone the repo, push branches.                                  |
| Pull requests | Read and write | Open/update PRs, post PR comments and watermarks.               |
| Issues        | Read and write | Read `readyLabel`, swap in `processingLabel`, comment.          |
| Actions       | Read-only      | `gh run list`, the check-state source for the `checks` janitor. |

Leave everything else at _No access_. Add _Workflows: Read and write_ only if
the agent will edit `.github/workflows/` files.

### Install on the repos you serve

Install the App on exactly the repos your tenants point at. Installing it on
repos outside your fleet widens the blast radius of the App key with no
operational benefit. Phoebe only reads the tenants it is configured to serve.

### Generate and base64 the private key

On the App settings page, generate a private key. It downloads as a `.pem`
file. Base64-encode it for the env-file:

```bash
base64 -w 0 path/to/private-key.pem
```

### The two env vars

Add to the deployment `.env`:

| Env var              | Value                                                  |
| -------------------- | ------------------------------------------------------ |
| `PHOEBE_APP_ID`      | The App's numeric id (shown on the App settings page). |
| `PHOEBE_APP_KEY_B64` | The base64-encoded private key from above.             |

Do **not** set `GH_TOKEN` in the deployment-level `.env`. That is now a
per-tenant field (see [Migrating](#7-moving-an-existing-deployment-to-the-app-arm)).
Each tenant's `GH_TOKEN` is left blank; the bootstrapper mints a fresh token
from the App credentials and hands it to the engine child at boot time.

### Install only what you serve

See [`trust.md`](trust.md) for the co-location policy. The constraint does not
change under the App arm: repos that share an installation share a rate budget
and a blast radius. Co-locate only repos whose mutual compromise is already
acceptable.

## 4. What changes at runtime

### Identity

Every commit, PR, and comment is attributed to `<app-name>[bot]` with `type:
Bot`. The commit identity falls back to a synthesised noreply address
(`<id>+<app-name>[bot]@users.noreply.github.com`).

It is a **fallback**, and the lowest rung but one: a repo that declares
`gitIdentity` in its `phoebe.config.ts`, or a tenant `.env` that sets
`GIT_AUTHOR_*`, commits under that identity instead, identically under both arms
([`configuration.md` → Commit attribution](configuration.md#commit-attribution-gitidentity)).
The API author is still the bot; commit authorship and API authorship are
independent, as they already are on the `pat` arm.

Vouch reads the `.github/VOUCHED.td` file only for human handles. A bot handle
ending in `[bot]` resolves to `trusted` on its own, without reading
the file. There is no step to take here.

The token itself is not narrowed per pipeline: the supervisor leases it per pipeline
and caches the minted installation token per tenant, so every pipeline of a tenant
works its repo with the same full grant.

### Reviews and branch protection

**The operator can approve the bot's PR** under required-review branch
protection, even with `enforce_admins: true`. Owning the App is not
self-approval: GitHub treats the bot as a separate account, so the operator who
registered the App can still clear the bot's PRs. After the operator approves,
`mergeable_state` flips from `blocked` to `clean`, and the bot merges its own
PR.

Two configuration-dependent caveats:

- With `dismiss_stale_reviews_on_push` set to true, a bot push after an
  approval dismisses that approval, which is the shape of a fixup commit on an
  already-approved PR.
- With `require_last_push_approval` set to true, the bot being the last
  pusher requires a further approval.

Both settings default to false on new protection rules, but confirm them on
your repo's branch protection before relying on the flow above.

### What you see

At boot, the bootstrapper's log line includes the arm tally (`app: N tenants`).
`phoebe list` shows an `arm` column; tenants on the App arm show `app`. A
tenant that failed to mint a token shows `held — mint failed: <reason>` in
place of the current unit.

To diagnose a tenant's token before a 403 lands mid-run, use
`scripts/verify-tenant-token.mjs`. On the App arm it reports a third verdict,
`unverifiable`, for grants the probe cannot confirm without a live write.

## 5. Capacity

### The binding budget

An App installation holds **two** independent rate-limit pools:

| Resource  | Limit    | What uses it    |
| --------- | -------- | --------------- |
| `core`    | 5 000/hr | REST endpoints  |
| `graphql` | 5 000/hr | GraphQL queries |

Phoebe's poll path is overwhelmingly GraphQL, so `graphql` is the binding budget
rather than `core`.

Minting an installation token is authenticated with the App's JWT rather than
with an installation token, so it is billed against the App's own limit and not
against either pool above. Treat it as cheap rather than free: the numbers below
count poll traffic only, and if you are sizing a very large fleet, measure
minting separately rather than assuming it is unmetered.

### The formula

Measured cost per tenant per poll cycle, where P is in-scope open PRs:

```
graphql ≈ 8 + 5P   per tenant per cycle
core    ≈ P        per tenant per cycle
```

Tenants per installation (idle polling, default 5-minute interval):

```
tenants_max ≈ 5000 ÷ ( (3600 ÷ interval_seconds) × (8 + 5 × avg_open_prs) )
```

### Reference table

| Avg open PRs per tenant | graphql/hr per tenant | Tenants per installation |
| ----------------------- | --------------------- | ------------------------ |
| 0                       | 96                    | ~52                      |
| 2                       | 216                   | ~23                      |
| 5                       | 396                   | ~12                      |
| 10                      | 696                   | ~7                       |

**Headline: around 10 tenants per installation for an active fleet at default
settings. Recommend staying under 8.**

The margin is deliberate. **These figures cover idle polling only.** While a
unit is executing, the coding agent makes its own GraphQL calls under the same
installation token, bounded by `PHOEBE_MAX_CONCURRENT_AGENTS` and plausibly
larger than the poll cost. Account for this head-room explicitly when sizing.

### PAT arm ceiling for comparison

The same formula applies to a fleet on the PAT arm. Fine-grained PATs minted by
one operator user all draw from that user's personal GraphQL budget of 5,000
points/hr, and that budget does not scale with repo or user count. A
single-operator PAT fleet is bounded by the same 5,000/hr ceiling as the base
App arm, with no repo- or user-count-based scaling. The poll-interval lever
below does apply: a longer interval raises the tenant ceiling proportionally. For
any fleet beyond a few tenants, use the App arm.

### Levers

**Poll interval.** The ceiling scales linearly with `PHOEBE_POLL_INTERVAL_MS`.
Doubling the interval doubles the tenant ceiling.

**Organization installation.** Installing on an organization account rather
than a personal account raises the GraphQL budget from 5 000/hr to 12 500/hr,
against the same per-tenant cost. An org installation at the default interval
supports roughly 25 active tenants (2 PRs each) before hitting the ceiling.

**Splitting across installations.** Tenants under different owners already land
on different installations for free. Rate budgets are per-installation, so a
multi-owner fleet partitions itself. Running deliberately separate
installations for same-owner tenants is possible but not supported: past that
point you are running multiple independent deployments.

**Rotation** happens over the bootstrapper-to-child channel with no restart and
nothing to configure. It is not operator-facing, and it does **not** reset the
rate budget. The budget belongs to the installation, so a rotated key mints tokens
against the same installation.

## 6. Revoking

Three levers, each with a different blast radius:

**Uninstall from one repo.** The installation stays on sibling repos; only
that tenant's tokens die. Existing tokens live up to sixty minutes. After that,
the tenant's next poll fails to resolve the installation, the tenant does not
spawn, and the log explains why. No config edit is needed, because revocation
heals itself. The next restart picks up the updated installation set.

**Regenerate the App key and update the deployment env-file.** Minting new
tokens becomes possible again only with the new key. Existing tokens live up to
sixty minutes before expiring naturally. This affects the whole fleet, not one
tenant, so coordinate the key rotation with any in-flight runs.

**Delete the App.** Every installation is removed and every token minted from
it expires within the hour. Nothing restarts on its own after this; the
deployment needs a new credential before it can serve any tenant.

**The sixty-minute TTL is the floor on any revocation response.** There is no
revoke-now for an already-minted token. Once minted, a token's expiry is fixed at
sixty minutes from issue time. Plan incident response around the
possibility of up to an hour of residual access.

## 7. Moving an existing deployment to the App arm

There is no pressure to move. The PAT arm is not deprecated, and an existing
deployment running PATs has no correctness problem to fix. Move only if the
provisioning cost of per-tenant PATs is actually hurting.

Migration steps:

1. Register the App and install it on the repos already supervised
   (§[3](#3-registering-the-app)).
2. Add `PHOEBE_APP_ID` and `PHOEBE_APP_KEY_B64` to the deployment `.env`.
3. Blank each tenant's `GH_TOKEN` in its `.env`, leaving the key present but
   empty. The bootstrapper treats a blank `GH_TOKEN` on the App arm as "mint one
   for me".
4. Restart the deployment.

**What changes visibly:**

- Commit authorship becomes `<app-name>[bot]` for every tenant.
- Workflow-trigger notifications and contribution graphs move off the operator
  account.
- The shared-user rate budget (5,000 req/hr across all PATs by the operator)
  becomes a shared installation budget that can scale with repo and user count.

This is **not** an engine-version migration and has no entry in
[`upgrading.md`](upgrading.md), because nothing about the engine changes.

## 8. Related work

| What                                | Where                                                                                             |
| ----------------------------------- | ------------------------------------------------------------------------------------------------- |
| GitHub App mode map                 | [#155](https://github.com/JesusFilm/phoebe/issues/155)                                            |
| Two credential arms decision        | [#163](https://github.com/JesusFilm/phoebe/issues/163)                                            |
| Rate limits decision                | [#184](https://github.com/JesusFilm/phoebe/issues/184)                                            |
| Where the App private key lives     | [#160](https://github.com/JesusFilm/phoebe/issues/160)                                            |
| Identity and attribution decision   | [#161](https://github.com/JesusFilm/phoebe/issues/161)                                            |
| Bot-CI behaviour (push triggers CI) | [#197](https://github.com/JesusFilm/phoebe/issues/197)                                            |
| How these facts were established    | [`docs/research/installation-token-observations.md`](research/installation-token-observations.md) |
