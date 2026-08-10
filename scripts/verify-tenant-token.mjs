#!/usr/bin/env node
// Diagnose a tenant's GH_TOKEN before Phoebe 403s deep in a run (#154).
//
// docs/phoebe-core-onboarding.md §2 asks the operator to hand-mint a
// fine-grained PAT with five repository permissions and — for an org-owned repo
// — to get it approved by an org owner. Every one of those steps is a browser
// click, and GitHub offers no API to mint the token, so the procedure cannot be
// automated away. What *can* be automated is the part that goes wrong: when a
// permission is missing or the org approval never landed, Phoebe does not fail
// at boot with a clear message, it fails later as a 403 from whichever API hop
// needed the grant. This script names the missing checkbox up front.
//
// Fine-grained PATs are not introspectable — no endpoint returns a token's own
// permission set, and `x-oauth-scopes` is a classic-token header. So it probes:
// one call per grant, reading the status code. The discriminator is 403 (no
// permission) vs 404/422 (no such resource), which is what lets a *write* grant
// be proven without writing anything — every mutating probe is aimed at a
// deliberately non-existent target (issue/PR 999999999, a ref whose sha is 40
// zeroes). NOTHING THIS SCRIPT DOES MUTATES THE REPO. It is safe to run against
// production.
//
// Verified first-hand on 2026-08-10, against a token with full access to a real
// repo: metadata 200, actions/runs 200, PATCH issues/999999999 → 404, PATCH
// pulls/999999999 → 404, POST git/refs with an all-zero sha → 422 "Object does
// not exist" — and no ref was created. The 403-when-missing half is GitHub's
// documented behaviour for fine-grained tokens and was NOT observed here, so any
// status outside the two expected sets is reported `unknown`, never a colour.
// Classic/OAuth tokens are a known exception: on a repo they can read but not
// write, the write probes return 404, not 403 (observed). That is why a token
// carrying `x-oauth-scopes` has its scopes reported directly and is not probed.
//
// Nothing here is part of the engine. It is an operator tool, like
// scripts/hoist-claude-login.mjs, and ships with the repo, not the package.
//
// Usage:
//   node scripts/verify-tenant-token.mjs                    # cwd's tenant: read .env + phoebe.config.ts
//   node scripts/verify-tenant-token.mjs ./repos/JesusFilm/core   # a specific tenant dir (repeatable)
//   node scripts/verify-tenant-token.mjs --all              # every tenant of the deployment rooted here
//   node scripts/verify-tenant-token.mjs --slug JesusFilm/core --token github_pat_…  # explicit, no files
//   node scripts/verify-tenant-token.mjs --json             # machine-readable
//   node scripts/verify-tenant-token.mjs --all --check      # exit 1 if any tenant is short a grant
//
// `--check` mirrors `phoebe list --check` (#140): findings are printed either
// way, and only `--check` turns them into an exit status a preflight can gate
// on. The token is never printed — not in output, not in errors, not in --json.

import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { readConfigDir } from "../bootstrap/config-dir.ts";
import { parseDotenv } from "../bootstrap/engine-child-env.ts";
import { discoverTenants, TENANT_CONFIG_FILE, tenantForDir } from "../bootstrap/tenants.ts";
import { loadUserConfig } from "../src/load-config.ts";
import { enumerateWorkspaceTenants } from "../src/tenant-commands.ts";
import {
  classifyProbe,
  classifyTokenKind,
  describeExpiry,
  diagnose,
  parseArgs,
  parseScopes,
  PERMISSION_PROBES,
  redact,
  renderReport,
  reportToJson,
  scopeCoverage,
  sweepExitCode,
} from "./token-probe-lib.mjs";

const argv = process.argv.slice(2);

if (argv.includes("--help") || argv.includes("-h")) {
  console.log(
    readFileSync(new URL(import.meta.url))
      .toString()
      .split("\n")
      .filter((l) => l.startsWith("//"))
      .map((l) => l.slice(3))
      .join("\n"),
  );
  process.exit(0);
}

let opts;
try {
  opts = parseArgs(argv);
} catch (error) {
  console.error(String(error instanceof Error ? error.message : error));
  console.error("Run with --help for usage.");
  process.exit(2);
}

