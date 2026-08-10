// Tests for the pure half of the tenant-token verifier (#154) — the judgement
// calls the driver reports, exercised without a live GitHub token.

import { describe, expect, it } from "vite-plus/test";

import {
  classifyProbe,
  classifyTokenKind,
  diagnose,
  isAmbiguousRefusal,
  redact,
  renderReport,
  reportToJson,
  sweepExitCode,
  describeExpiry,
  parseScopes,
  PERMISSION_PROBES,
  parseArgs,
  scopeCoverage,
} from "./token-probe-lib.mjs";

describe("parseArgs", () => {
  it("defaults to the cwd's tenant with no flags", () => {
    const a = parseArgs([]);
    expect(a.dirs).toEqual([]);
    expect(a.all).toBe(false);
    expect(a.json).toBe(false);
    expect(a.check).toBe(false);
  });

  it("collects tenant directories as positionals, in order", () => {
    expect(parseArgs(["./repos/a", "./repos/b"]).dirs).toEqual(["./repos/a", "./repos/b"]);
  });

  it("takes an explicit slug and token instead of any file", () => {
    const a = parseArgs(["--slug", "JesusFilm/core", "--token", "github_pat_x"]);
    expect(a.slug).toBe("JesusFilm/core");
    expect(a.token).toBe("github_pat_x");
  });

  it("refuses --all alongside a directory, a slug, or a token", () => {
    expect(() => parseArgs(["--all", "./repos/a"])).toThrow(/--all/);
    expect(() => parseArgs(["--all", "--slug", "a/b"])).toThrow(/--all/);
    expect(() => parseArgs(["--all", "--token", "x"])).toThrow(/--all/);
  });

  it("rejects a --slug that is not owner/repo", () => {
    expect(() => parseArgs(["--slug", "core"])).toThrow(/owner\/repo/);
  });

  it("rejects a flag it does not know rather than silently ignoring it", () => {
    expect(() => parseArgs(["--jsonn"])).toThrow(/--jsonn/);
  });

  it("accepts --flag=value, the form the phoebe CLI accepts", () => {
    const a = parseArgs(["--slug=JesusFilm/core", "--token=github_pat_x"]);
    expect(a.slug).toBe("JesusFilm/core");
    expect(a.token).toBe("github_pat_x");
  });

  it("never echoes the value of a mistyped option — it may be the token", () => {
    expect(() => parseArgs(["--tokenn=github_pat_secret"])).toThrow(/--tokenn/);
    expect(() => parseArgs(["--tokenn=github_pat_secret"])).not.toThrow(/secret/);
  });
});

