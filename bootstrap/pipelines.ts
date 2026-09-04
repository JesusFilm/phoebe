// How the supervisor learns a tenant's pipelines (#401/#417), and the vocabulary it
// supervises them with (#420).
//
// The bootstrapper spawns one engine child per (tenant × pipeline), so it needs
// pipeline names — and it gets them by asking the materialized engine checkout
// (`<entry> pipelines --config <tenant config>`) rather than by reading the
// `pipelines` block itself. The rest of the config stays the engine's business,
// exactly as `engine-source.ts` keeps the bootstrapper's interest in a config
// down to one field.
//
// Two questions, deliberately separate, because confusing them would spawn a
// `work` pipeline against a config already known to be broken:
//
//   - **Capability** is a property of the engine. Probed once per
//     materialization; an old checkout with no `pipelines` subcommand means
//     every tenant runs one implicit `work` pipeline and enumeration never runs at
//     all — byte-for-byte today's behaviour, so an existing deployment migrates
//     as a no-op.
//   - **Validity** is a property of the tenant. A failed enumeration is that
//     tenant's fault: it is thrown as {@link PipelineEnumerationError} for the
//     caller to hold on, never a fleet-wide one.
//
// Enumeration spawns a Node process, so it runs only when the tenant config's
// stat fingerprint moves — the same cheap trigger the engine-source confirm
// already uses (#138). Steady state stays stat-only.
//
// The supervised unit is a pipeline, not a tenant: {@link SupervisedPipeline} names one
// `(tenant × pipeline)` cell, {@link pipelineId} keys it, and {@link diffPipelines} says
// what moved between two polls. The loop that acts on that is
// bootstrap/supervise-fleet.ts.

import { spawnSync } from "node:child_process";

import type { DiscoveredTenant } from "./tenants.ts";

/** One pipeline of a tenant's work, as the supervisor reads it off the engine. */
export type Pipeline = {
  name: string;
  /** Hot: the operator's off-switch, acted on without relaunching the pipeline. */
  disabled: boolean;
  /** Hot: tenant-local priority for a contended concurrency slot. */
  priority: number;
  /** Units this pipeline may hold in flight. */
  concurrency: number;
  /** Whether this pipeline's kinds want the tenant's git clone. */
  needsClone: boolean;
  /**
   * The env keys this pipeline's scheduled kinds declared (#425) — names only, never
   * values. Read two ways: subtractively, so a key a *sibling* pipeline declared and
   * this one did not is taken out of this pipeline's child env, and as the lens on
   * the tenant's `.env` for this pipeline's reconcile digest. Empty for a pipeline that
   * declares nothing, which is every pipeline of every deployment today.
   */
  env: readonly string[];
  /**
   * Opaque digest of the pipeline's cold config; a move means relaunch this pipeline.
   * Null for the implicit pipeline of a checkout that cannot enumerate — the same
   * "unknown, never counts as a change" sentinel the tenant fingerprints use.
   */
  fingerprint: string | null;
};

/**
 * What every tenant runs on an engine checkout that cannot enumerate: the
 * reserved default pipeline, one unit at a time, with the tenant's clone — which is
 * what a pre-pipelines engine child has always been.
 */
export const IMPLICIT_WORK_PIPELINE: Pipeline = Object.freeze({
  name: "work",
  disabled: false,
  priority: 0,
  concurrency: 1,
  needsClone: true,
  env: [],
  fingerprint: null,
});

/** A tenant-level fault: this tenant's pipelines are unknown, the fleet is fine. */
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

/** The tenant whose pipelines are wanted: where its config is, and whether it moved. */
export type EnumerateTarget = {
  configPath: string;
  /** Working directory for the engine process — the tenant dir, as its child gets. */
  cwd?: string;
  /** The tenant config's stat fingerprint; null re-enumerates (unknown is not cacheable). */
  fingerprint: string | null;
};

export type PipelineEnumerator = {
  /** Whether this checkout supports enumeration. Probed once, then remembered. */
  supported: () => boolean;
  /** This tenant's pipelines, re-read only when its fingerprint moved. */
  pipelinesFor: (target: EnumerateTarget) => readonly Pipeline[];
};

