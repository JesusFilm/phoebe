// The work source: runs one cycle's gather across the configured work kinds —
// `registry.get(kind).definition.fetch(ctx)` into each kind's opaque record
// slot — and owns the engine-side shared stack facility the kinds contribute
// to and read from: the cycle-scoped issue-body read-through cache and the
// blocker-state index (#348 Q6). Bodies are fetched through one cache, never
// merged after the fact, so the #290 ordering bug cannot recur; the cross-kind
// body-derived blocker merge runs here, engine-owned, after every fetch.
//
// The feature facility (#341) is the same idea one layer up: `cycle.feature(n)`
// answers which live feature an issue belongs to, walking the issue graph
// through cycle-scoped memos so siblings under one feature share the reads.
//
// This module also builds the per-kind `WorkKindCtx` the engine hands to
// `fetch`/`select` (and widens for `run`): the ctx is per-cycle, so it lives
// with the cycle state it closes over.

import { asBranchRef } from "./branded.ts";
import type { PhoebeConfig } from "./config-schema.ts";
import {
  resolveFeature,
  type Feature,
  type FeatureGraphReader,
  type IntegrationPr,
  type IssueGraphNode,
} from "./feature-branch.ts";
import { parseBlockedBy, type BlockerPrState, type Issue } from "./orchestrator.ts";
import type { GitHubClient } from "./github-client.ts";
import type { OriginHub } from "./origin-hub.ts";
import type {
  CycleServices,
  WorkKindCtx,
  WorkKindGitHub,
  WorkKindOrigin,
} from "./work-kinds/definition.ts";
import type { WorkKindRegistry } from "./work-kinds/registry.ts";
import { registeredKind } from "./work-kinds/walk.ts";

export type Clock = {
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
};

export type CycleRecord = {
  /** The kinds that were gathered, in gather order. */
  kindsGathered: readonly string[];
  /**
   * Each kind's fetch result, keyed by kind — opaque to the engine; only the
   * kind's own `select` (and `report.idle`) read it back.
   */
  gathered: ReadonlyMap<string, unknown>;
};

export type GatheredCycle = {
  record: CycleRecord;
  /**
   * The per-kind cycle context, cached per kind — the same object `fetch` saw,
   * handed to `select` and widened for `run`.
   */
  ctxFor: (kind: string) => WorkKindCtx;
};

export type WorkSource = {
  /**
   * Gather one cycle's work data across the given kinds in order.
   *
   * A single unreadable unit is warned and dropped inside that kind's fetch;
   * the gather continues. A whole kind failing to fetch throws — the
   * bootstrapper's restart loop is the recovery path.
   */
  gatherCycle(kinds: readonly string[]): Promise<GatheredCycle>;
};

