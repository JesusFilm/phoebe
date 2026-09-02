// Type surface of the `phoebe-agent` bootstrapper package — the `types` entry.
// The runtime entry is index.mjs (plain JS, because Node 24 won't type-strip the
// installed package under node_modules); this file exists only to type a
// consumer's config authoring:
//
// ```ts
// import { defineConfig, type PhoebeUserConfig } from "phoebe-agent";
// export default defineConfig({ repoSlug: "...", ... });
// ```
//
// `defineConfig` is the identity typing helper; the config types are owned by
// the engine's config schema. The engine-source reader (engine-source.ts) is the
// bootstrapper's own internal concern — it is not part of the published surface
// yet, so it is not re-exported here.

export { defineConfig } from "./define-config.ts";
export type {
  CustomKindEntry,
  EngineSourceField,
  PhoebeConfig,
  PhoebeUserConfig,
  PathsConfig,
  PromptFilesConfig,
  ProviderName,
  WorkKindOverride,
  WorkKindsField,
  WorkspaceField,
} from "../src/config-schema.ts";
// The work-kind authoring surface (#303): everything a tenant kind module
// needs, type-only — kind code can never value-import the engine (no
// node_modules is reachable from the container mount), so modules type
// themselves with `satisfies WorkKindDefinition<G, U>` under `import type`.
export type { BlockerPrState, Issue } from "../src/orchestrator.ts";
export type {
  AgentHelpers,
  AgentWorkflowOutcome,
  CycleServices,
  WorkKindClock,
  WorkKindCtx,
  WorkKindDefinition,
  WorkKindGitHub,
  WorkKindOrigin,
  WorkKindReport,
  WorkKindRunCtx,
  WorkKindSelection,
  WorkKindSkip,
  WorkspaceHandle,
  WorkspaceMode,
  WorkUnitGitHubTarget,
  WorkUnitShape,
} from "../src/work-kinds/definition.ts";
