// What "Run observer" reads off the report and sends (#938): which tenants
// declare the observer, whether a run is in flight there, the ask each arm
// sends, "too old" from both arms, and the `#N` a summary links.

import { describe, expect, test } from "vite-plus/test";
import type { EffectiveFields, RemotePassthrough } from "phoebe-agent/contracts";
import {
  isLookback,
  localObserve,
  observeRequestOf,
  observerTargetsOf,
  summaryPieces,
} from "./observer.ts";
import { createRemoteClient } from "./remote-client.ts";
import {
  ago,
  bridge,
  cell,
  configReport,
  effectiveConfig,
  report,
  tenant,
} from "./test-fixture.ts";

/** A pipelines branch with one pipeline per entry, each owning the kinds named. */
function pipelines(declared: Record<string, string[]>): EffectiveFields {
  const branch: EffectiveFields = {};
  for (const [name, kinds] of Object.entries(declared)) {
    const owned: EffectiveFields = {};
    for (const kind of kinds) {
      owned[kind] = { runBudgetMs: { value: null, source: "default", reader: "engine" } };
    }
    branch[name] = {
      concurrency: { value: 1, source: "default", reader: "engine" },
      kinds: owned,
    };
  }
  return branch;
}

function row(slug: string, declared: Record<string, string[]>) {
  return effectiveConfig({
    tenant: slug,
    fields: {
      repoSlug: { value: slug, source: "file", reader: "both" },
      pipelines: pipelines(declared),
    },
  });
}

const OBSERVING = row("JesusFilm/youtube-studio", { work: ["issues"], observe: ["observer"] });

const OBSERVE_CELL = cell({ id: "/etc/phoebe#observe", pipeline: "observe" });

describe("which tenants declare the observer", () => {
  test("none, when no pipeline's kinds name it", () => {
    expect(observerTargetsOf(report())).toEqual([]);
    expect(
      observerTargetsOf(
        report({ config: configReport({ tenants: [row("a/b", { work: ["issues"] })] }) }),
      ),
    ).toEqual([]);
  });

  test("none, from a report without the config section", () => {
    const { config: _config, ...older } = report();
    expect(observerTargetsOf(older)).toEqual([]);
  });

  test("the tenant and pipeline that do, with nothing in flight", () => {
    const targets = observerTargetsOf(
      report({
        config: configReport({ tenants: [OBSERVING] }),
        fleet: { tenants: [tenant()], cells: [cell(), OBSERVE_CELL], updatedAt: ago(1) },
      }),
    );

    expect(targets).toEqual([
      {
        label: "JesusFilm/youtube-studio",
        tenant: "JesusFilm/youtube-studio",
        pipeline: "observe",
        runningSince: null,
      },
    ]);
  });

  test("a run in flight is the observer unit in its pipeline's snapshot", () => {
    const busy = cell({
      ...OBSERVE_CELL,
      snapshot: {
        tenant: "JesusFilm/youtube-studio",
        pipeline: "observe",
        currentUnits: [
          { unit: { kind: "observer", id: "observer" }, startedAt: ago(90), runBudgetMs: null },
        ],
        waitingForSlot: false,
        lastError: null,
        lastTimeoutAt: null,
        updatedAt: ago(5),
      },
    });
    const [target] = observerTargetsOf(
      report({
        config: configReport({ tenants: [OBSERVING] }),
        fleet: { tenants: [tenant()], cells: [cell(), busy], updatedAt: ago(1) },
      }),
    );

    expect(target?.runningSince).toBe(ago(90));
  });

  test("with several tenants, each is matched to its own cell by slug", () => {
    const other = tenant({ id: "/etc/phoebe/acme", slug: "acme/widget", path: "/etc/phoebe/acme" });
    const theirs = cell({
      id: "/etc/phoebe/acme#watch",
      tenant: other,
      pipeline: "watch",
      snapshot: {
        tenant: "acme/widget",
        pipeline: "watch",
        currentUnits: [
          { unit: { kind: "observer", id: "observer" }, startedAt: ago(30), runBudgetMs: null },
        ],
        waitingForSlot: false,
        lastError: null,
        lastTimeoutAt: null,
        updatedAt: ago(5),
      },
    });
    const targets = observerTargetsOf(
      report({
        config: configReport({
          tenants: [OBSERVING, row("acme/widget", { watch: ["observer"] })],
        }),
        fleet: {
          tenants: [tenant(), other],
          cells: [cell(), OBSERVE_CELL, theirs],
          updatedAt: ago(1),
        },
      }),
    );

    expect(targets.map((target) => [target.tenant, target.pipeline, target.runningSince])).toEqual([
      ["JesusFilm/youtube-studio", "observe", null],
      ["acme/widget", "watch", ago(30)],
    ]);
  });
});

