// The setup page: the command before the button, the output under it, and a
// way past it whatever happens.

import type { BootstrapPlan, BootstrapRun } from "phoebe-agent/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vite-plus/test";
import { SetupPage } from "./setup-page.tsx";
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

  test("a start is a different sentence and a different button, with no prompt", () => {
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
    expect(markup).toContain("No permission prompt.");
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

  test("a browser, and a step mid-run, both leave the button off", () => {
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
    expect(markup).toContain('<button type="button" disabled="">Install Docker</button>');
    expect(markup).toContain(
      '<span class="stdout">Found Docker Desktop [Docker.DockerDesktop]\n</span>',
    );
    expect(markup).toContain('<span class="stderr">slow mirror\n</span>');
    expect(markup).toContain("Running winget install --exact --id Docker.DockerDesktop…");
  });

  test("how the step ended, and what the page waits for next", () => {
    const base: BootstrapRun = {
      tool: "docker",
      need: "start",
      command: "open -a Docker",
      startedAt: "2026-10-22T12:00:00.000Z",
      lines: [],
    };

    const waiting = page({
      environment: DOWN,
      run: { ...base, exit: { tool: "docker", need: "start", code: 0 } },
    });
    expect(waiting).toContain("Done. Waiting for Docker to answer");

    const failed = page({
      environment: DOWN,
      run: { ...base, exit: { tool: "docker", need: "start", code: 1 } },
    });
    expect(failed).toContain("The command exited with code 1");

    const killed = page({
      environment: DOWN,
      run: { ...base, exit: { tool: "docker", need: "start", code: null } },
    });
    expect(killed).toContain("The command exited with no code");
  });

  test("once Docker answers, the page says so and the way out is Done", () => {
    const markup = page({
      environment: environment(),
      plan: { steps: [], blocked: [] },
      run: {
        tool: "docker",
        need: "start",
        command: "open -a Docker",
        startedAt: "2026-10-22T12:00:00.000Z",
        lines: [],
        exit: { tool: "docker", need: "start", code: 0 },
      },
    });

    expect(markup).toContain('<p class="outcome">Docker is running · Compose v2.29.7');
    expect(markup).not.toContain("Waiting for Docker");
    expect(markup).toContain('href="#/">Done</a>');
  });

  test("before main has answered, it is only looking", () => {
    const markup = page({ environment: null, plan: null });
    expect(markup).toContain("Looking for Docker…");
    expect(markup).not.toContain("<button");
  });
});