const API = "https://api.github.com";
/** Bound each probe so a stalled GitHub hop cannot block a fleet sweep. */
const PROBE_TIMEOUT_MS = 30_000;
const TOKEN_VAR = "GH_TOKEN";
const cwd = process.cwd();

// ------------------------------------------------------------------ targets

/**
 * One thing to verify: a slug, a token, and where each came from. `error` means
 * resolution failed — the sweep still reports the target rather than dropping it,
 * because a silently skipped tenant is the failure this script exists to stop.
 */
function makeTarget(fields) {
  return {
    display: fields.display,
    slug: null,
    token: undefined,
    source: null,
    error: null,
    ...fields,
  };
}

/** Display path for a tenant dir: relative to cwd when that is shorter/inside. */
function displayPath(dir) {
  const rel = relative(cwd, dir);
  return rel.length > 0 && !rel.startsWith("..") ? rel : dir;
}

/**
 * Read a tenant's token the way its engine child will: `parseDotenv` over the
 * tenant's own `.env`, at the `configDir`-aware path (#98), so this sees exactly
 * what the child will see.
 *
 * `allowAmbient` is what keeps that promise honest across deployment shapes. In
 * a multi-tenant deployment the supervisor scrubs its own env and hands each
 * child *only* that tenant's `.env` (bootstrap/engine-child-env.ts) — so falling
 * back to the operator's shell `GH_TOKEN` there would certify a tenant that
 * cannot boot. It is allowed only where it is the truth: a flat deployment,
 * where Docker injects the secret and there is no file to read, and the explicit
 * `--slug` form, which has no files at all.
 */
function readTenantToken(envPath, { allowAmbient }) {
  const ambient = allowAmbient && process.env[TOKEN_VAR] ? process.env[TOKEN_VAR] : undefined;
  if (envPath !== null && existsSync(envPath)) {
    const value = parseDotenv(readFileSync(envPath, "utf8"))[TOKEN_VAR];
    if (value !== undefined && value.length > 0) {
      return { token: value, source: `.env at ${envPath}` };
    }
    // A tenant `.env` that exists but holds no token is a definite finding: the
    // child gets nothing, whatever is in the operator's shell.
    return { token: undefined, source: `no ${TOKEN_VAR} in ${envPath}` };
  }
  if (ambient !== undefined) {
    return { token: ambient, source: `${TOKEN_VAR} in the environment` };
  }
  if (envPath === null) return { token: undefined, source: `no --token and no ${TOKEN_VAR} set` };
  return {
    token: undefined,
    source: allowAmbient
      ? `no .env at ${envPath} and no ${TOKEN_VAR} set`
      : `no .env at ${envPath} (the supervisor scrubs its own env, so this tenant's ` +
        `child would boot with no ${TOKEN_VAR} at all)`,
  };
}

/**
 * Resolve one tenant directory to a slug + the `.env` its engine child reads.
 * `allowAmbient` is threaded through to {@link readTenantToken}: it is true only
 * where the operator's shell `GH_TOKEN` really is what the child would get.
 */
async function targetForDir(dir, { allowAmbient }) {
  const absolute = resolve(dir);
  const display = displayPath(absolute);
  const configPath = join(absolute, TENANT_CONFIG_FILE);
  if (!existsSync(configPath)) {
    return makeTarget({
      display,
      error:
        `no ${TENANT_CONFIG_FILE} at ${absolute} — point at a tenant directory, ` +
        `or pass --slug/--token to verify a token with no files at all`,
    });
  }
  let user;
  try {
    user = await loadUserConfig(configPath);
  } catch (error) {
    return makeTarget({ display, error: error instanceof Error ? error.message : String(error) });
  }
  const slug = typeof user.repoSlug === "string" ? user.repoSlug.trim() : "";
  if (slug.length === 0) {
    return makeTarget({ display, error: `missing or empty repoSlug in ${configPath}` });
  }
  let tenant;
  try {
    tenant = tenantForDir(
      absolute,
      slug,
      readConfigDir(/** @type {Record<string, unknown>} */ (user)),
    );
  } catch (error) {
    return makeTarget({ display, error: error instanceof Error ? error.message : String(error) });
  }
  return makeTarget({ display, slug, ...readTenantToken(tenant.envPath, { allowAmbient }) });
}

