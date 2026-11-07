// The native source over fake rows and fake registry clients: detection and
// the claimed list, the targets each dependency gets (same-major, major and
// advisory fix), OSV and audit advisories unioned, and the failures that cost
// a log line rather than the source.

import { describe, expect, test } from "vite-plus/test";
import type { Advisory } from "../candidate.ts";
import type { DepsDevClient, PackageVersion } from "../registry/deps-dev.ts";
import type { OsvClient } from "../registry/osv.ts";
import type { ListedDependency, Manifest, Row } from "../rows/row.ts";
import {
  chooseTargets,
  detectNative,
  fixTarget,
  runNativeSecuritySource,
  runNativeSource,
} from "./native.ts";

function versions(...list: Array<string | [string, Partial<PackageVersion>]>): PackageVersion[] {
  return list.map((entry) => {
    const [version, extra] = typeof entry === "string" ? [entry, {}] : entry;
    return {
      version,
      publishedAt: `2026-0${version.split(".").length}-01T00:00:00Z`,
      isDefault: false,
      isDeprecated: false,
      ...extra,
    };
  });
}

const manifest: Manifest = {
  checkout: "/c",
  path: "package.json",
  workspaces: ["package.json", "web/package.json"],
};

function row(overrides: Partial<Row> & { listed?: ListedDependency[] } = {}): Row {
  const { listed = [], ...rest } = overrides;
  return {
    name: "pnpm",
    manager: "npm",
    system: "npm",
    ecosystem: "npm",
    detect: async () => [manifest],
    list: async () => ({ ok: true, value: listed }),
    ...rest,
  };
}

function dep(pkg: string, current: string, extra: Partial<ListedDependency> = {}) {
  return { package: pkg, current, depType: "prod" as const, workspace: "package.json", ...extra };
}

function clients(
  known: Record<string, PackageVersion[] | Error>,
  osv: Record<string, Advisory[]> | Error = {},
) {
  const asked: string[] = [];
  const depsDev: DepsDevClient = {
    versions: async (_system, name) => {
      asked.push(name);
      const answer = known[name];
      if (answer === undefined || answer instanceof Error) {
        return { ok: false, source: "deps.dev", error: answer?.message ?? "404" };
      }
      return { ok: true, value: answer };
    },
  };
  const osvClient: OsvClient = {
    advisories: async (queries) =>
      osv instanceof Error
        ? { ok: false, source: "osv", error: osv.message }
        : {
            ok: true,
            value: queries.map(
              (q) => osv["version" in q ? `${q.name}@${q.version}` : q.name] ?? [],
            ),
          },
  };
  return { depsDev, osv: osvClient, asked };
}

describe("chooseTargets", () => {
  const list = versions("1.0.0", "1.2.0", "1.3.0-rc.1", "1.2.1", "2.0.0", "2.1.0");

  test("the newest on the current major and the newest overall, pre-releases skipped", () => {
    expect(chooseTargets("semver", "1.0.0", list, []).map((v) => v.version)).toEqual([
      "1.2.1",
      "2.1.0",
    ]);
  });

  test("an advisory's fix release is a target of its own", () => {
    expect(chooseTargets("semver", "1.0.0", list, ["1.2.0"]).map((v) => v.version)).toEqual([
      "1.2.0",
      "1.2.1",
      "2.1.0",
    ]);
  });

  test("a deprecated release is never proposed, and an up-to-date dependency gets nothing", () => {
    const deprecated = versions("1.0.0", ["1.1.0", { isDeprecated: true }]);
    expect(chooseTargets("semver", "1.0.0", deprecated, [])).toEqual([]);
    expect(chooseTargets("semver", "2.1.0", list, [])).toEqual([]);
  });

  test("a current pre-release may move to a newer pre-release", () => {
    expect(
      chooseTargets("semver", "1.3.0-rc.0", versions("1.3.0-rc.0", "1.3.0-rc.1"), []).map(
        (v) => v.version,
      ),
    ).toEqual(["1.3.0-rc.1"]);
  });
});

