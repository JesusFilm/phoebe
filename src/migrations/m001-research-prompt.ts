// Migration m001: scaffold prompts/research-prompt.md if absent.
//
// The research work kind was added after initial deployments shipped. Solo
// deployments set up before it landed will be missing this file, causing every
// research unit to fail at dispatch. This migration creates the file from the
// shipped default — create-if-absent, so operator overrides are never touched.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Migration } from "../migrate.ts";

const SHIPPED_CONTENT = readFileSync(
  fileURLToPath(new URL("../../prompts/research-prompt.md", import.meta.url)),
  "utf8",
);

const PROMPT_REL_PATH = "prompts/research-prompt.md";

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
    return { [PROMPT_REL_PATH]: SHIPPED_CONTENT };
  },
};

export default researchPromptMigration;
