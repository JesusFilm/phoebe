import { describe, expect, test } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  ConfigFieldFacts,
  HarnessFacts,
  HarnessName,
  HarnessReport,
} from "phoebe-agent/contracts";
import {
  applyReading,
  availableUpdates,
  claudeAuthProblem,
  claudeAuthReading,
  harnessRows,
  neededTools,
  rootProblem,
  rootReading,
  toolAddReading,
  toolsProblem,
  toolsReading,
  volumesProblem,
  volumesReading,
  takenReading,
  updateArrow,
  updatesReading,
  updatesSignature,
  type AvailableUpdate,
} from "./harness.ts";
import { consoleStatus } from "./console-status.ts";
import { ClaudeSignIn, HarnessPanel } from "./harness-section.tsx";
import { createNotifier, type Notifiable } from "./notifications.ts";
import { Rail } from "./rail.tsx";
import { SettingsPage } from "./settings-page.tsx";
import { bridge, directory, install, localReport } from "./test-fixture.ts";
import {
  noticeOf,
  takeUpdates,
  targetReading,
  UpdateAlerts,
  UpdateNoticeLine,
  type TargetState,
  type UpdateTarget,
} from "./update-alert.tsx";

const solo = install({
  dir: "/repos/one",
  name: "one",
  state: "running",
  containerVersion: "0.13.2",
});

/** The root config's field facts: an engine on `ref`, running `provider`. */
function fields(ref: string, provider: HarnessName): ConfigFieldFacts[] {
  return [
    { path: "engine.source", scope: "deployment", type: "enum", state: "set", value: "github" },
    { path: "engine.ref", scope: "deployment", type: "string", state: "set", value: ref },
    { path: "defaultProvider", scope: "tenant", type: "enum", state: "set", value: provider },
  ];
}

const event = (ref = "v0.13.2") =>
  localReport({ facts: solo, directory: directory({ configFields: fields(ref, "claude") }) });

function facts(overrides: Partial<HarnessFacts> & { harness: HarnessName }): HarnessFacts {
  return { pin: { kind: "absent" }, running: null, latest: null, behind: null, ...overrides };
}

function report(overrides: Partial<HarnessReport> = {}): HarnessReport {
  return {
    dockerfile: "/repos/one/container/Dockerfile",
    containerAsked: true,
    latestAt: "2026-10-02T12:00:00.000Z",
    user: { root: false, dockerfileDrops: true, unwritable: [] },
    tools: [],
    auth: [],
    launcher: {
      pin: { kind: "pinned", version: "0.13.2" },
      running: "0.13.2",
      latest: "0.13.2",
      behind: false,
    },
    harnesses: [
      facts({
        harness: "cursor",
        pin: { kind: "pinned", version: "2026.07.23-e383d2b" },
        running: "2026.07.23-e383d2b",
        latest: "2026.10.01-e373342",
        behind: true,
      }),
      facts({
        harness: "claude",
        pin: { kind: "unpinned" },
        running: "2.1.269",
        latest: "2.1.288",
        behind: true,
      }),
      facts({ harness: "codex", latest: "0.160.0" }),
    ],
    ...overrides,
  };
}

const CLAUDE: AvailableUpdate = {
  kind: "harness",
  harness: "claude",
  label: "Claude Code",
  from: "2.1.269",
  to: "2.1.288",
};
const LAUNCHER: AvailableUpdate = { kind: "launcher", from: "0.13.2", to: "0.14.1" };

