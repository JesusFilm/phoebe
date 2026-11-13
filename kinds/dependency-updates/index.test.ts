// The dependency-updates kind end to end with fake sources and the GitHub
// stub: registration through the catalog path, the in-memory window, select's
// respect for in-flight and quarantined refs, and a run that unions the
// sources and files from what they found.

import { describe, expect, test } from "vite-plus/test";
import { resolveConfig, type PhoebeUserConfig } from "../../src/config-schema.ts";
import type { MentioningIssue, MentioningPr } from "../../src/github-client.ts";
import { stubGitHub, type GitHubStubOverrides } from "../../src/github-stub.ts";
import { selectPipeline } from "../../src/pipeline.ts";
import type { WorkKindRunCtx } from "../../src/work-kinds/definition.ts";
import { createWorkKindRegistry } from "../../src/work-kinds/load-custom.ts";
import { validateWorkKindDefinition } from "../../src/work-kinds/validate.ts";
import type { Candidate } from "../dependencies/candidate.ts";
import { bundleKey, fingerprint, parseMarker, renderMarker } from "../dependencies/fingerprint.ts";
import { DEPENDENCY_DETECT_PROMPT_FILE } from "../dependencies/sources/agent.ts";
import type { SourceRun } from "../dependencies/sources/run.ts";
import dependencyUpdatesKind, { createDependencyUpdatesKind, SCAN_REF } from "./index.ts";
import { resolveDependencyUpdatesOptions, type SourceName } from "./options.ts";

function userConfig(kindBlock: Record<string, unknown>): PhoebeUserConfig {
  return {
    repoSlug: "acme/widget",
    repoUrl: "https://github.com/acme/widget.git",
    installCommand: "npm ci",
    checkCommand: "npm run check",
    testCommand: "npm test",
    pipelines: { deps: { kinds: { "dependency-updates": kindBlock } } },
  };
}

const config = resolveConfig(userConfig({ path: "phoebe-agent/kinds/dependency-updates" }));

function candidate(pkg: string, overrides: Partial<Candidate> = {}): Candidate {
  return {
    manager: "npm",
    package: pkg,
    current: "1.0.0",
    target: "1.1.0",
    updateType: "minor",
    publishedAt: "2026-10-01T00:00:00Z",
    depType: "prod",
    workspace: "package.json",
    advisories: [],
    peers: [],
    ...overrides,
  };
}

type Clock = { now: Date };

function ctxFor(github: GitHubStubOverrides, clock: Clock, logged: string[] = []): WorkKindRunCtx {
  return {
    kind: "dependency-updates",
    config,
    options: undefined,
    env: {},
    github: stubGitHub(github).forCycle() as unknown as WorkKindRunCtx["github"],
    origin: {
      fetch: () => {},
      branchHead: () => {
        throw new Error("unused");
      },
      commitsBehind: () => 0,
    },
    cycle: {
      issueBody: () => null,
      registerIssues: () => {},
      blockerStates: () => new Map(),
      feature: () => null,
    },
    clock: { now: () => clock.now, sleep: async () => {} },
    inFlight: new Set(),
    quarantined: new Set(),
    log: (line) => logged.push(line),
    workspace: { mode: "readonly", dir: "/tmp/checkout", scratch: "/tmp/scratch" },
    signal: new AbortController().signal,
    agent: {
      run: async () => {},
      prWorkflow: async () => {},
      issueWorkflow: async () => {},
      cleanMerge: () => "pushed",
    },
  };
}

/** Sources answering from a table; a name missing from it fails. */
function fakeSources(answers: Partial<Record<SourceName, Candidate[]>>, asked: string[][] = []) {
  return async (_ctx: WorkKindRunCtx, names: readonly SourceName[]): Promise<SourceRun[]> => {
    asked.push([...names]);
    return names.map((name) => ({
      name,
      timeoutMs: 1_000,
      run: async () => {
        const candidates = answers[name];
        return candidates === undefined
          ? { ok: false, problem: "not configured in this test" }
          : { ok: true, candidates };
      },
    }));
  };
}

