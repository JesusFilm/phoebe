// Hand-ordered registry of all registered migrations.
//
// Execution order is the array order — never inferred from filenames or IDs.
// Add new migrations at the end unless a specific ordering dependency requires
// otherwise.

import type { Migration } from "../migrate.ts";
import { researchPromptMigration } from "./m001-research-prompt.ts";

export const MIGRATIONS: readonly Migration[] = [researchPromptMigration];
