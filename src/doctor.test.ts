// `phoebe doctor` verdict folding: which check states fail the report, and how
// the crash-loop record reads as a check — especially the quarantine case, the
// "silently running last-known-good" state doctor exists to surface.
// Also covers arm-aware token checks: the App arm and the PAT arm behave
// differently, and the unverifiable state must never fail --check.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import {
  buildDoctorReport,
  crashLoopCheck,
  declaredEnvCheck,
  describeRepoProbe,
  fetchRepoLabels,
  formatDoctorReport,
  labelsCheck,
  launcherFloorCheck,
  promptDriftCheck,
  relayCheck,
  staleStateCheck,
  strayMembersCheck,
  tenantCredential,
  tenantRow,
  tenantTokenCheck,
} from "./doctor.ts";
import { createDeadline, DEADLINE_DETAIL } from "./doctor-deadline.ts";

describe("describeRepoProbe", () => {
  test("200 is reachable", () => {
    expect(describeRepoProbe(200, "acme/widget").ok).toBe(true);
  });

  test("401/403/404 are token verdicts", () => {
    for (const status of [401, 403, 404]) {
      const probe = describeRepoProbe(status, "acme/widget");
      expect(probe.ok).toBe(false);
      expect(probe.detail).toMatch(/token cannot see the repo/);
    }
  });

  test("429 and 5xx fail without blaming the token", () => {
    for (const status of [429, 500, 502, 503]) {
      const probe = describeRepoProbe(status, "acme/widget");
      expect(probe.ok).toBe(false);
      expect(probe.detail).not.toMatch(/token cannot see/);
      expect(probe.detail).toMatch(/not a token verdict/);
    }
  });
});

describe("buildDoctorReport", () => {
  test("warn and unknown do not fail the report; fail does", () => {
    const ok = buildDoctorReport(
      [
        { id: "cli", state: "warn", detail: "behind" },
        { id: "supervisor", state: "unknown", detail: "not in container" },
      ],
      [],
    );
    expect(ok.ok).toBe(true);

    const failing = buildDoctorReport([{ id: "config", state: "fail", detail: "missing" }], []);
    expect(failing.ok).toBe(false);
  });

  test("a failing tenant check fails the whole report", () => {
    const report = buildDoctorReport(
      [{ id: "config", state: "ok", detail: "loads" }],
      [
        {
          path: "core",
          slug: "acme/core",
          checks: [{ id: "token", state: "fail", detail: "no GH_TOKEN" }],
        },
      ],
    );
    expect(report.ok).toBe(false);
    expect(formatDoctorReport(report)).toMatch(/1 failing check/);
  });
});

describe("tenantTokenCheck", () => {
  test("App arm is always ok regardless of token presence", () => {
    const withToken = tenantTokenCheck({
      arm: "app",
      token: "ghp_abc",
      envLabel: "/etc/phoebe/tenant/.env",
      inContainer: true,
    });
    expect(withToken.state).toBe("ok");
    expect(withToken.detail).toMatch(/App arm/);

    const noToken = tenantTokenCheck({
      arm: "app",
      token: undefined,
      envLabel: "/etc/phoebe/tenant/.env",
      inContainer: true,
    });
    expect(noToken.state).toBe("ok");
    expect(noToken.detail).toMatch(/App arm/);
  });

  test("App arm outside the container is still ok, not unverifiable", () => {
    // The arm short-circuits ahead of the container check: GH_APP_ID was
    // readable, so the arm is known even from the host and there is nothing
    // left to be unsure about.
    const check = tenantTokenCheck({
      arm: "app",
      token: undefined,
      envLabel: "/etc/phoebe/tenant/.env",
      inContainer: false,
    });
    expect(check.state).toBe("ok");
    expect(check.detail).toMatch(/App arm/);
  });

  test("PAT arm with a token is ok", () => {
    const check = tenantTokenCheck({
      arm: "pat",
      token: "ghp_abc",
      envLabel: "/etc/phoebe/tenant/.env",
      inContainer: true,
    });
    expect(check.state).toBe("ok");
    expect(check.detail).toMatch(/GH_TOKEN present/);
  });

  test("PAT arm with no token inside the container is a real failure", () => {
    const check = tenantTokenCheck({
      arm: "pat",
      token: undefined,
      envLabel: "/etc/phoebe/tenant/.env",
      inContainer: true,
    });
    expect(check.state).toBe("fail");
    expect(check.detail).toMatch(/no GH_TOKEN/);
  });

  test("PAT arm with no token outside the container is unverifiable, not a failure", () => {
    const check = tenantTokenCheck({
      arm: "pat",
      token: undefined,
      envLabel: "/etc/phoebe/tenant/.env",
      inContainer: false,
    });
    expect(check.state).toBe("unknown");
    expect(check.detail).toMatch(/unverifiable/);
  });

  test("unverifiable state does not fail the report (AC: --check must not fail on it)", () => {
    const report = buildDoctorReport(
      [{ id: "config", state: "ok", detail: "loads" }],
      [
        {
          path: "tenant",
          slug: "acme/core",
          checks: [
            { id: "token", state: "unknown", detail: "unverifiable — ..." },
            { id: "repo", state: "unknown", detail: "not probed (unverifiable)" },
          ],
        },
      ],
    );
    expect(report.ok).toBe(true);
  });
});

