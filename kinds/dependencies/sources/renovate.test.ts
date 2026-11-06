// The Renovate source: the report recorded from the pinned version parses
// into candidates, and every way a run can go wrong comes back as a failed
// source rather than a throw. The runner tests stand a shell script in for
// `renovate`, so the spawn, the environment and the deadline are the real ones.

import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import type { Candidate } from "../candidate.ts";
import {
  describeCoverage,
  parseRenovateReport,
  RENOVATE_CONFIG_FILE,
  RENOVATE_GLOBAL_CONFIG,
  RENOVATE_REPORT_FILE,
  runRenovateSource,
  type RenovateSourceCtx,
} from "./renovate.ts";

const repoRoot = join(import.meta.dirname, "..", "..", "..");

/** The `ARG RENOVATE_VERSION` pin in the shipped container template. */
function pinnedVersion(): string {
  const dockerfile = readFileSync(join(repoRoot, "templates/container/Dockerfile"), "utf8");
  const match = /^ARG RENOVATE_VERSION=(\S+)$/m.exec(dockerfile);
  if (match === null) throw new Error("templates/container/Dockerfile pins no RENOVATE_VERSION");
  return match[1]!;
}

// Recorded with the template's pin on Node 26, `env -i` down to PATH and HOME,
// the source's global config, and the source's flags, over a scratch repo
// holding a package.json, a Cargo.toml with its Cargo.lock, a
// requirements.txt, a Dockerfile and one workflow. The install had no
// compiler, so re2 was dropped and the top-level `problems` carry that warning
// beside the remapped Node version one. Bumping the pin means recording this
// again under the new version's name, from the same scratch repo:
//
//   npm install -g --prefix "$prefix" "renovate@$version"
//   env -i PATH="$prefix/bin:$PATH" HOME="$home" LOG_FORMAT=json \
//     RENOVATE_CONFIG_FILE="$config" renovate --platform=local \
//     --dry-run=lookup --report-type=file \
//     --report-path="fixtures/renovate-report-$version.json"
//
// where `$config` holds RENOVATE_GLOBAL_CONFIG, and then checking the
// expectations below against what the new report says.
function recordedReport(): string {
  return readFileSync(
    join(import.meta.dirname, "fixtures", `renovate-report-${pinnedVersion()}.json`),
    "utf8",
  );
}

function candidate(
  overrides: Partial<Candidate> & Pick<Candidate, "manager" | "package">,
): Candidate {
  return {
    current: "",
    target: "",
    updateType: "minor",
    depType: "prod",
    workspace: "package.json",
    advisories: [],
    peers: [],
    ...overrides,
  };
}

describe("parseRenovateReport on the recorded report", () => {
  test("every looked-up dependency's proposals come back as candidates", () => {
    const parsed = parseRenovateReport(recordedReport());
    if (!parsed.ok) throw new Error(parsed.problem);
    expect(parsed.candidates).toEqual([
      candidate({
        manager: "cargo",
        package: "serde",
        current: "1.0.150",
        target: "1.0.229",
        updateType: "lockfile",
        publishedAt: "2026-07-18T23:05:13.000Z",
        workspace: "crates/core/Cargo.toml",
        repositoryUrl: "https://github.com/serde-rs/serde",
      }),
      candidate({
        manager: "dockerfile",
        package: "node",
        current: "22.11.0",
        target: "22.23.4",
        workspace: "Dockerfile",
        repositoryUrl: "https://github.com/nodejs/node",
      }),
      candidate({
        manager: "dockerfile",
        package: "node",
        current: "22.11.0",
        target: "26.13.0",
        updateType: "major",
        workspace: "Dockerfile",
        repositoryUrl: "https://github.com/nodejs/node",
      }),
      candidate({
        manager: "npm",
        package: "react",
        current: "18.2.0",
        target: "18.3.1",
        publishedAt: "2024-04-26T16:42:26.496Z",
        repositoryUrl: "https://github.com/react/react",
      }),
      candidate({
        manager: "npm",
        package: "react",
        current: "18.2.0",
        target: "19.3.1",
        updateType: "major",
        publishedAt: "2026-10-14T16:47:15.290Z",
        repositoryUrl: "https://github.com/react/react",
      }),
      candidate({
        manager: "npm",
        package: "typescript",
        current: "5.4.5",
        target: "5.9.3",
        depType: "dev",
        publishedAt: "2025-09-30T21:19:38.784Z",
        repositoryUrl: "https://github.com/microsoft/TypeScript",
      }),
      candidate({
        manager: "npm",
        package: "typescript",
        current: "5.4.5",
        target: "7.0.2",
        updateType: "major",
        depType: "dev",
        publishedAt: "2026-07-08T15:55:18.431Z",
        repositoryUrl: "https://github.com/microsoft/TypeScript",
      }),
      candidate({
        manager: "npm",
        package: "fsevents",
        current: "2.3.2",
        target: "2.3.3",
        updateType: "patch",
        depType: "optional",
        publishedAt: "2023-08-21T16:24:22.854Z",
        repositoryUrl: "https://github.com/fsevents/fsevents",
      }),
      candidate({
        manager: "npm",
        package: "react-dom",
        current: "18.3.1",
        target: "19.3.1",
        updateType: "major",
        depType: "peer",
        publishedAt: "2026-10-14T16:49:10.081Z",
        repositoryUrl: "https://github.com/react/react",
      }),
      candidate({
        manager: "pip_requirements",
        package: "requests",
        current: "2.31.0",
        target: "2.34.2",
        publishedAt: "2026-05-14T19:25:26.000Z",
        workspace: "requirements.txt",
        repositoryUrl: "https://github.com/psf/requests",
      }),
    ]);
  });

  test("the Actions are skipped, not proposed, and the up-to-date lodash still counts as looked up", () => {
    const parsed = parseRenovateReport(recordedReport());
    if (!parsed.ok) throw new Error(parsed.problem);
    expect(parsed.coverage).toEqual({
      lookedUp: 8,
      skipped: { "github-token-required": 1, disabled: 2 },
      failed: 0,
      unmapped: {},
    });
    expect(describeCoverage(parsed.candidates.length, parsed.coverage)).toBe(
      "renovate source: 10 candidate(s) from 8 looked-up dependencies; " +
        "skipped github-token-required 1, disabled 2.",
    );
  });
});