describe("what an install could move to", () => {
  test("is each installed harness the newest version has passed, from where it is now", () => {
    expect(availableUpdates(solo, event(), report())).toEqual([
      {
        kind: "harness",
        harness: "cursor",
        label: "Cursor agent",
        from: "2026.07.23-e383d2b",
        to: "2026.10.01-e373342",
      },
      // Nothing pinned, so where it is now is what the container has.
      CLAUDE,
    ]);
  });

  test("and Phoebe's own launcher and engine, when a release has passed them", () => {
    const behind = report({
      harnesses: [],
      launcher: {
        pin: { kind: "pinned", version: "0.13.2" },
        running: "0.13.2",
        latest: "0.14.1",
        behind: true,
      },
    });

    expect(availableUpdates(solo, event(), behind)).toEqual([
      LAUNCHER,
      { kind: "engine", from: "v0.13.2", to: "v0.14.1" },
    ]);
    // An engine that follows a branch is never behind a release.
    expect(availableUpdates(solo, event("main"), behind)).toEqual([LAUNCHER]);
  });

  test("is nothing before a look-up, and nothing for a harness the image does not install", () => {
    expect(availableUpdates(solo, event(), null)).toEqual([]);
    expect(
      availableUpdates(
        solo,
        event(),
        report({ harnesses: [facts({ harness: "codex", latest: "0.160.0" })] }),
      ),
    ).toEqual([]);
    expect(availableUpdates(solo, event(), report({ dockerfile: null }))).toEqual([]);
  });

  test("reads as a move, as a phrase, and signs as what is on offer", () => {
    const updates = availableUpdates(solo, event(), report());

    expect(updateArrow(CLAUDE)).toBe("Claude Code 2.1.269 → 2.1.288");
    expect(updateArrow({ ...CLAUDE, from: null })).toBe("Claude Code 2.1.288");
    expect(updateArrow(LAUNCHER)).toBe("Phoebe launcher 0.13.2 → 0.14.1");
    expect(updatesReading(updates)).toBe("Cursor agent 2026.10.01-e373342 and Claude Code 2.1.288");
    expect(updatesSignature(updates)).toBe("cursor@2026.10.01-e373342,claude@2.1.288");
  });
});

describe("the one line", () => {
  const other = install({ dir: "/repos/two", name: "two", state: "stopped" });
  const target = (
    state: TargetState = { status: "idle" },
    updates: AvailableUpdate[] = [CLAUDE],
    of = solo,
  ): UpdateTarget => ({ install: of, updates, state });

  test("names one install, says what would move, and offers Update", () => {
    expect(noticeOf([target()])).toEqual({
      status: "idle",
      title: "Update available for one",
      detail: "Claude Code 2.1.269 → 2.1.288",
      action: "Update",
      manual: null,
    });
  });

  test("counts several, and offers them all at once", () => {
    expect(noticeOf([target(), target({ status: "idle" }, [CLAUDE], other)])).toEqual({
      status: "idle",
      title: "Update available for 2 installs",
      detail: null,
      action: "Update all",
      manual: null,
    });
  });

  test("an install with only Phoebe's own upgrade needs a manual update", () => {
    const mixed = noticeOf([target(), target({ status: "idle" }, [LAUNCHER], other)]);

    expect(mixed).toMatchObject({ action: "Update 1 install", manual: "1 needs a manual update" });
    // With nothing the button could take, there is no button.
    expect(noticeOf([target({ status: "idle" }, [LAUNCHER])])).toMatchObject({
      title: "Update available for one",
      detail: "Phoebe launcher 0.13.2 → 0.14.1",
      action: null,
      manual: null,
    });
  });

  test("an update in flight is the line, with the step it is on", () => {
    expect(
      noticeOf([
        target({ status: "running", stage: "pinning Claude Code 2.1.288" }),
        target({ status: "idle" }, [CLAUDE], other),
      ]),
    ).toEqual({
      status: "running",
      title: "Updating one",
      detail: "pinning Claude Code 2.1.288",
      action: null,
      manual: null,
    });
  });

  test("a failure says why, and offers the retry", () => {
    expect(noticeOf([target({ status: "failed", message: "Claude Code: offline." })])).toEqual({
      status: "failed",
      title: "Could not update one",
      detail: "Claude Code: offline.",
      action: "Retry",
      manual: null,
    });
  });

  test("a finished one says so, and nothing at all is no line", () => {
    expect(
      noticeOf([target({ status: "done", text: "Claude Code 2.1.288 is pinned." }, [])]),
    ).toEqual({
      status: "done",
      title: "one updated",
      detail: "Claude Code 2.1.288 is pinned.",
      action: null,
      manual: null,
    });
    expect(noticeOf([])).toBeNull();
  });

  test("a row in the list says what would move, or how its update is going", () => {
    expect(targetReading(target())).toBe("Claude Code 2.1.269 → 2.1.288");
    expect(targetReading(target({ status: "idle" }, [CLAUDE, LAUNCHER]))).toContain(
      "Phoebe's own upgrade runs migrations",
    );
    expect(targetReading(target({ status: "running", stage: "pinning" }))).toBe("pinning");
  });
});

