// Guards the ten `phoebe.config.ts` samples, the three shipped scaffold
// templates, and docs/configuration.md's base-config JSON example against
// roster drift (#57). `tsconfig.json` only type-checks five of the ten
// (repo root, examples/solo, examples/nested, and the two
// examples/nested/repos/* tenants) and no test resolved any of them — a
// config that type-checks can still fail `resolveConfiguration`'s runtime
// validation (#36).
//
// The three shipped templates (`templates/phoebe.config*.ts`) carry bare
// `{{TOKEN}}` placeholders since #72 (see vite.config.ts's lint
// `ignorePatterns` comment) and are not valid TypeScript on their own —
// adding `templates/` to tsconfig.json's `include` would just fail the
// parse on every one of them. Instead this renders each with representative
// field values via the same `renderAuthoredConfig` that `phoebe init` calls,
// then resolves the rendered output — a strictly stronger guard, since it
// also proves the rendered config is deployable, not just syntactically valid.

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vite-plus/test";
import {
  loadConfiguration,
  loadUserConfig,
  renderAuthoredConfig,
  resolveConfiguration,
  type AuthoredFields,
  type PhoebeUserConfig,
  type ScaffoldProfile,
} from "./config/index.ts";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const DOCS_PATH = join(REPO_ROOT, "docs", "configuration.md");

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "phoebe-sample-config-"));
}

// Deployment-root samples (workspace/nested) deliberately carry only
// `engine`/`workspace` — the five required fields live per-tenant, never on
// the shared root. Filling them in with dummies (overridden below by
// whatever the sample itself declares) lets one helper resolve every sample,
// exercising each file's own fields' shape validation either way.
const DUMMY_REQUIRED: PhoebeUserConfig = {
  repoSlug: "sample/repo",
  repoUrl: "https://example.invalid/sample/repo.git",
  installCommand: "true",
  checkCommand: "true",
  testCommand: "true",
};

async function expectResolves(path: string): Promise<void> {
  const loaded = await loadUserConfig(path);
  const repository: PhoebeUserConfig = { ...DUMMY_REQUIRED, ...loaded };
  expect(() => resolveConfiguration({ repository })).not.toThrow();
}

const REAL_SAMPLES = [
  "phoebe.config.ts",
  ".phoebe/phoebe.config.ts",
  ".phoebe-nested/phoebe.config.ts",
  ".phoebe-nested/repos/JesusFilm/phoebe/phoebe.config.ts",
  ".phoebe-nested/repos/JesusFilm/youtube-studio/phoebe.config.ts",
  "examples/solo/phoebe.config.ts",
  "examples/nested/phoebe.config.ts",
  "examples/nested/repos/acme/gadget/phoebe.config.ts",
  "examples/nested/repos/acme/widget/phoebe.config.ts",
];

describe("sample phoebe.config.ts files resolve cleanly (#57)", () => {
  for (const relPath of REAL_SAMPLES) {
    test(relPath, async () => {
      await expectResolves(join(REPO_ROOT, relPath));
    });
  }
});

const SCAFFOLD_SAMPLES: Array<{ profile: ScaffoldProfile; fields: Partial<AuthoredFields> }> = [
  {
    profile: "flat",
    fields: {
      repoSlug: "acme/widget",
      repoUrl: "https://github.com/acme/widget.git",
      installCommand: "npm ci",
      checkCommand: "npm run check",
      testCommand: "npm test",
      defaultProvider: "claude",
    },
  },
  {
    profile: "tenant",
    fields: {
      repoSlug: "acme/widget",
      repoUrl: "https://github.com/acme/widget.git",
      installCommand: "npm ci",
      checkCommand: "npm run check",
      testCommand: "npm test",
    },
  },
  { profile: "workspace", fields: {} },
];

describe("shipped scaffold templates render and resolve cleanly (#57)", () => {
  for (const { profile, fields } of SCAFFOLD_SAMPLES) {
    test(profile, async () => {
      const rendered = renderAuthoredConfig(profile, fields, { packageRoot: REPO_ROOT });
      const dir = makeTempDir();
      const path = join(dir, "phoebe.config.ts");
      writeFileSync(path, rendered);
      await expectResolves(path);
    });
  }
});

describe("docs/configuration.md's base-config example (#57)", () => {
  test("parses and resolves through the base-document parser", async () => {
    const docs = readFileSync(DOCS_PATH, "utf8");
    const match = /```json\n([\s\S]*?)\n```/.exec(docs);
    if (!match) {
      throw new Error("docs/configuration.md: could not find the base-config JSON example.");
    }
    const dir = makeTempDir();
    const basePath = join(dir, "generated-base.json");
    writeFileSync(basePath, match[1]!);

    const resolved = await loadConfiguration({
      repositoryPath: join(REPO_ROOT, "examples", "solo", "phoebe.config.ts"),
      env: { PHOEBE_BASE_CONFIG: basePath },
    });
    // The example sets branchPrefix — proof the base layer actually merged in,
    // not just that resolution happened to succeed some other way.
    expect(resolved.config.branchPrefix).toBe("managed/");
  });
});
