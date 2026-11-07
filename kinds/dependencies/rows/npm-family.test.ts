// The npm family of native rows, replayed against output recorded from the
// real tools (fixtures/*.json): pnpm 12, npm 11, yarn 1 and yarn 4, each over
// one project with workspaces and one without. pnpm's workspace fixture is
// this repository. Each fixture holds the manifests and lockfiles the tools
// saw and what every command printed; the replay writes the files into a
// fresh directory and answers a command only with what was recorded for it.

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { nativeRows } from "./index.ts";
import { FindingSet, fixedFromPatched, fixedFromVulnerable } from "./common.ts";
import { addNpmAuditReport, findProjects, registryPackage } from "./npm-family.ts";
import { npmRow } from "./npm.ts";
import { pnpmRow } from "./pnpm.ts";
import { unionAdvisories, type Manifest, type Row, type RowDeps, type RunTool } from "./row.ts";
import { yarnMajor, yarnRow } from "./yarn.ts";

type Recorded = { cwd: string; command: string; args: string[]; code: number; stdout: string };
type Fixture = { files: Record<string, string>; runs: Recorded[] };

type Replay = { checkout: string; deps: RowDeps; calls: string[]; logged: string[] };

function writeFiles(files: Record<string, string>): string {
  const checkout = mkdtempSync(join(tmpdir(), "phoebe-rows-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(checkout, path)), { recursive: true });
    writeFileSync(join(checkout, path), text);
  }
  return checkout;
}

function replay(name: string): Replay {
  const fixture = JSON.parse(
    readFileSync(join(import.meta.dirname, "fixtures", `${name}.json`), "utf8"),
  ) as Fixture;
  const checkout = writeFiles(fixture.files);
  const calls: string[] = [];
  const logged: string[] = [];
  const run: RunTool = async (command, args, cwd) => {
    const at = relative(checkout, cwd) || ".";
    const shown = `${at}$ ${command} ${args.join(" ")}`;
    calls.push(shown);
    const recorded = fixture.runs.find(
      (r) => r.cwd === at && r.command === command && r.args.join(" ") === args.join(" "),
    );
    if (recorded === undefined) {
      return { ok: false, missing: false, problem: `unrecorded: ${shown}` };
    }
    return {
      ok: true,
      code: recorded.code,
      stdout: recorded.stdout.split("<checkout>").join(checkout),
    };
  };
  return { checkout, deps: { run, log: (line) => logged.push(line) }, calls, logged };
}

async function detectOne(row: Row, checkout: string): Promise<Manifest> {
  const manifests = await row.detect(checkout);
  expect(manifests).toHaveLength(1);
  return manifests[0]!;
}

async function listed(row: Row, manifest: Manifest) {
  const result = await row.list(manifest);
  if (!result.ok) throw new Error(result.problem);
  return result.value;
}

/** The audit's findings without their ancestors, which the tests below check on their own. */
async function audited(row: Row, manifest: Manifest) {
  return (await auditedWithPaths(row, manifest)).map(({ package: pkg, version, advisory }) => ({
    package: pkg,
    version,
    advisory,
  }));
}

async function auditedWithPaths(row: Row, manifest: Manifest) {
  const result = await row.audit!(manifest);
  if (!result.ok) throw new Error(result.problem);
  return result.value;
}

/** The three-package workspace npm, yarn 1 and yarn 4 were all recorded over. */
const WORKSPACE_LIST = [
  { package: "minimist", current: "1.2.5", depType: "dev", workspace: "package.json" },
  { package: "lodash", current: "4.17.20", depType: "prod", workspace: "packages/a/package.json" },
  // packages/b asks for ^4.17.21, so it gets its own lodash rather than the hoisted one.
  { package: "lodash", current: "4.18.1", depType: "prod", workspace: "packages/b/package.json" },
  { package: "ms", current: "2.1.2", depType: "dev", workspace: "packages/b/package.json" },
];

/** The single project every manager was recorded over: an alias, and each section. */
const SINGLE_LIST = [
  { package: "lodash", current: "4.17.20", depType: "prod", workspace: "package.json" },
  // `"left-pad": "npm:pad-left@2.1.0"` lists the package deps.dev knows.
  { package: "pad-left", current: "2.1.0", depType: "prod", workspace: "package.json" },
  { package: "minimist", current: "1.2.5", depType: "dev", workspace: "package.json" },
  { package: "ms", current: "2.1.2", depType: "optional", workspace: "package.json" },
];

const minimistFinding = {
  package: "minimist",
  version: "1.2.5",
  advisory: { id: "GHSA-xvch-5gv4-984h", severity: "critical", fixedIn: "1.2.6" },
};

describe("pnpm row", () => {
  test("lists this repository's workspace from the lockfile, one entry per workspace package", async () => {
    const { checkout, deps, logged } = replay("pnpm-workspace");
    const row = pnpmRow(deps);
    const manifest = await detectOne(row, checkout);
    expect(manifest).toEqual({
      checkout,
      path: "package.json",
      workspaces: ["package.json", "apps/console/package.json", "apps/desktop/package.json"],
    });

    const deps_ = await listed(row, manifest);
    expect(deps_).toContainEqual({
      package: "typescript",
      current: "7.0.2",
      depType: "dev",
      workspace: "package.json",
    });
    expect(deps_).toContainEqual({
      package: "react",
      current: "19.3.1",
      depType: "prod",
      workspace: "apps/console/package.json",
    });
    expect(deps_).toContainEqual({
      package: "electron-updater",
      current: "6.8.11",
      depType: "prod",
      workspace: "apps/desktop/package.json",
    });
    // Both apps depend on `phoebe-agent` through `workspace:*`, which no registry serves.
    expect(deps_.map((d) => d.package)).not.toContain("phoebe-agent");
    expect(new Set(deps_.map((d) => d.workspace)).size).toBe(3);
    expect(logged).toEqual([]);
  });

  test("audits transitive packages, one finding per installed version", async () => {
    const { checkout, deps } = replay("pnpm-workspace");
    const row = pnpmRow(deps);
    const findings = await audited(row, await detectOne(row, checkout));
    expect(findings).toContainEqual({
      package: "js-yaml",
      version: "4.3.0",
      advisory: { id: "GHSA-5p4m-2wfm-xmqj", severity: "high", fixedIn: "4.3.1" },
    });
    const minimatch = findings.filter((f) => f.advisory.id === "GHSA-g3hv-75wg-m249");
    expect(minimatch.map((f) => f.version).sort()).toEqual(["10.2.6", "9.0.9"]);
  });

  test("a finding names the packages on its paths, importer included", async () => {
    const { checkout, deps } = replay("pnpm-workspace");
    const row = pnpmRow(deps);
    const findings = await auditedWithPaths(row, await detectOne(row, checkout));
    const jsYaml = findings.find((f) => f.package === "js-yaml");
    expect(jsYaml?.ancestors).toEqual(
      expect.arrayContaining(["apps__desktop", "electron-updater", "electron-builder"]),
    );
    expect(jsYaml?.ancestors).not.toContain("js-yaml");
  });

  test("lists a project without workspaces", async () => {
    const { checkout, deps, calls } = replay("pnpm-single");
    const row = pnpmRow(deps);
    const manifest = await detectOne(row, checkout);
    expect(manifest.workspaces).toEqual(["package.json"]);
    expect(await listed(row, manifest)).toEqual(SINGLE_LIST);
    expect(await audited(row, manifest)).toContainEqual(minimistFinding);
    expect(calls).toEqual([
      ".$ pnpm --version",
      ".$ pnpm list --json --depth -1 --recursive",
      ".$ pnpm list --json --depth 0 --recursive",
      ".$ pnpm audit --json",
    ]);
  });
});

describe("npm row", () => {
  test("lists the root's dependencies and each workspace package's", async () => {
    const { checkout, deps } = replay("npm-workspace");
    const row = npmRow(deps);
    const manifest = await detectOne(row, checkout);
    expect(manifest.workspaces).toEqual([
      "package.json",
      "packages/a/package.json",
      "packages/b/package.json",
    ]);
    // packages/a's `"@fx/b": "*"` is the sibling workspace package, not a registry one.
    expect(await listed(row, manifest)).toEqual(WORKSPACE_LIST);
  });

  test("reads the audit's installed versions from the lockfile and skips one outside the range", async () => {
    const { checkout, deps } = replay("npm-workspace");
    const row = npmRow(deps);
    const findings = await audited(row, await detectOne(row, checkout));
    expect(findings).toContainEqual(minimistFinding);
    expect(findings).toContainEqual({
      package: "lodash",
      version: "4.17.20",
      advisory: { id: "GHSA-35jh-r3h4-6jhm", severity: "high", fixedIn: "4.17.21" },
    });
    // `>=4.0.0 <=4.17.23` names the last bad version and no fix.
    expect(findings).toContainEqual({
      package: "lodash",
      version: "4.17.20",
      advisory: { id: "GHSA-r5fr-rjxr-66jc", severity: "high", fixedIn: null },
    });
    expect(findings.map((f) => f.version)).not.toContain("4.18.1");
  });

  test("a vulnerable package's ancestors are its effects, followed up to the direct dependency", async () => {
    const set = new FindingSet();
    const advisory = (name: string) => ({
      name,
      url: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc",
      severity: "high",
      range: "<6.5.3",
    });
    addNpmAuditReport(
      set,
      {
        qs: { name: "qs", via: [advisory("qs")], effects: ["body-parser"], nodes: ["n/qs"] },
        "body-parser": { name: "body-parser", via: ["qs"], effects: ["express"], nodes: [] },
        express: { name: "express", isDirect: true, via: ["body-parser"], effects: [], nodes: [] },
      },
      { "n/qs": { version: "6.5.2" } },
    );
    expect(set.findings).toEqual([
      {
        package: "qs",
        version: "6.5.2",
        advisory: { id: "GHSA-aaaa-bbbb-cccc", severity: "high", fixedIn: "6.5.3" },
        ancestors: ["body-parser", "express"],
      },
    ]);
  });

  test("lists a project without workspaces, never asking for any", async () => {
    const { checkout, deps, calls } = replay("npm-single");
    const row = npmRow(deps);
    const manifest = await detectOne(row, checkout);
    expect(await listed(row, manifest)).toEqual(SINGLE_LIST);
    expect(await audited(row, manifest)).toContainEqual(minimistFinding);
    expect(calls.some((c) => c.includes("query"))).toBe(false);
  });
});

describe("yarn row", () => {
  test("classic: a workspace package's own copy beats the hoisted one", async () => {
    const { checkout, deps } = replay("yarn1-workspace");
    const row = yarnRow(deps);
    const manifest = await detectOne(row, checkout);
    expect(manifest.workspaces).toEqual([
      "package.json",
      "packages/a/package.json",
      "packages/b/package.json",
    ]);
    expect(await listed(row, manifest)).toEqual(WORKSPACE_LIST);
    expect(await audited(row, manifest)).toContainEqual({
      package: "lodash",
      version: "4.17.20",
      advisory: { id: "GHSA-r5fr-rjxr-66jc", severity: "high", fixedIn: "4.18.0" },
    });
  });

  test("classic: a project without workspaces", async () => {
    const { checkout, deps } = replay("yarn1-single");
    const row = yarnRow(deps);
    const manifest = await detectOne(row, checkout);
    expect(await listed(row, manifest)).toEqual(SINGLE_LIST);
    expect(await audited(row, manifest)).toContainEqual(minimistFinding);
  });

  test("modern: resolves each workspace's descriptors through their locators", async () => {
    const { checkout, deps } = replay("yarn4-workspace");
    const row = yarnRow(deps);
    const manifest = await detectOne(row, checkout);
    expect(await listed(row, manifest)).toEqual(WORKSPACE_LIST);
    expect(await audited(row, manifest)).toContainEqual(minimistFinding);
  });

  test("modern: a project without workspaces", async () => {
    const { checkout, deps } = replay("yarn4-single");
    const row = yarnRow(deps);
    const manifest = await detectOne(row, checkout);
    expect(manifest.workspaces).toEqual(["package.json"]);
    expect(await listed(row, manifest)).toEqual(
      expect.arrayContaining(SINGLE_LIST.map((d) => expect.objectContaining(d))),
    );
    expect(await audited(row, manifest)).toHaveLength(5);
  });

  test("reads the major from the version it prints", () => {
    expect(yarnMajor("1.22.22\n")).toBe(1);
    expect(yarnMajor("4.12.0")).toBe(4);
    expect(yarnMajor("not yarn")).toBeNull();
  });
});

describe("a missing tool", () => {
  const files = {
    "package.json": '{ "name": "root", "dependencies": { "lodash": "4.17.20" } }\n',
    "pnpm-lock.yaml": "",
    "tools/web/package.json": '{ "name": "web" }\n',
    "tools/web/pnpm-lock.yaml": "",
  };

  test("claims nothing and logs once for the whole checkout", async () => {
    const checkout = writeFiles(files);
    const calls: string[] = [];
    const logged: string[] = [];
    const run: RunTool = async (command, args) => {
      calls.push(`${command} ${args.join(" ")}`);
      return { ok: false, missing: true, problem: `${command} is not installed` };
    };
    const rows = nativeRows({ run, log: (line) => logged.push(line) });
    const claimed = (await Promise.all(rows.map((row) => row.detect(checkout)))).flat();
    expect(claimed).toEqual([]);
    expect(calls).toEqual(["pnpm --version"]);
    expect(logged).toEqual([
      "pnpm row: pnpm is not installed; 2 project(s) left to the agent fallback.",
    ]);
  });

  test("a version that will not run in one project leaves the others claimed", async () => {
    const checkout = writeFiles(files);
    const logged: string[] = [];
    const run: RunTool = async (_command, args, cwd) => {
      if (cwd === checkout) {
        return { ok: false, missing: false, problem: "pnpm --version exited 1: no network" };
      }
      return args[0] === "--version"
        ? { ok: true, code: 0, stdout: "12.18.0\n" }
        : { ok: true, code: 0, stdout: JSON.stringify([{ path: cwd }]) };
    };
    const manifests = await pnpmRow({ run, log: (line) => logged.push(line) }).detect(checkout);
    expect(manifests.map((m) => m.path)).toEqual(["tools/web/package.json"]);
    expect(logged).toEqual([
      "pnpm row: pnpm --version exited 1: no network; 1 project(s) left to the agent fallback.",
    ]);
  });
});

describe("finding projects", () => {
  test("packageManager settles a directory with two lockfiles, and node_modules is not searched", () => {
    const checkout = writeFiles({
      "package.json": '{ "packageManager": "yarn@4.12.0" }\n',
      "pnpm-lock.yaml": "",
      "yarn.lock": "",
      "site/package.json": "{}\n",
      "site/pnpm-lock.yaml": "",
      "site/yarn.lock": "",
      "legacy/package.json": "{}\n",
      "legacy/package-lock.json": "{}\n",
      "node_modules/x/package.json": "{}\n",
      "node_modules/x/package-lock.json": "{}\n",
      "docs/package.json": "{}\n",
    });
    expect(findProjects(checkout, "yarn")).toEqual([""]);
    expect(findProjects(checkout, "pnpm")).toEqual(["site"]);
    expect(findProjects(checkout, "npm")).toEqual(["legacy"]);
  });

  test("a declared dependency the lockfile lacks is left out and logged", async () => {
    const checkout = writeFiles({
      "package.json": '{ "dependencies": { "lodash": "^4", "left-pad": "^1" } }\n',
      "pnpm-lock.yaml": "",
    });
    const logged: string[] = [];
    const run: RunTool = async () => ({
      ok: true,
      code: 0,
      stdout: JSON.stringify([
        { path: checkout, dependencies: { lodash: { from: "lodash", version: "4.18.1" } } },
      ]),
    });
    const row = pnpmRow({ run, log: (line) => logged.push(line) });
    const result = await row.list({ checkout, path: "package.json", workspaces: ["package.json"] });
    expect(result).toEqual({
      ok: true,
      value: [{ package: "lodash", current: "4.18.1", depType: "prod", workspace: "package.json" }],
    });
    expect(logged).toEqual([
      "pnpm row: 1 declared dependency with no resolved version under package.json (package.json: left-pad).",
    ]);
  });

  test("a tool that prints an error or no JSON fails the listing rather than throwing", async () => {
    const checkout = writeFiles({ "package.json": "{}\n", "pnpm-lock.yaml": "" });
    const manifest = { checkout, path: "package.json", workspaces: ["package.json"] };
    const broken = pnpmRow({
      run: async () => ({
        ok: true,
        code: 1,
        stdout: '{ "error": { "code": "ERR_PNPM_BROKEN_LOCKFILE", "message": "broken" } }',
      }),
      log: () => {},
    });
    expect(await broken.list(manifest)).toEqual({
      ok: false,
      problem: "ERR_PNPM_BROKEN_LOCKFILE: broken",
    });
    const garbled = npmRow({
      run: async () => ({ ok: true, code: 0, stdout: "npm WARN" }),
      log: () => {},
    });
    const result = await garbled.list(manifest);
    expect(result.ok).toBe(false);
  });
});

describe("declarations and ranges", () => {
  test("only registry declarations list, aliases by their target", () => {
    expect(registryPackage("lodash", "^4.17.21")).toBe("lodash");
    expect(registryPackage("left-pad", "npm:pad-left@2.1.0")).toBe("pad-left");
    expect(registryPackage("x", "npm:@scope/real@^1")).toBe("@scope/real");
    expect(registryPackage("lodash", "npm:^4.17.0")).toBe("lodash");
    expect(registryPackage("alias", "npm:real-package")).toBe("real-package");
    expect(registryPackage("react", "catalog:")).toBe("react");
    expect(registryPackage("phoebe-agent", "workspace:*")).toBeNull();
    expect(registryPackage("a", "file:../a")).toBeNull();
    expect(registryPackage("a", "github:owner/a")).toBeNull();
    expect(registryPackage("a", "owner/a#main")).toBeNull();
  });

  test("the fix is the upper bound of the vulnerable part the installed version is in", () => {
    expect(fixedFromVulnerable(">=4.0.0 <4.3.1", "4.3.0")).toBe("4.3.1");
    expect(fixedFromVulnerable("<1.2.3 || >=2.0.0 <2.1.0", "2.0.5")).toBe("2.1.0");
    expect(fixedFromVulnerable(">=4.0.0 <=4.17.23", "4.17.20")).toBeNull();
    expect(fixedFromVulnerable("<1.0.0", "1.5.0")).toBeNull();
  });

  test("the fix is the lowest patched bound past the installed version", () => {
    expect(fixedFromPatched(">=4.3.1", "4.3.0")).toBe("4.3.1");
    expect(fixedFromPatched(">=1.2.3 <2.0.0 || >=2.1.0", "2.0.5")).toBe("2.1.0");
    expect(fixedFromPatched("<0.0.0", "1.0.0")).toBeNull();
  });

  test("OSV's advisory wins an id both report, and the audit adds the rest", () => {
    const osv = [{ id: "GHSA-aaaa-bbbb-cccc", severity: "high" as const, fixedIn: "1.2.4" }];
    const audit = [
      { id: "GHSA-aaaa-bbbb-cccc", severity: "moderate" as const, fixedIn: null },
      { id: "GHSA-0000-1111-2222", severity: "low" as const, fixedIn: "1.3.0" },
    ];
    expect(unionAdvisories([osv, audit])).toEqual([
      { id: "GHSA-0000-1111-2222", severity: "low", fixedIn: "1.3.0" },
      { id: "GHSA-aaaa-bbbb-cccc", severity: "high", fixedIn: "1.2.4" },
    ]);
  });
});
