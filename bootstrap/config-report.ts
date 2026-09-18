// The deployment report's config section (#535; decisions #501 §5, #502, #503).
//
// Section 5 of the report is every tenant's effective config, and the rule that
// shapes this module is that the bootstrapper does not compute it. The tree is
// the engine's answer: one engine-side function owns the precedence questions
// (src/effective-config.ts), and the bootstrapper asks the *materialized*
// checkout for it — `<entry> config --json --config <tenant config>` — exactly
// the way it asks the same checkout for a tenant's pipelines (bootstrap/
// pipelines.ts). So a deployment running an older engine reports that engine's
// idea of its own settings, which is the only idea that is true.
//
// Three things this module owns that neither side does.
//
// **When to ask.** Asking spawns a Node process per tenant, and a tenant's
// settings move only when its `phoebe.config.ts` or its `.env` does. So the
// answer is cached against the same fingerprint the supervisor relaunches on,
// and a steady fleet asks nothing however often the report is rebuilt.
//
// **What a failure looks like.** Never a throw: an engine too old for the verb,
// a config that will not parse, a tenant held before discovery could read it —
// all of them are one tenant's error arm, which is the same shape #502 gives a
// tenant whose settings are unknown for any other reason. One broken tenant does
// not cost the other nineteen their config section.
//
// **How big it may get.** A tenant's tree is a few kilobytes; a workspace
// declares no ceiling on tenants. The report is one file rewritten atomically
// and shipped whole to a relay on every change, so the section is written to a
// byte budget and says how many tenants it left out, rather than growing without
// limit with the fleet.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ConfigSource } from "../src/contracts/deployment.ts";
import {
  EFFECTIVE_CONFIG_VERSION,
  type TenantEffectiveConfig,
} from "../src/contracts/effective-config.ts";
import { diagnosis, engineCommandFor, lastJsonLine, type EngineCommand } from "./pipelines.ts";
import { configFingerprint } from "./reconcile.ts";

/**
 * How many bytes of the report the config section may spend.
 *
 * It is a budget rather than a limit on any one tenant: a tenant's tree is the
 * engine's to size, and truncating one would hand a console a config that is
 * wrong rather than absent. 1 MiB is the point past which a file that is
 * rewritten on every change and pushed whole over a relay stops being cheap —
 * about fifty tenants at the few kilobytes a tenant's tree costs, which is
 * larger than any deployment this has run against.
 */
export const CONFIG_SECTION_BUDGET_BYTES = 1024 * 1024;

/** The tenant whose settings are wanted: where its files are, and whether they moved. */
export type ConfigTarget = {
  /** The tenant's id — its config dir, the key the section's rows are ordered by. */
  id: string;
  configPath: string;
  /** The tenant's co-located `.env`; read for the layer an env value is attributed to. */
  envPath: string;
  /** Working directory for the engine process — the tenant dir, as its child gets. */
  cwd?: string;
};

/** One tenant's effective config, as the running engine answered for it. */
export type TenantConfigReader = (target: ConfigTarget) => TenantEffectiveConfig;

/**
 * The collector for one materialized engine checkout, with its cache. Create one
 * per launch beside the pipeline enumerator: a relaunch is a different engine and
 * so a different answer, and dropping the cache with the checkout is what makes
 * that true without a second trigger.
 */
export type ConfigCollector = {
  read: TenantConfigReader;
  /** The shape version the engine last reported; its own until one answers. */
  version: () => number;
};

/**
 * The error arm for a tenant whose settings are unknown. The same shape
 * src/effective-config.ts returns for a config that will not resolve — written
 * out here rather than imported, because the bootstrapper must not depend on the
 * engine half's module graph to say "I could not ask".
 */
export function unknownConfig(tenant: string, reason: string): TenantEffectiveConfig {
  return { tenant, error: reason, fields: null, env: null, warnings: [] };
}

/** The `{ version, tenants }` object `phoebe config --json` prints, loosely read. */
function parseConfigPayload(payload: unknown): { version: number; row: TenantEffectiveConfig } {
  const object = payload !== null && typeof payload === "object" ? payload : undefined;
  const tenants = object === undefined ? undefined : (object as Record<string, unknown>)["tenants"];
  if (!Array.isArray(tenants) || tenants.length === 0) {
    throw new Error(`the engine printed no config (got ${JSON.stringify(payload)})`);
  }
  const row = tenants[0] as Record<string, unknown>;
  if (typeof row !== "object" || row === null || !("fields" in row) || !("error" in row)) {
    throw new Error(`malformed config row ${JSON.stringify(row)}`);
  }
  const version = (object as Record<string, unknown>)["version"];
  return {
    version: typeof version === "number" ? version : EFFECTIVE_CONFIG_VERSION,
    row: row as unknown as TenantEffectiveConfig,
  };
}

/**
 * One tenant's config + `.env` fingerprint — what decides that a cached row has
 * gone stale. The same pair the supervisor relaunches a tenant's children on
 * (`tenantFingerprint`), passed in rather than read here so the collector cannot
 * drift from the reconcile trigger it is meant to follow.
 */