/**
 * Every tenant of the deployment rooted at the cwd, through the same seams boot
 * uses: `enumerateWorkspaceTenants` in workspace mode, `discoverTenants` for the
 * nested/flat ladder (#83). A fleet sweep that enumerated differently from boot
 * could pass while the supervisor was short a tenant.
 */
async function allTargets() {
  const workspace = await enumerateWorkspaceTenants({ configDir: cwd });
  if (workspace !== null) {
    const held = workspace.holds.map((hold) =>
      makeTarget({
        display: displayPath(hold.dir),
        slug: hold.slug,
        error: `held by discovery — ${hold.reason}`,
      }),
    );
    const live = workspace.tenants.map((tenant) =>
      makeTarget({
        display: displayPath(tenant.dir),
        slug: tenant.slug,
        // Never ambient: a workspace child is supervised with a scrubbed env.
        ...readTenantToken(tenant.envPath, { allowAmbient: false }),
      }),
    );
    return [...live, ...held];
  }

  // Not a workspace: the nested/flat arm. Discovery does not read child configs
  // there, so each tenant's `configDir` (and thus its `.env`) is resolved here.
  // Flat mode is the one shape where the child *does* inherit the supervisor's
  // env, so it is the one shape where the ambient GH_TOKEN is the truth.
  const discovery = discoverTenants(cwd);
  const allowAmbient = discovery.mode === "flat";
  const targets = [];
  for (const tenant of discovery.tenants) {
    const resolved = await targetForDir(tenant.dir, { allowAmbient });
    // Nested path identity is authoritative (#58) — keep it when the config is
    // unreadable, so a broken tenant is still named by its slug.
    targets.push(
      resolved.slug === null && tenant.slug !== null
        ? { ...resolved, slug: tenant.slug }
        : resolved,
    );
  }
  if (targets.length === 0) {
    return [
      makeTarget({ display: displayPath(cwd), error: "no tenants discovered under this root" }),
    ];
  }
  return targets;
}

/**
 * What this run verifies, in precedence order: `--all` sweeps the deployment;
 * `--slug` with no directory is the file-less form; otherwise the named
 * directories, defaulting to the cwd's tenant. `--token` overrides whatever a
 * resolved target read from disk, so an operator can test a replacement token
 * before writing it anywhere.
 */
async function resolveTargets() {
  if (opts.all) return allTargets();
  if (opts.slug !== undefined && opts.dirs.length === 0) {
    // No files in play, so the operator's own environment is the only source
    // there could be — ambient is the point of this form, not a fallback.
    const explicit =
      opts.token !== undefined
        ? { token: opts.token, source: "--token" }
        : readTenantToken(null, { allowAmbient: true });
    return [makeTarget({ display: opts.slug, slug: opts.slug, ...explicit })];
  }
  const dirs = opts.dirs.length > 0 ? opts.dirs : [cwd];
  const resolved = [];
  for (const dir of dirs) {
    // A single named directory is verified on its own terms: if it has no `.env`
    // the operator's shell token is a reasonable thing to be asking about.
    const one = await targetForDir(dir, { allowAmbient: true });
    resolved.push(
      opts.token !== undefined ? { ...one, token: opts.token, source: "--token" } : one,
    );
  }
  return resolved;
}

// ------------------------------------------------------------------- probing

/**
 * Issue one probe and return the evidence: the status, plus the two headers and
 * the body `message` that tell a permission refusal apart from a rate-limit,
 * SAML/SSO or suspension 403 ({@link isAmbiguousRefusal}). Nothing else from the
 * body is kept — it can echo request content, and a refusal message is all the
 * classifier needs.
 */
