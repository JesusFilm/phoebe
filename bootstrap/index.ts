// Public surface of the `phoebe-agent` bootstrapper package. Deliberately
// minimal — the packaged v1 has no programmatic runtime API, only the `phoebe`
// bin (bootstrap/cli.ts). Import this module for type-checked config authoring:
//
// ```ts
// import { defineConfig, type PhoebeUserConfig } from "phoebe-agent";
// export default defineConfig({ repoSlug: "...", ... });
// ```
//
// `defineConfig` is the identity typing helper; the config types are owned by
// the engine's config schema. The engine-source helpers are exported for the
// bootstrapper's own `boot` path and for tooling that wants to resolve the
// `engine` field the same way the bootstrapper does.

export { defineConfig } from "./define-config.ts";
export {
  DEFAULT_ENGINE_REF,
  DEFAULT_ENGINE_REPO,
  readEngineSource,
  resolveEngineSource,
  type ResolvedEngineSource,
} from "./engine-source.ts";
export type {
  EngineSourceField,
  PhoebeConfig,
  PhoebeUserConfig,
  PathsConfig,
  PromptFilesConfig,
  ProviderName,
} from "../src/config-schema.ts";
