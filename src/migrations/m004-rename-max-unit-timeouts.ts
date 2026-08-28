// Migration m004: rename maxUnitTimeouts → maxUnproductiveRuns in phoebe.config.ts.
//
// maxUnitTimeouts was renamed in #367 because, after that change, the old name
// was a lie: the counter tracks consecutive unproductive runs (no PR produced),
// not just timeouts. The field still works under the old name as a deprecated
// alias, so correctness is not affected — this migration is for tidiness and
// to silence the deprecation path in resolveConfig.
//
// detect returns null for:
//   - no config file
//   - already migrated (maxUnproductiveRuns present)
//   - maxUnitTimeouts absent (using the default — nothing to rename)
//
// When maxUnitTimeouts has a non-literal value (computed, identifier, etc.),
// a ConfigRefusal tells the operator the exact two-field edit to make by hand.

import {
  ConfigRefusal,
  editConfigGetField,
  editConfigRemoveField,
  editConfigSetField,
} from "../config-handle.ts";
import type { Migration } from "../migrate.ts";

const CONFIG_REL_PATH = "phoebe.config.ts";
const OLD_KEY = "maxUnitTimeouts";
const NEW_KEY = "maxUnproductiveRuns";

type DetectData = { content: string; value: number };

export const renameMaxUnitTimeoutsMigration: Migration = {
  id: "rename-max-unit-timeouts",
  title: "Rename maxUnitTimeouts to maxUnproductiveRuns",
  appliesTo: ["solo-root", "workspace-root", "tenant"] as const,

  detect(_dir, readFile) {
    const content = readFile(CONFIG_REL_PATH);
    if (content === null) return null;

    // Already migrated
    const newField = editConfigGetField(content, NEW_KEY);
    if (newField.ok && newField.found) return null;

    // Not explicitly set — using the default, nothing to rename
    const oldField = editConfigGetField(content, OLD_KEY);
    if (!oldField.ok || !oldField.found) return null;

    // Non-literal value: the field is set but we cannot safely rewrite it
    if (oldField.literal === undefined) {
      return { content, value: NaN } satisfies DetectData;
    }

    return { content, value: oldField.literal as number } satisfies DetectData;
  },

  describe(data) {
    const { value } = data as DetectData;
    if (Number.isNaN(value)) {
      return `rename ${OLD_KEY} to ${NEW_KEY} (manual — non-literal value)`;
    }
    return `rename ${OLD_KEY}: ${String(value)} to ${NEW_KEY}: ${String(value)}`;
  },

  apply(_dir, data, _readFile) {
    const { content, value } = data as DetectData;

    if (Number.isNaN(value)) {
      return new ConfigRefusal(
        `In ${CONFIG_REL_PATH}, rename \`${OLD_KEY}\` to \`${NEW_KEY}\` by hand.`,
      );
    }

    const removed = editConfigRemoveField(content, OLD_KEY);
    if (!removed.ok) {
      return new ConfigRefusal(
        `In ${CONFIG_REL_PATH}, rename \`${OLD_KEY}\` to \`${NEW_KEY}\` by hand ` +
          `(could not remove automatically: ${removed.reason}).`,
      );
    }

    const set = editConfigSetField(removed.content, NEW_KEY, value);
    if (!set.ok) {
      return new ConfigRefusal(
        `In ${CONFIG_REL_PATH}, rename \`${OLD_KEY}\` to \`${NEW_KEY}\` by hand ` +
          `(could not insert new field: ${set.reason}).`,
      );
    }

    return { [CONFIG_REL_PATH]: set.content };
  },
};

export default renameMaxUnitTimeoutsMigration;
