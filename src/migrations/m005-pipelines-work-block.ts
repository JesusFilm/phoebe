// Migration m005: move workOrder, workKinds and promptFiles into the
// `pipelines.work` block (#419, part of #400).
//
// #415 made `pipelines` the home of a tenant's work declaration and left the
// three top-level fields working as deprecated aliases. That is a load-bearing
// courtesy in exactly one direction: an older engine ignores `pipelines`, so a
// migrated config read by a pre-#415 engine looks like a tenant that declares
// no work at all. Migrate after the ref flip has settled, never before — the
// fetch → migrate → validate → flip-ref-last order `phoebe upgrade` already
// runs in.
//
// The move is bytes, not values: `editConfigMoveField` lifts each field's
// source range into the new block, so comments inside `workKinds` travel with
// it and every byte outside the touched ranges is left alone. A config whose
// value is computed — an identifier, a call, a spread — is refused with the
// manual instruction rather than rewritten, because relocating an expression
// is not the same as relocating a literal.
//
// `promptFiles` folds per entry: each key names one kind's prompt, under two
// spellings the engine has carried since the beginning (`issue` for the
// `issues` kind, `conflict` for `conflicts`), and the fold is where the odd
// singulars are finally spent — `pipelines.work.kinds.issues.promptFile` says
// which kind it belongs to in the path.

import {
  DEFAULT_PIPELINE_NAME,
  PROMPT_FILE_KEY_BY_KIND,
  resolveConfig,
  type PhoebeUserConfig,
  type WorkKindsField,
} from "../config-schema.ts";
import {
  ConfigRefusal,
  editConfigGetField,
  editConfigListKeys,
  editConfigMoveField,
  editConfigRemoveField,
} from "../config-handle.ts";
import type { Migration, MigrationVerifyContext } from "../migrate.ts";
import { selectPipelineRow } from "../pipeline-row.ts";

const CONFIG_REL_PATH = "phoebe.config.ts";

/** The three top-level fields this migration empties, in the order it moves them. */
const MOVES = [
  { field: "workOrder", to: [DEFAULT_PIPELINE_NAME, "order"] },
  { field: "workKinds", to: [DEFAULT_PIPELINE_NAME, "kinds"] },
] as const;

/** `promptFiles` key → the kind whose `promptFile` it becomes. */
const KIND_BY_PROMPT_KEY: Record<string, string> = Object.fromEntries(
  Object.entries(PROMPT_FILE_KEY_BY_KIND).map(([kind, key]) => [key, kind]),
);

/**
 * The instruction an operator gets when the config is too dynamic to rewrite.
 * It names the whole shape rather than one field, because a config that
 * refuses on one of the three has to be moved as a unit to stay coherent.
 */
export const PIPELINES_WORK_INSTRUCTION =
  `In ${CONFIG_REL_PATH}, move \`workOrder\` to \`pipelines.work.order\`, \`workKinds\` to ` +
  `\`pipelines.work.kinds\`, and each \`promptFiles.<key>\` to ` +
  `\`pipelines.work.kinds.<kind>.promptFile\` by hand ` +
  `(issue → issues, conflict → conflicts, checks → checks, reviews → reviews, ` +
  `research → research). The old fields keep working until you do.`;

type DetectData = {
  content: string;
  /** Which of the three top-level fields this config carries. */
  fields: string[];
  /** The `promptFiles` keys to fold, in source order. */
  promptKeys: string[];
};

function refuse(why: string): ConfigRefusal {
  return new ConfigRefusal(`${PIPELINES_WORK_INSTRUCTION} (automatic move declined: ${why})`);
}

/** A kind block's tuning minus its prompt path — the part the move must not change. */
function tuningOnly(kinds: WorkKindsField): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, block] of Object.entries(kinds)) {
    if (name === "custom" || typeof block !== "object" || block === null) {
      out[name] = block;
      continue;
    }
    const { promptFile: _promptFile, ...rest } = block as Record<string, unknown>;
    if (Object.keys(rest).length > 0) out[name] = rest;
  }
  return out;
}

/** JSON with object keys sorted, so a reordered block still compares equal. */
function stable(value: unknown): string {
  return JSON.stringify(value, (_key, val: unknown) => {
    if (typeof val !== "object" || val === null || Array.isArray(val)) return val;
    const record = val as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((k) => [k, record[k]]),
    );
  });
}

/**
 * What the `work` row resolves to: the three things the move is allowed to
 * relocate but not change. Prompt paths are compared as the flattened
 * `promptFiles` the kinds resolve to, which is exactly where the fold lands,
 * and kind tuning is compared with `promptFile` taken out so the fold does not
 * read as a difference twice.
 */
