// The native source's rows (ADR 0003): one row per package manager, each
// listing a project's direct dependencies with that manager's own tooling. A
// row never asks what is newer. The native source takes what a row lists to
// deps.dev for newer versions and publish dates and to OSV for advisories, and
// unions the manager's own audit, where a row has one, into OSV's answer.
//
// A row whose tool is missing claims nothing, so its manifests fall to the
// agent fallback rather than going unlisted.

import { byText, type Advisory, type DepType } from "../candidate.ts";
import type { DepsDevSystem } from "../registry/deps-dev.ts";
import type { OsvEcosystem } from "../registry/osv.ts";

/** One project a row claimed: a root manifest and the workspace packages it covers. */
export type Manifest = {
  /** The checkout's absolute path; every other path here is relative to it. */
  checkout: string;
  /** The project's root manifest: `package.json`, `tools/web/Cargo.toml`, `requirements.txt`. */
  path: string;
  /**
   * Every manifest `list` reports dependencies for, root first: the workspace
   * packages, or the root alone in a project without workspaces. These are what
   * the agent fallback is told to skip.
   */
  workspaces: readonly string[];
};

/** One direct dependency of one workspace package, as installed. */
export type ListedDependency = {
  /** The registry name, which for an alias is the package it points at. */
  package: string;
  /** The resolved version the lockfile holds, or a requirements file's pin. */
  current: string;
  depType: DepType;
  /** The declaring manifest's path, relative to the checkout. */
  workspace: string;
};

/** One advisory the manager's audit reported against an installed version. */
export type AuditFinding = {
  package: string;
  version: string;
  advisory: Advisory;
};

export type RowResult<T> = { ok: true; value: T } | { ok: false; problem: string };

export type Row = {
  /** The row's name in log lines: `pnpm`, `cargo`, `uv`, `pip`. */
  name: string;
  /**
   * The candidate's `manager`. Renovate's word for the ecosystem, so a native
   * candidate and a Renovate one for the same bump merge.
   */
  manager: string;
  /** Where deps.dev keeps this ecosystem's versions. */
  system: DepsDevSystem;
  /** Where OSV keeps this ecosystem's advisories. */
  ecosystem: OsvEcosystem;
  /** The projects in the checkout this row lists. Empty when its tool is missing. */
  detect(checkout: string): Promise<Manifest[]>;
  list(manifest: Manifest): Promise<RowResult<ListedDependency[]>>;
  /** The manager's own audit, over the whole project including transitive packages. */
  audit?(manifest: Manifest): Promise<RowResult<AuditFinding[]>>;
};

/** What a row needs from its caller: a way to run the tool, and a log. */
export type RowDeps = {
  run: RunTool;
  log: (line: string) => void;
};

/**
 * The tool's stdout whatever it exited with: an audit exits non-zero when it
 * finds something, and `npm ls` when the tree has a problem, and both still
 * print the JSON. `missing` is a tool that could not be started at all.
 */
export type ToolOutput =
  | { ok: true; code: number; stdout: string }
  | { ok: false; missing: boolean; problem: string };

export type RunTool = (
  command: string,
  args: readonly string[],
  cwd: string,
) => Promise<ToolOutput>;

/**
 * Advisories for one package version from several sources, one per id, by id. The
 * first list wins an id it has, so the caller passes OSV first and the audit
 * only adds what OSV did not know.
 */
export function unionAdvisories(lists: readonly (readonly Advisory[])[]): Advisory[] {
  const byId = new Map<string, Advisory>();
  for (const list of lists) {
    for (const advisory of list) {
      if (!byId.has(advisory.id)) byId.set(advisory.id, advisory);
    }
  }
  return [...byId.values()].sort((a, b) => byText(a.id, b.id));
}
