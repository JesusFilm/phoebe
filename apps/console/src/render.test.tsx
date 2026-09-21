// What the rail and the grid actually put on screen.
//
// Rendered to static markup rather than into a DOM, which needs no browser and no
// jsdom: these are pure components over the facts `facts.ts` rolled up, so the
// markup is the whole output. The assertions are the ones the page would be wrong
// without — the four connection words reading as four different things, one bar
// segment per pipeline, and a deployment that has never reported saying so.

import { describe, expect, test } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";
import { rowFacts, sortFleet } from "./facts.ts";
import { FleetPage } from "./fleet-page.tsx";
import { Rail } from "./rail.tsx";
import { ago, cell, child, client, NOW, report, row, stored, tenant } from "./test-fixture.ts";

/** The four states, one deployment each, plus one that is wedged. */
const FLEET = sortFleet([
  rowFacts(
    row({ fingerprint: "one", name: "youtube-studio" }),
    stored(
      report({
        bootstrapper: {
          ...report().bootstrapper,
          children: [child({ id: "a#research", crashLooping: true })],
        },
        fleet: {
          tenants: [tenant()],
          cells: [
            cell({ id: "a#work", state: "working" }),
            cell({ id: "a#research", pipeline: "research", state: "idle" }),
            cell({ id: "a#triage", pipeline: "triage", state: "waiting for slot", disabled: true }),
          ],
          updatedAt: ago(12),
        },
      }),
    ),
  ),
  rowFacts(
    row({
      fingerprint: "two",
      name: "jesusfilm-workspace",
      state: "disconnected",
      connectedSince: null,
      disconnectedForSeconds: 12,
    }),
    stored(
      report({
        fleet: {
          tenants: [tenant()],
          cells: [cell({ wedged: { wedged: true, reason: "unit-overdue" } })],
          updatedAt: ago(12),
        },
      }),
    ),
  ),
  rowFacts(
    row({
      fingerprint: "three",
      name: "youtube-studio",
      state: "dark",
      connectedSince: null,
      lastSeen: ago(2 * 86_400),
      maybeReplaced: true,
    }),
    null,
  ),
  rowFacts(
    row({
      fingerprint: "four",
      name: "phoebe-demo",
      state: "unseen",
      connectedSince: null,
      lastSeen: null,
      firstSeen: ago(3 * 86_400),
    }),
    null,
  ),
]);

const rail = renderToStaticMarkup(
  <Rail facts={FLEET} selected={null} now={NOW} surface="browser" signedIn />,
);
const grid = renderToStaticMarkup(<FleetPage facts={FLEET} client={client()} now={NOW} />);

describe("the rail", () => {
  test("lists every deployment in the sort order, dark first", () => {
    const names = [...rail.matchAll(/class="name">.*?<\/span>(.*?)</g)].map((match) => match[1]);

    // Dark first; then the two with something on them, by name; then the rest.
    expect(names).toEqual([
      "youtube-studio", // dark
      "jesusfilm-workspace", // a wedged pipeline
      "youtube-studio", // a crash-looping child
      "phoebe-demo", // unseen, nothing wrong
    ]);
  });

  test("gives each of the four words its own mark, not one mark in four shades", () => {
    for (const tone of ["connected", "disconnected", "dark", "unseen"]) {
      expect(rail, tone).toContain(`class="mark ${tone}"`);
    }
  });

  test("says how long a disconnected deployment has been quiet", () => {
    expect(rail).toContain("disconnected 12 s");
  });

  test("dark carries its age and unseen carries when it was paired", () => {
    expect(rail).toContain("dark 2 d");
    expect(rail).toContain("unseen");
    expect(rail).not.toContain("dark 0 s");
  });

  test("a probably-replaced link is marked, beside its word rather than instead of it", () => {
    expect(rail).toContain("replaced?");
  });

  test("names the counts that are true and none that are not", () => {
    expect(rail).toContain("1 wedged");
    expect(rail).toContain("1 crash-looping");
    expect(rail).not.toContain("0 wedged");
  });

  test("carries no score and no verdict word", () => {
    for (const word of ["score", "health", "needs attention"]) {
      expect(rail.toLowerCase(), word).not.toContain(word);
    }
  });

  test("every entry opens that deployment's tabs (#544)", () => {
    for (const fingerprint of ["one", "two", "three", "four"]) {
      expect(rail, fingerprint).toContain(`href="#/d/${fingerprint}"`);
    }
  });

  test("the entry being shown is marked for a screen reader too", () => {
    const selected = renderToStaticMarkup(
      <Rail facts={FLEET} selected="two" now={NOW} surface="browser" signedIn />,
    );
    expect(selected).toContain('aria-current="page"');
    expect(selected).toContain("rail-entry state-disconnected attention current");
  });
});

