// Row selection (#415): turning the tenant's `pipelines` block plus a
// `--pipeline <name>` flag into the flat config shape the engine already
// reads.
//
// A pipeline is a row of work the tenant runs as its own engine child, so
// every child boots knowing exactly one name. `selectPipelineRow` resolves
// that name into `workOrder` / `workKinds` / `promptFiles` — the fields the
// orchestrator, the registry loader and the prompt check were reading before
// pipelines existed — which is what lets the whole declaration land without a
// single consumer rewrite. Absent the flag the row is `work`, the reserved
// default, so an existing deployment sees no change at all.

import {
  DEFAULT_PIPELINE_NAME,
  PIPELINE_DEFAULTS,
  PROMPT_FILE_KEY_BY_KIND,
  WORK_KIND_NAMES,
  customKindEntries,
  workKindOverride,
  type PhoebeConfig,
  type PromptFilesConfig,
  type ResolvedPipeline,
} from "./config-schema.ts";

/**
 * Read `--pipeline <name>` / `--pipeline=<name>` off the engine child's argv.
 * Absent, the row is the reserved default — which is why a deployment that has
 * never heard of pipelines keeps running the work it always did.
 */
export function parsePipelineName(argv: readonly string[]): string {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--pipeline") {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("-")) {
        throw new Error("`--pipeline` requires a pipeline name (e.g. `--pipeline work`).");
      }
      return next;
    }
    if (arg !== undefined && arg.startsWith("--pipeline=")) {
      const value = arg.slice("--pipeline=".length);
      if (value.length === 0) {
        throw new Error("`--pipeline=` requires a pipeline name (e.g. `--pipeline=work`).");
      }
      return value;
    }
  }
  return DEFAULT_PIPELINE_NAME;
}

/**
 * The declared row named `pipeline`. An unknown name is a boot error rather
 * than an empty row: a typo'd `--pipeline` would otherwise start a child that
 * polls forever and finds nothing, which reads as "the tracker is quiet".
 */
export function pipelineRow(config: PhoebeConfig, pipeline: string): ResolvedPipeline {
  const row = config.pipelines[pipeline];
  if (row === undefined) {
    throw new Error(
      `Unknown pipeline "${pipeline}". This tenant declares: ` +
        `${Object.keys(config.pipelines).join(", ")}.`,
    );
  }
  return row;
}

/**
 * How long an idle cycle of this row waits: what the row declares wins, else
 * `PHOEBE_POLL_INTERVAL_MS`, else the default (#408). The declaration outranks
 * the env var because a fleet-wide cadence is exactly the wrong answer for a
 * row whose whole point is a different one — an intake row polling every 15s
 * beside a work row polling every 5 min.
 */
export function resolvePollIntervalMs(row: ResolvedPipeline, env: NodeJS.ProcessEnv): number {
  if (row.pollIntervalMs !== undefined) return row.pollIntervalMs;
  const fromEnv = Number(env["PHOEBE_POLL_INTERVAL_MS"]);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  return PIPELINE_DEFAULTS.pollIntervalMs;
}

/**
 * Which pipeline owns each kind: the row that names it in `order`, else the
 * row that declares it under `kinds.custom`. Kinds nobody claims fall to the
 * default row, which is what makes a single-pipeline tenant's `order` mean
 * "priority" and nothing else. Two rows claiming one kind is already fatal at
 * validation (`validatePipelinesField`), so first-claim-wins here is only a
 * defensive tie-break.
 */
function kindOwners(pipelines: Record<string, ResolvedPipeline>): Map<string, string> {
  const owners = new Map<string, string>();
  for (const [name, row] of Object.entries(pipelines)) {
    for (const kind of [...row.order, ...Object.keys(customKindEntries(row.kinds))]) {
      if (!owners.has(kind)) owners.set(kind, name);
    }
  }
  return owners;
}

/**
 * The kinds this row registers, in declaration order: the built-ins, then the
 * custom kinds this row declares. Mirrors `buildRegistry`'s insertion order,
 * which is what "every other registered kind follows in declaration order"
 * means.
 */
function registeredKindNames(row: ResolvedPipeline): string[] {
  return [...WORK_KIND_NAMES, ...Object.keys(customKindEntries(row.kinds))];
}

/**
 * Every kind this row owns, in priority order: the ones it names first, in that
 * sequence, then the rest in declaration order. Switched-off kinds are still
 * here — `disabled` decides what the row *runs*, not what it owns, which is
 * what lets the enumerator (#417) derive a row's need for a git clone from a
 * fact no hot knob can flip.
 */
export function rowOwnedKinds(opts: {
  pipelines: Record<string, ResolvedPipeline>;
  pipeline: string;
  row: ResolvedPipeline;
}): readonly string[] {
  const { pipelines, pipeline, row } = opts;
  const registered = registeredKindNames(row);
  for (const kind of row.order) {
    if (!registered.includes(kind)) {
      throw new Error(
        `Unknown work kind "${kind}" in \`pipelines.${pipeline}.order\`. ` +
          `Use one of: ${registered.join(", ")}.`,
      );
    }
  }
  const owners = kindOwners(pipelines);
  const rest = registered.filter(
    (kind) => !row.order.includes(kind) && (owners.get(kind) ?? DEFAULT_PIPELINE_NAME) === pipeline,
  );
  // Deduped: a kind named twice in `order` would otherwise be gathered twice a
  // cycle for no gain. First mention wins, so it keeps the priority it was given.
  return [...new Set([...row.order, ...rest])];
}

/**
 * This row's work order: the kinds it owns, minus anything switched off with
 * `kinds.<name>.disabled` — the sole off-switch now that omission from `order`
 * means "no opinion about priority" rather than "never run this".
 */
export function resolveRowWorkOrder(opts: {
  pipelines: Record<string, ResolvedPipeline>;
  pipeline: string;
  row: ResolvedPipeline;
}): readonly string[] {
  return rowOwnedKinds(opts).filter(
    (kind) => workKindOverride(opts.row.kinds, kind)?.disabled !== true,
  );
}

/** This row's prompt paths: `kinds.<name>.promptFile` over the `promptFiles` alias. */
function resolveRowPromptFiles(config: PhoebeConfig, row: ResolvedPipeline): PromptFilesConfig {
  const promptFiles = { ...config.promptFiles };
  for (const [kind, key] of Object.entries(PROMPT_FILE_KEY_BY_KIND)) {
    const declared = workKindOverride(row.kinds, kind)?.promptFile;
    if (declared !== undefined) promptFiles[key] = declared;
  }
  return promptFiles;
}

/**
 * Flatten one pipeline row onto the tenant config. The result is an ordinary
 * `PhoebeConfig` — `workOrder`, `workKinds` and `promptFiles` now say what
 * *this row* runs — so every module downstream of here keeps reading the
 * fields it always read and never learns the word "pipeline". The whole
 * `pipelines` block rides along untouched: the poll cadence and the row's
 * concurrency are read back off it by the engine child.
 */
export function selectPipelineRow(config: PhoebeConfig, pipeline: string): PhoebeConfig {
  const row = pipelineRow(config, pipeline);
  return {
    ...config,
    workOrder: resolveRowWorkOrder({ pipelines: config.pipelines, pipeline, row }),
    workKinds: { ...row.kinds },
    promptFiles: resolveRowPromptFiles(config, row),
  };
}
