// The config this repository runs on is .phoebe/phoebe.config.ts.
//
// This file is a pointer to it (#663). A workspace that lists this checkout as a
// tenant finds it by this file, because discovery skips dotfolders, reads
// `configDir`, and runs the tenant on the config in that directory. That is the
// same file the dogfood deployment in .phoebe/ runs on and the same one the
// tests install as their fixture, so one edit reaches all three.
//
// Change settings there. Nothing else written here is read: a root that
// declared a `repoSlug` of its own would stop being a pointer and govern the
// tenant by itself. See docs/configuration.md, "One config for a repo deployed
// two ways".

import type { PhoebeUserConfig } from "./src/config-schema.ts";

const config: Pick<PhoebeUserConfig, "configDir"> = { configDir: ".phoebe" };

export default config;
