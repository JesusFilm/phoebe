// The remote arm's facts, with no React in them (map #690; decided in #697 and
// #699): the rows a machine section holds, what each row says, the join
// between a paired record and a folder on this machine, and the words the add
// modal uses.
//
// **A route is one way of reaching a deployment.** `local` is a folder on this
// machine, read over compose exec; `remote` is a paired record, read over the
// API. A deployment can have both, keyed on `deploymentId`, and the companion
// draws both: once under This machine, once under its host, each row with a
// chip to the other. The badge and the notifications count once per row, not
// per deployment (the owner's call in #699).
//
// **The rail lists machines.** This machine first, then one section per remote
// host with the hostname as its header, holding every record paired there —
// two deployments on one host arm on different ports are two rows under one
// header. Rows sort dark first, then blocked, then anything with a problem,
// then by name.

import type {
  DeploymentReport,
  LocalInstall,
  LocalReportEvent,
  PairResult,
  RemoteRecord,
} from "phoebe-agent/contracts";
import { age } from "./facts.ts";
import { blockedLine, coarseDuration, expiryNotice, hostnameOf, portOf } from "./reachability.ts";
import { cellsOf, childrenOf, readReport, type ReportReading } from "./report.ts";
import type { ConnectionCard } from "./tabs.ts";

/** What is wrong on a row, counted off its last report. */
export type RowProblems = {
  wedged: number;
  crashLooping: number;
  doctorFails: number;
  held: number;
};

const NO_PROBLEMS: RowProblems = { wedged: 0, crashLooping: 0, doctorFails: 0, held: 0 };

/** The problems one report carries, in the counts a row shows. */
export function problemsOf(reading: ReportReading): RowProblems {
  if (reading.kind !== "read") return NO_PROBLEMS;
  const report = reading.report;
  const cells = cellsOf(report);
  const children = childrenOf(report);
  const checks = report.doctor?.report;
  return {
    wedged: cells.filter((cell) => cell.wedged?.wedged === true).length,
    crashLooping: cells.filter((cell) => children.get(cell.id)?.crashLooping === true).length,
    doctorFails:
      checks === null || checks === undefined
        ? 0
        : [...checks.checks, ...checks.tenants.flatMap((row) => row.checks)].filter(
            (check) => check.state === "fail",
          ).length,
    held: (report.fleet?.tenants ?? []).filter((tenant) => tenant.held).length,
  };
}

export function hasProblems(problems: RowProblems): boolean {
  return problems.wedged + problems.crashLooping + problems.doctorFails + problems.held > 0;
}

/** The problems as the sub-line's clauses: `2 wedged · crash-loop · doctor 1`. */
export function problemClauses(problems: RowProblems): string[] {
  const clauses: string[] = [];
  if (problems.wedged > 0) clauses.push(`${problems.wedged} wedged`);
  if (problems.crashLooping > 0) clauses.push("crash-loop");
  if (problems.doctorFails > 0) clauses.push(`doctor ${problems.doctorFails}`);
  if (problems.held > 0) clauses.push(`${problems.held} held`);
  return clauses;
}

/** One record, read for a row. */
export type RemoteRow = {
  record: RemoteRecord;
  hostname: string;
  /** The port beside the name, when it is not 443. */
  port: string | null;
  reading: ReportReading;
  problems: RowProblems;
  /** Dark, blocked and reconnecting freeze the report: nothing on it is current. */
  frozen: boolean;
  /** The mark's tone, and what the row says under the name. */
  tone: "connected" | "disconnected" | "dark" | "blocked";
  text: string;
  /** Blocked's line and action, when blocked. */
  blocked: { text: string; action: "pair again" | "update" } | null;
  /** From three days before the session ends. */
  expiry: string | null;
  /** Counted on the badge: dark, or a problem the row can see. */
  attention: boolean;
};

export function remoteRow(record: RemoteRecord, now: Date): RemoteRow {
  const reading = readReport(record.lastReport);
  const problems = problemsOf(reading);
  const state = record.reachability;
  const frozen = state === "dark" || state === "blocked";
  const blocked =
    state === "blocked" && record.blocked !== undefined ? blockedLine(record.blocked) : null;
  let text: string;
  if (state === "blocked") text = blocked?.text ?? "blocked";
  else if (state === "dark") {
    text = `dark · ${record.lastHeardAt === null ? "never heard" : coarseDuration(Math.max(0, now.getTime() - Date.parse(record.lastHeardAt)))}`;
  } else {
    const clauses = problemClauses(problems);
    text = [state === "disconnected" ? "reconnecting" : "connected", ...clauses].join(" · ");
  }
  return {
    record,
    hostname: hostnameOf(record.url),
    port: portOf(record.url),
    reading,
    problems,
    frozen,
    tone: state,
    text,
    blocked,
    expiry: state === "blocked" ? null : expiryNotice(record.expiresAt, now.getTime()),
    attention: state === "dark" || (!frozen && hasProblems(problems)),
  };
}

