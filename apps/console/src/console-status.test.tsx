import { describe, expect, test } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";
import type { FleetCell, LocalReportEvent } from "phoebe-agent/contracts";
import { channelStatus, channelTitle, consoleStatus } from "./console-status.ts";
import { ConsoleView } from "./console-view.tsx";
import { ALL_CHANNEL, BOOT_CHANNEL } from "./logs-channels.ts";
import {
  ago,
  bridge,
  cell,
  child,
  directory,
  install,
  localReport,
  report,
  tenant,
} from "./test-fixture.ts";

const A = tenant({ id: "/w/a", path: "/w/a", slug: "acme/a" });
const B = tenant({ id: "/w/b", path: "/w/b", slug: "acme/b" });

/** A pipeline of tenant A or B, working a unit unless told otherwise. */
function pipeline(
  of: typeof A,
  name: string,
  overrides: Partial<FleetCell> & { unit?: { kind: string; id: string }; lastError?: string } = {},
): FleetCell {
  const { unit, lastError, ...rest } = overrides;
  return cell({
    id: `${of.id}#${name}`,
    tenant: of,
    pipeline: name,
    state: unit === undefined ? "idle" : "working",
    snapshot: {
      tenant: of.slug ?? "",
      pipeline: name,
      currentUnits: unit === undefined ? [] : [{ unit, startedAt: ago(60), runBudgetMs: null }],
      waitingForSlot: false,
      lastError: lastError ?? null,
      lastTimeoutAt: null,
      updatedAt: ago(30),
    },
    ...rest,
  });
}

const workspace = install({
  dir: "/repos/ws",
  name: "ws",
  workspace: {
    children: [
      { dir: "/repos/ws/a", name: "a", slug: "acme/a" },
      { dir: "/repos/ws/b", name: "b", slug: "acme/b" },
    ],
  },
});

function event(cells: FleetCell[], extra: Partial<Parameters<typeof report>[0]> = {}) {
  return localReport({
    facts: workspace,
    report: {
      schema: report().schema,
      receivedAt: ago(2),
      report: report({ fleet: { tenants: [A, B], cells, updatedAt: ago(12) }, ...extra }),
    },
  });
}

describe("what is working", () => {
  const busy = event([
    pipeline(A, "work", { unit: { kind: "issue", id: "497" } }),
    pipeline(A, "research"),
    pipeline(B, "work", { unit: { kind: "review", id: "88" } }),
  ]);
  const status = consoleStatus(workspace, busy);

  test("is every pipeline with a unit in flight, with the kind of work it is", () => {
    expect(status.working).toEqual([
      { channel: "acme/a:work", label: "a:work", units: ["issue 497"] },
      { channel: "acme/b:work", label: "b:work", units: ["review 88"] },
    ]);
  });

  test("a pipeline's tab is active when it is the one working", () => {
    expect(channelStatus(status, "acme/a:work")).toMatchObject({
      active: true,
      units: ["issue 497"],
    });
    expect(channelStatus(status, "acme/a:research").active).toBe(false);
  });

  test("a tenant's tab and its agent's are active while any of its pipelines is", () => {
    expect(channelStatus(status, "acme/a:*")).toMatchObject({ active: true, units: ["issue 497"] });
    expect(channelStatus(status, "acme/a:claude")).toMatchObject({
      active: true,
      units: ["issue 497"],
      problems: [],
    });
  });

  test("all speaks for the install, and the bootstrapper's tab is quiet", () => {
    expect(channelStatus(status, ALL_CHANNEL)).toMatchObject({
      active: true,
      units: ["issue 497", "review 88"],
    });
    expect(channelStatus(status, BOOT_CHANNEL)).toEqual({ active: false, units: [], problems: [] });
  });

  test("a stopped install has nothing working, whatever its last report said", () => {
    const stopped = { ...workspace, state: "stopped" as const };

    expect(consoleStatus(stopped, busy).working).toEqual([]);
    expect(consoleStatus(workspace, null)).toMatchObject({ working: [], problems: [] });
  });
});

