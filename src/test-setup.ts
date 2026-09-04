// Vitest setup file (wired via `test.setupFiles` in vite.config.ts).
//
// Installs a resolved config into the engine's runtime holder before any test
// module loads, so any test that imports engine modules (orchestrator, prompt,
// resolved-config) sees a fully-populated `config` — without dragging in the
// repo-root sample and without every test having to install the config itself.
//
// The values are the sample from ../phoebe.config.ts merged with the shipped
// defaults; tests that want a different config can call `setResolvedConfig`
// with their own value before the module under test triggers a read.

import { DEFAULT_PIPELINE_NAME, resolveConfig } from "./config-schema.ts";
import { selectPipelineRow } from "./pipeline-row.ts";
import { setResolvedConfig } from "./resolved-config.ts";
import { config as sampleUserConfig } from "../phoebe.config.ts";

// Row selection included, exactly as the CLI does it before it hands the engine
// a config (#415/#419): the sample declares its work under `pipelines.work`, so
// without this the fixture would carry the shipped defaults for `workKinds` and
// `promptFiles` rather than what this repo actually runs.
setResolvedConfig(selectPipelineRow(resolveConfig(sampleUserConfig), DEFAULT_PIPELINE_NAME));
