// Public consumer surface for `phoebe-agent`. Deliberately minimal — the
// packaged v1 has no programmatic runtime API, only the `phoebe` bin. Import
// this module for type-checked config authoring:
//
// ```ts
// import { defineConfig, type PhoebeUserConfig } from "phoebe-agent";
// export default defineConfig({ repoSlug: "...", ... });
// ```
//
// Types are structurally identical to their source in ./config-schema.ts;
// `defineConfig` is the identity typing helper from ./load-config.ts.

export { defineConfig } from "./load-config.ts";
export type {
  PhoebeConfig,
  PhoebeUserConfig,
  PathsConfig,
  PromptFilesConfig,
  ProviderName,
} from "./config-schema.ts";
