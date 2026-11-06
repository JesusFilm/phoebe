// The `dependencies` catalog kind (ADR 0003): the implementer half of the
// dependency feature. The two detector kinds file one issue per bundle under
// the `phoebe:dependencies` label; this kind works those issues one at a time
// with its own prompt, applying the bumps the body lists, fixing what breaks,
// and opening the PR.
//
// It is the `research` shape (one `issueProducerKind` call: a label, a prompt
// and the words) declared the `sentry` way: shipped under `kinds/`, registered
// only when a tenant names `phoebe-agent/kinds/dependencies-work`, its prompt an
// absolute path into the engine checkout.
//
// It lists its own label and nothing else, and never adds the tenant's
// `readyLabel`: a pipeline running `issues` beside this one would take the
// ticket for its own.

import { join } from "node:path";
import type { PhoebeConfig } from "../../src/config-schema.ts";
import type { AnyWorkKindDefinition } from "../../src/work-kinds/definition.ts";
import { issueProducerKind } from "../../src/work-kinds/issue-producer.ts";
import { parseMarker, renderMarker } from "../dependencies/fingerprint.ts";

export const DEPENDENCIES_KIND_NAME = "dependencies";

/** The kind's own prompt, an absolute path into the engine checkout. */
export const DEPENDENCIES_PROMPT_FILE = join(
  import.meta.dirname,
  "..",
  "..",
  "prompts",
  "dependencies-prompt.md",
);

export type DependenciesKindOptions = {
  /** The label the detectors file under, and the only one this kind lists. */
  label: string;
};

export const DEPENDENCIES_OPTION_DEFAULTS: DependenciesKindOptions = {
  label: "phoebe:dependencies",
};

const OPTION_KEYS: readonly (keyof DependenciesKindOptions)[] = ["label"];

/**
 * Validate the block a tenant declared and fill the default. No block at all
 * is fine. An unknown field is refused, as the sentry kind refuses one: a
 * typo'd option would otherwise sit inert while looking configured.
 */
export function resolveDependenciesOptions(raw: unknown, at: string): DependenciesKindOptions {
  if (raw === undefined) return { ...DEPENDENCIES_OPTION_DEFAULTS };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${at}: the dependencies kind's options must be an object.`);
  }
  const block = raw as Record<string, unknown>;
  for (const key of Object.keys(block)) {
    if (!(OPTION_KEYS as readonly string[]).includes(key)) {
      throw new Error(
        `${at}: unknown option \`${key}\`. The dependencies kind takes: ${OPTION_KEYS.join(", ")}.`,
      );
    }
  }
  const label = block["label"] ?? DEPENDENCIES_OPTION_DEFAULTS.label;
  if (typeof label !== "string" || label.trim().length === 0) {
    throw new Error(`${at}: \`label\` must be a non-empty string — got ${JSON.stringify(label)}.`);
  }
  return { label };
}

export function createDependenciesKind(options: DependenciesKindOptions): AnyWorkKindDefinition {
  return issueProducerKind({
    name: DEPENDENCIES_KIND_NAME,
    promptFile: DEPENDENCIES_PROMPT_FILE,
    noun: `${options.label} ticket(s)`,
    unitNoun: "dependency ticket",
    verb: "Updating dependencies for",
    unitLabel: options.label,
    listIssues: (ctx) => ctx.github.listLabeledIssues(options.label),
    // The issue's marker, so the detector can match a PR the engine opened to
    // the bundle it came from. The agent copies it into a PR it opens itself.
    prBodyTrailer: (issue) => {
      const marker = parseMarker(issue.body);
      return marker === null ? null : renderMarker(marker);
    },
  });
}

/**
 * The catalog entry point: the loader hands a factory the resolved config and
 * the block's root options. Validation throws here, at registration.
 */
export default function dependenciesKind(
  _config: PhoebeConfig,
  options: unknown,
): AnyWorkKindDefinition {
  return createDependenciesKind(
    resolveDependenciesOptions(options, `kinds.${DEPENDENCIES_KIND_NAME}`),
  );
}
