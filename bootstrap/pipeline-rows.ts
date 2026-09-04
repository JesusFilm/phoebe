// How the supervisor learns a tenant's rows (#401/#417).
//
// The bootstrapper spawns one engine child per (tenant × pipeline), so it needs
// row names — and it gets them by asking the materialized engine checkout
// (`<entry> pipelines --config <tenant config>`) rather than by reading the
// `pipelines` block itself. The rest of the config stays the engine's business,
// exactly as `engine-source.ts` keeps the bootstrapper's interest in a config
// down to one field.
//
// Two questions, deliberately separate, because confusing them would spawn a
// `work` row against a config already known to be broken:
//
//   - **Capability** is a property of the engine. Probed once per
//     materialization; an old checkout with no `pipelines` subcommand means
//     every tenant runs one implicit `work` row and enumeration never runs at
//     all — byte-for-byte today's behaviour, so an existing deployment migrates
//     as a no-op.
//   - **Validity** is a property of the tenant. A failed enumeration is that
//     tenant's fault: it is thrown as {@link PipelineEnumerationError} for the
//     caller to hold on, never a fleet-wide one.
//
// Enumeration spawns a Node process, so it runs only when the tenant config's
// stat fingerprint moves — the same cheap trigger the engine-source confirm
// already uses (#138). Steady state stays stat-only.

import { spawnSync } from "node:child_process";

/** One row of a tenant's work, as the supervisor reads it off the engine. */
export type PipelineRow = {
  name: string;
  /** Hot: the operator's off-switch, acted on without relaunching the row. */
  disabled: boolean;
  /** Hot: tenant-local priority for a contended concurrency slot. */
  priority: number;
  /** Units this row may hold in flight. */
  concurrency: number;
  /** Whether this row's kinds want the tenant's git clone. */
  needsClone: boolean;
  /**
   * Opaque digest of the row's cold config; a move means relaunch this row.
   * Null for the implicit row of a checkout that cannot enumerate — the same
   * "unknown, never counts as a change" sentinel the tenant fingerprints use.
   */
  fingerprint: string | null;
};

/**
 * What every tenant runs on an engine checkout that cannot enumerate: the
 * reserved default row, one unit at a time, with the tenant's clone — which is
 * what a pre-pipelines engine child has always been.
 */
export const IMPLICIT_WORK_ROW: PipelineRow = Object.freeze({
  name: "work",
  disabled: false,
  priority: 0,
  concurrency: 1,
  needsClone: true,
  fingerprint: null,
});

/** A tenant-level fault: this tenant's rows are unknown, the fleet is fine. */
export class PipelineEnumerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PipelineEnumerationError";
  }
}

/** Result of running the engine CLI once — the shape `spawnSync` reports. */
export type EngineCommandResult = {
  status: number | null;
  stdout: string;
  stderr: string;
};

/** Run the engine CLI with these args. Injected so the loop is tested without processes. */
export type EngineCommand = (
  args: readonly string[],
  opts: { cwd?: string },
) => EngineCommandResult;

/** How long either call may take before it is a failure rather than a wait. */
export const ENUMERATE_TIMEOUT_MS = 60_000;

/** The tenant whose rows are wanted: where its config is, and whether it moved. */
export type EnumerateTarget = {
  configPath: string;
  /** Working directory for the engine process — the tenant dir, as its child gets. */
  cwd?: string;
  /** The tenant config's stat fingerprint; null re-enumerates (unknown is not cacheable). */
  fingerprint: string | null;
};

export type RowEnumerator = {
  /** Whether this checkout supports enumeration. Probed once, then remembered. */
  supported: () => boolean;
  /** This tenant's rows, re-read only when its fingerprint moved. */
  rowsFor: (target: EnumerateTarget) => readonly PipelineRow[];
};

function engineCommandFor(entry: string): EngineCommand {
  return (args, { cwd }) => {
    const result = spawnSync(process.execPath, [entry, ...args], {
      encoding: "utf8",
      timeout: ENUMERATE_TIMEOUT_MS,
      ...(cwd !== undefined ? { cwd } : {}),
    });
    if (result.error !== undefined) {
      return { status: null, stdout: "", stderr: result.error.message };
    }
    return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  };
}

