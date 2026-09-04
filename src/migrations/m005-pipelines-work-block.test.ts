// m005 — pipelines-work-block migration unit tests.
//
// Contract:
//   detect: null when the config is absent or carries none of the three fields.
//   detect: non-null when any of workOrder / workKinds / promptFiles is present.
//   apply: moves all three into `pipelines.work`, folding each promptFiles key
//          onto the kind that reads it, and leaves every other byte alone.
//   apply: ConfigRefusal, config untouched, when a moved value is computed or
//          holds a spread.
//   idempotence: apply → detect returns null.
//   verify: passes when the pipeline still resolves the same, throws when it does not.
//   role filter: tenant only.
//
// The end-to-end pass through `runMigrate` — real files, real load, real
// verification — lives in migrate.test.ts.

import { describe, expect, test } from "vite-plus/test";
import { isConfigRefusal } from "../config-handle.ts";
import type { MigrationVerifyContext } from "../migrate.ts";
import { pipelinesWorkBlockMigration as m } from "./m005-pipelines-work-block.ts";

const CONFIG_PATH = "phoebe.config.ts";

function withConfig(content: string) {
  return (relPath: string): string | null => (relPath === CONFIG_PATH ? content : null);
}

/** A config in the templates form, with `extra` spliced into the object. */
function config(extra = ""): string {
  return [
    `import type { PhoebeUserConfig } from "phoebe-agent";`,
    ``,
    `const config: PhoebeUserConfig = {`,
    `  repoSlug: "owner/repo",`,
    `  repoUrl: "https://github.com/owner/repo.git",`,
    `  installCommand: "npm ci",`,
    `  checkCommand: "npm run check",`,
    `  testCommand: "npm test",${extra}`,
    `};`,
    ``,
    `export default config;`,
    ``,
  ].join("\n");
}

const ALL_THREE = config(
  [
    ``,
    `  workOrder: ["conflicts", "issues"],`,
    ``,
    `  // Spend where the agent reconstructs intent.`,
    `  workKinds: {`,
    `    // conflicts infers intent from two diverging branches.`,
    `    conflicts: { effort: "high" },`,
    `    issues: { effort: "high" },`,
    `  },`,
    ``,
    `  promptFiles: {`,
    `    issue: "../prompts/issues-prompt.md",`,
    `    conflict: "../prompts/conflict-prompt.md",`,
    `  },`,
  ].join("\n"),
);

/** Run detect + apply, asserting the migration applied rather than refused. */
function migrate(content: string): string {
  const data = m.detect("/dir", withConfig(content));
  expect(data).not.toBeNull();
  const writes = m.apply("/dir", data, withConfig(content));
  expect(isConfigRefusal(writes)).toBe(false);
  if (isConfigRefusal(writes)) throw new Error("refused");
  return writes[CONFIG_PATH]!;
}

describe("m005 detect", () => {
  test("null when there is no config file", () => {
    expect(m.detect("/dir", () => null)).toBeNull();
  });

  test("null when the config carries none of the three fields", () => {
    expect(m.detect("/dir", withConfig(config()))).toBeNull();
  });

  test("applicable when only one of the three is present", () => {
    expect(m.detect("/dir", withConfig(config(`\n  workOrder: ["checks"],`)))).not.toBeNull();
    expect(m.detect("/dir", withConfig(config(`\n  workKinds: {},`)))).not.toBeNull();
    expect(m.detect("/dir", withConfig(config(`\n  promptFiles: {},`)))).not.toBeNull();
  });

  test("describe names each move", () => {
    const data = m.detect("/dir", withConfig(ALL_THREE));
    const described = m.describe(data);
    expect(described).toContain("workOrder → pipelines.work.order");
    expect(described).toContain("workKinds → pipelines.work.kinds");
    expect(described).toContain("promptFiles.issue → pipelines.work.kinds.issues.promptFile");
  });
});

