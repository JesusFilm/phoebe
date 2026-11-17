#!/usr/bin/env node
// `vp run verify-skills`: fail when a vendored skill under `.agents/skills/` no
// longer matches the `computedHash` that `skills-lock.json` pins it to. Part of
// the root `ready` gate, so an in-place edit to a vendored `SKILL.md` stops the
// merge. Skills the lock doesn't name (the ones authored here) aren't checked.
//
// To change a vendored skill, bump it upstream and re-run the `skills` CLI so
// the files and the lock move together.

import path from "node:path";
import { fileURLToPath } from "node:url";

import { SKILL_LOCK_FILE, SKILLS_DIR, verifySkills } from "../src/skill-lock.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let results;
try {
  results = verifySkills(ROOT);
} catch (error) {
  console.error(`verify-skills: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const failed = results.filter((r) => r.status !== "matching");
if (failed.length === 0) {
  console.log(`verify-skills: all ${results.length} vendored skills match ${SKILL_LOCK_FILE}`);
} else {
  console.error(
    `verify-skills: ${failed.length} vendored skill(s) don't match ${SKILL_LOCK_FILE}:`,
  );
  for (const r of failed) {
    const where = `${SKILLS_DIR}/${r.name}`;
    console.error(
      r.status === "missing"
        ? `  ${r.name}: missing (no ${where}/)`
        : `  ${r.name}: modified (${where}/ hashes to ${r.actual}, lock says ${r.expected})`,
    );
  }
  console.error(
    "Vendored skills are not edited in place. Revert the change, or bump the skill " +
      "upstream with the skills CLI so the files and the lock move together.",
  );
  process.exit(1);
}
