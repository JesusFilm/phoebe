// The remote arm's facts (map #690; #697, #699): machines by hostname and the
// sort inside them, what each row says, the join between a record and a
// folder here, and the add modal's parsing and wording.

import { describe, expect, test } from "vite-plus/test";
import {
  addFailureLine,
  addSuccessLine,
  addUrl,
  deploymentIdOf,
  hostSections,
  localJoins,
  pageBanner,
  parseAddInput,
  problemsOf,
  raisedRows,
  remoteConnection,
  remoteJoins,
  fleetStopOf,
  remoteActions,
  remoteChildren,
  remoteHost,
  remoteIsWorkspace,
  remoteRow,
} from "./remote-routes.ts";
import { readReport } from "./report.ts";
import {
  ago,
  cell,
  install,
  localReport,
  NOW,
  remote,
  report,
  stored,
  tenant,
} from "./test-fixture.ts";

const record = remote;

describe("the rows and their words", () => {
  test("connected reads like a local row, with its problems as clauses", () => {
    const plain = remoteRow(record(), NOW);
    expect(plain).toMatchObject({
      tone: "connected",
      text: "connected",
      attention: false,
      port: null,
    });
    const wedged = remoteRow(
      record({
        lastReport: stored(
          report({
            fleet: {
              tenants: [tenant()],
              cells: [cell({ wedged: { wedged: true, reason: "no-pass", noPassForMs: 1 } })],
              updatedAt: ago(1),
            },
          }),
        ),
      }),
      NOW,
    );
    expect(wedged.text).toBe("connected · 1 wedged");
    expect(wedged.attention).toBe(true);
  });

  test("a fleet held down from a device is the first clause, and no problem", () => {
    const held = remoteRow(
      record({
        lastReport: stored(
          report({
            bootstrapper: {
              ...report().bootstrapper,
              stopped: { by: "device:Mike's phone", at: ago(60) },
            },
          }),
        ),
      }),
      NOW,
    );
    expect(held.text).toBe("connected · fleet stopped");
    expect(held.attention).toBe(false);
    expect(fleetStopOf(held.reading)).toEqual({ by: "device:Mike's phone", at: ago(60) });
    expect(fleetStopOf(readReport(null))).toBeNull();
    expect(fleetStopOf(remoteRow(record(), NOW).reading)).toBeNull();
  });

  test("the shortcuts: pause while the fleet runs, start while it is held, none without operate or a report", () => {
    expect(remoteActions(remoteRow(record(), NOW))).toEqual(["pause"]);
    const held = remoteRow(
      record({
        lastReport: stored(
          report({
            bootstrapper: { ...report().bootstrapper, stopped: { by: "device:x", at: ago(60) } },
          }),
        ),
      }),
      NOW,
    );
    expect(remoteActions(held)).toEqual(["start"]);
    expect(remoteActions(remoteRow(record({ scopes: ["read"] }), NOW))).toEqual([]);
    expect(remoteActions(remoteRow(record({ reachability: "disconnected" }), NOW))).toEqual([]);
    expect(remoteActions(remoteRow(record({ reachability: "dark" }), NOW))).toEqual([]);
    expect(remoteActions(remoteRow(record({ lastReport: null }), NOW))).toEqual([]);
  });

  test("the host off the report, and a workspace's tenants as the rail's children", () => {
    expect(remoteHost(remoteRow(record({ lastReport: stored(report()) }), NOW).reading)).toBe(
      "linux",
    );
    expect(remoteHost(readReport(null))).toBeNull();
    const solo = remoteRow(record(), NOW).reading;
    expect(remoteIsWorkspace(solo)).toBe(false);
    expect(remoteChildren(solo)).toEqual([]);
    const workspace = remoteRow(
      record({
        lastReport: stored(report({ identity: { name: "ws", arm: "workspace", host: "linux" } })),
      }),
      NOW,
    ).reading;
    expect(remoteIsWorkspace(workspace)).toBe(true);
    const rows = remoteChildren(workspace);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      dir: "/etc/phoebe",
      slug: "JesusFilm/youtube-studio",
      label: "JesusFilm/youtube-studio",
      enabled: true,
    });
    expect(["running", "idle", "attention", "stopped"]).toContain(rows[0]!.tone);
  });

  test("reconnecting keeps the counts; dark replaces them with how long", () => {
    expect(remoteRow(record({ reachability: "disconnected" }), NOW).text).toBe("reconnecting");
    const dark = remoteRow(record({ reachability: "dark", lastHeardAt: ago(3 * 60) }), NOW);
    expect(dark.text).toBe("dark · 3 min");
    expect(dark.frozen).toBe(true);
    expect(dark.attention).toBe(true);
  });

  test("blocked names its reason and offers pair again, or update for protocol", () => {
    const expired = remoteRow(record({ reachability: "blocked", blocked: "expired" }), NOW);
    expect(expired.blocked).toEqual({ text: "session expired", action: "pair again" });
    expect(expired.text).toBe("session expired");
    expect(expired.attention).toBe(false);
    expect(
      remoteRow(record({ reachability: "blocked", blocked: "protocol" }), NOW).blocked,
    ).toEqual({
      text: "newer than this companion",
      action: "update",
    });
    expect(
      remoteRow(record({ reachability: "blocked", blocked: "replaced" }), NOW).blocked?.text,
    ).toBe("a different deployment answers here");
  });

  test("the expiry notice from three days out, never while blocked; the port when not 443", () => {
    const soon = new Date(NOW.getTime() + 2 * 86_400_000).toISOString();
    expect(remoteRow(record({ expiresAt: soon }), NOW).expiry).toBe("session expires in 2 d");
    expect(
      remoteRow(record({ expiresAt: soon, reachability: "blocked", blocked: "expired" }), NOW)
        .expiry,
    ).toBeNull();
    expect(remoteRow(record({ url: "https://demo-host.tail4f2c.ts.net:8443" }), NOW).port).toBe(
      "8443",
    );
  });

  test("the problems come off the report: wedged, crash-looping, doctor fails, held", () => {
    const reading = readReport(
      stored(
        report({
          fleet: {
            tenants: [tenant({ held: true })],
            cells: [cell({ wedged: { wedged: true, reason: "no-pass", noPassForMs: 1 } })],
            updatedAt: ago(1),
          },
          doctor: {
            report: {
              checks: [{ id: "remote", state: "fail", detail: "x" }],
              tenants: [],
              ok: false,
            },
            at: ago(1),
            trigger: "boot",
            updatedAt: ago(1),
          },
        }),
      ),
    );
    expect(problemsOf(reading)).toEqual({ wedged: 1, crashLooping: 0, doctorFails: 1, held: 1 });
  });
});

