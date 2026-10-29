// The setup page: the command before the button, the button spinning until
// Docker answers, the output under it, and a way past it until then.

import type { BootstrapPlan, BootstrapRun } from "phoebe-agent/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vite-plus/test";
import { dockerReading } from "./local-install.ts";
import { SetupPage, stepPending } from "./setup-page.tsx";
import { environment } from "./test-fixture.ts";

const MISSING = environment({
  platform: "win32",
  docker: { present: false, composeVersion: null, daemonRunning: false },
});
const DOWN = environment({
  platform: "darwin",
  docker: { present: true, composeVersion: "v2.29.7", daemonRunning: false },
});

const WINGET: BootstrapPlan = {
  steps: [
    {
      tool: "docker",
      need: "install",
      command: "winget install --exact --id Docker.DockerDesktop",
      elevates: true,
      note: "Windows asks for permission.",
    },
  ],
  blocked: [],
};

function page(over: Partial<Parameters<typeof SetupPage>[0]> = {}, live = true): string {
  return renderToStaticMarkup(
    <SetupPage
      environment={MISSING}
      plan={WINGET}
      run={null}
      {...(live ? { onRun: () => undefined } : {})}
      {...over}
    />,
  );
}

describe("the setup page", () => {
  test("says what is wrong, shows the command, and offers the button", () => {
    const markup = page();

    expect(markup).toContain("Docker is not on this machine.");
    expect(markup).toContain("<code>winget install --exact --id Docker.DockerDesktop</code>");
    expect(markup).toContain(
      "The OS asks for permission before this runs. Windows asks for permission.",
    );
    expect(markup).toContain('<button type="button">Install Docker</button>');
    expect(markup).toContain('href="#/">Continue without Docker</a>');
  });

  test("a start is a different sentence and a different button, and says nothing about prompts", () => {
    const markup = page({
      environment: DOWN,
      plan: {
        steps: [
          { tool: "docker", need: "start", command: "open -a Docker", elevates: false, note: null },
        ],
        blocked: [],
      },
    });

    expect(markup).toContain("Docker is installed but its daemon is not running.");
    expect(markup).not.toContain("No permission prompt");
    expect(markup).not.toContain("takes a minute");
    expect(markup).toContain('<button type="button">Start Docker</button>');
  });

  test("a step the companion cannot offer says why and where to go", () => {
    const markup = page({
      plan: {
        steps: [],
        blocked: [
          {
            tool: "docker",
            need: "install",
            reason: "winget is not on this machine",
            link: "https://docs.docker.com/get-started/get-docker/",
          },
        ],
      },
    });

    expect(markup).toContain(
      "The companion cannot install Docker here: winget is not on this machine.",
    );
    expect(markup).toContain(
      'href="https://docs.docker.com/get-started/get-docker/">Get Docker</a>',
    );
    expect(markup).not.toContain("<button");
  });

  test("a browser leaves the button off; a step mid-run turns it into a spinner", () => {
    expect(page({}, false)).toContain('<button type="button" disabled="">Install Docker</button>');

    const run: BootstrapRun = {
      tool: "docker",
      need: "install",
      command: "winget install --exact --id Docker.DockerDesktop",
      startedAt: "2026-10-22T12:00:00.000Z",
      lines: [
        { stream: "stdout", line: "Found Docker Desktop [Docker.DockerDesktop]" },
        { stream: "stderr", line: "slow mirror" },
      ],
    };
    const markup = page({ run });
    expect(markup).toContain('class="pending" disabled="" aria-busy="true"');
    expect(markup).toContain("Installing Docker…</button>");
    expect(markup).not.toContain(">Install Docker<");
    expect(markup).toContain(
      '<span class="stdout">Found Docker Desktop [Docker.DockerDesktop]\n</span>',
    );
    expect(markup).toContain('<span class="stderr">slow mirror\n</span>');
    expect(markup).not.toContain("Running winget");
  });

  const START: BootstrapPlan = {
    steps: [
      { tool: "docker", need: "start", command: "open -a Docker", elevates: false, note: null },
    ],
    blocked: [],
  };
  const STARTED: BootstrapRun = {
    tool: "docker",
    need: "start",
    command: "open -a Docker",
    startedAt: "2026-10-22T12:00:00.000Z",
    lines: [],
  };

  test("a start keeps spinning after the command exits, until the daemon answers", () => {
    const waiting = page({
      environment: DOWN,
      plan: START,
      run: { ...STARTED, exit: { tool: "docker", need: "start", code: 0 } },
    });
    expect(waiting).toContain("Starting Docker…</button>");
    expect(waiting).not.toContain("Done.");
    expect(waiting).not.toContain("Waiting for Docker");
    expect(waiting).toContain('href="#/">Continue without Docker</a>');
  });

  test("when main gives up waiting, the spinner stops and the page says what to do", () => {
    const markup = page({
      environment: DOWN,
      plan: START,
      run: { ...STARTED, exit: { tool: "docker", need: "start", code: 0, settled: "timed-out" } },
    });
    expect(markup).toContain('<button type="button">Start Docker</button>');
    expect(markup).toContain("did not answer within two minutes");
    expect(markup).not.toContain("Starting Docker…");
  });

  test("a step that failed says how, and offers the button again", () => {
    const failed = page({
      environment: DOWN,
      plan: START,
      run: { ...STARTED, exit: { tool: "docker", need: "start", code: 1 } },
    });
    expect(failed).toContain("The command exited with code 1");
    expect(failed).toContain('<button type="button">Start Docker</button>');

    const killed = page({
      environment: DOWN,
      plan: START,
      run: { ...STARTED, exit: { tool: "docker", need: "start", code: null } },
    });
    expect(killed).toContain("The command exited with no code");
  });

  test("once Docker answers there is nothing left to click; the page is leaving", () => {
    const markup = page({
      environment: environment(),
      plan: { steps: [], blocked: [] },
      run: { ...STARTED, exit: { tool: "docker", need: "start", code: 0 } },
    });

    expect(markup).toContain('<p class="outcome">Docker is running · Compose v2.29.7');
    expect(markup).not.toContain("Waiting for Docker");
    expect(markup).not.toContain("<button");
    expect(markup).not.toContain('href="#/"');
  });

  test("what counts as pending, step by step", () => {
    const start = { tool: "docker", need: "start" } as const;
    const install = { tool: "docker", need: "install" } as const;
    const down = dockerReading(DOWN);
    const missing = dockerReading(MISSING);
    const ready = dockerReading(environment());
    const ok = { tool: "docker", need: "start", code: 0 } as const;

    expect(stepPending(start, null, down)).toBe(false);
    expect(stepPending(start, STARTED, down)).toBe(true);
    expect(stepPending(start, { ...STARTED, exit: ok }, down)).toBe(true);
    expect(stepPending(start, { ...STARTED, exit: ok }, ready)).toBe(false);
    expect(stepPending(start, { ...STARTED, exit: { ...ok, code: 1 } }, down)).toBe(false);
    expect(stepPending(start, { ...STARTED, exit: { ...ok, settled: "timed-out" } }, down)).toBe(
      false,
    );
    expect(stepPending(start, { ...STARTED, exit: { ...ok, settled: "answered" } }, down)).toBe(
      true,
    );
    // Another step's run is not this button's business.
    expect(stepPending(install, STARTED, missing)).toBe(false);
    // An install waits for the binary, not the daemon.
    const installed: BootstrapRun = {
      ...STARTED,
      need: "install",
      exit: { ...ok, need: "install" },
    };
    expect(stepPending(install, installed, missing)).toBe(true);
    expect(stepPending(install, installed, down)).toBe(false);
  });

  test("before main has answered, it is only looking", () => {
    const markup = page({ environment: null, plan: null });
    expect(markup).toContain("Looking for Docker…");
    expect(markup).not.toContain("<button");
  });
});
