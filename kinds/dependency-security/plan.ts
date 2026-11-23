// From the sources' union to the issues this kind files (ADR 0003). Pure: no
// clock, no GitHub.
//
//   - The bootstrapper pin goes unless the tenant asked for it (#832): it
//     moves with the engine ref, through `phoebe upgrade`.
//   - Each occurrence of a package (manager, package, current version,
//     dependency type, workspace) is collapsed across every target the
//     sources proposed, its advisories unioned by id.
//   - Advisories under the `minSeverity` of their occurrence's dependency
//     type are dropped (ADR 0005). `dependency-updates` reads them on a
//     direct dependency; on a transitive package nothing files them. An
//     occurrence left with none is not filed.
//   - What remains targets the fix release exactly, the highest `fixedIn`
//     among its advisories. policy.ts lets only that release skip the
//     maturity wait, so a newer target would leave the advisory open while it
//     aged. With no fix released, the occurrence stays at its version.
//   - A transitive occurrence with no fix released is dropped unless one of
//     its advisories is critical (ADR 0005). Nobody can act on it: there is
//     no version to move to, and no manifest declares the package. Once its
//     fix ships it has a target and is planned like any other.
//   - A transitive occurrence with a fix and no critical advisory joins the
//     transitive bundle, one per manager (ADR 0005). Its implementer makes
//     lockfile fixes only. A row it dropped as needing more is planned per
//     package from then on, as is every row under `transitive: "individual"`.
//   - Everything else is one bundle per package and manager. The bundle
//     routes when any occurrence has a fix, and is a tracking issue
//     otherwise. Its key does not change between the two, so the tracking
//     issue is the one refreshed and labelled once a fix ships.
//   - A routed bundle with a critical advisory is filed past the open cap,
//     and a tracking issue holds no slot in it (ADR 0005). The plan lists the
//     criticals first, then the transitive bundle and the other routed
//     bundles, then the tracking issues, which is the order the cap fills in.

import { withoutBootstrapperPin, type BootstrapperPinMode } from "../dependencies/bootstrapper.ts";
import {
  byText,
  compareCandidates,
  unionCandidates,
  type Candidate,
} from "../dependencies/candidate.ts";
import {
  DEPENDENCIES_LABEL,
  planBundle,
  SECURITY_LABEL,
  type PlannedBundle,
  type Rendered,
} from "../dependencies/filing.ts";
import type { Bundle } from "../dependencies/grouping.ts";
import { overThreshold, type MinSeverity } from "../dependencies/policy.ts";
import { managerScheme } from "../dependencies/registry/versions.ts";
import { fixTarget, moveOf } from "../dependencies/sources/native.ts";
import type { PhoebeLabel } from "../../src/labels.ts";
import {
  hasFix,
  renderSecurityBody,
  renderSecurityTitle,
  renderTransitiveBody,
  renderTransitiveTitle,
  transitiveRows,
} from "./body.ts";

/** A planned security issue, and whether it routes to the `dependencies` kind. */
export type PlannedSecurityBundle = PlannedBundle & { routed: boolean };

/** What a per-package security bundle's group opens with, after the manager in its key. */
const SECURITY_GROUP_PREFIX = "security:";

/**
 * The transitive bundle's group. A per-package group always opens with
 * `security:`, so no package, whatever its name, can share this key.
 */
export const TRANSITIVE_GROUP = "security-transitive";

/** `bundle` files transitive fixes together; `individual` files each package on its own. */
export const TRANSITIVE_MODES = ["bundle", "individual"] as const;
export type TransitiveMode = (typeof TRANSITIVE_MODES)[number];

/** The group of a bundle key: what follows the manager, which holds no colon. */
const groupOf = (key: string) => key.slice(key.indexOf(":") + 1);

/** Whether a bundle key is a transitive bundle's. */
export function isTransitiveBundleKey(key: string): boolean {
  return groupOf(key) === TRANSITIVE_GROUP;
}

/**
 * Whether a bundle key is one this kind files. The cap counts these alone:
 * `dependency-updates` keeps its own five open, and counting those would
 * leave a security fix waiting behind routine bumps.
 */
export function isSecurityKey(key: string): boolean {
  return isTransitiveBundleKey(key) || groupOf(key).startsWith(SECURITY_GROUP_PREFIX);
}

/**
 * The rows a transitive bundle's implementer dropped as needing more than a
 * lockfile fix, each under the PR or issue that dropped it. Keyed by
 * {@link movedKey}.
 */
