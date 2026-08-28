// m004 — rename-max-unit-timeouts migration unit tests.
//
// Contract:
//   detect: null when config absent, maxUnitTimeouts absent, or maxUnproductiveRuns already present.
//   detect: non-null when maxUnitTimeouts is set with a literal value.
//   apply: removes maxUnitTimeouts and inserts maxUnproductiveRuns with the same value.
//   apply: ConfigRefusal when the value is non-literal.
//   idempotence: apply → detect returns null.

import { describe, expect, test } from "vite-plus/test";
import { isConfigRefusal } from "../config-handle.ts";
import { renameMaxUnitTimeoutsMigration as m } from "./m004-rename-max-unit-timeouts.ts";

const CONFIG_PATH = "phoebe.config.ts";

function withConfig(content: string) {
  return (relPath: string): string | null => (relPath === CONFIG_PATH ? content : null);
}

function noop(): null {
  return null;
}

const MINIMAL_CONFIG_WITH_OLD_FIELD = `
export default {
  repoSlug: "owner/repo",
  repoUrl: "https://github.com/owner/repo",
  installCommand: "npm ci",
  checkCommand: "npm run check",
  testCommand: "npm test",
  maxUnitTimeouts: 5,
};
`.trim();

const MINIMAL_CONFIG_WITH_NEW_FIELD = `
export default {
  repoSlug: "owner/repo",
  repoUrl: "https://github.com/owner/repo",
  installCommand: "npm ci",
  checkCommand: "npm run check",
  testCommand: "npm test",
  maxUnproductiveRuns: 5,
};
`.trim();

const MINIMAL_CONFIG_NO_FIELD = `
export default {
  repoSlug: "owner/repo",
  repoUrl: "https://github.com/owner/repo",
  installCommand: "npm ci",
  checkCommand: "npm run check",
  testCommand: "npm test",
};
`.trim();

describe("detect", () => {
  test("returns null when config is absent", () => {
    expect(m.detect(".", noop)).toBeNull();
  });

  test("returns null when maxUnitTimeouts is absent (using default)", () => {
    expect(m.detect(".", withConfig(MINIMAL_CONFIG_NO_FIELD))).toBeNull();
  });

  test("returns null when maxUnproductiveRuns is already present", () => {
    expect(m.detect(".", withConfig(MINIMAL_CONFIG_WITH_NEW_FIELD))).toBeNull();
  });

  test("returns non-null when maxUnitTimeouts is set with a literal value", () => {
    const data = m.detect(".", withConfig(MINIMAL_CONFIG_WITH_OLD_FIELD));
    expect(data).not.toBeNull();
  });
});

describe("apply", () => {
  test("renames maxUnitTimeouts to maxUnproductiveRuns preserving the value", () => {
    const data = m.detect(".", withConfig(MINIMAL_CONFIG_WITH_OLD_FIELD));
    expect(data).not.toBeNull();
    const result = m.apply(".", data, withConfig(MINIMAL_CONFIG_WITH_OLD_FIELD));
    expect(isConfigRefusal(result)).toBe(false);
    const content = (result as Record<string, string>)[CONFIG_PATH]!;
    expect(content).toContain("maxUnproductiveRuns: 5");
    expect(content).not.toContain("maxUnitTimeouts");
  });

  test("is idempotent: apply then detect returns null", () => {
    const data = m.detect(".", withConfig(MINIMAL_CONFIG_WITH_OLD_FIELD));
    const result = m.apply(".", data, withConfig(MINIMAL_CONFIG_WITH_OLD_FIELD));
    const migrated = (result as Record<string, string>)[CONFIG_PATH]!;
    expect(m.detect(".", withConfig(migrated))).toBeNull();
  });

  test("returns ConfigRefusal for a non-literal value", () => {
    const configWithNonLiteral = `
export default {
  repoSlug: "owner/repo",
  repoUrl: "https://github.com/owner/repo",
  installCommand: "npm ci",
  checkCommand: "npm run check",
  testCommand: "npm test",
  maxUnitTimeouts: Number(process.env.MAX_TIMEOUTS ?? "3"),
};
    `.trim();
    const data = m.detect(".", withConfig(configWithNonLiteral));
    expect(data).not.toBeNull();
    const result = m.apply(".", data, withConfig(configWithNonLiteral));
    expect(isConfigRefusal(result)).toBe(true);
  });
});
