// `phoebe doctor` verdict folding: which check states fail the report, and how
// the crash-loop record reads as a check — especially the quarantine case, the
// "silently running last-known-good" state doctor exists to surface.
// Also covers arm-aware token checks: the App arm and the PAT arm behave
// differently, and the unverifiable state must never fail --check.

import { describe, expect, test } from "vite-plus/test";
import {
  buildDoctorReport,
  crashLoopCheck,
  describeRepoProbe,
  fetchRepoLabels,
  formatDoctorReport,
  labelsCheck,
  launcherFloorCheck,
  promptDriftCheck,
  tenantRow,
  tenantTokenCheck,
} from "./doctor.ts";

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
  test("all labels present — ok, names the repo", () => {
    const check = labelsCheck({
      missing: [],
      present: ["ready-for-agent", "processing", "ready-for-human"],
      slug: "acme/widget",
    });
    expect(check.state).toBe("ok");
    expect(check.detail).toMatch(/acme\/widget/);
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
