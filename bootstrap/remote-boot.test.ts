// The remote wiring (map #690): no block means an id and nothing else; a block
// means a listener, the two drops, and a remote section that learns its URL
// and its counts.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { DEPLOYMENT_ID_RE } from "./deployment-id.ts";
import type { DeploymentState } from "./deployment-state.ts";
import type { DropWatcherDeps } from "./file-drop.ts";
import { createPendingCodes, hashCode } from "./pairing-codes.ts";
import type { RemoteApi } from "./remote-api.ts";
import { parseRevokeAsk, prepareRemote } from "./remote-boot.ts";
import { createSessions } from "./remote-sessions.ts";

const dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "phoebe-remote-boot-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fakeApi(): RemoteApi & { closedStreams: string[]; listened: unknown[] } {
  const closedStreams: string[] = [];
  const listened: unknown[] = [];
  return {
    closedStreams,
    listened,
    handle: () => {},
    listen: async (target) => {
      listened.push(target);
      return { where: "fake" };
    },
    close: async () => {},
    closeStreams: (id) => closedStreams.push(id),
    streams: () => 0,
    rejections: () => ({ count: 0, exhausted: false }),
  };
}

function fakeState(): DeploymentState & { noted: unknown[] } {
  const noted: unknown[] = [];
  return {
    noted,
    noteRemote: (status) => noted.push(status),
    latest: () => null,
    noteEngine: () => {},
    noteReconcile: () => {},
    noteSpawn: () => {},
    noteDraining: () => {},
    noteExit: () => {},
    noteEngineReport: () => {},
    noteDoctor: () => {},
    noteSecrets: () => {},
    notePipelines: () => {},
    noteHolds: () => {},
    publish: () => {},
  };
}

const base = (): Parameters<typeof prepareRemote>[0] => ({
  rootConfig: {},
  dataBase: tmp(),
  name: "acme/widget",
  arm: "solo",
  host: "linux",
  version: "0.15.0",
});

