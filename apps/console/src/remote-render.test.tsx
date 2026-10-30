// What the remote arm puts on screen (map #690; #697, #699): the machines on
// the rail and their rows in every state, the two rows of a joined deployment
// with their chips, the remote page's card and panels, the Devices panel's
// gating, the install tab's Remote step in each of its states, and the mint
// card that shows a code the run's lines never carry.
//
// Static markup, like render.test.tsx: these are pure components over what
// they are handed. The add modal's presses are in add-remote.test.tsx.

import { describe, expect, test } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";
import type { RemoteRecord, SessionRow, VerbRun } from "phoebe-agent/contracts";
import { RemoteConsoleView } from "./console-view.tsx";
import { DevicesPanel } from "./devices-panel.tsx";
import { InstallPage } from "./install-page.tsx";
import { Rail } from "./rail.tsx";
import { RemotePage } from "./remote-page.tsx";
import { MintCard, RemoteStep } from "./remote-step.tsx";
import { ago, bridge, install, localReport, NOW, remote, report, stored } from "./test-fixture.ts";

const record = remote;

const noop = (): void => undefined;

describe("the machines on the rail", () => {
  const remotes = [
    record({ deploymentId: "a", name: "zeta", url: "https://demo-host.tail4f2c.ts.net" }),
    record({
      deploymentId: "b",
      name: "alpha",
      url: "https://demo-host.tail4f2c.ts.net:8443",
      reachability: "disconnected",
    }),
    record({
      deploymentId: "c",
      name: "ops-box",
      url: "https://ops-box.tail4f2c.ts.net",
      reachability: "blocked",
      blocked: "expired",
    }),
    record({
      deploymentId: "d",
      name: "phoebe-demo",
      url: "https://beast.tail4f2c.ts.net",
      reachability: "dark",
      lastHeardAt: ago(3 * 60),
    }),
  ];
  const markup = renderToStaticMarkup(
    <Rail
      surface="companion"
      installs={[install({ dir: "/repos/one", name: "one" })]}
      remotes={remotes}
      now={NOW}
      selectedRemote="b"
      onRemote={noop}
      onAddRemote={noop}
      onPairAgain={noop}
    />,
  );

  test("This machine first, then one section per hostname, then the one add", () => {
    const headings = [
      ...markup.matchAll(/aria-label="([^"]+)"[^>]*>\s*<h2 class="rail-heading"/g),
    ].map((m) => m[1]);
    expect(headings).toEqual([
      "This machine",
      "beast.tail4f2c.ts.net",
      "demo-host.tail4f2c.ts.net",
      "ops-box.tail4f2c.ts.net",
    ]);
    expect(markup).toContain("+ add remote");
    expect(markup.indexOf("This machine")).toBeLessThan(markup.indexOf("beast.tail4f2c.ts.net"));
    expect(markup.indexOf("+ add remote")).toBeGreaterThan(
      markup.indexOf("ops-box.tail4f2c.ts.net"),
    );
  });

  test("two deployments on one host are two rows under one header, the port on the row", () => {
    const section = markup.slice(
      markup.indexOf('aria-label="demo-host.tail4f2c.ts.net"'),
      markup.indexOf('aria-label="ops-box.tail4f2c.ts.net"'),
    );
    expect(section).toContain("alpha");
    expect(section).toContain("zeta");
    expect(section).toContain(":8443");
    expect(section.indexOf("alpha")).toBeLessThan(section.indexOf("zeta"));
  });

  test("each state has its words: counts, a spinner, dark · 3 min, the blocked reason with pair again", () => {
    expect(markup).toMatch(/zeta[\s\S]*?<div class="sub">connected<\/div>/);
    expect(markup).toMatch(/aria-label="Reconnecting to alpha"/);
    expect(markup).toMatch(/phoebe-demo[\s\S]*?dark · 3 min/);
    expect(markup).toMatch(/ops-box[\s\S]*?session expired/);
    expect(markup).toMatch(/ops-box[\s\S]*?>pair again</);
    expect(markup).toMatch(/class="rail-entry remote state-blocked[^"]*blocked/);
  });

  test("the open remote is marked, and rows link to their console", () => {
    expect(markup).toMatch(/href="#\/r\/b\/console"[^>]*aria-current="page"/);
  });

  test("a row carries a gear onto its page when the rail has one, as a local row does", () => {
    const gears = renderToStaticMarkup(
      <Rail
        surface="companion"
        remotes={[remotes[0]!]}
        now={NOW}
        onRemote={noop}
        onRemoteSettings={noop}
      />,
    );
    expect(gears).toMatch(/class="[^"]*rail-gear[^"]*"[^>]*aria-label="Settings for zeta"/);
    expect(markup).not.toContain("Settings for zeta");
  });

  test("the expiry notice from three days out, and update instead of pair again for protocol", () => {
    const soon = renderToStaticMarkup(
      <Rail
        surface="companion"
        remotes={[
          record({
            deploymentId: "e",
            expiresAt: new Date(NOW.getTime() + 2 * 86_400_000).toISOString(),
          }),
          record({
            deploymentId: "f",
            url: "https://other.ts.net",
            reachability: "blocked",
            blocked: "protocol",
          }),
        ]}
        now={NOW}
        onPairAgain={noop}
      />,
    );
    expect(soon).toContain("session expires in 2 d");
    expect(soon).toMatch(/newer than this companion[\s\S]*?>update</);
  });

  test("Tailscale off on this machine is a line above the host sections", () => {
    const off = renderToStaticMarkup(
      <Rail
        surface="companion"
        remotes={remotes}
        now={NOW}
        tailscale={{ running: false, detail: "Stopped" }}
      />,
    );
    expect(off).toContain("Tailscale is off on this machine; remotes cannot be reached");
    expect(off.indexOf("Tailscale is off")).toBeLessThan(off.indexOf("beast.tail4f2c.ts.net"));
    expect(markup).not.toContain("Tailscale is off");
  });

  test("a row with operate carries the fleet's pause or start before the gear; read-only carries neither", () => {
    const stopped = record({
      deploymentId: "s",
      name: "held-one",
      url: "https://held.tail4f2c.ts.net",
      lastReport: stored(
        report({
          bootstrapper: { ...report().bootstrapper, stopped: { by: "device:x", at: ago(60) } },
        }),
      ),
    });
    const readOnly = record({
      deploymentId: "r",
      name: "read-one",
      url: "https://read.tail4f2c.ts.net",
      scopes: ["read"],
    });
    const rail = renderToStaticMarkup(
      <Rail
        surface="companion"
        remotes={[remotes[0]!, remotes[1]!, stopped, readOnly]}
        now={NOW}
        onRemote={noop}
        onRemoteSettings={noop}
        onRemoteAction={noop}
        busyRemotes={new Set(["b"])}
      />,
    );
    expect(rail).toMatch(/aria-label="Pause zeta"/);
    expect(rail).not.toMatch(/aria-label="Stop zeta"|aria-label="Restart zeta"/);
    expect(rail).toMatch(/aria-label="Start held-one"/);
    expect(rail).not.toMatch(/aria-label="(Pause|Start) read-one"/);
    expect(rail).toMatch(/aria-label="Settings for read-one"/);
    // A fleet verb in flight: the spinner stands where the shortcuts were.
    expect(rail).toMatch(/aria-label="Working on alpha"/);
    expect(rail).not.toMatch(/aria-label="(Pause|Start) alpha"/);
    // The host's mark beside the name, as a local row carries its own.
    expect(rail).toMatch(/rail-entry remote[\s\S]*?data-host="linux"/);
    // Without the shortcut callback there is nothing to press, as a browser has none.
    expect(markup).not.toMatch(/aria-label="Pause zeta"/);
  });

  test("a workspace remote opens out to its tenants, each a row onto that tenant's console", () => {
    const workspace = record({
      deploymentId: "w",
      name: "ws",
      url: "https://ws.tail4f2c.ts.net",
      lastReport: stored(report({ identity: { name: "ws", arm: "workspace", host: "linux" } })),
    });
    const closed = renderToStaticMarkup(
      <Rail surface="companion" remotes={[workspace]} now={NOW} onRemote={noop} />,
    );
    expect(closed).toMatch(/aria-label="Expand ws"/);
    expect(closed).not.toContain("Children of ws");
    const open = renderToStaticMarkup(
      <Rail
        surface="companion"
        remotes={[workspace]}
        now={NOW}
        defaultExpanded={new Set(["w"])}
        selectedRemote="w"
        selectedRemoteChild="JesusFilm/youtube-studio"
        onRemote={noop}
        onRemoteChild={noop}
      />,
    );
    expect(open).toMatch(/aria-label="Collapse ws"/);
    expect(open).toContain('aria-label="Children of ws"');
    expect(open).toMatch(/rail-child-row current[\s\S]*?JesusFilm\/youtube-studio/);
    // A solo remote has no chevron: there is nothing under it.
    expect(markup).not.toMatch(/aria-label="Expand zeta"/);
  });

  test("a joined deployment shows twice, each row with a chip to the other", () => {
    const local = install({ dir: "/repos/youtube-studio", name: "youtube-studio" });
    const remote = record();
    const joined = renderToStaticMarkup(
      <Rail
        surface="companion"
        installs={[local]}
        remotes={[remote]}
        now={NOW}
        localJoins={{ [local.dir]: remote }}
        remoteJoins={{ [remote.deploymentId]: local }}
        onOpenRemoteRoute={noop}
        onSelect={noop}
      />,
    );
    expect(joined.match(/youtube-studio/g)!.length).toBeGreaterThanOrEqual(2);
    expect(joined).toContain("↗ youtube-studio.tail4f2c.ts.net");
    expect(joined).toContain("↗ this machine");
  });
});

