// Reference illustration — nested topology, TENANT config for `acme/gadget`.
//
// The second placeholder tenant, showing the multiplicity: one container, two
// self-configured repos side by side under `repos/`. Like `widget/`, this dir
// holds only the authored config + secrets template — never a checkout of the
// repo (Phoebe clones it privately to /data/repos/acme/gadget/ at runtime).
//
// Deliberately a DIFFERENT provider from the `widget` tenant: this one runs
// `cursor` (its .env supplies CURSOR_API_KEY), `widget` runs `claude`. The
// supervisor's per-tenant env-scrub (#61) means neither child can read the
// other's key at all. No `engine` field — shared from the deployment root.

import type { PhoebeUserConfig } from "phoebe-agent";

const config: PhoebeUserConfig = {
  repoSlug: "acme/gadget",
  repoUrl: "https://github.com/acme/gadget.git",
  installCommand: "npm ci",
  checkCommand: "npm run check",
  testCommand: "npm test",
  defaultProvider: "cursor",
};

export default config;
