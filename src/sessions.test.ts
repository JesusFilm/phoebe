// `phoebe sessions` (map #690, #696): list and revoke through the drop in the
// container, the uid 10001 exec on the host, the deployment-block refusal, and
// the --json shape.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { createSessions } from "../bootstrap/remote-sessions.ts";
import type { CommandResult, CommandRunner } from "./deployment-compose.ts";
import {
  formatSessions,
  parseSessionsArgs,
  runSessions,
  runSessionsInContainer,
} from "./sessions.ts";

const dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "phoebe-sessions-verb-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const T0 = Date.parse("2026-10-16T12:00:00.000Z");

describe("parseSessionsArgs", () => {
  test("list by default, revoke by id or --all, json", () => {
    expect(parseSessionsArgs([])).toEqual({ help: false, json: false, action: { action: "list" } });
    expect(parseSessionsArgs(["list", "--json"])).toEqual({
      help: false,
      json: true,
      action: { action: "list" },
    });
    expect(parseSessionsArgs(["revoke", "abc"])).toEqual({
      help: false,
      json: false,
      action: { action: "revoke", id: "abc" },
    });
    expect(parseSessionsArgs(["revoke", "--all"])).toEqual({
      help: false,
      json: false,
      action: { action: "revoke", all: true },
    });
    expect(() => parseSessionsArgs(["revoke"])).toThrow(/Usage/);
    expect(() => parseSessionsArgs(["revoke", "a", "--all"])).toThrow(/Usage/);
    expect(() => parseSessionsArgs(["frob"])).toThrow(/Unknown subcommand/);
  });
});

describe("in the container", () => {
  test("list reads the store and writes nothing", async () => {
    const base = tmp();
    const store = createSessions(base);
    store.issue(
      { scopes: ["read"], label: "lap", deviceType: "desktop", os: "macOS", pairedAs: null },
      new Date(T0),
    );
    const outcome = await runSessionsInContainer(
      { action: "list" },
      { cwd: "/", env: { PHOEBE_DATA_DIR: base }, now: () => T0 },
    );
    expect(outcome.sessions).toHaveLength(1);
    expect(outcome.revoked).toBe(0);
    expect(outcome.at).toBe(new Date(T0).toISOString());
    expect(JSON.stringify(outcome)).not.toContain("tokenHash");
  });

  test("revoke asks through the drop and reads the count back; an unknown id is named", async () => {
    const base = tmp();
    const store = createSessions(base);
    const { row } = store.issue(
      { scopes: ["read"], label: "lap", deviceType: "desktop", os: "macOS", pairedAs: null },
      new Date(T0),
    );
    const asks: string[] = [];
    const outcome = await runSessionsInContainer(
      { action: "revoke", id: row.id },
      {
        cwd: "/",
        env: { PHOEBE_DATA_DIR: base },
        now: () => T0,
        ask: async (_nonce, content) => {
          asks.push(content);
          // The bootstrapper carried it out.
          store.revoke(row.id);
          return { kind: "ok", detail: "1" };
        },
      },
    );
    expect(asks).toEqual([JSON.stringify({ id: row.id })]);
    expect(outcome).toMatchObject({ revoked: 1, sessions: [] });

    await expect(
      runSessionsInContainer(
        { action: "revoke", id: "nope" },
        {
          cwd: "/",
          env: { PHOEBE_DATA_DIR: base },
          ask: async () => ({ kind: "ok", detail: "0" }),
        },
      ),
    ).rejects.toThrow(/no session has the id nope/);
    await expect(
      runSessionsInContainer(
        { action: "revoke", all: true },
        { cwd: "/", env: { PHOEBE_DATA_DIR: base }, ask: async () => ({ kind: "unanswered" }) },
      ),
    ).rejects.toThrow(/did not carry the revoke out within 5 s/);
    const all = await runSessionsInContainer(
      { action: "revoke", all: true },
      {
        cwd: "/",
        env: { PHOEBE_DATA_DIR: base },
        ask: async (_n, content) =>
          JSON.parse(content).all === true
            ? { kind: "ok", detail: "3" }
            : { kind: "refused", detail: "?" },
      },
    );
    expect(all.revoked).toBe(3);
  });
});

describe("on the host", () => {
  const exists = (path: string): boolean =>
    path.endsWith("compose.yml") || path.endsWith("phoebe.config.ts");
  const ps = (state: string): CommandResult => ({
    code: 0,
    stdout: `${JSON.stringify({ Service: "phoebe", State: state })}\n`,
    stderr: "",
  });
  function scripted(script: CommandResult[]) {
    const calls: Array<readonly string[]> = [];
    let i = 0;
    const runner: CommandRunner = async (spec) => {
      calls.push(spec.args);
      const next = script[i++];
      if (next === undefined) throw new Error("unexpected");
      return next;
    };
    return { runner, calls };
  }

  test("execs as uid 10001 — never -u root — with --json, and refuses under a deployment block", async () => {
    const outcome = { sessions: [], revoked: 1, at: new Date(T0).toISOString() };
    const { runner, calls } = scripted([
      ps("running"),
      { code: 0, stdout: `${JSON.stringify(outcome)}\n`, stderr: "" },
    ]);
    const result = await runSessions({
      action: { action: "revoke", id: "abc" },
      deps: {
        cwd: "/deploy",
        inContainer: false,
        dockerAvailable: true,
        exists,
        runner,
        remote: { arm: "sidecar" },
      },
    });
    expect(result).toEqual(outcome);
    expect(calls[1]!.join(" ")).toContain("exec -T phoebe phoebe sessions revoke abc --json");
    expect(calls[1]).not.toContain("root");
    await expect(
      runSessions({
        action: { action: "list" },
        deps: {
          cwd: "/deploy",
          inContainer: false,
          deploymentCommands: { startCommand: "x", stopCommand: "y" },
        },
      }),
    ).rejects.toThrow(/docker exec <container> phoebe sessions/);
  });
});

describe("the printer", () => {
  test("rows with their facts, expired marked, and the revoke count", () => {
    const text = formatSessions({
      revoked: 1,
      at: new Date(T0).toISOString(),
      sessions: [
        {
          id: "s1",
          scopes: ["read", "operate"],
          label: "lap",
          deviceType: "desktop",
          os: "macOS",
          pairedAs: "me@x",
          issuedAt: "",
          expiresAt: new Date(T0 + 86_400_000).toISOString(),
          lastSeenAt: new Date(T0 - 60_000).toISOString(),
        },
        {
          id: "s2",
          scopes: ["read"],
          label: "phone",
          deviceType: "mobile",
          os: "iOS",
          pairedAs: null,
          issuedAt: "",
          expiresAt: new Date(T0 - 1).toISOString(),
          lastSeenAt: new Date(T0 - 3_600_000).toISOString(),
        },
      ],
    });
    expect(text).toContain("revoked 1 session.");
    expect(text).toContain("2 sessions:");
    expect(text).toContain(
      "s1  lap (desktop, macOS)  me@x  read+operate  last seen 1m ago  expires in 1d",
    );
    expect(text).toContain("s2  phone (mobile, iOS)  read  last seen 1h ago  expired");
    expect(formatSessions({ revoked: 0, at: new Date(T0).toISOString(), sessions: [] })).toBe(
      "[phoebe] no devices paired.",
    );
  });
});
