// Hand-ordered registry of all registered migrations.
//
// Execution order is the array order — never inferred from filenames or IDs.
// Add new migrations at the end unless a specific ordering dependency requires
// otherwise.

import type { Migration } from "../migrate.ts";
import { researchPromptMigration } from "./m001-research-prompt.ts";
import { addResearchToWorkOrderMigration } from "./m002-add-research-to-workorder.ts";
import { containerLauncherArgMigration } from "./m003-container-launcher-arg.ts";
import { renameMaxUnitTimeoutsMigration } from "./m004-rename-max-unit-timeouts.ts";
import { pipelinesWorkBlockMigration } from "./m005-pipelines-work-block.ts";
import { flattenCustomKindsMigration } from "./m006-flatten-custom-kinds.ts";

export const MIGRATIONS: readonly Migration[] = [
  researchPromptMigration,
  addResearchToWorkOrderMigration,
  containerLauncherArgMigration,
  renameMaxUnitTimeoutsMigration,
  // m006 runs before m005 on purpose (#465): m005's verify resolves the config
  // with the current engine, which rejects a `custom` block outright — so the
  // flattening must have happened by the time m005 touches a config.
  flattenCustomKindsMigration,
  pipelinesWorkBlockMigration,
];
