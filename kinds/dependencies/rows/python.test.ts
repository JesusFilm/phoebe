// The Python rows, replayed against output recorded from uv 0.13.7, CPython
// 3.13, poetry and pip-audit 2.10.1 (fixtures/{uv,poetry,pip}-*.json): a uv
// workspace of two packages, a poetry project, and a directory of requirements
// files with no pyproject.toml. The fixtures were recorded by running the rows
// themselves, so `<toml-script>` stands for the TOML reader, `<python>` for the
// interpreter uv found, and `<requirements>` for the pin file the audit wrote,
// whose text the run keeps. pip-audit's advisory descriptions are dropped.

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import {
  addPipAuditReport,
  pinnedVersion,
  parseRequirement,
  poetryDeclared,
  TOML_SCRIPT,
} from "./python-family.ts";
import { pipRow, poetryRow, readRequirements, uvRow } from "./python.ts";
import { FindingSet } from "./common.ts";
import type { Manifest, Row, RowDeps, RunTool } from "./row.ts";

type Recorded = {
  cwd: string;
  command: string;
  args: string[];
  code: number;
  stdout: string;
  requirements?: string;
};
type Fixture = { files: Record<string, string>; runs: Recorded[] };

function writeFiles(files: Record<string, string>): string {
  const checkout = mkdtempSync(join(tmpdir(), "phoebe-python-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(checkout, path)), { recursive: true });
    writeFileSync(join(checkout, path), text);
  }
  return checkout;
}

function replay(name: string) {
  const fixture = JSON.parse(
    readFileSync(join(import.meta.dirname, "fixtures", `${name}.json`), "utf8"),
  ) as Fixture;
  const checkout = writeFiles(fixture.files);
  const calls: string[] = [];
  const logged: string[] = [];
  const audited: string[] = [];
  const run: RunTool = async (command, args, cwd) => {
    const at = relative(checkout, cwd) || ".";
    const shown = args.map((arg) => {
      if (arg === TOML_SCRIPT) return "<toml-script>";
      if (!arg.includes("phoebe-pip-audit-")) return arg;
      audited.push(readFileSync(arg, "utf8"));
      return "<requirements>";
    });
    const line = `${at}$ ${command} ${shown.join(" ")}`;
    calls.push(line);
    const recorded = fixture.runs.find(
      (r) => r.cwd === at && r.command === command && r.args.join(" ") === shown.join(" "),
    );
    if (recorded === undefined)
      return { ok: false, missing: false, problem: `unrecorded: ${line}` };
    if (recorded.requirements !== undefined) expect(audited.at(-1)).toBe(recorded.requirements);
    return {
      ok: true,
      code: recorded.code,
      stdout: recorded.stdout.split("<checkout>").join(checkout),
    };
  };
  const deps: RowDeps = { run, log: (l) => logged.push(l) };
  return { checkout, deps, calls, logged, audited };
}

async function detectOne(row: Row, checkout: string): Promise<Manifest> {
  const manifests = await row.detect(checkout);
  expect(manifests).toHaveLength(1);
  return manifests[0]!;
}

describe("uv row", () => {
  test("lists each workspace member's declared dependencies at the uv.lock version", async () => {
    const { checkout, deps, logged } = replay("uv-workspace");
    const row = uvRow(deps);
    const manifest = await detectOne(row, checkout);
    expect(manifest).toEqual({
      checkout,
      path: "pyproject.toml",
      workspaces: ["pyproject.toml", "packages/pkg-b/pyproject.toml"],
    });
    expect(await row.list(manifest)).toEqual({
      ok: true,
      value: [
        { package: "requests", current: "2.31.0", depType: "prod", workspace: "pyproject.toml" },
        // `PyYAML==6.0` in the `yaml` extra, under its PEP 503 name.
        { package: "pyyaml", current: "6.0", depType: "optional", workspace: "pyproject.toml" },
        { package: "pytest", current: "7.4.0", depType: "dev", workspace: "pyproject.toml" },
        {
          package: "jinja2",
          current: "3.1.2",
          depType: "prod",
          workspace: "packages/pkg-b/pyproject.toml",
        },
        // `urllib3<2` names a range; the lockfile has the version.
        {
          package: "urllib3",
          current: "1.26.20",
          depType: "prod",
          workspace: "packages/pkg-b/pyproject.toml",
        },
      ],
    });
    // The root's `pkg-b` is the sibling member, which uv.lock has as editable, not from PyPI.
    expect(logged).toEqual([]);
  });

  test("audits every locked PyPI package and none of the members", async () => {
    const { checkout, deps, audited } = replay("uv-workspace");
    const row = uvRow(deps);
    const result = await row.audit!(await detectOne(row, checkout));
    if (!result.ok) throw new Error(result.problem);
    expect(audited[0]).not.toMatch(/^(uvws|pkg-b)==/m);
    expect(audited[0]).toMatch(/^markupsafe==3\.0\.4$/m);
    expect(result.value).toContainEqual({
      package: "jinja2",
      version: "3.1.2",
      advisory: { id: "PYSEC-2026-1473", severity: "moderate", fixedIn: "3.1.3" },
    });
    // pip-audit printed PYSEC-2026-1873 twice; it is one finding.
    expect(result.value.filter((f) => f.advisory.id === "PYSEC-2026-1873")).toHaveLength(1);
  });
});

describe("poetry row", () => {
  test("lists main, optional and group dependencies from poetry.lock", async () => {
    const { checkout, deps, logged } = replay("poetry-single");
    const row = poetryRow(deps);
    const manifest = await detectOne(row, checkout);
    expect(manifest.workspaces).toEqual(["pyproject.toml"]);
    expect(await row.list(manifest)).toEqual({
      ok: true,
      value: [
        // `Django = "4.2.0"`, which PyPI and the lockfile call 4.2.
        { package: "django", current: "4.2", depType: "prod", workspace: "pyproject.toml" },
        {
          package: "requests",
          current: "2.31.0",
          depType: "optional",
          workspace: "pyproject.toml",
        },
        { package: "pytest", current: "7.4.0", depType: "dev", workspace: "pyproject.toml" },
        // The `docs` group is development too.
        { package: "jinja2", current: "3.1.2", depType: "dev", workspace: "pyproject.toml" },
      ],
    });
    expect(logged).toEqual([]);
  });

  test("the fix is the lowest fixed version past the installed one", async () => {
    const { checkout, deps } = replay("poetry-single");
    const row = poetryRow(deps);
    const result = await row.audit!(await detectOne(row, checkout));
    // pip-audit lists 3.2.19, 4.1.9 and 4.2.1 for this one.
    expect(result.ok && result.value).toContainEqual({
      package: "django",
      version: "4.2",
      advisory: { id: "PYSEC-2023-61", severity: "moderate", fixedIn: "4.2.1" },
    });
  });
});

describe("pip row", () => {
  test("lists a requirements-only project's pins and logs the requirements that pin nothing", async () => {
    const { checkout, deps, calls, logged } = replay("pip-requirements");
    const row = pipRow(deps);
    const manifest = await detectOne(row, checkout);
    expect(manifest).toEqual({
      checkout,
      path: "requirements.txt",
      workspaces: ["requirements.txt", "requirements-dev.txt"],
    });
    expect(await row.list(manifest)).toEqual({
      ok: true,
      value: [
        { package: "flask", current: "2.2.0", depType: "prod", workspace: "requirements.txt" },
        { package: "pyyaml", current: "6.0", depType: "prod", workspace: "requirements.txt" },
        // Pinned on a line a backslash continues with its hash.
        { package: "urllib3", current: "1.26.5", depType: "prod", workspace: "requirements.txt" },
        { package: "pytest", current: "7.4.0", depType: "prod", workspace: "requirements-dev.txt" },
      ],
    });
    expect(logged).toEqual([
      "pip row: 2 declared dependencies with no resolved version under requirements.txt " +
        "(requirements.txt: requests, requirements-dev.txt: coverage).",
    ]);
    // Listing a requirements file needs no tool at all.
    expect(calls).toEqual([]);
  });

  test("audits the pins of every requirements file in the project", async () => {
    const { checkout, deps, audited } = replay("pip-requirements");
    const row = pipRow(deps);
    const result = await row.audit!(await detectOne(row, checkout));
    expect(audited).toEqual(["flask==2.2.0\npytest==7.4.0\npyyaml==6.0\nurllib3==1.26.5\n"]);
    expect(result.ok && result.value).toContainEqual({
      package: "flask",
      version: "2.2.0",
      advisory: { id: "PYSEC-2023-62", severity: "moderate", fixedIn: "2.2.5" },
    });
  });
});

describe("missing tools", () => {
  const files = {
    "pyproject.toml": "",
    "uv.lock": "",
    "legacy/pyproject.toml": "",
    "legacy/poetry.lock": "",
    "scripts/requirements.txt": "black==23.1.0\n",
  };
  const missing: RunTool = async (command) => ({
    ok: false,
    missing: true,
    problem: `${command} is not installed`,
  });

  test("with neither uv nor python3 the lockfile rows claim nothing, each saying so once", async () => {
    const checkout = writeFiles(files);
    const logged: string[] = [];
    const deps = { run: missing, log: (l: string) => logged.push(l) };
    expect(await uvRow(deps).detect(checkout)).toEqual([]);
    expect(await poetryRow(deps).detect(checkout)).toEqual([]);
    expect(logged).toEqual([
      "uv row: python3 is not installed; 1 project(s) left to the agent fallback.",
      "poetry row: python3 is not installed; 1 project(s) left to the agent fallback.",
    ]);
    // Pins need no tool to read.
    expect((await pipRow(deps).detect(checkout)).map((m) => m.path)).toEqual([
      "scripts/requirements.txt",
    ]);
  });

  test("without uv, python3 reads the TOML", async () => {
    const checkout = writeFiles(files);
    const calls: string[] = [];
    const run: RunTool = async (command, args) => {
      calls.push(command);
      if (command === "uv") return missing(command, args, checkout);
      if (args[0] === "--version") return { ok: true, code: 0, stdout: "Python 3.12.3\n" };
      return { ok: true, code: 0, stdout: JSON.stringify({ "uv.lock": { ok: { package: [] } } }) };
    };
    const manifests = await uvRow({ run, log: () => {} }).detect(checkout);
    expect(manifests.map((m) => m.path)).toEqual(["pyproject.toml"]);
    expect(calls).toEqual(["uv", "python3", "python3"]);
  });

  test("with no pip-audit the audit is empty, said once, and OSV answers alone", async () => {
    const checkout = writeFiles(files);
    const logged: string[] = [];
    const row = pipRow({ run: missing, log: (l) => logged.push(l) });
    const manifest = await detectOne(row, checkout);
    expect(await row.audit!(manifest)).toEqual({ ok: true, value: [] });
    expect(await row.audit!(manifest)).toEqual({ ok: true, value: [] });
    expect(logged).toEqual(["pip row: pip-audit is not installed; OSV alone."]);
  });

  test("a TOML file the interpreter cannot read fails the listing", async () => {
    const checkout = writeFiles({ "pyproject.toml": "", "uv.lock": "" });
    const run: RunTool = async (command) =>
      command === "uv"
        ? { ok: true, code: 0, stdout: "/usr/bin/python3\n" }
        : {
            ok: true,
            code: 0,
            stdout: JSON.stringify({
              "pyproject.toml": { error: "Invalid value (at line 3, column 9)" },
              "uv.lock": { ok: { package: [] } },
            }),
          };
    const manifest = { checkout, path: "pyproject.toml", workspaces: ["pyproject.toml"] };
    expect(await uvRow({ run, log: () => {} }).list(manifest)).toEqual({
      ok: false,
      problem: "pyproject.toml could not be read (Invalid value (at line 3, column 9))",
    });
  });
});

describe("reading requirements", () => {
  test("pins are `==` and `===` alone; ranges, wildcards and URLs pin nothing", () => {
    expect(
      readRequirements(
        [
          "# a comment",
          "--index-url https://example.test/simple",
          "-r base.txt",
          "-e .",
          "./local/pkg",
          "https://example.test/pkg.whl",
          "Django==4.2.1 ; python_version >= '3.10'  # trailing",
          "attrs===23.1.0",
          "numpy==1.26.*",
          "six>=1.16,<2",
          "cryptography==41.0.0 \\",
          "    --hash=sha256:aaaa \\",
          "    --hash=sha256:bbbb",
          "pkg @ https://example.test/pkg.tar.gz",
        ].join("\n"),
      ),
    ).toEqual({
      pins: [
        { name: "Django", version: "4.2.1" },
        { name: "attrs", version: "23.1.0" },
        { name: "cryptography", version: "41.0.0" },
      ],
      unpinned: ["numpy", "six"],
    });
  });

  test("a requirement's name, extras dropped, and none for a direct URL", () => {
    expect(parseRequirement("requests[socks, security] >= 2.28")).toEqual({
      name: "requests",
      rest: ">= 2.28",
    });
    expect(parseRequirement("pkg @ git+https://example.test/pkg")).toBeNull();
    expect(pinnedVersion("== 1.2.3")).toBe("1.2.3");
    expect(pinnedVersion("==1.2.3,<2")).toBeNull();
  });

  test("poetry declarations no registry serves are left out, and so is python", () => {
    expect(
      poetryDeclared({
        tool: {
          poetry: {
            dependencies: {
              python: "^3.11",
              local: { path: "../local" },
              forked: { git: "https://example.test/forked.git" },
              split: [
                { version: "1.0", python: "<3.12" },
                { version: "2.0", python: ">=3.12" },
              ],
            },
            "dev-dependencies": { black: "^23" },
          },
        },
      }),
    ).toEqual([
      { name: "split", depType: "prod" },
      { name: "black", depType: "dev" },
    ]);
  });
});

describe("pip-audit report", () => {
  test("a package pip-audit skipped is named with its reason, not read as clean", () => {
    const set = new FindingSet();
    const skipped: string[] = [];
    const report = {
      dependencies: [{ name: "private-pkg", version: "1.0", skip_reason: "not on PyPI" }],
    };
    expect(addPipAuditReport(set, report, skipped)).toBe(true);
    expect(set.findings).toEqual([]);
    expect(skipped).toEqual(["private-pkg: not on PyPI"]);
  });
});
