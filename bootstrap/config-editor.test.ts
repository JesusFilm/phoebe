// The bootstrapper's config-edit pen (#536).
//
// Contracts:
//   * Validation is spawned against the materialized checkout, with the root
//     config's path, and its JSON verdict decides the write.
//   * An edit before any engine has been materialized is refused, not written.
//   * A checkout that cannot answer is a refusal carrying its diagnosis.
//   * `lastEditId` reads the ledger against the file as it stands now.

import { describe, expect, test } from "vite-plus/test";
import { createConfigEditor } from "./config-editor.ts";
import { configEditLedgerPath, fingerprintOf } from "../src/config-edit.ts";
import type { EngineCommandResult } from "./pipelines.ts";

const ROOT = "/etc/phoebe/phoebe.config.ts";
const DATA = "/data/repos";
const LEDGER = configEditLedgerPath(DATA);

const CONFIG = `export const config = {
  repoSlug: "acme/test",
  repoUrl: "https://github.com/acme/test.git",
  installCommand: "npm ci",
  checkCommand: "npm run check",
  testCommand: "npm test",
};
`;

function harness(
  verdict: EngineCommandResult = { status: 0, stdout: `{"ok":true}\n`, stderr: "" },
  source = CONFIG,
): {
  editor: ReturnType<typeof createConfigEditor>;
  disk: Map<string, string>;
  calls: string[][];
} {
  const disk = new Map<string, string>([[ROOT, source]]);
  const calls: string[][] = [];
  const editor = createConfigEditor({
    rootConfigPath: ROOT,
    dataBase: DATA,
    env: {},
    now: () => Date.parse("2026-09-18T10:00:00.000Z"),
    run: (args) => {
      calls.push([...args]);
      return verdict;
    },
    readFile: (path) => {
      const content = disk.get(path);
      if (content === undefined) throw new Error(`ENOENT ${path}`);
      return content;
    },
    writeFile: (path, content) => disk.set(path, content),
  });
  return { editor, disk, calls };
}

const edit = (
  over: Partial<Parameters<ReturnType<typeof createConfigEditor>["apply"]>[0]> = {},
) => ({
  id: "e1",
  path: "checkCommand",
  value: "pnpm run check",
  fingerprint: fingerprintOf(CONFIG),
  ...over,
});

describe("createConfigEditor", () => {
  test("asks the materialized checkout, then writes the root config", async () => {
    const { editor, disk, calls } = harness();
    const receipt = await editor.apply(edit());

    expect(receipt.state).toBe("written");
    expect(calls).toEqual([
      ["config", "set", "checkCommand", `"pnpm run check"`, "--validate", "--config", ROOT],
    ]);
    expect(disk.get(ROOT)).toContain(`checkCommand: "pnpm run check"`);
  });

  test("a verdict of no is a refusal, and the file is untouched", async () => {
    const { editor, disk } = harness({
      status: 1,
      stdout: `{"ok":false,"reason":"checkCommand must be non-empty"}\n`,
      stderr: "",
    });
    const receipt = await editor.apply(edit({ value: "" }));
    expect(receipt.state).toBe("refused");
    if (receipt.state !== "refused") return;
    expect(receipt.reason).toBe("invalid");
    expect(receipt.why).toContain("non-empty");
    expect(disk.get(ROOT)).toBe(CONFIG);
  });

  test("a checkout that cannot answer refuses with its own diagnosis", async () => {
    const { editor, disk } = harness({ status: 1, stdout: "", stderr: "Unknown command `config`" });
    const receipt = await editor.apply(edit());
    expect(receipt.state).toBe("refused");
    if (receipt.state !== "refused") return;
    expect(receipt.why).toContain("Unknown command");
    expect(disk.get(ROOT)).toBe(CONFIG);
  });

  test("before any engine is materialized, an edit is refused rather than written", async () => {
    const disk = new Map<string, string>([[ROOT, CONFIG]]);
    const editor = createConfigEditor({
      rootConfigPath: ROOT,
      dataBase: DATA,
      env: {},
      readFile: (path) =>
        disk.get(path) ??
        (() => {
          throw new Error("ENOENT");
        })(),
      writeFile: (path, content) => disk.set(path, content),
    });
    const receipt = await editor.apply(edit());
    expect(receipt.state).toBe("refused");
    if (receipt.state !== "refused") return;
    expect(receipt.why).toContain("no engine is running");
    expect(disk.get(ROOT)).toBe(CONFIG);
  });

  test("the nudge fires on a write, once attached", async () => {
    const { editor } = harness();
    let nudged = 0;
    editor.useNudge(() => {
      nudged += 1;
    });
    await editor.apply(edit());
    expect(nudged).toBe(1);
  });

  test("lastEditId is null until an edit lands, then names the newest", async () => {
    const { editor, disk } = harness();
    expect(editor.lastEditId()).toBeNull();
    await editor.apply(edit());
    expect(editor.lastEditId()).toBe("e1");

    // The operator edits the file themselves: the ledger no longer describes it.
    disk.set(ROOT, `${disk.get(ROOT)!}\n// mine\n`);
    expect(editor.lastEditId()).toBeNull();
    expect(disk.has(LEDGER)).toBe(true);
  });

  test("an unreadable root config is null, not a throw", () => {
    const editor = createConfigEditor({
      rootConfigPath: ROOT,
      dataBase: DATA,
      readFile: () => {
        throw new Error("ENOENT");
      },
    });
    expect(editor.lastEditId()).toBeNull();
  });
});