export type ConfigFingerprint = (configPath: string, envPath: string) => string | null;

/**
 * Build the collector. `fingerprint` is the staleness question and `run` is the
 * engine process; both are injected, so a test asks neither a disk nor a spawn.
 */
export function createConfigCollector(opts: {
  entry: string;
  fingerprint: ConfigFingerprint;
  run?: EngineCommand;
}): ConfigCollector {
  const run = opts.run ?? engineCommandFor(opts.entry);
  const cache = new Map<string, { fingerprint: string; row: TenantEffectiveConfig }>();
  let version = EFFECTIVE_CONFIG_VERSION;

  const ask = (target: ConfigTarget): TenantEffectiveConfig => {
    const result = run(
      ["config", "--json", "--config", target.configPath],
      target.cwd !== undefined ? { cwd: target.cwd } : {},
    );
    // Exit 1 is `phoebe config`'s "every tenant errored", which for a one-tenant
    // question is a row worth reading rather than a failure — the row *is* the
    // error, in the shape a console already renders. Anything else is a checkout
    // that could not answer at all.
    try {
      const parsed = parseConfigPayload(lastJsonLine(result.stdout));
      version = parsed.version;
      // The file the row is about, stamped here rather than asked of the
      // engine: the bootstrapper is the process that both asks and holds the
      // pen (#503), so the reader that can write a file is the one that names
      // it — and the affordance works against an engine older than the field.
      return { ...parsed.row, configPath: target.configPath };
    } catch (error) {
      const why =
        result.status === 0
          ? error instanceof Error
            ? error.message
            : String(error)
          : diagnosis(result);
      return {
        ...unknownConfig(target.configPath, `could not read the effective config — ${why}`),
        configPath: target.configPath,
      };
    }
  };

  return {
    version: () => version,
    read: (target) => {
      const fingerprint = opts.fingerprint(target.configPath, target.envPath);
      const cached = cache.get(target.id);
      // A null fingerprint is "unknown", never cacheable — an unreadable config
      // is exactly the case that must be re-asked once the mount comes back.
      if (cached !== undefined && fingerprint !== null && cached.fingerprint === fingerprint) {
        return cached.row;
      }
      const row = ask(target);
      if (fingerprint !== null) cache.set(target.id, { fingerprint, row });
      return row;
    },
  };
}

/**
 * The root config as a later edit checks it (#503): its path, and a content hash
 * of the bytes the report was derived from.
 *
 * Content rather than stat, because the question an edit asks is "is this still
 * the text I was shown", and two edits inside one mtime tick are the case a stat
 * fingerprint cannot see. Re-hashed only when the cheap stat moves, so publishing
 * a report costs one stat.
 */
export function createRootConfigSource(
  path: string,
  read: (path: string) => string = (target) => readFileSync(target, "utf8"),
  stat: (path: string) => string | null = (target) => configFingerprint(target),
): () => ConfigSource {
  let seen: string | null = null;
  let source: ConfigSource = { path, fingerprint: null };
  return () => {
    const stamp = stat(path);
    if (stamp !== null && stamp === seen) return source;
    seen = stamp;
    try {
      source = {
        path,
        fingerprint: `sha256:${createHash("sha256").update(read(path)).digest("hex")}`,
      };
    } catch {
      source = { path, fingerprint: null };
    }
    return source;
  };
}

/**
 * How many bytes of the file one row costs.
 *
 * The report is written indented and a row sits three levels in
 * (`config.tenants[]`), so every line of it carries six spaces its own
 * serialization does not show. Counting them is what keeps the budget a
 * statement about the file rather than about a string nobody writes.
 */
function costOf(row: TenantEffectiveConfig): number {
  const serialized = JSON.stringify(row, null, 2);
  let lines = 1;
  for (const character of serialized) if (character === "\n") lines += 1;
  return serialized.length + lines * ROW_INDENT;
}

/** Spaces every line of a row carries inside `config.tenants[]`. */
const ROW_INDENT = 6;

/**
 * Fill the section to its byte budget, in the order given, and count what did
 * not fit. First-fit rather than best-fit on purpose: the order is the tenant
 * id's, so the same tenants are carried every time and a report does not churn
 * — and churn here is a file rewrite and a relay push, not just a different list.
 *
 * One row always goes in, even one larger than the whole budget. A deployment
 * whose single tenant has an enormous config is better served by an oversized
 * section than by an empty one, and the budget exists for the tenant *count*,
 * which is the axis with no ceiling on it.
 */
export function boundConfigRows(
  rows: readonly TenantEffectiveConfig[],
  budget: number = CONFIG_SECTION_BUDGET_BYTES,
): { tenants: TenantEffectiveConfig[]; omitted: number } {
  const tenants: TenantEffectiveConfig[] = [];
  let spent = 0;
  let omitted = 0;
  for (const row of rows) {
    const cost = costOf(row);
    if (spent + cost > budget && tenants.length > 0) {
      omitted += 1;
      continue;
    }
    spent += cost;
    tenants.push(row);
  }
  return { tenants, omitted };
}
