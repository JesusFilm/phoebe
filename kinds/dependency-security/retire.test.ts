// What a retired issue is told: the comment names each package under the
// reason it left, and the close reason follows from those. The scan-level
// tests in index.test.ts cover when an issue is retired at all.

import { describe, expect, test } from "vite-plus/test";
import type { MentioningIssue } from "../../src/github-client.ts";
import { stubGitHub } from "../../src/github-stub.ts";
import type { WorkKindRunCtx } from "../../src/work-kinds/definition.ts";
import type { Advisory, Candidate } from "../dependencies/candidate.ts";
import { MIN_SEVERITY_DEFAULT } from "../dependencies/policy.ts";
import type { PhoebeLabel } from "../../src/labels.ts";
import { movedKey, planSecurity } from "./plan.ts";
import { retireUncovered, type RetireInput } from "./retire.ts";

const routingLabel: PhoebeLabel = { name: "phoebe:dependencies", description: "" };
const options = {
  minSeverity: MIN_SEVERITY_DEFAULT,
  routingLabel,
  bootstrapperPin: "skip" as const,
  transitive: "bundle" as const,
};

const advisory = (
  id: string,
  severity: Advisory["severity"],
  fixedIn: string | null,
): Advisory => ({
  id,
  severity,
  fixedIn,
});

function transitive(pkg: string, overrides: Partial<Candidate> = {}): Candidate {
  return {
    manager: "npm",
    package: pkg,
    current: "1.0.0",
    target: "1.0.0",
    updateType: "patch",
    depType: "prod",
    workspace: "package.json",
    advisories: [advisory(`GHSA-${pkg}`, "high", "1.0.1")],
    peers: [],
    via: ["expo"],
    ...overrides,
  };
}

function open(number: number, body: string): MentioningIssue {
  return {
    number,
    body,
    state: "open",
    stateReason: null,
    closedAt: null,
    labels: ["dependencies", "security", routingLabel.name],
  };
}

function retire(issue: MentioningIssue, input: Partial<RetireInput> & Pick<RetireInput, "plan">) {
  const comments: string[] = [];
  const closed: string[] = [];
  const ctx = {
    github: stubGitHub({
      issueLabels: () => [],
      updateIssueBody: () => {},
      postUnitComment: (_target, body) => {
        comments.push(body);
      },
      closeIssue: (n, reason) => {
        closed.push(`#${n} ${reason}`);
      },
    }).forCycle() as unknown as WorkKindRunCtx["github"],
    log: () => {},
    clock: { now: () => new Date("2026-11-06T00:00:00Z"), sleep: async () => {} },
  };
  const result = retireUncovered(
    [issue],
    {
      moved: new Map(),
      prs: [],
      routingLabel: routingLabel.name,
      processingLabel: "processing",
      transitive: "bundle",
      minSeverity: MIN_SEVERITY_DEFAULT,
      complete: true,
      uncovered: new Set([issue.number]),
      ...input,
    },
    ctx,
  );
  return { comments, closed, result };
}

