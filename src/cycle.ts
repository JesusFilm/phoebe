// The shared per-cycle gather (issue #53): everything more than one work kind
// would otherwise fetch for itself, read exactly once. Before this, three
// janitor kinds each called `listOpenPhoebePrs()` and harvested issue bodies
// from their own PR subset, a fourth call ran in the stack-retarget sweep, and
// `issues`/`research` each rebuilt blocker state independently. Gathering it
// here removes the duplicate reads and the post-hoc merge `fetchCycleWorkData`
// used to do.
//
// Each kind's own `fetch(ctx)` still does its own kind-specific reads on top
// of this — per-PR watermark comment scans, check runs, review threads,
// mergeable retries — `CycleContext` only carries what is generically shared.

import { asBranchRef, type BranchRef, type PrNumber, type Sha } from "./branded.ts";
import type { PhoebeConfig } from "./config/index.ts";
import { isIssueInScope, isPrInScope } from "./pr-scope.ts";
import type { KindHandle, Io } from "./kinds/kind.ts";
import {
  issueBlockers,
  parseBlockedBy,
  type BlockerPrState,
  type Issue,
  type NativeBlockerMap,
} from "./stack.ts";
import { parseIssueNumberFromBranch } from "./pr-scope.ts";

/** An open PR already filtered to Phoebe's configured scope (`isPrInScope`). */
export type ScopedPr = {
  number: PrNumber;
  headRefName: BranchRef;
  baseRefName: BranchRef;
  authorLogin: string;
};

export type CycleContext = {
  mainHead: Sha;
  openPrs: readonly ScopedPr[];
  /** The authenticated login, fetched at most once per cycle — the `reviews` kind is the usual first caller. */
  login(): Promise<string>;
  pools: { ready: readonly Issue[]; research: readonly Issue[] };
  issueBodies: ReadonlyMap<number, string>;
  blockerStates: ReadonlyMap<number, BlockerPrState>;
  nativeBlockers: NativeBlockerMap;
  runtimeId: string;
};

export type CycleDeps = {
  config: PhoebeConfig;
  io: Io;
  runtimeId: string;
  error(message: string): void;
};

function listScopedOpenPrs(deps: CycleDeps): ScopedPr[] {
  const { config, io } = deps;
  const prScopeConfig = {
    branchPrefix: config.branchPrefix,
    prScope: config.prScope,
    prAuthors: config.prAuthors,
    draftPrs: config.draftPrs,
    prOptOutLabel: config.prOptOutLabel,
  };
  return io.github
    .openPrs(config.prBaseScope === "default" ? { base: config.defaultBranch } : undefined)
    .filter((pr) => isPrInScope(pr, prScopeConfig))
    .map((pr) => ({
      number: pr.number,
      headRefName: pr.headRefName,
      baseRefName: pr.baseRefName,
      authorLogin: pr.authorLogin,
    }));
}

function listScopedIssues(deps: CycleDeps, label: string): Issue[] {
  return deps.io.github
    .issuesWithLabel(label)
    .filter((issue) => isIssueInScope(issue, { issueAuthors: deps.config.issueAuthors }));
}

/**
 * Native blockers keyed by issue number. Empty (and makes zero `gh` calls)
 * under `blockerSource: "body"`; `native`/`both` do one API read per issue. A
 * failed native read never aborts the cycle — it warns and treats the issue as
 * having no native blockers this cycle.
 */
function nativeBlockersFor(deps: CycleDeps, issues: readonly Issue[]): Map<number, number[]> {
  const map = new Map<number, number[]>();
  if (deps.config.blockerSource === "body") {
    return map;
  }
  for (const issue of issues) {
    let native: number[];
    try {
      native = deps.io.github.nativeBlockers(issue.number).map((row) => row.number);
    } catch (error) {
      deps.error(
        `Native blocker lookup failed for #${issue.number} — treating as no native blockers this cycle (${error instanceof Error ? error.message : String(error)}).`,
      );
      native = [];
    }
    if (native.length > 0) {
      map.set(issue.number, native);
    }
  }
  return map;
}

function blockerPrState(deps: CycleDeps, blockerIssueNumber: number): BlockerPrState {
  const branch = asBranchRef(`${deps.config.branchPrefix}issue-${blockerIssueNumber}`);
  const openPrNumber = deps.io.github.prNumberForHead(branch, "open");
  const mergedPrNumber = deps.io.github.prNumberForHead(branch, "merged");
  return {
    hasOpenPr: openPrNumber !== undefined,
    openPrNumber,
    hasMergedPr: mergedPrNumber !== undefined,
    mergedPrNumber,
  };
}

