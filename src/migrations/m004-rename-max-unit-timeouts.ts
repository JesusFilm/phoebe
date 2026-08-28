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
//   - maxUnproductiveRuns already present AND maxUnitTimeouts absent (fully migrated)
//   - maxUnitTimeouts absent and maxUnproductiveRuns absent (using the default — nothing to rename)
//
// When both keys are present, the migration removes maxUnitTimeouts (the new key
// wins). If maxUnitTimeouts has a non-literal value in that case, a ConfigRefusal
// asks the operator to remove the deprecated key by hand.
//
// When only maxUnitTimeouts is present with a non-literal value (no new key yet),
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

type DetectData = { content: string; value: number; removeOnly: boolean };

export const renameMaxUnitTimeoutsMigration: Migration = {
  id: "rename-max-unit-timeouts",
  title: "Rename maxUnitTimeouts to maxUnproductiveRuns",
  appliesTo: ["solo-root", "workspace-root", "tenant"] as const,

  detect(_dir, readFile) {
    const content = readFile(CONFIG_REL_PATH);
    if (content === null) return null;

    const newField = editConfigGetField(content, NEW_KEY);
    const oldField = editConfigGetField(content, OLD_KEY);

    if (newField.ok && newField.found) {
      // New key is already present. If old key is also present, remove it.
      if (!oldField.ok || !oldField.found) return null;
      const oldValue = oldField.literal === undefined ? NaN : (oldField.literal as number);
      return { content, value: oldValue, removeOnly: true } satisfies DetectData;
    }

    // Not explicitly set — using the default, nothing to rename
    if (!oldField.ok || !oldField.found) return null;

    // Non-literal value: the field is set but we cannot safely rewrite it
    if (oldField.literal === undefined) {
      return { content, value: NaN, removeOnly: false } satisfies DetectData;
    }

    return { content, value: oldField.literal as number, removeOnly: false } satisfies DetectData;
  },

  describe(data) {
    const { value, removeOnly } = data as DetectData;
    if (removeOnly) {
      if (Number.isNaN(value)) {
        return `remove deprecated ${OLD_KEY} (manual — non-literal value; ${NEW_KEY} already present)`;
      }
      return `remove deprecated ${OLD_KEY}: ${String(value)} (${NEW_KEY} already present)`;
    }
    if (Number.isNaN(value)) {
      return `rename ${OLD_KEY} to ${NEW_KEY} (manual — non-literal value)`;
    }
    return `rename ${OLD_KEY}: ${String(value)} to ${NEW_KEY}: ${String(value)}`;
  },

  apply(_dir, data, _readFile) {
    const { content, value, removeOnly } = data as DetectData;

    if (Number.isNaN(value)) {
      const message = removeOnly
        ? `In ${CONFIG_REL_PATH}, remove the deprecated \`${OLD_KEY}\` field by hand (\`${NEW_KEY}\` already present).`
        : `In ${CONFIG_REL_PATH}, rename \`${OLD_KEY}\` to \`${NEW_KEY}\` by hand.`;
      return new ConfigRefusal(message);
    }

    const removed = editConfigRemoveField(content, OLD_KEY);
    if (!removed.ok) {
      return new ConfigRefusal(
        `In ${CONFIG_REL_PATH}, remove the deprecated \`${OLD_KEY}\` field by hand ` +
          `(could not remove automatically: ${removed.reason}).`,
      );
    }

    if (removeOnly) {
      return { [CONFIG_REL_PATH]: removed.content };
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
