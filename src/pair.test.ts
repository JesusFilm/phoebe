// `phoebe pair` (map #690, #695): the in-container gate and mint against a fake
// drop, the host's four refusals and the Serve-first order, the printer, and
// the code appearing nowhere but the outcome.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { deploymentReportPath } from "../bootstrap/deployment-report.ts";
import { hashCode, normalizeCode } from "../bootstrap/pairing-codes.ts";
import type { CommandResult, CommandRunner } from "./deployment-compose.ts";
import {
  formatPairOutcome,
  pairingLink,
  parsePairArgs,
  runPair,
  runPairInContainer,
} from "./pair.ts";

const dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "phoebe-pair-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function withReport(base: string, remote: Record<string, unknown> | null): void {
  mkdirSync(join(base, "state"), { recursive: true });
  const report = {
    schema: 1,
    identity: { name: "acme/widget", arm: "solo", deploymentId: "dep_0123456789ABCDEFGHJKMNPQRS" },
    ...(remote === null ? {} : { remote }),
  };
  writeFileSync(deploymentReportPath(base), JSON.stringify(report));
}

const SIDECAR_UP = {
  configured: true,
  arm: "sidecar",
  url: "https://phoebe.tail1.ts.net",
  sessions: { active: 0, expired: 0 },
  tampered: false,
  updatedAt: "x",
};

describe("parsePairArgs", () => {
  test("flags", () => {
    expect(parsePairArgs([])).toEqual({ help: false, operate: false, json: false });
    expect(parsePairArgs(["--operate", "--json"])).toEqual({
      help: false,
      operate: true,
      json: true,
    });
    expect(() => parsePairArgs(["--read"])).toThrow(/Unknown flag/);
  });
});

