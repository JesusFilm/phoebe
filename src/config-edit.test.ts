// Tests for the config-edit writer (#536).
//
// Contracts:
//   * Every refusal leaves the disk untouched and carries an instruction.
//   * The closed set is refused by name: fleet declaration, engine pin, relay,
//     the host `deployment` block, work-kind code, derived `paths`, a leaf a
//     PHOEBE_* variable already sets, and an env-only setting.
//   * A non-literal target is refused rather than overwritten.
//   * Optimistic concurrency: a fingerprint that does not match the file refuses.
//   * A write goes through the engine's loader first, lands in place, records a
//     ledger entry and nudges reconcile.
//   * The same edit id twice is one write and the original receipt.
//   * The ledger rolls off whole once the file moves by another hand.

import { describe, expect, test } from "vite-plus/test";
import {
  applyConfigEdit,
  configEditLedgerPath,
  editabilityOf,
  fingerprintOf,
  instructionFor,
  lastEditIdOf,
  liveLedger,
  MAX_LEDGER_ENTRIES,
  type ConfigEditDeps,
} from "./config-edit.ts";
import type { ConfigEdit, EditReceipt } from "./contracts/config-edit.ts";

const CONFIG = (extra = ""): string =>
  `import type { PhoebeUserConfig } from "phoebe-agent";\n\n` +
  `const config: PhoebeUserConfig = {\n` +
  `  repoSlug: "acme/test",\n` +
  `  repoUrl: "https://github.com/acme/test.git",\n` +
  `  installCommand: "npm ci",\n` +
  `  checkCommand: "npm run check",\n` +
  `  testCommand: "npm test",${extra}\n` +
  `};\n\nexport default config;\n`;

const FILE = "/etc/phoebe/phoebe.config.ts";
const LEDGER = "/data/repos/state/config-edits.json";

/** A writer over an in-memory disk. Returns what it wrote, so a refusal is visible. */
function harness(opts: {
  source?: string;
  ledger?: string;
  env?: NodeJS.ProcessEnv;
  validate?: ConfigEditDeps["validate"];
  writeFails?: boolean;
}): {
  deps: ConfigEditDeps;
  disk: Map<string, string>;
  nudges: () => number;
} {
  const disk = new Map<string, string>();
  if (opts.source !== undefined) disk.set(FILE, opts.source);
  if (opts.ledger !== undefined) disk.set(LEDGER, opts.ledger);
  let nudges = 0;
  return {
    disk,
    nudges: () => nudges,
    deps: {
      file: FILE,
      ledgerPath: LEDGER,
      env: opts.env ?? {},
      now: () => Date.parse("2026-09-18T10:00:00.000Z"),
      readFile: (path) => {
        const content = disk.get(path);
        if (content === undefined) throw new Error(`ENOENT ${path}`);
        return content;
      },
      writeFile: (path, content) => {
        if (opts.writeFails === true && path === FILE) throw new Error("EROFS: read-only");
        disk.set(path, content);
      },
      validate: opts.validate ?? (async () => ({ ok: true })),
      nudge: () => {
        nudges += 1;
      },
    },
  };
}

const edit = (over: Partial<ConfigEdit> & { fingerprint: string }): ConfigEdit => ({
  id: "e1",
  path: "checkCommand",
  value: "pnpm run check",
  ...over,
});

const refusal = (receipt: EditReceipt): Extract<EditReceipt, { state: "refused" }> => {
  if (receipt.state !== "refused") throw new Error(`expected a refusal, got ${receipt.state}`);
  return receipt;
};

// ------------------------------------------------------------------ editability