describe("the alert on screen", () => {
  const noop = (): void => undefined;
  const targets: UpdateTarget[] = [{ install: solo, updates: [CLAUDE], state: { status: "idle" } }];

  function line(overrides: Partial<Parameters<typeof UpdateNoticeLine>[0]> = {}) {
    return renderToStaticMarkup(
      <UpdateNoticeLine
        notice={noticeOf(targets)!}
        targets={targets}
        listing={false}
        onList={noop}
        onTake={noop}
        onReview={noop}
        onDismiss={noop}
        {...overrides}
      />,
    );
  }

  test("is one line: the title, what would move, the action and the dismiss", () => {
    const markup = line();

    expect(markup).toContain('aria-label="Updates"');
    expect(markup).toContain("Update available for one");
    expect(markup).toContain("Claude Code 2.1.269 → 2.1.288");
    expect(markup).toContain(">Update<");
    expect(markup).toContain('aria-label="Dismiss the update alert"');
    // The list stays shut until the title is pressed.
    expect(markup).not.toContain("update-list");
    expect(markup).toContain('aria-expanded="false"');
  });

  test("the title opens the list, each install with its own Update and Review", () => {
    const markup = line({ listing: true });

    expect(markup).toContain('aria-label="Installs with updates"');
    expect(markup).toMatch(/<strong>one<\/strong>/);
    expect(markup).toContain(">Review<");
  });

  test("while it updates there is a step, and nothing to press or dismiss", () => {
    const running: UpdateTarget[] = [
      {
        install: solo,
        updates: [CLAUDE],
        state: { status: "running", stage: "pinning Claude Code 2.1.288" },
      },
    ];
    const markup = line({ notice: noticeOf(running)!, targets: running });

    expect(markup).toContain("update-alert running");
    expect(markup).toContain("Updating one");
    expect(markup).toContain("pinning Claude Code 2.1.288");
    expect(markup).not.toContain(">Update<");
    expect(markup).not.toContain("Dismiss the update alert");
  });

  test("a failure is an alert with a Retry", () => {
    const failed: UpdateTarget[] = [
      {
        install: solo,
        updates: [CLAUDE],
        state: { status: "failed", message: "Claude Code: offline." },
      },
    ];
    const markup = line({ notice: noticeOf(failed)!, targets: failed });

    expect(markup).toContain('role="alert"');
    expect(markup).toContain("Could not update one");
    expect(markup).toContain(">Retry<");
  });

  test("an install with nothing on offer draws nothing", () => {
    const draw = (reports: Record<string, HarnessReport>) =>
      renderToStaticMarkup(
        <UpdateAlerts
          bridge={bridge()}
          installs={[solo]}
          events={{ [solo.dir]: event() }}
          reports={reports}
          onReview={noop}
        />,
      );

    expect(draw({})).toBe("");
    expect(draw({ [solo.dir]: report({ harnesses: [] }) })).toBe("");
    expect(draw({ [solo.dir]: report() })).toContain("Update available for one");
  });

  test("the rail counts them beside the install's state", () => {
    const rail = renderToStaticMarkup(
      <Rail
        surface="companion"
        facts={[]}
        now={new Date()}
        signedIn={false}
        signIn={null}
        onSignedIn={() => undefined}
        installs={[solo]}
        updates={{ [solo.dir]: 2 }}
        onSettings={noop}
      />,
    );

    expect(rail).toMatch(/class="rail-updates"[^>]*aria-label="2 updates available"/);
    expect(
      renderToStaticMarkup(
        <Rail
          surface="companion"
          facts={[]}
          now={new Date()}
          signedIn={false}
          signIn={null}
          onSignedIn={() => undefined}
          installs={[solo]}
          onSettings={noop}
        />,
      ),
    ).not.toContain("rail-updates");
  });
});

