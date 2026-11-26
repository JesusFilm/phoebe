// `phoebe bench` (#939, #940): the flags, the one-off container the host arm
// starts, the tenant the container arm reads, the suite it prints, and the run
// it starts.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import {
  benchComposeArgv,
  containerSuitePath,
  ensureGhToken,
  parseBenchArgs,
  resolveBenchTenant,
  runBenchCli,
  runBenchReportInContainer,
  runBenchRunInContainer,
  runBenchSelectInContainer,
} from "./bench-command.ts";
import { asBranchRef, asPrNumber, asSha } from "./branded.ts";
import type { BenchSuite } from "./contracts/bench.ts";
import type { BenchReport } from "./contracts/bench-report.ts";
import type { CommandRunner } from "./deployment-compose.ts";
import { stubGitHub } from "./github-stub.ts";

describe("parseBenchArgs", () => {
  test("--issues names the fixtures", () => {
    expect(parseBenchArgs(["select", "--issues", "12,#34, 56"])).toEqual({
      help: false,
      command: "select",
      request: { by: "issues", issues: [12, 34, 56] },
    });
    expect(parseBenchArgs(["select", "--issues=12"]).request).toEqual({
      by: "issues",
      issues: [12],
    });
  });

  test("the query takes --since and --limit, defaulting the limit", () => {
    expect(parseBenchArgs(["select"]).request).toEqual({ by: "query", since: null, limit: 20 });
    expect(
      parseBenchArgs(["select", "--since", "2026-11-01", "--limit=5", "--tenant", "acme/widget"]),
    ).toEqual({
      help: false,
      command: "select",
      tenant: "acme/widget",
      request: { by: "query", since: "2026-11-01", limit: 5 },
    });
  });

  test("refuses what it cannot mean", () => {
    expect(() => parseBenchArgs([])).toThrow(/needs a command: select, run or report/);
    expect(() => parseBenchArgs(["replay"])).toThrow(/Unknown `phoebe bench` command `replay`/);
    expect(() => parseBenchArgs(["select", "--issues", "12", "--limit", "3"])).toThrow(
      /does not combine/,
    );
    expect(() => parseBenchArgs(["select", "--issues", "twelve"])).toThrow(/positive whole/);
    expect(() => parseBenchArgs(["select", "--since", "last week"])).toThrow(/YYYY-MM-DD/);
    expect(() => parseBenchArgs(["select", "--limit", "0"])).toThrow(/positive whole/);
    expect(() => parseBenchArgs(["select", "--tenant"])).toThrow(/needs a value/);
    expect(() => parseBenchArgs(["select", "--json"])).toThrow(/always prints JSON/);
    expect(() => parseBenchArgs(["select", "--bench-config", "b.json"])).toThrow(/are for `run`/);
  });

  test("run takes one suite file and --tenant", () => {
    expect(parseBenchArgs(["run", "bench/suite.json", "--tenant=acme/widget"])).toEqual({
      help: false,
      command: "run",
      suitePath: "bench/suite.json",
      tenant: "acme/widget",
    });
    expect(() => parseBenchArgs(["run"])).toThrow(/needs a suite file/);
    expect(() => parseBenchArgs(["run", "a.json", "b.json"])).toThrow(
      /Unexpected argument `b.json`/,
    );
    expect(() => parseBenchArgs(["run", "a.json", "--issues", "1"])).toThrow(
      /for `select`, not `run`/,
    );
  });

  test("run takes a bench config, --concurrency and --json", () => {
    expect(
      parseBenchArgs([
        "run",
        "bench/suite.json",
        "--bench-config",
        "bench/bench.json",
        "--concurrency=3",
        "--json",
      ]),
    ).toEqual({
      help: false,
      command: "run",
      suitePath: "bench/suite.json",
      benchConfigPath: "bench/bench.json",
      concurrency: 3,
      json: true,
    });
    expect(() => parseBenchArgs(["run", "s.json", "--concurrency", "0"])).toThrow(/positive whole/);
  });

  test("report takes one run id and --json", () => {
    expect(parseBenchArgs(["report", "2026-11-25T12-00-00-000Z", "--json"])).toEqual({
      help: false,
      command: "report",
      runId: "2026-11-25T12-00-00-000Z",
      json: true,
    });
    expect(() => parseBenchArgs(["report"])).toThrow(/needs a run id/);
    expect(() => parseBenchArgs(["report", "r", "--concurrency", "2"])).toThrow(/are for `run`/);
    expect(() => parseBenchArgs(["report", "r", "--issues", "1"])).toThrow(/not `report`/);
  });

  test("--help needs no command", () => {
    expect(parseBenchArgs(["--help"])).toEqual({ help: true });
  });
});