describe("editabilityOf", () => {
  test("a plain tenant setting is editable", () => {
    expect(editabilityOf("checkCommand", {}).ok).toBe(true);
    expect(editabilityOf("pipelines.work.pollIntervalMs", {}).ok).toBe(true);
    expect(editabilityOf("pipelines.work.kinds.issues.model", {}).ok).toBe(true);
  });

  test.each([
    ["workspace.tenants", "fleet declaration"],
    ["engine.ref", "phoebe upgrade"],
    ["relay.name", "pairing"],
    ["deployment.startCommand", "lifecycle commands"],
    ["pipelines.work.kinds.issues", "code, not a literal"],
    ["paths.workDir", "derived"],
  ])("%s is refused, and the reason says why", (path, fragment) => {
    const verdict = editabilityOf(path, {});
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toBe("not-editable");
    expect(verdict.why).toContain(fragment);
  });

  test("top-level `workKinds` is refused as the alias it is", () => {
    const verdict = editabilityOf("workKinds.issues.model", {});
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.why).toContain("pipelines.work.kinds");
  });

  test("a work-kind field the catalogue does not know is refused", () => {
    const verdict = editabilityOf("pipelines.work.kinds.issues.module", {});
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.why).toContain("not a per-kind setting");
  });

  test("`base` is env-only — no file field lives at that path", () => {
    const verdict = editabilityOf("pipelines.work.kinds.issues.base", {});
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.why).toContain("PHOEBE_BASE");
  });

  test("a leaf an env variable already sets is refused by that name", () => {
    const verdict = editabilityOf("defaultProvider", { PHOEBE_DEFAULT_PROVIDER: "claude" });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.why).toContain("PHOEBE_DEFAULT_PROVIDER");
    expect(verdict.why).toContain("env beats file");
  });

  test("a permanent alias counts as set, like the catalogued name", () => {
    expect(editabilityOf("defaultProvider", { PHOEBE_AGENT: "cursor" }).ok).toBe(false);
  });

  test("a per-kind leaf is refused by its per-kind env name", () => {
    const verdict = editabilityOf("pipelines.work.kinds.issues.model", {
      PHOEBE_ISSUES_MODEL: "opus",
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.why).toContain("PHOEBE_ISSUES_MODEL");
  });

  test("an empty variable is not set — compose writes blanks", () => {
    expect(editabilityOf("defaultProvider", { PHOEBE_DEFAULT_PROVIDER: "" }).ok).toBe(true);
  });

  test("a path with no field in the file names the only channel that sets it", () => {
    const verdict = editabilityOf("deployment.reconcileIntervalMs", {});
    expect(verdict.ok).toBe(false);
  });

  test("a path that is not a path is refused", () => {
    expect(editabilityOf("", {}).ok).toBe(false);
    expect(editabilityOf("a..b", {}).ok).toBe(false);
  });
});

describe("instructionFor", () => {
  test("nests the path the way the file is written, and quotes what it must", () => {
    expect(
      instructionFor({
        file: "/etc/phoebe/phoebe.config.ts",
        path: "pipelines.work.kinds.my-kind.model",
        value: "opus",
        reason: "not-editable",
      }),
    ).toContain(`pipelines: { work: { kinds: { "my-kind": { model: "opus" } } } }`);
  });
});

// ------------------------------------------------------------------ writes

describe("applyConfigEdit — the write", () => {
  test("splices one literal in place, records it, and nudges reconcile", async () => {
    const source = CONFIG();
    const { deps, disk, nudges } = harness({ source });
    const receipt = await applyConfigEdit(
      edit({ fingerprint: fingerprintOf(source), by: "ops@example.com" }),
      deps,
    );

    expect(receipt.state).toBe("written");
    if (receipt.state !== "written") return;
    expect(receipt.path).toBe("checkCommand");
    expect(receipt.by).toBe("ops@example.com");
    const written = disk.get(FILE)!;
    expect(written).toBe(source.replace(`"npm run check"`, `"pnpm run check"`));
    expect(receipt.fingerprint).toBe(fingerprintOf(written));
    expect(nudges()).toBe(1);

    const ledger = JSON.parse(disk.get(LEDGER)!) as { applied: { id: string; after: string }[] };
    expect(ledger.applied).toHaveLength(1);
    expect(ledger.applied[0]!.id).toBe("e1");
    expect(ledger.applied[0]!.after).toBe(receipt.fingerprint);
  });

  test("inserts a leaf the config does not declare yet", async () => {
    const source = CONFIG();
    const { deps, disk } = harness({ source });
    const receipt = await applyConfigEdit(
      edit({
        path: "pipelines.work.pollIntervalMs",
        value: 30_000,
        fingerprint: fingerprintOf(source),
      }),
      deps,
    );
    expect(receipt.state).toBe("written");
    expect(disk.get(FILE)).toContain("pollIntervalMs: 30000");
  });

  test("the patched source is what the loader is asked about", async () => {
    const source = CONFIG();
    const seen: string[] = [];
    const { deps } = harness({
      source,
      validate: async (candidate) => {
        seen.push(candidate.source);
        return { ok: true };
      },
    });
    await applyConfigEdit(edit({ fingerprint: fingerprintOf(source) }), deps);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain(`checkCommand: "pnpm run check"`);
  });
});