async function callProbe(probe, slug, token) {
  const init = {
    method: probe.method,
    headers: {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "phoebe-verify-tenant-token",
      authorization: `Bearer ${token}`,
    },
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  };
  if (probe.body !== undefined) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(probe.body);
  }
  const res = await fetch(`${API}${probe.path(slug)}`, init);
  const text = await res.text();
  let message = "";
  try {
    message = String(JSON.parse(text)?.message ?? "");
  } catch {
    message = "";
  }
  return {
    status: res.status,
    headers: res.headers,
    context: {
      message,
      ssoHeader: res.headers.get("x-github-sso"),
      rateLimitRemaining: res.headers.get("x-ratelimit-remaining"),
    },
  };
}

/** A target that could not be probed: reported as a section, never dropped. */
function unverified(subject, error) {
  return { ...subject, target: subject.display, grants: [], advice: [], error };
}

/** Probe one target and fold the results into a report the renderers accept. */
async function verify(subject, nowMs) {
  if (subject.error !== null) return unverified(subject, subject.error);
  if (subject.token === undefined) {
    return unverified(
      subject,
      `${subject.source} — Phoebe cannot act on this repo without one. ` +
        `Mint it per docs/phoebe-core-onboarding.md §2.`,
    );
  }

  const [metadataProbe, ...rest] = PERMISSION_PROBES;
  let first;
  try {
    first = await callProbe(metadataProbe, subject.slug, subject.token);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return unverified(subject, `could not reach ${API}: ${redact(message, subject.token)}`);
  }

  const tokenKind = classifyTokenKind(subject.token);
  const scopes = parseScopes(first.headers.get("x-oauth-scopes"));
  const expiry = describeExpiry(first.headers.get("github-authentication-token-expiration"), nowMs);
  const metadataState = classifyProbe(metadataProbe, first.status, first.context);
  const grants = [
    { id: metadataProbe.id, ui: metadataProbe.ui, state: metadataState, status: first.status },
  ];

  for (const probe of rest) {
    // A repo the token cannot even see makes every other probe meaningless —
    // and a scope-bearing token cannot be probed at all (see the header), so its
    // scopes are read instead. Either way: no call, and no invented colour.
    if (metadataState !== "granted") {
      grants.push({ id: probe.id, ui: probe.ui, state: "unknown", status: null });
      continue;
    }
    if (scopes !== null) {
      grants.push({
        id: probe.id,
        ui: probe.ui,
        state: scopeCoverage(scopes)[probe.id],
        status: null,
      });
      continue;
    }
    try {
      const res = await callProbe(probe, subject.slug, subject.token);
      grants.push({
        id: probe.id,
        ui: probe.ui,
        state: classifyProbe(probe, res.status, res.context),
        status: res.status,
      });
    } catch {
      grants.push({ id: probe.id, ui: probe.ui, state: "unknown", status: null });
    }
  }

  const verdict = diagnose({ grants, metadataStatus: first.status, expiry, tokenKind });
  return {
    ...subject,
    target: subject.display,
    tokenKind,
    tokenSource: subject.source,
    scopes,
    expiry,
    grants,
    ...verdict,
  };
}

// -------------------------------------------------------------------- output

let targets;
try {
  targets = await resolveTargets();
} catch (error) {
  console.error(
    `[phoebe] ${redact(error instanceof Error ? error.message : String(error), opts.token)}`,
  );
  process.exit(2);
}

const now = Date.now();
const reports = [];
for (const subject of targets) {
  reports.push(await verify(subject, now));
}

if (opts.json) {
  process.stdout.write(
    `${JSON.stringify({
      ok: reports.every((r) => r.error == null && r.ok),
      tenants: reports.map(reportToJson),
    })}\n`,
  );
} else {
  const failing = reports.filter((r) => r.error != null || !r.ok).length;
  console.log(`[phoebe] verify-tenant-token — ${reports.length} tenant(s)\n`);
  console.log(reports.map(renderReport).join("\n\n"));
  console.log(
    failing === 0
      ? `\n${reports.length} of ${reports.length} tenant(s) hold every permission onboarding §2 asks for.`
      : `\n${failing} of ${reports.length} tenant(s) need attention.` +
          (opts.check ? "" : " Re-run with --check to make that an exit code."),
  );
}

process.exitCode = sweepExitCode(reports, opts.check);
