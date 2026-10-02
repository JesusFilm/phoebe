// Pairing, as the four steps it is — and the one rule that runs through all of
// them: the token goes into the `.env` and nowhere else.

import path from "node:path";
import { describe, expect, test } from "vite-plus/test";
import type { VerbIo } from "phoebe-agent/contracts";
import type { CommandRunner } from "../../../src/deployment-compose.ts";
import { BridgeRefusal } from "./channels.ts";
import { deploymentsUrlFor, pairInstall, type PairArm } from "./pair.ts";

const DIR = "/repos/youtube-studio";
const CONFIG = path.join(DIR, "phoebe.config.ts");
const ENV = path.join(DIR, ".env");
const COMPOSE = path.join(DIR, "container", "compose.yml");
const TOKEN = "s3cret-pairing-token";
const EXPIRES = "2026-09-18T12:15:00.000Z";

const CONFIG_SOURCE = `const config = {\n  repoSlug: "jesusfilm/youtube-studio",\n};\nexport default config;\n`;

/** A machine: the files it holds, the lines it collected, the compose calls made. */
function machine(files: Record<string, string> = { [CONFIG]: CONFIG_SOURCE }) {
  const written: Record<string, string> = {};
  const lines: string[] = [];
  const composeCalls: string[][] = [];
  const present = new Set([DIR, COMPOSE, ...Object.keys(files)]);

  const io: VerbIo = {
    stdout: (line) => lines.push(line),
    stderr: (line) => lines.push(line),
  };
  const runner: CommandRunner = (spec) => {
    composeCalls.push(spec.args as string[]);
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  };

  return {
    lines,
    written,
    composeCalls,
    deps: {
      io,
      runner,
      exists: (file: string) => present.has(file),
      read: (file: string) => {
        const held = written[file] ?? files[file];
        if (held === undefined) throw new Error(`no such file: ${file}`);
        return held;
      },
      write: (file: string, contents: string) => {
        written[file] = contents;
        present.add(file);
      },
    },
  };
}

/** A relay that mints, and counts how often it was asked to. */
function arm(overrides: Partial<PairArm> = {}): PairArm & { mints: number } {
  const state = {
    url: "https://relay.example.test",
    mints: 0,
    mint: () => {
      state.mints += 1;
      return Promise.resolve({ token: TOKEN, expiresAt: EXPIRES });
    },
    ...overrides,
  };
  return state;
}

describe("what one pairing writes", () => {
  test("the relay's address goes into the config as a websocket URL", async () => {
    const host = machine();

    const outcome = await pairInstall(DIR, arm(), host.deps);

    expect(outcome.relayUrl).toBe("wss://relay.example.test/deployments");
    expect(host.written[CONFIG]).toContain('url: "wss://relay.example.test/deployments"');
    expect(host.written[CONFIG]).toContain('repoSlug: "jesusfilm/youtube-studio"');
  });

  test("the token goes into the root `.env`, under the name boot reads", async () => {
    const host = machine();

    await pairInstall(DIR, arm(), host.deps);

    expect(host.written[ENV]).toBe(`PHOEBE_RELAY_TOKEN=${TOKEN}\n`);
  });

  test("an existing `.env` keeps everything that was in it", async () => {
    const host = machine({ [CONFIG]: CONFIG_SOURCE, [ENV]: "# mine\nGH_TOKEN=ghp_keep\n" });

    await pairInstall(DIR, arm(), host.deps);

    expect(host.written[ENV]).toBe(`# mine\nGH_TOKEN=ghp_keep\nPHOEBE_RELAY_TOKEN=${TOKEN}\n`);
  });

  test("the nudge is an `up -d`, which is what makes Compose reread the env", async () => {
    const host = machine();

    await pairInstall(DIR, arm(), host.deps);

    expect(host.composeCalls).toHaveLength(1);
    expect(host.composeCalls[0]).toEqual(["compose", "-f", COMPOSE, "up", "-d"]);
  });

  test("the outcome names the deployment the relay will see", async () => {
    const host = machine();

    const outcome = await pairInstall(DIR, arm(), host.deps);

    expect(outcome.deploymentName).toBe("jesusfilm/youtube-studio");
    expect(outcome.expiresAt).toBe(EXPIRES);
    expect(outcome.movedRelay).toBe(false);
  });

  test("re-pairing onto a different relay says the old one was left behind", async () => {
    const source = `const config = {\n  relay: { url: "wss://old.test/deployments" },\n};\nexport default config;\n`;
    const host = machine({ [CONFIG]: source });

    const outcome = await pairInstall(DIR, arm(), host.deps);

    expect(outcome.movedRelay).toBe(true);
    expect(host.written[CONFIG]).toContain("wss://relay.example.test/deployments");
  });

  test("re-pairing onto the same relay is a fresh token and not a move", async () => {
    const source = `const config = {\n  relay: { url: "wss://relay.example.test/deployments" },\n};\nexport default config;\n`;
    const host = machine({ [CONFIG]: source });

    const outcome = await pairInstall(DIR, arm(), host.deps);

    expect(outcome.movedRelay).toBe(false);
    expect(host.written[ENV]).toContain(TOKEN);
  });
});