describe("what is wrong", () => {
  const troubled = event(
    [
      pipeline(A, "work", {
        wedged: { wedged: true, reason: "no-pass", noPassForMs: 1_020_000 },
        lastError: "gh: rate limited",
      }),
      pipeline(A, "intake"),
      pipeline(B, "work"),
    ],
    {
      bootstrapper: {
        ...report().bootstrapper,
        children: [child({ id: "/w/a#intake", crashLooping: true })],
      },
    },
  );
  const status = consoleStatus(workspace, troubled);

  test("a pipeline's tab carries its own, errors first", () => {
    expect(channelStatus(status, "acme/a:work").problems).toEqual([
      { level: "error", text: "work: wedged" },
      { level: "warning", text: "work: gh: rate limited" },
    ]);
    expect(channelStatus(status, "acme/a:intake").problems).toEqual([
      { level: "error", text: "intake: crash-looping" },
    ]);
    expect(channelStatus(status, "acme/b:work").problems).toEqual([]);
  });

  test("a tenant's tab carries everything under it", () => {
    expect(channelStatus(status, "acme/a:*").problems).toEqual([
      { level: "error", text: "work: wedged" },
      { level: "error", text: "intake: crash-looping" },
      { level: "warning", text: "work: gh: rate limited" },
    ]);
  });

  test("the install's says whose each one is", () => {
    expect(status.problems).toEqual([
      { level: "error", text: "a: work: wedged" },
      { level: "error", text: "a: intake: crash-looping" },
      { level: "warning", text: "a: work: gh: rate limited" },
    ]);
  });

  test("errors come before warnings, whichever tenant each is from", () => {
    const mixed = consoleStatus(
      workspace,
      event([
        pipeline(A, "work", { lastError: "gh: rate limited" }),
        pipeline(B, "work", {
          wedged: { wedged: true, reason: "no-pass", noPassForMs: 1_020_000 },
        }),
      ]),
    );

    expect(mixed.problems).toEqual([
      { level: "error", text: "b: work: wedged" },
      { level: "warning", text: "a: work: gh: rate limited" },
    ]);
  });

  test("what the host found counts on a stopped workspace too", () => {
    const stopped = { ...workspace, state: "stopped" as const };
    const locked = localReport({
      facts: stopped,
      directory: directory({
        bootstrapperRunning: false,
        tenants: [
          {
            dir: "/repos/ws/a",
            name: "a",
            slug: "acme/a",
            configPath: "/repos/ws/a/phoebe.config.ts",
            configText: null,
            configFingerprint: null,
            env: { path: "/repos/ws/a/.env", access: "unreadable" },
          },
        ],
      }),
    });

    expect(consoleStatus(stopped, locked).problems).toEqual([
      { level: "error", text: "a: the container cannot read its .env" },
    ]);
  });

  test("a solo install's are its one tenant's, with no name in front", () => {
    const solo = install({ dir: "/repos/one", name: "one" });
    const one = tenant({ id: "/etc/phoebe", slug: "acme/one", held: true, reason: "no repoSlug" });
    const held = localReport({
      facts: solo,
      report: {
        schema: report().schema,
        receivedAt: ago(2),
        report: report({ fleet: { tenants: [one], cells: [], updatedAt: ago(12) } }),
      },
    });

    expect(consoleStatus(solo, held).problems).toEqual([
      { level: "error", text: "held: no repoSlug" },
    ]);
  });

  test("a tab's hover says what it is working on and what is wrong", () => {
    expect(
      channelTitle("acme/a:work", {
        active: true,
        units: ["issue 497"],
        problems: [{ level: "warning", text: "work: gh: rate limited" }],
      }),
    ).toBe("acme/a:work\nWorking on issue 497\nWarning — work: gh: rate limited");
    expect(channelTitle("boot", { active: false, units: [], problems: [] })).toBe("boot");
  });
});

describe("the console's header", () => {
  function view(report: LocalReportEvent | null, scoped: string | null = null) {
    return renderToStaticMarkup(
      <ConsoleView
        bridge={bridge()}
        install={workspace}
        host="linux"
        report={report}
        tenant={scoped}
        onSettings={() => undefined}
      />,
    );
  }
  const busy = event([
    pipeline(A, "work", { unit: { kind: "issue", id: "497" }, lastError: "gh: rate limited" }),
    pipeline(B, "work", {
      unit: { kind: "review", id: "88" },
      wedged: { wedged: true, reason: "no-pass", noPassForMs: 1_020_000 },
    }),
  ]);

  test("names each working pipeline and the work it is on", () => {
    const markup = view(busy);

    expect(markup).toContain('aria-label="Working now"');
    expect(markup).toMatch(
      /class="console-working"[^>]*>.*?a:work<span class="console-unit">issue 497/,
    );
    expect(markup).toMatch(/b:work<span class="console-unit">review 88/);
  });

  test("counts what is wrong, and names each on hover", () => {
    const markup = view(busy);

    expect(markup).toMatch(/class="console-problem error" aria-label="1 error"/);
    expect(markup).toMatch(/class="console-problem warning" aria-label="1 warning"/);
    expect(markup).toContain("Error — b: work: wedged");
    expect(markup).toContain("Warning — a: work: gh: rate limited");
  });

  test("opened from a tenant, speaks for that tenant and marks its tab", () => {
    const markup = view(busy, "acme/a");

    // Only its own pipeline, and only its own warning.
    expect(markup).toMatch(/a:work<span class="console-unit">issue 497/);
    expect(markup).not.toContain("review 88");
    expect(markup).not.toContain('aria-label="1 error"');
    expect(markup).toContain('aria-label="1 warning"');
    // Its tab is lit before it has printed a line.
    expect(markup).toMatch(/class="console-channel current active"/);
  });

  test("a quiet install's header says nothing extra", () => {
    const markup = view(event([pipeline(A, "work"), pipeline(B, "work")]));

    expect(markup).not.toContain("console-working");
    expect(markup).not.toContain("console-problem");
    expect(view(null)).not.toContain("console-pulse");
  });
});

describe("the console's cli tab", () => {
  function view(channel: string | null) {
    return renderToStaticMarkup(
      <ConsoleView
        bridge={bridge()}
        install={workspace}
        host="linux"
        report={null}
        channel={channel}
        onSettings={() => undefined}
      />,
    );
  }

  test("asked for by name, it is the tab open, before main has said what ran", () => {
    const markup = view("cli");

    expect(markup).toMatch(/class="console-channel current"[^>]*aria-pressed="true"[^>]*>cli</);
    expect(markup).toContain("What phoebe printed when the companion last ran a verb");
    expect(markup).toContain("Nothing has run on this install yet.");
    // It is not the container's quiet: that sentence belongs to the other tabs.
    expect(markup).not.toContain("Waiting for the container");
  });

  test("with no run and nobody asking, there is no such tab", () => {
    expect(view(null)).not.toMatch(/>cli</);
  });
});