describe("the host arm", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "phoebe-bench-host-"));
    mkdirSync(join(root, "container"));
    writeFileSync(join(root, "container", "compose.yml"), "services: {}\n");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("starts a one-off container from the deployment's image with the same request", async () => {
    const calls: Array<Parameters<CommandRunner>[0]> = [];
    const runner: CommandRunner = (spec) => {
      calls.push(spec);
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    };

    await runBenchCli(["select", "--issues", "12,34", "--tenant", "acme/widget"], {
      cwd: root,
      inContainer: false,
      dockerAvailable: true,
      hasDeploymentBlock: false,
      runner,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.inheritStdio).toBe(true);
    expect(calls[0]!.args).toEqual([
      "compose",
      "-f",
      join(root, "container", "compose.yml"),
      "run",
      "--rm",
      "-T",
      "--no-deps",
      "--entrypoint",
      "phoebe",
      "phoebe",
      "bench",
      "select",
      "--issues",
      "12,34",
      "--tenant",
      "acme/widget",
    ]);
  });

  test("forwards the query's defaults explicitly", () => {
    expect(benchComposeArgv(parseBenchArgs(["select", "--since", "2026-11-01"])).slice(-6)).toEqual(
      ["bench", "select", "--since", "2026-11-01", "--limit", "20"],
    );
  });

  test("run hands the container the suite's path inside the deployment directory", async () => {
    const calls: Array<Parameters<CommandRunner>[0]> = [];
    const runner: CommandRunner = (spec) => {
      calls.push(spec);
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    };
    await runBenchCli(["run", join(root, "bench", "suite.json")], {
      cwd: root,
      inContainer: false,
      dockerAvailable: true,
      hasDeploymentBlock: false,
      runner,
    });
    expect(calls[0]!.args.slice(-3)).toEqual(["bench", "run", "bench/suite.json"]);
  });

  test("run hands the container the bench config's path, --concurrency and --json", async () => {
    const calls: Array<Parameters<CommandRunner>[0]> = [];
    const runner: CommandRunner = (spec) => {
      calls.push(spec);
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    };
    const deps = {
      cwd: root,
      inContainer: false,
      dockerAvailable: true,
      hasDeploymentBlock: false,
      runner,
    };
    await runBenchCli(
      [
        "run",
        "bench/suite.json",
        "--bench-config",
        join(root, "bench", "bench.json"),
        "--concurrency",
        "2",
        "--json",
      ],
      deps,
    );
    expect(calls[0]!.args.slice(-8)).toEqual([
      "bench",
      "run",
      "bench/suite.json",
      "--bench-config",
      "bench/bench.json",
      "--concurrency",
      "2",
      "--json",
    ]);
    await expect(
      runBenchCli(["run", "bench/suite.json", "--bench-config", "/tmp/bench.json"], deps),
    ).rejects.toThrow(/The bench config \/tmp\/bench.json is outside the deployment directory/);
    await runBenchCli(["report", "2026-11-25T12-00-00-000Z", "--tenant", "acme/widget"], deps);
    expect(calls[1]!.args.slice(-5)).toEqual([
      "bench",
      "report",
      "2026-11-25T12-00-00-000Z",
      "--tenant",
      "acme/widget",
    ]);
  });

  test("run refuses a suite the container cannot see", async () => {
    expect(containerSuitePath("/srv/deploy", "/srv/deploy", "bench/s.json")).toBe("bench/s.json");
    expect(containerSuitePath("/srv/deploy", "/srv/deploy", "..s.json")).toBe("..s.json");
    expect(containerSuitePath("/srv/deploy", "/srv/deploy", "./-s.json")).toBe("./-s.json");
    expect(() => containerSuitePath("/srv/deploy", "/srv/deploy", "../s.json")).toThrow(
      /outside the deployment directory/,
    );
    expect(() => containerSuitePath("/srv/deploy", "/srv/deploy", "/tmp/s.json")).toThrow(
      /outside the deployment directory/,
    );
  });

  test("a deployment block has no Compose file to run through", async () => {
    await expect(
      runBenchCli(["select"], { cwd: root, inContainer: false, hasDeploymentBlock: true }),
    ).rejects.toThrow(/deployment` block/);
  });
});

const TENANT_CONFIG = `export default {
  repoSlug: "acme/widget",
  repoUrl: "https://github.com/acme/widget.git",
  installCommand: "pnpm install",
  checkCommand: "pnpm check",
  testCommand: "pnpm test",
};
`;

describe("the container arm", () => {
  let root: string;
  let dataBase: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "phoebe-bench-container-"));
    dataBase = join(root, "data");
    writeFileSync(join(root, "phoebe.config.ts"), TENANT_CONFIG);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("prints the suite as JSON on stdout, lists skips on stderr, and only reads GitHub", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const prepared: string[] = [];
    const gitCalls: Array<{ args: string[]; cwd: string | undefined }> = [];
    // Only the reads are declared: any write the verb reached for would throw.
    const github = stubGitHub({
      mergedPrsForBranch: (branch) =>
        branch === "phoebe/issue-12"
          ? [
              {
                number: asPrNumber(20),
                headRefName: asBranchRef("phoebe/issue-12"),
                mergedAt: "2026-11-04T00:00:00Z",
              },
            ]
          : [],
      benchPrFacts: (pr) => ({
        number: pr,
        createdAt: "2026-11-02T00:00:00Z",
        merged: true,
        baseRefName: "main",
        headRefName: "phoebe/issue-12",
        headRefOid: asSha("a".repeat(40)),
        mergeCommitOid: asSha("b".repeat(40)),
        body: "Closes #12",
        closingIssues: [12],
        commits: [{ oid: asSha("a".repeat(40)), authorName: "Phoebe", authorEmail: "p@x" }],
        commitsTruncated: false,
        commentBodies: [],
        baseRefChanged: false,
      }),
      benchIssueFacts: (issue) => ({
        number: issue,
        title: "Fix it",
        body: "It is broken.",
        labels: [],
        labelsEverAdded: [],
        comments: [],
      }),
    });

    const suite = await runBenchSelectInContainer(parseBenchArgs(["select", "--issues", "12,13"]), {
      cwd: root,
      env: { PHOEBE_DATA_DIR: dataBase },
      io: { stdout: (text) => stdout.push(text), stderr: (line) => stderr.push(line) },
      github: (tenant) => {
        expect(tenant.config.repoSlug).toBe("acme/widget");
        return github;
      },
      prepareClone: (config) => prepared.push(config.paths.repoDir),
      // The hub clone's side has its own suite (bench-select.test.ts); here it
      // holds both commits and answers the merge-base.
      git: (args, opts) => {
        gitCalls.push({ args, cwd: opts?.cwd });
        if (args[0] === "rev-parse") return `${"e".repeat(40)}\n`;
        if (args[0] === "merge-base") return `${"c".repeat(40)}\n`;
        return "";
      },
      now: () => new Date("2026-11-25T00:00:00Z"),
    });

    expect(prepared).toEqual([join(dataBase, "acme", "widget", "repo")]);
    const printed = JSON.parse(stdout.join("")) as BenchSuite;
    expect(printed).toEqual(suite);
    expect(printed.repo).toBe("acme/widget");
    expect(printed.fixtures).toEqual([
      {
        issue: { number: 12, title: "Fix it", body: "It is broken.", comments: [] },
        pr: { number: 20, headSha: "a".repeat(40), mergeSha: "b".repeat(40) },
        baseSha: "c".repeat(40),
      },
    ]);
    expect(printed.skipped).toEqual([
      { issue: 13, pr: null, reason: "no merged PR came from phoebe/issue-13" },
    ]);
    expect(gitCalls.map((call) => call.args)).toEqual([
      ["cat-file", "-e", `${"a".repeat(40)}^{commit}`],
      ["cat-file", "-e", `${"b".repeat(40)}^{commit}`],
      ["rev-parse", "--verify", `${"b".repeat(40)}^1`],
      ["merge-base", "a".repeat(40), "e".repeat(40)],
    ]);
    expect(new Set(gitCalls.map((call) => call.cwd))).toEqual(new Set([prepared[0]]));
    expect(stderr).toEqual([
      "[phoebe] bench: skipped #13: no merged PR came from phoebe/issue-13",
      "[phoebe] bench: 1 fixture(s) for acme/widget, 1 skipped.",
    ]);
  });
});

describe("the container arm of run", () => {
  let root: string;
  let dataBase: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "phoebe-bench-run-container-"));
    dataBase = join(root, "data");
    writeFileSync(join(root, "phoebe.config.ts"), TENANT_CONFIG);
    mkdirSync(join(root, "prompts"));
    writeFileSync(join(root, "prompts", "issues-prompt.md"), "Work #{{ISSUE_NUMBER}}.\n");
    mkdirSync(join(root, "bench"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function hubWithOneCommit(repoDir: string): string {
    const git = (...args: string[]): string =>
      execFileSync(
        "git",
        ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args],
        { cwd: repoDir, encoding: "utf8", stdio: "pipe" },
      ).trim();
    mkdirSync(repoDir, { recursive: true });
    git("init", "-q", "-b", "main");
    git("commit", "-q", "--allow-empty", "-m", "seed");
    return git("rev-parse", "HEAD");
  }

  function writeSuite(repo: string, baseSha: string): void {
    const suite: BenchSuite = {
      v: 1,
      repo,
      selectedAt: "2026-11-25T00:00:00.000Z",
      selection: { by: "issues", issues: [12] },
      fixtures: [
        {
          issue: { number: 12, title: "Fix it", body: "It is broken.", comments: [] },
          pr: { number: 20, headSha: baseSha, mergeSha: baseSha },
          baseSha,
        },
      ],
      skipped: [],
    };
    writeFileSync(join(root, "bench", "suite.json"), JSON.stringify(suite));
  }

  test("runs the suite against the tenant's hub, under the tenant's bench directory", async () => {
    const hubDir = join(dataBase, "acme", "widget", "repo");
    const baseSha = hubWithOneCommit(hubDir);
    writeSuite("acme/widget", baseSha);
    const stdout: string[] = [];
    const stderr: string[] = [];
    const prepared: string[] = [];
    const gates: string[] = [];

    const result = await runBenchRunInContainer(parseBenchArgs(["run", "bench/suite.json"]), {
      cwd: root,
      env: { PHOEBE_DATA_DIR: dataBase, PATH: process.env["PATH"], ANTHROPIC_API_KEY: "k" },
      io: { stdout: (text) => stdout.push(text), stderr: (line) => stderr.push(line) },
      prepareClone: (config) => prepared.push(config.paths.repoDir),
      signal: new AbortController().signal,
      run: {
        spawnAgent: (_file, _args, opts) =>
          spawn("sh", ["-c", "cat >/dev/null"], {
            cwd: opts.cwd,
            env: opts.env,
            stdio: ["pipe", "pipe", "pipe"],
          }),
        runGate: (opts) => {
          gates.push(opts.command);
          return Promise.resolve({ command: opts.command, exitCode: 0, durationMs: 1 });
        },
        engineCommit: null,
      },
    });

    expect(prepared).toEqual([hubDir]);
    expect(result.runDir.startsWith(join(dataBase, "acme", "widget", "bench"))).toBe(true);
    expect(result.trials).toHaveLength(1);
    expect(result.trials[0]).toMatchObject({ outcome: "completed", change: "none" });
    expect(gates).toEqual(["pnpm install"]);
    expect(result.report.interrupted).toBe(false);
    // The table on stdout, one row for the one contender.
    const table = stdout.join("");
    expect(table).toMatch(/^contender\s+trials\s+no change\s+check\s+test/m);
    expect(table).toMatch(/^tenant\s+1\s+1\s+0%\s+0%/m);

    // `bench report` prints the saved run again, here as JSON.
    const again: string[] = [];
    const reprinted = await runBenchReportInContainer(
      parseBenchArgs(["report", result.runId, "--json"]),
      {
        cwd: root,
        env: { PHOEBE_DATA_DIR: dataBase },
        io: { stdout: (text) => again.push(text), stderr: () => {} },
      },
    );
    expect(reprinted).toEqual(result.report);
    expect(JSON.parse(again.join("")) as BenchReport).toEqual(result.report);
    await expect(
      runBenchReportInContainer(parseBenchArgs(["report", "nope"]), {
        cwd: root,
        env: { PHOEBE_DATA_DIR: dataBase },
        io: { stdout: () => {}, stderr: () => {} },
      }),
    ).rejects.toThrow(
      new RegExp(`No bench report for run \`nope\`. Saved runs, newest last: ${result.runId}`),
    );
  });

  test("refuses a bench config it cannot read, and a contender with no provider key", async () => {
    const hubDir = join(dataBase, "acme", "widget", "repo");
    writeSuite("acme/widget", hubWithOneCommit(hubDir));
    const deps = {
      cwd: root,
      env: { PHOEBE_DATA_DIR: dataBase, PATH: process.env["PATH"], ANTHROPIC_API_KEY: "k" },
      io: { stdout: () => {}, stderr: () => {} },
      prepareClone: () => {},
      signal: new AbortController().signal,
      run: { engineCommit: null },
    };
    writeFileSync(
      join(root, "bench", "bench.json"),
      JSON.stringify({ contenders: [{ name: "a", modle: "x" }] }),
    );
    await expect(
      runBenchRunInContainer(
        parseBenchArgs(["run", "bench/suite.json", "--bench-config", "bench/bench.json"]),
        deps,
      ),
    ).rejects.toThrow(/contenders\[0\] has unknown field `modle`/);

    writeFileSync(
      join(root, "bench", "bench.json"),
      JSON.stringify({ contenders: [{ name: "a" }, { name: "b", provider: "codex" }] }),
    );
    await expect(
      runBenchRunInContainer(
        parseBenchArgs(["run", "bench/suite.json", "--bench-config", "bench/bench.json"]),
        deps,
      ),
    ).rejects.toThrow(/b: codex needs OPENAI_KEY, which is unset/);
    expect(existsSync(join(dataBase, "acme", "widget", "bench"))).toBe(false);
  });

  test("refuses a suite for another repo before touching the hub", async () => {
    writeSuite("acme/gadget", "c".repeat(40));
    const prepared: string[] = [];
    await expect(
      runBenchRunInContainer(parseBenchArgs(["run", "bench/suite.json"]), {
        cwd: root,
        env: { PHOEBE_DATA_DIR: dataBase },
        io: { stdout: () => {}, stderr: () => {} },
        prepareClone: (config) => prepared.push(config.paths.repoDir),
      }),
    ).rejects.toThrow(/for acme\/gadget, not acme\/widget/);
    expect(prepared).toEqual([]);
  });
});

