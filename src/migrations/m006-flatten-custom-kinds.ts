// Migration m006: flatten `custom` work-kind declarations into their `kinds`
// block (#465).
//
// #465 retired the reserved `custom` sub-block: a custom kind is declared
// directly under `kinds.<name>` (or the deprecated top-level `workKinds`),
// beside the built-ins' tuning blocks, and the engine now rejects a leftover
// `custom` key outright. That hard stop is why this migration is ordered
// *before* m005 in the registry: m005's verify resolves the config with the
// current engine, which would refuse a config still carrying the old block.
//
// The move is bytes, not values: each `custom.<name>` entry's source range is
// lifted up one level, comments and all. Two shapes are refused with the
// manual instruction rather than rewritten: a `custom` block whose value is
// computed (an identifier, a spread), and a config that also tunes a custom
// kind with a sibling block — folding those knobs into the entry's
// `{ module, ... }` wrapper is a value edit, not a byte move.

import { customKindEntries } from "../config-schema.ts";
import {
  ConfigRefusal,
  editConfigListKeys,
  editConfigMoveField,
  editConfigRemoveFieldAt,
} from "../config-handle.ts";
import type { Migration, MigrationVerifyContext } from "../migrate.ts";

const CONFIG_REL_PATH = "phoebe.config.ts";

/**
 * The instruction an operator gets when the config is too dynamic (or too
 * entangled) to rewrite automatically.
 */
export const FLATTEN_CUSTOM_INSTRUCTION =
  `In ${CONFIG_REL_PATH}, move each \`custom.<name>\` entry up one level, directly into the ` +
  `\`kinds\` (or \`workKinds\`) block that held \`custom\`, then delete the empty \`custom\` ` +
  `block. If a sibling block tunes a custom kind, fold its knobs into the entry's ` +
  `\`{ module, ... }\` wrapper. The engine refuses to boot until this is done.`;

/** One `custom` block found in the config: where it sits and what it declares. */
type CustomBlock = {
  /** Path of the block that holds the `custom` key (e.g. `["workKinds"]`). */
  base: string[];
  names: string[];
};

type DetectData = {
  content: string;
  blocks: CustomBlock[];
};

function refuse(why: string): ConfigRefusal {
  return new ConfigRefusal(`${FLATTEN_CUSTOM_INSTRUCTION} (automatic move declined: ${why})`);
}

/** The `custom` block under `base`, when `base` names an object that has one. */
function customBlockAt(content: string, base: string[]): CustomBlock | ConfigRefusal | null {
  const listed = editConfigListKeys(content, [...base, "custom"]);
  if (!listed.ok) return refuse(listed.reason);
  if (!listed.found) return null;
  return { base, names: listed.keys };
}

export const flattenCustomKindsMigration: Migration = {
  id: "flatten-custom-kinds",
  title: "Flatten custom work-kind declarations into their kinds block",
  appliesTo: ["tenant"] as const,

  detect(_dir, readFile) {
    const content = readFile(CONFIG_REL_PATH);
    if (content === null) return null;

    const bases: string[][] = [["workKinds"]];
    const pipelines = editConfigListKeys(content, ["pipelines"]);
    if (pipelines.ok && pipelines.found) {
      for (const name of pipelines.keys) bases.push(["pipelines", name, "kinds"]);
    }

    const blocks: CustomBlock[] = [];
    for (const base of bases) {
      const block = customBlockAt(content, base);
      // A block we cannot even enumerate is still a detection: apply() will
      // re-derive the refusal and surface the manual instruction.
      if (block instanceof ConfigRefusal) return { content, blocks: [{ base, names: [] }] };
      if (block !== null) blocks.push(block);
    }
    if (blocks.length === 0) return null;
    return { content, blocks } satisfies DetectData;
  },

  describe(data) {
    const { blocks } = data as DetectData;
    return `flatten ${blocks
      .map(
        (block) =>
          `\`${[...block.base, "custom"].join(".")}\` (${block.names.join(", ") || "unreadable"})`,
      )
      .join(", ")}`;
  },

  apply(_dir, data, _readFile) {
    const { content, blocks } = data as DetectData;
    let next = content;

    for (const block of blocks) {
      // Re-derive from the current content: an earlier block's move has
      // shifted every byte offset after it.
      const found = customBlockAt(next, block.base);
      if (found instanceof ConfigRefusal) return found;
      if (found === null) continue;
      for (const name of found.names) {
        const moved = editConfigMoveField(
          next,
          [...block.base, "custom", name],
          [...block.base, name],
        );
        if (!moved.ok) return refuse(moved.reason);
        next = moved.content;
      }
      const removed = editConfigRemoveFieldAt(next, [...block.base, "custom"]);
      if (!removed.ok) return refuse(removed.reason);
      next = removed.content;
    }

    return { [CONFIG_REL_PATH]: next };
  },

  /**
   * The engine rejects the *old* shape outright, so there is no before/after
   * resolution to compare (the m005 pattern). Instead: the migrated config must
   * resolve at all — the flattened entries pass the same shape validation the
   * `custom` block's used to — and every kind the old block declared must still
   * be declared, in the same `kinds` block, as a custom entry.
   */
  async verify(ctx: MigrationVerifyContext) {
    const { blocks } = ctx.data as DetectData;
    const user = await ctx.loadConfig();

    for (const block of blocks) {
      const kinds =
        block.base[0] === "workKinds" ? user.workKinds : user.pipelines?.[block.base[1]!]?.kinds;
      const declared = Object.keys(customKindEntries(kinds));
      const missing = block.names.filter((name) => !declared.includes(name));
      if (missing.length > 0) {
        throw new Error(
          `the flattened \`${block.base.join(".")}\` no longer declares ` +
            `${missing.map((name) => `"${name}"`).join(", ")}`,
        );
      }
    }
  },
};

export default flattenCustomKindsMigration;
