// The yarn row, which reads the project's yarn major first: classic (1) and
// modern (2 and later) share a name and a lockfile file name and little else.
// Corepack and `yarnPath` both pick the project's own yarn, so `yarn
// --version` run in the project is the version that wrote its lockfile.
//
// Classic's `yarn list --depth=1` is the hoisted tree: the root's packages at
// the top, and under each workspace package whatever it could not share with
// the root. Modern's `yarn info --all` lists each workspace's dependencies as
// descriptor and resolved locator, and every locator's version.

import { join } from "node:path";
import { dirOf, FindingSet, isRecord, parseJson } from "./common.ts";
import {
  addNpmAdvisory,
  addYarnAuditRecord,
  auditResult,
  declaresWorkspaces,
  detectProjects,
  listDeclared,
  manifestIn,
  NPM_MANAGER,
  parseJsonLines,
  type WorkspaceRef,
} from "./npm-family.ts";
import type { Manifest, Row, RowDeps, RowResult } from "./row.ts";

type Json = Record<string, unknown>;

/** The major of a `yarn --version`, or null for output that is not a version. */
export function yarnMajor(version: string): number | null {
  const major = /^(\d+)\./.exec(version.trim())?.[1];
  return major === undefined ? null : Number(major);
}

/** `name@1.2.3` or `@scope/name@npm:1.2.3` split at the `@` after the name. */
function splitAt(text: string): [string, string] | null {
  const at = text.indexOf("@", text.startsWith("@") ? 1 : 0);
  return at > 0 ? [text.slice(0, at), text.slice(at + 1)] : null;
}

/** Workspace manifests from classic's `yarn workspaces --json info`, which wraps its JSON in a log line. */
function classicWorkspaces(root: string, records: unknown[]): RowResult<string[]> {
  for (const record of records) {
    if (!isRecord(record) || record["type"] !== "log" || typeof record["data"] !== "string") {
      continue;
    }
    let info: unknown;
    try {
      info = JSON.parse(record["data"]);
    } catch {
      continue;
    }
    if (!isRecord(info)) continue;
    const paths: string[] = [];
    for (const workspace of Object.values(info)) {
      const location = isRecord(workspace) ? workspace["location"] : undefined;
      if (typeof location === "string") {
        paths.push(manifestIn(root === "" ? location : `${root}/${location}`));
      }
    }
    return { ok: true, value: paths };
  }
  return { ok: false, problem: "yarn workspaces info printed no workspaces" };
}

/** Workspace manifests from modern's `yarn workspaces list --json`, one per line. */
function modernWorkspaces(root: string, records: unknown[]): string[] {
  const paths: string[] = [];
  for (const record of records) {
    const location = isRecord(record) ? record["location"] : undefined;
    if (typeof location !== "string") continue;
    const dir = location === "." ? root : root === "" ? location : `${root}/${location}`;
    paths.push(manifestIn(dir));
  }
  return paths;
}

type Tree = { version: string; children: Map<string, string> };

/** Classic's hoisted tree from `yarn list --json --depth=1`. */
function classicTree(records: unknown[]): Map<string, Tree> | null {
  const tree = records.find((r) => isRecord(r) && r["type"] === "tree");
  const data = isRecord(tree) ? tree["data"] : undefined;
  const trees = isRecord(data) ? data["trees"] : undefined;
  if (!Array.isArray(trees)) return null;
  const top = new Map<string, Tree>();
  const named = (entry: unknown): [string, string] | null =>
    isRecord(entry) && typeof entry["name"] === "string" ? splitAt(entry["name"]) : null;
  for (const entry of trees) {
    const parsed = named(entry);
    if (parsed === null) continue;
    const children = new Map<string, string>();
    const nested = isRecord(entry) && Array.isArray(entry["children"]) ? entry["children"] : [];
    for (const nestedEntry of nested) {
      const nestedParsed = named(nestedEntry);
      if (nestedParsed !== null) children.set(nestedParsed[0], nestedParsed[1]);
    }
    top.set(parsed[0], { version: parsed[1], children });
  }
  return top;
}

/**
 * Modern's `yarn info --all --json`: each workspace's dependencies by declared
 * name, resolved through the locator's own `Version`, keyed by the
 * workspace's location relative to the project.
 */
function modernVersions(records: unknown[]): Map<string, Map<string, string>> {
  const versionOf = new Map<string, string>();
  for (const record of records) {
    if (!isRecord(record) || typeof record["value"] !== "string") continue;
    const version = isRecord(record["children"]) ? record["children"]["Version"] : undefined;
    if (typeof version === "string") versionOf.set(record["value"], version);
  }
  const byWorkspace = new Map<string, Map<string, string>>();
  for (const record of records) {
    if (!isRecord(record) || typeof record["value"] !== "string") continue;
    const locator = splitAt(record["value"]);
    if (locator === null || !locator[1].startsWith("workspace:")) continue;
    const children = isRecord(record["children"]) ? (record["children"] as Json) : {};
    const dependencies = Array.isArray(children["Dependencies"]) ? children["Dependencies"] : [];
    const byName = new Map<string, string>();
    for (const dependency of dependencies) {
      if (!isRecord(dependency)) continue;
      const { descriptor, locator: resolved } = dependency;
      if (typeof descriptor !== "string" || typeof resolved !== "string") continue;
      const name = splitAt(descriptor)?.[0];
      const version = versionOf.get(resolved);
      if (name !== undefined && version !== undefined) byName.set(name, version);
    }
    byWorkspace.set(locator[1].slice("workspace:".length), byName);
  }
  return byWorkspace;
}

