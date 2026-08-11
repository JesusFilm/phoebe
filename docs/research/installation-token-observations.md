# What a GitHub App installation token actually does

Observations for [#157](https://github.com/JesusFilm/phoebe/issues/157), a
`wayfinder:task` on the GitHub App mode map ([#155](https://github.com/JesusFilm/phoebe/issues/155)).
Everything below was observed first-hand on **2026-08-11** against a real App
and two real repos, not read out of documentation. Reproduce with
`scripts/probe-app-token.mjs`.

## Setup

|                       |                                                                                                            |
| --------------------- | ---------------------------------------------------------------------------------------------------------- |
| App                   | `phoebe-probe-1`, id `4551400`, owned by `mikeallisonJS`                                                   |
| Installation          | `152995629`, `repository_selection: selected`                                                              |
| Installed permissions | `metadata:read`, `contents:write`, `issues:write`, `pull_requests:write`, `actions:read` (onboarding §2)   |
| Repos                 | `mikeallisonJS/pb-test-1` (id `1331228812`), `mikeallisonJS/pb-test-2` (id `1331229679`), both **private** |
| Private key           | `~/.phoebe-scratch/phoebe-probe-1.pem` (0600, dir 0700) — path recorded, never the secret                  |

Scratch repos are seeded with one open issue, one open PR, and a `ci` workflow
firing on push/PR so the PR head carries a real check.

## Minting and narrowing

**`permissions` narrows below the installation's grant, and over-asking is a
hard 422 — not a silent clamp.**

| Mint body                               | Result                                                                            |
| --------------------------------------- | --------------------------------------------------------------------------------- |
| _(none)_                                | 201, full installation grant                                                      |
| `{issues: read}`                        | 201 → token holds `{issues: read, metadata: read}`. Metadata is added implicitly. |
| `{administration: write}`               | **422** `The permissions requested are not granted to this installation.`         |
| `{issues: read, administration: write}` | **422** — one bad key rejects the whole mint; you do not get the good half        |

This is the answer [#156](https://github.com/JesusFilm/phoebe/issues/156) was
waiting on, and it is the favourable one: a mis-specified per-tenant grant fails
loudly at mint time rather than later as a 403 from an arbitrary API hop.

**`repositories` narrowing works, in both spellings.** `repositories` takes bare
names, `repository_ids` takes numeric ids; both return 201 and echo the selected
set back in `repositories`, so the mint is self-verifying. A name not in the
installation → **422** `There is at least one repository that does not exist or
is not accessible to the parent installation.`

## Identity and attribution

Uniformly **`phoebe-probe-1[bot]`**, `type: Bot`.

| Write path                       | Login                                                                                                                          | Notes                                     |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------- |
| Issue comment                    | `phoebe-probe-1[bot]`                                                                                                          | `authorAssociation: NONE`                 |
| PR comment                       | `phoebe-probe-1[bot]`                                                                                                          | `authorAssociation: NONE`                 |
| Commit via Contents API          | author `phoebe-probe-1[bot] <315548108+phoebe-probe-1[bot]@users.noreply.github.com>`, committer `GitHub <noreply@github.com>` | **`verified: true`** — GitHub signs it    |
| Commit via `git push` over https | same login, `author_type: Bot`                                                                                                 | **`verified: false`, `reason: unsigned`** |

Two consequences:

- **`authorAssociation: NONE`.** Anything gating on `OWNER`/`MEMBER`/
  `COLLABORATOR` will reject an App where it accepted a PAT.
- **`GET /user` → 403** `Resource not accessible by integration`. An
  installation token has no user identity, so self-identification must not go
  through `/user`.
- Signing differs by write path, which matters if any branch protection requires
  signed commits: the API path satisfies it, `git push` does not.

## Status-code taxonomy

How a caller tells the failure modes apart — the practical form of the ticket's
"401 vs 403" question.

| Condition                                              | Status  | Body                                     |
| ------------------------------------------------------ | ------- | ---------------------------------------- |
| Valid token, granted permission                        | 200     | —                                        |
| Valid token, **ungranted permission**                  | **403** | `Resource not accessible by integration` |
| Valid token, **repo outside `repositories`**           | **404** | `Not Found`                              |
| **Expired** token (observed 4 min past `expires_at`)   | **401** | `Bad credentials`                        |
| **Revoked** token (`DELETE /installation/token` → 204) | **401** | `Bad credentials`                        |
| Never-valid token                                      | **401** | `Bad credentials`                        |

Expiry was confirmed on a read endpoint, a second read endpoint, and a write
endpoint — all 401, so it is not endpoint-specific. Revoking an
already-expired token also returns 401.

**The usable rule: 401 means the credential is bad, 403 means the credential is
fine but the grant is not.** That cleanly separates "remint and retry" from
"fail this tenant loudly", which is what the ticket wanted.

**Two things it does _not_ separate:**

- **Expired / revoked / garbage are byte-identical.** All three are `401 Bad
credentials`. Since reminting fixes the expired case and fails loudly for the
  others, a blanket remint-on-401 is still safe — but nothing can log _which_
  happened.
- **Out-of-scope repo is a 404, not a 403** — indistinguishable from a repo that
  was deleted, renamed, or never existed. A per-tenant mint that narrows by repo
  must treat 404 as ambiguous and re-probe on a wider token to disambiguate.
  This is a genuine preflight requirement for #156.

## GraphQL status rollup — YES, with `checks:read`

**An installation token can read `statusCheckRollup`.** This is the notable
finding of the ticket. `docs/work-kinds.md` records that the engine uses the
REST Actions API because fine-grained PATs cannot read the rollup; that
constraint does not apply to this credential arm. Acting on it is out of scope
for this map.

The first attempt returned `FORBIDDEN` on the field itself. That was a missing
permission, not a token-class limit: the App held `actions:read` and no
`checks:read`. With `checks:read` granted **and accepted on the installation**
(see the section above — those are two separate steps), the same query returns
`state: SUCCESS` and populated contexts.

### The rollup spans two permissions, and a partial grant fails quietly

`statusCheckRollup.contexts` is a union of two node types backed by two
different permissions:

| Node type       | Produced by                              | Needs            |
| --------------- | ---------------------------------------- | ---------------- |
| `CheckRun`      | GitHub Actions, check-run apps           | `checks: read`   |
| `StatusContext` | legacy commit statuses (e.g. CodeRabbit) | `statuses: read` |

With `checks:read` but not `statuses:read`, GraphQL returns **HTTP 200 carrying
both `data` and `errors`**:

- `statusCheckRollup.state` is still `SUCCESS` — the aggregate is computed
  server-side and does not leak.
- `contexts.nodes` has the `CheckRun` entries populated and the `StatusContext`
  entry as **`null`**, with a `FORBIDDEN` error whose path points at that exact
  node index.

So a caller that only reads `state` gets a correct answer, while a caller that
iterates `contexts` to decide _which_ check failed silently sees fewer checks
than exist. Nothing throws. Any consumer of this query must check the `errors`
array even on a 200, and must not treat `contexts.nodes` as complete.

Confirmed on the REST side with a `checks:read`-only token:

| Endpoint                                  | Status  |
| ----------------------------------------- | ------- |
| `GET /repos/{r}/commits/{sha}/check-runs` | 200     |
| `GET /repos/{r}/commits/{sha}/status`     | **403** |
| `GET /repos/{r}/commits/{sha}/statuses`   | **403** |

Minting `{statuses: read}` against an App that does not declare it → **422**,
consistent with the narrowing behaviour above. Reading the full rollup therefore
needs **both** `checks: read` and `statuses: read` declared on the App and
accepted on each installation.

## Adding a permission does not reach existing installations

Observed while trying to settle the rollup question. Editing the App to add
`checks: read` updates the App immediately — `GET /app` reports it — but the
**installation keeps its old grant** until someone with access to that
installation approves the request out of band (a banner at
`https://github.com/settings/installations/<id>`, plus an email). In between:

| Call                                      | Result                                                                    |
| ----------------------------------------- | ------------------------------------------------------------------------- |
| `GET /app`                                | `checks: read` present                                                    |
| `GET /app/installations/{id}`             | `checks` **absent**                                                       |
| Mint with `{permissions: {checks: read}}` | **422** `The permissions requested are not granted to this installation.` |

This is an operational cost the map should price in. Widening the App's
permissions later is not a single admin action — it is one approval **per
installation**, i.e. per tenant, and until each lands that tenant mints tokens
with the old grant while `GET /app` cheerfully reports the new one. Any
preflight must read the **installation's** permissions, never the App's.

The 422 at mint time is the saving grace: a tenant whose approval has not landed
fails loudly rather than silently running under-permissioned.

## `gh` CLI and the git seam

`bootstrap/boot.ts:97` runs Phoebe's entire git path through
`gh auth setup-git`. It needs **no change** for this arm:

- `gh auth setup-git --hostname github.com` exits 0 and writes the usual
  `!gh auth git-credential` helper.
- `gh auth status` reports `Logged in to github.com account phoebe-probe-1[bot]
(GH_TOKEN)`.
- `gh api`, `gh pr list`, `gh issue list`, `gh run list` all work.
- `git clone` and `git push` against a **private** repo succeed through the
  helper.

## Token shape — a trap

The same endpoint returns **two different formats non-deterministically**: a
40-character opaque `ghs_…`, and a 383-character `ghs_<appid>_<base64url JWT>`.
Three consecutive mints gave 383 / 40 / 383.

Anything validating token _shape_ by length or regex will pass and fail
intermittently. `scripts/token-probe-lib.mjs:145-150` classifies by prefix only,
so Phoebe is safe today — but this is worth not regressing.

## TTL and rate limits

- `expires_at` is exactly **60 minutes** out.
- **5000/hr**, `x-ratelimit-resource: core`, and **shared across repos in one
  installation** (`remaining` decremented across calls to the two repos). Per-tenant
  rate-budget isolation is _not_ free with this arm.

## Reproducing

```
node scripts/probe-app-token.mjs --i-know \
  --app-id 4551400 --key ~/.phoebe-scratch/phoebe-probe-1.pem \
  --repo mikeallisonJS/pb-test-1 --repo mikeallisonJS/pb-test-2

# expiry needs a token aged past its hour:
node scripts/probe-app-token.mjs --expired-check <ghs_ token minted >1h ago>
```

The script **writes to the repos it is pointed at** — that is how identity is
observed — so it refuses to run without `--i-know` and removes its comments and
branches unless `--keep`. Scratch repos only.
