import { describe, expect, test } from "vite-plus/test";
import { coAuthorTrailer, resolveIssueCoAuthorTrailer } from "./co-author.ts";

describe("coAuthorTrailer", () => {
  test("formats the GitHub noreply address that links the trailer to an account", () => {
    expect(coAuthorTrailer({ login: "octocat", id: 583231 })).toBe(
      "Co-authored-by: octocat <583231+octocat@users.noreply.github.com>",
    );
  });
});

describe("resolveIssueCoAuthorTrailer", () => {
  const user = { login: "octocat", id: 583231, type: "User" };

  test("credits the issue author when the lookup succeeds", () => {
    const seen: string[] = [];
    const trailer = resolveIssueCoAuthorTrailer(42, {
      issueAuthorLogin: (n) => {
        seen.push(`issue:${n}`);
        return "octocat";
      },
      lookupUser: (login) => {
        seen.push(`user:${login}`);
        return user;
      },
    });
    expect(trailer).toBe("Co-authored-by: octocat <583231+octocat@users.noreply.github.com>");
    expect(seen).toEqual(["issue:42", "user:octocat"]);
  });

  test("returns null when the issue has no author (deleted account)", () => {
    const trailer = resolveIssueCoAuthorTrailer(42, {
      issueAuthorLogin: () => null,
      lookupUser: () => {
        throw new Error("must not be called");
      },
    });
    expect(trailer).toBeNull();
  });

  test("skips bot authors without looking them up", () => {
    let looked = false;
    const trailer = resolveIssueCoAuthorTrailer(42, {
      issueAuthorLogin: () => "dependabot[bot]",
      lookupUser: () => {
        looked = true;
        return { login: "dependabot[bot]", id: 1, type: "Bot" };
      },
    });
    expect(trailer).toBeNull();
    expect(looked).toBe(false);
  });

  test("skips non-User accounts reported by the users endpoint", () => {
    const trailer = resolveIssueCoAuthorTrailer(42, {
      issueAuthorLogin: () => "some-app",
      lookupUser: () => ({ login: "some-app", id: 7, type: "Bot" }),
    });
    expect(trailer).toBeNull();
  });

  test("returns null when the user lookup fails or comes back empty", () => {
    expect(
      resolveIssueCoAuthorTrailer(42, {
        issueAuthorLogin: () => "octocat",
        lookupUser: () => null,
      }),
    ).toBeNull();
    expect(
      resolveIssueCoAuthorTrailer(42, {
        issueAuthorLogin: () => "octocat",
        lookupUser: () => {
          throw new Error("HTTP 404");
        },
      }),
    ).toBeNull();
    expect(
      resolveIssueCoAuthorTrailer(42, {
        issueAuthorLogin: () => {
          throw new Error("gh exploded");
        },
        lookupUser: () => user,
      }),
    ).toBeNull();
  });

  test("uses the canonical login casing from the users endpoint", () => {
    const trailer = resolveIssueCoAuthorTrailer(42, {
      issueAuthorLogin: () => "OctoCat",
      lookupUser: () => user,
    });
    expect(trailer).toBe("Co-authored-by: octocat <583231+octocat@users.noreply.github.com>");
  });
});