/**
 * The JSON object the subcommand prints as the *last* line of stdout. Last
 * rather than only: a custom kind module loads during enumeration and may print
 * whatever it likes on the way past.
 */
function lastJsonLine(stdout: string): unknown {
  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const last = lines[lines.length - 1];
  if (last === undefined) return undefined;
  try {
    return JSON.parse(last);
  } catch {
    return undefined;
  }
}

/** The first line of a failed command worth showing an operator. */
function diagnosis(result: EngineCommandResult): string {
  const stderr = result.stderr.trim();
  if (stderr.length > 0) return stderr.split("\n").slice(-3).join(" ");
  const stdout = result.stdout.trim();
  return stdout.length > 0 ? stdout.split("\n").slice(-1).join(" ") : `exit ${result.status}`;
}

/** Read one row off the parsed JSON, rejecting anything the wrong shape. */
function parseRow(value: unknown): PipelineRow {
  if (value === null || typeof value !== "object") {
    throw new PipelineEnumerationError(`a row is not an object (got ${JSON.stringify(value)})`);
  }
  const row = value as Record<string, unknown>;
  const { name, disabled, priority, concurrency, needsClone, fingerprint } = row;
  if (
    typeof name !== "string" ||
    typeof disabled !== "boolean" ||
    typeof priority !== "number" ||
    typeof concurrency !== "number" ||
    typeof needsClone !== "boolean" ||
    typeof fingerprint !== "string"
  ) {
    throw new PipelineEnumerationError(`malformed row ${JSON.stringify(value)}`);
  }
  return { name, disabled, priority, concurrency, needsClone, fingerprint };
}

function parseRows(payload: unknown): PipelineRow[] {
  const declared =
    payload !== null && typeof payload === "object"
      ? (payload as Record<string, unknown>)["rows"]
      : undefined;
  if (!Array.isArray(declared)) {
    throw new PipelineEnumerationError(
      `the engine printed no rows (got ${JSON.stringify(payload)})`,
    );
  }
  if (declared.length === 0) {
    // Every tenant has at least the reserved `work` row, so an empty list is
    // not "this tenant runs nothing" — it is an answer that did not arrive.
    throw new PipelineEnumerationError("the engine enumerated zero rows");
  }
  return declared.map(parseRow);
}

/**
 * The enumerator for one materialized engine checkout. Its probe is the "once
 * per materialization" record: create one per launch, and a checkout that
 * cannot enumerate is asked exactly once and never invoked again.
 */
export function createRowEnumerator(opts: { entry: string; run?: EngineCommand }): RowEnumerator {
  const run = opts.run ?? engineCommandFor(opts.entry);
  const cache = new Map<string, { fingerprint: string; rows: readonly PipelineRow[] }>();
  let probed: boolean | null = null;

  const supported = (): boolean => {
    if (probed !== null) return probed;
    const result = run(["pipelines", "--probe"], {});
    const payload = lastJsonLine(result.stdout);
    probed =
      result.status === 0 &&
      payload !== null &&
      typeof payload === "object" &&
      (payload as Record<string, unknown>)["supported"] === true;
    return probed;
  };

  const enumerate = (target: EnumerateTarget): readonly PipelineRow[] => {
    const result = run(
      ["pipelines", "--config", target.configPath],
      target.cwd !== undefined ? { cwd: target.cwd } : {},
    );
    if (result.status !== 0) {
      throw new PipelineEnumerationError(
        `enumerating pipelines for ${target.configPath} failed — ${diagnosis(result)}`,
      );
    }
    try {
      return parseRows(lastJsonLine(result.stdout));
    } catch (error) {
      throw new PipelineEnumerationError(
        `enumerating pipelines for ${target.configPath} failed — ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  return {
    supported,
    rowsFor: (target) => {
      if (!supported()) return [IMPLICIT_WORK_ROW];
      const cached = cache.get(target.configPath);
      if (
        cached !== undefined &&
        target.fingerprint !== null &&
        cached.fingerprint === target.fingerprint
      ) {
        return cached.rows;
      }
      const rows = enumerate(target);
      if (target.fingerprint !== null) {
        cache.set(target.configPath, { fingerprint: target.fingerprint, rows });
      }
      return rows;
    },
  };
}
