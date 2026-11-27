// Manual observer runs (#937) at the bootstrapper's two seams: the handler
// both doors call, and the file drop `phoebe observe` asks through.

import { EventEmitter } from "node:events";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import type { DeploymentReport } from "../src/contracts/deployment.ts";
import type { FleetStop } from "../src/contracts/remote-protocol.ts";
import type { SpendHold } from "../src/contracts/spend.ts";
import type { CurrentUnit } from "../src/contracts/status-snapshot.ts";
import { MANUAL_RUN, parseManualRunMessage } from "../src/manual-run.ts";
import { askDrop, watchDrop, type DropWatcherDeps } from "./file-drop.ts";
import {
  createObserveDispatcher,
  observeAckDir,
  observeDropDir,
  parseObserveBody,
  watchObserveDrop,
  type ObserveDispatcher,
} from "./observe.ts";
import type { SupervisedPipeline } from "./pipelines.ts";

const NOW = Date.parse("2026-11-25T12:00:00.000Z");

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function pipelineOf(slug: string | null, name: string, kinds: string[]): SupervisedPipeline {
  const tenantId = `/workspace/${slug ?? "solo"}`;
  return {
    id: `${tenantId}#${name}`,
    tenant: {
      id: tenantId,
      slug,
      dir: tenantId,
      configPath: `${tenantId}/phoebe.config.ts`,
      envPath: `${tenantId}/.env`,
      gitIdentity: null,
    },
    pipeline: {
      name,
      disabled: false,
      priority: 0,
      concurrency: 1,
      needsClone: true,
      env: [],
      kinds,
      fingerprint: "fp",
    },
    enumerated: true,
    siblingEnv: [],
  };
}

/** A child that records what it was sent and can exit. */
class FakeChild extends EventEmitter {
  sent: unknown[] = [];
  closed = false;
  send(message: unknown, callback?: (error: Error | null) => void): void {
    if (this.closed) throw new Error("channel closed");
    this.sent.push(message);
    callback?.(null);
  }
}

type Cell = {
  pipeline: SupervisedPipeline;
  tenant?: string;
  running?: CurrentUnit[];
  hold?: SpendHold;
};

/** The report as the dispatcher reads it: the live cells and their snapshots. */
function reportOf(cells: readonly Cell[]): DeploymentReport {
  return {
    fleet: {
      cells: cells.map(({ pipeline, tenant, running, hold }) => ({
        id: pipeline.id,
        ...(hold !== undefined ? { spend: { hold, warnings: [] } } : {}),
        snapshot: {
          tenant: tenant ?? pipeline.tenant.slug ?? "acme/solo",
          pipeline: pipeline.pipeline.name,
          currentUnits: running ?? [],
          waitingForSlot: false,
          lastError: null,
          lastTimeoutAt: null,
          updatedAt: "2026-11-25T11:59:00.000Z",
        },
      })),
    },
  } as unknown as DeploymentReport;
}

function harness(cells: Cell[], opts: { stopped?: FleetStop } = {}) {
  const logged: string[] = [];
  const state = { cells, stopped: opts.stopped ?? null };
  const dispatcher = createObserveDispatcher({
    stopped: () => state.stopped,
    report: () => reportOf(state.cells),
    now: () => NOW,
    log: (line) => logged.push(line),
  });
  return { dispatcher, logged, state };
}

const widget = pipelineOf("acme/widget", "observe", ["observer"]);
const widgetWork = pipelineOf("acme/widget", "work", ["issues", "reviews"]);
const gadget = pipelineOf("acme/gadget", "observe", ["observer"]);

