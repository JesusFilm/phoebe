// Migration m001: scaffold prompts/research-prompt.md if absent.
//
// The research work kind was added after initial deployments shipped. Solo
// deployments set up before it landed will be missing this file, causing every
// research unit to fail at dispatch. This migration creates the file from the
// shipped default — create-if-absent, so operator overrides are never touched.

import { readFileSync } from "node:fs";
import type { Migration } from "../migrate.ts";
import { moduleDirOf, resolvePackageResource } from "../package-resource.ts";

const PROMPT_REL_PATH = "prompts/research-prompt.md";

/**
 * The shipped default, read when the migration applies rather than when this
 * module loads. Lazy because the registry is imported by anything that imports
 * `migrate`, including the companion's main process (ADR 0001) — and a read at
 * import time turns a resource this migration may never need into something
 * that can stop a process from starting.
 */
function shippedContent(): string {
  return readFileSync(
    resolvePackageResource(PROMPT_REL_PATH, moduleDirOf(import.meta.url)),
    "utf8",
  );
}

export const researchPromptMigration: Migration = {
  id: "add-research-prompt",
  title: "Scaffold missing research-prompt.md",
  appliesTo: ["solo-root"] as const,

  detect(_dir, readFile) {
    return readFile(PROMPT_REL_PATH) === null ? true : null;
  },

  describe() {
    return `scaffold ${PROMPT_REL_PATH} from the shipped default`;
  },

  apply() {
    return { [PROMPT_REL_PATH]: shippedContent() };
  },
};

export default researchPromptMigration;
