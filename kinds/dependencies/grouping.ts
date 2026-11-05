// Grouping (ADR 0003): candidates become bundles, and each bundle becomes one
// issue. A bundle's `group` names it across cycles, so it is built from what
// stays put while versions move — a package, a scope, a workspace — and never
// from a version.

import { byText, compareCandidates, repositoryWebUrl, type Candidate } from "./candidate.ts";

export const STRATEGIES = [
  "individual",
  "all",
  "by-dependency-type",
  "by-workspace",
  "by-relation",
] as const;
export type Strategy = (typeof STRATEGIES)[number];

/**
 * Packages whose name matches `pattern` share the bundle `group`, whatever
 * the strategy says. `*` matches any run of characters; everything else is
 * literal. The first matching override wins.
 */
export type GroupOverride = { pattern: string; group: string };

export type GroupingOptions = {
  /** `individual` gives every major its own bundle; `follow-strategy` groups it like the rest. */
  majors?: "individual" | "follow-strategy";
  overrides?: readonly GroupOverride[];
};

export type Bundle = {
  /** Every candidate in a bundle shares one manager. */
  manager: string;
  group: string;
  candidates: readonly Candidate[];
};

function patternRegExp(pattern: string): RegExp {
  const literal = pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^${literal.join(".*")}$`);
}

/** An npm scope — `@mui` for `@mui/material` — or null for an unscoped name. */
function npmScope(name: string): string | null {
  return /^(@[^/]+)\//.exec(name)?.[1] ?? null;
}

/**
 * Components of the relation graph over one manager's candidates: two
 * packages are related when they share an npm scope, either declares the
 * other a peer, or both name the same source repository. Each component is
 * named by its smallest scope, else its smallest package name. A scoped
 * family keeps its name while members come and go; an unscoped one renames,
 * and so files a new bundle, when the member that names it drops out or a
 * scoped member joins.
 */
function relationGroups(candidates: readonly Candidate[]): Map<Candidate, string> {
  const parent = new Map<string, string>();
  const find = (name: string): string => {
    let root = name;
    while (parent.get(root) !== root) root = parent.get(root)!;
    parent.set(name, root);
    return root;
  };
  const union = (a: string, b: string) => {
    const [ra, rb] = [find(a), find(b)];
    if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
  };

  const names = new Set(candidates.map((c) => c.package));
  for (const name of names) parent.set(name, name);
  const byKey = new Map<string, string>();
  const link = (key: string, name: string) => {
    const first = byKey.get(key);
    if (first === undefined) byKey.set(key, name);
    else union(first, name);
  };
  for (const c of candidates) {
    const scope = npmScope(c.package);
    if (scope !== null) link(`scope:${scope}`, c.package);
    if (c.repositoryUrl) {
      const repository = repositoryWebUrl(c.repositoryUrl) ?? c.repositoryUrl.trim();
      link(`repo:${repository.toLowerCase()}`, c.package);
    }
    for (const peer of c.peers) if (names.has(peer)) union(c.package, peer);
  }

  const members = new Map<string, string[]>();
  for (const name of names) {
    const root = find(name);
    members.set(root, [...(members.get(root) ?? []), name]);
  }
  const label = new Map<string, string>();
  for (const [root, list] of members) {
    const scopes = list.map(npmScope).filter((s): s is string => s !== null);
    label.set(root, scopes.length > 0 ? scopes.sort(byText)[0]! : list.sort(byText)[0]!);
  }
  return new Map(candidates.map((c) => [c, `relation:${label.get(find(c.package))!}`]));
}

/**
 * Split candidates into bundles. A bundle never spans two managers. A major
 * gets a bundle of its own unless `majors` is `follow-strategy`, and even
 * then when its package also has a smaller update, so no bundle asks for two
 * targets of one package. That rule comes first, then the pattern
 * overrides, then the strategy. Bundles come
 * back ordered by manager and group, their candidates by package.
 */
export function groupCandidates(
  candidates: readonly Candidate[],
  strategy: Strategy,
  options: GroupingOptions = {},
): Bundle[] {
  const majors = options.majors ?? "individual";
  const overrides = (options.overrides ?? []).map((o) => ({
    re: patternRegExp(o.pattern),
    group: o.group,
  }));

  const packageKey = (c: Candidate) => JSON.stringify([c.manager, c.package]);
  const withSmallerUpdate = new Set(
    candidates.filter((c) => c.updateType !== "major").map(packageKey),
  );

  const groupOf = new Map<Candidate, string>();
  const byManager = new Map<string, Candidate[]>();
  for (const c of candidates) {
    if (
      c.updateType === "major" &&
      (majors === "individual" || withSmallerUpdate.has(packageKey(c)))
    ) {
      groupOf.set(c, `major:${c.package}`);
      continue;
    }
    const override = overrides.find((o) => o.re.test(c.package));
    if (override !== undefined) {
      groupOf.set(c, `group:${override.group}`);
      continue;
    }
    byManager.set(c.manager, [...(byManager.get(c.manager) ?? []), c]);
  }

  for (const list of byManager.values()) {
    if (strategy === "by-relation") {
      for (const [c, group] of relationGroups(list)) groupOf.set(c, group);
      continue;
    }
    for (const c of list) {
      groupOf.set(
        c,
        strategy === "individual"
          ? `package:${c.package}`
          : strategy === "all"
            ? "all"
            : strategy === "by-dependency-type"
              ? `type:${c.depType}`
              : `workspace:${c.workspace}`,
      );
    }
  }

  const bundles = new Map<string, Bundle & { candidates: Candidate[] }>();
  for (const c of candidates) {
    const group = groupOf.get(c)!;
    const key = JSON.stringify([c.manager, group]);
    const bundle = bundles.get(key) ?? { manager: c.manager, group, candidates: [] };
    bundle.candidates.push(c);
    bundles.set(key, bundle);
  }
  return [...bundles.values()]
    .map((b) => ({ ...b, candidates: b.candidates.sort(compareCandidates) }))
    .sort((a, b) => byText(a.manager, b.manager) || byText(a.group, b.group));
}