describe("taking the updates", () => {
  const updates = availableUpdates(solo, event(), report());

  test("moves each pin, then puts it into the running container, saying each step", async () => {
    const harnessUpdates: { dir: string; update: { harness: HarnessName; version: string } }[] = [];
    const harnessApplies: { dir: string; harness: HarnessName }[] = [];
    const harnessChecks: { dir: string; lookUp: boolean }[] = [];
    const stages: string[] = [];

    const results = await takeUpdates(
      bridge({ harnessUpdates, harnessApplies, harnessChecks, harness: report() }),
      solo,
      updates,
      (stage) => stages.push(stage),
    );

    expect(harnessUpdates.map((call) => call.update)).toEqual([
      { harness: "cursor", version: "2026.10.01-e373342" },
      { harness: "claude", version: "2.1.288" },
    ]);
    expect(harnessApplies.map((call) => call.harness)).toEqual(["cursor", "claude"]);
    expect(stages).toEqual([
      "pinning Cursor agent 2026.10.01-e373342",
      "putting Cursor agent 2026.10.01-e373342 into the running container",
      "pinning Claude Code 2.1.288",
      "putting Claude Code 2.1.288 into the running container",
    ]);
    // It ends on a fresh check, without asking the network again.
    expect(harnessChecks).toEqual([{ dir: "/repos/one", lookUp: false }]);
    expect(takenReading(results, true)).toBe(
      "Cursor agent 2026.10.01-e373342 and Claude Code 2.1.288 are pinned in the Dockerfile and in the running container. " +
        "A unit in flight finishes on the version it started with, and the next one starts on the new.",
    );
  });

  test("a stopped install is pinned and nothing is asked of a container", async () => {
    const harnessApplies: { dir: string; harness: HarnessName }[] = [];
    const stopped = { ...solo, state: "stopped" as const };

    const results = await takeUpdates(bridge({ harnessApplies }), stopped, [CLAUDE]);

    expect(harnessApplies).toEqual([]);
    expect(takenReading(results, false)).toBe(
      "Claude Code 2.1.288 is pinned in the Dockerfile. The next build of the image installs it.",
    );
  });

  test("a refusal on one is said, and the rest still go", async () => {
    const refusing = bridge({
      harnessApply: { kind: "refused", harness: "claude", why: "no space left on device" },
    });

    const results = await takeUpdates(refusing, solo, [CLAUDE]);

    expect(results[0]).toMatchObject({ applied: false });
    expect(takenReading(results, true)).toBe(
      "Claude Code: pinned, but not put into the running container: no space left on device.",
    );
  });

  test("Phoebe's own versions are never moved from the alert", async () => {
    const harnessUpdates: { dir: string; update: { harness: HarnessName; version: string } }[] = [];

    await takeUpdates(bridge({ harnessUpdates }), solo, [LAUNCHER]);

    expect(harnessUpdates).toEqual([]);
  });

  test("an apply's outcome is a sentence either way", () => {
    expect(applyReading({ kind: "applied", harness: "claude", version: "2.1.288" })).toContain(
      "The running container has Claude Code 2.1.288 too.",
    );
    expect(applyReading({ kind: "refused", harness: "cursor", why: "offline" })).toBe(
      "Cursor agent was not put into the running container: offline. A rebuild installs it.",
    );
  });
});

