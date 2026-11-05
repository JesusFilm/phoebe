// Sweep scoping (#418): which tracker objects a pipeline's sweeps may touch.

import { describe, expect, test } from "vite-plus/test";
import { resolveConfig, type PhoebeUserConfig } from "./config-schema.ts";
import { sweepScope as sweepScopeOver } from "./sweep-scope.ts";
import type { AnyWorkKindDefinition, WorkUnitKey } from "./work-kinds/definition.ts";
import { buildRegistry } from "./work-kinds/registry.ts";

const READY = "ready-for-agent";
const RESEARCH = "wayfinder:research";
const DEPENDENCIES = "phoebe:dependencies";

/** A minimal custom kind, declaring `unitKey` (and `unitLabel`) only when given one. */
function customKind(
  name: string,
  unitKey?: WorkUnitKey,
  unitLabel?: string,
): AnyWorkKindDefinition {
  return {
    name,
    oneShotEligible: true,
    promptFile: "prompts/custom.md",
    workspace: "worktree",
    ...(unitKey === undefined ? {} : { unitKey }),
    ...(unitLabel === undefined ? {} : { unitLabel }),
    report: { noun: "thing(s)", describe: (unit: { ref: string }) => unit.ref },
    fetch: () => Promise.resolve([]),
    select: () => ({ unit: null, skipped: [], total: 0 }),
    run: () => Promise.resolve(),
  };
}

/** The five built-ins beside `customs`, under the tenant's labels. */
function registryOf(customs: AnyWorkKindDefinition[], labels: Partial<PhoebeUserConfig> = {}) {
  const config = resolveConfig({
    repoSlug: "acme/widget",
    repoUrl: "https://github.com/acme/widget.git",
    installCommand: "npm ci",
    checkCommand: "npm run check",
    testCommand: "npm test",
    ...labels,
  });
  return {
    config,
    registry: buildRegistry(
      config,
      customs.map((definition) => ({ name: definition.name, definition, options: undefined })),
    ),
  };
}

/** The built-ins beside custom kinds of each unit key. */
const { config, registry } = registryOf([
  customKind("nudge"),
  customKind("digest", "none"),
  customKind("dependencies", "issue", DEPENDENCIES),
  customKind("pr-labeller", "pr"),
]);

const sweepScope = (kinds: readonly string[]) => sweepScopeOver(kinds, registry, config.readyLabel);

/** The kind that owns a ticket wearing `labels`, as `kinds`' pipeline sees it. */
const ownerIn = (kinds: readonly string[], labels: readonly string[]) =>
  sweepScope(kinds).issueOwner(labels)?.kind ?? null;