function blockerStatesFor(
  deps: CycleDeps,
  issues: readonly Issue[],
  nativeBlockersByIssue: NativeBlockerMap,
): Map<number, BlockerPrState> {
  const blockerConfig = {
    blockedByPattern: deps.config.blockedByPattern,
    blockerSource: deps.config.blockerSource,
  };
  const blockerNumbers = new Set<number>();
  for (const issue of issues) {
    for (const n of issueBlockers(
      issue,
      blockerConfig,
      nativeBlockersByIssue.get(issue.number) ?? [],
    )) {
      blockerNumbers.add(n);
    }
  }
  const states = new Map<number, BlockerPrState>();
  for (const n of blockerNumbers) {
    try {
      states.set(n, blockerPrState(deps, n));
    } catch (error) {
      // Absent entries are treated as unmerged blockers — safe to retry next cycle.
      deps.error(
        `Skipping blocker state for #${n} this cycle — ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return states;
}

function blockerStatesFromBodies(
  deps: CycleDeps,
  bodies: ReadonlyMap<number, string>,
): Map<number, BlockerPrState> {
  const blockerNumbers = new Set<number>();
  for (const body of bodies.values()) {
    for (const n of parseBlockedBy(deps.config.blockedByPattern, body)) {
      blockerNumbers.add(n);
    }
  }
  const states = new Map<number, BlockerPrState>();
  for (const n of blockerNumbers) {
    try {
      states.set(n, blockerPrState(deps, n));
    } catch (error) {
      deps.error(
        `Skipping blocker state for #${n} this cycle — ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return states;
}

/**
 * Every issue body behind a scoped open PR that maps to a Phoebe issue
 * branch, keyed by issue number and deduped so a body shared by several PRs is
 * fetched once. The stack selectors read these for `blocked by` references.
 */
function harvestIssueBodies(deps: CycleDeps, prs: readonly ScopedPr[]): Map<number, string> {
  const issueNumbers = [
    ...new Set(
      prs
        .map((pr) => parseIssueNumberFromBranch(pr.headRefName, deps.config.branchPrefix))
        .filter((n): n is number => n !== null),
    ),
  ];
  return new Map(issueNumbers.map((number) => [number, deps.io.github.issueBody(number)] as const));
}

function mergeInto<K, V>(target: Map<K, V>, source: ReadonlyMap<K, V>): void {
  for (const [k, v] of source) {
    target.set(k, v);
  }
}

/**
 * Gather the ambient state every kind's own `fetch` (and every kind's
 * `sweep`) reads from: the scoped open-PR list, the `ready`/`research` issue
 * pools, and the blocker states resolved from both. Always computes every
 * field regardless of which `kinds` are enabled this cycle — the loop always
 * boxes and sweeps all five kinds even when `WORK_ORDER` narrows selection to
 * a subset, so there is no configuration under which a field here goes
 * unread. `kinds` is threaded through for that reason: a future narrowing
 * would filter on it here rather than changing every call site.
 */
export async function gatherCycleContext(
  deps: CycleDeps,
  _kinds: readonly KindHandle[],
): Promise<CycleContext> {
  deps.io.git.fetchOrigin();
  const mainHead = deps.io.git.originBranchSha(asBranchRef(deps.config.defaultBranch));

  const openPrs = listScopedOpenPrs(deps);
  const ready = listScopedIssues(deps, deps.config.readyLabel);
  const research = listScopedIssues(deps, deps.config.researchLabel);

  const nativeBlockers = new Map<number, number[]>();
  mergeInto(nativeBlockers, nativeBlockersFor(deps, ready));
  mergeInto(nativeBlockers, nativeBlockersFor(deps, research));

  const blockerStates = new Map<number, BlockerPrState>();
  mergeInto(blockerStates, blockerStatesFor(deps, ready, nativeBlockers));
  mergeInto(blockerStates, blockerStatesFor(deps, research, nativeBlockers));

  const issueBodies = harvestIssueBodies(deps, openPrs);
  if (issueBodies.size > 0) {
    mergeInto(blockerStates, blockerStatesFromBodies(deps, issueBodies));
  }

  let cachedLogin: string | undefined;
  const login = async (): Promise<string> => {
    if (cachedLogin === undefined) {
      cachedLogin = deps.io.github.login();
    }
    return cachedLogin;
  };

  return {
    mainHead,
    openPrs,
    login,
    pools: { ready, research },
    issueBodies,
    blockerStates,
    nativeBlockers,
    runtimeId: deps.runtimeId,
  };
}
