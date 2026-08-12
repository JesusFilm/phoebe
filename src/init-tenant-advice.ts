// Advisory workspace registration hints for `phoebe init --tenant` (#142).
//
// Scaffolding a child is self-completing under the walk arm; under the explicit
// arm the operator must paste the directory into `workspace.tenants`. Phoebe
// prints the exact line and never edits the root config (#131).

import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve as resolvePath, sep } from "node:path";
import { TENANT_CONFIG_FILE } from "../bootstrap/tenants.ts";
import {
  isExplicitWorkspace,
  resolveWorkspace,
  type ResolvedWorkspace,
} from "../bootstrap/workspace-source.ts";
import { loadUserConfig } from "./config/index.ts";

export type InitTenantRootState =
  | { kind: "explicit-missing"; rootConfigPath: string; workspace: { tenants: string[] } }
  | { kind: "explicit-listed"; rootConfigPath: string }
  | { kind: "walk" }
  | { kind: "no-workspace"; rootConfigPath: string }
  | { kind: "uncertain"; rootConfigPath: string; reason: string };

/** Format a `workspace.tenants` entry: relative inside the root, absolute outside. */
export function formatTenantListEntry(rootDir: string, tenantDir: string): string {
  const rootAbs = resolvePath(rootDir);
  const tenantAbs = resolvePath(tenantDir);
  const rel = relative(rootAbs, tenantAbs);
  const inside = rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
  if (inside) {
    const posix = rel.split(sep).join("/");
    return posix.startsWith("./") ? posix.slice(2) : posix;
  }
  return tenantAbs.split(sep).join("/");
}

function pasteLine(entry: string): string {
  return `  ${JSON.stringify(entry)},`;
}

function isTenantListed(tenants: readonly string[], rootDir: string, tenantDir: string): boolean {
  const rootAbs = resolvePath(rootDir);
  const tenantKey = resolvePath(tenantDir);
  return tenants.some((entry) => resolvePath(rootAbs, entry) === tenantKey);
}

export type ResolveInitTenantRootStateOpts = {
  rootDir: string;
  tenantDir: string;
  loadConfig?: (configPath: string) => Promise<Record<string, unknown>>;
};

/**
 * Inspect the deployment root for workspace mode. Advisory only — never throws;
 * malformed or missing root config becomes an `uncertain` state.
 */
export async function resolveInitTenantRootState(
  opts: ResolveInitTenantRootStateOpts,
): Promise<InitTenantRootState> {
  const rootAbs = resolvePath(opts.rootDir);
  const rootConfigPath = joinConfig(rootAbs);
  if (!existsSync(rootConfigPath)) {
    return {
      kind: "uncertain",
      rootConfigPath,
      reason: `no ${TENANT_CONFIG_FILE} at this root`,
    };
  }

  const loadConfig = opts.loadConfig ?? defaultLoadRootConfig;
  let root: Record<string, unknown>;
  try {
    root = await loadConfig(rootConfigPath);
  } catch {
    return {
      kind: "uncertain",
      rootConfigPath,
      reason: `could not read ${TENANT_CONFIG_FILE}`,
    };
  }

  let workspace: ResolvedWorkspace | null;
  try {
    workspace = resolveWorkspace(root, { root: rootAbs });
  } catch {
    return {
      kind: "uncertain",
      rootConfigPath,
      reason: `workspace block in ${TENANT_CONFIG_FILE} could not be parsed`,
    };
  }

  if (workspace === null) {
    return { kind: "no-workspace", rootConfigPath };
  }
  if (!isExplicitWorkspace(workspace)) {
    return { kind: "walk" };
  }
  if (isTenantListed(workspace.tenants, rootAbs, opts.tenantDir)) {
    return { kind: "explicit-listed", rootConfigPath };
  }
  return { kind: "explicit-missing", rootConfigPath, workspace };
}

async function defaultLoadRootConfig(configPath: string): Promise<Record<string, unknown>> {
  return (await loadUserConfig(configPath)) as Record<string, unknown>;
}

function joinConfig(rootAbs: string): string {
  return resolvePath(rootAbs, TENANT_CONFIG_FILE);
}

/** Trailing advice printed after `initTenant` scaffolding (#142). */
export function formatInitTenantRegistrationAdvice(
  state: InitTenantRootState,
  tenantDir: string,
  rootDir: string,
): string {
  const entry = formatTenantListEntry(rootDir, tenantDir);
  switch (state.kind) {
    case "explicit-missing":
      return (
        `Add to workspace.tenants in ${state.rootConfigPath} ` +
        `(declared order is spawn order):\n${pasteLine(entry)}\n`
      );
    case "explicit-listed":
      return `already declared in ${state.rootConfigPath} — nothing to register\n`;
    case "walk":
      return "The workspace walk discovers this child on the next boot poll.\n";
    case "no-workspace":
      return "This root is not in workspace mode (no workspace block in phoebe.config.ts).\n";
    case "uncertain":
      return (
        `Could not determine workspace mode (${state.reason}).\n` +
        `If this root uses workspace.tenants, add:\n${pasteLine(entry)}\n`
      );
  }
}

export async function formatInitTenantRegistrationAdviceForRoot(
  opts: ResolveInitTenantRootStateOpts,
): Promise<string> {
  const state = await resolveInitTenantRootState(opts);
  return formatInitTenantRegistrationAdvice(state, opts.tenantDir, opts.rootDir);
}