describe("resolveBenchTenant", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "phoebe-bench-tenant-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function workspace(): void {
    writeFileSync(join(root, "phoebe.config.ts"), `export default { workspace: { depth: 1 } };\n`);
    for (const name of ["widget", "gadget"]) {
      mkdirSync(join(root, name));
      writeFileSync(join(root, name, "phoebe.config.ts"), TENANT_CONFIG.replaceAll("widget", name));
    }
    writeFileSync(join(root, "widget", ".env"), "GH_TOKEN=from-widget-env\n");
  }

  test("a workspace root takes --tenant, and the tenant's .env joins the env", async () => {
    workspace();
    const tenant = await resolveBenchTenant({
      configPath: join(root, "phoebe.config.ts"),
      dataBase: join(root, "data"),
      processEnv: { GH_TOKEN: "deployment" },
      tenant: "acme/widget",
    });
    expect(tenant.config.repoSlug).toBe("acme/widget");
    expect(tenant.env["GH_TOKEN"]).toBe("from-widget-env");
  });

  test("a workspace root with several tenants refuses to guess", async () => {
    workspace();
    await expect(
      resolveBenchTenant({
        configPath: join(root, "phoebe.config.ts"),
        dataBase: join(root, "data"),
        processEnv: {},
      }),
    ).rejects.toThrow(/Name the tenant/);
  });

  test("a solo config is the tenant, and --tenant may only agree with it", async () => {
    writeFileSync(join(root, "phoebe.config.ts"), TENANT_CONFIG);
    await expect(
      resolveBenchTenant({
        configPath: join(root, "phoebe.config.ts"),
        dataBase: join(root, "data"),
        processEnv: {},
        tenant: "acme/other",
      }),
    ).rejects.toThrow(/does not match this deployment's acme\/widget/);
  });
});

describe("ensureGhToken", () => {
  test("keeps a token already set", async () => {
    const env: NodeJS.ProcessEnv = { GH_TOKEN: "set" };
    await ensureGhToken(env, "acme/widget", () => {
      throw new Error("must not mint");
    });
    expect(env["GH_TOKEN"]).toBe("set");
  });

  test("mints an App token when there is none", async () => {
    const env: NodeJS.ProcessEnv = { GH_APP_ID: "1", GH_APP_PRIVATE_KEY: "key" };
    await ensureGhToken(env, "acme/widget", (slug) => {
      expect(slug).toBe("acme/widget");
      return Promise.resolve({
        ok: true,
        token: "minted",
        botLogin: "app[bot]",
        botName: "app[bot]",
        botEmail: "1+app[bot]@users.noreply.github.com",
      });
    });
    expect(env["GH_TOKEN"]).toBe("minted");
  });

  test("names the missing credential", async () => {
    await expect(ensureGhToken({}, "acme/widget")).rejects.toThrow(/No GitHub credential/);
  });
});
