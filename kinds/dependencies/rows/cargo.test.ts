// The Cargo row, replayed against output recorded from cargo 1.99.1 and
// cargo-audit 0.22.2 (fixtures/cargo-*.json): a virtual workspace of two
// members and a single crate. The resolve graph keeps only the members' full
// package records, and the audit drops advisory descriptions, which the row
// does not read. The manifests are JSON strings in the fixture rather than
// Cargo.toml files, so no dependency bot picks up their deliberately old crates.

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { cargoRow } from "./cargo.ts";
import type { Manifest, RowDeps, RunTool } from "./row.ts";

type Recorded = { cwd: string; command: string; args: string[]; code: number; stdout: string };
type Fixture = { files: Record<string, string>; runs: Recorded[] };

function writeFiles(files: Record<string, string>): string {
  const checkout = mkdtempSync(join(tmpdir(), "phoebe-cargo-"));
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
  const run: RunTool = async (command, args, cwd) => {
    const at = relative(checkout, cwd) || ".";
    const shown = `${at}$ ${command} ${args.join(" ")}`;
    calls.push(shown);
    const recorded = fixture.runs.find(
      (r) => r.cwd === at && r.command === command && r.args.join(" ") === args.join(" "),
    );
    if (recorded === undefined)
      return { ok: false, missing: false, problem: `unrecorded: ${shown}` };
    const stdout = recorded.stdout.split("<checkout>").join(checkout);
    return { ok: true, code: recorded.code, stdout };
  };
  const deps: RowDeps = { run, log: (line) => logged.push(line) };
  return { checkout, deps, calls, logged };
}

async function detectOne(deps: RowDeps, checkout: string): Promise<Manifest> {
  const manifests = await cargoRow(deps).detect(checkout);
  expect(manifests).toHaveLength(1);
  return manifests[0]!;
}

describe("cargo row", () => {
  test("lists each workspace member's crates.io dependencies at the locked version", async () => {
    const { checkout, deps, logged } = replay("cargo-workspace");
    const manifest = await detectOne(deps, checkout);
    expect(manifest).toEqual({
      checkout,
      path: "Cargo.toml",
      workspaces: ["Cargo.toml", "crates/app/Cargo.toml", "crates/util/Cargo.toml"],
    });
    const listed = await cargoRow(deps).list(manifest);
    const app = "crates/app/Cargo.toml";
    const util = "crates/util/Cargo.toml";
    expect(listed).toEqual({
      ok: true,
      value: [
        // Each member resolves its own itoa: `"1"` in app, `"0.4"` in util.
        { package: "itoa", current: "1.0.18", depType: "prod", workspace: app },
        // An optional dependency is still in [dependencies].
        { package: "log", current: "0.4.14", depType: "prod", workspace: app },
        { package: "regex", current: "1.5.4", depType: "prod", workspace: app },
        // `semver-crate = { package = "semver" }` lists the crate it renames.
        { package: "semver", current: "1.0.0", depType: "prod", workspace: app },
        // `smallvec = { workspace = true }` lists in the member that inherits it.
        { package: "smallvec", current: "1.6.0", depType: "prod", workspace: app },
        { package: "tempfile", current: "3.3.0", depType: "dev", workspace: app },
        { package: "cc", current: "1.0.73", depType: "prod", workspace: app },
        { package: "itoa", current: "0.4.8", depType: "prod", workspace: util },
        { package: "regex", current: "1.5.4", depType: "prod", workspace: util },
        { package: "smallvec", current: "1.6.0", depType: "prod", workspace: util },
        // From `[target.'cfg(unix)'.dependencies]`.
        { package: "libc", current: "0.2.150", depType: "prod", workspace: util },
      ],
    });
    // app's `util = { path = "../util" }` is a sibling, not a crates.io crate.
    expect(logged).toEqual([]);
  });

  test("audits the whole lockfile, rating each advisory by its CVSS vector", async () => {
    const { checkout, deps } = replay("cargo-workspace");
    const findings = await cargoRow(deps).audit!(await detectOne(deps, checkout));
    expect(findings).toEqual({
      ok: true,
      value: [
        {
          package: "regex",
          version: "1.5.4",
          advisory: { id: "RUSTSEC-2022-0013", severity: "high", fixedIn: "1.5.5" },
        },
        // Transitive, through tempfile, and with no CVSS vector.
        {
          package: "remove_dir_all",
          version: "0.5.3",
          advisory: { id: "RUSTSEC-2023-0018", severity: "moderate", fixedIn: "0.8.0" },
        },
        // Patched `>=0.6.14, <1.0.0` or `>=1.6.1`: the fix past 1.6.0 is 1.6.1.
        {
          package: "smallvec",
          version: "1.6.0",
          advisory: { id: "RUSTSEC-2021-0003", severity: "critical", fixedIn: "1.6.1" },
        },
      ],
    });
  });

  test("lists and audits a crate with no workspace", async () => {
    const { checkout, deps, calls } = replay("cargo-single");
    const row = cargoRow(deps);
    const manifest = await detectOne(deps, checkout);
    expect(manifest.workspaces).toEqual(["Cargo.toml"]);
    expect(await row.list(manifest)).toEqual({
      ok: true,
      value: [
        { package: "anyhow", current: "1.0.104", depType: "prod", workspace: "Cargo.toml" },
        { package: "time", current: "0.1.43", depType: "prod", workspace: "Cargo.toml" },
        { package: "itoa", current: "1.0.18", depType: "dev", workspace: "Cargo.toml" },
      ],
    });
    expect(await row.audit!(manifest)).toEqual({
      ok: true,
      value: [
        {
          package: "time",
          version: "0.1.43",
          advisory: { id: "RUSTSEC-2020-0071", severity: "moderate", fixedIn: "0.2.23" },
        },
      ],
    });
    expect(calls.slice(-3)).toEqual([
      ".$ cargo metadata --format-version 1 --no-deps",
      ".$ cargo metadata --format-version 1 --locked --all-features",
      ".$ cargo-audit audit --json",
    ]);
  });
});