function kindWith(
  block: Record<string, unknown>,
  answers: Partial<Record<SourceName, Candidate[]>>,
  asked?: string[][],
) {
  return createDependencyUpdatesKind(
    config,
    resolveDependencyUpdatesOptions(block, "kinds.dependency-updates"),
    { createSources: fakeSources(answers, asked) },
  );
}

/**
 * A GitHub that holds `issues` and `prs`, and Phoebe's comments on each issue
 * by number, and records every write.
 */
function gitHub(
  issues: MentioningIssue[] = [],
  prs: MentioningPr[] = [],
  comments: Record<number, string[]> = {},
) {
  const writes: string[] = [];
  const bodies = new Map<number, string>();
  let next = 100;
  const overrides: GitHubStubOverrides = {
    listIssuesMentioning: () => issues,
    listPrsMentioning: () => prs,
    createIssue: (opts) => {
      const n = next++;
      bodies.set(n, opts.body);
      writes.push(`create #${n} ${opts.title}`);
      return n;
    },
    addIssueLabel: (n, label) => {
      writes.push(`label #${n} ${label}`);
    },
    updateIssueBody: (n, body) => {
      bodies.set(n, body);
      writes.push(`update #${n}`);
    },
    postUnitComment: (target) => {
      writes.push(`comment #${target.id}`);
    },
    resolveLogin: () => "phoebe-bot",
    issueTimeoutInputs: (n) => ({
      comments: (comments[n] ?? []).map((body) => ({
        body,
        createdAt: "2026-11-05T00:00:00Z",
        authorLogin: "phoebe-bot",
      })),
      extraActivityAt: null,
      baseline: "body:aa",
    }),
    removeIssueLabel: (n, label) => {
      writes.push(`unlabel #${n} ${label}`);
    },
  };
  return { overrides, writes, bodies };
}

describe("registration", () => {
  test("registers through the catalog path as a readonly scan kind keyed by nothing", async () => {
    const registry = await createWorkKindRegistry(selectPipeline(config, "deps"), "/nowhere");
    const definition = registry.get("dependency-updates")?.definition;
    expect(definition?.name).toBe("dependency-updates");
    expect(definition?.workspace).toBe("readonly");
    expect(definition?.unitKey).toBe("none");
    expect(definition?.unitLabel).toBeUndefined();
    expect(definition?.promptFile).toBe(DEPENDENCY_DETECT_PROMPT_FILE);
  });

  test("the definition validates, and a bad block fails at the factory naming the path", () => {
    expect(() =>
      validateWorkKindDefinition(
        dependencyUpdatesKind(config, undefined),
        "kinds.dependency-updates",
      ),
    ).not.toThrow();
    expect(() => dependencyUpdatesKind(config, { every: "soon" })).toThrow(
      "kinds.dependency-updates: `every` must be a period",
    );
  });

  test("the routing label may never be the ready label", () => {
    expect(() => dependencyUpdatesKind(config, { label: config.readyLabel })).toThrow(
      "`label` must not be the ready label",
    );
  });
});

