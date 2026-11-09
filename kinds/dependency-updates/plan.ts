// From the sources' union to the bundles this kind files (ADR 0003): drop the
// ignored packages and the releases still ageing, keep one target per
// release line, set aside the bumps the implementer already failed, and
// group the rest. Pure: the clock and the failure record come in as values.

import { parseDropped } from "../dependencies-work/dropped.ts";
import { byText, compareCandidates, type Candidate } from "../dependencies/candidate.ts";
import { groupCandidates, patternRegExp, type Bundle } from "../dependencies/grouping.ts";
import type { PlannedBundle } from "../dependencies/filing.ts";
import { renderIssueBody, renderIssueTitle } from "../dependencies/issue-body.ts";
import { isMature, overThreshold } from "../dependencies/policy.ts";
import { compareVersions, managerScheme } from "../dependencies/registry/versions.ts";
import type { MentioningPr } from "../../src/github-client.ts";
import type { DependencyUpdatesOptions } from "./options.ts";

/** Failures per package-version past which a bump is not filed again. */
export const MAX_FAILURES = 2;

/** The PRs that dropped each `package@version`, newest first. */
export type Failures = ReadonlyMap<string, readonly number[]>;

const failureKey = (pkg: string, version: string) => `${pkg}@${version}`;

/**
 * Every bump a dependency PR listed under its `## Dropped` heading, by the
 * PRs that dropped it. A PR counts one failure whatever its state: a bump the
 * agent gave up on failed whether or not the rest of the PR merged.
 */
export function readFailures(prs: readonly MentioningPr[]): Failures {
  const failures = new Map<string, number[]>();
  for (const pr of [...prs].sort((a, b) => b.number - a.number)) {
    for (const bump of parseDropped(pr.body)) {
      const key = failureKey(bump.package, bump.version);
      const list = failures.get(key) ?? [];
      if (!list.includes(pr.number)) list.push(pr.number);
      failures.set(key, list);
    }
  }
  return failures;
}

/**
 * Of several proposals for one occurrence, the highest target per release
 * line: one for the majors and one for everything smaller. A source may offer
 * both the newest release and the one that fixes an advisory; once both are
 * mature the newest wins, and while it ages the fix ships alone.
 */
function newestPerLine(candidates: readonly Candidate[]): Candidate[] {
  const best = new Map<string, Candidate>();
  for (const c of candidates) {
    const key = JSON.stringify([
      c.manager,
      c.package,
      c.current,
      c.depType,
      c.workspace,
      c.updateType === "major",
    ]);
    const seen = best.get(key);
    if (
      seen === undefined ||
      compareVersions(managerScheme(c.manager), c.target, seen.target) > 0
    ) {
      best.set(key, c);
    }
  }
  const keep = new Set(best.values());
  return candidates.filter((c) => keep.has(c));
}

/**
 * Production dependencies and development ones grouped by their own
 * strategies. A strategy's group is prefixed with the side it came from, so
 * `all` for both stays two bundles; an override group and a major's own group
 * are left as they are, so a pattern a tenant named collects both sides.
 */
function groupBySide(
  candidates: readonly Candidate[],
  options: DependencyUpdatesOptions,
): Bundle[] {
  const sides = [
    { side: "prod", list: candidates.filter((c) => c.depType !== "dev") },
    { side: "dev", list: candidates.filter((c) => c.depType === "dev") },
  ] as const;
  const merged = new Map<string, Bundle & { candidates: Candidate[] }>();
  for (const { side, list } of sides) {
    const strategy = options.grouping.strategy[side];
    for (const bundle of groupCandidates(list, strategy, {
      majors: options.majors,
      overrides: options.grouping.groups,
    })) {
      const shared = bundle.group.startsWith("group:") || bundle.group.startsWith("major:");
      const group = shared ? bundle.group : `${side}:${bundle.group}`;
      const key = JSON.stringify([bundle.manager, group]);
      const seen = merged.get(key) ?? { manager: bundle.manager, group, candidates: [] };
      seen.candidates.push(...bundle.candidates);
      merged.set(key, seen);
    }
  }
  return [...merged.values()]
    .map((b) => ({ ...b, candidates: b.candidates.sort(compareCandidates) }))
    .sort((a, b) => byText(a.manager, b.manager) || byText(a.group, b.group));
}

export type Plan = {
  planned: PlannedBundle[];
  /** How many candidates each rule turned away. */
  dropped: { ignored: number; immature: number; failedTwice: number };
};

/**
 * The bundles to file, those carrying an advisory first. A bump that failed
 * once is filed on its own, opening with the PR it failed in; one that failed
 * twice is not filed at all.
 */
export function planBundles(
  candidates: readonly Candidate[],
  options: DependencyUpdatesOptions,
  now: Date,
  failures: Failures,
): Plan {
  const ignores = options.ignore.map(patternRegExp);
  const kept = candidates.filter((c) => !ignores.some((re) => re.test(c.package)));
  const ignored = candidates.length - kept.length;

  // Only an advisory under the threshold lets its fix skip the wait here; one
  // at or over it belongs to dependency-security.
  const mature = kept.filter((c) =>
    isMature(
      { ...c, advisories: c.advisories.filter((a) => !overThreshold(a, options.minSeverity)) },
      now,
      options.maturity,
    ),
  );
  const immature = kept.length - mature.length;

  const fresh: Candidate[] = [];
  const retries = new Map<string, { bundle: Bundle & { candidates: Candidate[] }; pr: number }>();
  let failedTwice = 0;
  for (const c of newestPerLine(mature)) {
    const prs = failures.get(failureKey(c.package, c.target)) ?? [];
    if (prs.length === 0) {
      fresh.push(c);
    } else if (prs.length >= MAX_FAILURES) {
      failedTwice += 1;
    } else {
      const group = `retry:${c.package}${c.updateType === "major" ? ":major" : ""}`;
      const key = JSON.stringify([c.manager, group]);
      const seen = retries.get(key) ?? {
        bundle: { manager: c.manager, group, candidates: [] },
        pr: prs[0]!,
      };
      seen.bundle.candidates.push(c);
      retries.set(key, seen);
    }
  }

  const planned: PlannedBundle[] = [
    ...groupBySide(fresh, options).map((bundle) => ({
      bundle,
      title: renderIssueTitle(bundle),
      body: renderIssueBody(bundle, options.maturity),
    })),
    ...[...retries.values()].map(({ bundle, pr }) => {
      const sorted = { ...bundle, candidates: bundle.candidates.sort(compareCandidates) };
      return {
        bundle: sorted,
        title: renderIssueTitle(sorted),
        body:
          `Failed in #${pr}; filed again on its own.\n\n` +
          renderIssueBody(sorted, options.maturity),
      };
    }),
  ];
  const advised = (p: PlannedBundle) => p.bundle.candidates.some((c) => c.advisories.length > 0);
  return {
    planned: [...planned.filter(advised), ...planned.filter((p) => !advised(p))],
    dropped: { ignored, immature, failedTwice },
  };
}
