// Phoebe's crash reporter (#474): its *own* install and upgrade faults, posted
// to a Sentry project as one envelope each — the bootstrapper's boot failures
// and crash-loop verdicts, and the operator commands throwing. The work loop
// never reports: a tenant's install script failing or a unit timing out is
// the tenant's repository misbehaving, not Phoebe, and stays in its logs.
//
// No runtime dependency. The envelope endpoint is one HTTPS POST with an
// `X-Sentry-Auth` header derived from the DSN (src/sentry-protocol.ts owns
// the parsing, shared with the `sentry` kind's read adapter). Fire-and-forget:
// one attempt, a short timeout, a failure logged at debug and never allowed to
// change a command's exit code or delay a boot. The one place that waits is
// the bootstrapper's exit path, which flushes so a crash-loop report is not
// lost to the process ending.
//
// Two targets, one switch each, both default off: `reporting.maintainers`
// (the Phoebe project's DSN, baked in below) and `reporting.dsn` (the
// consumer's own). Neither set means no client and no network call.

import { readEngineSource } from "../bootstrap/engine-source.ts";
import { resolveCredentialArm, type CredentialArm } from "../bootstrap/credential-arm.ts";
import { readReportingField, type ReportingField } from "./config-schema.ts";
import { loadUserConfig } from "./load-config.ts";
import { DEFAULT_DATA_BASE, resolveDataBase } from "./paths.ts";
import { parseDsn, type FetchLike, type ParsedDsn } from "./sentry-protocol.ts";

/**
 * The maintainers' project DSN — the engine's own Sentry project, the one this
 * repository's tenant triages through the `sentry` kind. A Sentry DSN is a public client key, so shipping one is the
 * SDK-standard shape; rotating it is an engine release. The type admits `null`
 * so a fork with no project of its own can blank it, at which point
 * `maintainers: true` builds no client and says so at debug level.
 */
export const MAINTAINERS_DSN: string | null =
  "https://be755f854cd91a633041ed8e621e58c3@o4512031715164160.ingest.us.sentry.io/4512031884050432";

/** Which of Phoebe's own phases a fault belongs to — the `phase` tag. */
export type CrashPhase = "boot" | "upgrade" | "migrate" | "init" | "doctor";

/** What every event carries about the process that sent it. */
export type CrashContext = {
  bootstrapVersion: string | null;
  engineRef: string | null;
  engineSha: string | null;
  /** The deployment arm: one tenant, or a fleet. */
  deploymentArm: "solo" | "workspace" | null;
  credentialArm: CredentialArm | null;
};

/** One fault. `error` is whatever was thrown; `message` overrides its text. */
export type CrashEvent = {
  phase: CrashPhase;
  level: "error" | "fatal";
  error: unknown;
  message?: string;
  /** The tenant the fault names, sent only under `includeRef`. */
  tenant?: string;
  /** The unit the fault names, sent only under `includeRef`. */
  ref?: string;
  /** Free tags — the upgrade stage, the migration id, the exit code. */
  tags?: Record<string, string | number | boolean | null | undefined>;
};

export type CrashReporter = {
  /** Whether any target is configured. False ⇒ `report` is a no-op. */
  enabled: boolean;
  /** Send one event to every target. Never throws; resolves when the sends settle. */
  report(event: CrashEvent): Promise<void>;
  /** Wait for every in-flight send, bounded by the timeout. */
  flush(): Promise<void>;
};

export const CRASH_REPORT_TIMEOUT_MS = 3_000;
const SENTRY_CLIENT = "phoebe-crash-reporter/1";

/**
 * Rewrite `<dataBase>/<owner>/<repo>` to `<tenant>` wherever it appears, so a
 * stack that ran inside a tenant's clone names no repository. Applied to every
 * string that leaves the box whatever `includeRef` says — the slug is one tag
 * under one switch, not something a stack frame gets to leak. `dataBase` is
 * the deployment's resolved tenant root (`PHOEBE_DATA_DIR` overrides the
 * default), threaded in by the reporter so a host/dev layout redacts too.
 */
