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
import { InstallPage, InstallTab } from "./install-page.tsx";
import type { RelaySignIn } from "./relay-client.ts";
import {
  ago,
  bridge,
  cell,
  child,
  directory,
  install,
  localReport,
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

function noop(): void {}

/** What the companion says when there is no keyring to encrypt a token to. */
const NO_KEYRING = "This machine has no keyring the companion can encrypt to.";

/** The companion's arm of the sign-in control: a form, not a link (#554). */
const SIGN_IN_PROMPT: RelaySignIn = {
  kind: "prompt",
  relay: null,
  persisted: true,
  start: () => Promise.resolve({ sub: "1", email: "ada@example.test" }),
};

const rail = renderToStaticMarkup(
  <Rail facts={FLEET} now={NOW} surface="browser" signedIn signIn={null} onSignedIn={noop} />,
);
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
    <Rail
      facts={[]}
      now={NOW}
      surface="companion"
      signedIn={false}
      signIn={SIGN_IN_PROMPT}
      onSignedIn={noop}
    />,
  );

  test("is one rail carrying both arms as groups, not a switch between them", () => {
    expect(empty).toContain('aria-label="This machine"');
    expect(empty).toContain('aria-label="Relay"');
    expect([...empty.matchAll(/<nav/g)]).toHaveLength(1);
  });

  test("the Relay group's signed-out entry carries a sign-in control (#554)", () => {
    // The address is the only thing the operator supplies; everything after it
    // is main's, which is why there is a field and a button and nothing else.
    expect(empty).toContain('id="relay-url"');
    expect(empty).toContain("Relay address");
    expect(empty).toContain("Sign in");
  });

  test("with no keyring, the rail says the sign-in will not be kept", () => {
    const markup = renderToStaticMarkup(
      <Rail
        facts={[]}
        now={NOW}
        surface="companion"
        signedIn={false}
        signIn={{ ...SIGN_IN_PROMPT, persisted: false, reason: NO_KEYRING }}
        onSignedIn={noop}
      />,
    );

    expect(markup).toContain(NO_KEYRING);
  });

  test("the relay it last held a token for fills the field, so re-signing in is one click", () => {
    const markup = renderToStaticMarkup(
      <Rail
        facts={[]}
        now={NOW}
        surface="companion"
        signedIn={false}
        signIn={{ ...SIGN_IN_PROMPT, relay: "https://relay.example.test" }}
        onSignedIn={noop}
      />,
    );

    expect(markup).toContain('value="https://relay.example.test"');
  });

  test("names which kind of empty each group is", () => {
    expect(empty).toContain("No local install yet");
    expect(empty).toContain("Not signed in to a relay");
  });

  test("keeps the relay's deployments in the relay's group once signed in", () => {
    const markup = renderToStaticMarkup(
      <Rail facts={FLEET} now={NOW} surface="companion" signedIn signIn={null} onSignedIn={noop} />,
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
      signIn={null}
      onSignedIn={() => undefined}
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
      <Rail
        facts={[]}
        now={NOW}
        surface="browser"
        signedIn
        installs={installs}
        signIn={null}
        onSignedIn={() => undefined}
      />,
    );

    expect(browser).not.toContain("This machine");
    expect(browser).not.toContain("+ add");
  });
});

describe("the install tab", () => {
  /**
   * The tab with the buttons, rendered on its own. The page lands a running
   * install on overview (#526), and which verbs an install is offered is a
   * question about this tab rather than about where the page opened.
   */
  function tab(overrides: Parameters<typeof install>[0] = {}) {
    return renderToStaticMarkup(
      <InstallTab
        install={install(overrides)}
        environment={null}
        run={null}
        running={false}
        trouble={null}
        onStart={() => undefined}
        onForget={() => undefined}
        onCancel={() => undefined}
      />,
    );
  }

  test("a not-initialised install is offered init and nothing that needs one", () => {
    const markup = tab({ state: "not-initialised" });

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

  test("says forgetting deletes nothing, because a Forget button reads like one that does", () => {
    expect(tab()).toContain("Nothing on disk is deleted");
  });
});

describe("a local install's page", () => {
  function page(
    overrides: Parameters<typeof install>[0] = {},
    event: Parameters<typeof localReport>[0] | null = null,
  ) {
    const one = install(overrides);
    return renderToStaticMarkup(
      <InstallPage
        install={one}
        bridge={bridge()}
        report={event === null ? null : localReport({ facts: one, ...event })}
        now={NOW}
        onForget={() => undefined}
      />,
    );
  }

  test("carries the same six tabs whatever the install is doing", () => {
    const markup = page();

    for (const name of ["install", "overview", "pipelines", "doctor", "secrets", "config"]) {
      expect(markup, name).toContain(`>${name}<`);
    }
  });

  test("names the folder it is about, since the rail only had room for its name", () => {
    expect(page()).toContain("/repos/youtube-studio");
  });

  test("a not-initialised install lands on the install tab (#526)", () => {
    const markup = page({ state: "not-initialised" });

    expect(markup).toContain(">Init<");
  });

  test("a running install lands on overview, and its card says local install (#556)", () => {
    const markup = page({ state: "running" }, {});

    expect(markup).toContain("Local install");
    expect(markup).toContain("/repos/youtube-studio");
    expect(markup).toContain("desktop bridge");
    expect(markup).toContain("its container is up");
  });

  test("the overview renders the report the loop read, not a relay's row", () => {
    const markup = page({ state: "running" }, {});

    expect(markup).toContain("youtube-studio");
    expect(markup).toContain("v0.13.0");
    expect(markup).toContain("1/2 in use");
  });

  test("a stopped install lands on config, read from the file (#526)", () => {
    const markup = page(
      { state: "stopped" },
      { directory: directory({ bootstrapperRunning: false }) },
    );

    expect(markup).toContain("phoebe.config.ts");
    expect(markup).toContain("defineConfig");
  });

  test("a stopped install does not render the report the window is still holding", () => {
    // The event carries one — main read it while the container was up, and the
    // window has held it since. Four tabs are shut over it and not one of the
    // report's numbers is on the page (#526).
    const markup = page({ state: "stopped" }, { facts: install({ state: "running" }) });

    expect(markup).not.toContain("1/2 in use");
    expect(markup).not.toContain("Slots");
    for (const name of ["overview", "pipelines", "doctor", "secrets"]) {
      expect(markup, name).toMatch(
        new RegExp(`disabled="" title="Needs a running container\\.">${name}<`),
      );
    }
    expect(markup).toContain("defineConfig");
  });

  test("a stopped install is pointed at the install tab, where the start button is (#526)", () => {
    const markup = page({ state: "stopped" }, {});

    expect(markup).toContain("Go to the install tab");
  });

  test("a running install mid-read says it is reading, not that nothing is running", () => {
    const markup = page({ state: "running" }, null);

    expect(markup).toContain("Reading this install");
    expect(markup).not.toContain("Go to the install tab");
  });

  test("config stays open on a stopped install, because a file is readable either way", () => {
    const markup = page({ state: "stopped" }, {});

    expect(markup).not.toMatch(/disabled="" [^>]*>config</);
  });
});
