// Reference illustration — workspace topology, CHILD config for `acme/widget`.
//
// One of two placeholder children under the workspace root. In a real workspace
// this file is committed IN the child's own repository (its in-tree Phoebe
// install) — the operator places the checkout on disk (clone / submodule /
// worktree) and Phoebe discovers it. The directory name here (`widget/`) is an
// operator-chosen LOCAL checkout name; the authoritative identity is `repoSlug`
// below, cross-checked best-effort against the checkout's git origin.
//
// Like every child it holds a full five-field PhoebeUserConfig with ONE
// omission: no `engine` field. Engine source is shared and set once on the
// deployment-root config (../phoebe.config.ts) — a child carrying `engine` is
// ignored with a warning. Same #115 convention as the solo example.

import type { PhoebeUserConfig } from "phoebe-agent";

const config: PhoebeUserConfig = {
  repoSlug: "acme/widget",
  repoUrl: "https://github.com/acme/widget.git",
  installCommand: "npm ci",
  checkCommand: "npm run check",
  testCommand: "npm test",

  // This child runs the `claude` provider, so its co-located .env supplies
  // ANTHROPIC_API_KEY. The supervisor scrubs every OTHER child's secrets from
  // this engine's env (#61), so the sibling `gadget` child's key is never
  // visible here — that per-tenant isolation is what makes co-tenancy safe.
  defaultProvider: "claude",
};

export default config;
