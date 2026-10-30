// The remote arm (map #690): pair reads the descriptor first and never hands
// the bearer out, request adds it, sign out deletes then drops, forget drops
// without a request, and pair again keeps what #699 says it keeps.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import type { RemoteAlertEvent, RemoteRecord, RemoteReportEvent } from "phoebe-agent/contracts";
import { createCompanionAlerts } from "./alerting.ts";
import { createRemoteArm, originOf, osLabel } from "./remote-arm.ts";
import { createRemoteStore } from "./remotes.ts";
import { REMOTES_FILE } from "./remotes.ts";
import type { SafeStorageLike } from "./vault.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const KEYRING: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from(plain, "utf8"),
  decryptString: (cipher) => cipher.toString("utf8"),
};

const URL_ = "https://phoebe.tail1.ts.net";
const DESCRIPTOR = {
  deploymentId: "dep_A",
  name: "acme/widget",
  protocol: 1,
  version: "0.15.0",
  arm: "sidecar",
};

type Call = { path: string; method: string; headers: Record<string, string>; body: unknown };

function harness(
  opts: {
    descriptor?: { status: number; body?: unknown } | Error;
    pair?: { status: number; body?: unknown };
    answers?: Record<string, { status: number; body?: unknown }>;
    tailscale?: { running: boolean; detail: string } | null;
  } = {},
) {
  const userDataDir = mkdtempSync(join(tmpdir(), "phoebe-arm-"));
  dirs.push(userDataDir);
  const calls: Call[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = url.slice(URL_.length);
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    calls.push({
      path,
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    const answer =
      path === "/.well-known/phoebe/deployment"
        ? (opts.descriptor ?? { status: 200, body: DESCRIPTOR })
        : path === "/api/pair"
          ? (opts.pair ?? {
              status: 200,
              body: {
                token: "the-bearer",
                expiresAt: "2026-11-15T00:00:00.000Z",
                scopes: ["read"],
                deploymentId: "dep_A",
              },
            })
          : path === "/api/session" && (init?.method ?? "GET") === "GET"
            ? {
                status: 200,
                body: { id: "sess_1", label: "x", scopes: ["read"], issuedAt: "", expiresAt: "" },
              }
            : path === "/api/events"
              ? { status: 503 }
              : (opts.answers?.[`${init?.method ?? "GET"} ${path}`] ?? { status: 204 });
    if (answer instanceof Error) throw answer;
    return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), {
      status: answer.status,
    });
  }) as typeof fetch;
  const changed: RemoteRecord[][] = [];
  const reports: RemoteReportEvent[] = [];
  const alertsOut: RemoteAlertEvent[] = [];
  const arm = createRemoteArm({
    userDataDir,
    safeStorage: KEYRING,
    fetchFn,
    alerts: createCompanionAlerts(),
    emit: {
      changed: (records) => changed.push(records),
      report: (event) => reports.push(event),
      alert: (event) => alertsOut.push(event),
    },
    tailscaleStatus: async () => opts.tailscale ?? { running: true, detail: "Running" },
    os: "macOS",
    now: () => 1_700_000_000_000,
    // Timers never fire: the supervisor's one attempt is enough here.
    setTimer: () => ({}),
    clearTimer: () => {},
  });
  const store = createRemoteStore({ path: join(userDataDir, REMOTES_FILE) });
  return { arm, calls, changed, reports, store, userDataDir };
}

