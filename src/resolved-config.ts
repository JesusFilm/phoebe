// Engine entry point for the resolved, defaults-filled config.
//
// The consumer edits `../phoebe.config.ts` — a `PhoebeUserConfig` whose only
// required fields are the repo/toolchain identifiers. This module runs it
// through `resolveConfig` once at load time and re-exports the fully-populated
// `PhoebeConfig` that every engine module imports as `config`. Keeping the
// resolution in one place means:
//
//   - engine code stays repo-agnostic and never has to `?? default` inline,
//   - `validateUserConfig` fires at startup (or the first import in tests), and
//   - swapping the shipped defaults is a one-file edit in `config-schema.ts`.

import { config as userConfig } from "../phoebe.config.ts";
import { resolveConfig } from "./config-schema.ts";

export const config = resolveConfig(userConfig);
