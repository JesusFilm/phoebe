// From the sources' union to the issues this kind files (ADR 0003). Pure: no
// clock, no GitHub.
//
//   - The bootstrapper pin goes unless the tenant asked for it (#832): it
//     moves with the engine ref, through `phoebe upgrade`.
//   - Each occurrence of a package (manager, package, current version,
//     dependency type, workspace) is collapsed across every target the
//     sources proposed, its advisories unioned by id.
//   - Advisories under `minSeverity` are dropped; `dependency-updates` reads
//     them. An occurrence left with none is not filed.
//   - What remains targets the fix release exactly, the highest `fixedIn`
//     among its advisories. policy.ts lets only that release skip the
//     maturity wait, so a newer target would leave the advisory open while it
//     aged. With no fix released, the occurrence stays at its version.
//   - Grouping is `individual`: one bundle per package and manager. The
//     bundle routes when any occurrence has a fix, and is a tracking issue
//     otherwise. Its key does not change between the two, so the tracking
//     issue is the one refreshed and labelled once a fix ships.

import { withoutBootstrapperPin, type BootstrapperPinMode } from "../dependencies/bootstrapper.ts";
import {
  byText,
  compareCandidates,
  unionCandidates,
  type Candidate,
  type Severity,
} from "../dependencies/candidate.ts";
import { DEPENDENCIES_LABEL, SECURITY_LABEL, type PlannedBundle } from "../dependencies/filing.ts";
import type { Bundle } from "../dependencies/grouping.ts";
import { overThreshold } from "../dependencies/policy.ts";
import { managerScheme } from "../dependencies/registry/versions.ts";
import { fixTarget, moveOf } from "../dependencies/sources/native.ts";
import type { PhoebeLabel } from "../../src/labels.ts";
import { hasFix, renderSecurityBody, renderSecurityTitle } from "./body.ts";

/** A planned security issue, and whether it routes to the `dependencies` kind. */
export type PlannedSecurityBundle = PlannedBundle & { routed: boolean };

export type SecurityPlan = {
  planned: PlannedSecurityBundle[];
  /** Occurrences carrying advisories, every one under `minSeverity`. */
  below: number;
  /** Bootstrapper pins left to `phoebe upgrade`. */
  bootstrapper: number;
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
function securityTarget(c: Candidate, minSeverity: Severity): Candidate | null {
  const advisories = c.advisories
    .filter((a) => overThreshold(a, minSeverity))
    .sort((a, b) => byText(a.id, b.id));
  if (advisories.length === 0) return null;
  const target = fixTarget(managerScheme(c.manager), c.current, advisories);
  const filed: Candidate = { ...c, advisories, target, updateType: moveOf(c.current, target) };
  delete filed.publishedAt;
  return filed;
}

/**
 * The issues to file, routed ones first. `routingLabel` is the label a routed
 * issue carries beside `dependencies` and `security`; a tracking issue
 * carries those two alone.
 */
export function planSecurity(
  candidates: readonly Candidate[],
  options: {
    minSeverity: Severity;
    routingLabel: PhoebeLabel;
    bootstrapperPin: BootstrapperPinMode;
  },
): SecurityPlan {
  const pinless = withoutBootstrapperPin(candidates, options.bootstrapperPin);
  const advised = collapse(pinless.kept).filter((c) => c.advisories.length > 0);
  const severe = advised
    .map((c) => securityTarget(c, options.minSeverity))
    .filter((c): c is Candidate => c !== null);

  const bundles = new Map<string, Bundle & { candidates: Candidate[] }>();
  for (const c of severe) {
    const key = JSON.stringify([c.manager, c.package]);
    const bundle = bundles.get(key) ?? {
      manager: c.manager,
      group: `security:${c.package}`,
      candidates: [],
    };
    bundle.candidates.push(c);
    bundles.set(key, bundle);
  }

  const planned = [...bundles.values()]
    .map((b) => ({ ...b, candidates: b.candidates.sort(compareCandidates) }))
    .sort((a, b) => byText(a.manager, b.manager) || byText(a.group, b.group))
    .map((bundle): PlannedSecurityBundle => {
      const routed = bundle.candidates.some(hasFix);
      return {
        bundle,
        routed,
        title: renderSecurityTitle(bundle),
        body: renderSecurityBody(bundle, {
          routed,
          minSeverity: options.minSeverity,
          routingLabel: options.routingLabel.name,
        }),
        labels: routed
          ? [DEPENDENCIES_LABEL, SECURITY_LABEL, options.routingLabel]
          : [DEPENDENCIES_LABEL, SECURITY_LABEL],
      };
    });
  return {
    planned: [...planned.filter((p) => p.routed), ...planned.filter((p) => !p.routed)],
    below: advised.length - severe.length,
    bootstrapper: pinless.skipped,
  };
}