export function redactTenantPaths(text: string, dataBase: string = DEFAULT_DATA_BASE): string {
  const root = dataBase.replace(/\/+$/, "");
  const escaped = root.replaceAll(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  return text.replaceAll(new RegExp(`${escaped}\\/[^/\\s]+\\/[^/\\s]+`, "g"), "<tenant>");
}

type Frame = { filename: string; function: string; lineno?: number; colno?: number };

/**
 * A Node stack, as Sentry frames — innermost last, which is Sentry's order.
 * Lines that are not `at …` (the message, blank lines) are skipped; a frame
 * that does not parse is kept as its raw text so nothing is silently dropped.
 */
export function parseStackFrames(stack: string): Frame[] {
  const frames: Frame[] = [];
  for (const line of stack.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("at ")) continue;
    const rest = trimmed.slice(3);
    const withFn = /^(.*?)\s+\((.*):(\d+):(\d+)\)$/.exec(rest);
    const bare = /^(.*):(\d+):(\d+)$/.exec(rest);
    if (withFn) {
      frames.push({
        function: withFn[1]!,
        filename: withFn[2]!,
        lineno: Number(withFn[3]),
        colno: Number(withFn[4]),
      });
    } else if (bare) {
      frames.push({
        function: "<anonymous>",
        filename: bare[1]!,
        lineno: Number(bare[2]),
        colno: Number(bare[3]),
      });
    } else {
      frames.push({ function: rest, filename: "?" });
    }
  }
  return frames.reverse();
}

function errorParts(
  error: unknown,
  message: string | undefined,
): { type: string; value: string; stack: string | null } {
  if (error instanceof Error) {
    return { type: error.name, value: message ?? error.message, stack: error.stack ?? null };
  }
  return { type: "Error", value: message ?? String(error), stack: null };
}

/**
 * The Sentry event payload, pure so the tests can read exactly what leaves
 * the box: the phase and process tags, the tenant tag under its switch, the
 * error class, message and redacted stack.
 */
export function buildCrashPayload(
  event: CrashEvent,
  context: CrashContext,
  opts: { includeRef: boolean; now: Date; eventId: string; dataBase?: string },
): Record<string, unknown> {
  const redact = (text: string): string => redactTenantPaths(text, opts.dataBase);
  const { type, value, stack } = errorParts(event.error, event.message);
  const tags: Record<string, string> = {
    phase: event.phase,
    bootstrapVersion: context.bootstrapVersion ?? "unknown",
    engineRef: context.engineRef ?? "unknown",
    engineSha: context.engineSha ?? "unknown",
    node: process.version,
    deploymentArm: context.deploymentArm ?? "unknown",
    credentialArm: context.credentialArm ?? "unknown",
    tenant: opts.includeRef ? (event.tenant ?? "none") : "redacted",
  };
  if (opts.includeRef && event.ref !== undefined) tags["ref"] = event.ref;
  for (const [key, raw] of Object.entries(event.tags ?? {})) {
    if (raw === undefined || raw === null) continue;
    tags[key] = redact(String(raw));
  }
  const exception: Record<string, unknown> = { type, value: redact(value) };
  if (stack !== null) {
    exception["stacktrace"] = { frames: parseStackFrames(redact(stack)) };
  }
  return {
    event_id: opts.eventId,
    timestamp: opts.now.toISOString(),
    platform: "node",
    logger: "phoebe",
    level: event.level,
    ...(context.engineSha !== null ? { release: context.engineSha } : {}),
    tags,
    exception: { values: [exception] },
  };
}

/** One envelope: header line, item header line, payload — newline-separated. */
export function buildEnvelope(
  dsn: ParsedDsn,
  payload: Record<string, unknown>,
  sentAt: Date,
): string {
  const header = JSON.stringify({
    event_id: payload["event_id"],
    sent_at: sentAt.toISOString(),
    dsn: `${dsn.protocol}//${dsn.publicKey}@${dsn.host}${dsn.pathPrefix}/${dsn.projectId}`,
  });
  const body = JSON.stringify(payload);
  const item = JSON.stringify({ type: "event", length: Buffer.byteLength(body, "utf8") });
  return `${header}\n${item}\n${body}\n`;
}

export function authHeader(dsn: ParsedDsn): string {
  return `Sentry sentry_version=7, sentry_client=${SENTRY_CLIENT}, sentry_key=${dsn.publicKey}`;
}

/**
 * Build the reporter for one process. Each configured target is parsed once
 * here; a DSN that does not parse is reported at debug and dropped rather than
 * failing the command that was about to run.
 */