describe("prepareRemote", () => {
  test("with no block: the identity carries a minted id, the section stays unconfigured", async () => {
    const options = base();
    const prepared = prepareRemote(options);
    expect(prepared.identity()).toEqual({
      name: "acme/widget",
      deploymentId: expect.stringMatching(DEPLOYMENT_ID_RE),
      arm: "solo",
      host: "linux",
    });
    expect(prepared.remote).toBeUndefined();
    const state = fakeState();
    await prepared.start(state, {});
    expect(state.noted).toEqual([]);
    expect(prepared.api()).toBeNull();
    // Stable across a second prepare on the same volume.
    expect(prepareRemote(options).identity().deploymentId).toBe(prepared.identity().deploymentId);
  });

  test("a block that will not validate is ignored with a warning", () => {
    const warned: string[] = [];
    const prepared = prepareRemote({
      ...base(),
      rootConfig: { remote: { tailscale: "nope" } },
      warn: (m) => warned.push(m),
    });
    expect(prepared.remote).toBeUndefined();
    expect(warned.join("\n")).toMatch(/ignoring the `remote` block/);
  });

  test("sidecar: listens on the socket, learns the URL from LocalAPI, publishes counts", async () => {
    const api = fakeApi();
    let status: string = JSON.stringify({ BackendState: "Starting", Self: { DNSName: "" } });
    const timers: Array<() => void> = [];
    const sessions = createSessions(tmp());
    const prepared = prepareRemote({
      ...base(),
      rootConfig: { remote: { tailscale: "sidecar" } },
      deps: {
        api: () => api,
        sessions,
        localApi: async () => ({ status: 200, body: status }),
        setInterval: (fn) => {
          timers.push(fn);
          return { clear: () => {} };
        },
        watchDrop: () => ({ scan: () => {}, stop: () => {} }),
      },
    });
    const state = fakeState();
    await prepared.start(state, {});
    expect(api.listened).toEqual([{ arm: "sidecar" }]);
    expect(state.noted.at(-1)).toMatchObject({
      configured: true,
      arm: "sidecar",
      url: null,
      sessions: { active: 0, expired: 0 },
      tampered: false,
    });

    status = JSON.stringify({ BackendState: "Running", Self: { DNSName: "phoebe.tail1.ts.net." } });
    sessions.issue(
      { scopes: ["read"], label: "x", deviceType: "desktop", os: "?", pairedAs: null },
      new Date(),
    );
    for (const tick of timers) tick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(state.noted.at(-1)).toMatchObject({
      url: "https://phoebe.tail1.ts.net",
      sessions: { active: 1, expired: 0 },
    });
    await prepared.stop();
  });

  test("host: listens on loopback and reads the URL the host wrote", async () => {
    const api = fakeApi();
    let written: string | null = null;
    const timers: Array<() => void> = [];
    const prepared = prepareRemote({
      ...base(),
      rootConfig: { remote: { tailscale: "host", port: 9000 } },
      deps: {
        api: () => api,
        readHostUrl: () => written,
        setInterval: (fn) => {
          timers.push(fn);
          return { clear: () => {} };
        },
        watchDrop: () => ({ scan: () => {}, stop: () => {} }),
      },
    });
    const state = fakeState();
    await prepared.start(state, {});
    expect(api.listened).toEqual([{ arm: "host" }]);
    written = "https://beast.tail1.ts.net";
    for (const tick of timers) tick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(state.noted.at(-1)).toMatchObject({ arm: "host", url: "https://beast.tail1.ts.net" });
    await prepared.stop();
  });

  test("the mint drop is root-only and feeds the pending map; the revoke drop writes the store", async () => {
    const api = fakeApi();
    const pending = createPendingCodes();
    const sessions = createSessions(tmp());
    const watchers: DropWatcherDeps[] = [];
    const prepared = prepareRemote({
      ...base(),
      rootConfig: { remote: { tailscale: "host" } },
      deps: {
        api: () => api,
        pending,
        sessions,
        readHostUrl: () => null,
        setInterval: () => ({ clear: () => {} }),
        watchDrop: (deps) => {
          watchers.push(deps);
          return { scan: () => {}, stop: () => {} };
        },
      },
    });
    const state = fakeState();
    await prepared.start(state, {});
    const [mint, revoke] = watchers;
    expect(mint!.requireUid).toBe(0);
    expect(revoke!.requireUid).toBeUndefined();

    const now = Date.now();
    const ack = mint!.onFile({
      name: "n1.json",
      uid: 0,
      content: JSON.stringify({
        nonce: "n1n1n1n1",
        hash: hashCode("ABCDEFGHJK12"),
        scopes: ["read"],
        expiresAt: new Date(now + 60_000).toISOString(),
      }),
    });
    expect(ack).toBe("ok");
    expect(pending.spend(hashCode("ABCDEFGHJK12"), now)).toEqual({ scopes: ["read"] });
    expect(() => mint!.onFile({ name: "n2.json", uid: 0, content: "garbage" })).toThrow(
      /not a pending code/,
    );

    const { row } = sessions.issue(
      { scopes: ["read"], label: "x", deviceType: "desktop", os: "?", pairedAs: null },
      new Date(now),
    );
    expect(
      revoke!.onFile({ name: "r1.json", uid: 10001, content: JSON.stringify({ id: row.id }) }),
    ).toBe("ok 1");
    expect(api.closedStreams).toEqual([row.id]);
    expect(sessions.list(new Date(now))).toEqual([]);
    expect(
      revoke!.onFile({ name: "r2.json", uid: 10001, content: JSON.stringify({ id: "nope" }) }),
    ).toBe("ok 0");
    expect(() => revoke!.onFile({ name: "r3.json", uid: 10001, content: "{}" })).toThrow(
      /not a revoke request/,
    );
    await prepared.stop();
  });

  test("push wakes every stream listener", () => {
    const prepared = prepareRemote(base());
    expect(() => prepared.push()).not.toThrow();
  });

  test("parseRevokeAsk reads the two shapes", () => {
    expect(parseRevokeAsk('{"all":true}')).toEqual({ all: true });
    expect(parseRevokeAsk('{"id":"abc"}')).toEqual({ all: false, id: "abc" });
    expect(parseRevokeAsk("nope")).toBeNull();
  });
});
