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

  test("an absolute workspace path or an unknown update type drops the record", () => {
    const parsed = parseAgentCandidates(
      JSON.stringify([
        { ...gradle, workspace: "/work/android/app/build.gradle" },
        { ...gradle, updateType: "upgrade" },
      ]),
    );
    expect(parsed).toEqual({
      ok: true,
      candidates: [],
      dropped: [
        "record 0: workspace must be relative to the checkout",
        "record 1: updateType must be one of patch, minor, major, pin, digest, lockfile",
      ],
    });
  });

  test("text that is not JSON is a failure", () => {
    const parsed = parseAgentCandidates("here are the updates:");
    expect(parsed.ok).toBe(false);
  });
});

test("the detection prompt ships beside the kinds", () => {
  expect(existsSync(DEPENDENCY_DETECT_PROMPT_FILE)).toBe(true);
  const prompt = readFileSync(DEPENDENCY_DETECT_PROMPT_FILE, "utf8");
  for (const placeholder of ["{{CLAIMED_JSON}}", "{{CANDIDATES_JSON}}", "{{SCRATCH_DIR}}"]) {
    expect(prompt).toContain(placeholder);
  }
});
