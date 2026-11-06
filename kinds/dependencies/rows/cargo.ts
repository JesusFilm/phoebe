// The Cargo row. A project is a workspace root, a directory holding Cargo.toml
// and Cargo.lock, and it covers every member. `cargo metadata --no-deps` names
// the members and what each declares; a second `cargo metadata`, with the
// resolve graph, says which version Cargo.lock holds for each declaration.
//
// The resolve run passes `--locked`, so a lockfile that is behind its
// manifests fails the listing rather than being rewritten in the read-only
// checkout, and `--all-features`, so an optional dependency resolves whether
// or not a default feature turns it on. It downloads the crates it reads into
// CARGO_HOME, not into the checkout.

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { DepType } from "../candidate.ts";
import { cvss3BaseScore, scoreSeverity, UNRATED_SEVERITY } from "../registry/osv.ts";
import {
  checkoutPath,
  detectRoots,
  dirOf,
  findDirs,
  FindingSet,
  fixedFromPatched,
  isRecord,
  logUnresolved,
  parseJson,
  str,
  type Json,
} from "./common.ts";
import type { ListedDependency, Row, RowDeps, RowResult } from "./row.ts";

/** How crates.io names itself in `cargo metadata`, over git and over the sparse index. */
const CRATES_IO = new Set([
  "registry+https://github.com/rust-lang/crates.io-index",
  "sparse+https://index.crates.io/",
]);

/** Cargo's dependency kinds by section. A build dependency ships in the build. */
const DEP_TYPES: Record<string, DepType> = { normal: "prod", build: "prod", dev: "dev" };

function kindOf(value: unknown): string {
  return typeof value === "string" ? value : "normal";
}

