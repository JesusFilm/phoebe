// Grouping: each strategy, the majors rule, pattern overrides, and the rule
// that a bundle never spans two managers.

import { describe, expect, test } from "vite-plus/test";
import type { Candidate } from "./candidate.ts";
import { groupCandidates, type Bundle } from "./grouping.ts";

function candidate(pkg: string, overrides: Partial<Candidate> = {}): Candidate {
  return {
    manager: "npm",
    package: pkg,
    current: "1.0.0",
    target: "1.1.0",
    updateType: "minor",
    publishedAt: "2026-10-01T00:00:00Z",
    depType: "prod",
    workspace: "package.json",
    advisories: [],
    peers: [],
    ...overrides,
  };
}

/** Each bundle as `manager group: package, package`, for readable assertions. */
function shape(bundles: readonly Bundle[]): string[] {
  return bundles.map(
    (b) => `${b.manager} ${b.group}: ${b.candidates.map((c) => c.package).join(", ")}`,
  );
}

describe("by-relation", () => {
  const fixture = [
    candidate("lodash"),
    candidate("@mui/material"),
    candidate("react-dom", { peers: ["react"] }),
    candidate("@mui/system"),
    candidate("react"),
  ];

  test("a scoped family, a peer pair and an unrelated package make three bundles", () => {
    expect(shape(groupCandidates(fixture, "by-relation"))).toEqual([
      "npm relation:@mui: @mui/material, @mui/system",
      "npm relation:lodash: lodash",
      "npm relation:react: react, react-dom",
    ]);
  });

  test("one source repository relates packages with no scope or peer in common", () => {
    const bundles = groupCandidates(
      [
        candidate("typescript-eslint", {
          repositoryUrl: "git+https://github.com/typescript-eslint/typescript-eslint.git",
        }),
        candidate("@typescript-eslint/parser", {
          repositoryUrl: "https://github.com/typescript-eslint/typescript-eslint",
        }),
        candidate("eslint", { repositoryUrl: "git+https://github.com/eslint/eslint.git" }),
      ],
      "by-relation",
    );
    expect(shape(bundles)).toEqual([
      "npm relation:@typescript-eslint: @typescript-eslint/parser, typescript-eslint",
      "npm relation:eslint: eslint",
    ]);
  });

  test("relations chain: a peer of a scoped package joins the whole family", () => {
    const bundles = groupCandidates(
      [
        candidate("@emotion/react", { peers: ["react"] }),
        candidate("@emotion/styled"),
        candidate("react"),
      ],
      "by-relation",
    );
    expect(shape(bundles)).toEqual([
      "npm relation:@emotion: @emotion/react, @emotion/styled, react",
    ]);
  });

  test("a peer that is not itself a candidate relates nothing", () => {
    const bundles = groupCandidates(
      [candidate("react-dom", { peers: ["react"] }), candidate("lodash")],
      "by-relation",
    );
    expect(shape(bundles)).toEqual([
      "npm relation:lodash: lodash",
      "npm relation:react-dom: react-dom",
    ]);
  });
});

describe("the other strategies", () => {
  const list = [
    candidate("react", { workspace: "apps/web/package.json" }),
    candidate("vitest", { depType: "dev", workspace: "apps/web/package.json" }),
    candidate("express", { workspace: "apps/api/package.json" }),
    candidate("react", { workspace: "apps/api/package.json" }),
  ];

  test("individual gives each package its own bundle, across workspaces", () => {
    expect(shape(groupCandidates(list, "individual"))).toEqual([
      "npm package:express: express",
      "npm package:react: react, react",
      "npm package:vitest: vitest",
    ]);
  });

  test("all puts everything in one bundle", () => {
    expect(shape(groupCandidates(list, "all"))).toEqual(["npm all: express, react, react, vitest"]);
  });

  test("by-dependency-type splits production from development", () => {
    expect(shape(groupCandidates(list, "by-dependency-type"))).toEqual([
      "npm type:dev: vitest",
      "npm type:prod: express, react, react",
    ]);
  });

  test("by-workspace splits on the owning workspace package", () => {
    expect(shape(groupCandidates(list, "by-workspace"))).toEqual([
      "npm workspace:apps/api/package.json: express, react",
      "npm workspace:apps/web/package.json: react, vitest",
    ]);
  });
});

