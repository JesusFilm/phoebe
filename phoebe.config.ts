// Sample Phoebe consumer config. In this repo it doubles as the fixture that
// src/test-setup.ts installs into src/resolved-config.ts before any test
// module loads. Real consumers install `phoebe-agent` and export their own
// config; the shape is identical:
//
// ```ts
// import { defineConfig } from "phoebe-agent";
// export default defineConfig({
//   repoSlug: "your-org/your-repo",
//   repoUrl: "https://github.com/your-org/your-repo.git",
//   installCommand: "npm ci",
//   checkCommand: "npm run check",
//   testCommand: "npm test",
// });
// ```
//
// Only five fields are required (repo slug, clone URL, install/check/test
// commands). Everything else is optional and filled from `CONFIG_DEFAULTS`
// (see src/config-schema.ts) by `resolveConfig()`. Add entries here only when
// overriding a shipped default; `PHOEBE_*` env vars provide one-off overrides
// for a subset of scalar fields (see src/load-config.ts).

import { defineConfig } from "./bootstrap/define-config.ts";

export const config = defineConfig({
  repoSlug: "your-org/your-repo",
  repoUrl: "https://github.com/your-org/your-repo.git",
  installCommand: "npm ci",
  checkCommand: "npm run check",
  testCommand: "npm test",
});

export default config;
