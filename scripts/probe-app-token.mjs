#!/usr/bin/env node
// Observe what a GitHub App *installation token* actually does (#157).
//
// The GitHub App map (#155) proposes a second credential arm: instead of an
// operator hand-minting a fine-grained PAT per tenant (onboarding §2), one App
// private key mints a short-lived `ghs_` token per tenant on demand. Nothing on
// that map can be decided from documentation — GitHub's docs are silent or
// ambiguous on narrowing semantics, on the identity writes land as, and on what
// an expired installation token returns. So this script asks a real App against
// real repos and records the answers.
//
// THIS SCRIPT MUTATES THE REPOSITORIES IT IS POINTED AT. That is the opposite
// of scripts/verify-tenant-token.mjs, which proves write grants without writing
// by aiming every mutating probe at a non-existent target. Here the writes ARE
// the observation: the only way to learn what login a commit lands as, and what
// `authorAssociation` GitHub reports for a bot's issue comment, is to make one.
// Point this at scratch repos only. It refuses to run without --i-know, and it
// cleans up the refs it creates unless --keep is passed.
//
// Usage:
//   node scripts/probe-app-token.mjs --i-know \
//     --app-id 4551400 --key ~/.phoebe-scratch/phoebe-probe-1.pem \
//     --repo mikeallisonJS/pb-test-1 --repo mikeallisonJS/pb-test-2
//
//   --installation <id>   skip discovery (otherwise the sole installation is used)
//   --json                machine-readable observations
//   --keep                leave the probe branch/comments behind
//
// The private key is never printed, and neither is any minted token — only the
// token's prefix and its `expires_at`. Expiry behaviour (401 vs 403 after the
// TTL lapses) is NOT probed here: it needs a wall-clock hour. Run
// `--expired-check <token>` separately once one has gone stale.
//
// Nothing here is part of the engine. Operator tool, ships with the repo.

import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

const API = "https://api.github.com";
const UA = "phoebe-probe-app-token";

// ---------------------------------------------------------------- arg parsing

