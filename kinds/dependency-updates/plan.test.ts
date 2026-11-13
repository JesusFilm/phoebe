// From the union to bundles: the ignore list, the maturity filter and its
// advisory exception, one target per release line, the failure record, and
// grouping with a strategy per side.

import { describe, expect, test } from "vite-plus/test";
import type { MentioningPr } from "../../src/github-client.ts";
import type { Advisory, Candidate } from "../dependencies/candidate.ts";
import { parseMarker } from "../dependencies/fingerprint.ts";
import { DEPENDENCY_UPDATES_OPTION_DEFAULTS, type DependencyUpdatesOptions } from "./options.ts";
import { planBundles, readFailures, type Failures } from "./plan.ts";

const NOW = new Date("2026-11-06T00:00:00Z");
const OLD = "2026-10-01T00:00:00Z";
const YESTERDAY = "2026-11-05T00:00:00Z";

function candidate(pkg: string, overrides: Partial<Candidate> = {}): Candidate {
  return {
    manager: "npm",
    package: pkg,
    current: "1.0.0",
    target: "1.1.0",
    updateType: "minor",
    publishedAt: OLD,
    depType: "prod",
    workspace: "package.json",
    advisories: [],
    peers: [],
    ...overrides,
  };
}

function plan(
  candidates: Candidate[],
  options: Partial<DependencyUpdatesOptions> = {},
  failures: Failures = new Map(),
) {
  return planBundles(
    candidates,
    { ...DEPENDENCY_UPDATES_OPTION_DEFAULTS, ...options },
    NOW,
    failures,
  );
}

/** Each bundle as `key: package@target, …`, for readable assertions. */
function shape(result: ReturnType<typeof plan>): string[] {
  return result.planned.map(
    (p) =>
      `${p.bundle.manager}:${p.bundle.group}: ${p.bundle.candidates.map((c) => `${c.package}@${c.target}`).join(", ")}`,
  );
}

