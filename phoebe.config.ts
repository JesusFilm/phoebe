// All repo-specific configuration for the Phoebe engine lives here. Engine
// code under src/ never mentions any concrete repository (enforced by
// src/config-seam.test.ts); pointing Phoebe at a repo is a matter of editing
// this one file.
//
// Only five fields are required — repo slug, clone URL, and the three
// toolchain commands. Every other field is optional and filled from
// `CONFIG_DEFAULTS` (see src/config-schema.ts) by `resolveConfig()`. Add
// entries below only when you need to override an engine default.

import type { PhoebeUserConfig } from "./src/config-schema.ts";

export const config: PhoebeUserConfig = {
  repoSlug: "your-org/your-repo",
  repoUrl: "https://github.com/your-org/your-repo.git",
  installCommand: "npm ci",
  checkCommand: "npm run check",
  testCommand: "npm test",
};