describe("machines on the rail", () => {
  test("one section per hostname, sorted; rows dark, blocked, problems, then by name", () => {
    const sections = hostSections(
      [
        record({ deploymentId: "a", name: "zeta", url: "https://demo-host.tail4f2c.ts.net" }),
        record({ deploymentId: "b", name: "alpha", url: "https://demo-host.tail4f2c.ts.net:8443" }),
        record({
          deploymentId: "c",
          name: "dark-one",
          url: "https://demo-host.tail4f2c.ts.net:9443",
          reachability: "dark",
          lastHeardAt: ago(120),
        }),
        record({
          deploymentId: "d",
          name: "blocked-one",
          url: "https://demo-host.tail4f2c.ts.net:7443",
          reachability: "blocked",
          blocked: "revoked",
        }),
        record({ deploymentId: "e", name: "elsewhere", url: "https://beast.tail4f2c.ts.net" }),
      ],
      NOW,
    );
    expect(sections.map((section) => section.host)).toEqual([
      "beast.tail4f2c.ts.net",
      "demo-host.tail4f2c.ts.net",
    ]);
    expect(sections[1]!.rows.map((row) => row.record.name)).toEqual([
      "dark-one",
      "blocked-one",
      "alpha",
      "zeta",
    ]);
    expect(sections[1]!.rows.map((row) => row.port)).toEqual(["9443", "7443", "8443", null]);
  });

  test("the badge counts once per row and never a blocked one", () => {
    const sections = hostSections(
      [
        record({ deploymentId: "a", reachability: "dark", lastHeardAt: ago(120) }),
        record({
          deploymentId: "b",
          url: "https://other.ts.net",
          reachability: "blocked",
          blocked: "expired",
        }),
        record({ deploymentId: "c", url: "https://third.ts.net" }),
      ],
      NOW,
    );
    expect(raisedRows(sections)).toBe(1);
  });
});

