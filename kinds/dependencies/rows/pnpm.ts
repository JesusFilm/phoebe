// The pnpm row. `pnpm list --recursive` answers for every workspace package at
// once, keyed by its directory, and pnpm 11 and later read it straight from
// the lockfile, so the read-only checkout needs no install.

import { join } from "node:path";
import {
  addNpmAdvisory,
  auditResult,
  checkoutPath,
  detectProjects,
  dirOf,
  FindingSet,
  isRecord,
  listDeclared,
  manifestIn,
  NPM_MANAGER,
  parseJson,
  reportedError,
} from "./npm-family.ts";
import type { Manifest, Row, RowDeps, RowResult } from "./row.ts";

const LIST_SECTIONS = ["dependencies", "devDependencies", "optionalDependencies"] as const;

/** The workspace packages `pnpm list --depth -1` names, as manifest paths. */
function projectManifests(checkout: string, value: unknown): RowResult<string[]> {
  const error = reportedError(value);
  if (error !== null) return { ok: false, problem: error };
  if (!Array.isArray(value)) return { ok: false, problem: "pnpm list did not print an array" };
  const paths: string[] = [];
  for (const project of value) {
    const dir = isRecord(project) && typeof project["path"] === "string" ? project["path"] : null;
    const rel = dir === null ? null : checkoutPath(checkout, dir);
    if (rel !== null) paths.push(manifestIn(rel));
  }
  return { ok: true, value: paths };
}

export function pnpmRow(deps: RowDeps): Row {
  const run = (manifest: Manifest, args: string[]) =>
    deps.run("pnpm", args, join(manifest.checkout, dirOf(manifest.path)));

  return {
    name: "pnpm",
    manager: NPM_MANAGER,
    system: "npm",
    ecosystem: "npm",

    detect: (checkout) =>
      detectProjects(deps, "pnpm", checkout, async (root) => {
        const listed = parseJson(
          await deps.run(
            "pnpm",
            ["list", "--json", "--depth", "-1", "--recursive"],
            join(checkout, root),
          ),
          "pnpm list",
        );
        return listed.ok ? projectManifests(checkout, listed.value) : listed;
      }),

    async list(manifest) {
      const listed = parseJson(
        await run(manifest, ["list", "--json", "--depth", "0", "--recursive"]),
        "pnpm list",
      );
      if (!listed.ok) return listed;
      const error = reportedError(listed.value);
      if (error !== null) return { ok: false, problem: error };
      if (!Array.isArray(listed.value)) {
        return { ok: false, problem: "pnpm list did not print an array" };
      }
      const versions = new Map<string, Map<string, string>>();
      for (const project of listed.value) {
        if (!isRecord(project) || typeof project["path"] !== "string") continue;
        const rel = checkoutPath(manifest.checkout, project["path"]);
        if (rel === null) continue;
        const byName = new Map<string, string>();
        for (const section of LIST_SECTIONS) {
          const entries = project[section];
          if (!isRecord(entries)) continue;
          for (const [name, entry] of Object.entries(entries)) {
            if (isRecord(entry) && typeof entry["version"] === "string") {
              byName.set(name, entry["version"]);
            }
          }
        }
        versions.set(manifestIn(rel), byName);
      }
      return listDeclared(
        manifest,
        (workspace, name) => versions.get(workspace.path)?.get(name),
        deps.log,
        "pnpm",
      );
    },

    async audit(manifest) {
      const audited = parseJson(await run(manifest, ["audit", "--json"]), "pnpm audit");
      if (!audited.ok) return audited;
      const error = reportedError(audited.value);
      if (error !== null) return { ok: false, problem: error };
      const advisories = isRecord(audited.value) ? audited.value["advisories"] : undefined;
      if (!isRecord(advisories)) return { ok: false, problem: "pnpm audit printed no advisories" };
      const set = new FindingSet();
      for (const advisory of Object.values(advisories)) addNpmAdvisory(set, advisory);
      return auditResult(set, deps.log, "pnpm");
    },
  };
}