describe("detectNative", () => {
  test("collects every row's projects and claims their workspace manifests", async () => {
    const logged: string[] = [];
    const broken = row({
      name: "yarn",
      detect: async () => {
        throw new Error("boom");
      },
    });
    const found = await detectNative([row(), broken], "/c", (l) => logged.push(l));
    expect(found.projects).toHaveLength(1);
    expect(found.claimed).toEqual(["package.json", "web/package.json"]);
    expect(logged).toEqual(["yarn row: detection failed (boom); left to the agent fallback."]);
  });
});

describe("runNativeSource", () => {
  test("proposes each target with its date, the advisories of OSV and the audit unioned", async () => {
    const audited: Advisory = { id: "GHSA-aaaa-bbbb-cccc", severity: "low", fixedIn: "1.2.0" };
    const fromOsv: Advisory = { id: "GHSA-aaaa-bbbb-cccc", severity: "moderate", fixedIn: "1.2.0" };
    const onlyAudit: Advisory = { id: "GHSA-zzzz-zzzz-zzzz", severity: "high", fixedIn: null };
    const r = row({
      listed: [dep("left-pad", "1.0.0"), dep("vite", "8.0.0", { depType: "dev" })],
      audit: async () => ({
        ok: true,
        value: [
          { package: "left-pad", version: "1.0.0", advisory: audited },
          { package: "left-pad", version: "1.0.0", advisory: onlyAudit },
          { package: "transitive", version: "0.1.0", advisory: onlyAudit },
        ],
      }),
    });
    const c = clients(
      { "left-pad": versions("1.0.0", "1.2.0", "1.3.0"), vite: versions("8.0.0") },
      { "left-pad@1.0.0": [fromOsv] },
    );
    const logged: string[] = [];
    const result = await runNativeSource([{ row: r, manifest }], {
      ...c,
      log: (l) => logged.push(l),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidates.map((x) => [x.package, x.target, x.updateType])).toEqual([
      ["left-pad", "1.2.0", "minor"],
      ["left-pad", "1.3.0", "minor"],
    ]);
    expect(result.candidates[0]).toMatchObject({
      manager: "npm",
      current: "1.0.0",
      depType: "prod",
      workspace: "package.json",
      publishedAt: "2026-03-01T00:00:00Z",
      advisories: [fromOsv, onlyAudit],
      peers: [],
    });
    expect(logged).toEqual([]);
  });

  test("deps.dev and OSV failures are log lines, and the rest stands", async () => {
    const r = row({ listed: [dep("a", "1.0.0"), dep("b", "1.0.0")] });
    const c = clients(
      { a: versions("1.0.0", "1.0.1"), b: new Error("HTTP 500") },
      new Error("down"),
    );
    const logged: string[] = [];
    const result = await runNativeSource([{ row: r, manifest }], {
      ...c,
      log: (l) => logged.push(l),
    });
    expect(result.ok && result.candidates.map((x) => x.package)).toEqual(["a"]);
    expect(logged).toEqual([
      "native source: OSV failed (down); advisories come from the audits alone.",
      "native source: deps.dev could not answer for 1 package(s) (b); they are skipped this pass.",
    ]);
  });

  test("a package listed by two workspaces costs one deps.dev request", async () => {
    const r = row({
      listed: [dep("a", "1.0.0"), dep("a", "1.0.0", { workspace: "web/package.json" })],
    });
    const c = clients({ a: versions("1.0.0", "1.0.1") });
    const result = await runNativeSource([{ row: r, manifest }], { ...c, log: () => {} });
    expect(c.asked).toEqual(["a"]);
    expect(result.ok && result.candidates.map((x) => x.workspace)).toEqual([
      "package.json",
      "web/package.json",
    ]);
  });

  test("fails only when there were projects and none of them listed", async () => {
    const r = row({ list: async () => ({ ok: false, problem: "no lockfile" }) });
    const logged: string[] = [];
    const result = await runNativeSource([{ row: r, manifest }], {
      ...clients({}),
      log: (l) => logged.push(l),
    });
    expect(result).toEqual({ ok: false, problem: "no project the rows claimed could be listed" });
    expect(logged).toEqual(["pnpm row: could not list package.json (no lockfile)."]);
    expect(await runNativeSource([], { ...clients({}), log: () => {} })).toEqual({
      ok: true,
      candidates: [],
    });
  });
});

describe("fixTarget", () => {
  test("the highest fix among the advisories, or the current version when none has one", () => {
    const fix = (fixedIn: string | null): Advisory => ({ id: "x", severity: "high", fixedIn });
    expect(fixTarget("semver", "1.0.0", [fix("1.0.2"), fix(null), fix("1.0.10")])).toBe("1.0.10");
    expect(fixTarget("semver", "1.0.0", [fix(null)])).toBe("1.0.0");
    expect(fixTarget("semver", "2.0.0", [fix("1.9.9"), fix("2.0.0")])).toBe("2.0.0");
  });
});

describe("runNativeSecuritySource", () => {
  const high: Advisory = { id: "GHSA-hhhh-hhhh-hhhh", severity: "high", fixedIn: "1.0.5" };
  const unfixed: Advisory = { id: "GHSA-nnnn-nnnn-nnnn", severity: "critical", fixedIn: null };

  test("a direct dependency with an advisory targets its fix, and deps.dev is never asked", async () => {
    const r = row({ listed: [dep("a", "1.0.0"), dep("clean", "2.0.0")] });
    const c = clients({}, { "a@1.0.0": [high] });
    const result = await runNativeSecuritySource([{ row: r, manifest }], { ...c, log: () => {} });
    expect(c.asked).toEqual([]);
    expect(result).toEqual({
      ok: true,
      candidates: [
        {
          manager: "npm",
          package: "a",
          current: "1.0.0",
          target: "1.0.5",
          updateType: "patch",
          depType: "prod",
          workspace: "package.json",
          advisories: [high],
          peers: [],
          via: [],
        },
      ],
    });
  });

  test("a transitive finding is proposed per workspace through the direct dependencies on its paths", async () => {
    const r = row({
      listed: [
        dep("express", "4.0.0"),
        dep("jest", "29.0.0", { depType: "dev" }),
        dep("express", "4.0.0", { workspace: "web/package.json", depType: "dev" }),
      ],
      audit: async () => ({
        ok: true,
        value: [
          {
            package: "qs",
            version: "6.5.2",
            advisory: { ...high, fixedIn: "6.5.3" },
            ancestors: [".", "express", "body-parser", "jest"],
          },
          { package: "orphan", version: "0.1.0", advisory: unfixed },
        ],
      }),
    });
    const result = await runNativeSecuritySource([{ row: r, manifest }], {
      ...clients({}),
      log: () => {},
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.candidates.map((c) => [c.package, c.workspace, c.depType, c.target, c.via]),
    ).toEqual([
      ["qs", "package.json", "prod", "6.5.3", ["express", "jest"]],
      ["qs", "web/package.json", "dev", "6.5.3", ["express"]],
      ["orphan", "package.json", "prod", "0.1.0", undefined],
    ]);
  });

  test("an audit finding on a listed version joins that dependency's advisories", async () => {
    const r = row({
      listed: [dep("a", "1.0.0")],
      audit: async () => ({
        ok: true,
        value: [{ package: "a", version: "1.0.0", advisory: unfixed }],
      }),
    });
    const result = await runNativeSecuritySource([{ row: r, manifest }], {
      ...clients({}, { "a@1.0.0": [high] }),
      log: () => {},
    });
    expect(result.ok && result.candidates.map((c) => [c.package, c.target, c.advisories])).toEqual([
      ["a", "1.0.5", [high, unfixed]],
    ]);
  });
});
