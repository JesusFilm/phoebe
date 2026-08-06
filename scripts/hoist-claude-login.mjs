#!/usr/bin/env node
// Hoist a Claude subscription login into Phoebe's env-file.
//
// Phoebe forwards exactly one env var per provider to the agent child
// (`providerEnv[provider]` in src/agent-env.ts). For a Claude *subscription*
// (Pro/Max) that var is CLAUDE_CODE_OAUTH_TOKEN — a long-lived OAuth token
// minted by `claude setup-token`. This script mints (or accepts) that token and
// upserts it into the .env file your compose `--env-file` already reads, so the
// container authenticates as your subscription instead of billing an API key.
//
// It deliberately does NOT touch the image: the token is a secret and belongs on
// the env-file, never baked into a layer. See docs/claude-subscription-auth.md.
//
// Usage:
//   node scripts/hoist-claude-login.mjs                 # launch `claude setup-token`, paste result
//   node scripts/hoist-claude-login.mjs --token sk-ant-oat01-…   # use a token you already have
//   CLAUDE_CODE_OAUTH_TOKEN=… node scripts/hoist-claude-login.mjs # take it from the environment
//   node scripts/hoist-claude-login.mjs --envfile ./deploy/.env   # write somewhere other than .phoebe/.env
//   node scripts/hoist-claude-login.mjs --no-launch     # never spawn the CLI; require --token/env/stdin

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
function flag(name) {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  return args[i + 1] ?? "";
}
const has = (name) => args.includes(name);

if (has("--help") || has("-h")) {
  console.log(readFileSync(new URL(import.meta.url)).toString().split("\n")
    .filter((l) => l.startsWith("//")).map((l) => l.slice(3)).join("\n"));
  process.exit(0);
}

// NB: the flag is `--envfile`, not `--env-file` — Node itself consumes
// `--env-file` (even after the script path), so a hyphenated name would never
// reach us.
const envFile = resolve(flag("--envfile") ?? ".phoebe/.env");
const VAR = "CLAUDE_CODE_OAUTH_TOKEN";

function readLine(prompt) {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((res) => rl.question(prompt, (a) => { rl.close(); res(a.trim()); }));
}

async function resolveToken() {
  const fromArg = flag("--token");
  if (fromArg) return fromArg.trim();
  if (process.env[VAR]) return process.env[VAR].trim();

  // --no-launch means "don't spawn the CLI" — not "don't accept a paste". Fall
  // straight through to the stdin prompt below so a token minted elsewhere can
  // still be pasted in (as the usage text and docs promise).
  if (!has("--no-launch")) {
    console.error("Launching `claude setup-token` — complete the browser sign-in with your");
    console.error("Claude Pro/Max account, then copy the token it prints.\n");
    const r = spawnSync("claude", ["setup-token"], { stdio: "inherit" });
    if (r.error?.code === "ENOENT") {
      console.error("\n`claude` is not on PATH. Install the CLI (npm i -g @anthropic-ai/claude-code)");
      console.error("or run `claude setup-token` elsewhere and re-run with --token <token>.");
      process.exit(127);
    }
  }
  // setup-token prints the token to the inherited stdout, so we can't capture it
  // directly — ask the operator to paste it back. This is the reliable path
  // across TTY/headless setups.
  const pasted = await readLine("\nPaste the token here: ");
  if (!pasted) { console.error("No token entered."); process.exit(2); }
  return pasted;
}

function upsert(file, key, value) {
  mkdirSync(dirname(file), { recursive: true });
  // Lock the file down *before* the secret touches disk: chmod an existing file
  // first, and create a new one at 0600 — otherwise there's a window where the
  // token is readable at the default umask. Best-effort on non-POSIX.
  const exists = existsSync(file);
  if (exists) {
    try { chmodSync(file, 0o600); } catch { /* best-effort on non-POSIX */ }
  }
  const line = `${key}=${value}`;
  let body = exists ? readFileSync(file, "utf8") : "";
  const re = new RegExp(`^${key}=.*$`, "m");
  if (re.test(body)) {
    body = body.replace(re, line);
  } else {
    if (body && !body.endsWith("\n")) body += "\n";
    body += line + "\n";
  }
  writeFileSync(file, body, { mode: 0o600 });
  try { chmodSync(file, 0o600); } catch { /* best-effort on non-POSIX */ }
}

const token = await resolveToken();
if (/[\r\n]/.test(token)) {
  // A newline in the token would serialize into the .env as extra assignments.
  console.error("Token must not contain line breaks.");
  process.exit(2);
}
if (!token.startsWith("sk-ant-")) {
  console.error(`Warning: token does not look like an OAuth token (expected sk-ant-…). Writing it anyway.`);
}
upsert(envFile, VAR, token);

console.error(`\n✓ Wrote ${VAR} to ${envFile} (mode 0600).`);
console.error(`\nTwo more steps to run Claude under the subscription:`);
console.error(`  1. Point Phoebe's claude provider at the token instead of the API key.`);
console.error(`     In phoebe.config.ts:  providerEnv: { claude: "${VAR}" }`);
console.error(`  2. Make sure the Claude CLI is installed in your image (Dockerfile):`);
console.error(`     RUN npm install -g @anthropic-ai/claude-code@<version>`);
console.error(`  Then rebuild + restart the container. See docs/claude-subscription-auth.md.`);
