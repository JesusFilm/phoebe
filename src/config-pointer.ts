// Following a pointer config from a host verb (#663).
//
// A tenant's root `phoebe.config.ts` may be a pointer: it declares `configDir`
// and no `repoSlug`, and the config the tenant runs on is the one in that
// directory (`governingConfigPath`, bootstrap/tenants.ts). Boot learns this
// during discovery. A verb run by hand in the tenant's own directory — `phoebe
// config`, `phoebe config set`, `phoebe secret`, `phoebe pipelines` — never
// goes through discovery: it resolves `./phoebe.config.ts` and stops. Without
// this it would print the pointer's one field as the tenant's whole config, and
// `config set` would write a setting into the file nothing reads.
//
// The engine itself does not call this. Its prompt paths resolve against its
// working directory, so a run from the pointer's directory cannot be turned
// into a run on the governing config by swapping the path; it refuses instead
// and names where to run from (`assertNotConfigPointer`, src/cli.ts).

import { governingConfigFor } from "../bootstrap/tenants.ts";
import { loadUserConfig } from "./load-config.ts";

/** How a config is loaded; `loadUserConfig` outside a test. */
export type PointerLoad = (configPath: string) => Promise<unknown>;

/**
 * The config a verb handed `configPath` should read and write: the governing
 * config when `configPath` is a pointer, and `configPath` itself otherwise.
 *
 * A file that will not load, or whose `configDir` is malformed, answers itself.
 * Each verb already reports those faults against the path it was given, in its
 * own words, and a second report from here would be the worse one.
 */
export async function followConfigPointer(
  configPath: string,
  load: PointerLoad = loadUserConfig,
  exists?: (path: string) => boolean,
): Promise<string> {
  try {
    const root = (await load(configPath)) as Record<string, unknown>;
    return governingConfigFor(configPath, root, exists);
  } catch {
    return configPath;
  }
}
