// The dependencies implementer kind: it registers from a catalog declaration,
// lists only issues carrying its own label, claims with the processing label
// and never the ready label, and hands the engine the issue's marker to end a
// PR body with.

import { existsSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import { resolveConfig, type PhoebeUserConfig } from "../../src/config-schema.ts";
import type { Issue } from "../../src/orchestrator.ts";
import { selectPipeline } from "../../src/pipeline.ts";
import type { WorkKindRunCtx } from "../../src/work-kinds/definition.ts";
import { createWorkKindRegistry } from "../../src/work-kinds/load-custom.ts";
import { renderMarker } from "../dependencies/fingerprint.ts";
import dependenciesKind, { DEPENDENCIES_PROMPT_FILE } from "./index.ts";

function userConfig(kindBlock: Record<string, unknown>): PhoebeUserConfig {
  return {
    repoSlug: "acme/widget",
    repoUrl: "https://github.com/acme/widget.git",
    installCommand: "npm ci",
    checkCommand: "npm run check",
    testCommand: "npm test",
    pipelines: { deps: { kinds: { dependencies: kindBlock } } },
  };
}

async function registered(kindBlock: Record<string, unknown>) {
  const config = resolveConfig(userConfig(kindBlock));
  const registry = await createWorkKindRegistry(selectPipeline(config, "deps"), "/nowhere");
  return { config, entry: registry.get("dependencies") };
}

const MARKER = renderMarker({ key: "npm:production", fingerprint: "0123456789ab" });

function issue(number: number, labels: string[], body = `| table |\n\n${MARKER}\n`): Issue {
  return { number, title: `Deps ${number}`, body, labels, createdAt: "2026-11-01T00:00:00Z" };
}

/** A run ctx whose GitHub answers only what the kind is allowed to ask. */
function ctxFor(
  config: ReturnType<typeof resolveConfig>,
  issues: Issue[],
  calls: { listed: string[]; added: string[]; workflows: unknown[] },
): WorkKindRunCtx {
  return {
    kind: "dependencies",
    config,
    options: undefined,
    env: {},
    cycle: {
      issueBody: () => null,
      registerIssues: () => {},
      blockerStates: () => new Map(),
      feature: () => null,
    },
    clock: { now: () => new Date(), sleep: () => Promise.resolve() },
    inFlight: new Set<string>(),
    quarantined: new Set<string>(),
    log: () => {},
    github: new Proxy({} as WorkKindRunCtx["github"], {
      get(_target, prop) {
        if (prop === "listLabeledIssues")
          return (label: string) => {
            calls.listed.push(label);
            return issues.filter((i) => i.labels.includes(label));
          };
        if (prop === "issueLabels") return () => [];
        if (prop === "addIssueLabel") return (_n: number, label: string) => calls.added.push(label);
        if (prop === "createLabel") return () => {};
        if (typeof prop !== "string" || prop === "then") return undefined;
        throw new Error(`github.${prop} was not expected to be called`);
      },
    }),
    origin: {
      fetch: () => {},
      branchHead: () => {
        throw new Error("unused");
      },
      commitsBehind: () => 0,
    },
    workspace: { mode: "worktree", dir: "/tmp/w", scratch: "/tmp/s" },
    signal: new AbortController().signal,
    agent: {
      run: () => Promise.resolve(),
      prWorkflow: () => Promise.resolve(),
      issueWorkflow: async (opts) => {
        calls.workflows.push(opts);
      },
      cleanMerge: () => "pushed",
    },
  };
}

describe("registration", () => {
  test("registers through the catalog path as an issue-keyed worktree kind on its label", async () => {
    const { entry } = await registered({ path: "phoebe-agent/kinds/dependencies-work" });
    const definition = entry?.definition;
    expect(definition?.name).toBe("dependencies");
    expect(definition?.workspace).toBe("worktree");
    expect(definition?.unitKey).toBe("issue");
    expect(definition?.unitLabel).toBe("phoebe:dependencies");
    expect(definition?.promptFile).toBe(DEPENDENCIES_PROMPT_FILE);
    expect(existsSync(DEPENDENCIES_PROMPT_FILE)).toBe(true);
  });

  test("the label option moves the unit label", async () => {
    const { entry } = await registered({
      path: "phoebe-agent/kinds/dependencies-work",
      label: "deps",
    });
    expect(entry?.definition.unitLabel).toBe("deps");
  });

  test("an unknown or empty option fails at the factory, naming the block", () => {
    const config = resolveConfig(userConfig({ path: "phoebe-agent/kinds/dependencies-work" }));
    expect(() => dependenciesKind(config, { lable: "x" })).toThrow(
      "kinds.dependencies: unknown option `lable`",
    );
    expect(() => dependenciesKind(config, { label: " " })).toThrow(
      "kinds.dependencies: `label` must be a non-empty string",
    );
  });
});

describe("claiming", () => {
  test("lists and claims only issues with its label, never adding the ready label", async () => {
    const { config, entry } = await registered({ path: "phoebe-agent/kinds/dependencies-work" });
    const kind = entry!.definition;
    const calls = { listed: [] as string[], added: [] as string[], workflows: [] as unknown[] };
    const ctx = ctxFor(
      config,
      [issue(1, ["ready-for-agent"]), issue(2, ["phoebe:dependencies"])],
      calls,
    );

    const gathered = await kind.fetch(ctx);
    const { unit } = kind.select(gathered, ctx);
    expect(calls.listed).toEqual(["phoebe:dependencies"]);
    expect(unit?.ref).toBe("issue:2");

    await kind.run(unit!, ctx);
    expect(calls.added).toEqual([config.processingLabel]);
    expect(calls.added).not.toContain(config.readyLabel);
    expect(calls.workflows).toEqual([
      expect.objectContaining({ issueNumber: 2, prBodyTrailer: MARKER }),
    ]);
  });

  test("an issue without a marker gets no trailer", async () => {
    const { config, entry } = await registered({ path: "phoebe-agent/kinds/dependencies-work" });
    const kind = entry!.definition;
    const calls = { listed: [] as string[], added: [] as string[], workflows: [] as unknown[] };
    const ctx = ctxFor(config, [issue(3, ["phoebe:dependencies"], "no marker")], calls);
    const { unit } = kind.select(await kind.fetch(ctx), ctx);
    await kind.run(unit!, ctx);
    expect(calls.workflows[0]).not.toHaveProperty("prBodyTrailer");
  });
});