function workResolution(user: PhoebeUserConfig): {
  order: readonly string[];
  kinds: string;
  promptFiles: string;
} {
  const row = selectPipelineRow(resolveConfig(user), DEFAULT_PIPELINE_NAME);
  return {
    order: row.workOrder,
    kinds: stable(tuningOnly(row.workKinds)),
    promptFiles: stable(row.promptFiles),
  };
}

export const pipelinesWorkBlockMigration: Migration = {
  id: "pipelines-work-block",
  title: "Move workOrder, workKinds and promptFiles into pipelines.work",
  // Tenant only: a workspace root is rejected outright for declaring
  // `pipelines` (it runs no work of its own), and a solo root's move is a
  // separate step — its config is also the bootstrapper's, so it moves once
  // the engine every solo deployment boots knows the new block.
  appliesTo: ["tenant"] as const,

  detect(_dir, readFile) {
    const content = readFile(CONFIG_REL_PATH);
    if (content === null) return null;

    const fields = ["workOrder", "workKinds", "promptFiles"].filter((key) => {
      const field = editConfigGetField(content, key);
      return field.ok && field.found;
    });
    if (fields.length === 0) return null;

    const promptFiles = editConfigListKeys(content, ["promptFiles"]);
    const promptKeys = promptFiles.ok && promptFiles.found ? promptFiles.keys : [];
    return { content, fields, promptKeys } satisfies DetectData;
  },

  describe(data) {
    const { fields, promptKeys } = data as DetectData;
    const parts: string[] = fields
      .filter((field) => field !== "promptFiles")
      .map((field) =>
        field === "workOrder"
          ? "workOrder → pipelines.work.order"
          : "workKinds → pipelines.work.kinds",
      );
    for (const key of promptKeys) {
      const kind = KIND_BY_PROMPT_KEY[key] ?? key;
      parts.push(`promptFiles.${key} → pipelines.work.kinds.${kind}.promptFile`);
    }
    return `move ${parts.join(", ")}`;
  },

  apply(_dir, data, _readFile) {
    const { content, fields, promptKeys } = data as DetectData;
    let next = content;

    for (const { field, to } of MOVES) {
      if (!fields.includes(field)) continue;
      const moved = editConfigMoveField(next, [field], ["pipelines", ...to]);
      if (!moved.ok) return refuse(moved.reason);
      next = moved.content;
    }

    for (const key of promptKeys) {
      const kind = KIND_BY_PROMPT_KEY[key];
      if (kind === undefined) {
        return refuse(`\`promptFiles.${key}\` names no built-in work kind`);
      }
      const moved = editConfigMoveField(
        next,
        ["promptFiles", key],
        ["pipelines", DEFAULT_PIPELINE_NAME, "kinds", kind, "promptFile"],
      );
      if (!moved.ok) return refuse(moved.reason);
      next = moved.content;
    }

    if (fields.includes("promptFiles")) {
      // Every key it held is now a kind's `promptFile`, so what is left is an
      // empty block. Anything still in it means a key nobody claimed, which
      // the fold above would already have refused.
      const removed = editConfigRemoveField(next, "promptFiles");
      if (!removed.ok) return refuse(removed.reason);
      next = removed.content;
    }

    return { [CONFIG_REL_PATH]: next };
  },

  /**
   * A move that changes what the tenant runs is worse than no move at all, so
   * the migrated file is loaded and resolved beside the source it replaced. A
   * mismatch throws, which reverts the write and reports `failed`.
   */
  async verify(ctx: MigrationVerifyContext) {
    const { content } = ctx.data as DetectData;
    // A config that does not resolve on either side leaves nothing to compare,
    // so say which side and keep the deployment as it was. The usual cause is a
    // config that was already broken — an `order` naming a kind nobody
    // declares, say — which the schema check does not catch.
    const resolveSide = async (label: string, source?: string) => {
      const user = await ctx.loadConfig(source);
      try {
        return workResolution(user);
      } catch (err) {
        throw new Error(
          `the config ${label} does not resolve: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    };
    const before = await resolveSide("as it was before the move", content);
    const after = await resolveSide("as the move left it");

    const mismatch = (what: string, from: unknown, to: unknown): never => {
      throw new Error(
        `the move changed what this tenant runs — ${what} was ${JSON.stringify(from)}, ` +
          `is now ${JSON.stringify(to)}`,
      );
    };
    if (stable(before.order) !== stable(after.order)) {
      mismatch("pipelines.work.order", before.order, after.order);
    }
    if (before.kinds !== after.kinds) {
      mismatch("pipelines.work.kinds", before.kinds, after.kinds);
    }
    if (before.promptFiles !== after.promptFiles) {
      mismatch("the resolved prompt paths", before.promptFiles, after.promptFiles);
    }
  },
};

export default pipelinesWorkBlockMigration;
