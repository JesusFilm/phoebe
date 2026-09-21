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
import { ConfigEditForm, InstallPage, InstallTab } from "./install-page.tsx";
import { RELAY_UPGRADE_DOC, tooOldText } from "./relay-version.ts";
import { ReceiptPanel } from "./deployment-tabs.tsx";
import { pairReading } from "./local-install.ts";
import type { RelaySignIn } from "./relay-client.ts";
import {
  ago,
  bridge,
  cell,
  child,
  client,
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
  <Rail
    facts={FLEET}
    selectedDeployment={null}
    now={NOW}
    surface="browser"
    signedIn
    signIn={null}
    onSignedIn={noop}
  />,
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
      <Rail
        facts={FLEET}
        selectedDeployment="two"
        now={NOW}
        surface="browser"
        signedIn
        signIn={null}
        onSignedIn={noop}
      />,
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
        selectedDeployment={null}
        now={NOW}
        surface="browser"
        signedIn
        signIn={null}
        onSignedIn={noop}
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
      signIn={null}
      onSignedIn={noop}
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

describe("the companion's shell", () => {
  // Shell A (#526): one rail, two groups. Signed out and with nothing installed,
  // this is the whole window.
  const empty = renderToStaticMarkup(
    <Rail
      facts={[]}
      selectedDeployment={null}
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
        selectedDeployment={null}
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
        selectedDeployment={null}
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
      <Rail
        facts={FLEET}
        selectedDeployment={null}
        now={NOW}
        surface="companion"
        signedIn
        signIn={null}
        onSignedIn={noop}
      />,
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
      onSignedIn={noop}
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
        onSignedIn={noop}
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
  function tab(
    overrides: Parameters<typeof install>[0] = {},
    arm: { signedIn?: boolean; paired?: boolean } = {},
  ) {
    const subject = install(overrides);
    return renderToStaticMarkup(
      <InstallTab
        install={subject}
        environment={null}
        run={null}
        running={false}
        trouble={null}
        pairing={pairReading(subject, {
          signedIn: arm.signedIn ?? true,
          paired: arm.paired ?? false,
        })}
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

  test("a running install on a signed-in companion is offered the pairing", () => {
    const markup = tab({ state: "running" }, { signedIn: true });

    expect(markup).toContain(">Pair with the relay<");
    expect(markup).not.toContain('disabled="">Pair');
  });

  test("signed out, it is disabled and says to sign in", () => {
    const markup = tab({ state: "running" }, { signedIn: false });

    expect(markup).toContain("Sign in to a relay on the rail first");
    expect(markup).toMatch(/disabled=""[^>]*>Pair with the relay/);
  });

  test("stopped, it is disabled and says to start the install", () => {
    const markup = tab({ state: "stopped" }, { signedIn: true });

    expect(markup).toContain("Start this install first");
    expect(markup).toMatch(/disabled=""[^>]*>Pair with the relay/);
  });

  test("already paired, there is no button at all — only what it means", () => {
    const markup = tab({ state: "running" }, { signedIn: true, paired: true });

    expect(markup).not.toContain(">Pair with the relay<");
    expect(markup).toContain("Paired");
  });

  test("says forgetting deletes nothing, because a Forget button reads like one that does", () => {
    expect(tab()).toContain("Nothing on disk is deleted");
  });

  test("states the container's version beside the companion's, and refuses nothing on it", () => {
    const markup = tab({ state: "stopped", containerVersion: "0.12.1" });

    expect(markup).toContain("container 0.12.1");
    // Every verb an install in this state is offered is still offered, and none
    // of them is disabled by the skew.
    const verbs = /<div class="verbs">(.*?)<\/div>/.exec(markup)?.[1] ?? "";
    // Asked of the two verbs by name: pairing sits in the same row and is
    // disabled on a stopped install for a reason of its own (#558).
    expect(verbs).toContain('<button type="button">Start</button>');
    expect(verbs).toContain('<button type="button">Check for upgrades</button>');
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
        signedIn
        paired={false}
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

describe("the two local writes on screen (#557)", () => {
  function page(
    overrides: Parameters<typeof install>[0] = {},
    event: Parameters<typeof localReport>[0] | null = {},
  ) {
    const one = install(overrides);
    return renderToStaticMarkup(
      <InstallPage
        install={one}
        bridge={bridge()}
        signedIn
        paired={false}
        report={event === null ? null : localReport({ facts: one, ...event })}
        now={NOW}
        onForget={() => undefined}
      />,
    );
  }

  test("the config tab carries the edit form and the fingerprint it checks against", () => {
    const markup = page({ state: "stopped" }, {});

    expect(markup).toContain("Change one field");
    expect(markup).toContain("sha256:0f1e2d3c4b5a6978");
    expect(markup).toContain("pipelines.work.pollIntervalMs");
  });

  test("the edit form says it writes this machine and no relay is involved", () => {
    const markup = page({ state: "stopped" }, {});

    expect(markup).toContain("straight to");
    expect(markup).toContain("No relay is involved");
  });

  test("a folder with no config has no edit form to offer", () => {
    const markup = page(
      { state: "stopped" },
      { directory: directory({ configText: null, configFingerprint: null }) },
    );

    expect(markup).not.toContain("Change one field");
  });

  /** The install tab alone, which is where the secret form lives. */
  function secretTab(overrides: Parameters<typeof install>[0] = {}) {
    return renderToStaticMarkup(
      <InstallTab
        install={install(overrides)}
        environment={null}
        run={null}
        running={false}
        trouble={null}
        pairing={{ kind: "ready" }}
        onStart={() => undefined}
        onForget={() => undefined}
        onCancel={() => undefined}
      />,
    );
  }

  test("the secret form is on the install tab, reachable with nothing running", () => {
    const markup = secretTab({ state: "not-initialised" });

    expect(markup).toContain("Set a secret");
    expect(markup).toContain('type="password"');
  });

  test("it says no envelope is built and nothing is sent to a relay (#526)", () => {
    const markup = secretTab({ state: "not-initialised" });

    expect(markup).toContain("Nothing is sealed to anybody");
    expect(markup).toContain("even if this install is paired");
  });

  test("it names the writer before a value is pasted — the file, with nothing running", () => {
    const markup = secretTab({ state: "stopped" });

    expect(markup).toContain(".env");
    expect(markup).not.toContain("tenant secret store on the data volume");
  });

  test("and the store, on a running container", () => {
    expect(secretTab({ state: "running" })).toContain("tenant secret store on the data volume");
  });

  test("a refusal renders its reason and the exact edit to make by hand (#503)", () => {
    const markup = renderToStaticMarkup(
      <ConfigEditForm
        install={install({ state: "stopped" })}
        config={{
          kind: "file",
          path: "/repos/youtube-studio/phoebe.config.ts",
          text: "export default defineConfig({})",
          fingerprint: "sha256:abc",
        }}
        running={false}
        receipt={{
          id: "e1",
          state: "refused",
          file: "/repos/youtube-studio/phoebe.config.ts",
          path: "engine.ref",
          reason: "not-editable",
          why: "the engine pin moves with `phoebe upgrade`",
          instruction: "Run `phoebe upgrade --ref v2` in that folder.",
          at: ago(1),
        }}
        onStart={() => undefined}
      />,
    );

    expect(markup).toContain("Refused (not-editable)");
    expect(markup).toContain("phoebe upgrade --ref v2");
  });

  test("a written receipt says what landed and that a reconcile follows", () => {
    const markup = renderToStaticMarkup(
      <ReceiptPanel
        receipt={{
          id: "e1",
          state: "written",
          file: "/repos/youtube-studio/phoebe.config.ts",
          path: "checkCommand",
          value: "pnpm run check",
          fingerprint: "sha256:after",
          at: ago(1),
        }}
      />,
    );

    expect(markup).toContain("checkCommand");
    expect(markup).toContain("pnpm run check");
    expect(markup).toContain("reconciles onto it");
  });
});

describe("a paired install on the rail (#558)", () => {
  const PAIRED = install({ dir: "/repos/one", name: "one", deploymentName: "the-fleet" });
  const FLEET = sortFleet([rowFacts(row({ fingerprint: "FP1", name: "the-fleet" }), null)]);

  function rail(paired: Set<string>, facts = FLEET) {
    return renderToStaticMarkup(
      <Rail
        facts={facts}
        now={NOW}
        surface="companion"
        signedIn
        installs={[PAIRED]}
        paired={paired}
        signIn={null}
        onSignedIn={() => undefined}
      />,
    );
  }

  test("wears a paired chip under This machine", () => {
    const markup = rail(new Set(["/repos/one"]), []);

    expect(markup).toContain("This machine");
    expect(markup).toContain('class="chip paired"');
    expect(markup).toContain(">paired<");
  });

  test("shows once: the row it is on the relay is not drawn beside it", () => {
    // The Relay group is handed the rows that are *not* local installs, so with
    // its one row claimed the group says what an empty relay says.
    const markup = rail(new Set(["/repos/one"]), []);

    expect(markup).toContain("No deployment is paired with this relay yet.");
    expect(markup.match(/the-fleet/g)).toBeNull();
    expect(markup.match(/class="name">/g)).toHaveLength(1);
  });

  test("an unpaired install wears no chip, and its relay group still draws its rows", () => {
    const markup = rail(new Set());

    expect(markup).not.toContain("chip paired");
    expect(markup).toContain("the-fleet");
  });
});