describe("pair", () => {
  test("reads the descriptor, spends the code, stores the record, and never answers the bearer", async () => {
    const h = harness();
    const result = await h.arm.pair({
      url: `${URL_}/pair`,
      code: "ABCD-EFGH-JK12",
      label: "Mike's MacBook",
    });
    expect(result.outcome).toBe("paired");
    expect(JSON.stringify(result)).not.toContain("the-bearer");
    expect(h.calls.slice(0, 2).map((call) => call.path)).toEqual([
      "/.well-known/phoebe/deployment",
      "/api/pair",
    ]);
    expect(h.calls[1]!.body).toEqual({
      code: "ABCD-EFGH-JK12",
      client: { label: "Mike's MacBook", deviceType: "desktop", os: "macOS" },
    });
    const stored = h.store.get("dep_A")!;
    expect(stored).toMatchObject({
      url: URL_,
      name: "acme/widget",
      label: "Mike's MacBook",
      arm: "sidecar",
      scopes: ["read"],
      sessionId: "sess_1",
    });
    expect(JSON.stringify(stored)).not.toContain("the-bearer");
    expect(h.changed.at(-1)?.map((record) => record.deploymentId)).toEqual(["dep_A"]);
  });

  test("the four failures, each its own word", async () => {
    expect(
      (
        await harness({ descriptor: new Error("ECONNREFUSED") }).arm.pair({
          url: URL_,
          code: "x",
          label: "l",
        })
      ).outcome,
    ).toBe("unreachable");
    expect(
      (
        await harness({
          descriptor: new Error("ECONNREFUSED"),
          tailscale: { running: false, detail: "Stopped" },
        }).arm.pair({ url: URL_, code: "x", label: "l" })
      ).outcome,
    ).toBe("tailscale-off");
    expect(
      (
        await harness({ descriptor: { status: 200, body: { hello: "world" } } }).arm.pair({
          url: URL_,
          code: "x",
          label: "l",
        })
      ).outcome,
    ).toBe("not-phoebe");
    expect(
      (
        await harness({ descriptor: { status: 404 } }).arm.pair({
          url: URL_,
          code: "x",
          label: "l",
        })
      ).outcome,
    ).toBe("not-phoebe");
    expect(
      (
        await harness({
          descriptor: { status: 200, body: { ...DESCRIPTOR, protocol: 2 } },
        }).arm.pair({ url: URL_, code: "x", label: "l" })
      ).outcome,
    ).toBe("protocol");
    expect(
      (
        await harness({ pair: { status: 400, body: { error: "code-rejected" } } }).arm.pair({
          url: URL_,
          code: "x",
          label: "l",
        })
      ).outcome,
    ).toBe("code-rejected");
    expect((await harness().arm.pair({ url: "not a url", code: "x", label: "l" })).outcome).toBe(
      "unreachable",
    );
  });

  test("pair again keeps the label, the last report and the notified map, and moves the bearer", async () => {
    const h = harness();
    await h.arm.pair({ url: URL_, code: "x", label: "first label" });
    h.store.patch("dep_A", {
      lastReport: { schema: 1, receivedAt: "then", report: { schema: 1 } },
      notified: { "wedged:acme/work": { state: "raised", at: "then", since: "then" } },
      seeded: true,
    });
    const again = await h.arm.pair({ url: URL_, code: "y", label: "second label" });
    expect(again.outcome).toBe("paired");
    const stored = h.store.get("dep_A")!;
    expect(stored.label).toBe("first label");
    expect(stored.lastReport?.receivedAt).toBe("then");
    expect(stored.notified).toEqual({
      "wedged:acme/work": { state: "raised", at: "then", since: "then" },
    });
    expect(h.store.list()).toHaveLength(1);
  });

  test("pair again ends the old session with the old bearer, then moves to the new one", async () => {
    const h = harness();
    await h.arm.pair({ url: URL_, code: "x", label: "l" });
    h.calls.length = 0;
    await h.arm.pair({ url: URL_, code: "y", label: "l" });
    const signOut = h.calls.find((c) => c.method === "DELETE" && c.path === "/api/session");
    expect(signOut).toBeDefined();
    expect(signOut!.headers["authorization"]).toBe("Bearer the-bearer");
    expect(h.calls.indexOf(signOut!)).toBeGreaterThan(
      h.calls.findIndex((c) => c.path === "/api/pair"),
    );
  });

  test("a failed pair again leaves the old session alone", async () => {
    const opts: Parameters<typeof harness>[0] = {};
    const h = harness(opts);
    await h.arm.pair({ url: URL_, code: "x", label: "l" });
    h.calls.length = 0;
    opts.pair = { status: 400, body: { error: "bad-code" } };
    expect((await h.arm.pair({ url: URL_, code: "bad", label: "l" })).outcome).not.toBe("paired");
    expect(h.calls.some((c) => c.method === "DELETE")).toBe(false);
    expect(h.store.get("dep_A")).not.toBeNull();
  });
});

