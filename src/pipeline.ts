// Pipeline selection (#415): turning the tenant's `pipelines` block plus a
// `--pipeline <name>` flag into the flat config shape the engine already
// reads.
//
// A pipeline is a named body of work the tenant runs as its own engine child, so
// every child boots knowing exactly one name. `selectPipeline` resolves
// that name into `workOrder` / `workKinds` / `promptFiles` — the fields the
// orchestrator, the registry loader and the prompt check were reading before
// pipelines existed — which is what lets the whole declaration land without a
// single consumer rewrite. Absent the flag the pipeline is `work`, the reserved
// default, so an existing deployment sees no change at all.

import { matchPipelineFlag } from "./cli-flags.ts";
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
 * Absent, the pipeline is the reserved default — which is why a deployment that has
 * never heard of pipelines keeps running the work it always did.
 */
export function parsePipelineName(argv: readonly string[]): string {
  for (let i = 0; i < argv.length; i++) {
    const match = matchPipelineFlag(argv, i);
    if (match !== undefined) return match.value;
  }
  return DEFAULT_PIPELINE_NAME;
}

/**
 * The declared pipeline named `pipeline`. An unknown name is a boot error rather
 * than an empty pipeline: a typo'd `--pipeline` would otherwise start a child that
 * polls forever and finds nothing, which reads as "the tracker is quiet".
 */
export function declaredPipeline(config: PhoebeConfig, name: string): ResolvedPipeline {
  const pipeline = config.pipelines[name];
  if (pipeline === undefined) {
    throw new Error(
      `Unknown pipeline "${name}". This tenant declares: ` +
        `${Object.keys(config.pipelines).join(", ")}.`,
    );
  }
  return pipeline;
}

/**
 * How long an idle cycle of this pipeline waits: what the pipeline declares wins, else
 * `PHOEBE_POLL_INTERVAL_MS`, else the default (#408). The declaration outranks
 * the env var because a fleet-wide cadence is exactly the wrong answer for a
 * pipeline whose whole point is a different one — an intake pipeline polling every 15s
 * beside a work pipeline polling every 5 min.
 */
export function resolvePollIntervalMs(pipeline: ResolvedPipeline, env: NodeJS.ProcessEnv): number {
  if (pipeline.pollIntervalMs !== undefined) return pipeline.pollIntervalMs;
  const fromEnv = Number(env["PHOEBE_POLL_INTERVAL_MS"]);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  return PIPELINE_DEFAULTS.pollIntervalMs;
}

/**
 * Which pipeline owns each kind: the pipeline that names it in `order`, else the
 * pipeline that declares it under `kinds` (#465). Kinds nobody claims fall to the
 * default pipeline, which is what makes a single-pipeline tenant's `order` mean
 * "priority" and nothing else. Two pipelines claiming one kind is already fatal at
 * validation (`validatePipelinesField`), so first-claim-wins here is only a
 * defensive tie-break.
 */
function kindOwners(pipelines: Record<string, ResolvedPipeline>): Map<string, string> {
  const owners = new Map<string, string>();
  for (const [name, pipeline] of Object.entries(pipelines)) {
    for (const kind of [...pipeline.order, ...Object.keys(customKindEntries(pipeline.kinds))]) {
      if (!owners.has(kind)) owners.set(kind, name);
    }
  }
  return owners;
}

/**
 * The kinds this pipeline registers, in declaration order: the built-ins, then the
 * custom kinds this pipeline declares. Mirrors `buildRegistry`'s insertion order,
 * which is what "every other registered kind follows in declaration order"
 * means.
 */
function registeredKindNames(pipeline: ResolvedPipeline): string[] {
  return [...WORK_KIND_NAMES, ...Object.keys(customKindEntries(pipeline.kinds))];
}

/**
 * Every kind this pipeline owns, in priority order: the ones it names first, in that
 * sequence, then the rest in declaration order. Switched-off kinds are still
 * here — `disabled` decides what the pipeline *runs*, not what it owns, which is
 * what lets the enumerator (#417) derive a pipeline's need for a git clone from a
 * fact no hot knob can flip.
 */
export function pipelineOwnedKinds(opts: {
  pipelines: Record<string, ResolvedPipeline>;
  name: string;
  pipeline: ResolvedPipeline;
}): readonly string[] {
  const { pipelines, name, pipeline } = opts;
  const registered = registeredKindNames(pipeline);
  for (const kind of pipeline.order) {
    if (!registered.includes(kind)) {
      throw new Error(
        `Unknown work kind "${kind}" in \`pipelines.${name}.order\`. ` +
          `Use one of: ${registered.join(", ")}.`,
      );
    }
  }
  const owners = kindOwners(pipelines);
  const rest = registered.filter(
    (kind) =>
      !pipeline.order.includes(kind) && (owners.get(kind) ?? DEFAULT_PIPELINE_NAME) === name,
  );
  // Deduped: a kind named twice in `order` would otherwise be gathered twice a
  // cycle for no gain. First mention wins, so it keeps the priority it was given.
  return [...new Set([...pipeline.order, ...rest])];
}

/**
 * This pipeline's work order: the kinds it owns, minus anything switched off with
 * `kinds.<name>.disabled` — the sole off-switch now that omission from `order`
 * means "no opinion about priority" rather than "never run this".
 */
export function resolvePipelineWorkOrder(opts: {
  pipelines: Record<string, ResolvedPipeline>;
  name: string;
  pipeline: ResolvedPipeline;
}): readonly string[] {
  return pipelineOwnedKinds(opts).filter(
    (kind) => workKindOverride(opts.pipeline.kinds, kind)?.disabled !== true,
  );
}

/** This pipeline's prompt paths: `kinds.<name>.promptFile` over the `promptFiles` alias. */
function resolvePipelinePromptFiles(
  config: PhoebeConfig,
  pipeline: ResolvedPipeline,
): PromptFilesConfig {
  const promptFiles = { ...config.promptFiles };
  for (const [kind, key] of Object.entries(PROMPT_FILE_KEY_BY_KIND)) {
    const declared = workKindOverride(pipeline.kinds, kind)?.promptFile;
    if (declared !== undefined) promptFiles[key] = declared;
  }
  return promptFiles;
}

/**
 * Flatten one pipeline onto the tenant config. The result is an ordinary
 * `PhoebeConfig` — `workOrder`, `workKinds` and `promptFiles` now say what
 * *this pipeline* runs — so every module downstream of here keeps reading the
 * fields it always read and never learns the word "pipeline". The whole
 * `pipelines` block rides along untouched: the poll cadence and the pipeline's
 * concurrency are read back off it by the engine child.
 */
export function selectPipeline(config: PhoebeConfig, name: string): PhoebeConfig {
  const pipeline = declaredPipeline(config, name);
  return {
    ...config,
    workOrder: resolvePipelineWorkOrder({ pipelines: config.pipelines, name, pipeline }),
    workKinds: { ...pipeline.kinds },
    promptFiles: resolvePipelinePromptFiles(config, pipeline),
  };
}