describe("PERMISSION_PROBES", () => {
  const byId = new Map(PERMISSION_PROBES.map((p) => [p.id, p]));

  it("covers exactly the five permissions onboarding §2 asks for", () => {
    expect(PERMISSION_PROBES.map((p) => p.id)).toEqual([
      "metadata",
      "contents",
      "pull_requests",
      "issues",
      "actions",
    ]);
  });

  it("names each permission as the GitHub UI spells it", () => {
    expect(byId.get("contents")!.ui).toBe("Contents: Read and write");
    expect(byId.get("pull_requests")!.ui).toBe("Pull requests: Read and write");
    expect(byId.get("actions")!.ui).toBe("Actions: Read-only");
  });

  it("aims every mutating probe at a resource that cannot exist", () => {
    const writes = PERMISSION_PROBES.filter((p) => p.method !== "GET");
    expect(writes.length).toBeGreaterThan(0);
    for (const probe of writes) {
      const path = probe.path("owner/repo");
      // Either an issue/PR number far above any real one, or a ref creation
      // whose sha is the all-zero (non-existent) object.
      const absentTarget = /\/(issues|pulls)\/9{7,}$/.test(path);
      const bogusSha = probe.body?.sha !== undefined && /^0{40}$/.test(probe.body.sha);
      expect(absentTarget || bogusSha).toBe(true);
    }
  });

  it("reads a permission refusal as missing and an absent resource as granted", () => {
    // Verified against a live token, 2026-08-10: on a repo the token can write,
    // PATCH issues/999999999 → 404, PATCH pulls/999999999 → 404, POST git/refs
    // with an all-zero sha → 422 "Object does not exist" (and no ref created).
    expect(classifyProbe(byId.get("issues")!, 404)).toBe("granted");
    expect(classifyProbe(byId.get("pull_requests")!, 404)).toBe("granted");
    expect(classifyProbe(byId.get("contents")!, 422)).toBe("granted");
    expect(classifyProbe(byId.get("actions")!, 200)).toBe("granted");
    for (const probe of PERMISSION_PROBES) {
      if (probe.id === "metadata") continue;
      expect(classifyProbe(probe, 403)).toBe("missing");
    }
  });

  it("reads an invisible repo, not a refusal, as missing Metadata", () => {
    expect(classifyProbe(byId.get("metadata")!, 200)).toBe("granted");
    expect(classifyProbe(byId.get("metadata")!, 404)).toBe("missing");
  });

  it("downgrades an ambiguous 403 to unknown rather than blaming a checkbox", () => {
    const probe = byId.get("issues")!;
    expect(classifyProbe(probe, 403, { message: "API rate limit exceeded" })).toBe("unknown");
    expect(classifyProbe(probe, 403, { message: "Resource not accessible by integration" })).toBe(
      "missing",
    );
  });

  it("reports an unexpected status as unknown rather than guessing a colour", () => {
    expect(classifyProbe(byId.get("issues")!, 410)).toBe("unknown");
    expect(classifyProbe(byId.get("contents")!, 500)).toBe("unknown");
    expect(classifyProbe(byId.get("metadata")!, 401)).toBe("unknown");
  });
});

describe("classifyTokenKind", () => {
  it("names each prefix GitHub mints", () => {
    expect(classifyTokenKind("github_pat_11ABC").id).toBe("fine-grained");
    expect(classifyTokenKind("ghp_abc").id).toBe("classic");
    expect(classifyTokenKind("ghs_abc").id).toBe("installation");
    expect(classifyTokenKind("gho_abc").id).toBe("oauth");
  });

  it("falls back to unknown rather than assuming fine-grained", () => {
    expect(classifyTokenKind("abcdef").id).toBe("unknown");
  });

  it("notes that Phoebe is built for fine-grained tokens without calling others an error", () => {
    expect(classifyTokenKind("github_pat_x").note).toBeNull();
    expect(classifyTokenKind("ghp_x").note).toMatch(/fine-grained/);
  });
});

describe("parseScopes", () => {
  it("splits the classic-token header GitHub returns", () => {
    expect(parseScopes("gist, read:org, repo, workflow")).toEqual([
      "gist",
      "read:org",
      "repo",
      "workflow",
    ]);
  });

  it("treats an absent or empty header as no scopes at all, distinctly from none granted", () => {
    expect(parseScopes(null)).toBeNull();
    expect(parseScopes("")).toEqual([]);
  });
});

describe("scopeCoverage", () => {
  it("reads `repo` as covering all five repository permissions", () => {
    const cover = scopeCoverage(["repo"]);
    for (const probe of PERMISSION_PROBES) {
      expect(cover[probe.id]).toBe("granted");
    }
  });

  it("reports public_repo as unknown — it covers public repos only", () => {
    expect(scopeCoverage(["public_repo"])["contents"]).toBe("unknown");
  });

  it("reports a scope set with neither as missing", () => {
    expect(scopeCoverage(["gist", "read:org"])["issues"]).toBe("missing");
  });
});