export function createWorkSource(opts: {
  github: GitHubClient;
  originHub: OriginHub;
  clock: Clock;
  env: NodeJS.ProcessEnv;
  config: PhoebeConfig;
  registry: WorkKindRegistry;
  /**
   * The engine's stdout tag (#418). Passed in rather than derived: the tag
   * names the *process* — tenant and pipeline — and this module only knows the
   * tenant. Defaults to the bare tag so a test that builds a work source
   * directly need not supply one.
   */
  tag?: string;
  /**
   * This kind's currently-running refs (#422) — a live view of the loop's
   * in-flight set, read through on every `ctx.inFlight` access rather than
   * copied, so a `select` called a second time in one pass sees the unit the
   * first call yielded. Defaults to empty, which is what a work source built
   * outside the loop (a test, a preview) should see.
   */
  inFlight?: (kind: string) => ReadonlySet<string>;
  /**
   * This kind's refs the engine has quarantined in memory (#424) — read through
   * the same way `inFlight` is, so a `select` asked twice in one pass sees a
   * count the first ask's pick has just cleared. Defaults to empty, which is
   * what a work source built outside the loop should see.
   */
  quarantined?: (kind: string) => ReadonlySet<string>;
}): WorkSource {
  const { github, originHub, clock, env, config, registry } = opts;
  const tag = opts.tag ?? "[phoebe]";
  const inFlight = opts.inFlight ?? (() => new Set<string>());
  const quarantined = opts.quarantined ?? (() => new Set<string>());

  /** The message every per-unit warning below prints, whatever was thrown. */
  function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  function buildBlockerStates(issues: readonly Issue[], into: Map<number, BlockerPrState>): void {
    const blockerNumbers = new Set<number>();
    for (const issue of issues) {
      for (const n of parseBlockedBy(issue.body)) {
        blockerNumbers.add(n);
      }
    }
    for (const n of blockerNumbers) {
      if (into.has(n)) continue;
      try {
        into.set(n, github.blockerPrState(n));
      } catch (error) {
        console.warn(`${tag} Skipping blocker state for #${n} this cycle — ${errorText(error)}`);
      }
    }
  }

  async function gatherCycle(kinds: readonly string[]): Promise<GatheredCycle> {
    const cycle = github.forCycle();
    // The kind-facing GitHub surface: the cycle-scoped memoizing client, plus
    // the one deliberately fresh read the run phase needs. A forwarding proxy
    // rather than a spread: the cycle client may itself be a Proxy (the test
    // stub is), whose members a spread would not see.
    const workGitHub = new Proxy(cycle, {
      get(target, prop, receiver) {
        if (prop === "currentMergeInfo") {
          return (prNumber: Parameters<GitHubClient["currentMergeInfo"]>[0]) =>
            github.currentMergeInfo(prNumber);
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as WorkKindGitHub;

    // The stack facility. `null` records a failed body read, so the failure is
    // remembered too — a candidate whose body cannot be read is dropped by its
    // kind, once, instead of re-fetched by every kind that shares the issue.
    const issueBodies = new Map<number, string | null>();
    const blockerStates = new Map<number, BlockerPrState>();

    // The feature facility (#341). Three memos, all cycle-scoped: the issue
    // graph nodes a membership walk climbs, the integration PR that says whether
    // a feature is still live, and the answers themselves — so siblings under
    // one feature share every read the first of them paid for. A failed read is
    // remembered as `null` too, so a repo where the sub-issue endpoint is
    // unavailable costs one call per issue, not one per walk.
    const graphNodes = new Map<number, IssueGraphNode | null>();
    const integrationPrs = new Map<number, { pr: IntegrationPr | null } | null>();
    const features = new Map<number, Feature | null>();
    const featureReader: FeatureGraphReader = {
      issueGraphNode(issueNumber) {
        if (graphNodes.has(issueNumber)) {
          return graphNodes.get(issueNumber) ?? null;
        }
        try {
          const node = github.issueGraphNode(issueNumber);
          graphNodes.set(issueNumber, node);
          return node;
        } catch (error) {
          console.warn(
            `${tag} Skipping feature membership at #${issueNumber} this cycle — ${errorText(error)}`,
          );
          graphNodes.set(issueNumber, null);
          return null;
        }
      },
      featureIntegrationPr(featureIssueNumber) {
        if (integrationPrs.has(featureIssueNumber)) {
          return integrationPrs.get(featureIssueNumber) ?? null;
        }
        try {
          const read = { pr: github.featureIntegrationPr(featureIssueNumber) };
          integrationPrs.set(featureIssueNumber, read);
          return read;
        } catch (error) {
          console.warn(
            `${tag} Skipping feature #${featureIssueNumber} this cycle — its integration PR ` +
              `could not be read: ${errorText(error)}`,
          );
          integrationPrs.set(featureIssueNumber, null);
          return null;
        }
      },
    };
    const services: CycleServices = {
      issueBody(issueNumber) {
        if (issueBodies.has(issueNumber)) {
          return issueBodies.get(issueNumber) ?? null;
        }
        try {
          const body = github.issueBody(issueNumber);
          issueBodies.set(issueNumber, body);
          return body;
        } catch (error) {
          console.warn(
            `${tag} Skipping issue body for #${issueNumber} this cycle — ${errorText(error)}`,
          );
          issueBodies.set(issueNumber, null);
          return null;
        }
      },
      registerIssues(issues) {
        buildBlockerStates(issues, blockerStates);
      },
      blockerStates: () => blockerStates,
      feature(issueNumber) {
        if (features.has(issueNumber)) {
          return features.get(issueNumber) ?? null;
        }
        const resolved = resolveFeature(issueNumber, featureReader);
        features.set(issueNumber, resolved);
        return resolved;
      },
    };

    const origin: WorkKindOrigin = {
      fetch: () => originHub.fetch(),
      branchHead: (branch) => originHub.branchHead(asBranchRef(branch)),
      commitsBehind: (branch, upstream) => originHub.commitsBehind(asBranchRef(branch), upstream),
    };

    const ctxCache = new Map<string, WorkKindCtx>();
    const ctxFor = (kind: string): WorkKindCtx => {
      const cached = ctxCache.get(kind);
      if (cached) return cached;
      const registered = registeredKind(registry, kind);
      const ctx: WorkKindCtx = {
        kind,
        config,
        options: registered.options,
        env,
        github: workGitHub,
        origin,
        cycle: services,
        clock,
        get inFlight() {
          return inFlight(kind);
        },
        get quarantined() {
          return quarantined(kind);
        },
        log: (message) => console.log(`${tag}[${kind}] ${message}`),
      };
      ctxCache.set(kind, ctx);
      return ctx;
    };

    const gathered = new Map<string, unknown>();
    for (const kind of kinds) {
      gathered.set(kind, await registeredKind(registry, kind).definition.fetch(ctxFor(kind)));
    }

    // The engine-owned cross-kind step: blocker states derived from every body
    // read this cycle, whatever kind read it. Order-insensitive by
    // construction — it runs after all fetches, over the whole cache.
    const readableBodies: Issue[] = [...issueBodies.entries()]
      .filter((entry): entry is [number, string] => entry[1] !== null)
      .map(([number, body]) => ({ number, title: "", body, labels: [], createdAt: "" }));
    if (readableBodies.length > 0) {
      buildBlockerStates(readableBodies, blockerStates);
    }

    return { record: { kindsGathered: kinds, gathered }, ctxFor };
  }

  return { gatherCycle };
}
