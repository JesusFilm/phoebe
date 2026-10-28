// The five probes, read into a verdict the window can draw.

import { describe, expect, test } from "vite-plus/test";
import { repoSlugArg, verifyGithubToken } from "./github-token.ts";

type Answer = { status: number; body?: unknown; headers?: Record<string, string> };

/** A GitHub that answers each path with what the test says, and records what it was asked. */
function github(answers: Record<string, Answer>) {
  const asked: { method: string; url: string; body: string | null; auth: string | null }[] = [];
  const fetchFn: typeof fetch = (input, init) => {
    const url = input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
    const headers = new Headers(init?.headers);
    asked.push({
      method: init?.method ?? "GET",
      url,
      body: typeof init?.body === "string" ? init.body : null,
      auth: headers.get("authorization"),
    });
    const path = url.replace("https://api.github.com", "");
    const answer = Object.entries(answers).find(([prefix]) => path.startsWith(prefix))?.[1];
    if (answer === undefined) return Promise.reject(new Error(`ENOTFOUND ${url}`));
    return Promise.resolve(
      new Response(JSON.stringify(answer.body ?? {}), {
        status: answer.status,
        headers: { "content-type": "application/json", ...answer.headers },
      }),
    );
  };
  return { fetchFn, asked };
}

const SLUG = "JesusFilm/phoebe";
const TOKEN = "github_pat_11AAAA_example";

describe("verifyGithubToken", () => {
  test("a token with every grant is ok, and no probe writes anything real", async () => {
    const { fetchFn, asked } = github({
      "/repos/JesusFilm/phoebe/git/refs": {
        status: 422,
        body: { message: "Object does not exist" },
      },
      "/repos/JesusFilm/phoebe/pulls/999999999": { status: 404 },
      "/repos/JesusFilm/phoebe/issues/999999999": { status: 404 },
      "/repos/JesusFilm/phoebe/actions/runs": { status: 200 },
      "/repos/JesusFilm/phoebe": { status: 200 },
    });

    const verdict = await verifyGithubToken(SLUG, TOKEN, { fetchFn });

    expect(verdict.ok).toBe(true);
    expect(verdict.slug).toBe(SLUG);
    expect(verdict.kind).toEqual({
      id: "fine-grained",
      label: "fine-grained personal access token",
      note: null,
    });
    expect(verdict.grants.map((grant) => [grant.id, grant.state, grant.detail])).toEqual([
      ["metadata", "granted", "HTTP 200"],
      ["contents", "granted", "HTTP 422"],
      ["pull_requests", "granted", "HTTP 404"],
      ["issues", "granted", "HTTP 404"],
      ["actions", "granted", "HTTP 200"],
    ]);
    expect(verdict.grants[1]!.label).toBe("Contents: Read and write");

    // The write probes aim at nothing: an all-zero sha and an issue that is not there.
    const refs = asked.find((call) => call.url.endsWith("/git/refs"))!;
    expect(refs.method).toBe("POST");
    expect(refs.body).toContain("0000000000000000000000000000000000000000");
    expect(asked.every((call) => call.auth === `Bearer ${TOKEN}`)).toBe(true);
  });

  test("a 403 on a probe is that grant missing, and the verdict is not ok", async () => {
    const { fetchFn } = github({
      "/repos/JesusFilm/phoebe/git/refs": { status: 422 },
      "/repos/JesusFilm/phoebe/pulls/999999999": { status: 404 },
      "/repos/JesusFilm/phoebe/issues/999999999": {
        status: 403,
        body: { message: "Resource not accessible by personal access token" },
      },
      "/repos/JesusFilm/phoebe/actions/runs": { status: 403 },
      "/repos/JesusFilm/phoebe": { status: 200 },
    });

    const verdict = await verifyGithubToken(SLUG, TOKEN, { fetchFn });

    expect(verdict.ok).toBe(false);
    expect(verdict.grants.find((grant) => grant.id === "issues")).toMatchObject({
      state: "missing",
      detail: "HTTP 403",
    });
    expect(verdict.grants.find((grant) => grant.id === "actions")!.state).toBe("missing");
  });

  test("a 403 that is about rate limits or SSO is unknown, with the message", async () => {
    const { fetchFn } = github({
      "/repos/JesusFilm/phoebe/git/refs": {
        status: 403,
        body: { message: "API rate limit exceeded" },
        headers: { "x-ratelimit-remaining": "0" },
      },
      "/repos/JesusFilm/phoebe/pulls/999999999": {
        status: 403,
        headers: { "x-github-sso": "required" },
      },
      "/repos/JesusFilm/phoebe/issues/999999999": { status: 404 },
      "/repos/JesusFilm/phoebe/actions/runs": { status: 200 },
      "/repos/JesusFilm/phoebe": { status: 200 },
    });

    const verdict = await verifyGithubToken(SLUG, TOKEN, { fetchFn });

    expect(verdict.grants.find((grant) => grant.id === "contents")).toMatchObject({
      state: "unknown",
      detail: "HTTP 403: API rate limit exceeded",
    });
    expect(verdict.grants.find((grant) => grant.id === "pull_requests")!.state).toBe("unknown");
  });

  test("a repo the token cannot see is metadata missing, and a classic token carries a note", async () => {
    const { fetchFn } = github({
      "/repos/JesusFilm/phoebe/git/refs": { status: 404 },
      "/repos/JesusFilm/phoebe/pulls/999999999": { status: 404 },
      "/repos/JesusFilm/phoebe/issues/999999999": { status: 404 },
      "/repos/JesusFilm/phoebe/actions/runs": { status: 404 },
      "/repos/JesusFilm/phoebe": { status: 404 },
    });

    const verdict = await verifyGithubToken(SLUG, "ghp_example", { fetchFn });

    expect(verdict.grants[0]).toMatchObject({ id: "metadata", state: "missing" });
    expect(verdict.kind.id).toBe("classic");
    expect(verdict.kind.note).not.toBeNull();
  });

  test("a network failure is unknown with the reason, never a verdict on the token", async () => {
    const { fetchFn } = github({});

    const verdict = await verifyGithubToken(SLUG, TOKEN, { fetchFn });

    expect(verdict.ok).toBe(false);
    expect(verdict.grants.every((grant) => grant.state === "unknown")).toBe(true);
    expect(verdict.grants[0]!.detail).toContain("ENOTFOUND");
  });
});

describe("repoSlugArg", () => {
  test("passes a plain owner/repo and refuses anything that would move the probe", () => {
    expect(repoSlugArg("JesusFilm/phoebe")).toBe("JesusFilm/phoebe");
    expect(repoSlugArg("some_org/my.repo-2")).toBe("some_org/my.repo-2");
    for (const bad of [
      "owner/repo?x=1",
      "owner/repo#frag",
      "owner/..",
      "../repo",
      "owner/repo/extra",
      "owner",
      "",
      42,
      undefined,
    ]) {
      expect(() => repoSlugArg(bad), String(bad)).toThrow("owner/repo slug");
    }
  });
});
