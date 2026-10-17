// `tailscale serve` on the host arm (map #690, decided in #691 and #693; the
// refuse-on-foreign-mapping rule from #706).
//
// The host's own Tailscale serves the loopback port the container publishes.
// `phoebe start` reconciles that mapping after `up -d`, and `phoebe pair` runs
// the same function before minting, so a pairing link never names a URL nobody
// can open. The whole of it is argv spawns of the `tailscale` CLI plus two HTTPS
// probes, and every step is injectable so the tests drive it with a fake CLI.
//
// **Three outcomes at the probe, and one rule before it.** The rule: a mapping
// already on `httpsPort` that points anywhere other than this deployment's
// loopback port is refused and named — on the owner's machine a blind
// `serve --bg --https=443` replaced an unrelated proxy (#706). Then the probe of
// the tailnet URL: unreachable, or 502/503/504 (a stale mapping to a dead
// backend), means map it; our own descriptor means leave it; any other
// responder means refuse and name it.
//
// **Stderr is classified, never stored or echoed.** `tailscale` prints the auth
// key into some of its errors, and a `tskey-` in a log line is a credential in
// a log line.

import { accessSync, constants, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { DESCRIPTOR_PATH } from "./contracts/remote-protocol.ts";
import type { ServeOutcome } from "./contracts/start-outcome.ts";
import type { CommandResult, CommandRunner } from "./deployment-compose.ts";

/** The App Store build keeps its CLI inside the bundle, off PATH. */
export const MACOS_BUNDLE_CLI = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";

/** How long one probe of the tailnet URL may take. */
export const PROBE_TIMEOUT_MS = 2_500;

/**
 * How long to wait for the first-request certificate. Serve orders it on the
 * first TLS handshake through Let's Encrypt's DNS-01, which is tens of seconds;
 * T3 gives up after five and prints a note. A minute, polling each second.
 */
export const CERTIFICATE_WAIT_MS = 60_000;
export const CERTIFICATE_POLL_MS = 1_000;

/** Why a `tailscale` invocation failed, as much as is safe to say. */
export type ServeStderrClass =
  | "no-existing-handler"
  | "not-logged-in"
  | "permission-denied"
  | "unknown";

/** The CLI, once found: the file to spawn and how it was found. */
export type TailscaleCli = { file: string; via: "path" | "macos-bundle" | "wsl-interop" };

export type ServeDeps = {
  /** Spawns the CLI. Never a shell string. */
  run: CommandRunner;
  fetchFn: typeof fetch;
  /** The environment the CLI is looked for in. */
  env?: NodeJS.ProcessEnv;
  platform?: string;
  /** `/proc/version`, for the WSL interop arm. */
  readProcVersion?: () => string;
  access?: (path: string, mode: number) => void;
  /** The certificate wait's clock. Tests pass a no-op. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** A line for the operator as the reconcile goes. */
  log?: (line: string) => void;
};

/**
 * Classify a `tailscale` failure by three anchored patterns. Nothing of the
 * text itself survives: the auth key can be in it.
 */
export function classifyServeStderr(stderr: string): ServeStderrClass {
  if (/no .*handler|not found|nothing to remove/i.test(stderr)) return "no-existing-handler";
  if (/logged out|not logged in|needs login|NeedsLogin|Logged out/i.test(stderr)) {
    return "not-logged-in";
  }
  if (/permission denied|access is denied|operator|requires (root|admin)/i.test(stderr)) {
    return "permission-denied";
  }
  return "unknown";
}

/** `tailscale status --json`, read down to the two fields this needs. */
export type TailscaleStatus = { backendState: string; dnsName: string | null };

export function parseTailscaleStatus(stdout: string): TailscaleStatus | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as { BackendState?: unknown; Self?: { DNSName?: unknown } };
  const backendState = typeof record.BackendState === "string" ? record.BackendState : "unknown";
  const raw = record.Self?.DNSName;
  // `host.<tailnet>.ts.net.`, with the trailing dot a DNS name carries and a
  // URL does not.
  const dnsName = typeof raw === "string" && raw.length > 0 ? raw.replace(/\.$/, "") : null;
  return { backendState, dnsName };
}

