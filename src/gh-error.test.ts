// Classification of `gh` CLI 403 failures — rate-limit exhaustion vs.
// permission not granted (#201).

import { describe, expect, test } from "vite-plus/test";
import { classifyGhError, describeGhError, isTransientGhError } from "./gh-error.ts";

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

describe("isTransientGhError", () => {
  test("HTTP 5xx status lines are transient", () => {
    expect(isTransientGhError(makeGhError("gh: Bad gateway (HTTP 502)"))).toBe(true);
    expect(isTransientGhError(makeGhError("gh: Service unavailable (HTTP 503)"))).toBe(true);
    expect(isTransientGhError(makeGhError("gh: Gateway timeout (HTTP 504)"))).toBe(true);
    expect(isTransientGhError(makeGhError("gh: Internal server error (HTTP 500)"))).toBe(true);
  });

  test("HTTP 501 (not implemented) is not transient", () => {
    expect(isTransientGhError(makeGhError("gh: Not implemented (HTTP 501)"))).toBe(false);
  });

  test("the GraphQL server-side catch-all is transient", () => {
    expect(
      isTransientGhError(
        makeGhError(
          "GraphQL: Something went wrong while executing your query. This may be the result of a timeout",
        ),
      ),
    ).toBe(true);
  });

  test("network-level failures are transient", () => {
    expect(isTransientGhError(makeGhError("dial tcp 140.82.112.6:443: connection refused"))).toBe(
      true,
    );
    expect(isTransientGhError(makeGhError("read tcp: connection reset by peer"))).toBe(true);
    expect(isTransientGhError(makeGhError("dial tcp: i/o timeout"))).toBe(true);
    expect(isTransientGhError(makeGhError("net/http: TLS handshake timeout"))).toBe(true);
    expect(isTransientGhError(makeGhError('Post "https://api.github.com": unexpected EOF'))).toBe(
      true,
    );
    expect(isTransientGhError(makeGhError("dial tcp: lookup api.github.com: no such host"))).toBe(
      true,
    );
  });

  test("rate-limit and permission failures are not transient", () => {
    expect(
      isTransientGhError(makeGhError("gh: API rate limit exceeded for installation ID 12345.")),
    ).toBe(false);
    expect(
      isTransientGhError(makeGhError("gh: Resource not accessible by integration (HTTP 403)")),
    ).toBe(false);
  });

  test("plain client errors are not transient", () => {
    expect(isTransientGhError(makeGhError("gh: Not Found (HTTP 404)"))).toBe(false);
    expect(isTransientGhError(makeGhError("gh: Validation failed (HTTP 422)"))).toBe(false);
  });

  test("no stderr (inherited stdio or a spawn timeout) is not transient", () => {
    expect(isTransientGhError(new Error("Command failed: gh pr list"))).toBe(false);
    expect(isTransientGhError(Object.assign(new Error("ETIMEDOUT"), { stderr: null }))).toBe(false);
    expect(isTransientGhError(makeGhError(""))).toBe(false);
  });
});