describe("requests with the bearer", () => {
  test("request adds the bearer in main; the window never sees it", async () => {
    const h = harness({
      answers: { "POST /api/doctor-run": { status: 200, body: { outcome: "started" } } },
    });
    await h.arm.pair({ url: URL_, code: "x", label: "l" });
    const answer = await h.arm.request("dep_A", {
      method: "POST",
      path: "/api/doctor-run",
      body: {},
    });
    expect(answer).toEqual({ status: 200, body: { outcome: "started" } });
    expect(h.calls.at(-1)?.headers["authorization"]).toBe("Bearer the-bearer");
    await expect(h.arm.request("dep_nope", { method: "GET", path: "/api/report" })).rejects.toThrow(
      /not a remote/,
    );
  });

  test("sessions and revoke map the deployment's answers", async () => {
    const rows = [
      {
        id: "sess_1",
        scopes: ["read"],
        label: "x",
        deviceType: "desktop",
        os: "?",
        pairedAs: null,
        issuedAt: "",
        expiresAt: "",
        lastSeenAt: "",
      },
    ];
    const h = harness({
      answers: {
        "GET /api/sessions": { status: 200, body: { sessions: rows, self: "sess_1" } },
        "DELETE /api/sessions/sess_1": { status: 409, body: { error: "revoke-self" } },
        "DELETE /api/sessions/sess_2": { status: 204 },
        "DELETE /api/sessions/nope": { status: 404 },
      },
    });
    await h.arm.pair({ url: URL_, code: "x", label: "l" });
    expect(await h.arm.sessions("dep_A")).toEqual(rows);
    expect(await h.arm.revoke("dep_A", "sess_1")).toEqual({ outcome: "revoke-self" });
    expect(await h.arm.revoke("dep_A", "sess_2")).toEqual({ outcome: "revoked" });
    expect(await h.arm.revoke("dep_A", "nope")).toEqual({ outcome: "not-found" });
    const readOnly = harness({
      answers: { "GET /api/sessions": { status: 403 }, "DELETE /api/sessions/s": { status: 403 } },
    });
    await readOnly.arm.pair({ url: URL_, code: "x", label: "l" });
    await expect(readOnly.arm.sessions("dep_A")).rejects.toThrow(/needs operate/);
    expect(await readOnly.arm.revoke("dep_A", "s")).toEqual({ outcome: "needs-operate" });
  });
});

describe("sign out and forget", () => {
  test("sign out deletes the session, then drops the record and the bearer", async () => {
    const h = harness();
    await h.arm.pair({ url: URL_, code: "x", label: "l" });
    await h.arm.signOut("dep_A");
    expect(h.calls.at(-1)).toMatchObject({
      method: "DELETE",
      path: "/api/session",
      headers: { authorization: "Bearer the-bearer" },
    });
    expect(h.store.list()).toEqual([]);
    expect(h.arm.list()).toEqual([]);
    await expect(h.arm.request("dep_A", { method: "GET", path: "/api/report" })).rejects.toThrow(
      /not a remote/,
    );
  });

  test("forget drops the record without a request", async () => {
    const h = harness();
    await h.arm.pair({ url: URL_, code: "x", label: "l" });
    const before = h.calls.length;
    await h.arm.forget("dep_A");
    expect(h.calls.length).toBe(before);
    expect(h.store.list()).toEqual([]);
  });
});

describe("helpers", () => {
  test("originOf trims a pairing link to the deployment's origin", () => {
    expect(originOf("https://x.ts.net/pair#code=AAAA")).toBe("https://x.ts.net");
    expect(originOf("https://x.ts.net:8443")).toBe("https://x.ts.net:8443");
    expect(originOf("ftp://x")).toBeNull();
    expect(originOf("nope")).toBeNull();
  });

  test("the tailscale check is cached for a minute", async () => {
    let asked = 0;
    const userDataDir = mkdtempSync(join(tmpdir(), "phoebe-arm-"));
    dirs.push(userDataDir);
    let now = 0;
    const arm = createRemoteArm({
      userDataDir,
      safeStorage: KEYRING,
      fetchFn: fetch,
      alerts: createCompanionAlerts(),
      emit: { changed: () => {}, report: () => {}, alert: () => {} },
      tailscaleStatus: async () => {
        asked += 1;
        return { running: true, detail: "Running" };
      },
      now: () => now,
    });
    await arm.tailscale();
    await arm.tailscale();
    expect(asked).toBe(1);
    now += 61_000;
    await arm.tailscale();
    expect(asked).toBe(2);
    expect(osLabel("darwin")).toBe("macOS");
  });
});
