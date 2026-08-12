// Reference illustration — workspace topology, DEPLOYMENT-ROOT config.
//
// Workspace = one container running Phoebe at the root of a WORKSPACE whose
// child project repos each sit in their own directory with an in-tree Phoebe
// install (the map #81 layout). A child dir is any on-disk checkout — a plain
// clone, a git submodule, a worktree; the operator owns all git on the tree,
// Phoebe only discovers what is already there.
//
// What selects workspace mode is the `workspace: { … }` block on THIS root
// config (bootstrap/tenants.ts detection ladder: a `workspace` block → workspace
// mode; without one the deployment is solo). `depth` is how many directory levels
// under the root are scanned for a child `phoebe.config.ts` — default 1, which
// is exactly the sibling-children layout shown here (widget/, gadget/).
//
// This root file is SHARED-ONLY: the bootstrapper reads
// just the `engine` source (one engine version for the whole fleet) and the
// `workspace` discovery block from it. It describes no single repo, so it has no
// repoSlug/commands — the type is narrowed to exactly the two fields the root
// owns rather than the full five-required-field PhoebeUserConfig every child
// uses. Each child carries its own authoritative repoSlug + commands.
//
// Convention (issue #115), same as every example: type-only import from the
// published `phoebe-agent` specifier — never a relative `../src/...` path. It
// still type-checks in-tree via this package's own `name` + `exports`
// self-reference, so the example can't silently rot against src/config-schema.ts.

import type { PhoebeUserConfig } from "phoebe-agent";

const config: Pick<PhoebeUserConfig, "engine" | "workspace"> = {
  // Shared across the fleet: pin which engine version `phoebe boot` checks out
  // for every child. Omit ⇒ github/main (bleeding edge). See docs/configuration.md.
  engine: { source: "github", ref: "v0.1.0" },

  // Presence of this block selects workspace discovery mode. `depth: 1` scans
  // the immediate children of the root (widget/, gadget/) for a `phoebe.config.ts`;
  // the workspace root itself is never treated as a tenant. Omit `depth` ⇒ 1.
  // See docs/workspace.md → "Mode selection".
  workspace: { depth: 1 },
};

export default config;