describe("retireUncovered", () => {
  test("a bundle with nothing left names each package under the reason it left", () => {
    const names = ["dropped", "fixed", "lower", "rerated", "stuck"];
    const bundle = open(
      40,
      planSecurity(
        names.map((name) => transitive(name)),
        options,
      ).planned[0]!.body,
    );

    const moved = new Map([[movedKey("npm", "dropped", "1.0.1"), 41]]);
    const now = planSecurity(
      [
        transitive("dropped"),
        transitive("lower", { depType: "dev" }),
        transitive("rerated", { advisories: [advisory("GHSA-rerated", "critical", "1.0.1")] }),
        transitive("stuck", { advisories: [advisory("GHSA-stuck-2", "high", null)] }),
      ],
      { ...options, moved },
    );
    expect(now.planned.map((p) => p.bundle.group)).toEqual([
      "security:rerated",
      "security:dropped",
    ]);

    const { comments, closed, result } = retire(bundle, { plan: now, moved });
    expect(closed).toEqual(["#40 not planned"]);
    expect(comments).toEqual([
      [
        "Nothing this issue listed is left for Phoebe to fix, so Phoebe closed it.",
        "",
        "- `dropped`: it needed more than a lockfile fix, so Phoebe files it on its own.",
        "- `rerated`: Phoebe files it in an issue of its own now.",
        "- `fixed`: the scan no longer reports it. The fix landed outside this issue, or the " +
          "package is no longer installed.",
        "- `lower`: its advisories are under `minSeverity` now (prod high, dev critical), so " +
          "Phoebe no longer files it.",
        "- `stuck`: what is left has no fix released and no manifest declares the package, so " +
          "nobody can act on it yet. Phoebe files it again when a fix ships.",
        "",
        "The closed issue holds none of these rows back. If one needs a fix again, Phoebe files " +
          "a new issue for it.",
      ].join("\n"),
    ]);
    expect(result.issues[0]).toMatchObject({ state: "closed", stateReason: "not_planned" });
    expect(result.uncovered.size).toBe(0);
  });

  test("with every row fixed or filed elsewhere, the close reads as completed", () => {
    const bundle = open(40, planSecurity([transitive("fixed")], options).planned[0]!.body);
    const { closed } = retire(bundle, { plan: planSecurity([], options) });
    expect(closed).toEqual(["#40 completed"]);
  });

  test("an issue that cannot be closed is returned as it was and checked again next scan", () => {
    const bundle = open(40, planSecurity([transitive("fixed")], options).planned[0]!.body);
    const logged: string[] = [];
    const ctx = {
      github: stubGitHub({
        issueLabels: () => [],
        updateIssueBody: () => {
          throw new Error("gh exploded");
        },
      }).forCycle() as unknown as WorkKindRunCtx["github"],
      log: (line: string) => logged.push(line),
      clock: { now: () => new Date("2026-11-06T00:00:00Z"), sleep: async () => {} },
    };
    const result = retireUncovered(
      [bundle],
      {
        plan: planSecurity([], options),
        moved: new Map(),
        prs: [],
        routingLabel: routingLabel.name,
        processingLabel: "processing",
        transitive: "bundle",
        minSeverity: MIN_SEVERITY_DEFAULT,
        complete: true,
        uncovered: new Set([40]),
      },
      ctx,
    );
    expect(result.issues).toEqual([bundle]);
    expect([...result.uncovered]).toEqual([40]);
    expect(logged[0]).toContain("#40 has nothing left to do but could not be closed");
  });

  test("a scan that could not see everything keeps what the last scan found, and adds nothing", () => {
    const seen = open(40, planSecurity([transitive("fixed")], options).planned[0]!.body);
    const fresh = { ...seen, number: 41 };
    const logged: string[] = [];
    const ctx = {
      github: stubGitHub({
        issueLabels: () => [],
      }).forCycle() as unknown as WorkKindRunCtx["github"],
      log: (line: string) => logged.push(line),
      clock: { now: () => new Date("2026-11-06T00:00:00Z"), sleep: async () => {} },
    };
    const result = retireUncovered(
      [seen, fresh],
      {
        plan: planSecurity([], options),
        moved: new Map(),
        prs: [],
        routingLabel: routingLabel.name,
        processingLabel: "processing",
        transitive: "bundle",
        minSeverity: MIN_SEVERITY_DEFAULT,
        complete: false,
        uncovered: new Set([40]),
      },
      ctx,
    );
    expect(result.issues).toEqual([seen, fresh]);
    expect([...result.uncovered]).toEqual([40]);
    expect(logged).toEqual([
      "2 open issue(s) may have nothing left to fix, but a source failed or answered in part " +
        "this scan, so Phoebe leaves them as they are.",
    ]);
  });
});