describe("describeExpiry", () => {
  const now = Date.parse("2026-08-10T12:00:00Z");

  it("reads GitHub's `YYYY-MM-DD HH:MM:SS UTC` header", () => {
    const e = describeExpiry("2026-09-30 09:00:00 UTC", now)!;
    expect(e.iso).toBe("2026-09-30T09:00:00.000Z");
    expect(e.expired).toBe(false);
    expect(e.warn).toBe(false);
  });

  it("warns inside 14 days", () => {
    expect(describeExpiry("2026-08-20 12:00:00 UTC", now)!.daysLeft).toBe(10);
    expect(describeExpiry("2026-08-20 12:00:00 UTC", now)!.warn).toBe(true);
    expect(describeExpiry("2026-08-25 12:00:00 UTC", now)!.warn).toBe(false);
  });

  it("flags a token that has already lapsed", () => {
    const e = describeExpiry("2026-08-01 12:00:00 UTC", now)!;
    expect(e.expired).toBe(true);
    expect(e.warn).toBe(true);
  });

  it("returns null for an absent header — a non-expiring token is not a finding", () => {
    expect(describeExpiry(null, now)).toBeNull();
    expect(describeExpiry("not a date", now)).toBeNull();
  });
});

describe("diagnose", () => {
  const grants = (states: Record<string, "granted" | "missing" | "unknown">) =>
    PERMISSION_PROBES.map((probe) => ({ ...probe, state: states[probe.id] ?? "granted" }));

  it("passes a token that holds every grant", () => {
    const d = diagnose({ grants: grants({}), metadataStatus: 200 });
    expect(d.verdict).toBe("ok");
    expect(d.ok).toBe(true);
    expect(d.missing).toEqual([]);
  });

  it("blames org approval when the repo is invisible, not a single checkbox", () => {
    const d = diagnose({ grants: grants({ metadata: "missing" }), metadataStatus: 404 });
    expect(d.verdict).toBe("no-access");
    expect(d.ok).toBe(false);
    expect(d.advice.join(" ")).toMatch(/org owner|organization approval/i);
    expect(d.advice.join(" ")).toMatch(/Repository access/);
  });

  it("names a missing grant in the GitHub UI's own words, not the API path", () => {
    const d = diagnose({
      grants: grants({ pull_requests: "missing", actions: "missing" }),
      metadataStatus: 200,
    });
    expect(d.verdict).toBe("missing-grants");
    expect(d.missing).toEqual(["Pull requests: Read and write", "Actions: Read-only"]);
    expect(d.advice.join(" ")).not.toMatch(/\/repos\//);
  });

  it("calls out a repo selected with no permissions ticked at all", () => {
    const d = diagnose({
      grants: grants({
        contents: "missing",
        pull_requests: "missing",
        issues: "missing",
        actions: "missing",
      }),
      metadataStatus: 200,
    });
    expect(d.verdict).toBe("missing-grants");
    expect(d.advice.join(" ")).toMatch(/Repository permissions/);
  });

  it("does not list the unprobed grants when the repo was invisible anyway", () => {
    const d = diagnose({
      grants: grants({
        metadata: "missing",
        contents: "unknown",
        pull_requests: "unknown",
        issues: "unknown",
        actions: "unknown",
      }),
      metadataStatus: 404,
    });
    expect(d.verdict).toBe("no-access");
    expect(d.advice.join(" ")).not.toMatch(/Could not judge/);
  });

  it("reports a rejected credential as its own verdict, not as five missing grants", () => {
    const d = diagnose({ grants: grants({ metadata: "unknown" }), metadataStatus: 401 });
    expect(d.verdict).toBe("invalid-credential");
    expect(d.ok).toBe(false);
  });

  it("does not certify a token whose grants it could not prove", () => {
    const d = diagnose({ grants: grants({ actions: "unknown" }), metadataStatus: 200 });
    expect(d.verdict).toBe("unknown");
    expect(d.unknown).toEqual(["Actions: Read-only"]);
    // A wrong green is worse than a blank: an unproven grant must not certify.
    expect(d.ok).toBe(false);
  });

  it("fails an expired token even though its expiry is only a header", () => {
    const d = diagnose({
      grants: grants({}),
      metadataStatus: 200,
      expiry: {
        raw: "2026-08-07 00:00:00 UTC",
        iso: "2026-08-07T00:00:00.000Z",
        daysLeft: -3,
        expired: true,
        warn: true,
      },
    });
    expect(d.ok).toBe(false);
    expect(d.advice.join(" ")).toMatch(/expired/i);
  });

  it("warns but passes a token expiring soon", () => {
    const d = diagnose({
      grants: grants({}),
      metadataStatus: 200,
      expiry: {
        raw: "2026-08-15 00:00:00 UTC",
        iso: "2026-08-15T00:00:00.000Z",
        daysLeft: 5,
        expired: false,
        warn: true,
      },
    });
    expect(d.ok).toBe(true);
    expect(d.advice.join(" ")).toMatch(/5 day/);
  });
});

describe("reporting", () => {
  const report = {
    target: "./repos/JesusFilm/core",
    slug: "JesusFilm/core",
    tokenSource: ".env at /etc/phoebe/repos/JesusFilm/core/.env",
    tokenKind: { id: "fine-grained", label: "fine-grained personal access token", note: null },
    scopes: null,
    expiry: null,
    grants: PERMISSION_PROBES.map((probe) => ({
      id: probe.id,
      ui: probe.ui,
      state: probe.id === "actions" ? "missing" : "granted",
      status: probe.id === "actions" ? 403 : 200,
    })),
    verdict: "missing-grants",
    ok: false,
    missing: ["Actions: Read-only"],
    unknown: [],
    advice: ["Tick these under **Repository permissions**"],
    error: null,
  };

  it("renders the tenant, its slug, and every permission's state", () => {
    const text = renderReport(report);
    expect(text).toContain("./repos/JesusFilm/core");
    expect(text).toContain("JesusFilm/core");
    for (const probe of PERMISSION_PROBES) expect(text).toContain(probe.ui);
    expect(text).toMatch(/✗.*Actions: Read-only/);
  });

  it("renders a resolution failure as a section, so a sweep keeps going", () => {
    const text = renderReport({ ...report, error: "no GH_TOKEN in .env" });
    expect(text).toContain("no GH_TOKEN in .env");
  });

  it("never puts the token in the JSON payload", () => {
    const json = JSON.stringify(reportToJson({ ...report, token: "github_pat_secret" }));
    expect(json).not.toContain("github_pat_secret");
    expect(JSON.parse(json).slug).toBe("JesusFilm/core");
    expect(JSON.parse(json).grants).toHaveLength(PERMISSION_PROBES.length);
  });

  it("scrubs a token that leaked into an error string", () => {
    expect(redact("connect ECONNREFUSED for github_pat_secret", "github_pat_secret")).toBe(
      "connect ECONNREFUSED for [redacted]",
    );
    expect(redact("nothing to scrub", undefined)).toBe("nothing to scrub");
  });
});

describe("sweepExitCode", () => {
  const ok = { ok: true, error: null };
  const bad = { ok: false, error: null };
  const broken = { ok: true, error: "no GH_TOKEN" };

  it("stays 0 without --check, however bad the findings", () => {
    expect(sweepExitCode([ok, bad, broken], false)).toBe(0);
  });

  it("exits 1 under --check when any tenant is missing a grant", () => {
    expect(sweepExitCode([ok, bad], true)).toBe(1);
    expect(sweepExitCode([ok, ok], true)).toBe(0);
  });

  it("exits 1 under --check when a tenant could not be resolved at all", () => {
    expect(sweepExitCode([ok, broken], true)).toBe(1);
  });
});

describe("isAmbiguousRefusal", () => {
  it("reads a plain permission refusal as unambiguous", () => {
    expect(
      isAmbiguousRefusal({ message: "Resource not accessible by personal access token" }),
    ).toBe(false);
  });

  it("refuses to read a rate-limited 403 as a missing permission", () => {
    expect(isAmbiguousRefusal({ message: "API rate limit exceeded for user ID 1." })).toBe(true);
    expect(isAmbiguousRefusal({ message: "denied", rateLimitRemaining: "0" })).toBe(true);
  });

  it("refuses to read a SAML/SSO refusal as a missing permission", () => {
    expect(isAmbiguousRefusal({ message: "denied", ssoHeader: "required; url=..." })).toBe(true);
    expect(
      isAmbiguousRefusal({ message: "Resource protected by organization SAML enforcement." }),
    ).toBe(true);
  });

  it("refuses to read a suspended or blocked account as a missing permission", () => {
    expect(isAmbiguousRefusal({ message: "Your account has been suspended." })).toBe(true);
  });
});
