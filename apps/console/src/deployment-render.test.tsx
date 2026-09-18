// What the three tabs put on screen.
//
// Static markup, no DOM and no jsdom, for the reason the fleet's render test
// gives: these are pure components over values `deployment-facts.ts` already
// derived, so the markup is the whole output.
//
// The assertions are the ones the page would be wrong without — the connection
// panel staying out of doctor's way, two lines per pipeline, a unit counted
// against the budget it was given, doctor's four verdicts each legible, and a
// deployment that has never connected saying so instead of drawing three empty
// tabs.

import { describe, expect, test } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";
import { DeploymentPage, NoSuchDeployment } from "./deployment-page.tsx";
import { rowFacts } from "./facts.ts";
import type { DeploymentTab } from "./route.ts";
import {
  ago,
  cell,
  check,
  child,
  doctor,
  NOW,
  report,
  row,
  snapshot,
  stored,
  stubClient,
  tenant,
} from "./test-fixture.ts";

/** One deployment with something to say on every tab. */
const BUSY = report({
  bootstrapper: {
    ...report().bootstrapper,
    engineRef: "v0.13.0",
    engineSha: "dd6f67d",
    quarantinedSha: "c0ffee1",
    crashLoop: { lastGoodSha: "dd6f67d", failingSha: "c0ffee1", failureCount: 3 },
    reconcile: { phase: "reconciling", reason: "config", since: ago(30) },
    slots: { capacity: 2, inUse: 2, waiting: 3, overGranted: 1, floorBudget: 2 },
    children: [
      child({ id: "/etc/phoebe#work", since: ago(9 * 86_400) }),
      child({ id: "apps/web#work", restarts: 11, crashLooping: true, since: ago(20) }),
    ],
    updatedAt: ago(12),
  },
  fleet: {
    tenants: [
      tenant(),
      tenant({ id: "apps/web", path: "apps/web", slug: "JesusFilm/web" }),
      tenant({
        id: "apps/legacy",
        path: "apps/legacy",
        slug: null,
        held: true,
        reason: 'unknown provider "claude-code-v1"',
      }),
    ],
    cells: [
      cell({ state: "working", concurrency: 2, snapshot: snapshot() }),
      cell({
        id: "apps/web#work",
        tenant: tenant({ id: "apps/web", path: "apps/web", slug: "JesusFilm/web" }),
        state: "idle",
        disabled: true,
        wedged: { wedged: true, reason: "no-pass", noPassForMs: 1_020_000 },
      }),
    ],
    updatedAt: ago(12),
  },
  doctor: doctor({
    report: {
      checks: [
        check({ id: "cli" }),
        check({ id: "engine", state: "fail", detail: "c0ffee1 quarantined after 3 failures" }),
        check({ id: "relay", state: "warn", detail: "remove PHOEBE_RELAY_TOKEN from .env" }),
      ],
      tenants: [
        {
          path: "apps/web",
          slug: "JesusFilm/web",
          checks: [check({ id: "token", state: "unknown", detail: "deadline passed" })],
        },
      ],
      ok: false,
    },
    at: ago(6 * 3600),
    trigger: "boot",
    running: { since: ago(40), trigger: "reconcile" },
    lastAttempt: { at: ago(12 * 3600), outcome: "timed-out" },
  }),
  edits: [
    {
      id: "edit_01J9",
      file: "phoebe.config.ts",
      path: "pipelines.work.maxConcurrentUnits",
      value: 2,
      at: ago(3600),
      by: "mike@example.org",
    },
  ],
});

const BUSY_FACTS = rowFacts(row({ name: "jesusfilm-workspace" }), stored(BUSY));

function render(tab: DeploymentTab, facts = BUSY_FACTS): string {
  return renderToStaticMarkup(
    <DeploymentPage facts={facts} tab={tab} now={NOW} client={stubClient()} />,
  );
}

const overview = render("overview");
const pipelines = render("pipelines");
const doctorTab = render("doctor");

describe("the tabs", () => {
  test("names the tabs the console answers, and links each one", () => {
    // Overview is the bare deployment URL, so one deployment has one address.
    expect(overview).toContain(`href="#/d/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA">overview<`);
    for (const tab of ["pipelines", "doctor", "secrets"]) {
      expect(overview, tab).toContain(`href="#/d/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/${tab}"`);
    }
  });

  test("does not offer a tab nothing answers yet", () => {
    // Config is #545; a tab that opens nothing is a dead end.
    expect(overview).not.toContain(">config<");
  });

  test("marks the current tab for a screen reader, not only with a colour", () => {
    expect(doctorTab).toContain('aria-current="page"');
  });
});