describe("a remote route's page", () => {
  const b = bridge();
  const page = (overrides: Partial<RemoteRecord> = {}, joined = false) =>
    renderToStaticMarkup(
      <RemotePage
        record={record(overrides)}
        bridge={b}
        tab="overview"
        now={NOW}
        joined={joined ? install({ dir: "/repos/youtube-studio" }) : null}
        onTab={noop}
        onPairAgain={noop}
        onSignOut={noop}
        onForget={noop}
        onOpenLocal={noop}
      />,
    );

  test("carries the five tabs and no install tab", () => {
    const markup = page();
    for (const tab of ["overview", "pipelines", "doctor", "secrets", "config"]) {
      expect(markup).toMatch(new RegExp(`<button[^>]*class="tab[^"]*"[^>]*>${tab}</button>`));
    }
    expect(markup).not.toMatch(/>install</);
  });

  test("the overview carries the fleet's Stop and Start, reading the report for which is offered", () => {
    const running = page();
    expect(running).toContain("The fleet is running.");
    expect(running).toMatch(/<button type="button" disabled=""[^>]*>Start<\/button>/);
    expect(running).toMatch(/<button type="button"(?! disabled)[^>]*>Stop<\/button>/);
    expect(running).toContain("the container and this API stay up");
    const stopped = page({
      lastReport: stored(
        report({
          identity: { name: "youtube-studio", arm: "solo", deploymentId: "dep_YT" },
          bootstrapper: {
            ...report().bootstrapper,
            stopped: { by: "device:Mike's phone", at: ago(120) },
          },
        }),
      ),
    });
    expect(stopped).toContain("The fleet is stopped — by device:Mike&#x27;s phone, 2 min ago.");
    expect(stopped).toMatch(/<button type="button"(?! disabled)[^>]*>Start<\/button>/);
    expect(stopped).toMatch(/<button type="button" disabled=""[^>]*>Stop<\/button>/);
    // The overview's own line says so too, on both arms.
    expect(stopped).toContain("stopped by device:Mike&#x27;s phone 2 min ago");
  });

  test("a read session's Stop is disabled with the reason; a frozen report offers neither", () => {
    const read = page({ scopes: ["read"] });
    expect(read).toMatch(
      /<button type="button" disabled="" title="needs operate: this device paired with read only">Stop<\/button>/,
    );
    const dark = page({ reachability: "dark", lastHeardAt: ago(600) });
    expect(dark).toMatch(/<button type="button" disabled=""[^>]*>Stop<\/button>/);
  });

  test("the title carries the console button when the page is given one", () => {
    expect(page()).not.toContain("Open the console");
    const withConsole = renderToStaticMarkup(
      <RemotePage
        record={record()}
        bridge={b}
        tab="overview"
        now={NOW}
        joined={null}
        onTab={noop}
        onPairAgain={noop}
        onSignOut={noop}
        onForget={noop}
        onOpenLocal={noop}
        onConsole={noop}
      />,
    );
    expect(withConsole).toMatch(/class="[^"]*console-open[^"]*"[^>]*aria-label="Open the console"/);
  });

  test("the connection card says Remote, the address, the arm, the protocol and the session", () => {
    const markup = page();
    expect(markup).toContain("<strong>Remote</strong>");
    expect(markup).toContain("youtube-studio.tail4f2c.ts.net");
    expect(markup).toContain("host arm · protocol 1");
    expect(markup).toContain("session read+operate");
    expect(markup).toContain("Devices");
  });

  test("the session card carries Pair again and Remove, and says what a new code changes", () => {
    const markup = page();
    expect(markup).toMatch(/session-card[\s\S]*?>Pair again</);
    expect(markup).toMatch(/session-card[\s\S]*?>Remove</);
    expect(markup).toContain("paired as Mike");
    expect(markup).toContain("phoebe pair --operate");
    expect(markup).not.toMatch(/>sign out</);
  });

  test("a joined deployment's page carries the chip to the local route", () => {
    expect(page({}, true)).toContain("↗ this machine");
    expect(page({}, false)).not.toContain("↗ this machine");
  });

  test("dark, blocked and reconnecting put a banner above the tabs and grey the report", () => {
    const dark = page({ reachability: "dark", lastHeardAt: ago(180) });
    expect(dark).toMatch(/role="status"[^>]*>Dark · last heard 3 min ago/);
    expect(dark).toContain('class="greyed"');
    const blocked = page({ reachability: "blocked", blocked: "revoked" });
    expect(blocked).toContain("session revoked · 401 unknown");
    expect(blocked).toMatch(/>pair again</);
    expect(blocked).toMatch(/>forget</);
    expect(page({ reachability: "disconnected" })).toMatch(/Reconnecting · last heard/);
    expect(page()).not.toContain('class="greyed"');
  });

  test("a read session sees the operate controls disabled with the reason", () => {
    const read = renderToStaticMarkup(
      <RemotePage
        record={record({ scopes: ["read"] })}
        bridge={b}
        tab="config"
        now={NOW}
        joined={null}
        onTab={noop}
        onPairAgain={noop}
        onSignOut={noop}
        onForget={noop}
        onOpenLocal={noop}
      />,
    );
    expect(read).toMatch(
      /<button[^>]*disabled[^>]*title="needs operate: this device paired with read only"/,
    );
    const doctor = renderToStaticMarkup(
      <RemotePage
        record={record({ scopes: ["read"] })}
        bridge={b}
        tab="doctor"
        now={NOW}
        joined={null}
        onTab={noop}
        onPairAgain={noop}
        onSignOut={noop}
        onForget={noop}
        onOpenLocal={noop}
      />,
    );
    expect(doctor).toMatch(/Run doctor<\/button>/);
    expect(doctor).toContain("needs operate");
  });
});