describe("in the container", () => {
  test("refuses as uid 10001, and when boot is not PID 1's main process", async () => {
    const base = tmp();
    withReport(base, SIDECAR_UP);
    await expect(
      runPairInContainer(
        { operate: false },
        { cwd: "/", uid: 10001, bootAlive: true, env: { PHOEBE_DATA_DIR: base } },
      ),
    ).rejects.toThrow(/only as root/);
    await expect(
      runPairInContainer(
        { operate: false },
        { cwd: "/", uid: 0, bootAlive: false, env: { PHOEBE_DATA_DIR: base } },
      ),
    ).rejects.toThrow(/not this container's main process/);
  });

  test("refuses with no block, and while the sidecar has no URL", async () => {
    const base = tmp();
    withReport(base, { ...SIDECAR_UP, configured: false, arm: null, url: null });
    await expect(
      runPairInContainer(
        { operate: false },
        { cwd: "/", uid: 0, bootAlive: true, env: { PHOEBE_DATA_DIR: base } },
      ),
    ).rejects.toThrow(/no `remote` block/);
    withReport(base, { ...SIDECAR_UP, url: null });
    await expect(
      runPairInContainer(
        { operate: false },
        { cwd: "/", uid: 0, bootAlive: true, env: { PHOEBE_DATA_DIR: base } },
      ),
    ).rejects.toThrow(/has not joined the tailnet/);
    withReport(base, { ...SIDECAR_UP, arm: "host", url: null });
    await expect(
      runPairInContainer(
        { operate: false },
        { cwd: "/", uid: 0, bootAlive: true, env: { PHOEBE_DATA_DIR: base } },
      ),
    ).rejects.toThrow(/run `phoebe start` on the host/);
  });

  test("mints: the drop carries the hash and never the code, the ack returns the outcome", async () => {
    const base = tmp();
    withReport(base, SIDECAR_UP);
    const dropped: Array<{ nonce: string; content: string }> = [];
    const now = Date.parse("2026-10-16T12:00:00.000Z");
    const outcome = await runPairInContainer(
      { operate: true },
      {
        cwd: "/",
        uid: 0,
        bootAlive: true,
        env: { PHOEBE_DATA_DIR: base },
        now: () => now,
        ask: async (nonce, content) => {
          dropped.push({ nonce, content });
          return { kind: "ok", detail: "" };
        },
      },
    );
    expect(outcome.code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    expect(outcome.url).toBe(`https://phoebe.tail1.ts.net/pair#code=${outcome.code}`);
    expect(outcome.scopes).toEqual(["read", "operate"]);
    expect(outcome.expiresAt).toBe(new Date(now + 5 * 60_000).toISOString());
    expect(outcome.deploymentId).toBe("dep_0123456789ABCDEFGHJKMNPQRS");
    const file = JSON.parse(dropped[0]!.content) as {
      nonce: string;
      hash: string;
      scopes: string[];
    };
    expect(file.hash).toBe(hashCode(normalizeCode(outcome.code)!));
    expect(dropped[0]!.content).not.toContain(outcome.code);
    expect(dropped[0]!.content).not.toContain(outcome.code.replace(/-/g, ""));
  });

  test("no ack in 5 s names phoebe boot; a refused ack carries the reason", async () => {
    const base = tmp();
    withReport(base, SIDECAR_UP);
    const deps = { cwd: "/", uid: 0, bootAlive: true, env: { PHOEBE_DATA_DIR: base } };
    await expect(
      runPairInContainer(
        { operate: false },
        { ...deps, ask: async () => ({ kind: "unanswered" }) },
      ),
    ).rejects.toThrow(/did not pick the code up within 5 s.*phoebe boot/);
    await expect(
      runPairInContainer(
        { operate: false },
        {
          ...deps,
          ask: async () => ({ kind: "refused", detail: "already holds 8 pending codes" }),
        },
      ),
    ).rejects.toThrow(/refused the code: already holds 8/);
  });
});

function scriptedRunner(
  script: Array<CommandResult | ((args: readonly string[]) => CommandResult)>,
) {
  const calls: Array<{ args: readonly string[] }> = [];
  let i = 0;
  const runner: CommandRunner = async (spec) => {
    calls.push({ args: spec.args });
    const next = script[i++];
    if (next === undefined) throw new Error(`unexpected: docker ${spec.args.join(" ")}`);
    return typeof next === "function" ? next(spec.args) : next;
  };
  return { runner, calls };
}
const ps = (state: string): CommandResult => ({
  code: 0,
  stdout: `${JSON.stringify({ Service: "phoebe", State: state })}\n`,
  stderr: "",
});
const exists = (path: string): boolean =>
  path.endsWith("compose.yml") || path.endsWith("phoebe.config.ts");
const OUTCOME = {
  url: "https://beast.ts.net/pair#code=AAAA-BBBB-CCCC",
  code: "AAAA-BBBB-CCCC",
  expiresAt: "2026-10-16T12:05:00.000Z",
  scopes: ["read" as const],
  deploymentId: "dep_X",
};

describe("on the host", () => {
  test("refuses with no block, naming the block and the overlays", async () => {
    await expect(
      runPair({
        operate: false,
        deps: { cwd: "/deploy", inContainer: false, dockerAvailable: true, exists },
      }),
    ).rejects.toThrow(/no `remote` block.*phoebe init/);
  });

  test("refuses under a deployment block with the exact docker exec line", async () => {
    await expect(
      runPair({
        operate: true,
        deps: {
          cwd: "/deploy",
          inContainer: false,
          deploymentCommands: { startCommand: "x", stopCommand: "y" },
          remote: { arm: "sidecar" },
        },
      }),
    ).rejects.toThrow(/docker exec -u root <container> phoebe pair --operate/);
  });

  test("refuses when the container is not running", async () => {
    const { runner } = scriptedRunner([ps("exited")]);
    await expect(
      runPair({
        operate: false,
        deps: {
          cwd: "/deploy",
          inContainer: false,
          dockerAvailable: true,
          exists,
          runner,
          remote: { arm: "sidecar" },
        },
      }),
    ).rejects.toThrow(/container not running/);
  });

  test("sidecar: execs the root half with --json and hands the outcome back; lines say 'code minted'", async () => {
    const { runner, calls } = scriptedRunner([
      ps("running"),
      { code: 0, stdout: `[phoebe] something\n${JSON.stringify(OUTCOME)}\n`, stderr: "" },
    ]);
    const out: string[] = [];
    const outcome = await runPair({
      operate: true,
      deps: {
        cwd: "/deploy",
        inContainer: false,
        dockerAvailable: true,
        exists,
        runner,
        remote: { arm: "sidecar" },
        io: { stdout: (line) => out.push(line) },
      },
    });
    expect(outcome).toEqual(OUTCOME);
    expect(calls[1]!.args.join(" ")).toContain(
      "exec -T -u root phoebe phoebe pair --operate --json",
    );
    expect(calls[1]!.args).toContain("--json");
    expect(calls[1]!.args).toContain("/deploy/container/compose.tailscale-sidecar.yml");
    expect(out.join("\n")).toContain("code minted");
    expect(out.join("\n")).not.toContain("AAAA-BBBB-CCCC");
  });

  test("host arm: Serve first, refusing on its refusal; otherwise the URL is handed over before the exec", async () => {
    const refused = scriptedRunner([ps("running")]);
    await expect(
      runPair({
        operate: false,
        deps: {
          cwd: "/deploy",
          inContainer: false,
          dockerAvailable: true,
          exists,
          runner: refused.runner,
          remote: { arm: "host", port: 7463, httpsPort: 443 },
          serve: async () => ({ state: "refused", detail: "Tailscale is Stopped" }),
        },
      }),
    ).rejects.toThrow(/Serve is not serving this deployment: Tailscale is Stopped/);

    const { runner, calls } = scriptedRunner([
      ps("running"),
      { code: 0, stdout: "", stderr: "" },
      { code: 0, stdout: `${JSON.stringify(OUTCOME)}\n`, stderr: "" },
    ]);
    const outcome = await runPair({
      operate: false,
      deps: {
        cwd: "/deploy",
        inContainer: false,
        dockerAvailable: true,
        exists,
        runner,
        remote: { arm: "host", port: 7463, httpsPort: 443 },
        serve: async () => ({ state: "ready", url: "https://beast.ts.net" }),
      },
    });
    expect(outcome).toEqual(OUTCOME);
    expect(calls[1]!.args.slice(-6)).toEqual([
      "exec",
      "-T",
      "phoebe",
      "phoebe",
      "remote-url",
      "https://beast.ts.net",
    ]);
    expect(calls[2]!.args).toContain("-u");
  });

  test("the in-container half's refusal comes through as this verb's error", async () => {
    const { runner } = scriptedRunner([
      ps("running"),
      { code: 1, stdout: "", stderr: "[phoebe] the sidecar has not joined the tailnet yet\n" },
    ]);
    await expect(
      runPair({
        operate: false,
        deps: {
          cwd: "/deploy",
          inContainer: false,
          dockerAvailable: true,
          exists,
          runner,
          remote: { arm: "sidecar" },
        },
      }),
    ).rejects.toThrow(/^the sidecar has not joined the tailnet yet$/);
  });
});

describe("the printer", () => {
  test("the link, the code alone, the scopes, and until when", () => {
    const text = formatPairOutcome({
      ...OUTCOME,
      expiresAt: new Date(2026, 9, 16, 12, 5).toISOString(),
    });
    expect(text.split("\n")[0]).toBe("https://beast.ts.net/pair#code=AAAA-BBBB-CCCC");
    expect(text).toContain("code    AAAA-BBBB-CCCC");
    expect(text).toContain("scopes  read");
    expect(text).toContain("spendable for 5 minutes, until 12:05");
    expect(pairingLink("https://x.ts.net:8443", "AAAA-BBBB-CCCC")).toBe(
      "https://x.ts.net:8443/pair#code=AAAA-BBBB-CCCC",
    );
  });
});
