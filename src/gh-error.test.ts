// Classification of `gh` CLI 403 failures — rate-limit exhaustion vs.
// permission not granted (#201).

import { describe, expect, test } from "vite-plus/test";
import { classifyGhError, describeGhError } from "./gh-error.ts";

// Build a mock error object that resembles the SpawnSyncError thrown by
// execFileSync when the child exits non-zero with encoding:"utf8" set.
function makeGhError(stderr: string): unknown {
  return Object.assign(new Error("Command failed: gh issue list"), { stderr });
}

describe("classifyGhError", () => {
  describe("no usable signal → null", () => {
    test("error has no stderr property", () => {
      expect(classifyGhError(new Error("Command failed"))).toBeNull();
    });

    test("stderr is empty string", () => {
      expect(classifyGhError(makeGhError(""))).toBeNull();
    });

    test("stderr is null (inherited stdio)", () => {
      expect(classifyGhError(Object.assign(new Error(""), { stderr: null }))).toBeNull();
    });

    test("stderr matches neither rate-limit nor permission pattern", () => {
      expect(classifyGhError(makeGhError("Not Found"))).toBeNull();
      expect(classifyGhError(makeGhError("context deadline exceeded"))).toBeNull();
    });
  });

  describe("rate-limit detection", () => {
    test("detects the REST rate-limit message", () => {
      const c = classifyGhError(
        makeGhError("gh: API rate limit exceeded for installation ID 12345."),
      );
      expect(c?.kind).toBe("rate-limit");
    });

    test("detects the GraphQL rate-limit message", () => {
      const c = classifyGhError(
        makeGhError(
          "GraphQL: API rate limit exceeded for installation ID 12345. (requestLimitations)",
        ),
      );
      expect(c?.kind).toBe("rate-limit");
    });

    test("detection is case-insensitive", () => {
      expect(classifyGhError(makeGhError("RATE LIMIT EXCEEDED"))?.kind).toBe("rate-limit");
      expect(classifyGhError(makeGhError("Rate_Limit exceeded"))?.kind).toBe("rate-limit");
    });
  });

  describe("permission detection", () => {
    test("detects an App-token permission error", () => {
      const c = classifyGhError(makeGhError("gh: Resource not accessible by integration"));
      expect(c?.kind).toBe("permission");
    });

    test("detects a PAT permission error", () => {
      const c = classifyGhError(
        makeGhError("gh: Resource not accessible by personal access token"),
      );
      expect(c?.kind).toBe("permission");
    });
  });

  describe("resource inference from args", () => {
    const rateLimitStderr = "gh: API rate limit exceeded.";

    test("gh api graphql → graphql", () => {
      const c = classifyGhError(makeGhError(rateLimitStderr), [
        "api",
        "graphql",
        "-f",
        "query=...",
      ]);
      expect(c?.kind).toBe("rate-limit");
      if (c?.kind === "rate-limit") expect(c.resource).toBe("graphql");
    });

    test("gh api <rest-endpoint> → core", () => {
      const c = classifyGhError(makeGhError(rateLimitStderr), ["api", "rate_limit"]);
      expect(c?.kind).toBe("rate-limit");
      if (c?.kind === "rate-limit") expect(c.resource).toBe("core");
    });

    test("gh run list → core (REST Actions API)", () => {
      const c = classifyGhError(makeGhError(rateLimitStderr), [
        "run",
        "list",
        "--json",
        "workflowName",
      ]);
      expect(c?.kind).toBe("rate-limit");
      if (c?.kind === "rate-limit") expect(c.resource).toBe("core");
    });

    test("gh issue list → graphql (gh uses GraphQL under the hood)", () => {
      const c = classifyGhError(makeGhError(rateLimitStderr), [
        "issue",
        "list",
        "--json",
        "number",
      ]);
      expect(c?.kind).toBe("rate-limit");
      if (c?.kind === "rate-limit") expect(c.resource).toBe("graphql");
    });

    test("gh pr list → graphql", () => {
      const c = classifyGhError(makeGhError(rateLimitStderr), ["pr", "list", "--json", "number"]);
      expect(c?.kind).toBe("rate-limit");
      if (c?.kind === "rate-limit") expect(c.resource).toBe("graphql");
    });

    test("gh pr view → graphql", () => {
      const c = classifyGhError(makeGhError(rateLimitStderr), ["pr", "view", "42", "--json"]);
      expect(c?.kind).toBe("rate-limit");
      if (c?.kind === "rate-limit") expect(c.resource).toBe("graphql");
    });

    test("unknown subcommand falls back to text scan", () => {
      const graphqlStderr = "gh: API rate limit exceeded. (GraphQL resource)";
      const c = classifyGhError(makeGhError(graphqlStderr), ["unknown-sub"]);
      expect(c?.kind).toBe("rate-limit");
      if (c?.kind === "rate-limit") expect(c.resource).toBe("graphql");
    });

    test("unknown subcommand with no graphql mention → null resource", () => {
      const c = classifyGhError(makeGhError(rateLimitStderr), ["unknown-sub"]);
      expect(c?.kind).toBe("rate-limit");
      if (c?.kind === "rate-limit") expect(c.resource).toBeNull();
    });

    test("empty args → null resource", () => {
      const c = classifyGhError(makeGhError(rateLimitStderr), []);
      if (c?.kind === "rate-limit") expect(c.resource).toBeNull();
    });
  });

  describe("reset time parsing", () => {
    test("parses a 10-digit epoch from the error text", () => {
      const epoch = 1767830400; // 2026-01-07T12:00:00Z
      const c = classifyGhError(makeGhError(`gh: API rate limit exceeded. reset=${epoch}`));
      expect(c?.kind).toBe("rate-limit");
      if (c?.kind === "rate-limit") {
        expect(c.resetAt).toBeInstanceOf(Date);
        expect(c.resetAt?.getTime()).toBe(epoch * 1000);
      }
    });

    test("returns null resetAt when no epoch is present", () => {
      const c = classifyGhError(makeGhError("gh: API rate limit exceeded."));
      if (c?.kind === "rate-limit") expect(c.resetAt).toBeNull();
    });

    test("ignores 9-digit and 11-digit numbers (not epoch-shaped)", () => {
      const c = classifyGhError(makeGhError("gh: API rate limit exceeded. id=123456789"));
      if (c?.kind === "rate-limit") expect(c.resetAt).toBeNull();
    });
  });
});

describe("describeGhError", () => {
  test("rate-limit without resource or reset", () => {
    expect(describeGhError({ kind: "rate-limit", resource: null, resetAt: null })).toBe(
      "GitHub rate limit exhausted",
    );
  });

  test("rate-limit with graphql resource, no reset", () => {
    expect(describeGhError({ kind: "rate-limit", resource: "graphql", resetAt: null })).toBe(
      "GitHub rate limit exhausted (graphql)",
    );
  });

  test("rate-limit with core resource and reset time", () => {
    const resetAt = new Date("2026-08-18T15:00:00.000Z");
    expect(describeGhError({ kind: "rate-limit", resource: "core", resetAt })).toBe(
      "GitHub rate limit exhausted (core) — resets at 2026-08-18T15:00:00.000Z",
    );
  });

  test("permission error", () => {
    expect(describeGhError({ kind: "permission" })).toBe(
      "GitHub 403: permission not granted — check the token's repository access and scope",
    );
  });
});