describe("the observe handler", () => {
  test("refuses a run while a spend ceiling holds the observer, naming the ceiling (#990)", () => {
    const hold: SpendHold = {
      scope: "tenant",
      measure: "usd",
      window: "24h",
      limit: 20,
      spent: 21.5,
      since: "2026-11-25T10:00:00.000Z",
      releaseAt: "2026-11-26T08:00:00.000Z",
    };
    const { dispatcher } = harness([{ pipeline: widget, hold }]);
    const observer = new FakeChild();
    dispatcher.attach(widget, observer);

    const answer = dispatcher.request({ tenant: null, lookback: null, by: "shell" });

    expect(answer.outcome).toBe("refused");
    expect(answer.tenant).toBe("acme/widget");
    expect(answer.detail).toContain("the observer pipeline for acme/widget (observe) is held");
    expect(answer.detail).toContain("`spend.ceiling.usd24h`");
    expect(answer.detail).toContain("2026-11-26T08:00:00.000Z");
    expect(observer.sent).toEqual([]);
  });

  test("forwards a run to the one tenant's observer pipeline without --tenant", () => {
    const { dispatcher, logged } = harness([{ pipeline: widget }, { pipeline: widgetWork }]);
    const observer = new FakeChild();
    const work = new FakeChild();
    dispatcher.attach(widget, observer);
    dispatcher.attach(widgetWork, work);

    const answer = dispatcher.request({ tenant: null, lookback: "3d", by: "shell" });

    expect(answer).toEqual({
      outcome: "started",
      tenant: "acme/widget",
      detail: "observer run started for acme/widget (pipeline observe), over the last 3d.",
    });
    expect(work.sent).toEqual([]);
    expect(observer.sent).toEqual([
      {
        type: MANUAL_RUN,
        run: { kind: "observer", by: "shell", at: "2026-11-25T12:00:00.000Z", lookback: "3d" },
      },
    ]);
    // What the child reads back off the channel is the same run.
    expect(parseManualRunMessage(observer.sent[0])).toEqual({
      kind: "observer",
      by: "shell",
      at: "2026-11-25T12:00:00.000Z",
      lookback: "3d",
    });
    expect(logged).toEqual([
      "[phoebe] boot: observer run for acme/widget asked for by shell, over the last 3d.",
    ]);
  });

  test("with no lookback the run keeps the configured one", () => {
    const { dispatcher } = harness([{ pipeline: widget }]);
    const child = new FakeChild();
    dispatcher.attach(widget, child);
    const answer = dispatcher.request({ tenant: "acme/widget", lookback: null, by: "shell" });
    expect(answer.detail).toBe(
      "observer run started for acme/widget (pipeline observe), over its configured lookback.",
    );
    expect(parseManualRunMessage(child.sent[0])?.lookback).toBeNull();
  });

  test("needs --tenant only when more than one tenant declares the observer", () => {
    const { dispatcher } = harness([{ pipeline: widget }, { pipeline: gadget }]);
    const widgetChild = new FakeChild();
    const gadgetChild = new FakeChild();
    dispatcher.attach(widget, widgetChild);
    dispatcher.attach(gadget, gadgetChild);

    expect(dispatcher.request({ tenant: null, lookback: null, by: "shell" })).toEqual({
      outcome: "refused",
      detail: "2 tenants declare the observer (acme/gadget, acme/widget). Name one with --tenant.",
    });
    expect(dispatcher.request({ tenant: "acme/gadget", lookback: null, by: "shell" }).outcome).toBe(
      "started",
    );
    expect(widgetChild.sent).toEqual([]);
    expect(gadgetChild.sent).toHaveLength(1);
  });

  test("a solo tenant is named by the repo its engine reports", () => {
    const solo = pipelineOf(null, "observe", ["observer"]);
    const { dispatcher } = harness([{ pipeline: solo, tenant: "acme/solo" }]);
    dispatcher.attach(solo, new FakeChild());
    expect(dispatcher.request({ tenant: "acme/solo", lookback: null, by: "shell" }).tenant).toBe(
      "acme/solo",
    );
  });

  describe("refuses, never queues", () => {
    test("when the fleet is stopped", () => {
      const { dispatcher } = harness([{ pipeline: widget }], {
        stopped: { by: "device:phone", at: "2026-11-25T10:00:00.000Z" },
      });
      const child = new FakeChild();
      dispatcher.attach(widget, child);
      expect(dispatcher.request({ tenant: null, lookback: null, by: "shell" })).toEqual({
        outcome: "refused",
        detail:
          "the fleet is stopped (by device:phone at 2026-11-25T10:00:00.000Z), so nothing " +
          "would run it. Start the fleet first.",
      });
      expect(child.sent).toEqual([]);
    });

    test("when no tenant declares the observer", () => {
      const { dispatcher } = harness([{ pipeline: widgetWork }]);
      dispatcher.attach(widgetWork, new FakeChild());
      expect(dispatcher.request({ tenant: null, lookback: null, by: "shell" })).toEqual({
        outcome: "refused",
        detail: "no tenant on this deployment declares the observer kind.",
      });
    });

    test("when the named tenant does not declare it", () => {
      const { dispatcher } = harness([{ pipeline: widget }]);
      const child = new FakeChild();
      dispatcher.attach(widget, child);
      expect(dispatcher.request({ tenant: "acme/gadget", lookback: null, by: "shell" })).toEqual({
        outcome: "refused",
        detail:
          "acme/gadget does not declare the observer kind. The tenant that does is acme/widget.",
      });
      expect(child.sent).toEqual([]);
    });

    test("when a pipeline that ran the observer has left the fleet", () => {
      const { dispatcher, state } = harness([{ pipeline: widget }]);
      dispatcher.attach(widget, new FakeChild());
      state.cells = [];
      expect(dispatcher.request({ tenant: null, lookback: null, by: "shell" }).detail).toBe(
        "no tenant on this deployment declares the observer kind.",
      );
    });

    test("when a run is in flight for that tenant, with its start time", () => {
      const startedAt = "2026-11-25T11:58:00.000Z";
      const { dispatcher } = harness([
        {
          pipeline: widget,
          running: [
            {
              unit: { kind: "observer", id: "observer" },
              startedAt,
              runBudgetMs: null,
              provider: null,
              model: null,
              effort: null,
            },
          ],
        },
      ]);
      const child = new FakeChild();
      dispatcher.attach(widget, child);
      expect(dispatcher.request({ tenant: null, lookback: null, by: "shell" })).toEqual({
        outcome: "refused",
        tenant: "acme/widget",
        runningSince: startedAt,
        detail: `an observer run is already in flight for acme/widget, started at ${startedAt}.`,
      });
      expect(child.sent).toEqual([]);
    });

    test("when the observer pipeline's child is down", () => {
      const { dispatcher } = harness([{ pipeline: widget }]);
      const child = new FakeChild();
      dispatcher.attach(widget, child);
      child.emit("exit", 1, null);
      expect(dispatcher.request({ tenant: null, lookback: null, by: "shell" })).toEqual({
        outcome: "refused",
        tenant: "acme/widget",
        detail:
          "the observer pipeline for acme/widget (observe) is not running right now. " +
          "Try again once it is back up.",
      });
      // Its replacement is the one asked.
      const respawned = new FakeChild();
      dispatcher.attach(widget, respawned);
      expect(dispatcher.request({ tenant: null, lookback: null, by: "shell" }).outcome).toBe(
        "started",
      );
      expect(respawned.sent).toHaveLength(1);
    });

    test("when the channel is already closed", () => {
      const { dispatcher } = harness([{ pipeline: widget }]);
      const child = new FakeChild();
      child.closed = true;
      dispatcher.attach(widget, child);
      expect(dispatcher.request({ tenant: null, lookback: null, by: "shell" })).toEqual({
        outcome: "refused",
        tenant: "acme/widget",
        detail: "the observer pipeline for acme/widget could not be reached: channel closed.",
      });
    });

    test("when the lookback is not a period", () => {
      const { dispatcher } = harness([{ pipeline: widget }]);
      const child = new FakeChild();
      dispatcher.attach(widget, child);
      expect(dispatcher.request({ tenant: null, lookback: "two weeks", by: "shell" })).toEqual({
        outcome: "refused",
        detail: '`lookback` must be a period like "14d" or "36h" — got "two weeks".',
      });
      expect(child.sent).toEqual([]);
    });
  });
});

