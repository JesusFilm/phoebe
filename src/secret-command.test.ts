// `phoebe secret` (#504): the argv that must never hold a value, the stdin that
// must, the refusal an off-catalogue key gets, and the doctor run a successful
// set triggers.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import {
  formatSecretListing,
  listSecrets,
  parseSecretArgs,
  readSecretValue,
  resolveSecretTarget,
  runSecretCli,
  type SecretIo,
} from "./secret-command.ts";
import { readSecretEdits, readSecretStore, setSecret } from "./secret-store.ts";

/** A pipe carrying `text`, as the shell hands one over. */
function pipe(text: string): NodeJS.ReadStream {
  const stream = Readable.from([Buffer.from(text)]) as unknown as NodeJS.ReadStream;
  stream.isTTY = false;
  return stream;
}

function collector(): SecretIo & { text: () => string } {
  const chunks: string[] = [];
  return {
    out: (text) => chunks.push(text),
    err: (text) => chunks.push(text),
    text: () => chunks.join(""),
  };
}

const TENANT_CONFIG = `const config = {
  repoSlug: "acme/widget",
  repoUrl: "https://github.com/acme/widget.git",
  installCommand: "pnpm install",
  checkCommand: "pnpm check",
  testCommand: "pnpm test",
  providerEnv: { claude: "ANTHROPIC_API_KEY" },
};
export default config;
`;

let root: string;
let dataBase: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "phoebe-secret-command-"));
  dataBase = join(root, "data");
  mkdirSync(join(dataBase, "acme", "widget", "state"), { recursive: true });
  writeFileSync(join(root, "phoebe.config.ts"), TENANT_CONFIG);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const stateDir = (): string => join(dataBase, "acme", "widget", "state");
const env = (): NodeJS.ProcessEnv => ({ PHOEBE_DATA_DIR: dataBase });

describe("the argv", () => {
  test("a value is never an argument", () => {
    expect(() => parseSecretArgs(["set", "GH_TOKEN", "ghp_leaked"])).toThrow(/pipe it in/);
  });

  test("every command needs its key, and `secret` needs a command", () => {
    expect(() => parseSecretArgs([])).toThrow(/set, clear or ls/);
    expect(() => parseSecretArgs(["set"])).toThrow(/needs a key/);
    expect(() => parseSecretArgs(["rotate", "GH_TOKEN"])).toThrow(/Unknown/);
    expect(parseSecretArgs(["ls"]).action).toBe("ls");
  });

  test("the flags each subcommand shares", () => {
    const parsed = parseSecretArgs([
      "set",
      "GH_TOKEN",
      "--tenant",
      "acme/widget",
      "--config",
      "x.ts",
      "--no-doctor",
    ]);
    expect(parsed).toMatchObject({
      action: "set",
      key: "GH_TOKEN",
      tenant: "acme/widget",
      configPath: "x.ts",
      noDoctor: true,
    });
  });

  test("--help answers without a command", () => {
    expect(parseSecretArgs(["--help"]).help).toBe(true);
  });
});

describe("the value on stdin", () => {
  test("one trailing newline is stripped, so echo and printf agree", async () => {
    expect(await readSecretValue(pipe("sk-live\n"))).toBe("sk-live");
    expect(await readSecretValue(pipe("sk-live"))).toBe("sk-live");
    expect(await readSecretValue(pipe("sk-live\r\n"))).toBe("sk-live");
    expect(await readSecretValue(pipe("sk-live\n\n"))).toBe("sk-live\n");
  });

  test("a terminal on stdin is refused, not waited on", async () => {
    const tty = Readable.from([]) as unknown as NodeJS.ReadStream;
    tty.isTTY = true;
    await expect(readSecretValue(tty)).rejects.toThrow(/never from the command line/);
  });
});

describe("which tenant", () => {
  test("a config that declares its slug is the tenant", async () => {
    const target = await resolveSecretTarget({
      configPath: join(root, "phoebe.config.ts"),
      dataBase,
      processEnv: env(),
    });
    expect(target.slug).toBe("acme/widget");
    expect(target.stateDir).toBe(stateDir());
    expect(target.settable).toContain("ANTHROPIC_API_KEY");
    expect(target.settable).toContain("GH_TOKEN");
  });

  test("`--tenant` that disagrees with the config is refused", async () => {
    await expect(
      resolveSecretTarget({
        configPath: join(root, "phoebe.config.ts"),
        dataBase,
        processEnv: env(),
        tenant: "acme/other",
      }),
    ).rejects.toThrow(/does not match/);
  });

  test("a config with no repoSlug has nowhere to keep a store", async () => {
    writeFileSync(join(root, "phoebe.config.ts"), TENANT_CONFIG.replace(/repoSlug:.*\n/, ""));
    await expect(
      resolveSecretTarget({
        configPath: join(root, "phoebe.config.ts"),
        dataBase,
        processEnv: env(),
      }),
    ).rejects.toThrow(/repoSlug/);
  });
});

