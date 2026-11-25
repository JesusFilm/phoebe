// `phoebe bench` (#939): the flags, the one-off container the host arm starts,
// the tenant the container arm reads, and the suite it prints.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import {
  benchComposeArgv,
  ensureGhToken,
  parseBenchArgs,
  resolveBenchTenant,
  runBenchCli,
  runBenchSelectInContainer,
} from "./bench-command.ts";
import { asBranchRef, asPrNumber, asSha } from "./branded.ts";
import type { BenchSuite } from "./contracts/bench.ts";
import type { CommandRunner } from "./deployment-compose.ts";
import { stubGitHub } from "./github-stub.ts";

describe("parseBenchArgs", () => {
  test("--issues names the fixtures", () => {
    expect(parseBenchArgs(["select", "--issues", "12,#34, 56"])).toEqual({
      help: false,
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
      tenant: "acme/widget",
      request: { by: "query", since: "2026-11-01", limit: 5 },
    });
  });

  test("refuses what it cannot mean", () => {
    expect(() => parseBenchArgs([])).toThrow(/needs a command: select/);
    expect(() => parseBenchArgs(["run"])).toThrow(/Unknown `phoebe bench` command `run`/);
    expect(() => parseBenchArgs(["select", "--issues", "12", "--limit", "3"])).toThrow(
      /does not combine/,
    );
    expect(() => parseBenchArgs(["select", "--issues", "twelve"])).toThrow(/positive whole/);
    expect(() => parseBenchArgs(["select", "--since", "last week"])).toThrow(/YYYY-MM-DD/);
    expect(() => parseBenchArgs(["select", "--limit", "0"])).toThrow(/positive whole/);
    expect(() => parseBenchArgs(["select", "--tenant"])).toThrow(/needs a value/);
    expect(() => parseBenchArgs(["select", "--json"])).toThrow(/Unknown flag `--json`/);
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