function records(value: unknown): Json[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

type Metadata = { root: string; members: Json[]; packages: Map<string, Json>; nodes: Json[] };

/** The parts of `cargo metadata` the row reads, with paths relative to the checkout. */
function readMetadata(checkout: string, value: unknown): RowResult<Metadata> {
  if (!isRecord(value) || typeof value["workspace_root"] !== "string") {
    return { ok: false, problem: "cargo metadata printed no workspace_root" };
  }
  const root = checkoutPath(checkout, value["workspace_root"]);
  if (root === null) return { ok: false, problem: "the workspace root is outside the checkout" };
  const packages = new Map(
    records(value["packages"]).flatMap((p) => (typeof p["id"] === "string" ? [[p["id"], p]] : [])),
  );
  const ids = Array.isArray(value["workspace_members"]) ? value["workspace_members"] : [];
  const members = ids.flatMap((id) => {
    const member = typeof id === "string" ? packages.get(id) : undefined;
    return member === undefined ? [] : [member];
  });
  const resolve = isRecord(value["resolve"]) ? value["resolve"] : {};
  return { ok: true, value: { root, members, packages, nodes: records(resolve["nodes"]) } };
}

function manifestOf(checkout: string, member: Json): string | null {
  const path = str(member, "manifest_path");
  return path === undefined ? null : checkoutPath(checkout, path);
}

/** Each member's resolved crates.io packages, by manifest path, then by name and kind. */
function resolvedVersions(checkout: string, meta: Metadata): Map<string, Map<string, string>> {
  const byManifest = new Map<string, Map<string, string>>();
  for (const member of meta.members) {
    const path = manifestOf(checkout, member);
    const node = meta.nodes.find((n) => n["id"] === member["id"]);
    if (path === null || node === undefined) continue;
    const versions = new Map<string, string>();
    for (const dep of records(node["deps"])) {
      const pkg = typeof dep["pkg"] === "string" ? meta.packages.get(dep["pkg"]) : undefined;
      const name = pkg === undefined ? undefined : str(pkg, "name");
      const version = pkg === undefined ? undefined : str(pkg, "version");
      if (name === undefined || version === undefined) continue;
      for (const kind of records(dep["dep_kinds"])) {
        versions.set(JSON.stringify([name, kindOf(kind["kind"])]), version);
      }
    }
    byManifest.set(path, versions);
  }
  return byManifest;
}

const NO_DEPS = ["metadata", "--format-version", "1", "--no-deps"];
const RESOLVED = ["metadata", "--format-version", "1", "--locked", "--all-features"];

export function cargoRow(deps: RowDeps): Row {
  let auditMissing = false;

  const metadata = async (checkout: string, root: string, args: string[]) => {
    const parsed = parseJson(await deps.run("cargo", args, join(checkout, root)), "cargo metadata");
    return parsed.ok ? readMetadata(checkout, parsed.value) : parsed;
  };

  return {
    name: "cargo",
    manager: "cargo",
    system: "cargo",
    ecosystem: "crates.io",

    async detect(checkout) {
      const roots = findDirs(
        checkout,
        (dir) => existsSync(join(dir, "Cargo.toml")) && existsSync(join(dir, "Cargo.lock")),
        ["target"],
      );
      return detectRoots(deps, "cargo", checkout, roots, {
        manifest: "Cargo.toml",
        probe: (root) => deps.run("cargo", ["--version"], join(checkout, root)),
        async workspacesOf(root) {
          const meta = await metadata(checkout, root, NO_DEPS);
          if (!meta.ok) return meta;
          // A member holding a Cargo.lock of its own still resolves in its workspace.
          if (meta.value.root !== root) return { ok: true, value: null };
          const paths = meta.value.members.flatMap((m) => manifestOf(checkout, m) ?? []);
          return { ok: true, value: paths };
        },
      });
    },

    async list(manifest) {
      const root = dirOf(manifest.path);
      const declared = await metadata(manifest.checkout, root, NO_DEPS);
      if (!declared.ok) return declared;
      const resolved = await metadata(manifest.checkout, root, RESOLVED);
      if (!resolved.ok) return resolved;
      const versions = resolvedVersions(manifest.checkout, resolved.value);
      const listed = new Map<string, ListedDependency>();
      const unresolved: string[] = [];
      for (const member of declared.value.members) {
        const path = manifestOf(manifest.checkout, member);
        if (path === null) continue;
        for (const dep of records(member["dependencies"])) {
          const name = str(dep, "name");
          const source = str(dep, "source");
          // Path, git and other registries' crates are not on crates.io.
          if (name === undefined || source === undefined || !CRATES_IO.has(source)) continue;
          const kind = kindOf(dep["kind"]);
          const depType = DEP_TYPES[kind] ?? "prod";
          const current = versions.get(path)?.get(JSON.stringify([name, kind]));
          if (current === undefined) {
            unresolved.push(`${path}: ${name}`);
            continue;
          }
          // The same crate under two targets' tables is one dependency.
          const entry = { package: name, current, depType, workspace: path };
          listed.set(JSON.stringify(entry), entry);
        }
      }
      logUnresolved(deps.log, "cargo", manifest.path, unresolved);
      return { ok: true, value: [...listed.values()] };
    },

    async audit(manifest) {
      // `cargo audit` with no cargo-audit installed is a cargo error, not a missing command.
      const output = await deps.run(
        "cargo-audit",
        ["audit", "--json"],
        join(manifest.checkout, dirOf(manifest.path)),
      );
      if (!output.ok && output.missing) {
        if (!auditMissing) deps.log("cargo row: cargo-audit is not installed; OSV alone.");
        auditMissing = true;
        return { ok: true, value: [] };
      }
      const audited = parseJson(output, "cargo audit");
      if (!audited.ok) return audited;
      const found = isRecord(audited.value) ? audited.value["vulnerabilities"] : undefined;
      if (!isRecord(found)) return { ok: false, problem: "cargo audit printed no vulnerabilities" };
      const set = new FindingSet();
      for (const entry of records(found["list"])) addRustsecFinding(set, entry);
      if (set.dropped > 0) {
        deps.log(`cargo row: dropped ${set.dropped} audit record(s) with no id or version.`);
      }
      return { ok: true, value: set.findings };
    },
  };
}

/**
 * One entry of `cargo audit --json`'s vulnerability list: a RustSec advisory
 * against one locked package. `patched` holds Cargo requirements, any of
 * which fixes it; the severity is the CVSS vector's, when there is one.
 */
export function addRustsecFinding(set: FindingSet, entry: Json): void {
  const advisory = isRecord(entry["advisory"]) ? entry["advisory"] : {};
  const pkg = isRecord(entry["package"]) ? entry["package"] : {};
  const id = str(advisory, "id");
  const name = str(pkg, "name");
  const version = str(pkg, "version");
  if (id === undefined || name === undefined || version === undefined) {
    set.dropped += 1;
    return;
  }
  const versions = isRecord(entry["versions"]) ? entry["versions"] : {};
  const patched = Array.isArray(versions["patched"])
    ? versions["patched"].filter((r): r is string => typeof r === "string")
    : [];
  const cvss = str(advisory, "cvss");
  const score = cvss === undefined ? null : cvss3BaseScore(cvss);
  set.add(name, version, {
    id,
    severity: score === null ? UNRATED_SEVERITY : scoreSeverity(score),
    fixedIn: patched.length === 0 ? null : fixedFromPatched(patched.join(" || "), version),
  });
}