describe("a pin the running container has not caught up with", () => {
  const noop = (): void => undefined;
  const behind = report({
    harnesses: [
      facts({
        harness: "claude",
        pin: { kind: "pinned", version: "2.1.288" },
        running: "2.1.269",
        latest: "2.1.288",
        behind: false,
      }),
    ],
  });

  function panel(overrides: Partial<Parameters<typeof HarnessPanel>[0]> = {}) {
    return renderToStaticMarkup(
      <HarnessPanel
        install={solo}
        rows={harnessRows(behind, event(), [])}
        shared={false}
        containerAsked
        latestAt={null}
        lookingUp={false}
        updating={null}
        outcome={null}
        trouble={null}
        busy={false}
        onLookUp={noop}
        onUpdate={noop}
        onApply={noop}
        onRebuild={noop}
        {...overrides}
      />,
    );
  }

  test("can be applied to the running container, with the rebuild still on offer", () => {
    const markup = panel();

    expect(markup).toContain("Apply to the running container");
    expect(markup).toContain("Apply it to the running container, or rebuild.");
    expect(markup).toContain("Rebuild and restart");
  });

  test("a stopped install has no container to apply to", () => {
    expect(panel({ install: { ...solo, state: "stopped" } })).not.toContain(
      "Apply to the running container",
    );
  });

  test("says what the apply came to", () => {
    expect(
      panel({ applied: { kind: "applied", harness: "claude", version: "2.1.288" } }),
    ).toContain("The running container has Claude Code 2.1.288 too.");
    expect(panel({ applying: "claude" })).toContain("Applying…");
  });
});

describe("the setting", () => {
  function page(autoCheckUpdates: boolean) {
    return renderToStaticMarkup(
      <SettingsPage
        surface="companion"
        environment={null}
        systemDark
        notifications
        consoleTheme="system"
        autoCheckUpdates={autoCheckUpdates}
        onAutoCheckUpdates={() => undefined}
      />,
    );
  }

  test("is a checkbox that says what it asks and that it never updates by itself", () => {
    const markup = page(false);

    expect(markup).toContain("Check for updates automatically");
    expect(markup).toContain("It never updates anything by itself.");
    expect(markup).toMatch(/<input type="checkbox"\/>\s*Check for updates automatically/);
    expect(page(true)).toMatch(
      /<input type="checkbox" checked=""\/>\s*Check for updates automatically/,
    );
  });
});

describe("the notification for updates", () => {
  const notifiable: Notifiable = {
    tag: "/repos/one:updates",
    title: "one",
    body: "Updates are available: Claude Code 2.1.288.",
    subject: { arm: "local", install: "/repos/one" },
    pipeline: null,
  };

  function notifier() {
    const shown: { title: string; body: string; tag: string }[] = [];
    class Fake {
      onclick: ((event: Event) => unknown) | null = null;
      constructor(title: string, init: { body: string; tag: string; silent: boolean }) {
        shown.push({ title, body: init.body, tag: init.tag });
      }
    }
    return { shown, made: createNotifier({ Notification: Fake, open: () => undefined }) };
  }

  test("is raised once, tagged by install so a newer set replaces it", () => {
    const { made, shown } = notifier();

    expect(made.raise(notifiable, { enabled: true, focused: false })).toBe(true);
    expect(shown).toEqual([
      {
        title: "one",
        body: "Updates are available: Claude Code 2.1.288.",
        tag: "/repos/one:updates",
      },
    ]);
  });

  test("is not raised with notifications off, or while the window is being looked at", () => {
    const { made, shown } = notifier();

    expect(made.raise(notifiable, { enabled: false, focused: false })).toBe(false);
    expect(made.raise(notifiable, { enabled: true, focused: true })).toBe(false);
    expect(shown).toEqual([]);
  });
});

