// The child half of reading a tree's `issues` settings (#989), run by
// `process.execPath --no-warnings read-settings.ts <configPath>` from
// ./sides.ts. Evaluating a config runs its code, and a PR's config is code
// nobody has merged, so it runs here: in a process of its own whose env holds
// no GitHub credential and no provider key, with a HOME of its own. Only the
// resolved settings come back, as one line of JSON on stdout.
//
// The env is not consulted. The settings are what the file says, so the `main`
// and `pr` sides are read alike, whatever `PHOEBE_*` names the deployment sets.

import { dirname, resolve } from "node:path";
import { issuesPipelineConfig } from "../../src/bench-run.ts";
import { resolveConfig } from "../../src/config-schema.ts";
import { loadUserConfig } from "../../src/load-config.ts";
import { selectProviderForKind } from "../../src/provider-selection.ts";
import type { TreeSettings } from "./sides.ts";

const configPath = process.argv[2];
if (configPath === undefined) {
  process.stderr.write("usage: read-settings.ts <configPath>\n");
  process.exit(2);
}
const user = await loadUserConfig(resolve(configPath));
// Relative prompts resolve from the asset directory the config names, as they
// do when the supervisor runs the engine with that directory as its cwd.
const assetDir = resolve(dirname(resolve(configPath)), user.configDir ?? ".");
const config = issuesPipelineConfig(
  resolveConfig(user, { dataBase: dirname(resolve(configPath)) }),
);
const selection = selectProviderForKind({ kind: "issues", env: {}, config });
const settings: TreeSettings = {
  provider: selection.provider,
  model: selection.model,
  effort: selection.effort ?? null,
  promptFile: resolve(assetDir, config.promptFiles.issue),
};
process.stdout.write(`${JSON.stringify(settings)}\n`);