describe("the token is never in a line", () => {
  test("not while it is being minted, written, or reported", async () => {
    const host = machine();

    const outcome = await pairInstall(DIR, arm(), host.deps);

    expect(host.lines.join("\n")).not.toContain(TOKEN);
    expect(JSON.stringify(outcome)).not.toContain(TOKEN);
  });

  test("what the operator gets instead is that one exists and when it dies", async () => {
    const host = machine();

    await pairInstall(DIR, arm(), host.deps);

    expect(host.lines.join("\n")).toContain(EXPIRES);
    expect(host.lines.join("\n")).toContain("PHOEBE_RELAY_TOKEN written");
  });

  test("the steps stream in the order they happen", async () => {
    const host = machine();

    await pairInstall(DIR, arm(), host.deps);

    const said = host.lines.join("\n");
    expect(said.indexOf("minting")).toBeLessThan(said.indexOf("relay.url"));
    expect(said.indexOf("relay.url")).toBeLessThan(said.indexOf("PHOEBE_RELAY_TOKEN written"));
    expect(said.indexOf("PHOEBE_RELAY_TOKEN written")).toBeLessThan(said.indexOf("nudging"));
  });
});

describe("what it refuses, and what it leaves behind when it does", () => {
  test("a folder with no compose file is not-initialised, and nothing is written", async () => {
    const host = machine();
    const bare = { ...host.deps, exists: (file: string) => file === DIR };

    await expect(pairInstall(DIR, arm(), bare)).rejects.toMatchObject({
      error: { code: "not-initialised" },
    });
    expect(host.written).toEqual({});
  });

  test("a mint that fails leaves the install exactly as it was", async () => {
    const host = machine();
    const refusing = arm({
      mint: () => Promise.reject(new BridgeRefusal({ code: "refused", message: "no" })),
    });

    await expect(pairInstall(DIR, refusing, host.deps)).rejects.toThrow();
    expect(host.written).toEqual({});
    expect(host.composeCalls).toEqual([]);
  });

  test("a hand-written `relay.url` is refused rather than overwritten", async () => {
    const source = `const config = {\n  relay: { url: process.env.RELAY! },\n};\nexport default config;\n`;
    const host = machine({ [CONFIG]: source });

    await expect(pairInstall(DIR, arm(), host.deps)).rejects.toMatchObject({
      error: { code: "refused" },
    });
    expect(host.written[CONFIG]).toBeUndefined();
    // The instruction is the edit to make by hand (#527 §16).
    await pairInstall(DIR, arm(), host.deps).catch((error: unknown) => {
      expect((error as BridgeRefusal).error.instruction).toContain(
        "wss://relay.example.test/deployments",
      );
    });
  });

  test("a Compose that refuses the nudge says the writes already happened", async () => {
    const host = machine();
    const failing = {
      ...host.deps,
      runner: (() =>
        Promise.resolve({ code: 1, stdout: "", stderr: "no daemon" })) as CommandRunner,
    };

    await expect(pairInstall(DIR, arm(), failing)).rejects.toMatchObject({
      error: { code: "refused" },
    });
    expect(host.written[ENV]).toContain(TOKEN);
  });
});

describe("deploymentsUrlFor", () => {
  test("an https relay is dialled over wss, on the deployments path", () => {
    expect(deploymentsUrlFor("https://relay.example.test")).toBe(
      "wss://relay.example.test/deployments",
    );
  });

  test("a trailing slash and a port survive the translation", () => {
    expect(deploymentsUrlFor("https://relay.example.test:8443/")).toBe(
      "wss://relay.example.test:8443/deployments",
    );
  });

  test("a plain http relay — a local one, or a test — becomes ws", () => {
    expect(deploymentsUrlFor("http://localhost:4000")).toBe("ws://localhost:4000/deployments");
  });
});
