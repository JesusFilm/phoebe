// The npm row. Every command runs with `--package-lock-only`, so npm reads the
// lockfile rather than a `node_modules` the read-only checkout does not have.
// `npm ls --depth 0` prints the root's dependencies at the top and each
// workspace package's under that package's own entry.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  addNpmAuditReport,
  auditResult,
  declaresWorkspaces,
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
import type { Manifest, Row, RowDeps } from "./row.ts";

type Json = Record<string, unknown>;

function child(record: unknown, key: string): Json | undefined {
  const value = isRecord(record) ? record[key] : undefined;
  return isRecord(value) ? value : undefined;
}

/** The lockfile's `packages` map, location to entry, for the audit's versions. */
function lockPackages(dir: string): Json | null {
  for (const file of ["npm-shrinkwrap.json", "package-lock.json"]) {
    const path = join(dir, file);
    if (!existsSync(path)) continue;
    try {
      return child(JSON.parse(readFileSync(path, "utf8")) as unknown, "packages") ?? null;
    } catch {
      return null;
    }
  }
  return null;
}

export function npmRow(deps: RowDeps): Row {
  const run = (manifest: Manifest, args: string[]) =>
    deps.run("npm", args, join(manifest.checkout, dirOf(manifest.path)));

  return {
    name: "npm",
    manager: NPM_MANAGER,
    system: "npm",
    ecosystem: "npm",

    detect: (checkout) =>
      detectProjects(deps, "npm", checkout, async (root) => {
        if (!declaresWorkspaces(checkout, root)) return { ok: true, value: [] };
        const queried = parseJson(
          await deps.run(
            "npm",
            ["query", ".workspace", "--package-lock-only"],
            join(checkout, root),
          ),
          "npm query",
        );
        if (!queried.ok) return queried;
        if (!Array.isArray(queried.value)) {
          return {
            ok: false,
            problem: reportedError(queried.value) ?? "npm query did not print an array",
          };
        }
        const paths: string[] = [];
        for (const workspace of queried.value) {
          const location = isRecord(workspace) ? workspace["location"] : undefined;
          if (typeof location === "string") {
            paths.push(manifestIn(root === "" ? location : `${root}/${location}`));
          }
        }
        return { ok: true, value: paths };
      }),

    async list(manifest) {
      const listed = parseJson(
        await run(manifest, ["ls", "--json", "--depth", "0", "--package-lock-only"]),
        "npm ls",
      );
      if (!listed.ok) return listed;
      const error = reportedError(listed.value);
      const top = child(listed.value, "dependencies");
      if (top === undefined && error !== null) return { ok: false, problem: error };
      if (error !== null)
        deps.log(`npm row: npm ls reported tree problems (${error}); listing what resolved.`);
      return listDeclared(
        manifest,
        (workspace, name) => {
          const owner = workspace.root
            ? (top ?? {})
            : workspace.name !== undefined
              ? child((top ?? {})[workspace.name], "dependencies")
              : undefined;
          const version = owner === undefined ? undefined : child(owner, name)?.["version"];
          return typeof version === "string" ? version : undefined;
        },
        deps.log,
        "npm",
      );
    },

    async audit(manifest) {
      const audited = parseJson(
        await run(manifest, ["audit", "--json", "--package-lock-only"]),
        "npm audit",
      );
      if (!audited.ok) return audited;
      const error = reportedError(audited.value);
      if (error !== null) return { ok: false, problem: error };
      const vulnerabilities = child(audited.value, "vulnerabilities");
      if (vulnerabilities === undefined) {
        return { ok: false, problem: "npm audit printed no vulnerabilities" };
      }
      const packages = lockPackages(join(manifest.checkout, dirOf(manifest.path)));
      if (packages === null) return { ok: false, problem: "the npm lockfile has no packages" };
      const set = new FindingSet();
      addNpmAuditReport(set, vulnerabilities, packages);
      return auditResult(set, deps.log, "npm");
    },
  };
}