describe("the Devices panel", () => {
  const rows: SessionRow[] = [
    {
      id: "ses_me",
      scopes: ["read", "operate"],
      label: "Mike's MacBook",
      deviceType: "desktop",
      os: "macOS 15",
      pairedAs: "mike@github",
      issuedAt: ago(3600),
      expiresAt: new Date(NOW.getTime() + 86_400_000).toISOString(),
      lastSeenAt: ago(5),
    },
    {
      id: "ses_phone",
      scopes: ["read"],
      label: "phone",
      deviceType: "mobile",
      os: "iOS 19",
      pairedAs: null,
      issuedAt: ago(7200),
      expiresAt: ago(60),
      lastSeenAt: ago(3600),
    },
  ];
  const panel = (canOperate: boolean, tampered = false) =>
    renderToStaticMarkup(
      <DevicesPanel
        rows={rows}
        self="ses_me"
        canOperate={canOperate}
        tampered={tampered}
        counts={{ active: 1, expired: 1 }}
        now={NOW}
        note="read over the API"
        onRevoke={noop}
        onSignOut={noop}
      />,
    );

  test("every row: label, device and OS, pairedAs, scopes, last seen, expires; this device signs out", () => {
    const markup = panel(true);
    expect(markup).toContain("Mike&#x27;s MacBook");
    expect(markup).toContain("this device");
    expect(markup).toContain("desktop · macOS 15");
    expect(markup).toContain("mike@github");
    expect(markup).toContain("1 active, 1 expired");
    expect(markup).toMatch(/>sign out</);
    expect(markup).toMatch(/>revoke</);
  });

  test("an expired row is greyed but revocable; a read session's revoke is disabled with the reason", () => {
    expect(panel(true)).toMatch(
      /<tr class="expired">[\s\S]*?expired 1 min ago[\s\S]*?<button[^>]*>revoke</,
    );
    expect(panel(false)).toMatch(
      /<button[^>]*disabled[^>]*title="needs operate: this device paired with read only"[^>]*>revoke</,
    );
  });

  test("a tampered report puts the red banner above the rows", () => {
    expect(panel(true, true)).toMatch(
      /role="alert"[^>]*>sessions\.json changed under the bootstrapper/,
    );
    expect(panel(true, false)).not.toContain("sessions.json changed");
  });

  test("a blocked remote says the list is not readable; a local install offers a read", () => {
    expect(
      renderToStaticMarkup(
        <DevicesPanel
          rows={null}
          self={null}
          canOperate
          tampered={false}
          counts={null}
          now={NOW}
          note=""
          blocked
        />,
      ),
    ).toContain("Not readable while blocked.");
    expect(
      renderToStaticMarkup(
        <DevicesPanel
          rows={null}
          self={null}
          canOperate
          tampered={false}
          counts={null}
          now={NOW}
          note=""
          onRead={noop}
        />,
      ),
    ).toContain("Read the devices list");
  });
});