describe("finding Cargo projects", () => {
  const metadata = (checkout: string, root: string, members: string[]) =>
    JSON.stringify({
      workspace_root: join(checkout, root),
      workspace_members: members.map((m) => `path+file://${join(checkout, m)}#0.1.0`),
      packages: members.map((m) => ({
        id: `path+file://${join(checkout, m)}#0.1.0`,
        manifest_path: join(checkout, m, "Cargo.toml"),
        dependencies: [],
      })),
    });

  test("a workspace root claims its members; a stray lock, target/ and a lockless crate claim nothing", async () => {
    const checkout = writeFiles({
      "Cargo.toml": "",
      "Cargo.lock": "",
      "crates/a/Cargo.toml": "",
      "crates/a/Cargo.lock": "",
      "target/package/x/Cargo.toml": "",
      "target/package/x/Cargo.lock": "",
      "tools/lockless/Cargo.toml": "",
    });
    const calls: string[] = [];
    const run: RunTool = async (command, args, cwd) => {
      const at = relative(checkout, cwd);
      calls.push(`${at || "."}$ ${command} ${args.join(" ")}`);
      if (args[0] === "--version") return { ok: true, code: 0, stdout: "cargo 1.99.1\n" };
      // Run in crates/a, cargo still finds the workspace above it.
      return { ok: true, code: 0, stdout: metadata(checkout, "", ["crates/a"]) };
    };
    const manifests = await cargoRow({ run, log: () => {} }).detect(checkout);
    expect(manifests).toEqual([
      { checkout, path: "Cargo.toml", workspaces: ["Cargo.toml", "crates/a/Cargo.toml"] },
    ]);
    expect(calls.filter((c) => c.includes("metadata"))).toEqual([
      ".$ cargo metadata --format-version 1 --no-deps",
      "crates/a$ cargo metadata --format-version 1 --no-deps",
    ]);
  });

  test("a missing cargo claims nothing and logs once", async () => {
    const checkout = writeFiles({
      "Cargo.toml": "",
      "Cargo.lock": "",
      "b/Cargo.toml": "",
      "b/Cargo.lock": "",
    });
    const logged: string[] = [];
    const run: RunTool = async (command) => ({
      ok: false,
      missing: true,
      problem: `${command} is not installed`,
    });
    expect(await cargoRow({ run, log: (l) => logged.push(l) }).detect(checkout)).toEqual([]);
    expect(logged).toEqual([
      "cargo row: cargo is not installed; 2 project(s) left to the agent fallback.",
    ]);
  });

  test("a lockfile behind its manifests fails the listing rather than being rewritten", async () => {
    const checkout = writeFiles({ "Cargo.toml": "", "Cargo.lock": "" });
    const run: RunTool = async (_command, args) =>
      args.includes("--locked")
        ? {
            ok: false,
            missing: false,
            problem:
              "cargo metadata --format-version 1 --locked --all-features exited 101: " +
              "error: the lock file needs to be updated but --locked was passed to prevent this",
          }
        : { ok: true, code: 0, stdout: metadata(checkout, "", [""]) };
    const manifest = { checkout, path: "Cargo.toml", workspaces: ["Cargo.toml"] };
    const result = await cargoRow({ run, log: () => {} }).list(manifest);
    expect(result).toEqual({
      ok: false,
      problem: expect.stringMatching(/--locked was passed to prevent this$/),
    });
  });

  test("with no cargo-audit the audit is empty, said once, and OSV answers alone", async () => {
    const logged: string[] = [];
    const run: RunTool = async (command) => ({
      ok: false,
      missing: true,
      problem: `${command} is not installed`,
    });
    const row = cargoRow({ run, log: (l) => logged.push(l) });
    const manifest = { checkout: tmpdir(), path: "Cargo.toml", workspaces: ["Cargo.toml"] };
    expect(await row.audit!(manifest)).toEqual({ ok: true, value: [] });
    expect(await row.audit!(manifest)).toEqual({ ok: true, value: [] });
    expect(logged).toEqual(["cargo row: cargo-audit is not installed; OSV alone."]);
  });
});