describe("the grid", () => {
  test("carries one Run doctor for the whole fleet, never disabled (#546)", () => {
    // The deployments the relay cannot reach are part of the answer — each one
    // refused undelivered by name — so there is nothing here to grey out.
    expect(grid).toContain('aria-label="Run doctor"');
    expect(grid).toContain(">Run doctor on every deployment<");
    expect(grid).not.toContain("disabled=");
  });

  test("draws one segment per enumerated pipeline", () => {
    const segments = [...grid.matchAll(/class="segment /g)];

    // Three on the connected deployment, one on the wedged one; the dark and
    // unseen deployments have no report and so no bar.
    expect(segments).toHaveLength(4);
  });

  test("colours a segment by the state the deployment derived", () => {
    expect(grid).toContain("segment working");
    expect(grid).toContain("segment wedged");
    expect(grid).toContain("segment crash-looping");
    expect(grid).toContain("segment waiting disabled");
  });

  test("an idle pipeline is a segment too, just a quiet one", () => {
    const markup = renderToStaticMarkup(
      <FleetPage
        facts={[
          rowFacts(
            row(),
            stored(
              report({
                fleet: {
                  tenants: [tenant()],
                  cells: [
                    cell({ state: "idle" }),
                    cell({ id: "a#new", pipeline: "new", state: "no status" }),
                  ],
                  updatedAt: ago(12),
                },
              }),
            ),
          ),
        ]}
        client={client()}
        now={NOW}
      />,
    );

    expect(markup).toContain("segment idle");
    expect(markup).toContain("segment no-status");
  });

  test("a tooltip names the tenant and pipeline behind a segment", () => {
    expect(grid).toContain('title="/etc/phoebe/work: working"');
  });

  test("a deployment that has never reported says which kind of nothing that is", () => {
    expect(grid).toContain("paired, never booted");
    expect(grid).toContain("no report on this relay");
  });

  test("shows the engine ref and the running sha", () => {
    expect(grid).toContain("v0.13.0 → dd6f67d");
  });

  test("explains the bar rather than leaving the colours to be guessed", () => {
    expect(grid).toContain("green working");
  });

  test("gives doctor its counts and its age now that the report carries a section", () => {
    expect(grid).toContain("doctor healthy — 3 h ago (schedule)");
  });

  test("a card's name opens that deployment", () => {
    expect(grid).toContain('class="name" href="#/d/one"');
  });
});

describe("doctor at fleet level (#507 §9)", () => {
  const failing = report({
    doctor: {
      ...report().doctor,
      report: {
        checks: [{ id: "engine", state: "fail", detail: "c0ffee1 quarantined" }],
        tenants: [],
        ok: false,
      },
    },
  });

  test("a failing check joins the attention clause the sort reads", () => {
    const [first] = sortFleet([
      rowFacts(row({ fingerprint: "quiet", name: "zeta" }), stored(report())),
      rowFacts(row({ fingerprint: "sick", name: "alpha" }), stored(failing)),
    ]);

    // Name order would put alpha first anyway, so the fingerprint is the tell:
    // attention outranks name, and the failing row is the one with attention.
    expect(first?.row.fingerprint).toBe("sick");
    expect(first?.attention).toBe(true);
  });

  test("the rail names the fail count without naming a warn count beside it", () => {
    const markup = renderToStaticMarkup(
      <Rail
        facts={[rowFacts(row(), stored(failing))]}
        selected={null}
        now={NOW}
        surface="browser"
        signedIn
      />,
    );
    expect(markup).toContain("doctor 1 fail");
  });

  test("a deployment that has never run doctor says never, not healthy", () => {
    const markup = renderToStaticMarkup(
      <FleetPage
        facts={[
          rowFacts(
            row(),
            stored(report({ doctor: { ...report().doctor, report: null, at: null } })),
          ),
        ]}
        client={client()}
        now={NOW}
      />,
    );
    expect(markup).toContain("doctor never run");
  });
});

describe("a report this console cannot read", () => {
  test("says so and keeps the relay's own facts on screen", () => {
    const markup = renderToStaticMarkup(
      <FleetPage
        facts={[rowFacts(row({ name: "ahead-of-us" }), stored(report(), { schema: 99 }))]}
        client={client()}
        now={NOW}
      />,
    );

    expect(markup).toContain("report schema 99");
    expect(markup).toContain("newer than this console reads");
    expect(markup).toContain("connected");
  });
});

describe("the companion's shell", () => {
  // Shell A (#526): one rail, two groups. Signed out and with nothing installed,
  // this is the whole window.
  const empty = renderToStaticMarkup(
    <Rail facts={[]} selected={null} now={NOW} surface="companion" signedIn={false} />,
  );

  test("is one rail carrying both arms as groups, not a switch between them", () => {
    expect(empty).toContain('aria-label="This machine"');
    expect(empty).toContain('aria-label="Relay"');
    expect([...empty.matchAll(/<nav/g)]).toHaveLength(1);
  });

  test("names which kind of empty each group is", () => {
    expect(empty).toContain("No local install yet");
    expect(empty).toContain("Not signed in to a relay");
  });

  test("keeps the relay's deployments in the relay's group once signed in", () => {
    const markup = renderToStaticMarkup(
      <Rail facts={FLEET} selected={null} now={NOW} surface="companion" signedIn />,
    );

    expect(markup).toContain("jesusfilm-workspace");
    expect(markup).toContain("This machine");
  });

  test("a browser has no local arm, so its rail is the fleet and nothing else", () => {
    expect(rail).not.toContain("This machine");
    expect(rail).toContain("Fleet — 4 deployments");
  });
});
