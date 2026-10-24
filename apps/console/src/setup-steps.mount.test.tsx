// @vitest-environment jsdom
// The setup steps with state behind them: a token checked, saved or not, and
// a step ticked off by the run that saved its key.

import { act } from "react";
import type { ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type {
  ConfigFieldFacts,
  GithubTokenVerdict,
  VerbRun,
  VerbRunRequest,
} from "phoebe-agent/contracts";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { GH_TOKEN_KEY, SetupSteps } from "./setup-steps.tsx";
import { directory, install, localReport } from "./test-fixture.ts";

const TOKEN = "github_pat_11AAAA_eXaMpLe_eXaMpLe_eXaMpLe";

function field(path: string, value: string): ConfigFieldFacts {
  return { path, scope: "tenant", type: "string", state: "set", value };
}

const INSTALL = install({ state: "stopped" });
const REPORT = localReport({
  install: INSTALL.dir,
  facts: INSTALL,
  directory: directory({
    envPresent: false,
    configFields: [field("repoSlug", "JesusFilm/phoebe"), field("defaultProvider", "claude")],
  }),
  report: null,
});

function verdict(ok: boolean): GithubTokenVerdict {
  return {
    slug: "JesusFilm/phoebe",
    kind: { id: "fine-grained", label: "fine-grained personal access token", note: null },
    grants: [
      {
        id: "metadata",
        label: "Metadata: Read-only",
        why: "Mandatory.",
        state: "granted",
        detail: "HTTP 200",
      },
      {
        id: "issues",
        label: "Issues: Read and write",
        why: "Move labels.",
        state: ok ? "granted" : "missing",
        detail: ok ? "HTTP 404" : "HTTP 403",
      },
    ],
    ok,
  };
}

const roots: Root[] = [];

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  for (const root of roots) act(() => root.unmount());
  roots.length = 0;
  document.body.replaceChildren();
});

async function mount(element: ReactElement): Promise<HTMLElement> {
  const box = document.createElement("div");
  document.body.append(box);
  const root = createRoot(box);
  roots.push(root);
  await act(async () => root.render(element));
  return box;
}

function tokenField(box: HTMLElement): HTMLInputElement {
  const found = box.querySelector<HTMLInputElement>('input[aria-label="GitHub token"]');
  if (found === null) throw new Error("no token field");
  return found;
}

/** Type into a controlled input the way React hears it. */
async function type(input: HTMLInputElement, value: string): Promise<void> {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!;
  await act(async () => {
    descriptor.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function submit(input: HTMLInputElement): Promise<void> {
  await act(async () => {
    input.form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

function steps(over: Partial<Parameters<typeof SetupSteps>[0]>, started: VerbRunRequest[]) {
  return (
    <SetupSteps
      install={INSTALL}
      report={REPORT}
      run={null}
      running={false}
      onStart={(request) => started.push(request)}
      {...over}
    />
  );
}

describe("checking a token", () => {
  test("a token with every grant is checked against the repo and saved as GH_TOKEN", async () => {
    const started: VerbRunRequest[] = [];
    const asked: [string, string][] = [];
    const box = await mount(
      steps(
        {
          onVerifyToken: (slug, token) => {
            asked.push([slug, token]);
            return Promise.resolve(verdict(true));
          },
        },
        started,
      ),
    );

    const input = tokenField(box);
    await type(input, ` ${TOKEN} `);
    await submit(input);

    expect(asked).toEqual([["JesusFilm/phoebe", TOKEN]]);
    expect(started).toEqual([
      { install: INSTALL.dir, verb: "secret set", key: GH_TOKEN_KEY, value: TOKEN },
    ]);
    expect(box.textContent).toContain("Every grant answered. Saving it as GH_TOKEN.");
    expect(input.value).toBe("");
  });

  test("a missing grant is named, nothing is saved, and saving anyway is a second click", async () => {
    const started: VerbRunRequest[] = [];
    const box = await mount(
      steps({ onVerifyToken: () => Promise.resolve(verdict(false)) }, started),
    );

    const input = tokenField(box);
    await type(input, TOKEN);
    await submit(input);

    expect(started).toEqual([]);
    expect(box.textContent).toContain("Issues: Read and write: missing (HTTP 403). Move labels.");
    expect(box.querySelector("li.missing")).not.toBeNull();
    expect(input.value).toBe(TOKEN);

    const anyway = [...box.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("save it anyway"),
    );
    expect(anyway).toBeDefined();
    await act(async () => anyway!.click());
    expect(started.map((request) => request.verb)).toEqual(["secret set"]);
  });

  test("a check that could not run says so and keeps the token in the field", async () => {
    const started: VerbRunRequest[] = [];
    const box = await mount(
      steps(
        { onVerifyToken: () => Promise.reject(new Error("ENOTFOUND api.github.com")) },
        started,
      ),
    );

    const input = tokenField(box);
    await type(input, TOKEN);
    await submit(input);

    expect(box.textContent).toContain("The check did not run: ENOTFOUND api.github.com");
    expect(started).toEqual([]);
    expect(input.value).toBe(TOKEN);
  });
});

describe("a saved secret", () => {
  test("ticks its step and takes the field away", async () => {
    const run: VerbRun = {
      runId: "run-7",
      install: INSTALL.dir,
      verb: "secret set",
      startedAt: "2026-10-22T12:00:00.000Z",
      lines: [],
      exit: {
        runId: "run-7",
        code: 0,
        outcome: {
          verb: "secret set",
          outcome: {
            key: GH_TOKEN_KEY,
            tenant: null,
            writer: "host-env",
            target: "/repos/youtube-studio/.env",
            at: "2026-10-22T12:00:01.000Z",
          },
        },
      },
    };
    const box = await mount(steps({ run }, []));

    expect(box.querySelector('input[aria-label="GitHub token"]')).toBeNull();
    expect(box.textContent).toContain("GH_TOKEN is in this install's .env.");
    const done = [...box.querySelectorAll("li.step.done h3")].map((h) => h.textContent ?? "");
    expect(done.some((text) => text.includes("Give Phoebe access to the repository"))).toBe(true);
    // The provider step is still open: its key has not been saved.
    expect(box.querySelector('input[aria-label="Provider key"]')).not.toBeNull();
  });
});