describe("the install tab's Remote step", () => {
  const b = bridge();
  const running = install({ dir: "/repos/youtube-studio", state: "running" });
  const withBlock = (arm: "host" | "sidecar", url: string | null) =>
    localReport({
      facts: running,
      report: stored(
        report({
          identity: { name: "youtube-studio", arm: "solo", deploymentId: "dep_YT" },
          remote: {
            configured: true,
            arm,
            url,
            sessions: { active: 1, expired: 0 },
            tampered: false,
            updatedAt: ago(1),
          },
        }),
      ),
    });
  const step = (props: Partial<Parameters<typeof RemoteStep>[0]> = {}) =>
    renderToStaticMarkup(
      <RemoteStep
        install={running}
        bridge={b}
        report={localReport({ facts: running })}
        run={null}
        running={false}
        onStart={noop}
        joined={null}
        defaultLabel="this companion"
        onOpenRemote={noop}
        onPaired={noop}
        {...props}
      />,
    );

  test("no remote block: says what to add, and that it is a boot-time local file edit", () => {
    const markup = step();
    expect(markup).toContain("Not configured.");
    expect(markup).toContain("remote: { tailscale: &quot;host&quot; }");
    expect(markup).toContain("boot-time field");
    expect(markup).not.toContain("Pair this companion");
  });

  test("with one: names the arm and the address, and offers the two mints once running", () => {
    const markup = step({ report: withBlock("sidecar", "https://youtube-studio.tail4f2c.ts.net") });
    expect(markup).toContain("<strong>sidecar</strong> arm");
    expect(markup).toContain("youtube-studio.tail4f2c.ts.net");
    expect(markup).toMatch(/>Pair this companion</);
    expect(markup).toMatch(/>Link for another device</);
  });

  test("a stopped install with a block says to start it; already paired is a chip and a link", () => {
    const stopped = install({ dir: "/repos/youtube-studio", state: "stopped" });
    expect(step({ install: stopped, report: localReport({ facts: stopped }) })).toContain(
      "Needs a running install to say.",
    );
    const paired = step({
      report: withBlock("host", "https://youtube-studio.tail4f2c.ts.net"),
      joined: record(),
    });
    expect(paired).toContain("this companion is paired");
    expect(paired).toContain("↗ open over Tailscale");
    expect(paired).not.toMatch(/>Pair this companion</);
    expect(paired).toMatch(/>Link for another device</);
  });

  test("a refused pair run is shown as the run's exit", () => {
    const run: VerbRun = {
      runId: "r1",
      install: running.dir,
      verb: "pair",
      startedAt: ago(10),
      lines: [
        { runId: "r1", stream: "stderr", line: "[phoebe] Serve is not serving this deployment" },
      ],
      exit: { runId: "r1", code: 1 },
    };
    expect(step({ report: withBlock("host", "https://x.ts.net"), run })).toContain(
      "was refused — exited 1",
    );
  });
});