describe("launcherFloorCheck", () => {
  test("no floor declared — ok, says check does not apply", () => {
    const check = launcherFloorCheck({
      minBootstrap: null,
      launcherVersion: "0.3.0",
      launcherSource: "dockerfile",
    });
    expect(check.state).toBe("ok");
    expect(check.detail).toMatch(/does not apply/);
  });

  test("launcher below floor (Dockerfile source) — fail with deadlock warning and fix hint", () => {
    const check = launcherFloorCheck({
      minBootstrap: "0.5.0",
      launcherVersion: "0.3.0",
      launcherSource: "dockerfile",
    });
    expect(check.state).toBe("fail");
    expect(check.detail).toContain("0.3.0");
    expect(check.detail).toContain("0.5.0");
    expect(check.detail).toMatch(/not a staleness warning/);
    expect(check.detail).toMatch(/does no work/);
    expect(check.detail).toMatch(/ARG PHOEBE_AGENT_VERSION=0\.5\.0/);
    expect(check.detail).toMatch(/Dockerfile/);
  });

  test("launcher below floor (npm-global source) — fail with npm install fix hint", () => {
    const check = launcherFloorCheck({
      minBootstrap: "0.5.0",
      launcherVersion: "0.3.0",
      launcherSource: "npm-global",
    });
    expect(check.state).toBe("fail");
    expect(check.detail).toMatch(/npm install -g phoebe-agent@0\.5\.0/);
  });

  test("launcher exactly at floor — ok", () => {
    const check = launcherFloorCheck({
      minBootstrap: "0.5.0",
      launcherVersion: "0.5.0",
      launcherSource: "dockerfile",
    });
    expect(check.state).toBe("ok");
    expect(check.detail).toMatch(/meets the engine floor/);
  });

  test("launcher above floor — ok", () => {
    const check = launcherFloorCheck({
      minBootstrap: "0.5.0",
      launcherVersion: "0.7.1",
      launcherSource: "npm-global",
    });
    expect(check.state).toBe("ok");
  });

  test("floor declared but launcher version unknown (unpinned Dockerfile) — unknown", () => {
    const check = launcherFloorCheck({
      minBootstrap: "0.5.0",
      launcherVersion: null,
      launcherSource: "dockerfile",
    });
    expect(check.state).toBe("unknown");
    expect(check.detail).toMatch(/0\.5\.0/);
    expect(check.detail).toMatch(/ARG PHOEBE_AGENT_VERSION/);
  });

  test("floor declared but launcher unknown (no npm global) — unknown", () => {
    const check = launcherFloorCheck({
      minBootstrap: "0.5.0",
      launcherVersion: null,
      launcherSource: "npm-global",
    });
    expect(check.state).toBe("unknown");
    expect(check.detail).toMatch(/not installed globally/);
  });

  test("a floor-violating launcher fails the whole doctor report", () => {
    const report = buildDoctorReport(
      [
        { id: "config", state: "ok", detail: "loads" },
        {
          id: "launcher-floor",
          state: "fail",
          detail: "launcher 0.3.0 is below the engine floor 0.5.0 — ...",
        },
      ],
      [],
    );
    expect(report.ok).toBe(false);
  });
});

describe("crashLoopCheck", () => {
  test("an active quarantine warns and names both commits", () => {
    const check = crashLoopCheck(
      { lastGoodSha: "g".repeat(40), failingSha: "b".repeat(40), failureCount: 3 },
      3,
    );
    expect(check.state).toBe("warn");
    expect(check.detail).toMatch(/quarantined/);
    expect(check.detail).toContain("b".repeat(12));
    expect(check.detail).toContain("g".repeat(12));
  });

  test("crashes below the threshold warn without claiming quarantine", () => {
    const check = crashLoopCheck(
      { lastGoodSha: null, failingSha: "b".repeat(40), failureCount: 1 },
      3,
    );
    expect(check.state).toBe("warn");
    expect(check.detail).not.toMatch(/quarantined/);
  });

  test("a clean record is ok", () => {
    expect(
      crashLoopCheck({ lastGoodSha: "g".repeat(40), failingSha: null, failureCount: 0 }).state,
    ).toBe("ok");
    expect(crashLoopCheck({ lastGoodSha: null, failingSha: null, failureCount: 0 }).state).toBe(
      "ok",
    );
  });
});