describe("a container that runs as root", () => {
  const noop = (): void => undefined;
  const asRoot = report({ user: { root: true, dockerfileDrops: true, unwritable: [] } });

  test("is an error where a config runs claude, and says a rebuild fixes it", () => {
    expect(rootReading(solo, event(), asRoot)).toMatchObject({ level: "error", rebuild: true });
    expect(rootReading(solo, event(), asRoot)!.text).toContain(
      "Claude Code refuses to run as root, so every unit on the claude provider fails.",
    );
    expect(rootProblem(solo, event(), asRoot)).toEqual([
      {
        level: "error",
        text: "its container runs as root, which Claude Code refuses: its image predates its Dockerfile, so rebuild",
      },
    ]);
  });

  test("is a warning where nothing runs claude", () => {
    const cursor = localReport({
      facts: solo,
      directory: directory({ configFields: fields("v0.13.2", "cursor") }),
    });

    expect(rootReading(solo, cursor, asRoot)).toMatchObject({ level: "warning", rebuild: true });
  });

  test("a Dockerfile that never drops privileges is not fixed by a rebuild", () => {
    const never = report({ user: { root: true, dockerfileDrops: false, unwritable: [] } });

    expect(rootReading(solo, event(), never)).toMatchObject({ rebuild: false });
    expect(rootReading(solo, event(), never)!.text).toContain("has no USER line");
  });

  test("an unprivileged container, an unanswered question and no report say nothing", () => {
    expect(rootReading(solo, event(), report())).toBeNull();
    expect(
      rootReading(
        solo,
        event(),
        report({ user: { root: null, dockerfileDrops: true, unwritable: [] } }),
      ),
    ).toBeNull();
    expect(rootProblem(solo, event(), null)).toEqual([]);
  });

  test("the rail badges the install, and the console's header counts it", () => {
    const problems = rootProblem(solo, event(), asRoot);
    const rail = renderToStaticMarkup(
      <Rail
        surface="companion"
        facts={[]}
        now={new Date()}
        signedIn={false}
        signIn={null}
        onSignedIn={() => undefined}
        installs={[solo]}
        problems={{ [solo.dir]: problems }}
        onSettings={noop}
      />,
    );

    expect(rail).toMatch(/class="rail-problem error" aria-label="1 error"/);
    expect(rail).toContain("Error — its container runs as root");

    const status = consoleStatus(solo, event(), problems);
    expect(status.problems[0]).toEqual(problems[0]);
  });
});

describe("volumes the container cannot write", () => {
  const locked = report({
    user: { root: false, dockerfileDrops: true, unwritable: ["/data/engine", "/data/repos"] },
  });

  test("is said with the cause and that the fix removes nothing", () => {
    const reading = volumesReading(locked)!;

    expect(reading).toContain("The container cannot write /data/engine and /data/repos.");
    expect(reading).toContain("created while this install's image still ran as root");
    expect(reading).toContain("removes nothing");
  });

  test("is an error on the rail and in the console's header", () => {
    expect(volumesProblem(locked)).toEqual([
      {
        level: "error",
        text: "its container cannot write /data/engine and /data/repos: the volumes are still root's",
      },
    ]);
  });

  test("one volume is one volume, and writable ones say nothing", () => {
    const one = report({
      user: { root: false, dockerfileDrops: true, unwritable: ["/data/engine"] },
    });

    expect(volumesReading(one)).toContain("That volume was");
    expect(volumesReading(report())).toBeNull();
    expect(volumesProblem(null)).toEqual([]);
  });
});

describe("tooling the commands need", () => {
  const vpEvent = localReport({
    facts: solo,
    directory: directory({
      configFields: [
        ...fields("v0.13.2", "claude"),
        {
          path: "installCommand",
          scope: "tenant",
          type: "string",
          state: "set",
          value: "vp install --ignore-scripts",
        },
        { path: "checkCommand", scope: "tenant", type: "string", state: "set", value: "vp check" },
        { path: "testCommand", scope: "tenant", type: "string", state: "set", value: "npm test" },
      ],
    }),
  });
  const tools = (vp: { inDockerfile: boolean; inContainer: boolean | null }) =>
    report({
      tools: [
        { tool: "vp", ...vp },
        { tool: "pnpm", inDockerfile: false, inContainer: false },
      ],
    });

  test("the tools are the first words of the four commands, the known ones", () => {
    expect(neededTools(solo, vpEvent)).toEqual([{ tool: "vp", whose: ["one"] }]);
    expect(neededTools(solo, null)).toEqual([]);
  });

  test("a tool the Dockerfile does not install is added; one it installs but the image lacks is rebuilt", () => {
    expect(
      toolsReading(solo, vpEvent, tools({ inDockerfile: false, inContainer: false })),
    ).toMatchObject([{ tool: "vp", remedy: "add" }]);
    expect(
      toolsReading(solo, vpEvent, tools({ inDockerfile: true, inContainer: false })),
    ).toMatchObject([{ tool: "vp", remedy: "rebuild" }]);
    expect(
      toolsReading(solo, vpEvent, tools({ inDockerfile: false, inContainer: false }))[0]!.text,
    ).toContain('every unit fails with "vp: not found"');
  });

  test("a tool the container has, or one unasked but installed, says nothing", () => {
    expect(toolsReading(solo, vpEvent, tools({ inDockerfile: true, inContainer: true }))).toEqual(
      [],
    );
    expect(toolsReading(solo, vpEvent, tools({ inDockerfile: true, inContainer: null }))).toEqual(
      [],
    );
    // Nobody runs pnpm here, so its absence is nothing.
    expect(
      toolsReading(solo, vpEvent, tools({ inDockerfile: true, inContainer: true })).length,
    ).toBe(0);
  });

  test("is an error on the rail, and the add has a sentence", () => {
    expect(toolsProblem(solo, vpEvent, tools({ inDockerfile: false, inContainer: false }))).toEqual(
      [{ level: "error", text: "its commands run `vp`, which the Dockerfile does not install" }],
    );
    expect(toolAddReading({ kind: "added", tool: "vp", file: "f" })).toBe(
      "The Dockerfile now installs vp. Rebuild to put it in the container.",
    );
  });
});