/** A minimal report around one npm package file's deps. */
function report(deps: unknown[], problems: unknown[] = []): string {
  return JSON.stringify({
    problems: [],
    repositories: {
      local: { problems, packageFiles: { npm: [{ packageFile: "package.json", deps }] } },
    },
  });
}

const lookedUp = { registryUrl: "https://registry.npmjs.org", warnings: [] };

describe("parseRenovateReport", () => {
  test("a dependency with warnings or no registryUrl failed its lookup and proposes nothing", () => {
    const update = { updateType: "minor", newVersion: "1.1.0" };
    const parsed = parseRenovateReport(
      report([
        {
          depName: "JesusFilm/core",
          currentValue: "main",
          updates: [update],
          warnings: ["Failed to look up github-digest package JesusFilm/core: no-result"],
        },
        { depName: "left-pad", currentVersion: "1.0.0", updates: [update], warnings: [] },
      ]),
    );
    expect(parsed).toEqual({
      ok: true,
      candidates: [],
      coverage: { lookedUp: 0, skipped: {}, failed: 2, unmapped: {} },
    });
  });

  test("a digest names its digests, a pin the range it replaces, and a rollback is dropped", () => {
    const parsed = parseRenovateReport(
      report([
        {
          ...lookedUp,
          depName: "node",
          currentVersion: "22.11.0",
          currentDigest: "sha256:aaa",
          updates: [{ updateType: "digest", newDigest: "sha256:bbb", newValue: "22.11.0" }],
        },
        {
          ...lookedUp,
          depName: "lodash",
          currentValue: "^4.17.15",
          currentVersion: "4.18.1",
          updates: [
            { updateType: "pin", newValue: "4.18.1", newVersion: "4.18.1" },
            { updateType: "rollback", newVersion: "4.17.0" },
          ],
        },
      ]),
    );
    if (!parsed.ok) throw new Error(parsed.problem);
    expect(parsed.candidates.map((c) => [c.package, c.updateType, c.current, c.target])).toEqual([
      ["node", "digest", "sha256:aaa", "sha256:bbb"],
      ["lodash", "pin", "^4.17.15", "4.18.1"],
    ]);
    expect(parsed.coverage.unmapped).toEqual({ rollback: 1 });
  });

  test("an error-level problem fails the report; warnings do not", () => {
    const warning = { level: 40, msg: "GitHub token is required for some dependencies" };
    expect(parseRenovateReport(report([], [warning])).ok).toBe(true);
    expect(
      parseRenovateReport(report([], [warning, { level: 50, msg: "Repository has an error" }])),
    ).toEqual({ ok: false, problem: "renovate logged 1 error(s): Repository has an error" });
  });

  test("text that is not a report is a failure", () => {
    expect(parseRenovateReport("not json").ok).toBe(false);
    expect(parseRenovateReport(JSON.stringify({ problems: [] }))).toEqual({
      ok: false,
      problem: "the report has no repositories.local",
    });
  });
});

type Harness = { ctx: RenovateSourceCtx; scratch: string; checkout: string; logged: string[] };

function harness(env: NodeJS.ProcessEnv = {}, signal?: AbortSignal): Harness {
  const scratch = mkdtempSync(join(tmpdir(), "phoebe-renovate-source-"));
  const checkout = mkdtempSync(join(tmpdir(), "phoebe-renovate-checkout-"));
  const logged: string[] = [];
  const ctx: RenovateSourceCtx = {
    workspace: { mode: "readonly", dir: checkout, scratch },
    log: (line) => logged.push(line),
    env: { PATH: process.env["PATH"], HOME: process.env["HOME"], ...env },
    signal: signal ?? new AbortController().signal,
  };
  return { ctx, scratch, checkout, logged };
}

