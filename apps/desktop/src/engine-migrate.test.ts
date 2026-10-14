import path from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { runTargetMigrations, type EnvCommandSpec } from "./engine-migrate.ts";

const SOURCE = { source: "github" as const, ref: "v0.14.0", repo: "JesusFilm/phoebe" };
const BASE = path.join("T:", "engines");
const DIR = path.join(BASE, "github", "JesusFilm-phoebe");

/** A runner that records every spec and answers each by file and subcommand. */
function fakeRunner(answer: (spec: EnvCommandSpec) => { code: number; stdout?: string }) {
  const specs: EnvCommandSpec[] = [];
  const run = (spec: EnvCommandSpec) => {
    specs.push(spec);
    const result = answer(spec);
    return Promise.resolve({ code: result.code, stdout: result.stdout ?? "", stderr: "" });
  };
  return { run, specs };
}

const subcommand = (spec: EnvCommandSpec) =>
  spec.file === "git"
    ? spec.args.find((arg) => arg !== "-C" && !arg.startsWith("-") && arg !== DIR)
    : spec.file;

describe("the incoming engine's migrations, from the companion", () => {
  test("a fresh checkout: clone without history, scrub the remote, fetch, check out, migrate as Node", async () => {
    const { run, specs } = fakeRunner(() => ({ code: 0 }));
    const made: string[] = [];

    const code = await runTargetMigrations(
      { source: SOURCE, configPath: "D:\\installs\\one\\phoebe.config.ts", token: "ghp_secret" },
      {
        run,
        baseDir: BASE,
        execPath: "C:\\companion\\Phoebe.exe",
        exists: (file) => file.endsWith(path.join("migrations", "index.ts")),
        mkdir: (dir) => {
          made.push(dir);
          return Promise.resolve();
        },
      },
    );

    expect(code).toBe(0);
    expect(made).toEqual([DIR]);
    expect(specs.map(subcommand)).toEqual([
      "clone",
      "remote",
      "fetch",
      "checkout",
      "C:\\companion\\Phoebe.exe",
    ]);
    const clone = specs[0]!;
    expect(clone.args).toContain("--filter=blob:none");
    expect(clone.args.join(" ")).toContain("ghp_secret");
    expect(clone.inheritStdio).toBe(true);
    const scrub = specs[1]!;
    expect(scrub.args.join(" ")).not.toContain("ghp_secret");
    expect(scrub.inheritStdio).toBe(false);

    const migrate = specs[4]!;
    expect(migrate.args).toEqual([
      path.join(DIR, "src", "cli.ts"),
      "migrate",
      "--config",
      "D:\\installs\\one\\phoebe.config.ts",
    ]);
    expect(migrate.env?.["ELECTRON_RUN_AS_NODE"]).toBe("1");
    expect(migrate.inheritStdio).toBe(true);
  });

  test("an existing checkout is fetched, not cloned again", async () => {
    const { run, specs } = fakeRunner(() => ({ code: 0 }));

    await runTargetMigrations(
      { source: SOURCE, configPath: "cfg", token: undefined },
      { run, baseDir: BASE, execPath: "node", exists: () => true },
    );

    expect(specs.map(subcommand)).toEqual(["fetch", "checkout", "node"]);
  });

  test("a checkout with no migrations index runs nothing and says so with null", async () => {
    const { run, specs } = fakeRunner(() => ({ code: 0 }));

    const code = await runTargetMigrations(
      { source: SOURCE, configPath: "cfg", token: undefined },
      {
        run,
        baseDir: BASE,
        execPath: "node",
        exists: (file) => file.endsWith(".git"),
      },
    );

    expect(code).toBeNull();
    expect(specs.map(subcommand)).toEqual(["fetch", "checkout"]);
  });

  test("the migrate's exit code is the answer, whatever it is", async () => {
    const { run } = fakeRunner((spec) => ({ code: spec.file === "node" ? 3 : 0 }));

    const code = await runTargetMigrations(
      { source: SOURCE, configPath: "cfg", token: undefined },
      { run, baseDir: BASE, execPath: "node", exists: () => true },
    );

    expect(code).toBe(3);
  });

  test("a git failure names the subcommand and never the token", async () => {
    const { run } = fakeRunner((spec) => ({ code: spec.args.includes("fetch") ? 128 : 0 }));

    await expect(
      runTargetMigrations(
        { source: SOURCE, configPath: "cfg", token: "ghp_secret" },
        { run, baseDir: BASE, execPath: "node", exists: () => true },
      ),
    ).rejects.toThrow(/git fetch exited 128/);
    await expect(
      runTargetMigrations(
        { source: SOURCE, configPath: "cfg", token: "ghp_secret" },
        { run, baseDir: BASE, execPath: "node", exists: () => true },
      ),
    ).rejects.not.toThrow(/ghp_secret/);
  });
});
