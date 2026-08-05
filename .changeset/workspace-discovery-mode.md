---
"phoebe-agent": minor
---

Workspace discovery mode (map #81): run `phoebe` at the root of a workspace
whose child repos are linked as submodules, each carrying its own in-tree
Phoebe install (config + gitignored `.env`). Phoebe walks the tree, reads each
child's config, and feeds the same tenant abstraction as multi-tenant mode —
one supervised engine child per tenant, still cloning each repo privately (the
local checkout is a discovery + config source only). A `workspace: { depth }`
block in the root `phoebe.config.ts` selects the mode. Highlights:

- Discover and supervise a fleet from the submodule tree, reconciling on every
  poll as children come and go.
- Child `repoSlug` stays authoritative; the submodule `origin` is a best-effort
  cross-check, and duplicate slug/origin across the fleet is a fatal boot abort.
- `phoebe list` and per-tenant status surface workspace tenants.
- Two new scaffolder profiles: `phoebe init --workspace` (root) and
  `phoebe init --tenant` (child, prefilling `repoSlug`/`repoUrl` from the
  child's `origin`).
- Topology docs and an operator runbook for the workspace layout.