export type Moved = ReadonlyMap<string, number>;

/** A dropped row's identity: the manager, the package and the version it was to reach. */
export function movedKey(manager: string, pkg: string, target: string): string {
  return JSON.stringify([manager, pkg, target]);
}

/**
 * The longest body a bundle may render. GitHub refuses one over 65,536
 * characters; the margin is for the refresh a veto can make without growing.
 */
export const BODY_LIMIT = 60_000;

/** Whether any row of a bundle carries a critical advisory. */
function hasCritical(bundle: Bundle): boolean {
  return bundle.candidates.some((c) => c.advisories.some((a) => a.severity === "critical"));
}

export type SecurityPlan = {
  planned: PlannedSecurityBundle[];
  /** Occurrences carrying advisories, every one under `minSeverity`. */
  below: number;
  /** Bootstrapper pins left to `phoebe upgrade`. */
  bootstrapper: number;
  /** Transitive occurrences with no fix released and no critical advisory. */
  unfixable: number;
};

/**
 * One candidate per occurrence, whatever targets the sources proposed: with
 * every target set to the current version, the contract's union merges them,
 * the first seen winning its fields and advisories and `via` unioned.
 */
function collapse(candidates: readonly Candidate[]): Candidate[] {
  return unionCandidates([candidates.map((c) => ({ ...c, target: c.current }))]);
}

/**
 * The occurrence as this kind files it: only advisories at or over the
 * threshold, the target their fix, and no publish date, which belonged to
 * whatever target a source proposed.
 */
function securityTarget(c: Candidate, minSeverity: MinSeverity): Candidate | null {
  const advisories = c.advisories
    .filter((a) => overThreshold(a, c.depType, minSeverity))
    .sort((a, b) => byText(a.id, b.id));
  if (advisories.length === 0) return null;
  const target = fixTarget(managerScheme(c.manager), c.current, advisories);
  const filed: Candidate = { ...c, advisories, target, updateType: moveOf(c.current, target) };
  delete filed.publishedAt;
  return filed;
}

/**
 * Whether anyone can act on an occurrence. One with a fix can be moved. One
 * without is worth a tracking issue when a manifest declares it, when its
 * route is not known, or when an advisory on it is critical. A transitive
 * high with no fix is none of those.
 */
function actionable(c: Candidate): boolean {
  if (hasFix(c)) return true;
  const transitive = c.via !== undefined && c.via.length > 0;
  return !transitive || c.advisories.some((a) => a.severity === "critical");
}

function isTransitive(c: Candidate): boolean {
  return c.via !== undefined && c.via.length > 0;
}

/**
 * The bundle cut down to the table rows whose body fits under `limit`, in the
 * order the table lists them. The rows left out come in on a later scan, once
 * earlier ones have merged, or on this one when filing holds an earlier row
 * back (filing.ts).
 */
function fitToBody(bundle: Bundle, render: (bundle: Bundle) => Rendered, limit: number): Bundle {
  if (render(bundle).body.length <= limit) return bundle;
  const rows = transitiveRows(bundle.candidates);
  const first = (count: number): Bundle => {
    const kept = new Set(
      rows.slice(0, count).map((r) => JSON.stringify([r.package, r.current, r.target])),
    );
    return {
      ...bundle,
      candidates: bundle.candidates.filter((c) =>
        kept.has(JSON.stringify([c.package, c.current, c.target])),
      ),
    };
  };
  let fits = 0;
  let over = rows.length;
  while (over - fits > 1) {
    const middle = Math.floor((fits + over) / 2);
    if (render(first(middle)).body.length <= limit) fits = middle;
    else over = middle;
  }
  return first(fits);
}

/**
 * The issues to file: routed ones carrying a critical, then the transitive
 * bundle and the other routed ones, then the tracking issues. `routingLabel`
 * is the label a routed issue carries beside `dependencies` and `security`; a
 * tracking issue carries those two alone. `moved` names the rows a transitive
 * bundle's implementer dropped, which are planned per package.
 */
