# Custom work kinds — a feature illustration

**Who this is for:** anyone about to write their own work kind who wants to see
two real ones before starting. This is not a deployment topology (those live in
[`solo/`](../solo/) and [`workspace/`](../workspace/)) — it is a solo-shaped
config whose whole point is the `workKinds.custom` block.

Two kinds, deliberately at the two ends of the effort scale:

- **[`kinds/stale-pr-nudger.ts`](kinds/stale-pr-nudger.ts)** — the full form: a
  module in the tenant repo giving every contract obligation honest work.
  Fetch scans open PRs for review-thread silence, select picks the oldest
  un-nudged one, run spawns an agent (via the `ctx.agent` helper) that posts a
  nudge comment carrying a watermark marker so the PR is not re-selected — the
  house watermark pattern: state lives on GitHub, not in Phoebe.
- **The `docs-request` producer, inline in [`phoebe.config.ts`](phoebe.config.ts)**
  — the cheap case: a new issue-keyed producer is little more than a label, a
  prompt file, and one `ctx.agent.issueWorkflow` call.

The contrast is the lesson: both implement the same
`WorkKindDefinition<G, U>` contract the five built-ins run on, and after boot
the engine cannot tell any of them apart.

Conventions to copy (they are load-bearing, not style):

- **Type-only imports from `phoebe-agent`.** Kind modules and configs load
  from a container mount with no reachable `node_modules`, so a value import
  can never resolve. Everything a kind can _do_ arrives on `ctx`; the package
  supplies only types, via `import type` + `satisfies WorkKindDefinition`.
- **`promptFile` paths resolve against the runtime root** (like the built-ins'
  prompts); module paths in `workKinds.custom` resolve against the config
  file's directory.

Authoring reference: [`docs/work-kinds.md` → Writing your own kind](../../docs/work-kinds.md#writing-your-own-kind).
Field syntax: [`docs/configuration.md`](../../docs/configuration.md).