describe("parseObserveBody", () => {
  test("takes absent, null or non-empty strings, and nothing else", () => {
    expect(parseObserveBody({})).toEqual({ tenant: null, lookback: null });
    expect(parseObserveBody({ tenant: "acme/widget", lookback: null })).toEqual({
      tenant: "acme/widget",
      lookback: null,
    });
    expect(parseObserveBody({ tenant: "" })).toBeNull();
    expect(parseObserveBody({ lookback: 3 })).toBeNull();
    expect(parseObserveBody([])).toBeNull();
    expect(parseObserveBody(null)).toBeNull();
  });
});

describe("the observe drop", () => {
  function dropHarness(dispatcher: ObserveDispatcher) {
    const dataBase = mkdtempSync(join(tmpdir(), "phoebe-observe-"));
    dirs.push(dataBase);
    const watcher = watchObserveDrop({
      dataBase,
      dispatcher,
      watch: watchDropForTest,
    });
    let asks = 0;
    const ask = (content: string) =>
      askDrop(`nonce${++asks}`, content, {
        dir: observeDropDir(dataBase),
        ackDir: observeAckDir(dataBase),
        waitMs: 1_000,
        sleep: async () => watcher.scan(),
      });
    return { dataBase, watcher, ask };
  }

  test("acks a started run with the handler's words and leaves the drop empty", async () => {
    const { dispatcher } = harness([{ pipeline: widget }]);
    const child = new FakeChild();
    dispatcher.attach(widget, child);
    const { dataBase, watcher, ask } = dropHarness(dispatcher);

    const answer = await ask(JSON.stringify({ tenant: null, lookback: "7d" }));

    expect(answer).toEqual({
      kind: "ok",
      detail: "observer run started for acme/widget (pipeline observe), over the last 7d.",
    });
    expect(parseManualRunMessage(child.sent[0])?.by).toBe("shell");
    expect(readdirSync(observeDropDir(dataBase))).toEqual([]);
    expect(readdirSync(observeAckDir(dataBase))).toEqual([]);
    watcher.stop();
  });

  test("acks a refusal with its reason", async () => {
    const { dispatcher } = harness([{ pipeline: widgetWork }]);
    const { watcher, ask } = dropHarness(dispatcher);
    expect(await ask(JSON.stringify({}))).toEqual({
      kind: "refused",
      detail: "no tenant on this deployment declares the observer kind.",
    });
    expect(await ask("not json")).toEqual({
      kind: "refused",
      detail: "the drop file is not an observe request",
    });
    watcher.stop();
  });
});

/** `watchDrop` on the real file system, with no watch and no timer: the test scans. */
function watchDropForTest(deps: DropWatcherDeps) {
  return watchDrop({
    ...deps,
    fs: { watch: () => null },
    setInterval: () => ({ clear: () => {} }),
  });
}