describe("labelsCheck", () => {
  test("all labels present — ok, names the repo and every label it checked", () => {
    const check = labelsCheck({
      missing: [],
      present: ["ready-for-agent", "processing", "merged-to-feature", "ready-for-human"],
      slug: "acme/widget",
    });
    expect(check.state).toBe("ok");
    expect(check.detail).toMatch(/acme\/widget/);
    expect(check.detail).toMatch(/mergedLabel/);
  });

  test("one label missing — fail, names the label and the fix command", () => {
    const check = labelsCheck({
      missing: ["processing"],
      present: ["ready-for-agent", "ready-for-human"],
      slug: "acme/widget",
    });
    expect(check.state).toBe("fail");
    expect(check.detail).toMatch(/processing/);
    expect(check.detail).toMatch(/gh label create/);
    expect(check.detail).toMatch(/--repo acme\/widget/);
  });

  test("multiple labels missing — fail, fix command for each", () => {
    const check = labelsCheck({
      missing: ["processing", "ready-for-human"],
      present: ["ready-for-agent"],
      slug: "acme/widget",
    });
    expect(check.state).toBe("fail");
    expect(check.detail).toMatch(/processing/);
    expect(check.detail).toMatch(/ready-for-human/);
    expect(check.detail).toMatch(/gh label create/);
  });

  test("a missing mergedLabel fails with its own create command (#449)", () => {
    const check = labelsCheck({
      missing: ["merged-to-feature"],
      present: ["ready-for-agent", "processing", "ready-for-human"],
      slug: "acme/widget",
    });
    expect(check.state).toBe("fail");
    expect(check.detail).toContain(`gh label create "merged-to-feature" --repo acme/widget`);
  });

  test("a missing-labels fail fails the tenant row", () => {
    const report = buildDoctorReport(
      [{ id: "config", state: "ok", detail: "loads" }],
      [
        {
          path: "tenant",
          slug: "acme/widget",
          checks: [
            { id: "token", state: "ok", detail: "present" },
            { id: "repo", state: "ok", detail: "reachable" },
            labelsCheck({
              missing: ["processing"],
              present: ["ready-for-agent", "ready-for-human"],
              slug: "acme/widget",
            }),
          ],
        },
      ],
    );
    expect(report.ok).toBe(false);
  });
});

describe("promptDriftCheck", () => {
  test("shipped default path — ok, says using shipped default", () => {
    const check = promptDriftCheck({
      issuePromptPath: "prompts/issues-prompt.md",
      defaultIssuePromptPath: "prompts/issues-prompt.md",
      promptContent: null,
    });
    expect(check.state).toBe("ok");
    expect(check.detail).toMatch(/shipped default/);
  });

  test("override with blocker rule — ok", () => {
    const check = promptDriftCheck({
      issuePromptPath: "vendor/prompts/issues.md",
      defaultIssuePromptPath: "prompts/issues-prompt.md",
      promptContent: "If blocked by another issue, edit the body to include `Blocked by #N`.",
    });
    expect(check.state).toBe("ok");
    expect(check.detail).toMatch(/blocker-recording rule/);
  });

  test("override with 'Blocked By' (mixed case) — ok", () => {
    const check = promptDriftCheck({
      issuePromptPath: "vendor/issues.md",
      defaultIssuePromptPath: "prompts/issues-prompt.md",
      promptContent: "Record blocker: Blocked By #N in the body.",
    });
    expect(check.state).toBe("ok");
  });

  test("override without blocker rule — warn, explains consequence and fix", () => {
    const check = promptDriftCheck({
      issuePromptPath: "vendor/prompts/issues.md",
      defaultIssuePromptPath: "prompts/issues-prompt.md",
      promptContent: "You are a coding agent. Work on the issue assigned to you.",
    });
    expect(check.state).toBe("warn");
    expect(check.detail).toMatch(/no blocker-recording rule/);
    expect(check.detail).toMatch(/quarantine/);
    expect(check.detail).toMatch(/Blocked by #N/);
    expect(check.detail).toMatch(/prompts\/issues-prompt\.md/);
  });

  test("override but file unreadable — warn", () => {
    const check = promptDriftCheck({
      issuePromptPath: "vendor/prompts/issues.md",
      defaultIssuePromptPath: "prompts/issues-prompt.md",
      promptContent: null,
    });
    expect(check.state).toBe("warn");
    expect(check.detail).toMatch(/could not be read/);
  });

  test("prompt-drift warn does not fail the report (warn is not fail)", () => {
    const report = buildDoctorReport(
      [{ id: "config", state: "ok", detail: "loads" }],
      [
        {
          path: "tenant",
          slug: "acme/widget",
          checks: [
            { id: "token", state: "ok", detail: "present" },
            promptDriftCheck({
              issuePromptPath: "vendor/issues.md",
              defaultIssuePromptPath: "prompts/issues-prompt.md",
              promptContent: "no blocker rule here",
            }),
          ],
        },
      ],
    );
    expect(report.ok).toBe(true);
  });
});

describe("fetchRepoLabels", () => {
  test("returns label names on 200", async () => {
    const mockFetch = async () =>
      new Response(JSON.stringify([{ name: "ready-for-agent" }, { name: "processing" }]), {
        status: 200,
      });
    const names = await fetchRepoLabels("acme/widget", "ghp_tok", mockFetch as typeof fetch);
    expect(names).toEqual(["ready-for-agent", "processing"]);
  });

  test("returns null when label list is denied (403)", async () => {
    const mockFetch = async () => new Response(null, { status: 403 });
    const names = await fetchRepoLabels("acme/widget", "ghp_tok", mockFetch as typeof fetch);
    expect(names).toBeNull();
  });

  test("returns null on network error", async () => {
    const mockFetch = async (): Promise<Response> => {
      throw new Error("ECONNREFUSED");
    };
    const names = await fetchRepoLabels("acme/widget", "ghp_tok", mockFetch as typeof fetch);
    expect(names).toBeNull();
  });
});

describe("tenantRow label access regression", () => {
  test("repo probe ok but label list denied — labels unknown with permission guidance", async () => {
    const mockFetch = async (url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      if (urlStr.includes("/labels")) return new Response(null, { status: 403 });
      return new Response(JSON.stringify({ id: 1, name: "widget" }), { status: 200 });
    };
    const row = await tenantRow({
      path: "tenant",
      slug: "acme/widget",
      arm: "pat",
      token: "ghp_tok",
      envLabel: "/etc/phoebe/.env",
      fetchFn: mockFetch as typeof fetch,
      inContainer: false,
    });
    const labelsResult = row.checks.find((c) => c.id === "labels");
    expect(labelsResult?.state).toBe("unknown");
    expect(labelsResult?.detail).toMatch(/Issues:read/);
  });
});

describe("tenantRow landed-member label (#449)", () => {
  test("a repo without mergedLabel fails labels and prints the create command", async () => {
    const mockFetch = async (url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      if (urlStr.includes("/labels")) {
        return new Response(
          JSON.stringify(
            ["ready-for-agent", "processing", "ready-for-human"].map((name) => ({ name })),
          ),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ id: 1, name: "widget" }), { status: 200 });
    };
    const row = await tenantRow({
      path: "tenant",
      slug: "acme/widget",
      arm: "pat",
      token: "ghp_tok",
      envLabel: "/etc/phoebe/.env",
      fetchFn: mockFetch as typeof fetch,
      inContainer: false,
    });
    const labelsResult = row.checks.find((c) => c.id === "labels");
    expect(labelsResult?.state).toBe("fail");
    expect(labelsResult?.detail).toContain("merged-to-feature");
    expect(labelsResult?.detail).toContain(
      `gh label create "merged-to-feature" --repo acme/widget`,
    );
  });
});

