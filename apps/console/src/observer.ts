// "Run observer" as the History tab reads it (#938, spec #924, decisions #920
// and #916). Arm-neutral, like history.ts: a deployment page hands the tab one
// `ObserveRunner`. A local install's asks the companion to exec `phoebe
// observe` in its container, and a remote's asks `POST /api/observe` (#937).
// Both answer the same `ObserveResponse`, and both say "too old" the same way.
//
// Which tenants declare the observer, and whether a run is in flight, come off
// the report the page already holds: the effective config names each
// pipeline's kinds, and the observer pipeline's snapshot lists what it is
// running. Nothing here asks the deployment anything before the button is
// pressed.

import type {
  DeploymentReport,
  DesktopBridge,
  EffectiveFields,
  FleetCell,
  ObserveRequest,
  ObserveResponse,
} from "phoebe-agent/contracts";
import { cellsOf } from "./report.ts";

/** The catalog kind a manual run asks for. */
export const OBSERVER_KIND = "observer";

/** The lookback the confirm offers. The observer's own default. */
export const DEFAULT_LOOKBACK = "14d";

/** What one ask came to. */
export type ObserveFetch =
  | { kind: "answer"; answer: ObserveResponse }
  /** The deployment predates manual observer runs. */
  | { kind: "too-old" };

/** How a deployment page starts an observer run. Rejects when the deployment could not be asked. */
export type ObserveRunner = (request: ObserveRequest) => Promise<ObserveFetch>;

/** A local install's runner: one exec in its container. */
export function localObserve(bridge: DesktopBridge, dir: string): ObserveRunner {
  return async (request) => {
    const answer = await bridge.installs.observe(dir, request);
    return answer === null ? { kind: "too-old" } : { kind: "answer", answer };
  };
}

/** One tenant that declares the observer, as the button needs it. */
export type ObserverTarget = {
  /** How the tenant is shown: its `repoSlug`, else its config path. */
  label: string;
  /** What `tenant` in the ask carries when the deployment has more than one target. */
  tenant: string;
  /** The pipeline the tenant declares the observer in. */
  pipeline: string;
  /** When the run in flight started, or null when none is. */
  runningSince: string | null;
};

/**
 * Every tenant whose effective config declares the observer, in the order the
 * report lists them. Empty for a report without the config section: such a
 * deployment is too old to say, and too old to take the ask.
 */
export function observerTargetsOf(report: DeploymentReport): ObserverTarget[] {
  const rows = Array.isArray(report.config?.tenants) ? report.config.tenants : [];
  const cells = cellsOf(report);
  const oneTenant = new Set(cells.map((cell) => cell.tenant.id)).size <= 1;
  const targets: ObserverTarget[] = [];
  for (const row of rows) {
    const pipeline = observerPipelineOf(row.fields);
    if (pipeline === null) continue;
    const cell = cells.find(
      (candidate) =>
        candidate.pipeline === pipeline &&
        (oneTenant ||
          candidate.tenant.slug === row.tenant ||
          candidate.snapshot?.tenant === row.tenant),
    );
    targets.push({
      label: row.tenant,
      // The bootstrapper names a tenant by its slug, then the repo its engine
      // reports (bootstrap/observe.ts); the config row's name is the fallback.
      tenant: cell?.tenant.slug ?? cell?.snapshot?.tenant ?? row.tenant,
      pipeline,
      runningSince: runningSinceOf(cell),
    });
  }
  return targets;
}

/** The pipeline whose kinds include the observer, or null. One per tenant: the kind refuses to share. */
function observerPipelineOf(fields: EffectiveFields | null): string | null {
  const pipelines = branch(fields?.["pipelines"]);
  if (pipelines === null) return null;
  for (const [name, node] of Object.entries(pipelines)) {
    const kinds = branch(branch(node)?.["kinds"]);
    if (kinds !== null && OBSERVER_KIND in kinds) return name;
  }
  return null;
}

/** A node of the tree as a branch, or null when it is a leaf or nothing. */
function branch(node: unknown): EffectiveFields | null {
  if (typeof node !== "object" || node === null || Array.isArray(node)) return null;
  // A leaf's `source` is a string; a branch's members are all objects.
  if (typeof (node as { source?: unknown }).source === "string") return null;
  return node as EffectiveFields;
}

function runningSinceOf(cell: FleetCell | undefined): string | null {
  const units = cell?.snapshot?.currentUnits;
  if (!Array.isArray(units)) return null;
  return units.find((unit) => unit.unit.kind === OBSERVER_KIND)?.startedAt ?? null;
}

/** The ask for one target: `tenant` only when the deployment has more than one to choose from. */
export function observeRequestOf(
  target: ObserverTarget,
  targets: readonly ObserverTarget[],
  lookback: string,
): ObserveRequest {
  return {
    ...(targets.length > 1 ? { tenant: target.tenant } : {}),
    lookback,
  };
}

/** A period like `14d` or `36h`: what the observer takes as its `lookback`. */
export function isLookback(value: string): boolean {
  const match = /^(\d+)[smhdw]$/.exec(value);
  return match !== null && Number(match[1]) > 0;
}

/** A piece of a unit's summary: plain text, or an issue or PR number to link. */
export type SummaryPiece = { text: string } | { ref: number };

/**
 * A summary cut at every `#N`, so the drawer can link each to the tenant's
 * repo. A `#` inside a word or a path (`a#1`, `/#2`) is left as text.
 */
export function summaryPieces(text: string): SummaryPiece[] {
  const pieces: SummaryPiece[] = [];
  let from = 0;
  for (const match of text.matchAll(/(?<![\w/&#])#(\d+)\b/g)) {
    if (match.index > from) pieces.push({ text: text.slice(from, match.index) });
    pieces.push({ ref: Number(match[1]) });
    from = match.index + match[0].length;
  }
  if (from < text.length) pieces.push({ text: text.slice(from) });
  return pieces;
}