/**
 * The proxy target a Serve config maps `<dns>:<port>` to, or null when the
 * port carries no web handler. `tailscale serve status --json` prints the
 * daemon's `ServeConfig`: `Web["host:443"].Handlers["/"].Proxy`.
 */
export function serveTargetOn(stdout: string, dnsName: string, httpsPort: number): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const web = (parsed as { Web?: Record<string, unknown> }).Web;
  if (typeof web !== "object" || web === null) return null;
  const key = `${dnsName}:${httpsPort}`;
  // Case-insensitive on the host: Tailscale writes the DNS name as the admin
  // console shows it, which can differ in case from `Self.DNSName`.
  const entry = Object.entries(web).find(([name]) => name.toLowerCase() === key.toLowerCase());
  if (entry === undefined) return null;
  const handlers = (entry[1] as { Handlers?: Record<string, { Proxy?: unknown }> }).Handlers;
  const root = handlers?.["/"];
  return typeof root?.Proxy === "string" ? root.Proxy : null;
}

/** Is this process inside a WSL distro, where `tailscale.exe` is the Windows client? */
function insideWsl(deps: ServeDeps): boolean {
  if ((deps.platform ?? process.platform) !== "linux") return false;
  const read = deps.readProcVersion ?? (() => readFileSync("/proc/version", "utf8"));
  try {
    return read().toLowerCase().includes("microsoft");
  } catch {
    return false;
  }
}

/**
 * Find the CLI: PATH, then the macOS App Store bundle, then `tailscale.exe`
 * through WSL interop (#693). Null when none answers.
 */
