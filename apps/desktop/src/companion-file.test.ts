// What `companion.json` keeps, and what it refuses to lose.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import {
  addInstall,
  emptyCompanionFile,
  readCompanionFile,
  removeInstall,
  writeCompanionFile,
  updateInstall,
} from "./companion-file.ts";

/** The scratch directories this file made, removed after each test. */
const scratchDirs: string[] = [];

/** A path to a `companion.json` in a directory of this test's own. */
function scratch(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "phoebe-companion-"));
  scratchDirs.push(dir);
  return path.join(dir, "companion.json");
}

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("reading", () => {
  test("a companion that has never run reads as empty rather than as an error", () => {
    expect(readCompanionFile(scratch())).toEqual({
      installs: [],
      relay: null,
      preferences: { notifications: true, consoleTheme: "system" },
    });
  });

  test("round-trips what was written", () => {
    const file = scratch();
    const contents = {
      installs: [{ dir: "/repos/youtube-studio", addedAt: "2026-09-18T09:00:00.000Z" }],
      relay: { url: "https://relay.example.test" },
      preferences: { notifications: false, consoleTheme: "nord" },
    };

    writeCompanionFile(file, contents);

    expect(readCompanionFile(file)).toEqual(contents);
  });

  test("refuses a file that does not parse instead of starting empty over the top of it", () => {
    // Starting empty would lose the operator's install list to a stray editor
    // save, silently. Main turns this throw into a refusal naming the path.
    const file = scratch();
    writeFileSync(file, "{ installs: [", "utf8");

    expect(() => readCompanionFile(file)).toThrow(/does not parse as JSON/);
  });

  test("drops a field of the wrong shape and keeps the ones beside it", () => {
    const file = scratch();
    writeFileSync(
      file,
      JSON.stringify({
        installs: [{ dir: "/repos/one", addedAt: "2026-09-18T09:00:00.000Z" }, { dir: 7 }],
        relay: "https://relay.example.test",
        preferences: { notifications: "yes", consoleTheme: 3 },
      }),
      "utf8",
    );

    const contents = readCompanionFile(file);

    expect(contents.installs).toEqual([{ dir: "/repos/one", addedAt: "2026-09-18T09:00:00.000Z" }]);
    expect(contents.relay).toBeNull();
    expect(contents.preferences).toEqual({ notifications: true, consoleTheme: "system" });
  });

  test("leaves no temporary behind, so the next read sees one file", () => {
    const file = scratch();
    writeCompanionFile(file, emptyCompanionFile());

    expect(readFileSync(file, "utf8").endsWith("\n")).toBe(true);
    expect(() => readFileSync(`${file}.writing`, "utf8")).toThrow();
  });
});

describe("the install list", () => {
  const AT = "2026-09-18T09:00:00.000Z";

  test("stores the absolute directory, which is the install's identity", () => {
    const contents = addInstall(emptyCompanionFile(), "/repos/youtube-studio", AT);

    expect(contents.installs).toEqual([{ dir: "/repos/youtube-studio", addedAt: AT }]);
  });

  test("a relative path is refused rather than resolved against the companion's cwd", () => {
    expect(() => addInstall(emptyCompanionFile(), "repos/youtube-studio", AT)).toThrow(
      "not a full path",
    );
  });

  test("adding the same folder twice leaves one entry with its first date", () => {
    // The operator asking twice means they want it there, which it is.
    const once = addInstall(emptyCompanionFile(), "/repos/one", AT);
    const twice = addInstall(once, "/repos/one", "2026-09-19T09:00:00.000Z");

    expect(twice.installs).toEqual([{ dir: "/repos/one", addedAt: AT }]);
  });

  test("forgetting one keeps the rest", () => {
    const two = addInstall(addInstall(emptyCompanionFile(), "/repos/one", AT), "/repos/two", AT);

    expect(removeInstall(two, "/repos/one").installs).toEqual([{ dir: "/repos/two", addedAt: AT }]);
  });

  test("forgetting something that was never there changes nothing", () => {
    const one = addInstall(emptyCompanionFile(), "/repos/one", AT);

    expect(removeInstall(one, "/repos/other").installs).toEqual(one.installs);
  });

  test("holds no fact about an install beyond where it is and when it arrived", () => {
    // Every other fact is derived on read (#527 §12). A state written here is a
    // state that goes stale the moment someone runs `docker stop` in a terminal.
    const contents = addInstall(emptyCompanionFile(), "/repos/one", AT);

    expect(Object.keys(contents.installs[0]!).sort()).toEqual(["addedAt", "dir"]);
  });
});

describe("an install's own settings", () => {
  const AT = "2026-09-18T09:00:00.000Z";
  const two = addInstall(addInstall(emptyCompanionFile(), "/repos/one", AT), "/repos/two", AT);
  const one = path.resolve("/repos/one");
  const other = path.resolve("/repos/two");

  test("a display name is kept beside the folder, and cleared by an empty one", () => {
    const named = updateInstall(two, "/repos/one", { label: "  Studio  " });
    expect(named.installs[0]).toEqual({ dir: one, addedAt: AT, name: "Studio" });
    expect(named.installs[1]).toEqual({ dir: other, addedAt: AT });
    expect(updateInstall(named, "/repos/one", { label: null }).installs[0]).toEqual({
      dir: one,
      addedAt: AT,
    });
    expect(updateInstall(named, "/repos/one", { label: "" }).installs[0]).toEqual({
      dir: one,
      addedAt: AT,
    });
  });

  test("a moved folder keeps the entry's date and name, and its place in the list", () => {
    const named = updateInstall(two, "/repos/one", { label: "Studio" });
    const moved = updateInstall(named, "/repos/one", { dir: "/repos/elsewhere" });
    expect(moved.installs).toEqual([
      {
        dir: path.resolve("/repos/elsewhere"),
        addedAt: "2026-09-18T09:00:00.000Z",
        name: "Studio",
      },
      { dir: other, addedAt: AT },
    ]);
  });

  test("refuses a folder another entry already has, a relative one, and an unknown install", () => {
    expect(() => updateInstall(two, "/repos/one", { dir: "/repos/two" })).toThrow(
      /already on the rail/,
    );
    expect(() => updateInstall(two, "/repos/one", { dir: "repos/three" })).toThrow(/full path/);
    expect(() => updateInstall(two, "/repos/nine", { label: "x" })).toThrow(/not an install/);
    // Pointing at itself is not a clash.
    expect(updateInstall(two, "/repos/one", { dir: "/repos/one" }).installs).toEqual(two.installs);
  });

  test("a name round-trips through the file, and a blank one is dropped on read", () => {
    const file = scratch();
    writeCompanionFile(file, updateInstall(two, "/repos/one", { label: "Studio" }));
    expect(readCompanionFile(file).installs[0]).toEqual({ dir: one, addedAt: AT, name: "Studio" });
    writeFileSync(
      file,
      JSON.stringify({ installs: [{ dir: "/repos/one", addedAt: AT, name: "  " }] }),
      "utf8",
    );
    expect(readCompanionFile(file).installs[0]).toEqual({ dir: one, addedAt: AT });
  });
});