/** One machine on the tailnet: its hostname, and every record paired there. */
export type HostSection = { host: string; rows: RemoteRow[] };

function rank(row: RemoteRow): number {
  if (row.tone === "dark") return 0;
  if (row.tone === "blocked") return 1;
  return hasProblems(row.problems) ? 2 : 3;
}

/** The sections, by hostname, sorted; the rows inside each as #699 orders them. */
export function hostSections(records: readonly RemoteRecord[], now: Date): HostSection[] {
  const byHost = new Map<string, RemoteRow[]>();
  for (const record of records) {
    const row = remoteRow(record, now);
    const rows = byHost.get(row.hostname) ?? [];
    rows.push(row);
    byHost.set(row.hostname, rows);
  }
  return [...byHost.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([host, rows]) => ({
      host,
      rows: rows.sort((a, b) => rank(a) - rank(b) || a.record.name.localeCompare(b.record.name)),
    }));
}

/** How many rows need a look: the badge, once per row and never for blocked. */
export function raisedRows(sections: readonly HostSection[]): number {
  return sections.flatMap((section) => section.rows).filter((row) => row.attention).length;
}

// ── the join: a deployment reachable two ways ─────────────────────────────

/** The deployment id a local install's last report carries, or null. */
export function deploymentIdOf(event: LocalReportEvent | null): string | null {
  if (event === null) return null;
  const reading = readReport(event.report);
  if (reading.kind !== "read") return null;
  const id = reading.report.identity?.deploymentId;
  return typeof id === "string" && id.length > 0 ? id : null;
}

/**
 * The paired record for each local install whose report names an id the
 * companion holds, by directory. The chip on the local row.
 */
export function localJoins(
  installs: readonly LocalInstall[],
  events: Readonly<Record<string, LocalReportEvent>>,
  records: readonly RemoteRecord[],
): Record<string, RemoteRecord> {
  const joins: Record<string, RemoteRecord> = {};
  for (const install of installs) {
    const id = deploymentIdOf(events[install.dir] ?? null);
    if (id === null) continue;
    const record = records.find((candidate) => candidate.deploymentId === id);
    if (record !== undefined) joins[install.dir] = record;
  }
  return joins;
}

/**
 * The folder on this machine behind each paired record, by deployment id. The
 * chip on the remote row.
 */
export function remoteJoins(
  installs: readonly LocalInstall[],
  events: Readonly<Record<string, LocalReportEvent>>,
  records: readonly RemoteRecord[],
): Record<string, LocalInstall> {
  const joins: Record<string, LocalInstall> = {};
  for (const record of records) {
    const install = installs.find(
      (candidate) => deploymentIdOf(events[candidate.dir] ?? null) === record.deploymentId,
    );
    if (install !== undefined) joins[record.deploymentId] = install;
  }
  return joins;
}

// ── the remote page ───────────────────────────────────────────────────────

