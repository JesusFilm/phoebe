// m006 — flatten-custom-kinds migration unit tests.
//
// Contract:
//   detect: null when the config is absent or no `custom` block exists, under
//           `workKinds` or under any `pipelines.<name>.kinds`.
//   apply: lifts each `custom.<name>` entry up one level, comments intact,
//          removes the empty `custom` block, unwraps a wrapper's `options`
//          into the entry root, and leaves every other byte alone.
//   apply: ConfigRefusal, config untouched, when a custom kind also has a
//          sibling tuning block (the fold is a value edit) or the block is
//          not a plain literal.
//   idempotence: apply → detect returns null.
//   verify: passes when every declared kind survived, throws when one is gone.
//   role filter: tenant only.

import { describe, expect, test } from "vite-plus/test";
import { isConfigRefusal } from "../config-handle.ts";
import type { MigrationVerifyContext } from "../migrate.ts";
import { flattenCustomKindsMigration as m } from "./m006-flatten-custom-kinds.ts";

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

const TOP_LEVEL = config(
  [
    ``,
    `  workKinds: {`,
    `    issues: { effort: "high" },`,
    `    custom: {`,
    `      // Nudges stale PRs.`,
    `      "stale-pr-nudger": { module: "./kinds/nudger.ts", options: { staleDays: 7 } },`,
    `      digest: "./kinds/digest.ts",`,
    `    },`,
    `  },`,
  ].join("\n"),
);

const IN_PIPELINE = config(
  [
    ``,
    `  pipelines: {`,
    `    work: { order: ["issues"] },`,
    `    intake: {`,
    `      kinds: {`,
    `        custom: { slack: "./kinds/slack.ts" },`,
    `      },`,
    `    },`,
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

describe("m006 detect", () => {
  test("null when there is no config file", () => {
    expect(m.detect("/dir", () => null)).toBeNull();
  });

  test("null when no custom block exists anywhere", () => {
    expect(m.detect("/dir", withConfig(config()))).toBeNull();
    expect(
      m.detect("/dir", withConfig(config(`\n  workKinds: { issues: { effort: "high" } },`))),
    ).toBeNull();
    expect(
      m.detect(
        "/dir",
        withConfig(config(`\n  pipelines: { work: { kinds: { nudge: "./nudge.ts" } } },`)),
      ),
    ).toBeNull();
  });

  test("finds custom blocks under workKinds and under a pipeline's kinds", () => {
    expect(m.detect("/dir", withConfig(TOP_LEVEL))).not.toBeNull();
    expect(m.detect("/dir", withConfig(IN_PIPELINE))).not.toBeNull();
  });

  test("describe names each block and its kinds", () => {
    const described = m.describe(m.detect("/dir", withConfig(TOP_LEVEL)));
    expect(described).toContain("`workKinds.custom`");
    expect(described).toContain("stale-pr-nudger");
    expect(described).toContain("digest");
    expect(m.describe(m.detect("/dir", withConfig(IN_PIPELINE)))).toContain(
      "`pipelines.intake.kinds.custom`",
    );
  });
});

describe("m006 apply", () => {
  test("lifts each entry up one level and drops the custom block, comments intact", () => {
    const migrated = migrate(TOP_LEVEL);
    expect(migrated).toContain(
      [
        `  workKinds: {`,
        `    issues: { effort: "high" },`,
        `    "stale-pr-nudger": { module: "./kinds/nudger.ts", staleDays: 7 },`,
        `    digest: "./kinds/digest.ts",`,
        `  },`,
      ].join("\n"),
    );
    expect(migrated).not.toContain("custom");
    expect(migrated).not.toContain("options");
  });

  test("flattens inside a pipeline's kinds block", () => {
    const migrated = migrate(IN_PIPELINE);
    expect(migrated).toContain(`kinds: {`);
    expect(migrated).toContain(`slack: "./kinds/slack.ts",`);
    expect(migrated).not.toContain("custom");
  });

  test("leaves every byte outside the touched block alone", () => {
    const migrated = migrate(TOP_LEVEL);
    expect(migrated).toContain(`  repoSlug: "owner/repo",`);
    expect(migrated).toContain(`import type { PhoebeUserConfig } from "phoebe-agent";`);
  });

  test("apply → detect is null (idempotence)", () => {
    expect(m.detect("/dir", withConfig(migrate(TOP_LEVEL)))).toBeNull();
    expect(m.detect("/dir", withConfig(migrate(IN_PIPELINE)))).toBeNull();
  });

  test("refuses when a custom kind also has a sibling tuning block", () => {
    const entangled = config(
      [
        ``,
        `  workKinds: {`,
        `    digest: { effort: "low" },`,
        `    custom: { digest: "./kinds/digest.ts" },`,
        `  },`,
      ].join("\n"),
    );
    const data = m.detect("/dir", withConfig(entangled));
    const writes = m.apply("/dir", data, withConfig(entangled));
    expect(isConfigRefusal(writes)).toBe(true);
    if (isConfigRefusal(writes)) {
      expect(writes.instruction).toContain("fold its knobs");
    }
  });

  test("refuses a custom block that is not a plain literal", () => {
    const dynamic = config(`\n  workKinds: { custom: myKinds },`);
    const data = m.detect("/dir", withConfig(dynamic));
    expect(data).not.toBeNull();
    const writes = m.apply("/dir", data, withConfig(dynamic));
    expect(isConfigRefusal(writes)).toBe(true);
  });
});

describe("m006 verify", () => {
  const verifyCtx = (names: { base: string[]; names: string[] }[], migrated: string) =>
    ({
      dir: "/dir",
      data: { content: "", blocks: names },
      loadConfig: () => {
        // The migrated content is not importable here; hand back the shape a
        // real load would produce for these fixtures.
        void migrated;
        return Promise.resolve({
          repoSlug: "owner/repo",
          repoUrl: "https://github.com/owner/repo.git",
          installCommand: "npm ci",
          checkCommand: "npm run check",
          testCommand: "npm test",
          workKinds: {
            issues: { effort: "high" },
            "stale-pr-nudger": { module: "./kinds/nudger.ts" },
            digest: "./kinds/digest.ts",
          },
        });
      },
    }) as unknown as MigrationVerifyContext;

  test("passes when every declared kind survived the flatten", async () => {
    const ctx = verifyCtx(
      [{ base: ["workKinds"], names: ["stale-pr-nudger", "digest"] }],
      migrate(TOP_LEVEL),
    );
    await expect(m.verify!(ctx)).resolves.toBeUndefined();
  });

  test("throws when a declared kind went missing", async () => {
    const ctx = verifyCtx([{ base: ["workKinds"], names: ["vanished"] }], migrate(TOP_LEVEL));
    await expect(m.verify!(ctx)).rejects.toThrow(/no longer declares "vanished"/);
  });
});

describe("m006 role filter", () => {
  test("tenant only", () => {
    expect(m.appliesTo).toEqual(["tenant"]);
  });
});
