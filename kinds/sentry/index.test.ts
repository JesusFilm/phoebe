// The sentry kind end to end against a fake collector and the GitHub stub:
// the definition's shape, the fetch walk (gates are the adapter's; here the
// watermark, the regression rule and the event read), select's ordering and
// its respect for in-flight and quarantined refs, and a run that files from
// the agent's draft — labels by verdict, the duplicate comment, the throw
// when the agent left nothing.

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { resolveConfig, type PhoebeUserConfig } from "../../src/config-schema.ts";
import { stubGitHub, type GitHubStubOverrides } from "../../src/github-stub.ts";
import { validateWorkKindDefinition } from "../../src/work-kinds/validate.ts";
import type { WorkKindCtx, WorkKindRunCtx } from "../../src/work-kinds/definition.ts";
import type { SentryEvent, SentryGroup, SentrySource } from "./adapter.ts";
import sentryKind, { createSentryKind, SENTRY_PROMPT_FILE, type SentryUnit } from "./index.ts";
import { resolveSentryOptions } from "./options.ts";
import { parseMarker, renderMarker } from "./watermark.ts";

function config(overrides: Partial<PhoebeUserConfig> = {}) {
  return resolveConfig({
    repoSlug: "acme/widget",
    repoUrl: "https://github.com/acme/widget.git",
    installCommand: "npm ci",
    checkCommand: "npm run check",
    testCommand: "npm test",
    defaultProvider: "claude",
    ...overrides,
  });
}

const options = resolveSentryOptions({ org: "acme", project: 1 }, "kinds.sentry");

function group(id: string, overrides: Partial<SentryGroup> = {}): SentryGroup {
  return {
    id,
    shortId: `ACME-${id}`,
    title: `Error ${id}`,
    culprit: `mod${id}`,
    level: "error",
    count: 10,
    firstSeen: "2026-09-01T00:00:00Z",
    lastSeen: "2026-09-11T00:00:00Z",
    permalink: `https://sentry.io/acme/issues/${id}/`,
    raw: { id },
    ...overrides,
  };
}

function event(release: string | null): SentryEvent {
  return {
    eventId: "e",
    release,
    environment: "production",
    transaction: "t",
    dateCreated: null,
    tags: [],
    frames: [],
    raw: { release },
  };
}

function fakeSource(
  groups: SentryGroup[],
  releases: Record<string, string | null | Error>,
): SentrySource {
  return {
    listUnresolvedGroups: async () => groups,
    latestEvent: async (id) => {
      const release = releases[id];
      if (release instanceof Error) throw release;
      return event(release ?? null);
    },
  };
}

function ctxWith(github: GitHubStubOverrides, extra: Partial<WorkKindCtx> = {}): WorkKindCtx {
  const logged: string[] = [];
  return {
    kind: "sentry",
    config: config(),
    options: undefined,
    env: { SENTRY_AUTH_TOKEN: "tok" },
    // The stub answers every method the test declares and throws for the rest;
    // `currentMergeInfo` is one of the rest.
    github: stubGitHub(github).forCycle() as unknown as WorkKindCtx["github"],
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
    clock: { now: () => new Date("2026-09-11T12:00:00Z"), sleep: async () => {} },
    inFlight: new Set(),
    quarantined: new Set(),
    log: (line) => logged.push(line),
    ...extra,
  };
}

describe("the definition", () => {
  test("registers as a readonly, one-shot-eligible kind declaring the Sentry token and no agentEnv", () => {
    const definition = validateWorkKindDefinition(
      sentryKind(config(), { org: "acme", project: 1 }),
      "kinds.sentry",
    );
    expect(definition.name).toBe("sentry");
    expect(definition.workspace).toBe("readonly");
    expect(definition.oneShotEligible).toBe(true);
    expect(definition.requiredEnv).toEqual(["SENTRY_AUTH_TOKEN"]);
    expect(definition.agentEnv).toBeUndefined();
    expect(definition.promptFile).toBe(SENTRY_PROMPT_FILE);
    expect(existsSync(SENTRY_PROMPT_FILE)).toBe(true);
    expect(definition.effort).toBe("high");
    expect(definition.model).toBe("claude-opus-5");
  });

  test("a bad options block fails at the factory, naming the config path", () => {
    expect(() => sentryKind(config(), { org: "acme" })).toThrow("kinds.sentry: `project`");
  });

  test("a provider with no most-capable entry leaves the model to the tenant's defaults", () => {
    expect(
      sentryKind(config({ defaultProvider: "cursor" }), { org: "acme", project: 1 }).model,
    ).toBeUndefined();
  });
});