/** A stand-in `renovate`: a shell script with `body` after the shebang. */
function fakeRenovate(dir: string, body: string): string {
  const path = join(dir, "fake-renovate.sh");
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

/** Shell that writes `text` to the path given as `--report-path=…`. */
function writesReport(text: string): string {
  const fixture = join(mkdtempSync(join(tmpdir(), "phoebe-renovate-fixture-")), "report.json");
  writeFileSync(fixture, text);
  return `for arg; do case "$arg" in --report-path=*) cp '${fixture}' "\${arg#--report-path=}";; esac; done`;
}

describe("runRenovateSource", () => {
  test("a clean run returns the report's candidates and logs what it covered", async () => {
    const h = harness();
    const command = fakeRenovate(h.scratch, writesReport(recordedReport()));
    const result = await runRenovateSource(h.ctx, { command });
    expect(result.ok && result.candidates).toHaveLength(10);
    expect(h.logged).toEqual([
      "renovate source: 10 candidate(s) from 8 looked-up dependencies; " +
        "skipped github-token-required 1, disabled 2.",
    ]);
    expect(JSON.parse(readFileSync(join(h.scratch, RENOVATE_CONFIG_FILE), "utf8"))).toEqual(
      RENOVATE_GLOBAL_CONFIG,
    );
  });

  test("Renovate runs in the checkout with the spike's flags and no GitHub credential", async () => {
    const h = harness({ GH_TOKEN: "ghs_secret", GITHUB_TOKEN: "ghs_secret", RENOVATE_TOKEN: "x" });
    const seen = join(h.scratch, "seen.txt");
    const command = fakeRenovate(
      h.scratch,
      `{ pwd; echo "$@"; env | sort; } > '${seen}'\n${writesReport(report([]))}`,
    );
    const result = await runRenovateSource(h.ctx, { command });
    expect(result).toEqual({ ok: true, candidates: [] });
    const [cwd, args, ...env] = readFileSync(seen, "utf8").trim().split("\n");
    expect(cwd).toBe(h.checkout);
    expect(args).toBe(
      "--platform=local --dry-run=lookup --report-type=file " +
        `--report-path=${join(h.scratch, RENOVATE_REPORT_FILE)}`,
    );
    const names = env.map((line) => line.split("=")[0]);
    expect(names).not.toContain("GH_TOKEN");
    expect(names).not.toContain("GITHUB_TOKEN");
    expect(names).not.toContain("RENOVATE_TOKEN");
    expect(env).toContain("LOG_FORMAT=json");
    expect(env).toContain(`RENOVATE_CONFIG_FILE=${join(h.scratch, RENOVATE_CONFIG_FILE)}`);
  });

  test("exit code 1 is a failed source, logged with the last error, not a throw", async () => {
    const h = harness();
    const command = fakeRenovate(
      h.scratch,
      `echo '{"level":50,"msg":"Unsupported node environment detected. Please update your node version."}'\n` +
        `${writesReport(recordedReport())}\nexit 1`,
    );
    const result = await runRenovateSource(h.ctx, { command });
    expect(result).toEqual({ ok: false, problem: "renovate exited 1" });
    expect(h.logged).toEqual([
      "renovate source failed: renovate exited 1. Last error logged: Unsupported node " +
        `environment detected. Please update your node version.. Log: ${join(h.scratch, "renovate.log")}`,
    ]);
  });

  test("a run past its deadline is killed and reported", async () => {
    const h = harness();
    const command = fakeRenovate(h.scratch, "exec sleep 30");
    const result = await runRenovateSource(h.ctx, { command, timeoutMs: 200 });
    expect(result).toEqual({ ok: false, problem: "renovate did not finish within 200ms" });
  });

  test("an aborted unit stops Renovate", async () => {
    const controller = new AbortController();
    const h = harness({}, controller.signal);
    const command = fakeRenovate(h.scratch, "exec sleep 30");
    setTimeout(() => controller.abort(), 100);
    expect(await runRenovateSource(h.ctx, { command })).toEqual({
      ok: false,
      problem: "the run was aborted before renovate finished",
    });
  });

  test("a missing renovate, a missing report and an unparseable one are failed sources", async () => {
    const h = harness();
    const missing = await runRenovateSource(h.ctx, {
      command: join(h.scratch, "no-such-renovate"),
    });
    expect(missing.ok === false && missing.problem).toMatch(/^could not start renovate \(.*ENOENT/);

    const silent = await runRenovateSource(h.ctx, { command: fakeRenovate(h.scratch, "exit 0") });
    expect(silent).toEqual({
      ok: false,
      problem: `renovate exited 0 but wrote no report at ${join(h.scratch, RENOVATE_REPORT_FILE)}`,
    });

    const garbled = await runRenovateSource(h.ctx, {
      command: fakeRenovate(h.scratch, writesReport("{")),
    });
    expect(garbled.ok === false && garbled.problem).toMatch(/^the report is not JSON/);
  });
});