/** A workspace's location as modern yarn writes it, relative to the project root. */
function locationIn(manifest: Manifest, workspace: WorkspaceRef): string {
  const root = dirOf(manifest.path);
  const dir = dirOf(workspace.path);
  if (dir === root) return ".";
  return root === "" ? dir : dir.slice(root.length + 1);
}

export function yarnRow(deps: RowDeps): Row {
  const run = (manifest: Manifest, args: string[]) =>
    deps.run("yarn", args, join(manifest.checkout, dirOf(manifest.path)));

  const major = async (manifest: Manifest): Promise<RowResult<number>> => {
    const version = await run(manifest, ["--version"]);
    if (!version.ok) return { ok: false, problem: version.problem };
    const parsed = yarnMajor(version.stdout);
    return parsed === null
      ? { ok: false, problem: `yarn --version printed ${JSON.stringify(version.stdout.trim())}` }
      : { ok: true, value: parsed };
  };

  return {
    name: "yarn",
    manager: NPM_MANAGER,
    system: "npm",
    ecosystem: "npm",

    detect: (checkout) =>
      detectProjects(deps, "yarn", checkout, async (root, version) => {
        const cwd = join(checkout, root);
        const parsed = yarnMajor(version);
        if (parsed === null) return { ok: false, problem: `yarn --version printed ${version}` };
        if (parsed === 1) {
          if (!declaresWorkspaces(checkout, root)) return { ok: true, value: [] };
          const info = parseJsonLines(
            await deps.run("yarn", ["workspaces", "--json", "info"], cwd),
          );
          return info.ok ? classicWorkspaces(root, info.value) : info;
        }
        const listed = parseJsonLines(
          await deps.run("yarn", ["workspaces", "list", "--json"], cwd),
        );
        return listed.ok ? { ok: true, value: modernWorkspaces(root, listed.value) } : listed;
      }),

    async list(manifest) {
      const version = await major(manifest);
      if (!version.ok) return version;
      if (version.value === 1) {
        const listed = parseJsonLines(await run(manifest, ["list", "--json", "--depth=1"]));
        if (!listed.ok) return listed;
        const tree = classicTree(listed.value);
        if (tree === null) return { ok: false, problem: "yarn list printed no tree" };
        return listDeclared(
          manifest,
          (workspace, name) => {
            const own =
              !workspace.root && workspace.name !== undefined
                ? tree.get(workspace.name)?.children.get(name)
                : undefined;
            return own ?? tree.get(name)?.version;
          },
          deps.log,
          "yarn",
        );
      }
      const info = parseJsonLines(await run(manifest, ["info", "--all", "--json"]));
      if (!info.ok) return info;
      const versions = modernVersions(info.value);
      return listDeclared(
        manifest,
        (workspace, name) => versions.get(locationIn(manifest, workspace))?.get(name),
        deps.log,
        "yarn",
      );
    },

    async audit(manifest) {
      const version = await major(manifest);
      if (!version.ok) return version;
      const set = new FindingSet();
      if (version.value === 1) {
        const audited = parseJsonLines(await run(manifest, ["audit", "--json"]));
        if (!audited.ok) return audited;
        for (const record of audited.value) {
          if (isRecord(record) && record["type"] === "auditAdvisory" && isRecord(record["data"])) {
            addNpmAdvisory(set, record["data"]["advisory"]);
          }
        }
        return auditResult(set, deps.log, "yarn");
      }
      const output = await run(manifest, ["npm", "audit", "--all", "--recursive", "--json"]);
      // Yarn 2 and 3 print one npm-style report; yarn 4 prints a record per advisory.
      const whole = parseJson(output, "yarn npm audit");
      if (whole.ok && isRecord(whole.value) && isRecord(whole.value["advisories"])) {
        for (const advisory of Object.values(whole.value["advisories"])) {
          addNpmAdvisory(set, advisory);
        }
        return auditResult(set, deps.log, "yarn");
      }
      const audited = parseJsonLines(output);
      if (!audited.ok) return audited;
      for (const record of audited.value) addYarnAuditRecord(set, record);
      if (output.ok && output.code !== 0 && set.findings.length === 0 && set.dropped === 0) {
        return {
          ok: false,
          problem: `yarn npm audit exited ${output.code}: ${output.stdout.trim().split("\n")[0]?.slice(0, 200)}`,
        };
      }
      return auditResult(set, deps.log, "yarn");
    },
  };
}
