// Reference illustration — solo topology (a single self-configured repo).
//
// This file also fixes the convention every example config follows (issue #115):
//
//   • Import the config type from the published package specifier `phoebe-agent`,
//     never a relative `../src/...` path. That is exactly what a real consumer
//     writes; in-tree it still resolves because tsc honors this package's own
//     `name` + `exports` self-reference, so these examples type-check against the
//     live schema (src/config-schema.ts) and can't silently rot.
//   • Keep the import TYPE-ONLY (`import type`) and annotate the object
//     (`const config: PhoebeUserConfig`). A value import of `phoebe-agent` cannot
//     resolve from the container mount, so a real config must never rely on one —
//     see docs/configuration.md. (`defineConfig` is the host-only alternative;
//     the examples model the container-safe form.)
//   • Only the five required fields are shown here; every other field is optional
//     and filled from the shipped defaults. See docs/configuration.md for the
//     full reference.

import type { PhoebeUserConfig } from "phoebe-agent";

const config: PhoebeUserConfig = {
  repoSlug: "acme/widget",
  repoUrl: "https://github.com/acme/widget.git",
  installCommand: "npm ci",
  checkCommand: "npm run check",
  testCommand: "npm test",
};

export default config;