describe("set, clear, ls", () => {
  const run = async (
    argv: readonly string[],
    opts: { stdin?: NodeJS.ReadStream; doctor?: boolean } = {},
  ): Promise<{ io: ReturnType<typeof collector>; doctorRuns: string[] }> => {
    const io = collector();
    const doctorRuns: string[] = [];
    await runSecretCli(argv, {
      io,
      processEnv: env(),
      cwd: root,
      ...(opts.stdin !== undefined ? { stdin: opts.stdin } : {}),
      runDoctorFor: (configDir) => {
        doctorRuns.push(configDir);
        return Promise.resolve({ ok: opts.doctor ?? true, text: "[phoebe] doctor\n" });
      },
    });
    return { io, doctorRuns };
  };

  test("a set stores the value, records the edit, and never prints it", async () => {
    const { io, doctorRuns } = await run(["set", "ANTHROPIC_API_KEY"], {
      stdin: pipe("sk-live\n"),
    });
    expect(readSecretStore(stateDir())).toEqual({ ANTHROPIC_API_KEY: "sk-live" });
    expect(readSecretEdits(stateDir())).toHaveLength(1);
    expect(io.text()).not.toContain("sk-live");
    expect(io.text()).toContain("wrote ANTHROPIC_API_KEY");
    // The set is the moment an operator wants "did it work" answered (#507 §6).
    expect(doctorRuns).toEqual([root]);
  });

  test("--no-doctor skips the run, for a scripted rotation of many keys", async () => {
    const { doctorRuns } = await run(["set", "GH_TOKEN", "--no-doctor"], { stdin: pipe("ghp_x") });
    expect(doctorRuns).toEqual([]);
    expect(readSecretStore(stateDir())).toEqual({ GH_TOKEN: "ghp_x" });
  });

  test("a blank on stdin is refused — that is what clear is for", async () => {
    await expect(run(["set", "GH_TOKEN"], { stdin: pipe("\n") })).rejects.toThrow(/blank/);
    expect(readSecretStore(stateDir())).toEqual({});
  });

  test("an off-catalogue key is refused before anything is written", async () => {
    await expect(run(["set", "STRIPE_KEY"], { stdin: pipe("sk") })).rejects.toThrow(
      /not a key this tenant reads/,
    );
    expect(readSecretStore(stateDir())).toEqual({});
  });

  test("the App key is refused at tenant scope too", async () => {
    await expect(run(["set", "GH_APP_PRIVATE_KEY"], { stdin: pipe("x") })).rejects.toThrow(
      /deployment-scope/,
    );
  });

  test("a clear hands the key back and says so", async () => {
    setSecret({ stateDir: stateDir(), key: "GH_TOKEN", value: "ghp_x" });
    const { io } = await run(["clear", "GH_TOKEN"]);
    expect(readSecretStore(stateDir())).toEqual({});
    expect(io.text()).toContain("governs again");
  });

  test("clearing what was never set says nothing happened", async () => {
    const { io } = await run(["clear", "GH_TOKEN"]);
    expect(io.text()).toContain("nothing to clear");
  });

  test("ls reports presence and source, never a value", async () => {
    setSecret({ stateDir: stateDir(), key: "ANTHROPIC_API_KEY", value: "sk-live" });
    const { io } = await run(["ls"]);
    expect(io.text()).toContain("ANTHROPIC_API_KEY");
    expect(io.text()).toContain("store");
    expect(io.text()).not.toContain("sk-live");
  });
});

describe("the listing", () => {
  const edits = [{ id: "e1", key: "GH_TOKEN", at: "2026-03-01T00:00:00.000Z", by: "a@b.test" }];

  test("the store's tier is named, and so is what it shadows", () => {
    const listings = listSecrets({
      settable: ["GH_TOKEN", "ANTHROPIC_API_KEY", "SENTRY_DSN"],
      store: { GH_TOKEN: "ghp_x" },
      tenantEnv: { GH_TOKEN: "ghp_old", ANTHROPIC_API_KEY: "sk" },
      processEnv: {},
      edits,
    });
    expect(listings).toEqual([
      {
        key: "ANTHROPIC_API_KEY",
        present: true,
        source: "tenantEnv",
      },
      {
        key: "GH_TOKEN",
        present: true,
        source: "store",
        shadowed: true,
        setAt: "2026-03-01T00:00:00.000Z",
        by: "a@b.test",
      },
      { key: "SENTRY_DSN", present: false, source: "missing" },
    ]);
  });

  test("a store entry no kind declares any more still gets a line", () => {
    const listings = listSecrets({
      settable: ["GH_TOKEN"],
      store: { RETIRED_KEY: "x" },
      tenantEnv: {},
      processEnv: {},
      edits: [],
    });
    expect(listings.map((listing) => listing.key)).toEqual(["GH_TOKEN", "RETIRED_KEY"]);
  });

  test("the rendered lines carry no value", () => {
    const text = formatSecretListing(
      "acme/widget",
      listSecrets({
        settable: ["GH_TOKEN"],
        store: { GH_TOKEN: "ghp_secret_value" },
        tenantEnv: { GH_TOKEN: "ghp_older" },
        processEnv: {},
        edits,
      }),
    );
    expect(text).not.toContain("ghp_secret_value");
    expect(text).toContain("shadows the .env");
    expect(text).toContain("by a@b.test");
  });
});