describe("the overview", () => {
  test("keeps the relay's connection facts in their own panel, apart from doctor", () => {
    expect(overview).toContain('aria-label="Connection"');
    expect(overview).toContain("Doctor answers none of them");
    // The panel's facts are the relay's, and none of them is in the report.
    expect(overview).toContain("last heard");
    expect(overview).toContain("ada@example.test");
  });

  test("names the engine ref, the running sha and the commit it is avoiding", () => {
    expect(overview).toContain("v0.13.0 → dd6f67d");
    expect(overview).toContain("running away from c0ffee1");
    expect(overview).toContain("c0ffee1 failed 3 times; running dd6f67d");
  });

  test("says what the bootstrapper is relaunching onto and why", () => {
    expect(overview).toContain("reconciling (config) for 30 s");
  });

  test("shows the slot broker's numbers, over-cap grants included", () => {
    expect(overview).toContain("2/2 in use, 3 waiting, 1 over cap");
  });

  test("gives each pipeline its process line and its state line", () => {
    expect(overview).toContain("Pipelines at a glance");
    expect(overview).toContain("running 9 d");
    expect(overview).toContain("working 1/2");
    expect(overview).toContain("11 restarts, crash-looping");
    expect(overview).toContain("wedged? no pass for 17 min");
  });

  test("names a held tenant and the error holding it", () => {
    expect(overview).toContain("Held tenants");
    expect(overview).toContain("apps/legacy");
    expect(overview).toContain("unknown provider");
  });

  test("lists the edits that are in the file and not yet in a commit", () => {
    expect(overview).toContain("Edits not yet in a commit");
    expect(overview).toContain("pipelines.work.maxConcurrentUnits");
    expect(overview).toContain("mike@example.org");
  });

  test("a deployment with no edit ledger shows no edits panel at all", () => {
    const quiet = rowFacts(row(), stored(report()));
    expect(render("overview", quiet)).not.toContain("Edits not yet in a commit");
  });
});

describe("the pipelines tab", () => {
  test("gives one row per pipeline, with both lines on it", () => {
    expect(pipelines).toContain("running 9 d");
    expect(pipelines).toContain("working 1/2");
  });

  test("counts the units in flight against the budget each was given", () => {
    expect(pipelines).toContain("issues 544");
    expect(pipelines).toContain("10 min / 1 h");
  });

  test("names the wedged clause beside the state it contradicts", () => {
    expect(pipelines).toContain("wedged? no pass for 17 min");
  });

  test("marks a disabled pipeline rather than leaving it looking idle", () => {
    expect(pipelines).toContain(">disabled<");
  });

  test("keeps a held tenant on screen even though it fills no row", () => {
    expect(pipelines).toContain("apps/legacy");
    expect(pipelines).toContain("held: unknown provider");
  });
});

describe("the doctor tab", () => {
  test("shows a deployment check and a per-tenant check, kept apart", () => {
    expect(doctorTab).toContain(">Deployment<");
    expect(doctorTab).toContain(">apps/web<");
    expect(doctorTab).toContain("c0ffee1 quarantined after 3 failures");
    expect(doctorTab).toContain("deadline passed");
  });

  test("gives each of the four verdicts its own chip", () => {
    for (const state of ["ok", "fail", "warn", "unknown"]) {
      expect(doctorTab, state).toContain(`chip check ${state}`);
    }
  });

  test("carries the trigger, the age, the running marker and the last attempt", () => {
    expect(doctorTab).toContain("doctor running 40 s (reconcile)");
    expect(doctorTab).toContain("6 h ago");
    expect(doctorTab).toContain("Last attempt timed-out 12 h ago");
  });

  test("a deployment that has never run doctor says so, and calls it a fact", () => {
    const never = rowFacts(
      row(),
      stored(report({ doctor: doctor({ report: null, at: null, trigger: null }) })),
    );
    const markup = render("doctor", never);
    expect(markup).toContain("doctor never run");
    expect(markup).toContain("never produced a doctor report");
    expect(markup).not.toContain("chip check");
  });
});

describe("a deployment that has never connected", () => {
  const unseen = rowFacts(
    row({
      name: "phoebe-demo",
      state: "unseen",
      connectedSince: null,
      lastSeen: null,
      firstSeen: ago(3 * 86_400),
    }),
    null,
  );

  test("the overview says which kind of nothing this is, not an empty panel", () => {
    const markup = render("overview", unseen);
    expect(markup).toContain("has never connected");
    expect(markup).toContain("3 d ago");
    expect(markup).not.toContain("Pipelines at a glance");
  });

  test("the connection panel still answers, because the relay's facts are still true", () => {
    const markup = render("overview", unseen);
    expect(markup).toContain('aria-label="Connection"');
    expect(markup).toContain("unseen");
    expect(markup).toContain("last heard");
  });

  test("pipelines and doctor say why they are empty and point back at the overview", () => {
    for (const tab of ["pipelines", "doctor"] as const) {
      const markup = render(tab, unseen);
      expect(markup, tab).toContain("has never connected");
      expect(markup, tab).toContain("#/d/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    }
  });

  test("a report this console cannot read is its own kind of nothing", () => {
    const ahead = rowFacts(row(), stored(report(), { schema: 99 }));
    const markup = render("pipelines", ahead);
    expect(markup).toContain("schema 99");
    expect(markup).toContain("newer than this console reads");
  });
});

describe("a fingerprint the fleet does not hold", () => {
  test("says so rather than quietly becoming the fleet page", () => {
    const markup = renderToStaticMarkup(<NoSuchDeployment fingerprint="GONE" />);
    expect(markup).toContain("No such deployment");
    expect(markup).toContain("GONE");
  });
});
