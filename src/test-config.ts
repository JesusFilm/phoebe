// A fully-resolved `PhoebeConfig` for tests to pass into the module under
// test — the sample from ../phoebe.config.ts merged with the shipped
// defaults. Tests that want a different value (a different `branchPrefix`,
// `blockerSource`, ...) spread over this and pass the result, rather than
// mutating any shared state.

import { resolveConfiguration } from "./config/index.ts";
import { config as sampleUserConfig } from "../phoebe.config.ts";

export const sampleConfig = resolveConfiguration({ repository: sampleUserConfig }).config;