describe("the window", () => {
  test("one scan per window: due at boot, idle after a run, due again once `every` passes", async () => {
    const clock: Clock = { now: new Date("2026-11-06T00:00:00Z") };
    const kind = kindWith({ every: "12h" }, { native: [] });
    const { overrides } = gitHub();
    const ctx = ctxFor(overrides, clock);

    const first = kind.select(await kind.fetch(ctx), ctx);
    expect(first.unit?.ref).toBe(SCAN_REF);
    expect(first.total).toBe(1);
    await kind.run(first.unit!, ctx);

    clock.now = new Date("2026-11-06T11:59:00Z");
    expect(await kind.fetch(ctx)).toEqual({ due: null });
    expect(kind.select({ due: null }, ctx)).toEqual({ unit: null, skipped: [], total: 0 });

    clock.now = new Date("2026-11-06T12:00:00Z");
    const again = kind.select(await kind.fetch(ctx), ctx);
    expect(again.unit?.ref).toBe(SCAN_REF);
    expect(again.unit?.revision).not.toBe(first.unit?.revision);
  });

  test("a failed scan still waits out the window", async () => {
    const clock: Clock = { now: new Date("2026-11-06T00:00:00Z") };
    const kind = kindWith({}, {});
    const ctx = ctxFor(gitHub().overrides, clock);
    const { unit } = kind.select(await kind.fetch(ctx), ctx);
    await expect(kind.run(unit!, ctx)).rejects.toThrow("every dependency source failed");
    expect(await kind.fetch(ctx)).toEqual({ due: null });
  });

  test("select passes over a scan in flight or quarantined", async () => {
    const clock: Clock = { now: new Date("2026-11-06T00:00:00Z") };
    const kind = kindWith({}, {});
    const ctx = ctxFor(gitHub().overrides, clock);
    const gathered = await kind.fetch(ctx);
    expect(kind.select(gathered, { ...ctx, inFlight: new Set([SCAN_REF]) })).toEqual({
      unit: null,
      skipped: [{ reason: "in flight", count: 1 }],
      total: 1,
    });
    expect(kind.select(gathered, { ...ctx, quarantined: new Set([SCAN_REF]) }).unit).toBeNull();
  });
});

