---
"phoebe-agent": patch
---

Add `workspace: { tenants: [...] }` (#128) — the field shape, ordering, and
validation for declaring a workspace fleet in the root config instead of walking
the tree for it. A `workspace` block now declares exactly one of two discovery
arms: `depth` (walk, unchanged and still the default) or `tenants` (an ordered
list of directory paths). Declared order is authoritative, so it is spawn,
`phoebe list`, and warn order rather than the walk's emergent slug sort.

Entries are normalized (`"./widget/"` → `widget`); absolute and `..` paths are
deliberately supported so a root may supervise repos outside the workspace
checkout. Fatal at load: an entry that is or contains the workspace root, a
duplicate after normalization, a tenant nested inside another tenant, a glob, or
declaring both arms at once. An empty list is a valid zero-tenant fleet.

One validator in `bootstrap/workspace-source.ts` backs both the bootstrapper and
`resolveConfig`, so the two entry points cannot drift, and `WorkspaceField` is a
union — declaring both arms fails to compile as well as to validate.

Discovery for a declared fleet is not wired yet: a config using `tenants` is
validated and then refused at boot rather than silently falling back to a walk.