describe("rules over every strategy", () => {
  test("a bundle never spans two managers", () => {
    const bundles = groupCandidates(
      [
        candidate("serde", { manager: "cargo" }),
        candidate("lodash"),
        candidate("tokio", { manager: "cargo" }),
      ],
      "all",
    );
    expect(shape(bundles)).toEqual(["cargo all: serde, tokio", "npm all: lodash"]);
  });

  test("a major gets its own bundle, apart from the same package's minor", () => {
    const bundles = groupCandidates(
      [
        candidate("typescript", { target: "5.9.3" }),
        candidate("typescript", { target: "7.0.2", updateType: "major" }),
        candidate("eslint", { target: "10.0.0", updateType: "major" }),
        candidate("lodash"),
      ],
      "all",
    );
    expect(shape(bundles)).toEqual([
      "npm all: lodash, typescript",
      "npm major:eslint: eslint",
      "npm major:typescript: typescript",
    ]);
  });

  test("majors: follow-strategy groups a major with the rest", () => {
    const bundles = groupCandidates(
      [candidate("eslint", { updateType: "major" }), candidate("lodash")],
      "all",
      { majors: "follow-strategy" },
    );
    expect(shape(bundles)).toEqual(["npm all: eslint, lodash"]);
  });

  test("follow-strategy still splits a major from its own package's minor", () => {
    const bundles = groupCandidates(
      [
        candidate("typescript", { target: "5.9.3" }),
        candidate("typescript", { target: "7.0.2", updateType: "major" }),
        candidate("eslint", { target: "10.0.0", updateType: "major" }),
      ],
      "all",
      { majors: "follow-strategy" },
    );
    expect(shape(bundles)).toEqual([
      "npm all: eslint, typescript",
      "npm major:typescript: typescript",
    ]);
  });

  test("a pattern override takes precedence over the strategy", () => {
    const bundles = groupCandidates(
      [
        candidate("@types/node"),
        candidate("@types/react"),
        candidate("react"),
        candidate("lodash"),
      ],
      "individual",
      { overrides: [{ pattern: "@types/*", group: "types" }] },
    );
    expect(shape(bundles)).toEqual([
      "npm group:types: @types/node, @types/react",
      "npm package:lodash: lodash",
      "npm package:react: react",
    ]);
  });

  test("an override matches the whole name, and the first match wins", () => {
    const bundles = groupCandidates(
      [candidate("eslint"), candidate("eslint-plugin-react"), candidate("my-eslint")],
      "individual",
      {
        overrides: [
          { pattern: "eslint-plugin-*", group: "plugins" },
          { pattern: "eslint*", group: "lint" },
        ],
      },
    );
    expect(shape(bundles)).toEqual([
      "npm group:lint: eslint",
      "npm group:plugins: eslint-plugin-react",
      "npm package:my-eslint: my-eslint",
    ]);
  });

  test("an override group still never spans two managers", () => {
    const bundles = groupCandidates(
      [candidate("node", { manager: "dockerfile" }), candidate("node", { manager: "nvm" })],
      "all",
      { overrides: [{ pattern: "node", group: "runtime" }] },
    );
    expect(shape(bundles)).toEqual(["dockerfile group:runtime: node", "nvm group:runtime: node"]);
  });

  test("a lockfile move rides in its package's bundle", () => {
    const bundles = groupCandidates(
      [
        candidate("serde", { manager: "cargo", updateType: "lockfile", target: "1.0.229" }),
        candidate("serde", {
          manager: "cargo",
          updateType: "minor",
          workspace: "crates/a/Cargo.toml",
        }),
      ],
      "individual",
    );
    expect(shape(bundles)).toEqual(["cargo package:serde: serde, serde"]);
  });

  test("no candidates, no bundles", () => {
    expect(groupCandidates([], "by-relation")).toEqual([]);
  });
});