describe("fetch", () => {
  test("files the unfiled, skips by the watermark rules, orders loudest first, and drops an unreadable event", async () => {
    const kind = createSentryKind(config(), options, {
      createSource: () =>
        fakeSource(
          [
            group("1", { count: 5 }),
            group("2", { count: 50 }),
            group("3"),
            group("4", { lastSeen: "2026-09-12T00:00:00Z" }),
            group("5", { count: 99 }),
            group("6"),
          ],
          { "1": "r1", "2": "r2", "4": null, "5": new Error("500") },
        ),
    });
    const ctx = ctxWith({
      listIssuesMentioning: () => [
        { number: 10, body: renderMarker("3"), state: "open", stateReason: null, closedAt: null },
        {
          number: 11,
          body: renderMarker("4"),
          state: "closed",
          stateReason: "completed",
          closedAt: "2026-09-11T12:00:00Z",
        },
        {
          number: 12,
          body: renderMarker("6"),
          state: "closed",
          stateReason: "not_planned",
          closedAt: "2026-09-01T00:00:00Z",
        },
        { number: 13, body: "no marker at all", state: "open", stateReason: null, closedAt: null },
      ],
    });
    const gathered = await kind.fetch(ctx);
    expect(gathered.total).toBe(6);
    expect(gathered.candidates.map((c) => [c.ref, c.revision, c.regressionOf])).toEqual([
      ["sentry:2", "r2", null],
      ["sentry:4", undefined, 11],
      ["sentry:1", "r1", null],
    ]);
    expect(gathered.skipped).toEqual([
      { reason: "latest event unavailable", count: 1 },
      { reason: "already filed", count: 1 },
      { reason: "closed as not planned", count: 1 },
    ]);
  });

  test("a failed list propagates — the cycle dies, the restart loop recovers", async () => {
    const kind = createSentryKind(config(), options, {
      createSource: () => ({
        listUnresolvedGroups: async () => {
          throw new Error("Sentry API 401");
        },
        latestEvent: async () => event(null),
      }),
    });
    await expect(kind.fetch(ctxWith({}))).rejects.toThrow("Sentry API 401");
  });
});

describe("select", () => {
  const kind = createSentryKind(config(), options);
  const unit = (id: string): SentryUnit => ({
    ref: `sentry:${id}`,
    group: group(id),
    event: event(null),
    regressionOf: null,
  });

  test("takes the first candidate not in flight and not quarantined, reporting the rest", () => {
    const gathered = {
      total: 4,
      candidates: [unit("1"), unit("2"), unit("3")],
      skipped: [{ reason: "already filed", count: 1 }],
    };
    const selection = kind.select(
      gathered,
      ctxWith({}, { inFlight: new Set(["sentry:1"]), quarantined: new Set(["sentry:2"]) }),
    );
    expect(selection.unit?.ref).toBe("sentry:3");
    expect(selection.total).toBe(4);
    expect(selection.skipped).toEqual([
      { reason: "already filed", count: 1 },
      { reason: "in flight", count: 1 },
      { reason: "quarantined in memory", count: 1 },
    ]);
  });

  test("nothing workable is a null unit with the total kept", () => {
    expect(kind.select({ total: 0, candidates: [], skipped: [] }, ctxWith({}))).toEqual({
      unit: null,
      skipped: [],
      total: 0,
    });
  });
});

