// Guards this repository's vouch trust list (`.github/VOUCHED.td`).
//
// The list is consumed by `mitchellh/vouch/action/check-user` in
// `.github/workflows/vouch.yml`, which reads it over the GitHub API and never
// reports a parse error back to us — a malformed or misplaced line just makes
// its author silently resolve to `unknown`. So the format rules are asserted
// here instead, where a broken edit fails the merge gate.
//
// This is repo governance, not engine behaviour. It lives under `src/` because
// test files never ship (package.json `files` excludes `**/*.test.ts`) and
// `vp test` already covers this tree, so no consumer pays for it and no new
// test root has to exist to hold one file.
//
// Trustdown grammar, per vouch's own parser (vouch/file.nu `parse-line`):
//   - a blank line, or a line whose first non-space character is `#`, is ignored
//   - anything else is `[-]handle[ details]`, where a leading `-` denounces
//   - `handle` is `platform:username` or a bare `username`
//   - handles are lowercased before comparison, so trust is case-insensitive

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";

const repoRoot = join(import.meta.dirname, "..");

// `check-user` defaults its `vouched-file` input to this exact path, and the
// workflow deliberately does not override it. Moving the file without changing
// both would leave every author resolving to `unknown`.
const VOUCHED_PATH = ".github/VOUCHED.td";
const WORKFLOW_PATH = ".github/workflows/vouch.yml";

type Entry = { handle: string; denounced: boolean; lineNumber: number };

/** Parse Trustdown into its entries, mirroring vouch's `parse-line`. */
function parseVouchedFile(source: string): Entry[] {
  const entries: Entry[] = [];
  source.split("\n").forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      return;
    }
    const denounced = trimmed.startsWith("-");
    const rest = denounced ? trimmed.slice(1) : trimmed;
    // The first space separates the handle from its free-text details.
    const handle = rest.split(" ")[0] ?? "";
    entries.push({ handle, denounced, lineNumber: index + 1 });
  });
  return entries;
}

/** The key trust and ordering are judged by: lowercased, denounce prefix dropped. */
function sortKey(entry: Entry): string {
  return entry.handle.toLowerCase();
}

const vouchedSource = readFileSync(join(repoRoot, VOUCHED_PATH), "utf8");
const entries = parseVouchedFile(vouchedSource);

describe("vouch trust list", () => {
  test("opens with a comment header explaining the syntax", () => {
    // A maintainer editing this file should not have to find vouch's docs to
    // learn that write-access collaborators are already trusted.
    expect(vouchedSource.startsWith("#")).toBe(true);
    expect(vouchedSource).toContain("https://github.com/mitchellh/vouch");
  });

  test("every entry is a well-formed handle", () => {
    // GitHub logins are alphanumeric with single hyphens; the `[bot]` suffix on
    // an App's login and an optional `platform:` prefix are the two extras.
    const handlePattern = /^(?:[a-z]+:)?[A-Za-z\d](?:[A-Za-z\d-]*[A-Za-z\d])?(?:\[bot\])?$/;
    for (const entry of entries) {
      expect(
        handlePattern.test(entry.handle),
        `${VOUCHED_PATH}:${entry.lineNumber} — "${entry.handle}" is not a valid handle`,
      ).toBe(true);
    }
  });

  test("no handle appears twice", () => {
    // vouch lowercases before matching, so two casings of one login are one
    // person — and a duplicate is how a stale denouncement gets overridden by
    // accident rather than on purpose.
    const seen = new Map<string, number>();
    for (const entry of entries) {
      const key = sortKey(entry);
      const previous = seen.get(key);
      expect(
        previous,
        `${VOUCHED_PATH}:${entry.lineNumber} — "${entry.handle}" duplicates line ${previous}`,
      ).toBeUndefined();
      seen.set(key, entry.lineNumber);
    }
  });

  test("entries are sorted alphabetically", () => {
    // Sorted order is what keeps this file reviewable and merge-conflict-free
    // as it grows; the denounce prefix is not part of the sort key.
    const keys = entries.map(sortKey);
    const sorted = [...keys].sort();
    expect(keys, `${VOUCHED_PATH} entries must be sorted alphabetically`).toEqual(sorted);
  });

  test("sits where check-user looks, and the workflow does not redirect it", () => {
    // Half the contract is that the file is at `check-user`'s default path —
    // the module-level read above fails this whole suite if it moves, and a
    // seeded list is what the trust set is for. The other half is that the
    // workflow leaves that default alone; setting `vouched-file` is how the
    // two would come to disagree without anything failing.
    expect(entries.length).toBeGreaterThan(0);
    const workflow = readFileSync(join(repoRoot, WORKFLOW_PATH), "utf8");
    expect(workflow).toContain("mitchellh/vouch/action/check-user");
    expect(workflow).not.toContain("vouched-file:");
  });
});
