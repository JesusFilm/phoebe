// The setup steps: the order, the prefilled link, the checked token.

import type { ConfigFieldFacts, VerbRunRequest } from "phoebe-agent/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vite-plus/test";
import { GH_TOKEN_KEY, setupApplies, SetupSteps } from "./setup-steps.tsx";
import { directory, install, localReport } from "./test-fixture.ts";

function field(path: string, value: string): ConfigFieldFacts {
  return { path, scope: "tenant", type: "string", state: "set", value };
}

const FIELDS = [field("repoSlug", "JesusFilm/phoebe"), field("defaultProvider", "claude")];

function stopped(envPresent = false) {
  const facts = install({ state: "stopped" });
  return {
    install: facts,
    report: localReport({
      install: facts.dir,
      facts,
      directory: directory({ envPresent, configFields: FIELDS }),
      report: null,
    }),
  };
}

function page(
  over: Partial<Parameters<typeof SetupSteps>[0]> = {},
  started: VerbRunRequest[] = [],
): string {
  const base = stopped();
  return renderToStaticMarkup(
    <SetupSteps
      install={base.install}
      report={base.report}
      run={null}
      running={false}
      onStart={(request) => started.push(request)}
      onVerifyToken={() => Promise.reject(new Error("not in a static render"))}
      {...over}
    />,
  );
}

describe("whether the steps apply", () => {
  test("a solo install that is not initialised, or has no .env, and nothing else", () => {
    const fresh = install({ state: "not-initialised" });
    expect(setupApplies(fresh, null)).toBe(true);

    const { install: facts, report } = stopped(false);
    expect(setupApplies(facts, report)).toBe(true);
    expect(setupApplies(facts, stopped(true).report)).toBe(false);
    expect(setupApplies(facts, null)).toBe(false);
    expect(setupApplies(install({ state: "running" }), report)).toBe(false);
    expect(setupApplies(install({ state: "not-initialised", tenantOnly: true }), null)).toBe(false);
  });
});

describe("the steps", () => {
  test("four, in order, with the one that is done ticked", () => {
    const markup = page();

    expect(markup).toContain("Set up this install");
    const titles = [
      "Initialise the folder",
      "Give Phoebe access to the repository",
      "Give Phoebe an agent to run",
      "Start it",
    ];
    let at = -1;
    for (const title of titles) {
      const next = markup.indexOf(title);
      expect(next, title).toBeGreaterThan(at);
      at = next;
    }
    expect(markup).toContain(
      '<li class="step done"><h3><span class="step-number" aria-hidden="true">✓</span> Initialise the folder',
    );
    expect(markup).toContain(">2</span> Give Phoebe access");
  });

  test("an uninitialised folder offers Initialise and holds the rest back", () => {
    const fresh = install({ state: "not-initialised" });
    const started: VerbRunRequest[] = [];
    const markup = page({ install: fresh, report: null }, started);

    expect(markup).toContain('<button type="button">Initialise</button>');
    expect(markup).toContain("Initialise the folder first, so the config names the repository");
    expect(markup).toMatch(
      /<input aria-label="GitHub token"[^>]*>\s*<button type="submit" disabled=""/,
    );
    expect(markup).toContain('<button type="button" disabled="">Start</button>');
  });

  test("the GitHub step links to the prefilled page for the config's repo", () => {
    const markup = page();

    expect(markup).toContain(
      'href="https://github.com/settings/personal-access-tokens/new?name=Phoebe+phoebe&amp;',
    );
    expect(markup).toContain("target_name=JesusFilm");
    expect(markup).toContain(
      "contents=write&amp;pull_requests=write&amp;issues=write&amp;actions=read",
    );
    expect(markup).toContain("choose <code>phoebe</code>");
    expect(markup).toContain("Check and save");
  });

  test("without a repoSlug the token is saved unchecked, and says so", () => {
    const base = stopped();
    const report = {
      ...base.report,
      directory: directory({
        envPresent: false,
        configFields: [field("defaultProvider", "cursor")],
      }),
    };
    const markup = page({ report });

    expect(markup).toContain("does not state a repoSlug, so the token cannot be checked here");
    expect(markup).toContain(`Save as ${GH_TOKEN_KEY}`);
    expect(markup).not.toContain("personal-access-tokens/new");
  });

  test("the scaffold's placeholder slug is sent to the config tab, not to GitHub", () => {
    const base = stopped();
    const report = {
      ...base.report,
      directory: directory({
        envPresent: false,
        configFields: [field("repoSlug", "your-org/your-repo"), field("defaultProvider", "claude")],
      }),
    };
    const markup = page({ report });

    expect(markup).toContain("The config still says <code>your-org/your-repo</code>");
    expect(markup).not.toContain("personal-access-tokens/new");
    expect(markup).toContain(`Save as ${GH_TOKEN_KEY}`);
  });

  test("the agent step names the provider's key, and Claude's other way in", () => {
    const markup = page();

    expect(markup).toContain(
      "The config runs Claude Code, which reads its key from <code>ANTHROPIC_API_KEY</code>",
    );
    expect(markup).toContain("Sign in to Claude, under AI harness below");
    expect(markup).toContain('placeholder="ANTHROPIC_API_KEY"');
  });
});
