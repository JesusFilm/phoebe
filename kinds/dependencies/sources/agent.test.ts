// The agent fallback source: what the agent writes to scratch is checked
// against the candidate contract, a bad record is dropped and counted, and a
// run that leaves nothing is a failed source rather than a throw.

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import type { Candidate } from "../candidate.ts";
import {
  CANDIDATES_FILE,
  agentUpdateType,
  CLAIMED_FILE,
  DEPENDENCY_DETECT_PROMPT_FILE,
  parseAgentCandidates,
  runAgentSource,
  type AgentSourceCtx,
} from "./agent.ts";

const gradle: Candidate = {
  manager: "gradle",
  package: "com.squareup.okhttp3:okhttp",
  current: "4.12.0",
  target: "5.1.0",
  updateType: "major",
  publishedAt: "2025-07-07T00:00:00.000Z",
  depType: "prod",
  workspace: "android/app/build.gradle",
  advisories: [],
  peers: [],
  repositoryUrl: "https://github.com/square/okhttp",
};

const docker: Candidate = {
  manager: "dockerfile",
  package: "node",
  current: "22.11.0-bookworm",
  target: "22.20.0-bookworm",
  updateType: "minor",
  depType: "prod",
  workspace: "Dockerfile",
  advisories: [{ id: "CVE-2025-0001", severity: "high", fixedIn: "22.12.0-bookworm" }],
  peers: [],
};

type Harness = {
  ctx: AgentSourceCtx;
  scratch: string;
  logged: string[];
  promptArgs: Record<string, string> | undefined;
};