describe("planBundles", () => {
  test("drops ignored packages by pattern", () => {
    const result = plan([candidate("@types/node"), candidate("lodash")], { ignore: ["@types/*"] });
    expect(shape(result)).toEqual(["npm:prod:relation:lodash: lodash@1.1.0"]);
    expect(result.dropped.ignored).toBe(1);
  });

  test("files nothing for an override entry, whatever release is out (#811)", () => {
    // js-yaml held at the 4.3.2 fix by a pnpm-workspace.yaml override, its
    // dependents declaring ^4.1.0, and 5.5.0 well past the 14-day major wait.
    const pin = { override: true, workspace: "pnpm-workspace.yaml", current: "4.3.2" } as const;
    const result = plan([
      candidate("js-yaml", { ...pin, target: "5.5.0", updateType: "major", publishedAt: OLD }),
      candidate("js-yaml", { ...pin, target: "4.3.3", updateType: "patch", publishedAt: OLD }),
      candidate("lodash"),
    ]);
    expect(shape(result)).toEqual(["npm:prod:relation:lodash: lodash@1.1.0"]);
    expect(result.dropped).toEqual({
      bootstrapper: 0,
      overrides: 2,
      ignored: 0,
      immature: 0,
      failedTwice: 0,
    });
  });

  test("drops a release still inside its maturity wait", () => {
    const result = plan([candidate("fresh", { publishedAt: YESTERDAY }), candidate("aged")]);
    expect(shape(result)).toEqual(["npm:prod:relation:aged: aged@1.1.0"]);
    expect(result.dropped.immature).toBe(1);
  });

  test("the maturity option moves the wait", () => {
    const result = plan([candidate("fresh", { publishedAt: YESTERDAY })], {
      maturity: { ...DEPENDENCY_UPDATES_OPTION_DEFAULTS.maturity, minor: 0 },
    });
    expect(result.dropped.immature).toBe(0);
  });

  test("the fix release of an advisory under the threshold skips the wait", () => {
    const low: Advisory = { id: "GHSA-low", severity: "moderate", fixedIn: "1.1.0" };
    const result = plan([candidate("pkg", { publishedAt: YESTERDAY, advisories: [low] })]);
    expect(shape(result)).toEqual(["npm:prod:relation:pkg: pkg@1.1.0"]);
  });

  test("an advisory at or over the threshold is left to dependency-security's clock", () => {
    const high: Advisory = { id: "GHSA-high", severity: "high", fixedIn: "1.1.0" };
    const fresh = candidate("pkg", { publishedAt: YESTERDAY, advisories: [high] });
    expect(plan([fresh]).dropped.immature).toBe(1);
    expect(shape(plan([fresh], { minSeverity: "critical" }))).toEqual([
      "npm:prod:relation:pkg: pkg@1.1.0",
    ]);
  });

  test("the fix ships alone while the newest release ages, and the newest wins once aged", () => {
    const low: Advisory = { id: "GHSA-low", severity: "low", fixedIn: "1.1.0" };
    const fix = candidate("pkg", { publishedAt: YESTERDAY, advisories: [low] });
    const newest = candidate("pkg", { target: "1.2.0", publishedAt: YESTERDAY, advisories: [low] });
    expect(shape(plan([fix, newest]))).toEqual(["npm:prod:relation:pkg: pkg@1.1.0"]);
    const aged = { ...newest, publishedAt: OLD };
    expect(shape(plan([fix, aged]))).toEqual(["npm:prod:relation:pkg: pkg@1.2.0"]);
  });

  test("production and development dependencies group by their own strategies", () => {
    const result = plan([
      candidate("@mui/material"),
      candidate("@mui/system"),
      candidate("lodash"),
      candidate("vitest", { depType: "dev" }),
      candidate("eslint", { depType: "dev" }),
      candidate("left-pad", { manager: "cargo" }),
    ]);
    expect(shape(result)).toEqual([
      "cargo:prod:relation:left-pad: left-pad@1.1.0",
      "npm:dev:all: eslint@1.1.0, vitest@1.1.0",
      "npm:prod:relation:@mui: @mui/material@1.1.0, @mui/system@1.1.0",
      "npm:prod:relation:lodash: lodash@1.1.0",
    ]);
  });

  test("an override group collects both sides, and a major files alone", () => {
    const result = plan(
      [
        candidate("eslint", { depType: "dev" }),
        candidate("eslint-plugin-x"),
        candidate("react", { target: "19.0.0", current: "18.0.0", updateType: "major" }),
      ],
      {
        grouping: {
          ...DEPENDENCY_UPDATES_OPTION_DEFAULTS.grouping,
          groups: [{ pattern: "eslint*", group: "lint" }],
        },
      },
    );
    expect(shape(result)).toEqual([
      "npm:group:lint: eslint@1.1.0, eslint-plugin-x@1.1.0",
      "npm:major:react: react@19.0.0",
    ]);
  });

  test("bundles carrying an advisory come first", () => {
    const low: Advisory = { id: "GHSA-low", severity: "low", fixedIn: null };
    const result = plan([candidate("a"), candidate("z", { advisories: [low] })]);
    expect(shape(result)).toEqual(["npm:prod:relation:z: z@1.1.0", "npm:prod:relation:a: a@1.1.0"]);
  });

  test("a bump that failed once is filed on its own; twice, not at all", () => {
    const failures: Failures = new Map([
      ["vite@1.1.0", [31]],
      ["rollup@1.1.0", [40, 32]],
    ]);
    const result = plan(
      [candidate("vite"), candidate("rollup"), candidate("react")],
      {
        grouping: {
          ...DEPENDENCY_UPDATES_OPTION_DEFAULTS.grouping,
          strategy: { prod: "all", dev: "all" },
        },
      },
      failures,
    );
    expect(shape(result)).toEqual(["npm:prod:all: react@1.1.0", "npm:retry:vite: vite@1.1.0"]);
    expect(result.dropped.failedTwice).toBe(1);
    const retry = result.planned[1]!;
    expect(retry.title).toBe("Update vite to 1.1.0");
    expect(retry.body.startsWith("Failed in #31; filed again on its own.\n\n")).toBe(true);
    expect(parseMarker(retry.body)?.key).toBe("npm:retry:vite");
  });

  test("a failure at another version does not hold this one back", () => {
    const failures: Failures = new Map([["vite@1.0.5", [31]]]);
    expect(shape(plan([candidate("vite")], {}, failures))).toEqual([
      "npm:prod:relation:vite: vite@1.1.0",
    ]);
  });
});

describe("readFailures", () => {
  const dropped = (...entries: string[]) =>
    ["Closes #1", "", "## Dropped", "", ...entries.map((e) => `- \`${e}\`: broke`)].join("\n");
  const pr = (number: number, body: string, merged = true): MentioningPr => ({
    number,
    body,
    state: "closed",
    merged,
  });

  test("counts each PR that dropped a package-version, newest first, whatever its state", () => {
    const failures = readFailures([
      pr(10, dropped("vite@8.0.0", "@types/node@26.0.0")),
      pr(12, dropped("vite@8.0.0"), false),
      pr(11, "no dropped section"),
    ]);
    expect(failures.get("vite@8.0.0")).toEqual([12, 10]);
    expect(failures.get("@types/node@26.0.0")).toEqual([10]);
    expect(failures.size).toBe(2);
  });

  // #862: when every bump drops there is no PR, so the implementer's comment
  // on the issue is the record, counted once per issue however many runs wrote one.
  test("an issue comment counts like a PR body, once per issue", () => {
    const failures = readFailures([
      pr(857, dropped("electron@45.3.2")),
      { number: 858, body: dropped("electron@45.3.2") },
      { number: 858, body: dropped("electron@45.3.2") },
    ]);
    expect(failures.get("electron@45.3.2")).toEqual([858, 857]);
  });

  test("a bump dropped only because its release is too new counts nothing", () => {
    const tooNew = "## Dropped\n\n- `electron@45.3.2` (too new): published today\n";
    const failures = readFailures([pr(857, tooNew), { number: 858, body: tooNew }]);
    expect(failures.size).toBe(0);
  });
});