/** The overview's connection card for a remote route. */
export function remoteConnection(record: RemoteRecord, now: Date): ConnectionCard {
  const heard =
    record.lastHeardAt === null
      ? "nothing heard yet"
      : `last heard ${age(record.lastHeardAt, now)} ago`;
  const expires = `session ${record.scopes.join("+")}, expires in ${coarseDuration(Math.max(0, Date.parse(record.expiresAt) - now.getTime()))}`;
  return {
    arm: "Remote",
    detail: record.url.replace(/^https:\/\//, ""),
    note: `Read over the deployment API through this machine's Tailscale: ${record.arm} arm · protocol ${record.protocol} · ${heard} · ${expires}.`,
  };
}

/** What a blocked record's card says beyond the row's line. */
export function blockedDetail(record: RemoteRecord, now: Date): string {
  switch (record.blocked) {
    case "expired":
      return `401 expired · the session ended ${age(record.expiresAt, now)} ago`;
    case "revoked":
      return "401 unknown, and the descriptor still names this deployment: revoked on the other side";
    case "replaced":
      return "the descriptor's deployment id is not the one stored at pair time";
    case "protocol":
      return "the descriptor names a protocol this companion does not know";
    default:
      return "";
  }
}

/** The one-line banner above a remote page's tabs, or null when connected. */
export function pageBanner(row: RemoteRow, now: Date): string | null {
  switch (row.tone) {
    case "connected":
      return null;
    case "disconnected":
      return `Reconnecting · last heard ${row.record.lastHeardAt === null ? "never" : `${age(row.record.lastHeardAt, now)} ago`}. The report below is the last one received.`;
    case "dark":
      return `Dark · ${row.record.lastHeardAt === null ? "nothing heard" : `last heard ${age(row.record.lastHeardAt, now)} ago`}. The report below is the last one received.`;
    case "blocked":
      return `${row.blocked?.text ?? "blocked"} · ${blockedDetail(row.record, now)}. The report below is the last one received.`;
  }
}

/** Can this session change the deployment? */
export function canOperate(record: RemoteRecord): boolean {
  return record.scopes.includes("operate");
}

/** What a disabled operate control says. */
export const NEEDS_OPERATE = "needs operate: this device paired with read only";

/** The tampered banner's words. */
export const TAMPERED_BANNER =
  "sessions.json changed under the bootstrapper. A process sharing the data volume rewrote it. Every row below is shown; revoke anything you did not pair. Doctor's remote check fails until a pair or a revoke rewrites the file.";

/** The report's remote section, read loosely off a reading. */
export function remoteSectionOf(reading: ReportReading): DeploymentReport["remote"] | null {
  if (reading.kind !== "read") return null;
  const section = reading.report.remote;
  return typeof section === "object" && section !== null ? section : null;
}

// ── adding a remote ───────────────────────────────────────────────────────

/** What the one field held: a host, and the code when it was a link. */
export type AddInput = { host: string; code: string };

/**
 * A pairing link or a bare address. `https://<host>/pair#code=XXXX-XXXX-XXXX`
 * carries both; anything else is the host alone and a code field appears.
 */
export function parseAddInput(input: string): AddInput {
  const match = /^(?:https?:\/\/)?([^/#\s]+)(?:\/pair)?\/?(?:#code=([A-Za-z0-9-]+))?\s*$/.exec(
    input.trim(),
  );
  if (match === null) return { host: "", code: "" };
  return { host: match[1] ?? "", code: match[2] ?? "" };
}

/** The URL a pair is sent to: `https://` and the host, nothing else. */
export function addUrl(host: string): string {
  return `https://${host}`;
}

/** The line a failed pair shows, one per outcome. */
export function addFailureLine(
  result: Exclude<PairResult, { outcome: "paired" }>,
  tailscaleRunning: boolean | null,
): string {
  switch (result.outcome) {
    case "tailscale-off":
      return "This machine's Tailscale is off, so no remote can be reached. Start Tailscale, then try again.";
    case "unreachable":
      return tailscaleRunning === false
        ? "This machine's Tailscale is off, so no remote can be reached. Start Tailscale, then try again."
        : "Nothing answered at that address. Is the host on your tailnet, and is Phoebe started there with a remote block?";
    case "not-phoebe":
      return "Something answers at that address, but it is not a Phoebe deployment: no descriptor at /.well-known/phoebe/deployment.";
    case "code-rejected":
      return "That code was not accepted. Codes are single use and last five minutes, so it may already be spent or expired. Mint another on the host with phoebe pair, or from its install tab.";
    case "protocol":
      return "That deployment speaks a newer protocol than this companion. Update the companion, then pair.";
  }
}

export const ADD_EMPTY = "Paste a pairing link, or enter the deployment's address.";
export const CODE_SHAPE = "A code is twelve letters and digits, shown as XXXX-XXXX-XXXX.";

/** Where a successful pair landed, said in one line. */
export function addSuccessLine(input: {
  record: RemoteRecord;
  /** How many rows the host's section held before this pair. */
  sectionHad: number;
  /** The record was already held: this was pair again. */
  repaired: boolean;
  /** The folder on this machine with the same deployment id, when there is one. */
  joined: LocalInstall | null;
}): string[] {
  const host = hostnameOf(input.record.url);
  const lines: string[] = [];
  if (input.repaired) {
    lines.push(
      `Paired again. The row under ${host} kept its label, its last report and what it had already notified.`,
    );
  } else if (input.sectionHad > 0) {
    lines.push(
      `Added to ${host}, which already had ${input.sectionHad === 1 ? "one deployment" : `${input.sectionHad} deployments`}.`,
    );
  } else {
    lines.push(
      `Added as a new machine, ${host}, on the rail. The first event on the stream is the latest report.`,
    );
  }
  if (input.joined !== null) {
    lines.push(
      `This is also the folder at ${input.joined.dir} on this machine, so it now has two rows: the one under This machine reads over compose exec, this one over the API. Each carries a chip to the other.`,
    );
  }
  return lines;
}

/** The name this device offers at pair time. */
export function defaultDeviceLabel(hostName: string | null): string {
  const trimmed = (hostName ?? "").trim();
  return trimmed.length > 0 ? trimmed : "this companion";
}
