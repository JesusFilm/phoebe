// What the three tabs put on screen.
//
// Static markup, no DOM and no jsdom, for the reason the fleet's render test
// gives: these are pure components over values `deployment-facts.ts` already
// derived, so the markup is the whole output.
//
// The assertions are the ones the page would be wrong without — the connection
// panel staying out of doctor's way, two lines per pipeline, a unit counted
// against the budget it was given, doctor's four verdicts each legible, the
// config table keeping `via` out of the row and the shadowed value under its
// winner, and a deployment that has never connected saying so instead of
// drawing four empty tabs.

import { describe, expect, test } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";
import { DeploymentPage, NoSuchDeployment } from "./deployment-page.tsx";
import { rowFacts } from "./facts.ts";
import type { DeploymentTab } from "./route.ts";
import {
  ago,
  cell,
  check,
  client,
  child,
  configReport,
  doctor,
  effectiveConfig,
  NOW,
  report,
  row,
  snapshot,
  stored,
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
    <DeploymentPage facts={facts} tab={tab} client={client()} now={NOW} />,
  );
}

/**
 * The same page with a way to edit (#547). Separate from `render` so every
 * assertion above still reads the tab a console with no seam draws — which is
 * what the companion's renderer gets until its own seam lands (#553).
 */
function renderEditable(facts = BUSY_FACTS): string {
  return renderToStaticMarkup(
    <DeploymentPage
      facts={facts}
      tab="config"
      client={client()}
      now={NOW}
      onEdit={() => Promise.reject(new Error("no test presses this"))}
    />,
  );
}

const overview = render("overview");
const pipelines = render("pipelines");
const doctorTab = render("doctor");
const config = render("config");

describe("the tabs", () => {
  test("names the tabs the console answers, and links each one", () => {
    // Overview is the bare deployment URL, so one deployment has one address.
    expect(overview).toContain(`href="#/d/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA">overview<`);
    for (const tab of ["pipelines", "doctor", "config", "secrets"]) {
      expect(overview, tab).toContain(`href="#/d/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/${tab}"`);
    }
  });

  test("does not offer a tab nothing answers yet", () => {});

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

  test("offers the run, because a connected deployment can be asked (#546)", () => {
    expect(doctorTab).toContain('aria-label="Run doctor"');
    expect(doctorTab).toContain(">Run doctor<");
    expect(doctorTab).not.toContain("disabled");
  });

  test("is disabled with the reason when the relay is not holding the connection", () => {
    const gone = rowFacts(
      row({ state: "dark", connectedSince: null, lastSeen: ago(2 * 86_400) }),
      stored(report()),
    );
    const markup = render("doctor", gone);

    expect(markup).toContain("disabled");
    expect(markup).toContain("has been dark");
    expect(markup).toContain("would come back undelivered");
  });
});

describe("the config tab", () => {
  test("gives every leaf a row, with the path spelled the way the file has it", () => {
    expect(config).toContain("pipelines.work.kinds.research.model");
    expect(config).toContain("repoSlug");
  });

  test("shows the source chip on every row", () => {
    for (const source of ["file", "overlay", "alias", "inherited", "derived", "default"]) {
      expect(config, source).toContain(`chip src ${source}`);
    }
  });

  test("keeps via and from out of the row, and inside the disclosure", () => {
    // The resolution (#509): the chip is enough inline; `via` and `from` are on
    // hover or expand. Both here — the summary's title and the open body.
    expect(config).toContain('title="via PHOEBE_WORK_CONCURRENCY · read from tenantEnv"');
    expect(config).toContain("<details");
    expect(config).toContain("read by bootstrapper");
  });

  test("puts a shadowed value under the winner, with what shadowed it", () => {
    expect(config).toContain("shadowed:");
    expect(config).toContain("(file via phoebe.config.ts)");
  });

  test("counts each source in a chip that filters by it", () => {
    expect(config).toContain("file 3");
    expect(config).toContain("overlay 1");
    expect(config).toContain('aria-pressed="false"');
  });

  test("puts the warnings above the table, not in a row of it", () => {
    const warning = config.indexOf("workOrder is the old name");
    expect(warning).toBeGreaterThan(-1);
    expect(warning).toBeLessThan(config.indexOf("<table"));
  });

  test("shows the fingerprint of the file an edit would check itself against", () => {
    expect(config).toContain("/etc/phoebe/phoebe.config.ts");
    expect(config).toContain("sha256:9f2c1b7e");
  });

  test("prints an opaque value as the summary it is, not as JSON", () => {
    expect(config).toContain("a compose file and two mounts");
    expect(config).toContain(">opaque<");
  });

  test("a tenant whose settings are unknown says so instead of drawing a table", () => {
    const held = render(
      "config",
      rowFacts(
        row(),
        stored(
          report({
            config: configReport({
              tenants: [
                effectiveConfig({
                  tenant: "JesusFilm/legacy",
                  error: 'unknown provider "claude-code-v1"',
                  fields: null,
                  env: null,
                  warnings: [],
                }),
              ],
            }),
          }),
        ),
      ),
    );
    expect(held).toContain("unknown provider &quot;claude-code-v1&quot;");
    expect(held).not.toContain("<table");
    // The filter found nothing, but nothing is not what the filter did.
    expect(held).not.toContain("No leaf matches");
  });

  test("a config file that could not be read refuses the edit rather than hiding", () => {
    const unread = render(
      "config",
      rowFacts(
        row(),
        stored(
          report({
            config: configReport({ root: { path: "phoebe.config.ts", fingerprint: null } }),
          }),
        ),
      ),
    );
    expect(unread).toContain("could not be read");
  });

  test("offers no edit column at all when this console has no way to write", () => {
    expect(config).not.toContain("<th>edit</th>");
    expect(config).not.toContain(">Edit<");
  });

  test("a report with no config section says which kind of nothing that is", () => {
    const older = render("config", rowFacts(row(), stored(report({ config: undefined }))));
    expect(older).toContain("no config section");
    expect(older).not.toContain("<table");
  });
});