// ------------------------------------------------------------------ refusals

describe("applyConfigEdit — refusals", () => {
  test("a fingerprint that does not match the file refuses, disk untouched", async () => {
    const source = CONFIG();
    const { deps, disk, nudges } = harness({ source });
    const receipt = refusal(await applyConfigEdit(edit({ fingerprint: "sha256:stale" }), deps));
    expect(receipt.reason).toBe("stale");
    expect(receipt.why).toContain("changed since you loaded it");
    expect(receipt.instruction).toContain("reload it");
    expect(disk.get(FILE)).toBe(source);
    expect(disk.has(LEDGER)).toBe(false);
    expect(nudges()).toBe(0);
  });

  test("a closed block refuses and prints the nested edit to make by hand", async () => {
    const source = CONFIG();
    const { deps, disk } = harness({ source });
    const receipt = refusal(
      await applyConfigEdit(
        edit({ path: "engine.ref", value: "v1.2.3", fingerprint: fingerprintOf(source) }),
        deps,
      ),
    );
    expect(receipt.reason).toBe("not-editable");
    expect(receipt.why).toContain("phoebe upgrade");
    expect(receipt.instruction).toContain(FILE);
    expect(receipt.instruction).toContain(`engine: { ref: "v1.2.3" }`);
    expect(disk.get(FILE)).toBe(source);
  });

  test("a non-literal target refuses rather than overwriting the author's expression", async () => {
    const source = CONFIG(`\n  readyCommand: process.env.READY ?? "npm run ready",`);
    const { deps, disk } = harness({ source });
    const receipt = refusal(
      await applyConfigEdit(
        edit({ path: "readyCommand", value: "pnpm ready", fingerprint: fingerprintOf(source) }),
        deps,
      ),
    );
    expect(receipt.reason).toBe("not-literal");
    expect(receipt.why).toContain("not a plain literal");
    expect(receipt.instruction).toContain("computed");
    expect(disk.get(FILE)).toBe(source);
  });

  test("a config the loader rejects refuses, and nothing is written", async () => {
    const source = CONFIG();
    const { deps, disk } = harness({
      source,
      validate: async () => ({ ok: false, reason: "`checkCommand` must be a non-empty string" }),
    });
    const receipt = refusal(
      await applyConfigEdit(edit({ value: "", fingerprint: fingerprintOf(source) }), deps),
    );
    expect(receipt.reason).toBe("invalid");
    expect(receipt.why).toContain("non-empty string");
    expect(disk.get(FILE)).toBe(source);
  });

  test("an unreadable config refuses rather than writing one blind", async () => {
    const { deps } = harness({});
    const receipt = refusal(await applyConfigEdit(edit({ fingerprint: "sha256:x" }), deps));
    expect(receipt.reason).toBe("unreadable");
    expect(receipt.instruction).toContain("mount");
  });

  test("a read-only mount refuses and leaves no ledger entry", async () => {
    const source = CONFIG();
    const { deps, disk, nudges } = harness({ source, writeFails: true });
    const receipt = refusal(
      await applyConfigEdit(edit({ fingerprint: fingerprintOf(source) }), deps),
    );
    expect(receipt.reason).toBe("unwritable");
    expect(receipt.why).toContain("EROFS");
    expect(receipt.instruction).toContain("read-write");
    expect(disk.has(LEDGER)).toBe(false);
    expect(nudges()).toBe(0);
  });

  test("every refusal carries an instruction", async () => {
    const source = CONFIG();
    for (const candidate of [
      edit({ fingerprint: "sha256:stale" }),
      edit({ path: "workspace.tenants", value: "x", fingerprint: fingerprintOf(source) }),
    ]) {
      const { deps } = harness({ source });
      const receipt = refusal(await applyConfigEdit(candidate, deps));
      expect(receipt.instruction.length).toBeGreaterThan(0);
      expect(receipt.instruction).toContain(FILE);
    }
  });
});