describe("the mint card, and the code appearing nowhere else", () => {
  const outcome = {
    url: "https://youtube-studio.tail4f2c.ts.net/pair#code=ABCD-EFGH-JK12",
    code: "ABCD-EFGH-JK12",
    expiresAt: new Date(NOW.getTime() + 5 * 60_000).toISOString(),
    scopes: ["read" as const],
    deploymentId: "dep_YT",
  };

  test("the link, the code in large type, copy buttons, a QR, the scope and until when", () => {
    const markup = renderToStaticMarkup(<MintCard outcome={outcome} />);
    expect(markup).toContain("https://youtube-studio.tail4f2c.ts.net/pair#code=ABCD-EFGH-JK12");
    expect(markup).toMatch(/class="mint-code mono"[^>]*>ABCD-EFGH-JK12</);
    expect(markup).toMatch(/>copy link</);
    expect(markup).toMatch(/>copy code</);
    expect(markup).toContain('aria-label="QR code of the pairing link"');
    expect(markup).toContain("<svg");
    expect(markup).toContain("spendable until");
    expect(markup).toContain(">read<");
  });

  test("a run's lines say code minted and never the code; the run box on the install page carries no code", () => {
    const run: VerbRun = {
      runId: "r1",
      install: "/repos/youtube-studio",
      verb: "pair",
      startedAt: ago(10),
      lines: [{ runId: "r1", stream: "stdout", line: "[phoebe] code minted" }],
      exit: { runId: "r1", code: 0, outcome: { verb: "pair", outcome } },
    };
    const page = renderToStaticMarkup(
      <InstallPage
        install={install({ dir: "/repos/youtube-studio" })}
        bridge={bridge({ run })}
        report={null}
        now={NOW}
        onUpdate={() => Promise.resolve()}
        onForget={noop}
      />,
    );
    expect(run.lines.every((line) => !line.line.includes("ABCD"))).toBe(true);
    expect(page).not.toContain("ABCD-EFGH-JK12");
  });
});