describe("the edit affordance on the config tab (#503, #547)", () => {
  const editable = renderEditable();

  test("a leaf `config set` accepts carries an Edit, and the column says so", () => {
    expect(editable).toContain("<th>edit</th>");
    expect(editable).toContain(">Edit<");
  });

  test("a leaf env decides says why instead, and names the variable", () => {
    expect(editable).toContain("not editable");
    expect(editable).toContain(
      "PHOEBE_WORK_CONCURRENCY` sets this in the deployment&#x27;s environment",
    );
  });

  test("every closed leaf carries the manual edit and the verb to run", () => {
    expect(editable).toContain("by hand.");
    expect(editable).toContain("phoebe config set");
    // The engine pin is closed for a reason of its own, and it says which.
    expect(editable).toContain("phoebe upgrade");
  });

  test("a work kind's own setting is editable even though its declaration is not", () => {
    // Both are in the fixture's tree: `kinds.research` is a block, and
    // `kinds.research.model` is a literal inside it.
    const rows = editable.split("<tr>");
    const model = rows.find((cell) => cell.includes("kinds.research.model"));
    expect(model).toBeDefined();
    expect(model).toContain(">Edit<");
  });

  test("a tenant's own config is edited in its checkout, with that file in the command", () => {
    const workspace = renderEditable(
      rowFacts(
        row(),
        stored(
          report({
            config: configReport({
              root: { path: "/etc/phoebe/phoebe.config.ts", fingerprint: "sha256:root" },
              tenants: [
                effectiveConfig({
                  tenant: "JesusFilm/web",
                  configPath: "/etc/phoebe/children/web/phoebe.config.ts",
                }),
              ],
            }),
          }),
        ),
      ),
    );
    expect(workspace).not.toContain(">Edit<");
    expect(workspace).toContain("tenant&#x27;s own config");
    expect(workspace).toContain("--config /etc/phoebe/children/web/phoebe.config.ts");
  });

  test("a root config that could not be read closes every leaf, with the reason", () => {
    const unread = renderEditable(
      rowFacts(
        row(),
        stored(
          report({
            config: configReport({
              root: { path: "/etc/phoebe/phoebe.config.ts", fingerprint: null },
            }),
          }),
        ),
      ),
    );
    expect(unread).not.toContain(">Edit<");
    expect(unread).toContain("could not read its root config");
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

  test("the other tabs say why they are empty and point back at the overview", () => {
    for (const tab of ["pipelines", "doctor"] as const) {
      const markup = render(tab, unseen);
      expect(markup, tab).toContain("has never connected");
      expect(markup, tab).toContain("#/d/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    }
  });

  test("doctor keeps its button, disabled: there is nothing to ask until it boots", () => {
    const markup = render("doctor", unseen);
    expect(markup).toContain(">Run doctor<");
    expect(markup).toContain("disabled");
    expect(markup).toContain("nothing to ask until it boots");
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