// ------------------------------------------------------------------ idempotency

describe("applyConfigEdit — the ledger", () => {
  test("the same id twice is one write and the original receipt", async () => {
    const source = CONFIG();
    const { deps, disk, nudges } = harness({ source });
    const first = await applyConfigEdit(edit({ fingerprint: fingerprintOf(source) }), deps);
    const after = disk.get(FILE)!;

    // Redelivered against the fingerprint it was made with, which by now is stale.
    const second = await applyConfigEdit(edit({ fingerprint: fingerprintOf(source) }), deps);
    expect(second).toEqual(first);
    expect(disk.get(FILE)).toBe(after);
    expect(nudges()).toBe(1);
  });

  test("a different id against the new fingerprint writes again", async () => {
    const source = CONFIG();
    const { deps, disk } = harness({ source });
    await applyConfigEdit(edit({ fingerprint: fingerprintOf(source) }), deps);
    const receipt = await applyConfigEdit(
      edit({
        id: "e2",
        path: "testCommand",
        value: "pnpm test",
        fingerprint: fingerprintOf(disk.get(FILE)!),
      }),
      deps,
    );
    expect(receipt.state).toBe("written");
    const ledger = JSON.parse(disk.get(LEDGER)!) as { applied: { id: string }[] };
    expect(ledger.applied.map((entry) => entry.id)).toEqual(["e1", "e2"]);
  });

  test("an edit by another hand rolls the whole ledger off", async () => {
    const source = CONFIG();
    const { deps, disk } = harness({ source });
    await applyConfigEdit(edit({ fingerprint: fingerprintOf(source) }), deps);

    // The operator edits the file themselves.
    const byHand = disk.get(FILE)!.replace(`"npm test"`, `"pnpm test"`);
    disk.set(FILE, byHand);

    const receipt = await applyConfigEdit(
      edit({
        id: "e1",
        path: "installCommand",
        value: "pnpm i",
        fingerprint: fingerprintOf(byHand),
      }),
      deps,
    );
    // Not the old receipt: the ledger rolled, so the id is new again.
    expect(receipt.state).toBe("written");
    if (receipt.state !== "written") return;
    expect(receipt.path).toBe("installCommand");
    const ledger = JSON.parse(disk.get(LEDGER)!) as { applied: { path: string }[] };
    expect(ledger.applied.map((entry) => entry.path)).toEqual(["installCommand"]);
  });

  test("liveLedger reads a missing, empty or unparseable file as no edits", () => {
    expect(liveLedger(null, "sha256:a").applied).toEqual([]);
    expect(liveLedger("{oops", "sha256:a").applied).toEqual([]);
    expect(liveLedger(`{"version":1,"applied":[]}`, "sha256:a").applied).toEqual([]);
  });

  test("lastEditIdOf is the newest entry, or null", () => {
    expect(lastEditIdOf({ version: 1, applied: [] })).toBeNull();
    const raw = JSON.stringify({
      version: 1,
      applied: [
        { id: "a", file: FILE, path: "x", value: 1, at: "t", after: "sha256:old" },
        { id: "b", file: FILE, path: "y", value: 2, at: "t", after: "sha256:now" },
      ],
    });
    expect(lastEditIdOf(liveLedger(raw, "sha256:now"))).toBe("b");
    expect(lastEditIdOf(liveLedger(raw, "sha256:moved"))).toBeNull();
  });

  test("the ledger is a fixed size", async () => {
    const { deps, disk } = harness({ source: CONFIG() });
    for (let i = 0; i < MAX_LEDGER_ENTRIES + 5; i++) {
      await applyConfigEdit(
        edit({ id: `e${i}`, value: `run ${i}`, fingerprint: fingerprintOf(disk.get(FILE)!) }),
        deps,
      );
    }
    const ledger = JSON.parse(disk.get(LEDGER)!) as { applied: unknown[] };
    expect(ledger.applied).toHaveLength(MAX_LEDGER_ENTRIES);
  });
});

describe("configEditLedgerPath", () => {
  test("sits in the deployment-level state directory, beside the report", () => {
    expect(configEditLedgerPath("/data/repos")).toBe("/data/repos/state/config-edits.json");
  });
});