describe("run", () => {
  const clock: Clock = { now: new Date("2026-11-06T00:00:00Z") };

  test("runs the configured sources, unions them, files each bundle with both labels", async () => {
    const asked: string[][] = [];
    const kind = kindWith(
      { sources: ["native", "renovate", "agent"] },
      {
        native: [candidate("@mui/material"), candidate("lodash")],
        renovate: [
          candidate("@mui/material"),
          candidate("@mui/system"),
          candidate("fresh", { publishedAt: "2026-11-05T00:00:00Z" }),
        ],
      },
      asked,
    );
    const { overrides, writes, bodies } = gitHub();
    const logged: string[] = [];
    const ctx = ctxFor(overrides, clock, logged);
    await kind.run({ ref: SCAN_REF, revision: "0" }, ctx);

    expect(asked).toEqual([["native", "renovate", "agent"]]);
    expect(writes).toEqual([
      "create #100 Update 2 npm dependencies (prod:relation:@mui)",
      "label #100 dependencies",
      "label #100 phoebe:dependencies",
      "create #101 Update lodash to 1.1.0",
      "label #101 dependencies",
      "label #101 phoebe:dependencies",
    ]);
    expect(writes.join("\n")).not.toContain(config.readyLabel);
    expect(parseMarker(bodies.get(100)!)?.key).toBe("npm:prod:relation:@mui");
    expect(logged).toContain(
      "sources: native 2 candidate(s), renovate 3 candidate(s), agent failed (not configured in this test).",
    );
    expect(logged).toContain(
      "4 candidate(s): 0 bootstrapper pin(s) left to `phoebe upgrade`, 0 override(s) skipped, " +
        "0 ignored, 1 not yet mature, 0 failed 2 times; 2 bundle(s).",
    );
  });

  test("leaves what is filed, refreshes what moved, and honours a veto and the cap", async () => {
    const kind = kindWith(
      { prConcurrentLimit: 2, grouping: { strategy: "individual" } },
      { native: ["a", "b", "c", "d", "e"].map((p) => candidate(p)) },
    );
    const bundleOf = (p: string) => ({
      manager: "npm",
      group: `prod:package:${p}`,
      candidates: [candidate(p)],
    });
    const marker = (p: string, print?: string) =>
      renderMarker({ key: bundleKey(bundleOf(p)), fingerprint: print ?? fingerprint(bundleOf(p)) });
    const filed = (n: number, body: string, state: "open" | "closed"): MentioningIssue => ({
      number: n,
      body,
      state,
      stateReason: state === "closed" ? "not_planned" : null,
      closedAt: null,
      labels: ["dependencies", "phoebe:dependencies"],
    });
    const { overrides, writes } = gitHub([
      filed(1, marker("a"), "open"),
      filed(2, marker("b", "000000000000"), "open"),
      filed(3, marker("c"), "closed"),
    ]);
    await kind.run({ ref: SCAN_REF, revision: "0" }, ctxFor(overrides, clock));
    // a is left, b refreshed, c vetoed; a and b fill the cap of 2, so d and e wait.
    expect(writes).toEqual(["update #2", "comment #2"]);
  });

  // #810: the agent source read this repo's container template and proposed
  // the bootstrapper pin, which moved it without the engine ref.
  const bootstrapperPin = (workspace: string) =>
    candidate("phoebe-agent", {
      manager: "dockerfile",
      current: "0.7.1",
      target: "0.16.0",
      publishedAt: "2026-10-30T00:00:00Z",
      workspace,
    });

  test.each(["templates/container/Dockerfile", "container/Dockerfile"])(
    "files no bundle for the phoebe-agent pin in %s by default",
    async (workspace) => {
      const kind = kindWith({}, { agent: [bootstrapperPin(workspace)] });
      const { overrides, writes } = gitHub();
      const logged: string[] = [];
      await kind.run({ ref: SCAN_REF, revision: "0" }, ctxFor(overrides, clock, logged));
      expect(writes).toEqual([]);
      expect(logged).toContain(
        "1 candidate(s): 1 bootstrapper pin(s) left to `phoebe upgrade`, 0 override(s) skipped, 0 ignored, 0 not yet mature, " +
          "0 failed 2 times; 0 bundle(s).",
      );
    },
  );

  test("`bootstrapperPin: propose` files the pin like any other dependency", async () => {
    const kind = kindWith(
      { bootstrapperPin: "propose" },
      { agent: [bootstrapperPin("container/Dockerfile")] },
    );
    const { overrides, writes } = gitHub();
    await kind.run({ ref: SCAN_REF, revision: "0" }, ctxFor(overrides, clock));
    expect(writes.filter((w) => w.startsWith("create"))).toEqual([
      "create #100 Update phoebe-agent to 0.16.0",
    ]);
  });

  test("a bump the implementer dropped is re-filed on its own", async () => {
    const kind = kindWith(
      { grouping: { strategy: "all" } },
      { native: [candidate("vite"), candidate("react")] },
    );
    const { overrides, writes, bodies } = gitHub(
      [],
      [
        {
          number: 31,
          body: "## Dropped\n\n- `vite@1.1.0`: broke\n",
          state: "closed",
          merged: true,
        },
      ],
    );
    await kind.run({ ref: SCAN_REF, revision: "0" }, ctxFor(overrides, clock));
    expect(writes.filter((w) => w.startsWith("create"))).toEqual([
      "create #100 Update react to 1.1.0",
      "create #101 Update vite to 1.1.0",
    ]);
    expect(bodies.get(101)).toMatch(/^Failed in #31; filed again on its own\./);
  });

  // #862, from #856's dogfood: PR #857 dropped electron, the retry #858
  // dropped it again with no PR, and the scan after counted one failure.
  describe("a bundle whose every bump dropped", () => {
    const electron = candidate("electron", { current: "45.3.1", target: "45.3.2" });
    const jsdom = candidate("jsdom", { current: "31.0.0", target: "31.0.1" });
    const retryOf = (c: Candidate) => ({
      manager: "npm",
      group: `retry:${c.package}`,
      candidates: [c],
    });
    const markerOf = (bundle: ReturnType<typeof retryOf>) =>
      renderMarker({ key: bundleKey(bundle), fingerprint: fingerprint(bundle) });
    const ticket = (n: number, body: string, parked: boolean): MentioningIssue => ({
      number: n,
      body,
      state: "open",
      stateReason: null,
      closedAt: null,
      labels: ["dependencies", "phoebe:dependencies", ...(parked ? ["phoebe:blocked"] : [])],
    });
    const pr857 = (entries: string): MentioningPr => ({
      number: 857,
      body: `Closes #856\n\n## Dropped\n\n${entries}\n`,
      state: "closed",
      merged: true,
    });
    const allDropped = (entry: string) =>
      `Every bump dropped.\n\n## Dropped\n\n${entry}\n\n<!-- phoebe-blocked -->`;

    test("counts the comment on a parked retry as the second failure", async () => {
      const kind = kindWith({}, { native: [electron, jsdom] });
      const { overrides, writes } = gitHub(
        [
          ticket(859, markerOf(retryOf(jsdom)), false),
          ticket(858, markerOf(retryOf(electron)), true),
        ],
        [pr857("- `electron@45.3.2`: install refused it\n- `jsdom@31.0.1`: install refused it")],
        { 858: [allDropped("- `electron@45.3.2`: install refused it")] },
      );
      const logged: string[] = [];
      await kind.run({ ref: SCAN_REF, revision: "0" }, ctxFor(overrides, clock, logged));
      expect(logged).toContain(
        "2 candidate(s): 0 bootstrapper pin(s) left to `phoebe upgrade`, 0 override(s) skipped, " +
          "0 ignored, 0 not yet mature, 1 failed 2 times; 1 bundle(s).",
      );
      // jsdom's retry is left; electron is no longer planned, so #858 stays parked.
      expect(writes).toEqual([]);
    });

    test("a retry parked only because its release was too new is lifted, and counts nothing more", async () => {
      const kind = kindWith({}, { native: [electron] });
      const { overrides, writes } = gitHub(
        [ticket(858, markerOf(retryOf(electron)), true)],
        [pr857("- `electron@45.3.2`: install refused it")],
        { 858: [allDropped("- `electron@45.3.2` (too new): published today")] },
      );
      const logged: string[] = [];
      await kind.run({ ref: SCAN_REF, revision: "0" }, ctxFor(overrides, clock, logged));
      expect(logged).toContain(
        "1 candidate(s): 0 bootstrapper pin(s) left to `phoebe upgrade`, 0 override(s) skipped, " +
          "0 ignored, 0 not yet mature, 0 failed 2 times; 1 bundle(s).",
      );
      expect(writes).toEqual(["unlabel #858 phoebe:blocked"]);
    });

    test("a bump a PR dropped only because it was too new is filed again in a bundle, not on its own", async () => {
      const kind = kindWith({ grouping: { strategy: "all" } }, { native: [electron, jsdom] });
      const { overrides, writes } = gitHub(
        [],
        [
          pr857(
            "- `electron@45.3.2` (too new): published today\n- `jsdom@31.0.1` (too new): today",
          ),
        ],
      );
      await kind.run({ ref: SCAN_REF, revision: "0" }, ctxFor(overrides, clock));
      expect(writes.filter((w) => w.startsWith("create"))).toEqual([
        "create #100 Update 2 npm dependencies (prod:all)",
      ]);
    });
  });

  test("a security override is not raised to the newest release of its package (#811)", async () => {
    const kind = kindWith(
      { sources: ["renovate"] },
      {
        renovate: [
          candidate("js-yaml", {
            override: true,
            workspace: "pnpm-workspace.yaml",
            current: "4.3.2",
            target: "5.5.0",
            updateType: "major",
          }),
        ],
      },
    );
    const { overrides, writes } = gitHub();
    const logged: string[] = [];
    await kind.run({ ref: SCAN_REF, revision: "0" }, ctxFor(overrides, clock, logged));
    expect(writes).toEqual([]);
    expect(logged).toContain(
      "1 candidate(s): 0 bootstrapper pin(s) left to `phoebe upgrade`, 1 override(s) skipped, 0 ignored, 0 not yet mature, 0 failed 2 times; 0 bundle(s).",
    );
  });
});