describe("m005 apply", () => {
  test("moves all three, keeping the comments inside workKinds", () => {
    const migrated = migrate(ALL_THREE);

    expect(migrated).toContain(
      [
        `  pipelines: {`,
        `    work: {`,
        `      order: ["conflicts", "issues"],`,
        `      kinds: {`,
        `        // conflicts infers intent from two diverging branches.`,
        `        conflicts: { effort: "high", promptFile: "../prompts/conflict-prompt.md" },`,
        `        issues: { effort: "high", promptFile: "../prompts/issues-prompt.md" },`,
        `      },`,
        `    },`,
        `  },`,
      ].join("\n"),
    );
  });

  test("leaves every byte outside the moved ranges alone", () => {
    const migrated = migrate(ALL_THREE);

    for (const line of [
      `import type { PhoebeUserConfig } from "phoebe-agent";`,
      `  repoSlug: "owner/repo",`,
      `  testCommand: "npm test",`,
      `  // Spend where the agent reconstructs intent.`,
      `export default config;`,
    ]) {
      expect(migrated).toContain(line);
    }
  });

  test("empties the three top-level fields", () => {
    const migrated = migrate(ALL_THREE);
    for (const field of ["  workOrder:", "  workKinds:", "  promptFiles:"]) {
      expect(migrated).not.toContain(field);
    }
  });

  test("creates a kind block for a prompt key whose kind had no tuning", () => {
    const migrated = migrate(config(`\n  promptFiles: {\n    research: "prompts/r.md",\n  },`));
    expect(migrated).toContain(`promptFile: "prompts/r.md"`);
    expect(migrated).toContain(`research: {`);
  });

  test("is not applicable a second time", () => {
    const migrated = migrate(ALL_THREE);
    expect(m.detect("/dir", withConfig(migrated))).toBeNull();
  });
});

describe("m005 refusals", () => {
  const refusalFor = (extra: string): string => {
    const content = config(extra);
    const data = m.detect("/dir", withConfig(content));
    expect(data).not.toBeNull();
    const writes = m.apply("/dir", data, withConfig(content));
    expect(isConfigRefusal(writes)).toBe(true);
    return isConfigRefusal(writes) ? writes.instruction : "";
  };

  test("a spread in workKinds is manual, with the operator instruction verbatim", () => {
    const instruction = refusalFor(`\n  workKinds: { ...BASE, issues: { effort: "high" } },`);
    expect(instruction).toContain("move `workOrder` to `pipelines.work.order`");
    expect(instruction).toContain("`pipelines.work.kinds.<kind>.promptFile`");
    expect(instruction).toContain("issue → issues");
    expect(instruction).toContain("spread");
  });

  test("a computed workOrder is manual", () => {
    expect(refusalFor(`\n  workOrder: buildOrder(),`)).toContain("computed value");
  });

  test("a promptFiles key that names no built-in kind is manual", () => {
    expect(refusalFor(`\n  promptFiles: { docs: "prompts/docs.md" },`)).toContain(
      "names no built-in work kind",
    );
  });
});

describe("m005 verify", () => {
  const USER = {
    repoSlug: "owner/repo",
    repoUrl: "https://github.com/owner/repo.git",
    installCommand: "npm ci",
    checkCommand: "npm run check",
    testCommand: "npm test",
  };

  /** Drive verify with two in-memory configs standing in for before and after. */
  async function runVerify(before: object, after: object): Promise<void> {
    await m.verify!({
      dir: "/dir",
      configPath: "/dir/phoebe.config.ts",
      data: { content: "", fields: [], promptKeys: [] },
      loadConfig: ((source?: string) =>
        Promise.resolve(
          source === undefined ? after : before,
        )) as MigrationVerifyContext["loadConfig"],
    });
  }

  test("passes when the move preserved the resolved pipeline", async () => {
    await expect(
      runVerify(
        { ...USER, workOrder: ["issues"], promptFiles: { issue: "p/i.md" } },
        {
          ...USER,
          pipelines: { work: { order: ["issues"], kinds: { issues: { promptFile: "p/i.md" } } } },
        },
      ),
    ).resolves.toBeUndefined();
  });

  test("throws when the order changed", async () => {
    await expect(
      runVerify({ ...USER, workOrder: ["issues", "checks"] }, { ...USER, workOrder: ["checks"] }),
    ).rejects.toThrow(/pipelines.work.order/);
  });

  test("throws when a prompt path changed", async () => {
    await expect(
      runVerify(
        { ...USER, promptFiles: { issue: "p/i.md" } },
        { ...USER, pipelines: { work: { kinds: { issues: { promptFile: "p/other.md" } } } } },
      ),
    ).rejects.toThrow(/resolved prompt paths/);
  });

  test("throws when a kind's tuning changed", async () => {
    await expect(
      runVerify(
        { ...USER, workKinds: { issues: { effort: "high" } } },
        { ...USER, pipelines: { work: { kinds: { issues: { effort: "low" } } } } },
      ),
    ).rejects.toThrow(/pipelines.work.kinds/);
  });
});

describe("m005 role filter", () => {
  test("targets tenants only", () => {
    expect(m.appliesTo).toEqual(["tenant"]);
  });
});