describe("run", () => {
  type RunHarness = {
    ctx: WorkKindRunCtx;
    scratch: string;
    created: Array<{ title: string; body: string }>;
    labels: string[];
    createdLabels: string[];
    comments: Array<{ id: number; body: string }>;
    promptArgs: Record<string, string> | undefined;
    logged: string[];
  };

  function harness(
    opts: {
      draft?: string;
      labelMissing?: string;
      duplicateState?: "open" | "closed";
      withReadyPolicy?: boolean;
    } = {},
  ): RunHarness {
    const scratch = mkdtempSync(join(tmpdir(), "phoebe-sentry-run-"));
    const created: RunHarness["created"] = [];
    const labels: string[] = [];
    const createdLabels: string[] = [];
    const comments: RunHarness["comments"] = [];
    const logged: string[] = [];
    let promptArgs: Record<string, string> | undefined;
    const base = ctxWith({
      createIssue: (issue) => {
        created.push(issue);
        return 77;
      },
      addIssueLabel: (_n, label) => {
        if (opts.labelMissing === label && !createdLabels.includes(label)) {
          throw Object.assign(new Error("gh failed"), {
            stderr: `failed to update: 'Label not found: ${label}'`,
          });
        }
        labels.push(label);
      },
      createLabel: (name) => {
        createdLabels.push(name);
      },
      issueState: () => ({
        state: opts.duplicateState ?? "open",
        stateReason: null,
        closedAt: null,
      }),
      postUnitComment: (target, body) => {
        comments.push({ id: target.id, body });
      },
    });
    const ctx: WorkKindRunCtx = {
      ...base,
      log: (line) => logged.push(line),
      workspace: { mode: "readonly", dir: scratch, scratch },
      signal: new AbortController().signal,
      agent: {
        run: async (runOpts) => {
          promptArgs = runOpts?.promptArgs;
          if (opts.draft !== undefined) writeFileSync(join(scratch, "triage.json"), opts.draft);
        },
        prWorkflow: async () => {
          throw new Error("unused");
        },
        issueWorkflow: async () => {
          throw new Error("unused");
        },
        cleanMerge: () => "failed",
      },
    };
    return {
      ctx,
      scratch,
      created,
      labels,
      createdLabels,
      comments,
      get promptArgs() {
        return promptArgs;
      },
      logged,
    };
  }

  const kind = (withReadyPolicy = false) =>
    createSentryKind(config(), { ...options, applyReadyLabel: withReadyPolicy });
  const unit: SentryUnit = {
    ref: "sentry:9",
    revision: "app@2.0.0",
    group: group("9", { title: "Boom", culprit: "src/a.ts in f" }),
    event: event("app@2.0.0"),
    regressionOf: null,
  };

  test("writes the crash to scratch, runs the agent, and files a ready issue with the triaged label", async () => {
    const h = harness({
      draft: JSON.stringify({ verdict: "ready", cause: "src/a.ts:3 — x", change: "y", test: "z" }),
    });
    await kind().run(unit, h.ctx);
    expect(JSON.parse(readFileSync(join(h.scratch, "group.json"), "utf8"))).toEqual({ id: "9" });
    expect(JSON.parse(readFileSync(join(h.scratch, "event.json"), "utf8"))).toEqual({
      release: "app@2.0.0",
    });
    expect(h.promptArgs).toMatchObject({
      SENTRY_TITLE: "Boom",
      SENTRY_RELEASE: "app@2.0.0",
      TRIAGE_JSON: join(h.scratch, "triage.json"),
      REGRESSION_NOTE: "",
    });
    expect(h.created).toHaveLength(1);
    expect(h.created[0]?.title).toBe("Sentry: Boom (src/a.ts in f)");
    expect(parseMarker(h.created[0]!.body)).toBe("9");
    expect(h.created[0]?.body).toContain("## Cause\n\nsrc/a.ts:3 — x");
    expect(h.labels).toEqual(["sentry", "triaged"]);
    expect(h.comments).toEqual([]);
    expect(h.logged.at(-1)).toBe("sentry:9: filed #77 (ready).");
  });

  test("with applyReadyLabel the ready label goes on directly, created when the repo lacks it", async () => {
    const h = harness({
      draft: JSON.stringify({ verdict: "ready", cause: "c", change: "h", test: "t" }),
      labelMissing: "ready-for-agent",
    });
    await kind(true).run(unit, h.ctx);
    expect(h.labels).toEqual(["sentry", "ready-for-agent"]);
    expect(h.createdLabels).toEqual(["ready-for-agent"]);
  });

  test("a not-ready draft gets only the filed label; a regression says so in the prompt and the body", async () => {
    const h = harness({ draft: JSON.stringify({ verdict: "not-ready", openQuestion: "which?" }) });
    await kind().run({ ...unit, regressionOf: 31 }, h.ctx);
    expect(h.promptArgs?.["REGRESSION_NOTE"]).toContain("#31");
    expect(h.created[0]?.body.startsWith("Regression of #31")).toBe(true);
    expect(h.labels).toEqual(["sentry"]);
    expect(h.logged.at(-1)).toBe("sentry:9: filed #77 (not-ready) as a regression of #31.");
  });

  test("a duplicate files not-ready and comments once on the human's open issue", async () => {
    const h = harness({ draft: JSON.stringify({ verdict: "ready", duplicateOf: 12 }) });
    await kind().run(unit, h.ctx);
    expect(h.labels).toEqual(["sentry"]);
    expect(h.comments).toEqual([
      {
        id: 12,
        body: "Sentry is seeing this: [Boom](https://sentry.io/acme/issues/9/) — 10 event(s) in the last 24h on release `app@2.0.0`. Triage filed as #77.",
      },
    ]);
  });

  test("a closed duplicate gets no comment", async () => {
    const h = harness({
      draft: JSON.stringify({ verdict: "not-ready", duplicateOf: 12 }),
      duplicateState: "closed",
    });
    await kind().run(unit, h.ctx);
    expect(h.comments).toEqual([]);
    expect(h.logged).toContain("sentry:9: the named duplicate #12 is closed — no comment posted.");
  });

  test("an unparseable draft still files, as not ready, with the raw text", async () => {
    const h = harness({ draft: "I looked and it seems fine" });
    await kind().run(unit, h.ctx);
    expect(h.created[0]?.body).toContain("## Agent output (unparsed)");
    expect(h.created[0]?.body).toContain("I looked and it seems fine");
    expect(h.labels).toEqual(["sentry"]);
  });

  test("no draft at all throws and files nothing", async () => {
    const h = harness();
    await expect(kind().run(unit, h.ctx)).rejects.toThrow("left no triage.json");
    expect(h.created).toEqual([]);
  });
});
