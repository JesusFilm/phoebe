// Migration m007: write `defaultProvider: "cursor"` into a config that names no
// provider (#869).
//
// The built-in `defaultProvider` was "cursor" until #869 made it "claude". A
// deployment that never set the field ran Cursor because of the default, and
// its image installs Cursor's CLI. Moving it onto Claude without a word would
// spawn a `claude` its image does not have. So `phoebe upgrade`, which runs the
// incoming engine's migrations, writes down the agent it has been running.
//
// `phoebe init` writes `defaultProvider` into every config it scaffolds from
// #869 on, so a config without one is older than the change or was written by
// hand. Removing the field later to take the default is undone by the next
// upgrade; set `defaultProvider: "claude"` instead.
//
// detect returns null for:
//   - no config file
//   - a config that already names a provider, whatever it names
//
// A config the handle cannot edit (a spread, a computed object) is a
// ConfigRefusal: the operator gets the one-line edit, and the upgrade goes on.

import { ConfigRefusal, editConfigGetField, editConfigSetField } from "../config-handle.ts";
import type { Migration } from "../migrate.ts";

const CONFIG_REL_PATH = "phoebe.config.ts";
const KEY = "defaultProvider";
const KEPT = "cursor";

type DetectData = { content: string; readable: boolean; reason?: string };

const HAND_EDIT =
  `In ${CONFIG_REL_PATH}, add \`${KEY}: "${KEPT}"\` to keep running Cursor, ` +
  `or \`${KEY}: "claude"\` to move to the new default and install Claude Code in the image.`;

export const keepCursorProviderMigration: Migration = {
  id: "keep-cursor-provider",
  title: 'Write defaultProvider: "cursor" into a config that names no provider',
  // The workspace root carries no per-repo fields; each tenant names its own.
  appliesTo: ["solo-root", "tenant"] as const,

  detect(_dir, readFile) {
    const content = readFile(CONFIG_REL_PATH);
    if (content === null) return null;
    const field = editConfigGetField(content, KEY);
    if (!field.ok) return { content, readable: false, reason: field.reason } satisfies DetectData;
    if (field.found && field.literal !== undefined && field.literal !== null) return null;
    return { content, readable: true } satisfies DetectData;
  },

  describe(data) {
    const { readable } = data as DetectData;
    return readable
      ? `${KEY}: "${KEPT}" written: the default is now claude, and this deployment keeps the agent it ran`
      : `${KEY} not written (manual, the config could not be edited): the default is now claude`;
  },

  apply(_dir, data) {
    const { content, readable, reason } = data as DetectData;
    if (!readable) return new ConfigRefusal(`${HAND_EDIT} (${reason ?? "unreadable config"})`);
    const set = editConfigSetField(content, KEY, KEPT);
    if (!set.ok) return new ConfigRefusal(`${HAND_EDIT} (${set.reason})`);
    return { [CONFIG_REL_PATH]: set.content };
  },
};

export default keepCursorProviderMigration;
