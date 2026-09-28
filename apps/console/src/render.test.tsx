// What the rail and the install's pages actually put on screen.
//
// Rendered to static markup rather than into a DOM, which needs no browser and no
// jsdom: these are pure components over what they are handed, so the markup is
// the whole output.

import { describe, expect, test } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";
import { DEPLOYMENT_SCHEMA } from "phoebe-agent/contracts";
import type { CompanionUpdate } from "phoebe-agent/contracts";
import { Rail } from "./rail.tsx";
import { ConsoleView } from "./console-view.tsx";
import { ConfigEditForm, InstallPage, InstallTab } from "./install-page.tsx";
import { ReceiptPanel } from "./deployment-tabs.tsx";
import {
  ago,
  bridge,
  directory,
  install,
  localReport,
  NOW,
  report,
  tenant,
} from "./test-fixture.ts";

describe("the installs on the rail", () => {
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
      surface="companion"
      installs={installs}
      selected="/repos/two"
      onSelect={() => undefined}
      onAction={() => undefined}
      onAdd={() => undefined}
    />,
  );

  test("the stopped install has a start shortcut; the running one pause, stop and restart", () => {
    // one is running, two is stopped, three has nothing to start.
    // The button's own classes come first and ours last, so the attribute ends in it.
    expect(markup.match(/rail-action"/g)).toHaveLength(4);
    expect(markup).toMatch(/two[\s\S]*?class="[^"]*rail-action[^"]*"[^>]*aria-label="Start two"/);
    for (const label of ["Pause one", "Stop one", "Restart one"]) {
      expect(markup, label).toContain(`aria-label="${label}"`);
    }
    expect(markup).not.toContain('aria-label="Start one"');
    expect(markup).not.toMatch(/aria-label="(Start|Pause|Stop|Restart) three"/);
    // An icon, named for a screen reader by the button and hidden from it itself.
    expect(markup).toMatch(/class="[^"]*rail-action[^"]*"[^>]*>\s*<svg[^>]*aria-hidden="true"/);
  });

  test("an install with a run in flight shows a spinner where its shortcuts were", () => {
    const busy = renderToStaticMarkup(
      <Rail
        surface="companion"
        installs={installs}
        busy={new Set(["/repos/one"])}
        onSelect={() => undefined}
        onAction={() => undefined}
      />,
    );

    expect(busy).toMatch(/<svg[^>]*class="[^"]*animate-spin[^"]*"[^>]*aria-label="Working on one"/);
    expect(busy).not.toContain('aria-label="Pause one"');
    // The other entries keep their shortcuts.
    expect(busy).toContain('aria-label="Start two"');
  });

  test("lists every install under This machine, in the order they were added", () => {
    const names = [...markup.matchAll(/class="platform"[^>]*>[\s\S]*?<\/span>([^<]*)</g)].map(
      (match) => match[1],
    );

    expect(names).toEqual(["one", "two", "three"]);
  });

  test("says which host each install runs on: this machine's, or Linux under WSL", () => {
    const mixed = renderToStaticMarkup(
      <Rail
        surface="companion"
        installs={[
          install({ dir: "/repos/one", name: "one" }),
          install({
            dir: "\\\\wsl.localhost\\archlinux\\home\\mike\\two",
            name: "two",
            wsl: { distro: "archlinux", dir: "/home/mike/two" },
          }),
        ]}
        platform="win32"
      />,
    );

    expect(mixed).toMatch(/title="Windows"[^>]*>\s*<svg[^>]*data-host="windows"/);
    expect(mixed).toMatch(
      /title="Linux, in the archlinux WSL distro"[^>]*>\s*<svg[^>]*data-host="wsl"/,
    );
    // Before the environment has answered, a local install's host is not known.
    expect(markup).toMatch(/title="Host not reported yet"[^>]*>\s*<svg[^>]*lucide-monitor/);
  });

  test("a gear on every install opens its settings: the install tab", () => {
    const opened: string[] = [];
    const withGear = renderToStaticMarkup(
      <Rail surface="companion" installs={installs} onSettings={(dir) => opened.push(dir)} />,
    );

    for (const name of ["one", "two", "three"]) {
      expect(withGear, name).toContain(`aria-label="Settings for ${name}"`);
    }
    expect(withGear.match(/rail-gear"/g)).toHaveLength(3);
    // Without a way to open a page there is no gear to press.
    expect(markup).not.toContain("rail-gear");
  });

  test("a workspace has a chevron, closed to begin with, and its children once opened", () => {
    const workspace = install({
      dir: "/repos/ws",
      name: "ws",
      state: "running",
      workspace: {
        children: [
          { dir: "/repos/ws/a", name: "a", slug: "acme/a" },
          { dir: "/repos/ws/b", name: "b", slug: null },
        ],
      },
    });
    const closed = renderToStaticMarkup(
      <Rail
        surface="companion"
        installs={[workspace, install({ dir: "/repos/solo", name: "solo" })]}
        onSettings={() => undefined}
        onChild={() => undefined}
      />,
    );
    const opened = renderToStaticMarkup(
      <Rail
        surface="companion"
        installs={[workspace]}
        reports={{
          "/repos/ws": localReport({
            facts: workspace,
            report: {
              schema: DEPLOYMENT_SCHEMA,
              receivedAt: ago(2),
              report: report({
                fleet: {
                  tenants: [tenant({ id: "/w/a", path: "/w/a", slug: "acme/a", held: true })],
                  cells: [],
                  updatedAt: ago(12),
                },
              }),
            },
          }),
        }}
        defaultExpanded={new Set(["/repos/ws"])}
        onSettings={() => undefined}
        onChild={() => undefined}
      />,
    );

    // One chevron: the solo install has nothing to open out.
    expect(closed.match(/rail-chevron"/g)).toHaveLength(1);
    expect(closed).toContain('aria-expanded="false"');
    expect(closed).toContain('aria-label="Expand ws"');
    expect(closed).toContain('title="2 in this workspace"');
    expect(closed).not.toContain("rail-children");

    expect(opened).toContain('aria-expanded="true"');
    expect(opened).toMatch(/class="rail-children"/);
    // The slug labels a child when it has one, the folder otherwise; the fleet
    // says what each is doing, and a folder the fleet does not know says so.
    expect(opened).toMatch(
      /class="mark attention"[^>]*><\/span><span class="label">acme\/a<\/span><span class="word">held/,
    );
    expect(opened).toMatch(
      /class="mark idle"[^>]*><\/span><span class="label">b<\/span><span class="word">not in the fleet/,
    );
  });

  test("gives the three states three marks, and no verdict read out of silence", () => {
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

  test("offers a way to add one", () => {
    expect(markup).toContain("+ add");
  });
});

describe("the companion's own update on the rail", () => {
  function railWith(update: CompanionUpdate) {
    return renderToStaticMarkup(
      <Rail
        surface="companion"
        update={update}
        onDownload={() => undefined}
        onRestart={() => undefined}
      />,
    );
  }

  test("offers the download only once there is a build to download", () => {
    const markup = railWith({ kind: "available", version: "0.14.0" });

    expect(markup).toContain("Phoebe 0.14.0 is available");
    expect(markup).toContain("Download");
  });

  test("says what a download is doing while it does it", () => {
    expect(railWith({ kind: "downloading", version: "0.14.0", percent: 42 })).toContain("42%");
  });

  test("a staged build names the quit as the moment it installs", () => {
    const markup = railWith({ kind: "ready", version: "0.14.0" });

    expect(markup).toContain("installs when you quit");
    expect(markup).toContain("Restart now");
  });

  test("says nothing when there is nothing to say", () => {
    // Checking, nothing newer, a feed nobody could read, and the platforms that
    // do not update at all: four states, no line on the rail (#525 §3).
    for (const update of [
      { kind: "checking" },
      { kind: "current" },
      { kind: "unread", message: "fetch failed" },
      { kind: "unsupported", reason: "the macOS build is unsigned", releases: "https://x.test" },
    ] satisfies CompanionUpdate[]) {
      expect(railWith(update), update.kind).not.toContain("rail-update");
    }
  });
});

describe("the install tab", () => {
  /**
   * The tab with the buttons, rendered on its own. The page lands a running
   * install on overview (#526), and which verbs an install is offered is a
   * question about this tab rather than about where the page opened.
   */
  function tab(overrides: Parameters<typeof install>[0] = {}) {
    const subject = install(overrides);
    return renderToStaticMarkup(
      <InstallTab
        install={subject}
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

  test("states the container's version beside the companion's, and refuses nothing on it", () => {
    const markup = tab({ state: "stopped", containerVersion: "0.12.1" });

    expect(markup).toContain("container 0.12.1");
    // Every verb an install in this state is offered is still offered, and none
    // of them is disabled by the skew.
    const verbs = /<div class="verbs">(.*?)<\/div>/.exec(markup)?.[1] ?? "";
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
        report={event === null ? null : localReport({ facts: one, ...event })}
        now={NOW}
        onForget={() => undefined}
        onUpdate={() => Promise.resolve()}
      />,
    );
  }

  test("carries the project's own settings above the tabs, on every tab", () => {
    const markup = page({ dir: "/repos/youtube-studio", label: "Studio", name: "Studio" });
    const settings = markup.indexOf('aria-label="This project"');

    expect(settings).toBeGreaterThan(-1);
    expect(settings).toBeLessThan(markup.indexOf('<nav class="tabs"'));
    expect(markup).toContain('value="Studio"');
    expect(markup).toContain('placeholder="youtube-studio"');
    expect(markup).toContain(">Change…</button>");
  });

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

  test("the overview renders the report the loop read", () => {
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

  test("a stopped install opens on config with no line about the other tabs", () => {
    const markup = page({ state: "stopped" }, {});

    // The rail's shortcut and the install tab are one click away; a sentence
    // saying so on every stopped install was noise (#526 asked for a pointer,
    // the rail now is one).
    expect(markup).not.toContain("Nothing is running, so config");
    expect(markup).toContain("defineConfig");
  });

  test("a running install mid-read says it is reading, not that nothing is running", () => {
    const markup = page({ state: "running" }, null);

    expect(markup).toContain("Reading this install");
    expect(markup).not.toContain("Go to the install tab");
  });

  test("a workspace's config tab carries a config space per tenant, each with its own edit form", () => {
    const markup = page(
      {
        state: "stopped",
        workspace: { children: [{ dir: "/repos/ws/a", name: "a", slug: "acme/a" }] },
      },
      {
        directory: directory({
          bootstrapperRunning: false,
          tenants: [
            {
              dir: "/repos/ws/a",
              name: "a",
              slug: "acme/a",
              configPath: "/repos/ws/a/phoebe.config.ts",
              configText: 'export default defineConfig({ repoSlug: "acme/a" })\n',
              configFingerprint: "sha256:aa",
            },
            {
              dir: "/repos/ws/b",
              name: "b",
              slug: null,
              configPath: "/repos/ws/b/phoebe.config.ts",
              configText: null,
              configFingerprint: null,
            },
          ],
        }),
      },
    );

    expect(markup).toContain('aria-label="Tenants"');
    expect(markup).toContain('<span class="tenant-label">acme/a</span>');
    expect(markup).toContain("repoSlug: &quot;acme/a&quot;");
    expect(markup).toContain("<h2>Change one field in acme/a</h2>");
    // The child with no config is listed and says so rather than being dropped.
    expect(markup).toContain('<span class="tenant-label">b</span>');
    expect(markup).toContain("in this folder");
    // The root keeps its own form above them.
    expect(markup.indexOf("<h2>Change one field</h2>")).toBeLessThan(
      markup.indexOf('aria-label="Tenants"'),
    );
  });

  test("a solo install's config tab has no tenants block", () => {
    const markup = page({ state: "stopped" }, {});

    expect(markup).not.toContain('aria-label="Tenants"');
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
        report={event === null ? null : localReport({ facts: one, ...event })}
        now={NOW}
        onForget={() => undefined}
        onUpdate={() => Promise.resolve()}
      />,
    );
  }

  test("the config tab carries the edit form and the fingerprint it checks against", () => {
    const markup = page({ state: "stopped" }, {});

    expect(markup).toContain("Change one field");
    expect(markup).toContain("sha256:0f1e2d3c4b5a6978");
    expect(markup).toContain("pipelines.work.pollIntervalMs");
  });

  test("the edit form says it writes this machine", () => {
    const markup = page({ state: "stopped" }, {});

    expect(markup).toContain("straight to");
    expect(markup).toContain("on this machine");
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

  test("it says no envelope is built and nothing is sent anywhere (#526)", () => {
    const markup = secretTab({ state: "not-initialised" });

    expect(markup).toContain("Nothing is sealed to anybody");
    expect(markup).toContain("nothing is sent anywhere else");
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

describe("the console, the page the rail opens", () => {
  const view = renderToStaticMarkup(
    <ConsoleView
      bridge={bridge()}
      install={install({ name: "youtube-studio", state: "running" })}
      host="windows"
      onSettings={() => undefined}
    />,
  );

  test("names the install with its host and state, and carries the gear onto its settings", () => {
    expect(view).toContain('aria-label="Console for youtube-studio"');
    expect(view).toMatch(/title="Windows"[^>]*>\s*<svg[^>]*data-host="windows"/);
    expect(view).toContain("<h1");
    expect(view).toContain("running");
    expect(view).toContain('aria-label="Settings for youtube-studio"');
  });

  test("starts on all with nothing yet, and on the child's own tab when opened from one", () => {
    expect(view).toMatch(/class="console-channel current" aria-pressed="true"[^>]*>all</);
    expect(view).toContain("Waiting for the container to print something");
    const scoped = renderToStaticMarkup(
      <ConsoleView
        bridge={bridge()}
        install={install()}
        host={null}
        tenant="JesusFilm/phoebe"
        onSettings={() => undefined}
      />,
    );
    expect(scoped).toMatch(
      /class="console-channel current" aria-pressed="true" title="Every line from JesusFilm\/phoebe">phoebe</,
    );
  });
});