describe("the join", () => {
  const local = install({ dir: "/repos/youtube-studio" });
  const event = localReport({
    install: local.dir,
    report: stored(
      report({ identity: { name: "youtube-studio", arm: "solo", deploymentId: "dep_YT" } }),
    ),
  });

  test("a local install's report names its deployment id", () => {
    expect(deploymentIdOf(event)).toBe("dep_YT");
    expect(deploymentIdOf(null)).toBeNull();
    expect(deploymentIdOf(localReport({ report: null }))).toBeNull();
  });

  test("a folder here and a record with one id are two routes, each knowing the other", () => {
    const held = [record(), record({ deploymentId: "dep_OTHER", url: "https://other.ts.net" })];
    expect(localJoins([local], { [local.dir]: event }, held)).toEqual({ [local.dir]: held[0] });
    expect(remoteJoins([local], { [local.dir]: event }, held)).toEqual({ dep_YT: local });
    expect(localJoins([local], {}, held)).toEqual({});
  });
});

describe("the remote page's card and banner", () => {
  test("the connection card says how the facts got here", () => {
    const card = remoteConnection(record(), NOW);
    expect(card.arm).toBe("Remote");
    expect(card.detail).toBe("youtube-studio.tail4f2c.ts.net");
    expect(card.note).toContain("host arm · protocol 1 · last heard 5 s ago");
    expect(card.note).toContain("session read+operate, expires in 20 d");
  });

  test("the banner above the tabs, per state", () => {
    expect(pageBanner(remoteRow(record(), NOW), NOW)).toBeNull();
    expect(pageBanner(remoteRow(record({ reachability: "disconnected" }), NOW), NOW)).toMatch(
      /^Reconnecting · last heard 5 s ago/,
    );
    expect(
      pageBanner(remoteRow(record({ reachability: "dark", lastHeardAt: ago(180) }), NOW), NOW),
    ).toMatch(/^Dark · last heard 3 min ago/);
    expect(
      pageBanner(remoteRow(record({ reachability: "blocked", blocked: "revoked" }), NOW), NOW),
    ).toMatch(/^session revoked · 401 unknown/);
  });
});

describe("adding a remote", () => {
  test("a pairing link carries the host and the code; a bare address carries the host alone", () => {
    expect(
      parseAddInput("https://youtube-studio.tail4f2c.ts.net/pair#code=ABCD-EFGH-JK12"),
    ).toEqual({
      host: "youtube-studio.tail4f2c.ts.net",
      code: "ABCD-EFGH-JK12",
    });
    expect(parseAddInput(" demo-host.tail4f2c.ts.net:8443 ")).toEqual({
      host: "demo-host.tail4f2c.ts.net:8443",
      code: "",
    });
    expect(parseAddInput("https://beast.ts.net/")).toEqual({ host: "beast.ts.net", code: "" });
    expect(parseAddInput("")).toEqual({ host: "", code: "" });
    expect(addUrl("beast.ts.net:8443")).toBe("https://beast.ts.net:8443");
  });

  test("each failure is one line", () => {
    expect(addFailureLine({ outcome: "unreachable", detail: "" }, true)).toMatch(
      /^Nothing answered at that address/,
    );
    expect(addFailureLine({ outcome: "unreachable", detail: "" }, false)).toMatch(
      /Tailscale is off/,
    );
    expect(addFailureLine({ outcome: "tailscale-off", detail: "" }, null)).toMatch(
      /Tailscale is off/,
    );
    expect(addFailureLine({ outcome: "not-phoebe", detail: "" }, true)).toMatch(
      /not a Phoebe deployment/,
    );
    expect(addFailureLine({ outcome: "code-rejected", detail: "" }, true)).toMatch(
      /single use and last five minutes/,
    );
    expect(addFailureLine({ outcome: "protocol", detail: "" }, true)).toMatch(
      /Update the companion/,
    );
  });

  test("success says where the row landed", () => {
    const base = { record: record(), joined: null };
    expect(addSuccessLine({ ...base, sectionHad: 0, repaired: false })[0]).toMatch(
      /^Added as a new machine, youtube-studio.tail4f2c.ts.net/,
    );
    expect(addSuccessLine({ ...base, sectionHad: 2, repaired: false })[0]).toBe(
      "Added to youtube-studio.tail4f2c.ts.net, which already had 2 deployments.",
    );
    expect(addSuccessLine({ ...base, sectionHad: 1, repaired: true })[0]).toMatch(/^Paired again/);
    const joined = addSuccessLine({
      ...base,
      sectionHad: 0,
      repaired: false,
      joined: install({ dir: "/repos/ys" }),
    });
    expect(joined[1]).toMatch(
      /also the folder at \/repos\/ys on this machine, so it now has two rows/,
    );
  });
});
