// `phoebe pair` — mint a pairing code (map #690; decided in #695, the gate
// recorded in docs/adr/0002-pairing-codes-are-minted-root-only-through-a-file-drop.md).
//
// Two halves, one verb. On the host it checks what has to be true before a
// code is worth minting — the block exists, the arm is up, on the host arm
// Serve answers — and then execs the in-container half as root. Inside, it
// refuses unless it *is* root and `phoebe boot` is the container's main
// process, mints the code, hashes it, drops the hash where only root can write
// (the mint drop), and waits for the bootstrapper to acknowledge. The code
// itself goes to this process's stdout and nowhere else.
//
// Why root: everything in the container shares uid 10001, so a tenant child
// could mint itself a 30-day session on another device if minting were a thing
// uid 10001 could do. The drop is the one root-only path there is. The gate
// defends against a child using what it legitimately has, not against one
// that has already subverted the bootstrapper through `/data/engine`; that is
// model B's job, and docs/trust.md says so.

import { randomBytes } from "node:crypto";
import { readOrMintDeploymentId } from "../bootstrap/deployment-id.ts";
import { deploymentReportPath, readDeploymentReport } from "../bootstrap/deployment-report.ts";
import { askDrop, type DropAnswer } from "../bootstrap/file-drop.ts";
import { MINT_DROP_DIR } from "../bootstrap/mint-drop.ts";
import {
  CODE_LIFETIME_MS,
  formatCode,
  generateCode,
  hashCode,
  type PendingCode,
} from "../bootstrap/pairing-codes.ts";
import { mintAckDir } from "../bootstrap/remote-boot.ts";
import type { DeploymentField, ResolvedRemote } from "./config-schema.ts";
import type { PairOutcome } from "./contracts/pair-outcome.ts";
import type { RemoteScope } from "./contracts/remote-protocol.ts";
import type { ServeOutcome } from "./contracts/start-outcome.ts";
import type { VerbIo } from "./contracts/verb-io.ts";
import {
  execJsonInContainer,
  runningDeployment,
  type ContainerExecDeps,
} from "./container-exec.ts";
import { readDeploymentCommands, readHostRemote } from "./deployment-command.ts";
import { defaultCommandRunner, runCompose } from "./deployment-compose.ts";
import { bootIsMainProcess, isInsideContainer } from "./execution-gate.ts";
import { resolveDataBase } from "./paths.ts";
import { readRemoteUrl } from "./remote-url.ts";
import { PHOEBE_SERVICE } from "./status.ts";
import { reconcileServe } from "./tailscale-serve.ts";
import { PROCESS_IO, SILENT_IO } from "./verb-io.ts";

export type { PairOutcome };

/** How long the root half waits for the bootstrapper to pick the code up. */
export const MINT_ACK_WAIT_MS = 5_000;

export type ParsedPairArgs = { help: boolean; operate: boolean; json: boolean };

export function parsePairArgs(argv: readonly string[]): ParsedPairArgs {
  const parsed: ParsedPairArgs = { help: false, operate: false, json: false };
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") parsed.help = true;
    else if (arg === "--operate") parsed.operate = true;
    else if (arg === "--json") parsed.json = true;
    else
      throw new Error(`Unknown flag \`${arg}\` for \`phoebe pair\`. See \`phoebe pair --help\`.`);
  }
  return parsed;
}

export const PAIR_HELP_TEXT = `phoebe pair — mint a one-time pairing code for the companion (host-side)

Usage:
  phoebe pair              Mint a read-only code; prints the pairing link and the code
  phoebe pair --operate    Mint a code whose session may also change the deployment
  phoebe pair --json       The outcome as JSON, for a program

The code is spendable once, for five minutes. A device spends it through the
companion's "add remote" (paste the link or type the code) and holds a 30-day
session afterwards; \`phoebe sessions\` lists and revokes them.

Needs a "remote" block in phoebe.config.ts and a running container. On the host
arm, Serve is reconciled first so the link names a URL that answers. Inside the
container the verb runs as root and refuses otherwise: that is the gate that
keeps a tenant agent from minting itself a session. See docs/remote.md.
`;

/** The link a mint prints and a QR encodes. */
export function pairingLink(url: string, code: string): string {
  return `${url}/pair#code=${code}`;
}

