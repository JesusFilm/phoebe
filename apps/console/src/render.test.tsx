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
import { InstallPage } from "./install-page.tsx";
import { RELAY_UPGRADE_DOC, tooOldText } from "./relay-version.ts";
import {
  ago,
  bridge,
  cell,
  child,
  install,
  NOW,
  report,
  row,
  stored,
  tenant,
} from "./test-fixture.ts";

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

const rail = renderToStaticMarkup(<Rail facts={FLEET} now={NOW} surface="browser" signedIn />);
const grid = renderToStaticMarkup(<FleetPage facts={FLEET} now={NOW} />);

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
});

describe("the grid", () => {
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
});

describe("a report this console cannot read", () => {
  test("says so and keeps the relay's own facts on screen", () => {
    const markup = renderToStaticMarkup(
      <FleetPage
        facts={[rowFacts(row({ name: "ahead-of-us" }), stored(report(), { schema: 99 }))]}
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
    <Rail facts={[]} now={NOW} surface="companion" signedIn={false} />,
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
      <Rail facts={FLEET} now={NOW} surface="companion" signedIn />,
    );

    expect(markup).toContain("jesusfilm-workspace");
    expect(markup).toContain("This machine");
  });

  test("a browser has no local arm, so its rail is the fleet and nothing else", () => {
    expect(rail).not.toContain("This machine");
    expect(rail).toContain("Fleet — 4 deployments");
  });
});

describe("the local arm on the rail", () => {
  const installs = [
    install({ dir: "/repos/one", name: "one", state: "running" }),
    install({ dir: "/repos/two", name: "two", state: "stopped" }),
    install({
      dir: "/repos/three",
      name: "three",
      state: "not-initialised",
      detail: "no container/compose.yml yet",
    }),
  ];
  const markup = renderToStaticMarkup(
    <Rail
      facts={[]}
      now={NOW}
      surface="companion"
      signedIn={false}
      installs={installs}
      selected="/repos/two"
      onSelect={() => undefined}
      onAdd={() => undefined}
    />,
  );

  test("lists every install under This machine, in the order they were added", () => {
    const names = [...markup.matchAll(/class="name">.*?<\/span>(.*?)</g)].map((match) => match[1]);

    expect(names).toEqual(["one", "two", "three"]);
  });

  test("gives the three states three marks, and borrows none of the relay's four", () => {
    for (const tone of ["running", "stopped", "not-initialised"]) {
      expect(markup, tone).toContain(`class="mark ${tone}"`);
    }
    for (const word of ["dark", "unseen", "disconnected"]) {
      expect(markup.toLowerCase(), word).not.toContain(word);
    }
  });

  test("says why an install is in the state it is in, when there is a why", () => {
    expect(markup).toContain("not initialised · no container/compose.yml yet");
  });

  test("marks the install whose page is open", () => {
    expect(markup).toContain('aria-current="page"');
  });

  test("offers the one control the relay group has no equivalent of", () => {
    expect(markup).toContain("+ add");
  });

  test("a browser's rail has no local group at all, control included", () => {
    const browser = renderToStaticMarkup(
      <Rail facts={[]} now={NOW} surface="browser" signedIn installs={installs} />,
    );

    expect(browser).not.toContain("This machine");
    expect(browser).not.toContain("+ add");
  });
});

describe("the install tab", () => {
  function tab(overrides: Parameters<typeof install>[0] = {}) {
    return renderToStaticMarkup(
      <InstallPage install={install(overrides)} bridge={bridge()} onForget={() => undefined} />,
    );
  }

  test("is where a not-initialised install lands, offering init and nothing that needs one", () => {
    const markup = tab({ state: "not-initialised" });

    expect(markup).toContain(">install<");
    expect(markup).toContain(">Init<");
    expect(markup).not.toContain(">Start<");
    expect(markup).not.toContain(">Stop<");
  });

  test("a running install offers stop and doctor, never start beside them", () => {
    const markup = tab({ state: "running" });

    expect(markup).toContain(">Stop<");
    expect(markup).toContain(">Doctor<");
    expect(markup).not.toContain(">Start<");
    expect(markup).not.toContain(">Init<");
  });

  test("a stopped install offers start and the upgrade check", () => {
    const markup = tab({ state: "stopped" });

    expect(markup).toContain(">Start<");
    expect(markup).toContain(">Check for upgrades<");
  });

  test("carries the five deployment tabs, disabled and saying what they need", () => {
    const markup = tab();

    for (const name of ["overview", "pipelines", "doctor", "secrets", "config"]) {
      expect(markup, name).toContain(`>${name}<`);
    }
    expect(markup).toContain("Needs a running container");
  });

  test("says forgetting deletes nothing, because a Forget button reads like one that does", () => {
    expect(tab()).toContain("Nothing on disk is deleted");
  });

  test("names the folder it is about, since the rail only had room for its name", () => {
    expect(tab()).toContain("/repos/youtube-studio");
  });

  test("states the container's version beside the companion's, and refuses nothing on it", () => {
    const markup = tab({ state: "stopped", containerVersion: "0.12.1" });

    expect(markup).toContain("container 0.12.1");
    // Every verb an install in this state is offered is still offered, and none
    // of them is disabled by the skew. The five greyed tabs above are #556's and
    // have nothing to do with a version.
    const verbs = /<div class="verbs">(.*?)<\/div>/.exec(markup)?.[1] ?? "";
    expect(verbs).toContain(">Start<");
    expect(verbs).toContain(">Check for upgrades<");
    expect(verbs).not.toContain("disabled");
  });
});

describe("a relay the console is too new for", () => {
  const refusal = tooOldText({ version: "0.9.0", console: 0 });
  const markup = renderToStaticMarkup(
    <Rail
      facts={[]}
      now={NOW}
      surface="companion"
      signedIn={false}
      refusal={refusal}
      installs={[install({ dir: "/repos/one", name: "one" })]}
    />,
  );

  test("the Relay group says which end to move, and links how", () => {
    expect(markup).toContain("upgrade the relay first");
    expect(markup).toContain(RELAY_UPGRADE_DOC);
  });

  test("it does not also say 'not signed in' — one sentence, the true one", () => {
    expect(markup).not.toContain("Not signed in to a relay");
  });

  test("This machine is untouched: one arm refusing is not the window refusing", () => {
    expect(markup).toContain("This machine");
    expect(markup).toContain("one");
  });
});