describe("tenantRow applies the PHOEBE_* env overlay to label names", () => {
  test("PHOEBE_MERGED_LABEL overrides the config file's mergedLabel", async () => {
    const dir = mkdtempSync(join(tmpdir(), "phoebe-doctor-env-overlay-"));
    writeFileSync(
      join(dir, "phoebe.config.ts"),
      `export const config = {\n  repoSlug: "acme/widget",\n  mergedLabel: "config-label",\n};\n`,
    );
    const mockFetch = async (url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      if (urlStr.includes("/labels")) {
        return new Response(
          JSON.stringify(
            ["ready-for-agent", "processing", "env-label", "ready-for-human"].map((name) => ({
              name,
            })),
          ),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ id: 1, name: "widget" }), { status: 200 });
    };
    const row = await tenantRow({
      path: "tenant",
      slug: "acme/widget",
      arm: "pat",
      token: "ghp_tok",
      envLabel: "/etc/phoebe/.env",
      fetchFn: mockFetch as typeof fetch,
      inContainer: false,
      configPath: join(dir, "phoebe.config.ts"),
      // The tenant's own env, not the doctor process's: in workspace mode
      // each tenant's `.env` is what its engine child reads.
      env: { PHOEBE_MERGED_LABEL: "env-label" },
    });
    const labelsResult = row.checks.find((c) => c.id === "labels");
    expect(labelsResult?.state).toBe("ok");
    expect(labelsResult?.detail).not.toContain("config-label");
  });

  test("the doctor process's own env does not leak into a tenant row", async () => {
    const dir = mkdtempSync(join(tmpdir(), "phoebe-doctor-env-isolation-"));
    writeFileSync(
      join(dir, "phoebe.config.ts"),
      `export const config = {\n  repoSlug: "acme/widget",\n  mergedLabel: "config-label",\n};\n`,
    );
    const mockFetch = async (url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      if (urlStr.includes("/labels")) {
        return new Response(
          JSON.stringify(
            ["ready-for-agent", "processing", "config-label", "ready-for-human"].map((name) => ({
              name,
            })),
          ),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ id: 1, name: "widget" }), { status: 200 });
    };
    const previous = process.env.PHOEBE_MERGED_LABEL;
    process.env.PHOEBE_MERGED_LABEL = "ambient-label";
    try {
      const row = await tenantRow({
        path: "tenant",
        slug: "acme/widget",
        arm: "pat",
        token: "ghp_tok",
        envLabel: "/etc/phoebe/.env",
        fetchFn: mockFetch as typeof fetch,
        inContainer: false,
        configPath: join(dir, "phoebe.config.ts"),
        env: {},
      });
      const labelsResult = row.checks.find((c) => c.id === "labels");
      expect(labelsResult?.state).toBe("ok");
      expect(labelsResult?.detail).not.toContain("ambient-label");
    } finally {
      if (previous === undefined) delete process.env.PHOEBE_MERGED_LABEL;
      else process.env.PHOEBE_MERGED_LABEL = previous;
    }
  });
});