export type PairDeps = ContainerExecDeps & {
  inContainer?: boolean;
  /** This process's uid; the in-container half refuses anything but 0. */
  uid?: number;
  bootAlive?: boolean;
  env?: NodeJS.ProcessEnv;
  random?: (n: number) => Buffer;
  now?: () => number;
  ask?: (nonce: string, content: string) => Promise<DropAnswer>;
  /** The host arm's Serve reconcile, injectable. */
  serve?: (opts: { port: number; httpsPort: number }) => Promise<ServeOutcome>;
  deploymentCommands?: DeploymentField;
  io?: Partial<VerbIo>;
};

/**
 * The in-container half, as root. Refuses as the header says, then mints.
 */
export async function runPairInContainer(
  opts: { operate: boolean },
  deps: PairDeps = { cwd: "/" },
): Promise<PairOutcome> {
  const uid = deps.uid ?? process.getuid?.() ?? -1;
  if (uid !== 0) {
    throw new Error(
      "`phoebe pair` mints only as root inside the container (the gate that keeps a tenant " +
        "agent from minting itself a session). From the host, `phoebe pair` execs it that way.",
    );
  }
  if (!(deps.bootAlive ?? bootIsMainProcess())) {
    throw new Error(
      "`phoebe boot` is not this container's main process, so nothing would pick the code up.",
    );
  }
  const env = deps.env ?? process.env;
  const dataBase = resolveDataBase(env);
  const report = readDeploymentReport(deploymentReportPath(dataBase));
  const remote = report?.remote;
  if (remote === undefined || !remote.configured) {
    throw new Error(
      "this deployment has no `remote` block, so there is nothing to pair with. Add " +
        '`remote: { tailscale: "sidecar" }` or `{ tailscale: "host" }` to phoebe.config.ts, ' +
        "then `phoebe stop` and `phoebe start`.",
    );
  }
  // On the host arm the URL arrives through `phoebe remote-url`, and the
  // bootstrapper reads that file on a timer — so a `phoebe pair` straight
  // after `phoebe start` can beat the report. The file is the same truth.
  const url = remote.url ?? (remote.arm === "host" ? readRemoteUrl(dataBase) : null);
  if (url === null) {
    throw new Error(
      remote.arm === "sidecar"
        ? "the sidecar has not joined the tailnet yet — the deployment has no URL to put in a link. " +
            "Check TS_AUTHKEY in .env and `docker compose logs tailscale`, then try again."
        : "the deployment does not know its tailnet URL yet — run `phoebe start` on the host, " +
            "which reconciles Serve and records it.",
    );
  }
  const scopes: RemoteScope[] = opts.operate ? ["read", "operate"] : ["read"];
  const random = deps.random ?? randomBytes;
  const now = deps.now ?? Date.now;
  const code = generateCode(random);
  const nonce = random(12).toString("base64url");
  const expiresAt = new Date(now() + CODE_LIFETIME_MS).toISOString();
  const pending: PendingCode = { nonce, hash: hashCode(code), scopes, expiresAt };
  const ask =
    deps.ask ??
    ((n: string, content: string) =>
      askDrop(n, content, {
        dir: MINT_DROP_DIR,
        ackDir: mintAckDir(dataBase),
        waitMs: MINT_ACK_WAIT_MS,
      }));
  const answer = await ask(nonce, JSON.stringify(pending));
  if (answer.kind === "unanswered") {
    throw new Error(
      "the deployment did not pick the code up within 5 s — is `phoebe boot` running with a " +
        "`remote` block, and does /run/phoebe-mint exist in the image (`phoebe doctor` → remote)?",
    );
  }
  if (answer.kind === "refused")
    throw new Error(`the deployment refused the code: ${answer.detail}`);
  return {
    url: pairingLink(url, formatCode(code)),
    code: formatCode(code),
    expiresAt,
    scopes,
    deploymentId: report?.identity.deploymentId ?? readOrMintDeploymentId(dataBase),
  };
}

/** What the host prints when the deployment drives its own runtime (#261). */
export function pairDeploymentBlockMessage(operate: boolean): string {
  return (
    "`phoebe pair` mints inside the container, and a config with a `deployment` block has no " +
    "Compose file to exec through. Run it in your own runtime, as root — for Docker that is " +
    `\`docker exec -u root <container> phoebe pair${operate ? " --operate" : ""}\`.`
  );
}

/**
 * The host half: the preconditions, Serve on the host arm, then the exec.
 * Nothing here sees the code except as the outcome it hands back.
 */
