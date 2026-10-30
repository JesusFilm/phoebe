// `phoebe sessions` — the devices paired with this deployment, and revoking
// them from a shell (map #690, decided in #696).
//
// The store is uid 10001's, so the verb runs as uid 10001 and never as root.
// Listing reads the file. Revoking does not write it: the bootstrapper is the
// one process that writes `state/sessions.json`, which is what keeps its
// tampered flag meaning something, so a revoke is an ask through the revoke
// drop under `state/` that the bootstrapper carries out and acknowledges. A
// revoke is a log line on the bootstrapper's channel, never an edit-ledger
// entry: the ledger is the config pen's.
//
// On the host it is the same thin exec `phoebe status` is, as uid 10001.

import { randomBytes } from "node:crypto";
import { askDrop, type DropAnswer } from "../bootstrap/file-drop.ts";
import { revokeAckDir, revokeDropDir } from "../bootstrap/remote-boot.ts";
import { createSessions, isExpired, type Sessions } from "../bootstrap/remote-sessions.ts";
import type { DeploymentField } from "./config-schema.ts";
import type { SessionsOutcome } from "./contracts/pair-outcome.ts";
import type { SessionRow } from "./contracts/remote-protocol.ts";
import type { VerbIo } from "./contracts/verb-io.ts";
import {
  execJsonInContainer,
  runningDeployment,
  type ContainerExecDeps,
} from "./container-exec.ts";
import { readDeploymentCommands, readHostRemote } from "./deployment-command.ts";
import { isInsideContainer } from "./execution-gate.ts";
import { resolveDataBase } from "./paths.ts";
import { formatAge } from "./pipeline-listing.ts";
import { PROCESS_IO, SILENT_IO } from "./verb-io.ts";

export type { SessionsOutcome };

/** How long the shell half waits for the bootstrapper to carry out a revoke. */
export const REVOKE_ACK_WAIT_MS = 5_000;

export type SessionsAction =
  | { action: "list" }
  | { action: "revoke"; id: string }
  | { action: "revoke"; all: true };

export type ParsedSessionsArgs = { help: boolean; json: boolean; action: SessionsAction };

export function parseSessionsArgs(argv: readonly string[]): ParsedSessionsArgs {
  let help = false;
  let json = false;
  const positionals: string[] = [];
  let all = false;
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") help = true;
    else if (arg === "--json") json = true;
    else if (arg === "--all") all = true;
    else if (arg.startsWith("-")) {
      throw new Error(
        `Unknown flag \`${arg}\` for \`phoebe sessions\`. See \`phoebe sessions --help\`.`,
      );
    } else positionals.push(arg);
  }
  const [verb, id] = positionals;
  if (verb === undefined || verb === "list") {
    if (all || id !== undefined) throw new Error("Usage: phoebe sessions [list] [--json]");
    return { help, json, action: { action: "list" } };
  }
  if (verb === "revoke") {
    if (all && id === undefined) return { help, json, action: { action: "revoke", all: true } };
    if (!all && id !== undefined) return { help, json, action: { action: "revoke", id } };
    throw new Error("Usage: phoebe sessions revoke <id> | phoebe sessions revoke --all");
  }
  throw new Error(
    `Unknown subcommand \`${verb}\` for \`phoebe sessions\`. See \`phoebe sessions --help\`.`,
  );
}

export const SESSIONS_HELP_TEXT = `phoebe sessions — the devices paired with this deployment

Usage:
  phoebe sessions [list] [--json]       Every session: label, device, scopes, last seen, expiry
  phoebe sessions revoke <id> [--json]  End one session; its device gets 401 on its next request
  phoebe sessions revoke --all          End every session

Runs either side of the container wall. On the host it execs itself in the
container as the unprivileged user, the way \`phoebe status\` does. A revoke is
carried out by the bootstrapper, so the sessions file keeps one writer; a
device signs itself out from the companion instead. See docs/remote.md.
`;

export type SessionsDeps = ContainerExecDeps & {
  inContainer?: boolean;
  env?: NodeJS.ProcessEnv;
  store?: Sessions;
  ask?: (nonce: string, content: string) => Promise<DropAnswer>;
  random?: (n: number) => Buffer;
  now?: () => number;
  deploymentCommands?: DeploymentField;
  io?: Partial<VerbIo>;
};