function parseArgs(argv) {
  const out = { repos: [], json: false, keep: false, iKnow: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--app-id") out.appId = next();
    else if (a === "--key") out.key = next();
    else if (a === "--installation") out.installation = next();
    else if (a === "--repo") out.repos.push(next());
    else if (a === "--expired-check") out.expiredCheck = next();
    else if (a === "--json") out.json = true;
    else if (a === "--keep") out.keep = true;
    else if (a === "--i-know") out.iKnow = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

const expandHome = (p) => (p.startsWith("~/") ? homedir() + p.slice(1) : p);

// ------------------------------------------------------------------ transport

// Every probe cares about the status code and the headers, not just the body —
// the whole point of several observations is "422 or silent clamp?" and "what
// does the rate-limit header say?". So this returns the envelope, never throws
// on a non-2xx, and lets each probe decide what the status means.
async function call(path, { token, jwt, method = "GET", body, accept } = {}) {
  const res = await fetch(path.startsWith("http") ? path : API + path, {
    method,
    headers: {
      accept: accept ?? "application/vnd.github+json",
      "user-agent": UA,
      "x-github-api-version": "2022-11-28",
      ...(jwt ? { authorization: `Bearer ${jwt}` } : {}),
      ...(token ? { authorization: `token ${token}` } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: res.status, headers: res.headers, json, text };
}

// App JWTs are RS256 over {iat, exp, iss} and max 10 minutes. Clock skew on the
// caller is the usual cause of a mystery 401 here, hence the backdated iat.
function mintJwt({ appId, keyPath }) {
  const key = readFileSync(expandHome(keyPath), "utf8");
  const seg = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${seg({ alg: "RS256", typ: "JWT" })}.${seg({ iat: now - 60, exp: now + 540, iss: appId })}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  return `${unsigned}.${signer.sign(key, "base64url")}`;
}

async function mint(installationId, jwt, body) {
  const res = await call(`/app/installations/${installationId}/access_tokens`, {
    jwt,
    method: "POST",
    ...(body ? { body } : {}),
  });
  return res;
}

// ---------------------------------------------------------------- observations

// Q1. Does `permissions` in the mint body narrow below the installation's
// grant, and what happens when it asks for MORE than the installation has —
// 422, or a silent clamp? #156 turns on this: if it silently clamps, a
// mis-specified per-tenant grant fails later as a 403 from some API hop instead
// of at mint time, and the arm needs its own preflight.
async function probeNarrowing({ installationId, jwt, repos, granted }) {
  // `repositories` takes bare names, `repository_ids` takes numeric ids —
  // whether the former is even accepted is one of the things being observed.
  const names = repos.map((r) => r.full.split("/")[1]);
  const ids = repos.map((r) => r.id);

  const cases = [
    { name: "no body (full installation grant)", body: undefined },
    { name: "permissions: subset (issues read only)", body: { permissions: { issues: "read" } } },
    {
      name: "permissions: MORE than granted (administration write)",
      body: { permissions: { administration: "write" } },
    },
    {
      name: "permissions: escalate a held grant (issues read → admin write)",
      body: { permissions: { issues: "read", administration: "write" } },
    },
    { name: "repositories: by name (one repo)", body: { repositories: [names[0]] } },
    { name: "repositories: by name (both)", body: { repositories: names } },
    { name: "repository_ids: by id (one repo)", body: { repository_ids: [ids[0]] } },
    {
      name: "repositories: a name NOT in the installation",
      body: { repositories: ["definitely-not-installed"] },
    },
  ];

  const results = [];
  for (const c of cases) {
    const res = await mint(installationId, jwt, c.body);
    results.push({
      case: c.name,
      status: res.status,
      // The distinguishing signal: on success, what did we actually get back?
      // A clamp shows up as a permissions map narrower than what was asked for.
      granted_permissions: res.json?.permissions,
      repository_selection: res.json?.repository_selection,
      repositories: res.json?.repositories?.map((r) => r.full_name),
      expires_at: res.json?.expires_at,
      token_prefix: res.json?.token ? res.json.token.slice(0, 4) : undefined,
      message: res.json?.message,
      asked_for: c.body?.permissions,
      verdict:
        res.status === 422
          ? "REJECTED (422)"
          : res.status === 201
            ? JSON.stringify(res.json?.permissions) ===
              JSON.stringify({ ...granted, ...c.body?.permissions })
              ? "granted as asked"
              : "granted — compare map above against asked_for"
            : `unexpected ${res.status}`,
    });
  }
  return results;
}

// Q2. What identity do writes land as? The exact login on a PR comment, an
// issue comment, and a commit — plus the authorAssociation GitHub reports.
// The identity ticket on #155 needs this to decide whether Phoebe's "did the
// bot already reply?" checks still work when the author is an App.
async function probeIdentity({ token, repo, keep }) {
  const obs = {};

  const me = await call("/user", { token });
  // An installation token is not a user, so /user is expected to fail. What it
  // fails WITH is the observation — it tells you the shape of "this token has
  // no user identity" that any identity-detection code must handle.
  obs.user_endpoint = { status: me.status, message: me.json?.message };

  const issue = await call(`/repos/${repo}/issues`, { token });
  const issueNumber = issue.json?.find?.((i) => !i.pull_request)?.number;
  const pr = await call(`/repos/${repo}/pulls`, { token });
  const prNumber = pr.json?.[0]?.number;
  const headSha = pr.json?.[0]?.head?.sha;
  obs.targets = { issueNumber, prNumber, headSha };

  if (issueNumber) {
    const c = await call(`/repos/${repo}/issues/${issueNumber}/comments`, {
      token,
      method: "POST",
      body: { body: "probe: installation-token identity check (phoebe#157)" },
    });
    obs.issue_comment = {
      status: c.status,
      login: c.json?.user?.login,
      id: c.json?.user?.id,
      type: c.json?.user?.type,
      author_association: c.json?.author_association,
      url: c.json?.html_url,
    };
    if (!keep && c.json?.id) {
      await call(`/repos/${repo}/issues/comments/${c.json.id}`, { token, method: "DELETE" });
      obs.issue_comment.cleaned_up = true;
    }
  }

  if (prNumber) {
    const c = await call(`/repos/${repo}/issues/${prNumber}/comments`, {
      token,
      method: "POST",
      body: { body: "probe: installation-token identity check on a PR (phoebe#157)" },
    });
    obs.pr_comment = {
      status: c.status,
      login: c.json?.user?.login,
      author_association: c.json?.author_association,
    };
    if (!keep && c.json?.id) {
      await call(`/repos/${repo}/issues/comments/${c.json.id}`, { token, method: "DELETE" });
      obs.pr_comment.cleaned_up = true;
    }
  }

  // A commit made through the Contents API, which is how you observe the
  // committer identity without shelling out to git. The git-over-https path is
  // probed separately (Q4) because it runs through a different credential seam.
  const branch = "probe/identity";
  const main = await call(`/repos/${repo}/git/ref/heads/main`, { token });
  if (main.status === 200) {
    await call(`/repos/${repo}/git/refs`, {
      token,
      method: "POST",
      body: { ref: `refs/heads/${branch}`, sha: main.json.object.sha },
    });
    const put = await call(`/repos/${repo}/contents/probe-identity.txt`, {
      token,
      method: "PUT",
      body: {
        message: "probe: who does an installation token commit as? (phoebe#157)",
        content: Buffer.from("probe\n").toString("base64"),
        branch,
      },
    });
    obs.commit = {
      status: put.status,
      author: put.json?.commit?.author,
      committer: put.json?.commit?.committer,
      // The REST commit object carries the git identity; the *GitHub* identity
      // (the avatar shown next to it) comes from the separate user field.
      github_author: put.json?.commit?.author?.name,
      verification: put.json?.commit?.verification,
    };
    if (!keep) {
      await call(`/repos/${repo}/git/refs/heads/${branch}`, { token, method: "DELETE" });
      obs.commit.cleaned_up = true;
    }
  }

  return obs;
}

// Q3. Can an installation token read the GraphQL status rollup? The engine uses
// the REST Actions API specifically because fine-grained PATs cannot
// (docs/work-kinds.md). If an installation token can, that is a notable finding
// — acting on it is out of scope for this map, but it changes what's possible.
async function probeRollup({ token, repo, prNumber }) {
  const [owner, name] = repo.split("/");
  const query = `query($owner:String!,$name:String!,$pr:Int!){
    repository(owner:$owner,name:$name){
      pullRequest(number:$pr){
        commits(last:1){ nodes { commit {
          oid
          statusCheckRollup { state contexts(first:10){ nodes {
            __typename
            ... on CheckRun { name conclusion status }
            ... on StatusContext { context state }
          } } }
        } } }
      }
    }
  }`;
  const res = await call("https://api.github.com/graphql", {
    token,
    method: "POST",
    body: { query, variables: { owner, name, pr: prNumber } },
  });
  const commit = res.json?.data?.repository?.pullRequest?.commits?.nodes?.[0]?.commit;
  return {
    status: res.status,
    errors: res.json?.errors?.map((e) => ({ type: e.type, message: e.message })),
    rollup_state: commit?.statusCheckRollup?.state ?? null,
    contexts: commit?.statusCheckRollup?.contexts?.nodes,
    // The discriminator: a token that cannot see the rollup returns data with a
    // null rollup, NOT an error — so "no errors" alone does not mean success.
    verdict: res.json?.errors
      ? "ERROR — cannot query"
      : commit?.statusCheckRollup
        ? "CAN read the rollup"
        : "queried fine but rollup is null (indistinguishable from no checks)",
  };
}

// Q4. Does `gh auth setup-git` accept a ghs_ token, and does gh work normally
// with one in GH_TOKEN? Phoebe's entire git path runs through that helper
// (bootstrap/boot.ts:97), so if gh treats installation tokens differently the
// shallowest seam is already in trouble. Shelled out by the caller, since it
// needs a real working tree — see the runner below.

// Q4b. The status-code taxonomy: how does a caller tell the failure modes
// apart? The ticket asks this about expiry (401 vs 403), but expiry is only one
// of four ways an installation token can fail, and a retry policy needs all
// four. Everything here is observable in-process; only expiry needs a wall
// clock, which is why it lives behind --expired-check.
async function probeStatusTaxonomy({ installationId, jwt, repos }) {
  const [a, b] = repos;
  const out = {};

  // Valid token, permission the token was not minted with.
  const narrowRes = await mint(installationId, jwt, { permissions: { issues: "read" } });
  const narrow = narrowRes.json.token;
  out.ungranted_permission = {
    probe: `GET /repos/${a.full}/actions/runs with an issues-read-only token`,
    ...(await call(`/repos/${a.full}/actions/runs`, { token: narrow }).then((r) => ({
      status: r.status,
      message: r.json?.message,
    }))),
  };
  out.granted_permission = {
    probe: `GET /repos/${a.full}/issues with the same token`,
    status: (await call(`/repos/${a.full}/issues`, { token: narrow })).status,
  };

  // Valid token, repo outside the `repositories` narrowing. This one is a trap:
  // it is 404, not 403, so "out of scope" is indistinguishable from "repo was
  // deleted or renamed" without a second call on a wider token.
  if (b) {
    const scopedRes = await mint(installationId, jwt, { repositories: [a.full.split("/")[1]] });
    const scoped = scopedRes.json.token;
    out.out_of_scope_repo = {
      probe: `GET /repos/${b.full} with a token narrowed to ${a.full}`,
      ...(await call(`/repos/${b.full}`, { token: scoped }).then((r) => ({
        status: r.status,
        message: r.json?.message,
      }))),
    };
  }

  // Revoked token. DELETE /installation/token kills the token that authorises
  // the call, so this necessarily burns the token it mints.
  const doomedRes = await mint(installationId, jwt);
  const doomed = doomedRes.json.token;
  const before = await call("/installation/repositories", { token: doomed });
  const del = await call("/installation/token", { token: doomed, method: "DELETE" });
  const after = await call("/installation/repositories", { token: doomed });
  out.revoked = {
    before_status: before.status,
    delete_status: del.status,
    after_status: after.status,
    after_message: after.json?.message,
  };

  // A well-formed but never-valid token, as the control. If this matches the
  // revoked case, revocation is not distinguishable from garbage.
  const bogus = await call("/installation/repositories", {
    token: `ghs_${"0".repeat(36)}`,
  });
  out.never_valid = { status: bogus.status, message: bogus.json?.message };
  out.verdict =
    out.revoked.after_status === out.never_valid.status
      ? "revoked and never-valid are INDISTINGUISHABLE (same status + message)"
      : "revoked and never-valid differ — see statuses";

  return out;
}

// Q5. Rate limits: the actual limit, and whether it is shared across repos in
// one installation.
async function probeRateLimit({ token, repos }) {
  const per = [];
  for (const repo of repos) {
    const res = await call(`/repos/${repo}`, { token });
    per.push({
      repo,
      limit: res.headers.get("x-ratelimit-limit"),
      remaining: res.headers.get("x-ratelimit-remaining"),
      used: res.headers.get("x-ratelimit-used"),
      resource: res.headers.get("x-ratelimit-resource"),
      reset: res.headers.get("x-ratelimit-reset"),
    });
  }
  return {
    per_repo: per,
    // If remaining decrements across the two calls, the budget is per
    // installation, not per repo.
    verdict:
      per.length > 1 && Number(per[0].remaining) > Number(per[1].remaining)
        ? "SHARED across repos in one installation"
        : "inconclusive — remaining did not decrement as expected",
  };
}

// --------------------------------------------------------------------- runner

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.expiredCheck) {
    // Run this after an hour with a token you kept: the status code is the
    // whole observation. 401 vs 403 is what lets "expired" be told apart from
    // "never granted" — which is the difference between retry-with-a-new-token
    // and fail-the-tenant-loudly.
    const res = await call("/installation/repositories", { token: args.expiredCheck });
    console.log(
      JSON.stringify({ expired_token_status: res.status, message: res.json?.message }, null, 2),
    );
    return;
  }

  if (!args.iKnow) {
    console.error(
      "This script writes to the repos it is pointed at (comments, a branch, a commit).\n" +
        "Point it at scratch repos and pass --i-know.",
    );
    process.exit(2);
  }
  if (!args.appId || !args.key) throw new Error("--app-id and --key are required");

  const jwt = mintJwt({ appId: args.appId, keyPath: args.key });

  const app = await call("/app", { jwt });
  if (app.status !== 200) throw new Error(`GET /app → ${app.status}: ${app.json?.message}`);

  let installationId = args.installation;
  const installs = await call("/app/installations", { jwt });
  const install = installationId
    ? installs.json.find((i) => String(i.id) === String(installationId))
    : installs.json[0];
  installationId = install.id;

  const base = await mint(installationId, jwt);
  const token = base.json.token;

  const repoList = await call("/installation/repositories", { token });
  const repos = repoList.json.repositories.map((r) => ({ full: r.full_name, id: r.id }));
  const targets = args.repos.length ? args.repos : repos.map((r) => r.full);

  const observations = {
    app: { id: app.json.id, slug: app.json.slug, owner: app.json.owner.login },
    installation: {
      id: installationId,
      account: install.account?.login,
      repository_selection: install.repository_selection,
      permissions: install.permissions,
      repositories: repos,
    },
    token_shape: {
      prefix: token.slice(0, 4),
      length: token.length,
      expires_at: base.json.expires_at,
      ttl_minutes: Math.round((Date.parse(base.json.expires_at) - Date.now()) / 60000),
    },
  };

  observations.narrowing = await probeNarrowing({
    installationId,
    jwt,
    repos,
    granted: install.permissions,
  });

  const primary = targets[0];
  observations.identity = await probeIdentity({ token, repo: primary, keep: args.keep });
  observations.rollup = await probeRollup({
    token,
    repo: primary,
    prNumber: observations.identity.targets.prNumber,
  });
  observations.status_taxonomy = await probeStatusTaxonomy({ installationId, jwt, repos });
  observations.rate_limit = await probeRateLimit({ token, repos: targets });

  if (args.json) {
    console.log(JSON.stringify(observations, null, 2));
  } else {
    console.log(JSON.stringify(observations, null, 2));
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