export function createCrashReporter(deps: {
  reporting: ReportingField | undefined;
  context: CrashContext;
  fetchFn?: FetchLike;
  now?: () => Date;
  /** Where a failed send is mentioned; silent by default. */
  debug?: (line: string) => void;
  timeoutMs?: number;
  /** Test seam over the baked-in constant. */
  maintainersDsn?: string | null;
  /** The tenant data root to redact; defaults to the deployment's resolved one. */
  dataBase?: string;
}): CrashReporter {
  const debug = deps.debug ?? (() => {});
  const now = deps.now ?? (() => new Date());
  const fetchFn = deps.fetchFn ?? ((input, init) => fetch(input, init));
  const timeoutMs = deps.timeoutMs ?? CRASH_REPORT_TIMEOUT_MS;
  const maintainersDsn = deps.maintainersDsn === undefined ? MAINTAINERS_DSN : deps.maintainersDsn;
  const includeRef = deps.reporting?.includeRef ?? false;
  const dataBase = deps.dataBase ?? resolveDataBase();

  const targets: ParsedDsn[] = [];
  const add = (label: string, dsn: string | null | undefined): void => {
    if (dsn === undefined || dsn === null) return;
    try {
      targets.push(parseDsn(dsn));
    } catch (error) {
      debug(
        `crash reporter: ${label} DSN ignored — ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
  if (deps.reporting?.maintainers === true) {
    if (maintainersDsn === null) {
      debug(
        "crash reporter: reporting.maintainers is on but this engine carries no maintainers DSN.",
      );
    } else {
      add("maintainers", maintainersDsn);
    }
  }
  add("reporting.dsn", deps.reporting?.dsn);

  const pending = new Set<Promise<void>>();

  const send = async (dsn: ParsedDsn, envelope: string): Promise<void> => {
    try {
      const response = await fetchFn(dsn.envelopeUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-sentry-envelope",
          "X-Sentry-Auth": authHeader(dsn),
        },
        body: envelope,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) debug(`crash reporter: ${dsn.host} answered ${response.status}.`);
    } catch (error) {
      debug(
        `crash reporter: could not reach ${dsn.host} — ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  return {
    enabled: targets.length > 0,
    report(event) {
      if (targets.length === 0) return Promise.resolve();
      const at = now();
      const payload = buildCrashPayload(event, deps.context, {
        includeRef,
        now: at,
        eventId: crypto.randomUUID().replaceAll("-", ""),
        dataBase,
      });
      const sends = targets.map((dsn) => send(dsn, buildEnvelope(dsn, payload, at)));
      const settled = Promise.allSettled(sends).then(() => undefined);
      pending.add(settled);
      void settled.finally(() => pending.delete(settled));
      return settled;
    },
    async flush() {
      await Promise.allSettled(pending);
    },
  };
}

/** The reporter that reports nothing — for callers with no config in hand. */
export const NO_CRASH_REPORTER: CrashReporter = {
  enabled: false,
  report: () => Promise.resolve(),
  flush: () => Promise.resolve(),
};

/**
 * The reporter for an operator command (#474): built from the `reporting`
 * block of the config at `configPath` when it loads and carries one, the
 * silent reporter otherwise. A config that cannot load is exactly the kind of
 * fault a command then reports on — but with no block to read there is
 * nowhere to send it, so the command simply runs. The engine SHA is unknown
 * here: these commands run on the host, before or beside any checkout.
 */
export async function createCrashReporterForConfig(
  configPath: string,
  deps: { env?: NodeJS.ProcessEnv; debug?: (line: string) => void } = {},
): Promise<CrashReporter> {
  const env = deps.env ?? process.env;
  try {
    const user = (await loadUserConfig(configPath)) as Record<string, unknown>;
    let reporting: ReportingField | undefined;
    try {
      reporting = readReportingField(user);
    } catch (error) {
      // A block that does not validate is the operator's mistake, and a
      // command running with reporting silently off would hide it; the engine
      // refuses the same config more loudly at its own boot.
      deps.debug?.(
        `crash reporter: ${error instanceof Error ? error.message : String(error)} — reporting is off for this command.`,
      );
      return NO_CRASH_REPORTER;
    }
    if (reporting === undefined) return NO_CRASH_REPORTER;
    const source = readEngineSource(user);
    return createCrashReporter({
      reporting,
      context: {
        bootstrapVersion: null,
        engineRef: source.source === "github" ? source.ref : "local",
        engineSha: null,
        deploymentArm: user["workspace"] !== undefined ? "workspace" : "solo",
        credentialArm: resolveCredentialArm(env as Record<string, string | undefined>),
      },
      ...(deps.debug !== undefined ? { debug: deps.debug } : {}),
      dataBase: resolveDataBase(env),
    });
  } catch {
    // The config itself would not load: the command that needed it is about
    // to say so, and with no block to read there is nowhere to report to.
    return NO_CRASH_REPORTER;
  }
}