/** The in-container half, as uid 10001. */
export async function runSessionsInContainer(
  action: SessionsAction,
  deps: SessionsDeps = { cwd: "/" },
): Promise<SessionsOutcome> {
  const env = deps.env ?? process.env;
  const dataBase = resolveDataBase(env);
  const store = deps.store ?? createSessions(dataBase);
  const now = deps.now ?? Date.now;
  let revoked = 0;
  if (action.action === "revoke") {
    const nonce = (deps.random ?? randomBytes)(12).toString("base64url");
    const ask =
      deps.ask ??
      ((n: string, content: string) =>
        askDrop(n, content, {
          dir: revokeDropDir(dataBase),
          ackDir: revokeAckDir(dataBase),
          waitMs: REVOKE_ACK_WAIT_MS,
        }));
    const body = "all" in action ? { all: true } : { id: action.id };
    const answer = await ask(nonce, JSON.stringify(body));
    if (answer.kind === "unanswered") {
      throw new Error(
        "the bootstrapper did not carry the revoke out within 5 s — is `phoebe boot` running " +
          "with a `remote` block?",
      );
    }
    if (answer.kind === "refused")
      throw new Error(`the bootstrapper refused the revoke: ${answer.detail}`);
    revoked = Number.parseInt(answer.detail, 10) || 0;
    if (!("all" in action) && revoked === 0) {
      throw new Error(`no session has the id ${action.id} — \`phoebe sessions\` lists them.`);
    }
  }
  return { sessions: store.list(new Date(now())), revoked, at: new Date(now()).toISOString() };
}

/** What the host says when the deployment drives its own runtime (#261). */
export function sessionsDeploymentBlockMessage(): string {
  return (
    "`phoebe sessions` reads the sessions file inside the container, and a config with a " +
    "`deployment` block has no Compose file to exec through. Run it in your own runtime — for " +
    "Docker that is `docker exec <container> phoebe sessions`."
  );
}

/** The verb, either side of the wall. */
export async function runSessions(opts: {
  action: SessionsAction;
  deps?: SessionsDeps;
}): Promise<SessionsOutcome> {
  const deps: SessionsDeps = opts.deps ?? { cwd: process.cwd() };
  if (deps.inContainer ?? isInsideContainer()) return runSessionsInContainer(opts.action, deps);
  if (deps.deploymentCommands !== undefined) throw new Error(sessionsDeploymentBlockMessage());
  const deployment = await runningDeployment("sessions", deps);
  const args =
    opts.action.action === "list"
      ? ["sessions", "list", "--json"]
      : "all" in opts.action
        ? ["sessions", "revoke", "--all", "--json"]
        : ["sessions", "revoke", opts.action.id, "--json"];
  // As uid 10001, never root: the store is uid 10001's.
  return execJsonInContainer<SessionsOutcome>({ deployment, args, deps });
}

/** The table a shell prints. */
export function formatSessions(outcome: SessionsOutcome): string {
  const now = Date.parse(outcome.at);
  const lines: string[] = [];
  if (outcome.revoked > 0)
    lines.push(`[phoebe] revoked ${outcome.revoked} session${outcome.revoked === 1 ? "" : "s"}.`);
  if (outcome.sessions.length === 0) {
    lines.push("[phoebe] no devices paired.");
    return lines.join("\n");
  }
  lines.push(
    `[phoebe] ${outcome.sessions.length} session${outcome.sessions.length === 1 ? "" : "s"}:`,
  );
  for (const row of outcome.sessions) lines.push(formatSessionRow(row, now));
  return lines.join("\n");
}

function formatSessionRow(row: SessionRow, now: number): string {
  const expired = isExpired(row, new Date(now));
  const who = row.pairedAs === null ? "" : `  ${row.pairedAs}`;
  const seen = `last seen ${formatAge(Math.max(0, now - Date.parse(row.lastSeenAt)))} ago`;
  const expiry = expired
    ? "expired"
    : `expires in ${formatAge(Math.max(0, Date.parse(row.expiresAt) - now))}`;
  return `  ${row.id}  ${row.label} (${row.deviceType}, ${row.os})${who}  ${row.scopes.join("+")}  ${seen}  ${expiry}`;
}

/** `phoebe sessions` entry. */
export async function runSessionsCli(argv: readonly string[], deps?: SessionsDeps): Promise<void> {
  const parsed = parseSessionsArgs(argv);
  if (parsed.help) {
    process.stdout.write(SESSIONS_HELP_TEXT);
    return;
  }
  const inContainer = deps?.inContainer ?? isInsideContainer();
  const cwd = deps?.cwd ?? process.cwd();
  const io: VerbIo = { ...SILENT_IO, ...PROCESS_IO, ...deps?.io };
  const full: SessionsDeps = inContainer
    ? { ...deps, cwd, inContainer, io }
    : {
        ...deps,
        cwd,
        inContainer,
        io,
        ...(deps?.deploymentCommands === undefined
          ? await hostDeploymentCommands(cwd)
          : { deploymentCommands: deps.deploymentCommands }),
        ...(deps?.remote === undefined ? await hostRemote(cwd) : { remote: deps.remote }),
      };
  const outcome = await runSessions({ action: parsed.action, deps: full });
  process.stdout.write(
    parsed.json ? `${JSON.stringify(outcome)}\n` : `${formatSessions(outcome)}\n`,
  );
}

async function hostDeploymentCommands(
  cwd: string,
): Promise<{ deploymentCommands?: DeploymentField }> {
  const commands = await readDeploymentCommands(cwd);
  return commands !== undefined ? { deploymentCommands: commands } : {};
}

async function hostRemote(cwd: string): Promise<{ remote?: SessionsDeps["remote"] }> {
  const remote = await readHostRemote(cwd);
  return remote !== undefined ? { remote } : {};
}