describe("sweepScope", () => {
  test("a pipeline of issue producers sweeps issues and no PRs", () => {
    const scope = sweepScope(["issues", "research"]);
    expect(scope.issues).toBe(true);
    expect(scope.prs).toBe(false);
  });

  test("a pipeline of PR janitors sweeps PRs and no issues", () => {
    const scope = sweepScope(["conflicts", "checks", "reviews"]);
    expect(scope.issues).toBe(false);
    expect(scope.prs).toBe(true);
  });

  // The acceptance case: a pipeline that schedules no issue kind must not touch an
  // issue, whatever the sweep would otherwise have found.
  test("a pipeline that schedules no issue kind owns no issue", () => {
    expect(ownerIn(["conflicts"], [])).toBeNull();
    expect(ownerIn(["conflicts"], [RESEARCH])).toBeNull();
    expect(ownerIn(["conflicts"], [DEPENDENCIES])).toBeNull();
  });

  test("a pipeline of custom kinds alone sweeps nothing", () => {
    const scope = sweepScope(["nudge", "digest"]);
    expect(scope.issues).toBe(false);
    expect(scope.prs).toBe(false);
  });

  test("an empty pipeline sweeps nothing", () => {
    const scope = sweepScope([]);
    expect(scope.issues).toBe(false);
    expect(scope.prs).toBe(false);
  });

  // The partition that matters: two pipelines split the issue producers between
  // them, and each re-arms only what it works. Neither can re-arm a ticket the
  // other has an agent on.
  describe("the issue producers partition by their queue labels", () => {
    test("a ready ticket belongs to the pipeline that schedules `issues`", () => {
      expect(ownerIn(["issues"], [READY])).toBe("issues");
      expect(ownerIn(["research"], [READY])).toBeNull();
    });

    test("a research ticket belongs to the pipeline that schedules `research`", () => {
      expect(ownerIn(["issues"], [READY, RESEARCH])).toBeNull();
      expect(ownerIn(["research"], [READY, RESEARCH])).toBe("research");
    });

    test("a ticket wearing no queue label belongs to no pipeline", () => {
      expect(ownerIn(["issues"], [])).toBeNull();
      expect(ownerIn(["research"], [])).toBeNull();
      expect(ownerIn(["issues", "research"], ["bug"])).toBeNull();
    });
  });

  test("a pipeline scheduling both producers owns both shapes of ticket", () => {
    expect(ownerIn(["issues", "research"], [READY])).toBe("issues");
    expect(ownerIn(["issues", "research"], [RESEARCH])).toBe("research");
  });

  test("the research label is the tenant's, not a hardcoded word", () => {
    const tenant = registryOf([], { researchLabel: "wayfinder" });
    const scope = sweepScopeOver(["research"], tenant.registry, tenant.config.readyLabel);
    expect(scope.issueOwner(["wayfinder"])?.kind).toBe("research");
    expect(scope.issueOwner([RESEARCH])).toBeNull();
  });

  test("the owner names the queue label it was found by", () => {
    expect(sweepScope(["issues"]).issueOwner([READY])).toEqual({
      kind: "issues",
      unitLabel: READY,
    });
    expect(sweepScope(["research"]).issueOwner([RESEARCH])).toEqual({
      kind: "research",
      unitLabel: RESEARCH,
    });
  });

  // #753: the sweeps follow a kind's declared `unitKey`, not its name.
  describe("a custom kind sweeps what its unitKey says", () => {
    test("an issue-keyed custom kind gets the stranded and quarantine sweeps", () => {
      const scope = sweepScope(["dependencies"]);
      expect(scope.issues).toBe(true);
      expect(scope.prs).toBe(false);
    });

    test("a PR-keyed custom kind gets the PR half of the quarantine sweep", () => {
      const scope = sweepScope(["pr-labeller"]);
      expect(scope.issues).toBe(false);
      expect(scope.prs).toBe(true);
    });

    test("a kind declaring `none` gets no sweep", () => {
      const scope = sweepScope(["digest"]);
      expect(scope.issues).toBe(false);
      expect(scope.prs).toBe(false);
      expect(scope.issueOwner([READY])).toBeNull();
    });

    test("a kind omitting `unitKey` is `none`", () => {
      const scope = sweepScope(["nudge"]);
      expect(scope.issues).toBe(false);
      expect(scope.prs).toBe(false);
    });
  });

  // The review finding on #770: a `dependencies` pipeline beside the main one
  // must not re-arm the main pipeline's tickets, nor the other way round.
  describe("an issue-keyed custom kind owns only tickets wearing its label", () => {
    const main = ["issues", "research", "conflicts", "checks", "reviews"];
    const deps = ["dependencies"];

    test("each claimed ticket has exactly one owner across the two pipelines", () => {
      for (const labels of [[READY], [RESEARCH], [READY, RESEARCH], [DEPENDENCIES]]) {
        const owners = [ownerIn(main, labels), ownerIn(deps, labels)].filter((o) => o !== null);
        expect(owners, JSON.stringify(labels)).toHaveLength(1);
      }
    });

    test("an `issues` ticket mid-run is not the dependency pipeline's to re-arm", () => {
      expect(ownerIn(deps, [READY])).toBeNull();
      expect(ownerIn(deps, [])).toBeNull();
    });

    test("a dependency ticket is the dependency pipeline's, even wearing the ready label", () => {
      expect(ownerIn(deps, [DEPENDENCIES])).toBe("dependencies");
      expect(ownerIn(deps, [READY, DEPENDENCIES])).toBe("dependencies");
      expect(ownerIn(main, [READY, DEPENDENCIES])).toBeNull();
    });

    test("it is found by its own label, never the ready label", () => {
      expect(sweepScope(deps).issueOwner([])).toBeNull();
      expect(sweepScope(deps).issueOwner([DEPENDENCIES])?.unitLabel).toBe(DEPENDENCIES);
    });

    test("a ticket two kinds could claim belongs to neither", () => {
      const both = [RESEARCH, DEPENDENCIES];
      expect(ownerIn(main, both)).toBeNull();
      expect(ownerIn(deps, both)).toBeNull();
      expect(ownerIn([...main, ...deps], both)).toBeNull();
    });

    test("ownership reads the whole registry, so an unscheduled kind's ticket is nobody's here", () => {
      // `dependencies` is registered but this pipeline does not run it: the
      // ticket is still its, so `issues` here must leave it alone.
      expect(ownerIn(["issues"], [READY, DEPENDENCIES])).toBeNull();
    });
  });
});