export async function runPair(opts: { operate: boolean; deps?: PairDeps }): Promise<PairOutcome> {
  const deps: PairDeps = opts.deps ?? { cwd: process.cwd() };
  const io: VerbIo = { ...SILENT_IO, ...deps.io };
  if (deps.inContainer ?? isInsideContainer()) return runPairInContainer(opts, deps);

  if (deps.deploymentCommands !== undefined)
    throw new Error(pairDeploymentBlockMessage(opts.operate));
  const remote = deps.remote;
  if (remote === undefined) {
    throw new Error(
      "phoebe.config.ts has no `remote` block, so there is nothing to pair with. Add " +
        '`remote: { tailscale: "sidecar" }` or `{ tailscale: "host" }`, re-run `phoebe init` ' +
        "for the overlays if this install predates them, then `phoebe stop` and `phoebe start`. " +
        "See docs/remote.md.",
    );
  }
  const deployment = await runningDeployment("pair", deps);

  if (remote.arm === "host") {
    // Serve first, so a code never points at a URL nobody can open.
    const serve =
      deps.serve ??
      ((ports: { port: number; httpsPort: number }) =>
        reconcileServe(ports, {
          run: defaultCommandRunner,
          fetchFn: fetch,
          ...(deps.env !== undefined ? { env: deps.env } : {}),
          log: io.stdout,
        }));
    const outcome: ServeOutcome = await serve({ port: remote.port, httpsPort: remote.httpsPort });
    if (outcome.state === "refused")
      throw new Error(`Serve is not serving this deployment: ${outcome.detail}`);
    await runCompose({
      deployment,
      args: ["exec", "-T", PHOEBE_SERVICE, "phoebe", "remote-url", outcome.url],
      ...(deps.runner !== undefined ? { runner: deps.runner } : {}),
      remote,
      ...(deps.env !== undefined ? { env: deps.env } : {}),
    });
    if (outcome.state === "pending") {
      io.stderr(
        `[phoebe] ${outcome.url}'s certificate is still being issued; the link below works once it lands.`,
      );
    }
  }

  io.stdout("[phoebe] code minted");
  return execJsonInContainer<PairOutcome>({
    deployment,
    args: ["pair", ...(opts.operate ? ["--operate"] : []), "--json"],
    user: "root",
    deps,
  });
}

/** The shell lines: the link, the code alone, the scopes, and when it stops being spendable. */
export function formatPairOutcome(outcome: PairOutcome): string {
  const until = new Date(outcome.expiresAt);
  const hh = String(until.getHours()).padStart(2, "0");
  const mm = String(until.getMinutes()).padStart(2, "0");
  return [
    outcome.url,
    "",
    `  code    ${outcome.code}`,
    `  scopes  ${outcome.scopes.join(", ")}`,
    `  spendable for 5 minutes, until ${hh}:${mm}`,
  ].join("\n");
}

/** `phoebe pair` entry. The one place the code reaches a terminal. */
export async function runPairCli(argv: readonly string[], deps?: PairDeps): Promise<void> {
  const parsed = parsePairArgs(argv);
  if (parsed.help) {
    process.stdout.write(PAIR_HELP_TEXT);
    return;
  }
  const inContainer = deps?.inContainer ?? isInsideContainer();
  const cwd = deps?.cwd ?? process.cwd();
  const hostDeps: PairDeps = inContainer
    ? { ...deps, cwd, inContainer }
    : {
        ...deps,
        cwd,
        inContainer,
        ...(deps?.deploymentCommands === undefined
          ? await hostDeploymentCommands(cwd)
          : { deploymentCommands: deps.deploymentCommands }),
        ...(deps?.remote === undefined ? await hostRemote(cwd) : { remote: deps.remote }),
        io: { ...PROCESS_IO, ...deps?.io },
      };
  const outcome = await runPair({ operate: parsed.operate, deps: hostDeps });
  process.stdout.write(
    parsed.json ? `${JSON.stringify(outcome)}\n` : `${formatPairOutcome(outcome)}\n`,
  );
}

async function hostDeploymentCommands(
  cwd: string,
): Promise<{ deploymentCommands?: DeploymentField }> {
  const commands = await readDeploymentCommands(cwd);
  return commands !== undefined ? { deploymentCommands: commands } : {};
}

async function hostRemote(cwd: string): Promise<{ remote?: ResolvedRemote }> {
  const remote = await readHostRemote(cwd);
  return remote !== undefined ? { remote } : {};
}
