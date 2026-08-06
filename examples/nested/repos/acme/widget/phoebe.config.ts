// Reference illustration — nested topology, TENANT config for `acme/widget`.
//
// One of two placeholder tenants under `repos/<owner>/<repo>/`. Each tenant dir a
// consumer AUTHORS holds exactly this pair — one phoebe.config.ts + one .env — and
// nothing else: it is NOT a working copy of the repo. Phoebe clones the real repo
// privately at runtime to /data/repos/acme/widget/ (see docs/configuration.md
// "Container paths"); that clone is never committed here.
//
// Same #115 convention and shape as the solo example's config, with ONE
// difference: no `engine` field. Engine source is shared and set once in the
// deployment-root config (../../../phoebe.config.ts) — a tenant carrying `engine`
// is ignored with a warning.

import type { PhoebeUserConfig } from "phoebe-agent";

const config: PhoebeUserConfig = {
  repoSlug: "acme/widget",
  repoUrl: "https://github.com/acme/widget.git",
  installCommand: "npm ci",
  checkCommand: "npm run check",
  testCommand: "npm test",

  // This tenant runs the `claude` provider, so its co-located .env supplies
  // ANTHROPIC_API_KEY. The supervisor scrubs every OTHER tenant's secrets from
  // this child's env (#61), so the sibling `gadget` tenant's key is never visible
  // here — per-tenant isolation is the whole point of the nested topology.
  defaultProvider: "claude",
};

export default config;