describe("tenantRow config load failure regression", () => {
  test("config import failure — labels and prompt-drift both unknown", async () => {
    const mockFetch = async () =>
      new Response(JSON.stringify({ id: 1, name: "widget" }), { status: 200 });
    const row = await tenantRow({
      path: "tenant",
      slug: "acme/widget",
      arm: "pat",
      token: "ghp_tok",
      envLabel: "/etc/phoebe/.env",
      fetchFn: mockFetch as typeof fetch,
      inContainer: false,
      // Non-existent path causes loadUserConfig (dynamic import) to throw.
      configPath: `/tmp/phoebe-nonexistent-config-${Date.now()}.ts`,
    });
    const labelsResult = row.checks.find((c) => c.id === "labels");
    const driftResult = row.checks.find((c) => c.id === "prompt-drift");
    expect(labelsResult?.state).toBe("unknown");
    expect(labelsResult?.detail).toMatch(/config load failed/);
    expect(driftResult?.state).toBe("unknown");
    expect(driftResult?.detail).toMatch(/config load failed/);
  });
});

describe("tenantRow prompt-drift source (#419)", () => {
  const okFetch = async () =>
    new Response(JSON.stringify({ id: 1, name: "widget" }), { status: 200 });

  /** A tenant dir holding a config and a vendored issues prompt with no blocker rule. */
  function scaffoldTenant(configBody: string): string {
    const dir = mkdtempSync(join(tmpdir(), "phoebe-doctor-drift-"));
    writeFileSync(join(dir, "vendored-issues.md"), "# Issues\n\nDo the work.\n");
    writeFileSync(
      join(dir, "phoebe.config.ts"),
      `export const config = {\n  repoSlug: "acme/widget",\n${configBody}};\n`,
    );
    return join(dir, "phoebe.config.ts");
  }

  async function driftCheckFor(configBody: string) {
    const row = await tenantRow({
      path: "tenant",
      slug: "acme/widget",
      arm: "pat",
      token: "ghp_tok",
      envLabel: "/etc/phoebe/.env",
      fetchFn: okFetch as typeof fetch,
      inContainer: false,
      configPath: scaffoldTenant(configBody),
    });
    return row.checks.find((c) => c.id === "prompt-drift");
  }

  test("reads the kind block's promptFile", async () => {
    const check = await driftCheckFor(
      `  pipelines: { work: { kinds: { issues: { promptFile: "./vendored-issues.md" } } } },\n`,
    );
    expect(check?.state).toBe("warn");
    expect(check?.detail).toMatch(/vendored-issues\.md/);
    expect(check?.detail).toMatch(/no blocker-recording rule/);
  });

  test("still reads the deprecated promptFiles alias", async () => {
    const check = await driftCheckFor(`  promptFiles: { issue: "./vendored-issues.md" },\n`);
    expect(check?.state).toBe("warn");
    expect(check?.detail).toMatch(/vendored-issues\.md/);
  });

  test("a config declaring neither is on the shipped default", async () => {
    const check = await driftCheckFor("");
    expect(check?.state).toBe("ok");
    expect(check?.detail).toMatch(/shipped default/);
  });
});

describe("declaredEnvCheck", () => {
  test("a scheduled kind's missing key is a tenant finding", () => {
    const check = declaredEnvCheck(
      [{ pipeline: "intake", kind: "slack-intake", key: "SLACK_BOT_TOKEN" }],
      "/etc/phoebe/repos/acme/widget/.env",
    );
    expect(check.state).toBe("fail");
    expect(check.detail).toMatch(/intake\/slack-intake declares SLACK_BOT_TOKEN/);
    expect(check.detail).toMatch(/repos\/acme\/widget\/\.env/);
  });

  test("nothing missing passes", () => {
    expect(declaredEnvCheck([], "/etc/phoebe/.env").state).toBe("ok");
  });

  test("a config that would not load is unknown, not a shortfall", () => {
    expect(declaredEnvCheck(null, "/etc/phoebe/.env").state).toBe("unknown");
  });

  test("the check only appears when the caller ran the scan", async () => {
    const mockFetch = async () =>
      new Response(JSON.stringify({ id: 1, name: "widget" }), { status: 200 });
    const row = await tenantRow({
      path: "tenant",
      slug: "acme/widget",
      arm: "pat",
      token: "ghp_tok",
      envLabel: "/etc/phoebe/.env",
      fetchFn: mockFetch as typeof fetch,
      inContainer: false,
    });
    expect(row.checks.find((check) => check.id === "declared-env")).toBeUndefined();
  });
});