/**
 * Run the engine CLI at `entry` as a child process. Shared with the stale-state
 * sweeper (#426), which asks the same checkout a different question the same
 * way — one process, one JSON answer, a status that says whether to believe it.
 */
export function engineCommandFor(entry: string): EngineCommand {
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
 * The JSON object a subcommand prints as the *last* line of stdout. Last rather
 * than only: a custom kind module loads during enumeration and may print
 * whatever it likes on the way past.
 */
export function lastJsonLine(stdout: string): unknown {
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
export function diagnosis(result: EngineCommandResult): string {
  const stderr = result.stderr.trim();
  if (stderr.length > 0) return stderr.split("\n").slice(-3).join(" ");
  const stdout = result.stdout.trim();
  return stdout.length > 0 ? stdout.split("\n").slice(-1).join(" ") : `exit ${result.status}`;
}

/** Read one pipeline off the parsed JSON, rejecting anything the wrong shape. */
function parsePipeline(value: unknown): Pipeline {
  if (value === null || typeof value !== "object") {
    throw new PipelineEnumerationError(
      `a pipeline is not an object (got ${JSON.stringify(value)})`,
    );
  }
  const pipeline = value as Record<string, unknown>;
  const { name, disabled, priority, concurrency, needsClone, env, fingerprint } = pipeline;
  if (
    typeof name !== "string" ||
    typeof disabled !== "boolean" ||
    typeof priority !== "number" ||
    typeof concurrency !== "number" ||
    typeof needsClone !== "boolean" ||
    typeof fingerprint !== "string"
  ) {
    throw new PipelineEnumerationError(`malformed pipeline ${JSON.stringify(value)}`);
  }
  // `env` is additive (#425): an engine old enough to enumerate but too old to
  // declare keys reports none, and no pipeline loses anything. Present, it must be
  // key names — a malformed one would scrub by accident.
  if (env !== undefined && (!Array.isArray(env) || env.some((key) => typeof key !== "string"))) {
    throw new PipelineEnumerationError(`pipeline ${name} declared a malformed \`env\``);
  }
  return {
    name,
    disabled,
    priority,
    concurrency,
    needsClone,
    env: (env as string[] | undefined) ?? [],
    fingerprint,
  };
}

function parsePipelines(payload: unknown): Pipeline[] {
  const declared =
    payload !== null && typeof payload === "object"
      ? (payload as Record<string, unknown>)["pipelines"]
      : undefined;
  if (!Array.isArray(declared)) {
    throw new PipelineEnumerationError(
      `the engine printed no pipelines (got ${JSON.stringify(payload)})`,
    );
  }
  if (declared.length === 0) {
    // Every tenant has at least the reserved `work` pipeline, so an empty list is
    // not "this tenant runs nothing" — it is an answer that did not arrive.
    throw new PipelineEnumerationError("the engine enumerated zero pipelines");
  }
  return declared.map(parsePipeline);
}

/**
 * The enumerator for one materialized engine checkout. Its probe is the "once
 * per materialization" record: create one per launch, and a checkout that
 * cannot enumerate is asked exactly once and never invoked again.
 */
export function createPipelineEnumerator(opts: {
  entry: string;
  run?: EngineCommand;
}): PipelineEnumerator {
  const run = opts.run ?? engineCommandFor(opts.entry);
  const cache = new Map<string, { fingerprint: string; pipelines: readonly Pipeline[] }>();
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

  const enumerate = (target: EnumerateTarget): readonly Pipeline[] => {
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
      return parsePipelines(lastJsonLine(result.stdout));
    } catch (error) {
      throw new PipelineEnumerationError(
        `enumerating pipelines for ${target.configPath} failed — ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  return {
    supported,
    pipelinesFor: (target) => {
      if (!supported()) return [IMPLICIT_WORK_PIPELINE];
      const cached = cache.get(target.configPath);
      if (
        cached !== undefined &&
        target.fingerprint !== null &&
        cached.fingerprint === target.fingerprint
      ) {
        return cached.pipelines;
      }
      const pipelines = enumerate(target);
      if (target.fingerprint !== null) {
        cache.set(target.configPath, { fingerprint: target.fingerprint, pipelines });
      }
      return pipelines;
    },
  };
}

/**
 * The separator between a pipeline id's two halves (#401/#420). Neither half can
 * contain it: a tenant id is an absolute path and a pipeline name reuses the
 * custom-kind regex, which excludes `#` for exactly this reason (#415).
 */
export const PIPELINE_ID_SEPARATOR = "#";

/** The supervisor's key for one `(tenant × pipeline)` pipeline. */
export function pipelineId(tenantId: string, pipeline: string): string {
  return `${tenantId}${PIPELINE_ID_SEPARATOR}${pipeline}`;
}

/**
 * One cell of the supervision matrix: a tenant, one of its pipelines, and the
 * id that names the pair. That id is the child-map key, the broker owner and
 * the credential-lease id, so a pipeline's slots and its token are reclaimed with the
 * pipeline rather than with everything its tenant runs.
 */
export type SupervisedPipeline = {
  /** `<tenantId>#<pipeline>`. */
  id: string;
  tenant: DiscoveredTenant;
  pipeline: Pipeline;
  /**
   * Whether the engine checkout named this pipeline. False for the implicit `work`
   * pipeline of a checkout with no `pipelines` subcommand, whose child must not be
   * spawned with a `--pipeline` flag it would die on before reading a config.
   */
  enumerated: boolean;
  /**
   * Every key this pipeline's *siblings* declared — the union of `env` over the
   * tenant's other pipelines (#425). The scrub is subtractive, so this minus the
   * pipeline's own `env` is exactly what the child does not get to see. A tenant
   * with one pipeline has an empty set here and an unchanged child env.
   */
  siblingEnv: readonly string[];
};

/**
 * What the subtractive scrub takes out of one pipeline's child env: the keys a
 * sibling declared and this pipeline did not. Sorted, so a fingerprint built over it
 * is stable.
 */
export function siblingOnlyEnvKeys(pipeline: SupervisedPipeline): string[] {
  const own = new Set(pipeline.pipeline.env);
  return [...new Set(pipeline.siblingEnv)].filter((key) => !own.has(key)).sort();
}

/** A pipeline paired with the fingerprint that decides whether it relaunches. */
export type PipelineSample = { pipeline: SupervisedPipeline; fingerprint: string | null };

/** How an operator reads a pipeline in a boot line: `<slug>:<pipeline>`. */
export function pipelineLabel(pipeline: SupervisedPipeline): string {
  return `${pipeline.tenant.slug ?? pipeline.tenant.id}:${pipeline.pipeline.name}`;
}

/**
 * What changed between the last poll's pipeline fingerprints and the current matrix
 * — the pipeline-level twin of `diffFleet`, with the same conservatism: a null
 * fingerprint on either side is "unknown" and never counts as a change, and a
 * held pipeline id is never reported as removed however absent it is from `current`.
 */
export type PipelineDiff = {
  added: SupervisedPipeline[];
  removed: string[];
  changed: SupervisedPipeline[];
};

export function diffPipelines(
  previous: ReadonlyMap<string, string | null>,
  current: readonly PipelineSample[],
  hold: ReadonlySet<string> = new Set(),
): PipelineDiff {
  const added: SupervisedPipeline[] = [];
  const changed: SupervisedPipeline[] = [];
  const seen = new Set<string>();

  for (const { pipeline, fingerprint } of current) {
    seen.add(pipeline.id);
    if (!previous.has(pipeline.id)) {
      added.push(pipeline);
      continue;
    }
    const before = previous.get(pipeline.id) ?? null;
    if (before !== null && fingerprint !== null && before !== fingerprint) changed.push(pipeline);
  }

  const removed = [...previous.keys()].filter((id) => !seen.has(id) && !hold.has(id));
  return { added, removed, changed };
}