function harness(opts: { writes?: string; throws?: Error } = {}): Harness {
  const scratch = mkdtempSync(join(tmpdir(), "phoebe-agent-source-"));
  const logged: string[] = [];
  let promptArgs: Record<string, string> | undefined;
  const ctx: AgentSourceCtx = {
    log: (line) => logged.push(line),
    workspace: { mode: "readonly", dir: scratch, scratch },
    agent: {
      run: async (runOpts) => {
        promptArgs = runOpts?.promptArgs;
        if (opts.throws !== undefined) throw opts.throws;
        if (opts.writes !== undefined) writeFileSync(join(scratch, CANDIDATES_FILE), opts.writes);
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
    logged,
    get promptArgs() {
      return promptArgs;
    },
  };
}

describe("runAgentSource", () => {
  test("a valid file comes back as candidates, with the claimed manifests handed to the agent", async () => {
    const h = harness({ writes: JSON.stringify([gradle, docker]) });
    const result = await runAgentSource(h.ctx, {
      claimed: ["pnpm-workspace.yaml", "package.json", "package.json"],
    });
    expect(result).toEqual({ ok: true, candidates: [gradle, docker] });
    expect(h.promptArgs).toEqual({
      SCRATCH_DIR: h.scratch,
      CLAIMED_JSON: join(h.scratch, CLAIMED_FILE),
      CANDIDATES_JSON: join(h.scratch, CANDIDATES_FILE),
    });
    expect(JSON.parse(readFileSync(join(h.scratch, CLAIMED_FILE), "utf8"))).toEqual([
      "package.json",
      "pnpm-workspace.yaml",
    ]);
    expect(h.logged).toEqual([]);
  });

  test("two malformed records are dropped, counted in one log line, and the rest stand", async () => {
    const noTarget = { ...gradle, target: "" };
    const badSeverity = {
      ...docker,
      advisories: [{ id: "CVE-2025-0002", severity: "severe", fixedIn: null }],
    };
    const h = harness({ writes: JSON.stringify([noTarget, gradle, badSeverity, docker]) });
    const result = await runAgentSource(h.ctx, { claimed: [] });
    expect(result).toEqual({ ok: true, candidates: [gradle, docker] });
    expect(h.logged).toEqual([
      "agent source: kept 2 record(s), dropped 2 (record 0: target must be a non-empty string; " +
        "record 2: advisory severity must be one of low, moderate, high, critical).",
    ]);
  });

  test("a missing file is a failed source, not a throw", async () => {
    const h = harness();
    const result = await runAgentSource(h.ctx, { claimed: [] });
    expect(result).toEqual({
      ok: false,
      problem: `the agent left no ${CANDIDATES_FILE} in ${h.scratch}`,
    });
  });

  test("a failed agent run is a failed source", async () => {
    const h = harness({ throws: new Error("every provider failed") });
    expect(await runAgentSource(h.ctx, { claimed: [] })).toEqual({
      ok: false,
      problem: "the agent run failed: every provider failed",
    });
  });

  test("a file that is not a JSON array is a failed source", async () => {
    const h = harness({ writes: JSON.stringify({ candidates: [gradle] }) });
    expect(await runAgentSource(h.ctx, { claimed: [] })).toEqual({
      ok: false,
      problem: `${CANDIDATES_FILE} is not a JSON array`,
    });
  });
});

describe("parseAgentCandidates", () => {
  test("null optional fields and absent lists read as left out and empty", () => {
    const { advisories: _a, peers: _p, ...bare } = docker;
    const record = {
      ...bare,
      publishedAt: null,
      repositoryUrl: null,
      advisories: [{ id: "CVE-2025-0001", severity: "high" }],
    };
    const parsed = parseAgentCandidates(JSON.stringify([record]));
    expect(parsed).toEqual({
      ok: true,
      candidates: [{ ...docker, advisories: [{ ...docker.advisories[0], fixedIn: null }] }],
      dropped: [],
    });
  });

  test("a record for a manifest a native row claimed is dropped, since that row lists it", () => {
    const parsed = parseAgentCandidates(JSON.stringify([gradle, docker]), ["Dockerfile"]);
    expect(parsed).toEqual({
      ok: true,
      candidates: [gradle],
      dropped: ["record 1: Dockerfile is claimed by a native row"],
    });
  });

  test("an absolute workspace path drops the record", () => {
    const parsed = parseAgentCandidates(
      JSON.stringify([{ ...gradle, workspace: "/work/android/app/build.gradle" }]),
    );
    expect(parsed).toEqual({
      ok: true,
      candidates: [],
      dropped: ["record 0: workspace must be relative to the checkout"],
    });
  });

  test("a depType outside the contract drops a record whose manifest has the split", () => {
    const parsed = parseAgentCandidates(JSON.stringify([{ ...gradle, depType: "runtime" }]));
    expect(parsed).toMatchObject({
      dropped: ["record 0: depType must be one of prod, dev, optional, peer"],
    });
  });

  test("text that is not JSON is a failure", () => {
    const parsed = parseAgentCandidates("here are the updates:");
    expect(parsed.ok).toBe(false);
  });
});

// #860: on 2026-11-13 four scans of one commit gave the same pins different
// `depType` and `updateType` values, and each answer filed a different bundle.
describe("what the engine decides, not the agent", () => {
  const claude = {
    manager: "dockerfile",
    package: "@anthropic-ai/claude-code",
    current: "2.1.287",
    target: "2.1.325",
    depType: "prod",
    workspace: "templates/container/Dockerfile",
  };
  const only = (record: Record<string, unknown>): Candidate => {
    const parsed = parseAgentCandidates(JSON.stringify([record]));
    if (!parsed.ok || parsed.candidates.length !== 1) throw new Error(JSON.stringify(parsed));
    return parsed.candidates[0]!;
  };

  test("updateType comes from the versions, whatever the agent wrote or left out", () => {
    expect(only({ ...claude, updateType: "minor" }).updateType).toBe("patch");
    expect(only({ ...claude, updateType: "upgrade" }).updateType).toBe("patch");
    expect(only(claude).updateType).toBe("patch");
    expect(only({ ...claude, target: "2.2.0" }).updateType).toBe("minor");
    expect(only({ ...claude, target: "3.0.0" }).updateType).toBe("major");
  });

  test("a move between two digests is a digest update", () => {
    const a = `sha256:${"a".repeat(64)}`;
    const b = `sha256:${"b".repeat(64)}`;
    expect(agentUpdateType(a, b)).toBe("digest");
    expect(agentUpdateType("a".repeat(40), "b".repeat(40))).toBe("digest");
    expect(agentUpdateType("latest", b)).toBe("major");
  });

  test("a pin in a Dockerfile, a workflow file or a script is prod, whatever the agent wrote", () => {
    for (const workspace of [
      "Dockerfile",
      "templates/container/Dockerfile",
      "docker/app.Dockerfile",
      "Dockerfile.dev",
      "compose.yaml",
      ".github/workflows/ci.yml",
      ".github/actions/setup/action.yml",
      ".gitlab-ci.yml",
      "scripts/build-edit-substrate.sh",
    ]) {
      const record = { ...claude, manager: "npm", workspace, depType: "dev" };
      expect(only(record).depType, workspace).toBe("prod");
      const { depType: _d, ...noDepType } = record;
      expect(only(noDepType).depType, workspace).toBe("prod");
    }
    const dockerManager = { ...claude, workspace: "build.gradle", depType: "dev" };
    expect(only(dockerManager).depType).toBe("prod");
  });

  test("a manifest with the split keeps the section the agent reported", () => {
    expect(only({ ...gradle, depType: "dev" }).depType).toBe("dev");
    expect(
      only({ ...gradle, workspace: "composer.json", manager: "composer", depType: "dev" }),
    ).toMatchObject({ depType: "dev" });
  });

  test("one pin reported as prod and minor, then dev and patch, is the same candidate", () => {
    const renovate = {
      manager: "dockerfile",
      package: "renovate",
      current: "44.210.0",
      target: "44.239.1",
      workspace: "templates/container/Dockerfile",
    };
    const first = parseAgentCandidates(
      JSON.stringify([{ ...renovate, depType: "prod", updateType: "major" }]),
    );
    const next = parseAgentCandidates(
      JSON.stringify([{ ...renovate, depType: "dev", updateType: "patch" }]),
    );
    expect(first).toEqual(next);
    expect(first).toMatchObject({ candidates: [{ depType: "prod", updateType: "minor" }] });
  });
});

test("the detection prompt ships beside the kinds", () => {
  expect(existsSync(DEPENDENCY_DETECT_PROMPT_FILE)).toBe(true);
  const prompt = readFileSync(DEPENDENCY_DETECT_PROMPT_FILE, "utf8");
  expect(prompt).not.toContain(`"updateType"`);
  for (const placeholder of ["{{CLAIMED_JSON}}", "{{CANDIDATES_JSON}}", "{{SCRATCH_DIR}}"]) {
    expect(prompt).toContain(placeholder);
  }
});