describe("staleStateCheck", () => {
  const dataDir = "/data/repos/acme/widget";

  test("a clean data directory is ok", () => {
    expect(staleStateCheck({ dataDir, items: [] })).toEqual({
      id: "stale-state",
      state: "ok",
      detail: `nothing orphaned under ${dataDir}`,
    });
  });

  test("orphans are a warn, counted by tier, never a fail", () => {
    const check = staleStateCheck({
      dataDir,
      items: [
        { tier: "state", path: `${dataDir}/state/intake`, detail: "no pipeline", reclaim: null },
        { tier: "scratch", path: `${dataDir}/scratch/triage`, detail: "no kind", reclaim: null },
      ],
    });
    expect(check.state).toBe("warn");
    expect(check.detail).toContain("2 orphan(s)");
    expect(check.detail).toContain("state 1, scratch 1");
    expect(check.detail).toContain("2 the next sweep reclaims");
  });

  test("a worktree the sweep refused names its path and how to reclaim it", () => {
    const path = `${dataDir}/worktrees/phoebe-issue-9`;
    const check = staleStateCheck({
      dataDir,
      items: [{ tier: "worktree", path, detail: "not clean", reclaim: "git worktree remove it" }],
    });
    expect(check.state).toBe("warn");
    expect(check.detail).toContain(path);
    expect(check.detail).toContain("git worktree remove it");
    expect(check.detail).toContain("none of it auto-reclaimable");
  });

  test("warn findings leave the report exiting 0", () => {
    const report = buildDoctorReport(
      [],
      [
        {
          path: "tenant",
          slug: "acme/widget",
          checks: [
            staleStateCheck({
              dataDir,
              items: [
                {
                  tier: "state",
                  path: `${dataDir}/state/intake`,
                  detail: "no pipeline",
                  reclaim: null,
                },
              ],
            }),
          ],
        },
      ],
    );
    expect(report.ok).toBe(true);
  });
});

describe("strayMembersCheck", () => {
  const slug = "acme/widget";
  const stray = {
    issueNumber: 20,
    issueTitle: "Landed member",
    labels: ["merged-to-feature"],
    featureIssueNumber: 448,
    featureTitle: "Feature-member lifecycle",
    end: "merged" as const,
    hint: "close #20",
  };

  test("a repo with no strays is ok", () => {
    expect(strayMembersCheck({ slug, strays: [] })).toEqual({
      id: "stray-members",
      state: "ok",
      detail: `no open member of a retired feature is still labelled in ${slug}`,
    });
  });

  test("a stray is a warn naming the member, the feature and the repair", () => {
    const check = strayMembersCheck({ slug, strays: [stray] });
    expect(check.state).toBe("warn");
    expect(check.detail).toContain("1 stray member(s)");
    expect(check.detail).toContain(`#20 "Landed member"`);
    expect(check.detail).toContain(`#448 "Feature-member lifecycle" merged`);
    expect(check.detail).toContain("close #20");
  });

  test("a cancelled feature's stray offers the label strip as well as the close", () => {
    const check = strayMembersCheck({
      slug,
      strays: [
        {
          ...stray,
          labels: ["processing"],
          end: "cancelled",
          hint: `close #20, or strip "processing" to re-route it onto the default branch`,
        },
      ],
    });
    expect(check.detail).toContain("was cancelled");
    expect(check.detail).toContain("re-route it onto the default branch");
  });

  test("strays leave the report exiting 0, and --json carries them", () => {
    const report = buildDoctorReport(
      [],
      [{ path: "tenant", slug, checks: [strayMembersCheck({ slug, strays: [stray] })] }],
    );
    expect(report.ok).toBe(true);
    expect(JSON.parse(JSON.stringify(report))).toMatchObject({
      tenants: [{ checks: [{ id: "stray-members", state: "warn" }] }],
    });
  });
});

