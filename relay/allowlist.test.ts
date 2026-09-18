import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { ALLOWLIST_FILENAME, createAllowlist, type AllowlistFile } from "./allowlist.ts";

const NOW = new Date("2026-09-18T10:00:00.000Z");

describe("the allowlist", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "phoebe-allowlist-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function onDisk(): AllowlistFile {
    return JSON.parse(readFileSync(join(dir, ALLOWLIST_FILENAME), "utf8")) as AllowlistFile;
  }

  test("an unclaimed relay is seeded by the first verified login", () => {
    const allowlist = createAllowlist(dir, []);

    const admission = allowlist.admit({ sub: "sub-1", email: "Ada@example.test" }, NOW);

    expect(admission).toEqual({
      kind: "seeded",
      entry: {
        sub: "sub-1",
        email: "ada@example.test",
        addedBy: "bootstrap",
        addedAt: NOW.toISOString(),
      },
    });
    expect(onDisk().entries).toHaveLength(1);
  });

  test("the second person through the door is refused, not seeded again", () => {
    const allowlist = createAllowlist(dir, []);
    allowlist.admit({ sub: "sub-1", email: "ada@example.test" }, NOW);

    expect(allowlist.admit({ sub: "sub-2", email: "eve@example.test" }, NOW)).toEqual({
      kind: "refused",
    });
    expect(onDisk().entries).toHaveLength(1);
  });

  test("ALLOWED_EMAILS means the relay is never unclaimed", () => {
    const allowlist = createAllowlist(dir, ["grace@example.test"]);

    expect(allowlist.admit({ sub: "sub-1", email: "eve@example.test" }, NOW)).toEqual({
      kind: "refused",
    });
    expect(allowlist.admit({ sub: "sub-2", email: "Grace@example.test" }, NOW).kind).toBe(
      "matched",
    );
  });

  test("an environment entry is never written to the file", () => {
    const allowlist = createAllowlist(dir, ["grace@example.test"]);

    allowlist.admit({ sub: "sub-2", email: "grace@example.test" }, NOW);

    // Nothing was written at all: removing the variable removes the person.
    expect(() => onDisk()).toThrow();
    expect(allowlist.entries()).toEqual([
      { email: "grace@example.test", addedBy: "environment", addedAt: "1970-01-01T00:00:00.000Z" },
    ]);
  });

  test("an email the operator typed gains its sub on first login", () => {
    writeFileSync(
      join(dir, ALLOWLIST_FILENAME),
      JSON.stringify({
        entries: [
          {
            email: "ada@example.test",
            addedBy: "grace@example.test",
            addedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      }),
    );
    const allowlist = createAllowlist(dir, []);

    const admission = allowlist.admit({ sub: "sub-1", email: "ada@example.test" }, NOW);

    expect(admission.kind).toBe("matched");
    expect(onDisk().entries[0]?.sub).toBe("sub-1");
  });

  test("a later login matches on sub even after the address changes", () => {
    const allowlist = createAllowlist(dir, []);
    allowlist.admit({ sub: "sub-1", email: "ada@example.test" }, NOW);

    const admission = allowlist.admit({ sub: "sub-1", email: "ada@newjob.test" }, NOW);

    expect(admission.kind).toBe("matched");
    expect(onDisk().entries).toEqual([
      expect.objectContaining({ sub: "sub-1", email: "ada@newjob.test" }),
    ]);
  });

  test("an entry already keyed on someone else's sub does not match by email", () => {
    const allowlist = createAllowlist(dir, []);
    allowlist.admit({ sub: "sub-1", email: "ada@example.test" }, NOW);

    // Same address, different Google account: the sub is the identity.
    expect(allowlist.admit({ sub: "sub-impostor", email: "ada@example.test" }, NOW)).toEqual({
      kind: "refused",
    });
  });

  test("a corrupt file reads as unclaimed rather than locking everyone out", () => {
    writeFileSync(join(dir, ALLOWLIST_FILENAME), "{ this is not json");
    const allowlist = createAllowlist(dir, []);

    expect(allowlist.admit({ sub: "sub-1", email: "ada@example.test" }, NOW).kind).toBe("seeded");
  });

  test("entries() shows the file's and the environment's, file first", () => {
    const allowlist = createAllowlist(dir, ["grace@example.test", "ada@example.test"]);
    createAllowlist(dir, []).admit({ sub: "sub-1", email: "ada@example.test" }, NOW);

    expect(allowlist.entries().map((entry) => [entry.email, entry.addedBy])).toEqual([
      ["ada@example.test", "bootstrap"],
      ["grace@example.test", "environment"],
    ]);
  });
});