describe("the ask", () => {
  const one = { label: "a/b", tenant: "a/b", pipeline: "observe", runningSince: null };
  const two = { ...one, label: "c/d", tenant: "c/d" };

  test("names the tenant only when there is more than one to choose from", () => {
    expect(observeRequestOf(one, [one], "14d")).toEqual({ lookback: "14d" });
    expect(observeRequestOf(two, [one, two], "3d")).toEqual({ tenant: "c/d", lookback: "3d" });
  });

  test("a lookback is a positive period", () => {
    expect(["14d", "36h", "2w", "90m"].every(isLookback)).toBe(true);
    expect(["", "14", "0d", "d", "14 d", "1y", "-3d"].some(isLookback)).toBe(false);
  });

  test("a remote is asked on POST /api/observe, and its 404 is too old", async () => {
    const asked: RemotePassthrough[] = [];
    const respond = (status: number, body: unknown) => ({
      ...bridge(),
      remotes: {
        ...bridge().remotes,
        request: (_id: string, passthrough: RemotePassthrough) => {
          asked.push(passthrough);
          return Promise.resolve({ status, body });
        },
      },
    });

    const answer = { outcome: "refused", detail: "the fleet is stopped" } as const;
    const observe = createRemoteClient(respond(200, answer), "dep_YT").observe;
    expect(await observe({ lookback: "14d" })).toEqual({ kind: "answer", answer });
    expect(asked[0]).toEqual({ method: "POST", path: "/api/observe", body: { lookback: "14d" } });

    const old = createRemoteClient(respond(404, { error: "not-found" }), "dep_YT").observe;
    expect(await old({})).toEqual({ kind: "too-old" });

    const reader = createRemoteClient(respond(403, { error: "forbidden" }), "dep_YT").observe;
    await expect(reader({})).rejects.toThrow();
  });

  test("a local install asks its bridge, and a null answer is too old", async () => {
    const asks: { dir: string; request: object }[] = [];
    const started = { outcome: "started", detail: "observer run started." } as const;

    const run = localObserve(bridge({ observe: started, observeAsks: asks }), "/repos/one");
    expect(await run({ lookback: "7d" })).toEqual({ kind: "answer", answer: started });
    expect(asks).toEqual([{ dir: "/repos/one", request: { lookback: "7d" } }]);

    const old = localObserve(bridge({ observe: null }), "/repos/one");
    expect(await old({})).toEqual({ kind: "too-old" });
  });
});

describe("a summary's references", () => {
  test("each #N is cut out to link; one inside a word or a path is text", () => {
    expect(summaryPieces("Filed #12 and updated #3. See a#4 and /#5.")).toEqual([
      { text: "Filed " },
      { ref: 12 },
      { text: " and updated " },
      { ref: 3 },
      { text: ". See a#4 and /#5." },
    ]);
    expect(summaryPieces("nothing to link")).toEqual([{ text: "nothing to link" }]);
    expect(summaryPieces("#7")).toEqual([{ ref: 7 }]);
  });
});