export function planSecurity(
  candidates: readonly Candidate[],
  options: {
    minSeverity: MinSeverity;
    routingLabel: PhoebeLabel;
    bootstrapperPin: BootstrapperPinMode;
    transitive: TransitiveMode;
    moved?: Moved;
    /** The body limit, for a test that cannot afford sixty thousand characters. */
    bodyLimit?: number;
  },
): SecurityPlan {
  const pinless = withoutBootstrapperPin(candidates, options.bootstrapperPin);
  const advised = collapse(pinless.kept).filter((c) => c.advisories.length > 0);
  const severe = advised
    .map((c) => securityTarget(c, options.minSeverity))
    .filter((c): c is Candidate => c !== null);
  const filed = severe.filter(actionable);

  const moved = options.moved ?? new Map<string, number>();
  const droppedFrom = (c: Candidate) =>
    isTransitive(c) ? moved.get(movedKey(c.manager, c.package, c.target)) : undefined;
  const lockfileOnly = (c: Candidate) =>
    options.transitive === "bundle" &&
    isTransitive(c) &&
    hasFix(c) &&
    !c.advisories.some((a) => a.severity === "critical") &&
    droppedFrom(c) === undefined;

  const together = new Map<string, Candidate[]>();
  for (const c of filed.filter(lockfileOnly)) {
    together.set(c.manager, [...(together.get(c.manager) ?? []), c]);
  }
  const renderTransitive = (bundle: Bundle): Rendered => ({
    title: renderTransitiveTitle(bundle),
    body: renderTransitiveBody(bundle, { minSeverity: options.minSeverity }),
    labels: [DEPENDENCIES_LABEL, SECURITY_LABEL, options.routingLabel],
  });
  const fit = (bundle: Bundle) =>
    fitToBody(bundle, renderTransitive, options.bodyLimit ?? BODY_LIMIT);
  const transitive = [...together].map(([manager, list]): PlannedSecurityBundle => {
    const whole: Bundle = {
      manager,
      group: TRANSITIVE_GROUP,
      candidates: list.sort(compareCandidates),
    };
    return { ...planBundle(whole, renderTransitive, fit), routed: true };
  });

  const bundles = new Map<string, Bundle & { candidates: Candidate[] }>();
  for (const c of filed.filter((c) => !lockfileOnly(c))) {
    const key = JSON.stringify([c.manager, c.package]);
    const bundle = bundles.get(key) ?? {
      manager: c.manager,
      group: `${SECURITY_GROUP_PREFIX}${c.package}`,
      candidates: [],
    };
    bundle.candidates.push(c);
    bundles.set(key, bundle);
  }

  // Rendered from the bundle alone, so a bundle a veto trimmed routes by the rows it kept.
  const render = (bundle: Bundle): Rendered => {
    const routed = bundle.candidates.some(hasFix);
    // The newest PR or issue that dropped one of these rows from the transitive bundle.
    const from = bundle.candidates
      .map(droppedFrom)
      .filter((n): n is number => n !== undefined)
      .sort((a, b) => b - a)[0];
    return {
      title: renderSecurityTitle(bundle),
      body: renderSecurityBody(bundle, {
        routed,
        minSeverity: options.minSeverity,
        routingLabel: options.routingLabel.name,
        ...(from === undefined ? {} : { droppedFrom: from }),
      }),
      labels: routed
        ? [DEPENDENCIES_LABEL, SECURITY_LABEL, options.routingLabel]
        : [DEPENDENCIES_LABEL, SECURITY_LABEL],
      ...(routed
        ? hasCritical(bundle)
          ? { slot: "exempt" as const }
          : {}
        : { slot: "none" as const }),
    };
  };
  const perPackage = [...bundles.values()]
    .map((b) => ({ ...b, candidates: b.candidates.sort(compareCandidates) }))
    .map((bundle): PlannedSecurityBundle => ({
      ...planBundle(bundle, render),
      routed: bundle.candidates.some(hasFix),
    }));
  // `security-transitive` sorts ahead of every `security:<package>`, so a
  // manager's transitive bundle takes its slot before that manager's packages.
  const planned = [...transitive.filter((p) => p.bundle.candidates.length > 0), ...perPackage].sort(
    (a, b) => byText(a.bundle.manager, b.bundle.manager) || byText(a.bundle.group, b.bundle.group),
  );
  return {
    planned: [
      ...planned.filter((p) => p.routed && p.slot === "exempt"),
      ...planned.filter((p) => p.routed && p.slot !== "exempt"),
      ...planned.filter((p) => !p.routed),
    ],
    below: advised.length - severe.length,
    bootstrapper: pinless.skipped,
    unfixable: severe.length - filed.length,
  };
}
