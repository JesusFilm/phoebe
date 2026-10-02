// The derivations behind the three tabs, tested apart from the markup.
//
// The assertions worth having are the ones where the page could tell a lie: a
// process line that claims a child where there is none, a state line that counts
// units against the wrong number, a wedged clause that quotes a clock it must not
// quote, and the slot line that would otherwise print a permanent "0 over cap".

import { describe, expect, test } from "vite-plus/test";
import {
  crashLoopLine,
  enumeratedRows,
  processLine,
  reconcileLine,
  slotsLine,
  stateLine,
  tenantRows,
  unitLines,
  wedgedLine,
} from "./deployment-facts.ts";
import { ago, cell, child, NOW, report, snapshot, tenant } from "./test-fixture.ts";

describe("the process line", () => {
  test("a cell with no child is not supervised, which is not the same as stopped", () => {
    expect(processLine(undefined, NOW)).toBe("not supervised");
  });

  test("a running child carries a duration, not an age", () => {
    expect(processLine(child({ since: ago(3600) }), NOW)).toBe("running 1 h");
  });

  test("an exited child carries an age, because it already happened", () => {
    const line = processLine(
      child({
        state: "exited",
        since: ago(120),
        lastExit: { code: 1, signal: null, at: ago(120) },
      }),
      NOW,
    );
    expect(line).toBe("exited (code 1) 2 min ago");
  });

  test("a signal is named rather than turned into a number", () => {
    const line = processLine(
      child({
        state: "exited",
        since: ago(60),
        lastExit: { code: null, signal: "SIGKILL", at: ago(60) },
      }),
      NOW,
    );
    expect(line).toContain("exited on SIGKILL");
  });

  test("restarts and the crash-loop mark ride on the same line", () => {
    expect(processLine(child({ restarts: 11, crashLooping: true }), NOW)).toContain(
      "11 restarts, crash-looping",
    );
  });
});

describe("the state line", () => {
  test("working counts the snapshot's units against the declared concurrency", () => {
    expect(stateLine(cell({ state: "working", concurrency: 3, snapshot: snapshot() }))).toBe(
      "working 1/3",
    );
  });

  test("an undeclared concurrency drops the denominator rather than inventing one", () => {
    expect(stateLine(cell({ state: "working", concurrency: null, snapshot: snapshot() }))).toBe(
      "working 1",
    );
  });

  test("every other state is the word the report derived, unadorned", () => {
    expect(stateLine(cell({ state: "waiting for slot" }))).toBe("waiting for slot");
    expect(stateLine(cell({ state: "no status" }))).toBe("no status");
  });
});

describe("units in flight against their budget", () => {
  test("a unit inside its budget says so without a warning", () => {
    const [unit] = unitLines(cell({ snapshot: snapshot() }), NOW);
    expect(unit).toEqual({
      ref: "issues 544",
      running: "10 min",
      budget: "1 h",
      overBudget: false,
    });
  });

  test("a unit past its budget is marked, and that is not the wedged verdict", () => {
    const overdue = snapshot({
      currentUnits: [
        { unit: { kind: "issues", id: "544" }, startedAt: ago(7200), runBudgetMs: 3_600_000 },
      ],
    });
    const [unit] = unitLines(cell({ snapshot: overdue, wedged: { wedged: false } }), NOW);
    expect(unit?.overBudget).toBe(true);
    // The deployment said it is not wedged; the console does not overrule it.
    expect(wedgedLine(cell({ snapshot: overdue, wedged: { wedged: false } }))).toBeNull();
  });

  test("a kind with no run budget says so rather than showing a zero", () => {
    const unbudgeted = snapshot({
      currentUnits: [{ unit: { kind: "checks", id: "77" }, startedAt: ago(60), runBudgetMs: null }],
    });
    const [unit] = unitLines(cell({ snapshot: unbudgeted }), NOW);
    expect(unit).toMatchObject({ budget: null, overBudget: false });
  });

  test("a pipeline with no snapshot has no units, rather than throwing", () => {
    expect(unitLines(cell({ snapshot: null }), NOW)).toEqual([]);
  });
});

describe("the wedged clause", () => {
  test("names the budget clause without pretending to know which unit", () => {
    expect(wedgedLine(cell({ wedged: { wedged: true, reason: "unit-overdue" } }))).toBe(
      "wedged? a unit is past its budget",
    );
  });

  test("quotes the silence the report stamped, never lastPassAt as an age", () => {
    const line = wedgedLine(
      cell({ wedged: { wedged: true, reason: "no-pass", noPassForMs: 1_020_000 } }),
    );
    expect(line).toBe("wedged? no pass for 17 min");
  });
});

describe("the bootstrapper's lines", () => {
  test("reconcile says idle for, or what it is relaunching onto and why", () => {
    expect(reconcileLine(report(), NOW)).toBe("idle for 1 h");
    const moving = report({
      bootstrapper: {
        ...report().bootstrapper,
        reconcile: { phase: "reconciling", reason: "config", since: ago(30) },
      },
    });
    expect(reconcileLine(moving, NOW)).toBe("reconciling (config) for 30 s");
  });

  test("slots name the waiting and the over-cap grants only when there are any", () => {
    expect(slotsLine(report())).toBe("1/2 in use");
    const strained = report({
      bootstrapper: {
        ...report().bootstrapper,
        slots: { capacity: 2, inUse: 2, waiting: 3, overGranted: 1, floorBudget: 2 },
      },
    });
    expect(slotsLine(strained)).toBe("2/2 in use, 3 waiting, 1 over cap");
  });

  test("a crash-loop record with nothing failing has no line at all", () => {
    expect(crashLoopLine(report())).toBeNull();
  });

  test("a failing commit says how many times and what is running instead", () => {
    const quarantined = report({
      bootstrapper: {
        ...report().bootstrapper,
        crashLoop: { lastGoodSha: "9994052", failingSha: "c0ffee1", failureCount: 3 },
      },
    });
    expect(crashLoopLine(quarantined)).toBe("c0ffee1 failed 3 times; running 9994052");
  });
});

describe("the tenant rows", () => {
  const held = tenant({
    id: "/etc/phoebe/apps/legacy",
    path: "apps/legacy",
    slug: null,
    held: true,
    reason: "phoebe.config.ts: unknown provider",
  });

  const twoTenants = report({
    fleet: {
      tenants: [tenant(), held],
      cells: [cell(), cell({ id: "/etc/phoebe#stale", pipeline: "stale", source: "stale" })],
      updatedAt: ago(12),
    },
  });

  test("a held tenant with no pipeline is still a row", () => {
    const rows = tenantRows(twoTenants);
    expect(rows.map((row) => row.tenant.path)).toEqual(["/etc/phoebe", "apps/legacy"]);
    expect(rows[1]?.pipelines).toEqual([]);
  });

  test("the pipelines tab keeps the stale cells the fleet bar drops", () => {
    expect(tenantRows(twoTenants)[0]?.pipelines.map((row) => row.cell.pipeline)).toEqual([
      "work",
      "stale",
    ]);
    expect(enumeratedRows(twoTenants).map((row) => row.cell.pipeline)).toEqual(["work"]);
  });

  test("each row carries its own child, and none where the bootstrapper has none", () => {
    const rows = tenantRows(twoTenants)[0]?.pipelines ?? [];
    expect(rows[0]?.child?.id).toBe("/etc/phoebe#work");
    expect(rows[1]?.child).toBeUndefined();
  });
});