describe("a remote route's console (map #690)", () => {
  const view = renderToStaticMarkup(
    <RemoteConsoleView bridge={bridge()} record={record()} now={NOW} onSettings={noop} />,
  );

  test("names the deployment with its address and reachability, and carries the gear onto its page", () => {
    expect(view).toContain('aria-label="Console for youtube-studio"');
    expect(view).toMatch(
      /<h1 title="https:\/\/youtube-studio\.tail4f2c\.ts\.net">youtube-studio<\/h1>/,
    );
    expect(view).toMatch(/class="mark connected"/);
    expect(view).toContain('<span class="console-state">connected</span>');
    expect(view).toContain('aria-label="Settings for youtube-studio"');
  });

  test("opens on all, with no cli tab: nothing runs on this machine for a remote", () => {
    expect(view).toMatch(/class="console-channel current" aria-pressed="true"[^>]*>all</);
    expect(view).not.toMatch(/>cli</);
    expect(view).toContain("Waiting for the container to print something");
  });

  test("opened from a workspace child, the child's own tab is the one open", () => {
    const scoped = renderToStaticMarkup(
      <RemoteConsoleView
        bridge={bridge()}
        record={record()}
        now={NOW}
        tenant="JesusFilm/youtube-studio"
        onSettings={noop}
      />,
    );
    expect(scoped).toMatch(
      /class="console-channel current[^"]*" aria-pressed="true"[^>]*>(<span[^>]*><\/span>)?youtube-studio</,
    );
    expect(scoped).toContain("Every line from JesusFilm/youtube-studio");
  });

  test("a stopped fleet is in the header's words", () => {
    const stopped = renderToStaticMarkup(
      <RemoteConsoleView
        bridge={bridge()}
        record={record({
          lastReport: stored(
            report({
              identity: { name: "youtube-studio", arm: "solo", deploymentId: "dep_YT" },
              bootstrapper: { ...report().bootstrapper, stopped: { by: "x", at: ago(5) } },
            }),
          ),
        })}
        now={NOW}
        onSettings={noop}
      />,
    );
    expect(stopped).toContain('<span class="console-state">connected · fleet stopped</span>');
  });
});
