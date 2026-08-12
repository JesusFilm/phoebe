#!/usr/bin/env node
// Does a push made with a GitHub App *installation token* trigger workflow
// runs, and does a human approval satisfy branch protection on a bot's PR?
// (#197, on the GitHub App mode map #155.)
//
// #157 answered what an installation token *is*; this answers what CI does when
// the bot uses one. The `checks` work kind (docs/work-kinds.md) is built on runs
// actually happening, so if an installation-token push does not trigger them,
// `checks` is dead under App mode and the runbook fork has to say so out loud.
// The belief is that it does trigger — the no-trigger rule is specific to
// Actions' own `GITHUB_TOKEN` — but #157 exists precisely to stop trusting
// recall about this credential.
//
// Deliberately pushes over the *git seam* Phoebe really uses: `gh auth
// setup-git` writes a `!gh auth git-credential` helper that reads `GH_TOKEN`
// live (bootstrap/boot.ts:97), so the push here goes through the same helper the
// engine's does. It runs against a throwaway HOME so it never touches the
// operator's ~/.gitconfig.
//
// THIS SCRIPT MUTATES THE REPOSITORY IT IS POINTED AT — a branch, commits, a
// pull request, and (with --protect) a branch-protection rule on the default
// branch. Point it at scratch repos only. It refuses to run without --i-know and
// cleans up everything it created unless --keep is passed.
//
// Usage:
//   node scripts/probe-bot-ci.mjs --i-know \
//     --app-id 4551400 --key ~/.phoebe-scratch/phoebe-probe-1.pem \
//     --repo mikeallisonJS/pb-test-1 --protect
//
//   --installation <id>  skip discovery (otherwise the sole installation is used)
//   --protect            also run the branch-protection / human-approval phase
//   --keep               leave the branch, PR and protection rule behind
//   --timeout <seconds>  how long to wait for a run to appear (default 150)
//
// The --protect phase is the one place this script does NOT use the App: the App
// holds no `administration` grant, and the question is whether a *human* review
// clears a *bot* PR. That phase shells out to `gh` with GH_TOKEN scrubbed, so gh
// falls back to the operator's own stored credential.
//
// No token is ever printed — only its prefix and expiry.
//
// Nothing here is part of the engine. Operator tool, ships with the repo.

import { execFileSync } from "node:child_process";
import { createSign } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const API = "https://api.github.com";
const UA = "phoebe-probe-bot-ci";

// ---------------------------------------------------------------- arg parsing

