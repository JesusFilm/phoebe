// Reference illustration — workspace topology, CHILD config for `acme/gadget`.
//
// The second placeholder child, showing the multiplicity: one container at the
// workspace root supervising two self-configured child repos side by side
// (widget/, gadget/). Like `widget/`, in a real workspace this file is committed
// IN the child's own repo; the directory name is an operator-chosen local
// checkout name and `repoSlug` is the authoritative identity.
//
// Deliberately a DIFFERENT provider from the `widget` child: this one runs
// `cursor` (its .env supplies CURSOR_API_KEY), `widget` runs `claude`. The
// supervisor's per-tenant env-scrub (#61) means neither engine can read the
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