describe("Claude Code not signed in", () => {
  const notLoggedIn = report({
    auth: [{ slug: "acme/one", state: "not-logged-in", text: "Not logged in · Please run /login" }],
  });

  test("is read as what it means and what fixes it", () => {
    const [reading] = claudeAuthReading(notLoggedIn);

    expect(reading).toMatchObject({ slug: "acme/one", state: "not-logged-in", signIn: true });
    expect(reading!.text).toContain("is not logged in, so every unit on the claude provider fails");
    expect(reading!.text).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(claudeAuthReading(report())).toEqual([]);
    expect(claudeAuthReading(null)).toEqual([]);
  });

  test("a lapsed subscription is not fixed by signing in again", () => {
    const [reading] = claudeAuthReading(
      report({
        auth: [
          { slug: "acme/one", state: "subscription-lapsed", text: "Your subscription has expired" },
        ],
      }),
    );

    expect(reading).toMatchObject({ signIn: false });
    expect(reading!.text).toContain("Renew the subscription");
  });

  test("is an error on the rail and in the console's header", () => {
    expect(claudeAuthProblem(notLoggedIn)).toEqual([
      { level: "error", text: "Claude Code on acme/one is not signed in" },
    ]);
    expect(
      claudeAuthProblem(
        report({ auth: [{ slug: "acme/one", state: "subscription-lapsed", text: "x" }] }),
      )[0]!.text,
    ).toContain("the subscription has lapsed");
  });

  test("the notice offers the sign-in and a place for the token", () => {
    const markup = renderToStaticMarkup(
      <ClaudeSignIn
        install={solo}
        event={event()}
        readings={claudeAuthReading(notLoggedIn)}
        bridge={bridge()}
        busy={false}
        onStart={() => undefined}
      />,
    );

    expect(markup).toContain('aria-label="Claude Code is not signed in"');
    expect(markup).toContain(">Sign in to Claude<");
    expect(markup).toContain("claude setup-token");
    expect(markup).toContain('aria-label="Claude sign-in token"');
    expect(markup).toContain(">Set the token<");
    // What the CLI said, verbatim, beside the reading of it.
    expect(markup).toContain("Not logged in · Please run /login");
  });

  test("a lapsed subscription gets the explanation and no sign-in", () => {
    const markup = renderToStaticMarkup(
      <ClaudeSignIn
        install={solo}
        event={event()}
        readings={claudeAuthReading(
          report({ auth: [{ slug: "acme/one", state: "subscription-lapsed", text: "lapsed" }] }),
        )}
        bridge={bridge()}
        busy={false}
        onStart={() => undefined}
      />,
    );

    expect(markup).toContain("subscription has lapsed");
    expect(markup).not.toContain(">Sign in to Claude<");
  });
});
