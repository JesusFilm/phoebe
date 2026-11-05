// The union of sources: one candidate per occurrence, where an occurrence is
// manager, package, current, target, dependency type and workspace together.

import { describe, expect, test } from "vite-plus/test";
import { repositoryWebUrl, unionCandidates, type Candidate } from "./candidate.ts";

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    manager: "npm",
    package: "typescript",
    current: "5.4.5",
    target: "5.9.3",
    updateType: "minor",
    depType: "dev",
    workspace: "package.json",
    advisories: [],
    peers: [],
    ...overrides,
  };
}

describe("unionCandidates", () => {
  test("the same occurrence from two sources merges into one", () => {
    const renovate = candidate({ publishedAt: "2025-09-30T21:19:38.784Z" });
    const native = candidate({ repositoryUrl: "https://github.com/microsoft/TypeScript" });
    expect(unionCandidates([[renovate], [native]])).toEqual([
      candidate({
        publishedAt: "2025-09-30T21:19:38.784Z",
        repositoryUrl: "https://github.com/microsoft/TypeScript",
      }),
    ]);
  });

  test("a minor and a major for one package stay two candidates", () => {
    const minor = candidate();
    const major = candidate({ target: "7.0.2", updateType: "major" });
    expect(unionCandidates([[minor, major], [minor]])).toEqual([minor, major]);
  });

  test("the same package wanted by two workspace packages stays two candidates", () => {
    const web = candidate({ workspace: "apps/web/package.json" });
    const api = candidate({ workspace: "apps/api/package.json" });
    expect(unionCandidates([[web], [api]])).toEqual([web, api]);
  });

  test("a different current version or dependency type is a different occurrence", () => {
    const list = [
      candidate(),
      candidate({ current: "5.5.0" }),
      candidate({ depType: "prod" }),
      candidate({ manager: "bun" }),
    ];
    expect(unionCandidates([list])).toHaveLength(4);
  });

  test("advisories union by id and peers union by name", () => {
    const osv = candidate({
      advisories: [{ id: "GHSA-b", severity: "high", fixedIn: "5.9.3" }],
      peers: ["react"],
    });
    const audit = candidate({
      advisories: [
        { id: "GHSA-a", severity: "low", fixedIn: null },
        { id: "GHSA-b", severity: "critical", fixedIn: "5.9.3" },
      ],
      peers: ["react-dom", "react"],
    });
    const [merged] = unionCandidates([[osv], [audit]]);
    expect(merged!.advisories).toEqual([
      { id: "GHSA-a", severity: "low", fixedIn: null },
      { id: "GHSA-b", severity: "high", fixedIn: "5.9.3" },
    ]);
    expect(merged!.peers).toEqual(["react", "react-dom"]);
  });

  test("the earlier source wins a conflicting publish date", () => {
    const [merged] = unionCandidates([
      [candidate({ publishedAt: "2025-09-30T00:00:00Z" })],
      [candidate({ publishedAt: "2025-10-01T00:00:00Z" })],
    ]);
    expect(merged!.publishedAt).toBe("2025-09-30T00:00:00Z");
  });

  test("no sources, no candidates", () => {
    expect(unionCandidates([])).toEqual([]);
  });
});

describe("repositoryWebUrl", () => {
  test.each([
    ["git+https://github.com/facebook/react.git", "https://github.com/facebook/react"],
    ["https://github.com/facebook/react", "https://github.com/facebook/react"],
    ["git@github.com:facebook/react.git", "https://github.com/facebook/react"],
    ["ssh://git@gitlab.com/group/project.git", "https://gitlab.com/group/project"],
    ["git://github.com/facebook/react.git/", "https://github.com/facebook/react"],
  ])("%s reads as %s", (url, web) => {
    expect(repositoryWebUrl(url)).toBe(web);
  });

  test("shorthand it cannot place is null", () => {
    expect(repositoryWebUrl("facebook/react")).toBeNull();
  });
});