describe("tenantRow stray members (#487)", () => {
  /** A tracker with one member of a feature whose integration PR has merged. */
  function trackerFetch(overrides: { parentClosed?: boolean; prState?: string } = {}) {
    return async (url: string | URL | Request) => {
      const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
      if (href.includes("/labels?")) {
        return json(
          ["ready-for-agent", "processing", "merged-to-feature", "ready-for-human"].map((name) => ({
            name,
          })),
        );
      }
      if (href.includes("/issues?")) {
        return json(
          href.includes(encodeURIComponent("merged-to-feature"))
            ? [{ number: 20, title: "Landed member", labels: [{ name: "merged-to-feature" }] }]
            : [],
        );
      }
      if (href.endsWith("/issues/20")) {
        return json({
          number: 20,
          title: "Landed member",
          state: "open",
          body: "",
          labels: [{ name: "merged-to-feature" }],
          parent_issue_url: "https://api.github.com/repos/acme/widget/issues/448",
        });
      }
      if (href.endsWith("/issues/448")) {
        return json({
          number: 448,
          title: "Feature-member lifecycle",
          state: overrides.parentClosed === true ? "closed" : "open",
          body: "",
          labels: [{ name: "phoebe:feature" }],
        });
      }
      if (href.includes("/pulls?")) {
        expect(href).toContain(encodeURIComponent("acme:phoebe/feature-448"));
        const state = overrides.prState ?? "MERGED";
        return json([
          {
            number: 99,
            state: state === "MERGED" ? "closed" : state.toLowerCase(),
            merged_at: state === "MERGED" ? "2026-01-01T00:00:00Z" : null,
          },
        ]);
      }
      return json({ id: 1, name: "widget" });
    };
  }

  const tenant = {
    path: "tenant",
    slug: "acme/widget",
    arm: "pat" as const,
    token: "ghp_tok",
    envLabel: "/etc/phoebe/.env",
    inContainer: false,
  };

  test("a member left labelled by a merged feature is a warn naming both", async () => {
    const row = await tenantRow({ ...tenant, fetchFn: trackerFetch() as typeof fetch });
    const check = row.checks.find((c) => c.id === "stray-members");
    expect(check?.state).toBe("warn");
    expect(check?.detail).toContain(`#20 "Landed member"`);
    expect(check?.detail).toContain(`#448 "Feature-member lifecycle" merged`);
    expect(check?.detail).toContain("close #20");
  });

  test("a cancelled feature's member gets the strip-the-label repair", async () => {
    const row = await tenantRow({
      ...tenant,
      fetchFn: trackerFetch({ prState: "CLOSED" }) as typeof fetch,
    });
    const check = row.checks.find((c) => c.id === "stray-members");
    expect(check?.state).toBe("warn");
    expect(check?.detail).toContain("was cancelled");
    expect(check?.detail).toContain(`strip "merged-to-feature"`);
  });

  test("a member of a live feature is not reported", async () => {
    const row = await tenantRow({
      ...tenant,
      fetchFn: trackerFetch({ prState: "OPEN" }) as typeof fetch,
    });
    expect(row.checks.find((c) => c.id === "stray-members")?.state).toBe("ok");
  });

  test("an issue list the token cannot read is unknown, not a finding", async () => {
    const denied = async (url: string | URL | Request) => {
      const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      if (href.includes("/issues?")) return new Response(null, { status: 403 });
      if (href.includes("/labels?")) return new Response(JSON.stringify([]), { status: 200 });
      return new Response(JSON.stringify({ id: 1, name: "widget" }), { status: 200 });
    };
    const row = await tenantRow({ ...tenant, fetchFn: denied as typeof fetch });
    const check = row.checks.find((c) => c.id === "stray-members");
    expect(check?.state).toBe("unknown");
    expect(check?.detail).toMatch(/Issues:read/);
  });

  test("a label with more open issues than the page cap is unknown, not a short list", async () => {
    const fullPage = Array.from({ length: 100 }, (_, i) => ({
      number: i + 1,
      title: `Issue ${i + 1}`,
      labels: [{ name: "merged-to-feature" }],
    }));
    const capped = async (url: string | URL | Request) => {
      const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
      if (href.includes("/labels?")) {
        return json(
          ["ready-for-agent", "processing", "merged-to-feature", "ready-for-human"].map((name) => ({
            name,
          })),
        );
      }
      if (href.includes("/issues?")) {
        return href.includes(encodeURIComponent("merged-to-feature")) ? json(fullPage) : json([]);
      }
      return json({ id: 1, name: "widget" });
    };
    const row = await tenantRow({ ...tenant, fetchFn: capped as typeof fetch });
    const check = row.checks.find((c) => c.id === "stray-members");
    expect(check?.state).toBe("unknown");
    expect(check?.detail).toMatch(/more than \d+ open issues/);
  });

  test("not probed when the repo check did not pass", async () => {
    const unreachable = async () => new Response(null, { status: 404 });
    const row = await tenantRow({ ...tenant, fetchFn: unreachable as typeof fetch });
    expect(row.checks.find((c) => c.id === "stray-members")).toEqual({
      id: "stray-members",
      state: "unknown",
      detail: "not probed (repo check did not pass)",
    });
  });
});

describe("relayCheck (#540)", () => {
  const url = "wss://relay.example.com/deployments";
  const paired = {
    configured: true,
    state: "connected" as const,
    nextRetryAt: null,
    lastClose: null,
    updatedAt: "2026-09-18T10:00:00.000Z",
  };

  test("a deployment with no relay block is not a deployment with a problem", () => {
    const check = relayCheck({ url: null, keyPresent: false, tokenPresent: false, reported: null });
    expect(check).toMatchObject({ id: "relay", state: "ok" });
    expect(check.detail).toContain("dials nothing");
  });

  test("a url and a token and no key yet is a pairing about to happen", () => {
    const check = relayCheck({ url, keyPresent: false, tokenPresent: true, reported: null });
    expect(check.state).toBe("ok");
    expect(check.detail).toContain("unpaired");
    expect(check.detail).toContain("the next boot pairs");
  });

  test("a url with neither a key nor a token is an operator who stopped halfway", () => {
    const check = relayCheck({ url, keyPresent: false, tokenPresent: false, reported: null });
    expect(check.state).toBe("warn");
    expect(check.detail).toContain("Mint a pairing token");
  });

  test("a paired deployment says so, and says where it stands", () => {
    const check = relayCheck({ url, keyPresent: true, tokenPresent: false, reported: paired });
    expect(check).toMatchObject({ state: "ok" });
    expect(check.detail).toContain("paired with " + url);
    expect(check.detail).toContain("connected");
  });

  test("a token left in the env after pairing is a dead credential worth naming", () => {
    const check = relayCheck({ url, keyPresent: true, tokenPresent: true, reported: paired });
    expect(check.state).toBe("warn");
    expect(check.detail).toContain("token-stale");
    expect(check.detail).toContain("PHOEBE_RELAY_TOKEN");
  });

  test("a refusal fails the check — nothing about it changes on its own", () => {
    const check = relayCheck({
      url,
      keyPresent: true,
      tokenPresent: false,
      reported: {
        ...paired,
        state: "unpaired",
        lastClose: { code: 4001, reason: "unlinked", at: "2026-09-18T11:00:00.000Z" },
      },
    });
    expect(check.state).toBe("fail");
    expect(check.detail).toContain("refused");
    expect(check.detail).toContain("4001");
  });

  test("a link between retries is still paired, not refused", () => {
    const check = relayCheck({
      url,
      keyPresent: true,
      tokenPresent: false,
      reported: {
        ...paired,
        state: "reconnecting",
        nextRetryAt: "2026-09-18T11:00:05.000Z",
        lastClose: { code: 1006, reason: "", at: "2026-09-18T11:00:00.000Z" },
      },
    });
    expect(check.state).toBe("ok");
    expect(check.detail).toContain("reconnecting");
  });

  test("a block that does not parse is reported, not read as no relay at all", () => {
    const check = relayCheck({
      url: null,
      configError: "`relay.url` must be a WebSocket URL",
      keyPresent: false,
      tokenPresent: false,
      reported: null,
    });
    expect(check.state).toBe("warn");
    expect(check.detail).toContain("does not parse");
  });
});