export function findTailscaleCli(deps: ServeDeps): TailscaleCli | null {
  const env = deps.env ?? process.env;
  const access = deps.access ?? accessSync;
  const platform = deps.platform ?? process.platform;
  const executable = (path: string): boolean => {
    try {
      access(path, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  for (const dir of (env["PATH"] ?? "").split(delimiter)) {
    if (dir.length === 0) continue;
    const candidate = join(dir, platform === "win32" ? "tailscale.exe" : "tailscale");
    if (executable(candidate)) return { file: candidate, via: "path" };
  }
  if (platform === "darwin" && executable(MACOS_BUNDLE_CLI)) {
    return { file: MACOS_BUNDLE_CLI, via: "macos-bundle" };
  }
  if (insideWsl(deps)) return { file: "tailscale.exe", via: "wsl-interop" };
  return null;
}

/** The tailnet URL for one node and port: `https://<dns>` with the port only when it is not 443. */
export function tailnetUrl(dnsName: string, httpsPort: number): string {
  return httpsPort === 443 ? `https://${dnsName}` : `https://${dnsName}:${httpsPort}`;
}

/** The loopback target Serve must proxy to for this deployment. */
export function loopbackTarget(port: number): string {
  return `http://127.0.0.1:${port}`;
}

/**
 * What one probe of a descriptor URL found: the descriptor, that nothing
 * answers (or a proxy with a dead backend, which is the same thing for this
 * purpose), or something else entirely.
 */
export type ProbeResult =
  | { kind: "descriptor"; deploymentId: string; name: string }
  | { kind: "unreachable"; detail: string }
  | { kind: "other"; detail: string };

export async function probeDescriptor(url: string, fetchFn: typeof fetch): Promise<ProbeResult> {
  let response: Response;
  try {
    response = await fetchFn(`${url}${DESCRIPTOR_PATH}`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
  } catch (error) {
    return { kind: "unreachable", detail: error instanceof Error ? error.message : String(error) };
  }
  // 502 is Go's reverse proxy with a dead backend, 503 a proxy being closed,
  // 504 one that timed out: a mapping to nothing, which is the unreachable case.
  if (response.status === 502 || response.status === 503 || response.status === 504) {
    return { kind: "unreachable", detail: `HTTP ${response.status} (a stale mapping)` };
  }
  if (response.status !== 200) {
    return { kind: "other", detail: `HTTP ${response.status} from ${url}` };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { kind: "other", detail: `${url} answered 200 with something that is not JSON` };
  }
  const record = body as { deploymentId?: unknown; name?: unknown } | null;
  if (
    typeof record !== "object" ||
    record === null ||
    typeof record.deploymentId !== "string" ||
    typeof record.name !== "string"
  ) {
    return { kind: "other", detail: `${url} answered 200 but not with a Phoebe descriptor` };
  }
  return { kind: "descriptor", deploymentId: record.deploymentId, name: record.name };
}

/** One CLI call, with its failure classified rather than quoted. */
async function tailscale(
  cli: TailscaleCli,
  args: readonly string[],
  deps: ServeDeps,
): Promise<{ ok: true; stdout: string } | { ok: false; why: ServeStderrClass }> {
  let result: CommandResult;
  try {
    result = await deps.run({ file: cli.file, args });
  } catch {
    return { ok: false, why: "unknown" };
  }
  if (result.code !== 0) return { ok: false, why: classifyServeStderr(result.stderr) };
  return { ok: true, stdout: result.stdout };
}

function whyText(why: ServeStderrClass, cli: TailscaleCli): string {
  switch (why) {
    case "not-logged-in":
      return "this machine's Tailscale is logged out — `tailscale up` and try again";
    case "permission-denied":
      return `\`${cli.file}\` refused for lack of permission — on Linux, make yourself the operator (\`sudo tailscale set --operator=$USER\`)`;
    case "no-existing-handler":
      return "Tailscale reported no handler where one was expected";
    default:
      return `\`${cli.file}\` failed; run it by hand to see why (its output is not echoed here, since it can carry an auth key)`;
  }
}

/**
 * What a read-only look at Serve found (the doctor `remote` check runs this
 * and changes nothing; `reconcileServe` runs it and then acts).
 *
 *   - `ready`     the tailnet URL answers with this deployment's descriptor.
 *   - `unmapped`  nothing answers there, or a stale mapping does: `serve --bg`
 *                 would fix it.
 *   - `refused`   something stands in the way, named in `detail`.
 */
export type ServeInspection =
  | { state: "ready"; url: string }
  | { state: "unmapped"; url: string; cli: TailscaleCli; target: string; deploymentId: string }
  | { state: "refused"; detail: string };

/**
 * Steps one to four of the reconcile, without the one that changes anything:
 * find the CLI, read the node's state and name, read the deployment's own
 * descriptor off loopback, refuse a foreign mapping, and probe the tailnet URL.
 */
export async function inspectServe(
  opts: { port: number; httpsPort: number },
  deps: ServeDeps,
): Promise<ServeInspection> {
  const log = deps.log ?? (() => {});
  const cli = findTailscaleCli(deps);
  if (cli === null) {
    return {
      state: "refused",
      detail:
        "no `tailscale` CLI on PATH (nor the macOS bundle, nor `tailscale.exe` through WSL). " +
        "Install Tailscale on this machine, or use the sidecar arm.",
    };
  }

  const status = await tailscale(cli, ["status", "--json"], deps);
  if (!status.ok) return { state: "refused", detail: whyText(status.why, cli) };
  const parsed = parseTailscaleStatus(status.stdout);
  if (parsed === null) {
    return { state: "refused", detail: "`tailscale status --json` did not print a status" };
  }
  // A logged-out node has no DNS name either; reading the state first is what
  // keeps that from being reported as "MagicDNS is off" (T3's misreport, #693).
  if (parsed.backendState !== "Running") {
    return {
      state: "refused",
      detail: `this machine's Tailscale is ${parsed.backendState}, not Running — bring it up and try again`,
    };
  }
  if (parsed.dnsName === null) {
    return {
      state: "refused",
      detail: "this node has no MagicDNS name — enable MagicDNS on the tailnet, or set one",
    };
  }
  const url = tailnetUrl(parsed.dnsName, opts.httpsPort);
  const target = loopbackTarget(opts.port);

  // The deployment's own descriptor, off the loopback port the overlay
  // publishes. Nothing there means nothing to serve.
  const own = await probeDescriptor(target, deps.fetchFn);
  if (own.kind !== "descriptor") {
    return {
      state: "refused",
      detail:
        `nothing answers the descriptor on ${target} (${own.detail}) — is the container up ` +
        `with container/compose.tailscale-host.yml, and does its config carry the \`remote\` block?`,
    };
  }

  // The rule before the probe (#706): a mapping on this port that points
  // elsewhere is somebody else's, and `serve --bg` would silently replace it.
  const mappings = await tailscale(cli, ["serve", "status", "--json"], deps);
  if (mappings.ok) {
    const existing = serveTargetOn(mappings.stdout, parsed.dnsName, opts.httpsPort);
    if (existing !== null && existing !== target) {
      return {
        state: "refused",
        detail:
          `${url} already proxies to ${existing}, which is not this deployment. Not overwriting ` +
          `it: pick another \`remote.httpsPort\`, or remove that mapping yourself ` +
          `(\`tailscale serve --https=${opts.httpsPort} off\`).`,
      };
    }
  }

  // The three outcomes.
  const seen = await probeDescriptor(url, deps.fetchFn);
  if (seen.kind === "descriptor") {
    if (seen.deploymentId === own.deploymentId) {
      log(`[phoebe] ${url} already serves this deployment.`);
      return { state: "ready", url };
    }
    return {
      state: "refused",
      detail:
        `${url} answers with a different Phoebe deployment (${seen.name}). Not overwriting ` +
        `its mapping: pick another \`remote.httpsPort\`.`,
    };
  }
  if (seen.kind === "other") {
    return {
      state: "refused",
      detail: `${url} answers, but not as a Phoebe deployment (${seen.detail}). Not overwriting what serves it.`,
    };
  }
  return { state: "unmapped", url, cli, target, deploymentId: own.deploymentId };
}

/**
 * Reconcile Serve on the host arm: {@link inspectServe}, then on `unmapped`
 * the one `serve --bg` and the wait for the first-request certificate. Every
 * spawn and probe is through `deps`.
 *
 * `port` is the loopback port the container publishes, `httpsPort` the
 * tailnet-side one.
 */
export async function reconcileServe(
  opts: { port: number; httpsPort: number },
  deps: ServeDeps,
): Promise<ServeOutcome> {
  const log = deps.log ?? (() => {});
  const sleep = deps.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? Date.now;

  const seen = await inspectServe(opts, deps);
  if (seen.state !== "unmapped") return seen;
  const { url, cli, target, deploymentId } = seen;

  log(`[phoebe] mapping ${url} → ${target} with \`tailscale serve\`.`);
  const mapped = await tailscale(cli, ["serve", "--bg", `--https=${opts.httpsPort}`, target], deps);
  if (!mapped.ok) return { state: "refused", detail: whyText(mapped.why, cli) };

  // The certificate: ordered on the first handshake, so the first probe is the
  // one that starts it, and the wait is for Let's Encrypt.
  const deadline = now() + CERTIFICATE_WAIT_MS;
  let noted = false;
  while (true) {
    const again = await probeDescriptor(url, deps.fetchFn);
    if (again.kind === "descriptor" && again.deploymentId === deploymentId) {
      return { state: "ready", url };
    }
    if (again.kind === "descriptor" || again.kind === "other") {
      return {
        state: "refused",
        detail: `${url} answered after mapping, but not with this deployment (${again.kind === "other" ? again.detail : again.name})`,
      };
    }
    if (now() >= deadline) break;
    if (!noted) {
      log(`[phoebe] waiting for ${url}'s certificate — the first request orders it.`);
      noted = true;
    }
    await sleep(CERTIFICATE_POLL_MS);
  }
  log(
    `[phoebe] ${url} is mapped, but its certificate is still being issued. ` +
      `It answers once Let's Encrypt completes; try the link again in a minute.`,
  );
  return { state: "pending", url };
}
