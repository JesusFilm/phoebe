// The GitHub half of the setup steps: the prefilled page, and the readings.

import type { ConfigFieldFacts } from "phoebe-agent/contracts";
import { describe, expect, test } from "vite-plus/test";
import {
  grantReading,
  isPlaceholderSlug,
  looksLikeToken,
  slugOf,
  tokenPageUrl,
} from "./github-token.ts";

function field(path: string, over: Partial<ConfigFieldFacts> = {}): ConfigFieldFacts {
  return { path, scope: "tenant", type: "string", state: "unset", ...over };
}

describe("slugOf", () => {
  test("reads a literal repoSlug and nothing else", () => {
    expect(slugOf([field("repoSlug", { state: "set", value: "JesusFilm/phoebe" })])).toBe(
      "JesusFilm/phoebe",
    );
    expect(slugOf([field("repoSlug", { state: "computed", raw: "process.env.X" })])).toBeNull();
    expect(slugOf([field("repoSlug", { state: "set", value: "not a slug" })])).toBeNull();
    expect(slugOf([field("defaultProvider")])).toBeNull();
    expect(slugOf(undefined)).toBeNull();
  });
});

describe("isPlaceholderSlug", () => {
  test("knows the scaffold's slug from a real one", () => {
    expect(isPlaceholderSlug("your-org/your-repo")).toBe(true);
    expect(isPlaceholderSlug("JesusFilm/your-repo")).toBe(true);
    expect(isPlaceholderSlug("JesusFilm/phoebe")).toBe(false);
  });
});

describe("tokenPageUrl", () => {
  test("names the token after the repo, sets the owner, a year, and the five grants", () => {
    const url = new URL(tokenPageUrl("JesusFilm/phoebe"));

    expect(url.origin + url.pathname).toBe(
      "https://github.com/settings/personal-access-tokens/new",
    );
    expect(url.searchParams.get("name")).toBe("Phoebe phoebe");
    expect(url.searchParams.get("target_name")).toBe("JesusFilm");
    expect(url.searchParams.get("expires_in")).toBe("366");
    expect(url.searchParams.get("contents")).toBe("write");
    expect(url.searchParams.get("pull_requests")).toBe("write");
    expect(url.searchParams.get("issues")).toBe("write");
    expect(url.searchParams.get("actions")).toBe("read");
    expect(url.searchParams.get("description")).toContain("JesusFilm/phoebe");
  });

  test("keeps the name within GitHub's forty characters", () => {
    const url = new URL(tokenPageUrl("org/a-repository-with-a-very-long-name-indeed-yes"));
    expect(url.searchParams.get("name")!.length).toBeLessThanOrEqual(40);
  });
});

describe("the readings", () => {
  test("one line per grant, by what the probe could say", () => {
    expect(
      grantReading({
        id: "contents",
        label: "Contents: Read and write",
        why: "Push.",
        state: "granted",
        detail: "HTTP 422",
      }),
    ).toBe("Contents: Read and write: granted");
    expect(
      grantReading({
        id: "issues",
        label: "Issues: Read and write",
        why: "Move labels.",
        state: "missing",
        detail: "HTTP 403",
      }),
    ).toBe("Issues: Read and write: missing (HTTP 403). Move labels.");
    expect(
      grantReading({
        id: "actions",
        label: "Actions: Read-only",
        why: "Checks.",
        state: "unknown",
        detail: "HTTP 403: API rate limit exceeded",
      }),
    ).toBe("Actions: Read-only: could not tell (HTTP 403: API rate limit exceeded)");
  });

  test("a token is one long word", () => {
    expect(looksLikeToken("github_pat_11AAAA_eXaMpLe_eXaMpLe")).toBe(true);
    expect(looksLikeToken("  github_pat_11AAAA_eXaMpLe_eXaMpLe\n")).toBe(true);
    expect(looksLikeToken("github_pat")).toBe(false);
    expect(looksLikeToken("github_pat_11AAAA eXaMpLe_eXaMpLe")).toBe(false);
  });
});