describe("tenantCredential (#507 §5)", () => {
  test("a tenant's own token wins — a PAT-arm tenant is leased nothing", () => {
    expect(
      tenantCredential({ own: "ghp_own", slug: "acme/widget", leases: { "acme/widget": "ghs_l" } }),
    ).toEqual({ token: "ghp_own", leased: false });
  });

  test("an App-arm tenant runs on the lease the supervisor handed over", () => {
    expect(
      tenantCredential({ own: undefined, slug: "acme/widget", leases: { "acme/widget": "ghs_l" } }),
    ).toEqual({ token: "ghs_l", leased: true });
  });

  test("a manual run leases nothing, so there is no token to probe with", () => {
    expect(tenantCredential({ own: undefined, slug: "acme/widget", leases: {} })).toEqual({
      token: undefined,
      leased: false,
    });
  });

  test("a tenant with no slug has nothing to look a lease up by", () => {
    expect(
      tenantCredential({ own: undefined, slug: null, leases: { "acme/widget": "ghs_l" } }),
    ).toEqual({ token: undefined, leased: false });
  });
});

describe("the App arm with a lease (#507 §5)", () => {
  const leased = {
    path: "tenant",
    slug: "acme/widget",
    arm: "app" as const,
    token: "ghs_leased",
    leased: true,
    envLabel: "/etc/phoebe/tenant/.env",
    inContainer: true,
  };

  const reachable = async (url: string | URL | Request) => {
    const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    if (href.includes("/labels?")) {
      return json(
        ["ready-for-agent", "processing", "merged-to-feature", "ready-for-human"].map((name) => ({
          name,
        })),
      );
    }
    if (href.includes("/issues?")) return json([]);
    return json({ id: 1, name: "widget" });
  };

  test("repo and labels are real checks, not `not probed (App arm)`", async () => {
    const row = await tenantRow({ ...leased, fetchFn: reachable as typeof fetch });
    expect(row.checks.find((c) => c.id === "repo")?.state).toBe("ok");
    expect(row.checks.find((c) => c.id === "labels")?.state).toBe("ok");
    expect(row.checks.find((c) => c.id === "stray-members")?.state).toBe("ok");
  });

  test("the token check says the credential was leased to this run", async () => {
    const row = await tenantRow({ ...leased, fetchFn: reachable as typeof fetch });
    expect(row.checks.find((c) => c.id === "token")?.detail).toMatch(/leased to this run/);
  });

  test("without a lease the App arm still defers to the runtime mint", async () => {
    const row = await tenantRow({
      ...leased,
      token: undefined,
      leased: false,
      fetchFn: reachable as typeof fetch,
    });
    expect(row.checks.find((c) => c.id === "repo")).toEqual({
      id: "repo",
      state: "unknown",
      detail: "not probed (App arm — repo access verified at runtime when the token is minted)",
    });
  });
});

describe("the run's deadline (#507 §7)", () => {
  const tenant = {
    path: "tenant",
    slug: "acme/widget",
    arm: "pat" as const,
    token: "ghp_tok",
    envLabel: "/etc/phoebe/.env",
    inContainer: false,
  };

  test("a tenant whose GitHub never answers goes unknown, not pending forever", async () => {
    const hangs = () => new Promise<Response>(() => {});
    const row = await tenantRow({
      ...tenant,
      fetchFn: hangs as unknown as typeof fetch,
      deadline: createDeadline(5),
    });
    const repo = row.checks.find((c) => c.id === "repo");
    expect(repo?.state).toBe("unknown");
    expect(repo?.detail).toBe(DEADLINE_DETAIL);
  });

  test("the checks behind the one that ran out of time are still reported", async () => {
    const hangs = () => new Promise<Response>(() => {});
    const row = await tenantRow({
      ...tenant,
      fetchFn: hangs as unknown as typeof fetch,
      deadline: createDeadline(5),
    });
    // Shape first: a report whose rows lose checks when a tenant is slow is a
    // report a console cannot line up against the last one.
    expect(row.checks.map((check) => check.id)).toEqual([
      "token",
      "repo",
      "labels",
      "stray-members",
    ]);
    expect(row.checks.find((c) => c.id === "token")?.state).toBe("ok");
  });
});