function parseArgs(argv) {
  const out = { keep: false, iKnow: false, protect: false, timeout: 150 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--app-id") out.appId = next();
    else if (a === "--key") out.key = next();
    else if (a === "--installation") out.installation = next();
    else if (a === "--repo") out.repo = next();
    else if (a === "--timeout") out.timeout = Number(next());
    else if (a === "--protect") out.protect = true;
    else if (a === "--keep") out.keep = true;
    else if (a === "--i-know") out.iKnow = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

const expandHome = (p) => (p.startsWith("~/") ? homedir() + p.slice(1) : p);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ transport

async function call(path, { token, jwt, method = "GET", body } = {}) {
  const res = await fetch(path.startsWith("http") ? path : API + path, {
    method,
    headers: {
      accept: "application/vnd.github+json",
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
  return { status: res.status, headers: res.headers, json };
}

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
  return call(`/app/installations/${installationId}/access_tokens`, {
    jwt,
    method: "POST",
    ...(body ? { body } : {}),
  });
}

// ------------------------------------------------------------- run observation

// The whole point of the ticket: a run either appears for this sha or it does
// not. Absence is only meaningful after a real wait — Actions queues runs
// asynchronously and an impatient poll would manufacture the scary answer. So
// poll to a generous deadline and report the wait alongside the verdict.
async function waitForRuns({ token, repo, sha, timeoutSeconds, label, event }) {
  const started = Date.now();
  const deadline = started + timeoutSeconds * 1000;
  // When a specific event is wanted, "some run exists" is not good enough: the
  // push run for a sha lands before the pull_request run for the same sha, so an
  // unqualified wait would return early and report the wrong absence.
  const satisfied = (runs) => (event ? runs.some((r) => r.event === event) : runs.length > 0);
  let runs = [];
  while (Date.now() < deadline) {
    const res = await call(`/repos/${repo}/actions/runs?head_sha=${sha}&per_page=20`, { token });
    if (res.status !== 200) {
      return { label, sha, error: { status: res.status, message: res.json?.message } };
    }
    runs = res.json.workflow_runs ?? [];
    if (satisfied(runs)) break;
    await sleep(5000);
  }
  const hit = event ? runs.some((r) => r.event === event) : runs.length > 0;
  return {
    label,
    sha,
    looking_for_event: event,
    triggered: hit,
    appeared_after_seconds: hit ? Math.round((Date.now() - started) / 1000) : undefined,
    waited_seconds: hit ? undefined : timeoutSeconds,
    runs: runs.map((r) => ({
      id: r.id,
      event: r.event,
      status: r.status,
      // actor vs triggering_actor: for a bot push they should agree, but they
      // are distinct fields and a workflow author gating on either needs to know
      // which one carries the `[bot]` login.
      actor: r.actor?.login,
      actor_type: r.actor?.type,
      triggering_actor: r.triggering_actor?.login,
      head_branch: r.head_branch,
    })),
  };
}

// ------------------------------------------------------------------ git seam

// Phoebe never pushes with a bare token in a URL — it runs `gh auth setup-git`
// and lets the credential helper read GH_TOKEN per call. Reproducing that
// exactly is the point: a probe that pushed with an embedded-token remote would
// prove nothing about the seam the engine actually uses. HOME is a throwaway so
// the helper's gitconfig lands there and not on the operator's.
function gitSeam({ token, repo, branch, botIdentity, keep }) {
  const home = mkdtempSync(join(tmpdir(), "phoebe-probe-home-"));
  const work = mkdtempSync(join(tmpdir(), "phoebe-probe-work-"));
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    GH_TOKEN: token,
    GIT_TERMINAL_PROMPT: "0",
    // gh writes its own config under HOME; a fresh one keeps the probe honest
    // about needing nothing but GH_TOKEN.
    GH_CONFIG_DIR: join(home, ".config", "gh"),
  };
  const run = (cmd, cmdArgs, cwd) =>
    execFileSync(cmd, cmdArgs, { env, cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

  const out = { home_was_throwaway: true, branch, home };
  try {
    out.setup_git = run("gh", ["auth", "setup-git", "--hostname", "github.com"]) || "ok (exit 0)";
    run("git", ["clone", "--depth", "1", `https://github.com/${repo}.git`, work]);
    run("git", ["config", "user.name", botIdentity.name], work);
    run("git", ["config", "user.email", botIdentity.email], work);
    run("git", ["checkout", "-b", branch], work);
    writeFileSync(join(work, `probe-${branch.replace(/\//g, "-")}.txt`), `phoebe #197\n`);
    run("git", ["add", "-A"], work);
    run(
      "git",
      ["commit", "-m", "probe: does an installation-token push trigger CI? (phoebe#197)"],
      work,
    );
    run("git", ["push", "-u", "origin", branch], work);
    out.pushed_sha = run("git", ["rev-parse", "HEAD"], work).trim();
    out.push_ok = true;
    out.work = work;
    out.env = env;
  } catch (e) {
    out.push_ok = false;
    out.error = String(e.stderr || e.message).slice(0, 800);
  } finally {
    if (!keep) rmSync(home, { recursive: true, force: true });
  }
  return out;
}

// A second commit on an already-open PR — `push` and `pull_request:synchronize`
// are different triggers, and Phoebe pushes to open PRs constantly.
function gitSeamSecondCommit({ seam, branch }) {
  const run = (cmd, cmdArgs) =>
    execFileSync(cmd, cmdArgs, {
      env: seam.env,
      cwd: seam.work,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  writeFileSync(join(seam.work, "probe-second.txt"), "phoebe #197 second commit\n");
  run("git", ["add", "-A"]);
  run("git", ["commit", "-m", "probe: second commit on an open bot PR (phoebe#197)"]);
  run("git", ["push", "origin", branch]);
  return run("git", ["rev-parse", "HEAD"]).trim();
}

// --------------------------------------------------- the human's own credential

// Everything else here runs as the App. This does not: the question is whether a
// *human* review clears a *bot* PR under branch protection, and the App holds no
// `administration` grant to set that protection up anyway. Scrubbing GH_TOKEN
// makes gh fall back to the operator's stored login.
function ghAsHuman(cmdArgs) {
  const env = { ...process.env };
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  try {
    return {
      ok: true,
      out: execFileSync("gh", cmdArgs, {
        env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    };
  } catch (e) {
    return { ok: false, error: String(e.stderr || e.message).slice(0, 600) };
  }
}

// --------------------------------------------------------------------- runner

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.iKnow) {
    console.error(
      "This script writes to the repo it is pointed at (a branch, commits, a PR,\n" +
        "and with --protect a branch-protection rule). Point it at a scratch repo\n" +
        "and pass --i-know.",
    );
    process.exit(2);
  }
  if (!args.appId || !args.key || !args.repo) {
    throw new Error("--app-id, --key and --repo are required");
  }

  const jwt = mintJwt({ appId: args.appId, keyPath: args.key });
  const app = await call("/app", { jwt });
  if (app.status !== 200) throw new Error(`GET /app → ${app.status}: ${app.json?.message}`);

  const installs = await call("/app/installations", { jwt });
  const install = args.installation
    ? installs.json.find((i) => String(i.id) === String(args.installation))
    : installs.json[0];

  // Narrowed exactly as #156's mint would be: this repo, and only the grants a
  // tenant needs. If CI behaves differently under a narrowed token than a full
  // one, that is itself the finding.
  const repoName = args.repo.split("/")[1];
  const minted = await mint(install.id, jwt, {
    repositories: [repoName],
    permissions: { contents: "write", pull_requests: "write", actions: "read", checks: "read" },
  });
  if (minted.status !== 201) {
    throw new Error(`mint → ${minted.status}: ${minted.json?.message}`);
  }
  const token = minted.json.token;

  // #161 resolves the bot's commit identity from the slug, never from /user.
  const slug = app.json.slug;
  const botUser = await call(`/users/${slug}[bot]`, { token });
  const botIdentity = {
    name: `${slug}[bot]`,
    email: `${botUser.json?.id}+${slug}[bot]@users.noreply.github.com`,
  };

  const stamp = Date.now().toString(36);
  const branch = `probe/ci-${stamp}`;

  const observations = {
    app: { id: app.json.id, slug },
    installation: { id: install.id, permissions_granted: install.permissions },
    token: { prefix: token.slice(0, 4), expires_at: minted.json.expires_at },
    bot_identity: botIdentity,
    repo: args.repo,
    branch,
  };

  // ---- Q1/Q2: does a git-seam push trigger a run, and who is the actor?
  const seam = gitSeam({ token, repo: args.repo, branch, botIdentity, keep: true });
  observations.git_seam_push = {
    setup_git: seam.setup_git?.trim?.() ?? seam.setup_git,
    push_ok: seam.push_ok,
    error: seam.error,
    sha: seam.pushed_sha,
  };
  if (!seam.push_ok) {
    console.log(JSON.stringify(observations, null, 2));
    process.exit(1);
  }
  observations.push_runs = await waitForRuns({
    token,
    repo: args.repo,
    sha: seam.pushed_sha,
    timeoutSeconds: args.timeout,
    label: "push over the gh credential helper, branch has no PR yet",
  });

  // ---- Q3: does `pull_request` fire on a PR opened BY the bot?
  const pr = await call(`/repos/${args.repo}/pulls`, {
    token,
    method: "POST",
    body: {
      title: `Probe: bot-opened PR for #197 (${stamp})`,
      head: branch,
      base: "main",
      body: "Opened by an installation token to observe whether `pull_request` events fire.",
    },
  });
  observations.pr_open = {
    status: pr.status,
    number: pr.json?.number,
    author: pr.json?.user?.login,
    author_type: pr.json?.user?.type,
    author_association: pr.json?.author_association,
    message: pr.json?.message,
    errors: pr.json?.errors,
  };
  const prNumber = pr.json?.number;

  if (prNumber) {
    // The `pull_request` run is keyed to the same head sha as the push run, so
    // re-poll the same sha and look for a second run with a different event.
    observations.pr_open_runs = await waitForRuns({
      token,
      repo: args.repo,
      sha: seam.pushed_sha,
      timeoutSeconds: args.timeout,
      event: "pull_request",
      label: "same sha, re-read after the bot opened a PR — look for event: pull_request",
    });

    // ---- a second commit onto the open PR: push + synchronize
    const secondSha = gitSeamSecondCommit({ seam, branch });
    observations.second_commit_runs = await waitForRuns({
      token,
      repo: args.repo,
      sha: secondSha,
      timeoutSeconds: args.timeout,
      label: "second commit pushed onto an open bot PR",
    });

    // Can the bot's own token see the checks it triggered? `checks` work kind
    // reads this, so a blind bot would be as broken as an untriggered run.
    const checkRuns = await call(`/repos/${args.repo}/commits/${secondSha}/check-runs`, { token });
    observations.bot_can_read_own_checks = {
      status: checkRuns.status,
      total: checkRuns.json?.total_count,
      names: checkRuns.json?.check_runs?.map((c) => c.name),
    };
  }

  // ---- Q4: does a human approval clear branch protection on a bot's PR?
  if (args.protect && prNumber) {
    const protection = {};
    // Branch protection is a PUT with a nested body, which gh's -f flags cannot
    // express — it has to go in over stdin, so this one call does not go through
    // ghAsHuman.
    protection.enable = (() => {
      const env = { ...process.env };
      delete env.GH_TOKEN;
      delete env.GITHUB_TOKEN;
      const payload = JSON.stringify({
        required_status_checks: null,
        enforce_admins: true,
        required_pull_request_reviews: {
          required_approving_review_count: 1,
          dismiss_stale_reviews: false,
        },
        restrictions: null,
      });
      try {
        execFileSync(
          "gh",
          ["api", "--method", "PUT", `repos/${args.repo}/branches/main/protection`, "--input", "-"],
          { env, input: payload, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
        );
        return { ok: true };
      } catch (e) {
        return { ok: false, error: String(e.stderr || e.message).slice(0, 600) };
      }
    })();

    if (protection.enable.ok) {
      const before = await call(`/repos/${args.repo}/pulls/${prNumber}`, { token });
      protection.before_review = {
        mergeable_state: before.json?.mergeable_state,
        mergeable: before.json?.mergeable,
      };

      // The human approves the bot's PR. GitHub blocks approving your OWN pull
      // request; the question banked by #161 is whether an App owned by that
      // same human counts as "own".
      const review = ghAsHuman([
        "api",
        "--method",
        "POST",
        `repos/${args.repo}/pulls/${prNumber}/reviews`,
        "-f",
        "event=APPROVE",
        "-f",
        "body=probe: human approval of a bot-authored PR (phoebe#197)",
      ]);
      protection.human_approval = review.ok
        ? {
            ok: true,
            state: JSON.parse(review.out).state,
            user: JSON.parse(review.out).user?.login,
          }
        : review;

      await sleep(4000);
      const after = await call(`/repos/${args.repo}/pulls/${prNumber}`, { token });
      protection.after_review = {
        mergeable_state: after.json?.mergeable_state,
        mergeable: after.json?.mergeable,
      };
      const decision = ghAsHuman([
        "pr",
        "view",
        String(prNumber),
        "-R",
        args.repo,
        "--json",
        "reviewDecision,reviews",
      ]);
      protection.review_decision = decision.ok ? JSON.parse(decision.out).reviewDecision : decision;

      // Whether the *bot* can then merge is a second grant question entirely.
      const merge = await call(`/repos/${args.repo}/pulls/${prNumber}/merge`, {
        token,
        method: "PUT",
        body: { merge_method: "squash" },
      });
      protection.bot_merge_attempt = { status: merge.status, message: merge.json?.message };
    }
    observations.branch_protection = protection;
  }

  // ------------------------------------------------------------------ cleanup
  if (!args.keep) {
    const cleanup = {};
    if (args.protect) {
      cleanup.protection_removed = ghAsHuman([
        "api",
        "--method",
        "DELETE",
        `repos/${args.repo}/branches/main/protection`,
      ]).ok;
    }
    if (prNumber) {
      const closed = await call(`/repos/${args.repo}/pulls/${prNumber}`, {
        token,
        method: "PATCH",
        body: { state: "closed" },
      });
      cleanup.pr_closed = closed.status === 200 || closed.json?.state === "closed";
    }
    const delRef = await call(`/repos/${args.repo}/git/refs/heads/${branch}`, {
      token,
      method: "DELETE",
    });
    cleanup.branch_deleted = delRef.status === 204;
    if (seam.home) rmSync(seam.home, { recursive: true, force: true });
    if (seam.work) rmSync(seam.work, { recursive: true, force: true });
    observations.cleanup = cleanup;
  } else {
    observations.kept = { branch, pr: prNumber, worktree: seam.work };
  }

  console.log(JSON.stringify(observations, null, 2));
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
