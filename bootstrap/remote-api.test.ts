// The deployment API (map #690; #694, #696, #698) against a real loopback
// listener on an ephemeral port: the descriptor and the plain-text landings,
// the bearer gate's answers, the pair exchange and its budget, the stream, the
// body cap, the operate handlers and who they say `by` is.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import type { DeploymentReport } from "../src/contracts/deployment.ts";
import { CODE_LIFETIME_MS, createPendingCodes, hashCode } from "./pairing-codes.ts";
import {
  byOf,
  createRemoteApi,
  landingLine,
  MAX_BODY_BYTES,
  MAX_STREAMS,
  PAIR_REJECTION_BUDGET,
  parseConfigSet,
  STREAM_KEEPALIVE_MS,
  type RemoteApi,
  type RemoteVerbs,
} from "./remote-api.ts";
import { createSessions } from "./remote-sessions.ts";

const dirs: string[] = [];
const apis: RemoteApi[] = [];
afterEach(async () => {
  for (const api of apis.splice(0)) await api.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const T0 = Date.parse("2026-10-16T12:00:00.000Z");

function report(stamp = "a"): DeploymentReport {
  return {
    schema: 1,
    identity: { name: "acme/widget", arm: "solo", deploymentId: "dep_X" },
    updatedAt: stamp,
  } as unknown as DeploymentReport;
}

type Harness = {
  base: string;
  api: RemoteApi;
  url: string;
  clock: { now: number };
  reports: { current: DeploymentReport | null; listeners: Set<() => void> };
  logged: string[];
  pending: ReturnType<typeof createPendingCodes>;
  sessions: ReturnType<typeof createSessions>;
  calls: Record<string, unknown[]>;
};

async function harness(
  opts: { verbs?: RemoteVerbs; keepAliveMs?: number; maxStreams?: number } = {},
): Promise<Harness> {
  const base = mkdtempSync(join(tmpdir(), "phoebe-api-"));
  dirs.push(base);
  const clock = { now: T0 };
  const reports = {
    current: report() as DeploymentReport | null,
    listeners: new Set<() => void>(),
  };
  const logged: string[] = [];
  const pending = createPendingCodes();
  const sessions = createSessions(base);
  const calls: Record<string, unknown[]> = {};
  const api = createRemoteApi({
    descriptor: () => ({
      deploymentId: "dep_X",
      name: "acme/widget",
      protocol: 1,
      version: "0.15.0",
      arm: "host",
    }),
    sessions,
    pending,
    report: () => ({ report: reports.current, builtAt: "2026-10-16T11:59:00.000Z" }),
    onReport: (listener) => {
      reports.listeners.add(listener);
      return () => reports.listeners.delete(listener);
    },
    verbs: opts.verbs ?? {},
    now: () => clock.now,
    log: (line) => logged.push(line),
    newId: () => "req_1",
    ...(opts.keepAliveMs !== undefined ? { keepAliveMs: opts.keepAliveMs } : {}),
    ...(opts.maxStreams !== undefined ? { maxStreams: opts.maxStreams } : {}),
  });
  apis.push(api);
  const { where } = await api.listen({ arm: "host", port: 0 });
  // Bound on every interface so Docker's published port reaches it; reached
  // here over loopback, as the overlay publishes it.
  expect(where).toMatch(/^0\.0\.0\.0:\d+$/);
  const url = `http://127.0.0.1:${where.split(":")[1]}`;
  return { base, api, url, clock, reports, logged, pending, sessions, calls };
}

function mint(h: Harness, code: string, scopes: ("read" | "operate")[] = ["read"]): void {
  h.pending.add(
    {
      nonce: `n-${code}`,
      hash: hashCode(code),
      scopes,
      expiresAt: new Date(h.clock.now + CODE_LIFETIME_MS).toISOString(),
    },
    h.clock.now,
  );
}

async function pair(
  h: Harness,
  code: string,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${h.url}/api/pair`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({
      code,
      client: { label: "Mike's MacBook", deviceType: "desktop", os: "macOS 15" },
      ...extra,
    }),
  });
}

async function paired(
  h: Harness,
  scopes: ("read" | "operate")[] = ["read"],
  label = "Mike's MacBook",
): Promise<string> {
  const code = `${scopes.length}AAA-BBBB-CCC${label.length % 10}`
    .replace(/[^0-9A-Z-]/g, "")
    .slice(0, 14);
  const normalized = code.replace(/-/g, "").padEnd(12, "A").slice(0, 12);
  mint(h, normalized, scopes);
  const response = await fetch(`${h.url}/api/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code: normalized,
      client: { label, deviceType: "desktop", os: "macOS 15" },
    }),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { token: string };
  return body.token;
}

const auth = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });

describe("the open surface", () => {
  test("the descriptor, no-store", async () => {
    const h = await harness();
    const response = await fetch(`${h.url}/.well-known/phoebe/deployment`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      deploymentId: "dep_X",
      name: "acme/widget",
      protocol: 1,
      version: "0.15.0",
      arm: "host",
    });
  });

  test("GET / is one plain line at 200; /pair and anything else off /api are the same line at 404", async () => {
    const h = await harness();
    const root = await fetch(`${h.url}/`);
    expect(root.status).toBe(200);
    expect(root.headers.get("content-type")).toContain("text/plain");
    expect(await root.text()).toBe(`${landingLine("acme/widget")}\n`);
    const pairPage = await fetch(`${h.url}/pair`);
    expect(pairPage.status).toBe(404);
    expect(await pairPage.text()).toContain("Phoebe companion");
    expect((await fetch(`${h.url}/index.html`)).status).toBe(404);
    expect((await fetch(`${h.url}/api/nothing`, { headers: auth("x") })).status).toBe(404);
  });
});

describe("the bearer gate", () => {
  test("missing, malformed, unknown and expired each answer 401 with the reason and the challenge", async () => {
    const h = await harness();
    for (const headers of [{}, { authorization: "Basic abc" }, auth("not-a-token")]) {
      const response = await fetch(`${h.url}/api/report`, { headers });
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toBe("Bearer");
      expect(await response.json()).toEqual({ error: "unauthenticated", reason: "unknown" });
    }
    const token = await paired(h);
    h.clock.now += 31 * 24 * 60 * 60 * 1000;
    const expired = await fetch(`${h.url}/api/report`, { headers: auth(token) });
    expect(expired.status).toBe(401);
    expect(await expired.json()).toEqual({ error: "unauthenticated", reason: "expired" });
  });

  test("the right token on the wrong scope is 403 naming what it needs", async () => {
    const h = await harness();
    const token = await paired(h, ["read"]);
    const response = await fetch(`${h.url}/api/sessions`, { headers: auth(token) });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden", needs: "operate" });
  });

  test("no cookie is ever read", async () => {
    const h = await harness();
    const token = await paired(h);
    const response = await fetch(`${h.url}/api/report`, {
      headers: { cookie: `session=${token}` },
    });
    expect(response.status).toBe(401);
  });
});

describe("POST /api/pair", () => {
  test("a good code answers the token once, with scopes from the mint, and stores a row", async () => {
    const h = await harness();
    mint(h, "ABCDEFGHJK12", ["read", "operate"]);
    const response = await pair(
      h,
      "abcd-efgh-jk12",
      {},
      { "tailscale-user-login": "mike@example.com" },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({
      token: expect.any(String),
      expiresAt: new Date(T0 + 30 * 24 * 60 * 60 * 1000).toISOString(),
      scopes: ["read", "operate"],
      deploymentId: "dep_X",
    });
    const rows = h.sessions.list(new Date(T0));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      label: "Mike's MacBook",
      deviceType: "desktop",
      os: "macOS 15",
      pairedAs: "mike@example.com",
      scopes: ["read", "operate"],
    });
    expect(h.logged.join("\n")).not.toContain(body["token"] as string);
  });

  test("unknown, spent and expired are one answer, and each ticks the budget", async () => {
    const h = await harness();
    mint(h, "ABCDEFGHJK12");
    expect((await pair(h, "ABCDEFGHJK12")).status).toBe(200);
    const spent = await pair(h, "ABCDEFGHJK12");
    expect(spent.status).toBe(400);
    expect(await spent.json()).toEqual({ error: "code-rejected" });
    const unknown = await pair(h, "ZZZZZZZZZZZZ");
    expect(await unknown.json()).toEqual({ error: "code-rejected" });
    expect(h.api.rejections().count).toBe(2);
    mint(h, "AAAAAAAAAAAA");
    h.clock.now += CODE_LIFETIME_MS;
    const expired = await pair(h, "AAAAAAAAAAAA");
    expect(await expired.json()).toEqual({ error: "code-rejected" });
    // The window is a minute, so the two earlier ticks have rolled off.
    expect(h.api.rejections().count).toBe(1);
  });

  test("a malformed body is its own 400 and ticks nothing", async () => {
    const h = await harness();
    const response = await fetch(`${h.url}/api/pair`, { method: "POST", body: "{}" });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "bad-request" });
    expect(h.api.rejections().count).toBe(0);
  });

  test("ten rejections in a minute put the lid on for 60 s, even for a good code", async () => {
    const h = await harness();
    for (let i = 0; i < PAIR_REJECTION_BUDGET; i++) await pair(h, "ZZZZZZZZZZZZ");
    expect(h.api.rejections().exhausted).toBe(true);
    mint(h, "ABCDEFGHJK12");
    const refused = await pair(h, "ABCDEFGHJK12");
    expect(refused.status).toBe(429);
    h.clock.now += 60_001;
    expect((await pair(h, "ABCDEFGHJK12")).status).toBe(200);
    expect(h.api.rejections().exhausted).toBe(false);
  });
});

describe("the reads", () => {
  test("GET /api/report answers the report and its build time, null before the first write", async () => {
    const h = await harness();
    const token = await paired(h);
    const response = await fetch(`${h.url}/api/report`, { headers: auth(token) });
    expect(await response.json()).toEqual({
      report: report(),
      builtAt: "2026-10-16T11:59:00.000Z",
    });
    h.reports.current = null;
    const again = (await (await fetch(`${h.url}/api/report`, { headers: auth(token) })).json()) as {
      report: unknown;
    };
    expect(again.report).toBeNull();
  });

  test("GET /api/session is this session's own facts", async () => {
    const h = await harness();
    const token = await paired(h, ["read"], "laptop");
    const body = await (await fetch(`${h.url}/api/session`, { headers: auth(token) })).json();
    expect(body).toEqual({
      id: expect.any(String),
      label: "laptop",
      scopes: ["read"],
      issuedAt: expect.any(String),
      expiresAt: expect.any(String),
    });
  });
});

describe("the stream", () => {
  async function openStream(
    h: Harness,
    token: string,
  ): Promise<{ response: Response; read: () => Promise<string>; stop: () => void }> {
    const controller = new AbortController();
    const response = await fetch(`${h.url}/api/events`, {
      headers: auth(token),
      signal: controller.signal,
    });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    return {
      response,
      read: async () => {
        const { value } = await reader.read();
        return decoder.decode(value);
      },
      stop: () => controller.abort(),
    };
  }

  test("opens with the latest report, pushes each change, and comments on the keepalive", async () => {
    const h = await harness({ keepAliveMs: 30 });
    const token = await paired(h);
    const stream = await openStream(h, token);
    expect(stream.response.headers.get("content-type")).toContain("text/event-stream");
    let seen = "";
    while (!seen.includes('"updatedAt":"a"')) seen += await stream.read();
    expect(seen).toContain(": connected");
    expect(seen).toContain("event: report");
    h.reports.current = report("b");
    for (const listener of h.reports.listeners) listener();
    while (!seen.includes('"updatedAt":"b"')) seen += await stream.read();
    while (!seen.includes(": keepalive")) seen += await stream.read();
    expect(STREAM_KEEPALIVE_MS).toBe(25_000);
    stream.stop();
  });

  test("the seventeenth stream is 503, and a revoke closes a session's streams", async () => {
    const h = await harness({ maxStreams: 2 });
    const token = await paired(h);
    const a = await openStream(h, token);
    const b = await openStream(h, token);
    await a.read();
    await b.read();
    expect(h.api.streams()).toBe(2);
    const third = await fetch(`${h.url}/api/events`, { headers: auth(token) });
    expect(third.status).toBe(503);
    expect(MAX_STREAMS).toBe(16);
    h.api.closeStreams(h.sessions.list(new Date(T0))[0]!.id);
    await expect(a.read()).resolves.toBe("");
    expect(h.api.streams()).toBe(0);
    a.stop();
    b.stop();
  });

  test("signing out closes the stream and the next request is 401 unknown", async () => {
    const h = await harness();
    const token = await paired(h);
    const stream = await openStream(h, token);
    await stream.read();
    const out = await fetch(`${h.url}/api/session`, { method: "DELETE", headers: auth(token) });
    expect(out.status).toBe(204);
    await expect(stream.read()).resolves.toBe("");
    const again = await fetch(`${h.url}/api/session`, { method: "DELETE", headers: auth(token) });
    expect(again.status).toBe(401);
    expect(await again.json()).toEqual({ error: "unauthenticated", reason: "unknown" });
    stream.stop();
  });
});

describe("sessions over the API", () => {
  test("list carries every row without the hash and names the caller; revoke is 204; self is 409", async () => {
    const h = await harness();
    const operator = await paired(h, ["read", "operate"], "operator");
    const reader = await paired(h, ["read"], "reader");
    const list = (await (
      await fetch(`${h.url}/api/sessions`, { headers: auth(operator) })
    ).json()) as { sessions: Array<Record<string, unknown>>; self: string };
    expect(list.sessions).toHaveLength(2);
    expect(JSON.stringify(list)).not.toContain("tokenHash");
    const me = list.sessions.find((row) => row["label"] === "operator")!;
    const other = list.sessions.find((row) => row["label"] === "reader")!;
    const myId = String(me["id"]);
    const otherId = String(other["id"]);
    expect(list.self).toBe(myId);
    const self = await fetch(`${h.url}/api/sessions/${myId}`, {
      method: "DELETE",
      headers: auth(operator),
    });
    expect(self.status).toBe(409);
    expect(await self.json()).toEqual({ error: "revoke-self" });
    const gone = await fetch(`${h.url}/api/sessions/${otherId}`, {
      method: "DELETE",
      headers: auth(operator),
    });
    expect(gone.status).toBe(204);
    expect((await fetch(`${h.url}/api/report`, { headers: auth(reader) })).status).toBe(401);
    expect(
      (await fetch(`${h.url}/api/sessions/nope`, { method: "DELETE", headers: auth(operator) }))
        .status,
    ).toBe(404);
    expect(
      (await fetch(`${h.url}/api/sessions/x`, { method: "DELETE", headers: auth(reader) })).status,
    ).toBe(401);
  });
});

describe("the operate handlers", () => {
  test("config-set: the receipt comes back, `by` is stamped from the session, a body with `by` is 400", async () => {
    const edits: unknown[] = [];
    const h = await harness({
      verbs: {
        configSet: async (edit) => {
          edits.push(edit);
          return {
            id: edit.id,
            state: "written",
            file: "phoebe.config.ts",
            path: edit.path,
            value: edit.value,
            fingerprint: "sha256:next",
            at: "now",
            by: edit.by!,
          };
        },
      },
    });
    const token = await paired(h, ["read", "operate"], "Ops laptop");
    const ok = await fetch(`${h.url}/api/config-set`, {
      method: "POST",
      headers: auth(token),
      body: JSON.stringify({ id: "e1", path: "disabled", value: true, fingerprint: "sha256:abc" }),
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({
      receipt: { state: "written", by: "device:Ops laptop" },
    });
    expect(edits).toEqual([
      {
        id: "e1",
        path: "disabled",
        value: true,
        fingerprint: "sha256:abc",
        by: "device:Ops laptop",
      },
    ]);
    const withBy = await fetch(`${h.url}/api/config-set`, {
      method: "POST",
      headers: auth(token),
      body: JSON.stringify({
        id: "e2",
        path: "disabled",
        value: true,
        fingerprint: "x",
        by: "someone",
      }),
    });
    expect(withBy.status).toBe(400);
    const blind = await fetch(`${h.url}/api/config-set`, {
      method: "POST",
      headers: auth(token),
      body: JSON.stringify({ path: "disabled", value: true }),
    });
    expect(blind.status).toBe(400);
  });

  test("config-set with pairedAs: `by` is the login; a refused receipt is still 200; no pen is a refusal", async () => {
    const h = await harness({
      verbs: {
        configSet: async (edit) => ({
          id: edit.id,
          state: "refused",
          file: "phoebe.config.ts",
          path: edit.path,
          reason: "not-editable",
          why: "closed",
          instruction: "edit by hand",
          at: "now",
          by: edit.by!,
        }),
      },
    });
    mint(h, "ABCDEFGHJK12", ["read", "operate"]);
    const response = await pair(
      h,
      "ABCDEFGHJK12",
      {},
      { "tailscale-user-login": "mike@example.com" },
    );
    const { token } = (await response.json()) as { token: string };
    const refused = await fetch(`${h.url}/api/config-set`, {
      method: "POST",
      headers: auth(token),
      body: JSON.stringify({ id: "e1", path: "remote.port", value: 1, fingerprint: "x" }),
    });
    expect(refused.status).toBe(200);
    expect(await refused.json()).toMatchObject({
      receipt: { state: "refused", reason: "not-editable", by: "mike@example.com" },
    });

    const noPen = await harness();
    const t2 = await paired(noPen, ["read", "operate"]);
    const answer = await fetch(`${noPen.url}/api/config-set`, {
      method: "POST",
      headers: auth(t2),
      body: JSON.stringify({ id: "e1", path: "disabled", value: true, fingerprint: "x" }),
    });
    expect(await answer.json()).toMatchObject({
      receipt: { state: "refused", reason: "unwritable" },
    });
  });

  test("doctor-run answers the runner's word within the moment", async () => {
    const asked: string[] = [];
    const h = await harness({
      verbs: {
        doctorRun: (by) => {
          asked.push(by);
          return { outcome: "started" };
        },
      },
    });
    const token = await paired(h, ["read", "operate"], "lap");
    const response = await fetch(`${h.url}/api/doctor-run`, {
      method: "POST",
      headers: auth(token),
    });
    expect(await response.json()).toEqual({ outcome: "started" });
    expect(asked).toEqual(["device:lap"]);
    const none = await harness();
    const t2 = await paired(none, ["read", "operate"]);
    expect(
      await (
        await fetch(`${none.url}/api/doctor-run`, { method: "POST", headers: auth(t2) })
      ).json(),
    ).toEqual({ outcome: "refused", detail: "this deployment runs no doctor" });
  });

  test("secrets: the value reaches the verb and nothing else; the receipt comes back", async () => {
    const seen: unknown[] = [];
    const h = await harness({
      verbs: {
        secretSet: async (request) => {
          seen.push(request);
          return {
            outcome: "written",
            tenant: request.tenant,
            key: request.key,
            editId: request.id,
            detail: "wrote it",
          };
        },
      },
    });
    const token = await paired(h, ["read", "operate"], "lap");
    const response = await fetch(`${h.url}/api/secrets`, {
      method: "POST",
      headers: auth(token),
      body: JSON.stringify({
        tenant: "acme/widget",
        key: "ANTHROPIC_API_KEY",
        value: "sk-very-secret",
      }),
    });
    expect(await response.json()).toEqual({
      outcome: "written",
      tenant: "acme/widget",
      key: "ANTHROPIC_API_KEY",
      editId: "req_1",
      detail: "wrote it",
    });
    expect(seen).toEqual([
      {
        id: "req_1",
        tenant: "acme/widget",
        key: "ANTHROPIC_API_KEY",
        value: "sk-very-secret",
        by: "device:lap",
      },
    ]);
    expect(h.logged.join("\n")).not.toContain("sk-very-secret");
    const clear = await fetch(`${h.url}/api/secrets`, {
      method: "POST",
      headers: auth(token),
      body: JSON.stringify({ tenant: "acme/widget", key: "ANTHROPIC_API_KEY", value: null }),
    });
    expect(clear.status).toBe(200);
    const bad = await fetch(`${h.url}/api/secrets`, {
      method: "POST",
      headers: auth(token),
      body: JSON.stringify({ tenant: "acme/widget", key: "K", value: 7 }),
    });
    expect(bad.status).toBe(400);
  });

  test("a read session gets 403 on every operate route", async () => {
    const h = await harness();
    const token = await paired(h, ["read"]);
    for (const path of ["/api/config-set", "/api/doctor-run", "/api/secrets"]) {
      const response = await fetch(`${h.url}${path}`, {
        method: "POST",
        headers: auth(token),
        body: "{}",
      });
      expect(response.status).toBe(403);
    }
  });
});

describe("limits", () => {
  test("a body over 64 KiB is 413", async () => {
    const h = await harness();
    const token = await paired(h, ["read", "operate"]);
    const response = await fetch(`${h.url}/api/config-set`, {
      method: "POST",
      headers: auth(token),
      body: JSON.stringify({ path: "x".repeat(MAX_BODY_BYTES + 10) }),
    });
    expect(response.status).toBe(413);
    const big = await fetch(`${h.url}/api/pair`, {
      method: "POST",
      body: "x".repeat(MAX_BODY_BYTES + 1),
    });
    expect(big.status).toBe(413);
  });

  test("the wrong method is 405", async () => {
    const h = await harness();
    expect((await fetch(`${h.url}/api/pair`)).status).toBe(405);
    expect((await fetch(`${h.url}/.well-known/phoebe/deployment`, { method: "POST" })).status).toBe(
      405,
    );
  });
});

describe("helpers", () => {
  test("byOf prefers the Tailscale login", () => {
    const row = {
      id: "1",
      scopes: ["read" as const],
      label: "lap",
      deviceType: "desktop" as const,
      os: "x",
      pairedAs: null,
      issuedAt: "",
      expiresAt: "",
      lastSeenAt: "",
    };
    expect(byOf(row)).toBe("device:lap");
    expect(byOf({ ...row, pairedAs: "me@x" })).toBe("me@x");
  });

  test("parseConfigSet takes literals and lists of strings, nothing else", () => {
    expect(parseConfigSet({ path: "a", value: ["x"], fingerprint: "f" }, () => "id")).toEqual({
      id: "id",
      path: "a",
      value: ["x"],
      fingerprint: "f",
    });
    expect(
      parseConfigSet({ path: "a", value: { nested: 1 }, fingerprint: "f" }, () => "id"),
    ).toBeNull();
    expect(parseConfigSet({ path: "a", value: 1 }, () => "id")).toBeNull();
  });
});

describe("the sidecar arm's socket", () => {
  test("listens on a Unix socket, mode 0660, replacing one an earlier process left", async () => {
    const { request } = await import("node:http");
    const { statSync, writeFileSync } = await import("node:fs");
    const dir = mkdtempSync(join(tmpdir(), "phoebe-sock-"));
    dirs.push(dir);
    const socketPath = join(dir, "api.sock");
    writeFileSync(socketPath, "stale");
    const api = createRemoteApi({
      descriptor: () => ({
        deploymentId: "dep_X",
        name: "acme/widget",
        protocol: 1,
        version: "0.15.0",
        arm: "sidecar",
      }),
      sessions: createSessions(dir),
      pending: createPendingCodes(),
      report: () => ({ report: null, builtAt: null }),
      onReport: () => () => {},
    });
    apis.push(api);
    const { where } = await api.listen({ arm: "sidecar", socketPath });
    expect(where).toBe(socketPath);
    expect(statSync(socketPath).mode & 0o777).toBe(0o660);
    const body = await new Promise<string>((resolve, reject) => {
      const req = request(
        { socketPath, path: "/.well-known/phoebe/deployment", method: "GET" },
        (res) => {
          let text = "";
          res.on("data", (chunk: Buffer) => (text += chunk.toString()));
          res.on("end", () => resolve(text));
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(JSON.parse(body)).toMatchObject({ arm: "sidecar", deploymentId: "dep_X" });
  });
});

describe("the console and the fleet over the API (map #690)", () => {
  /** A deployment's output, as remote-boot hands it over: held lines, and a listener per stream. */
  function output(lines: string[]) {
    const listeners = new Set<(line: string) => void>();
    return {
      logs: {
        lines: () => [...lines],
        onLine: (listener: (line: string) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      print: (line: string) => {
        lines.push(line);
        for (const listener of listeners) listener(line);
      },
      listeners,
    };
  }

  async function openLogs(h: Harness, token: string, extraDeps: Record<string, unknown> = {}) {
    void extraDeps;
    const controller = new AbortController();
    const response = await fetch(`${h.url}/api/logs`, {
      headers: auth(token),
      signal: controller.signal,
    });
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    return {
      response,
      read: async () => {
        const { value } = await reader!.read();
        return decoder.decode(value);
      },
      stop: () => controller.abort(),
    };
  }

  test("GET /api/logs opens with the backlog, then a line per line, and counts as a stream", async () => {
    const base = mkdtempSync(join(tmpdir(), "phoebe-api-"));
    dirs.push(base);
    const out = output([
      "[phoebe] boot: engine source local",
      "[acme:a/b:work] cycle: 1 candidate",
    ]);
    const sessions = createSessions(base);
    const pending = createPendingCodes();
    const clock = { now: T0 };
    const api = createRemoteApi({
      descriptor: () => ({
        deploymentId: "dep_X",
        name: "acme",
        protocol: 1,
        version: "0",
        arm: "host",
      }),
      sessions,
      pending,
      report: () => ({ report: null, builtAt: null }),
      onReport: () => () => {},
      logs: out.logs,
      now: () => clock.now,
      keepAliveMs: 30,
      maxStreams: 1,
    });
    apis.push(api);
    const { where } = await api.listen({ arm: "host", port: 0 });
    const h = {
      url: `http://127.0.0.1:${where.split(":")[1]}`,
      clock,
      pending,
      sessions,
      api,
    } as Harness;
    const token = await paired(h);
    const stream = await openLogs(h, token);
    expect(stream.response.headers.get("content-type")).toContain("text/event-stream");
    let seen = "";
    while (!seen.includes("event: backlog")) seen += await stream.read();
    expect(seen).toContain(
      `data: ${JSON.stringify({ lines: ["[phoebe] boot: engine source local", "[acme:a/b:work] cycle: 1 candidate"] })}`,
    );
    out.print("[acme:a/b:work] cycle: done");
    while (!seen.includes("cycle: done")) seen += await stream.read();
    expect(seen).toContain(
      `event: line\ndata: ${JSON.stringify({ line: "[acme:a/b:work] cycle: done" })}`,
    );
    while (!seen.includes(": keepalive")) seen += await stream.read();
    expect(api.streams()).toBe(1);
    // The cap is shared with the report stream, and so is the revoke.
    expect((await fetch(`${h.url}/api/events`, { headers: auth(token) })).status).toBe(503);
    api.closeStreams(sessions.list(new Date(T0))[0]!.id);
    await expect(stream.read()).resolves.toBe("");
    expect(out.listeners.size).toBe(0);
    stream.stop();
  });

  test("GET /api/logs is read scope, and 404 on a deployment that keeps no output", async () => {
    const h = await harness();
    expect((await fetch(`${h.url}/api/logs`)).status).toBe(401);
    const token = await paired(h, ["read"]);
    const response = await fetch(`${h.url}/api/logs`, { headers: auth(token) });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "no-logs" });
  });

  test("fleet stop and start need operate, stamp `by` from the session, and answer the hold's own words", async () => {
    const asked: string[] = [];
    let held = false;
    const h = await harness({
      verbs: {
        fleetStop: (by) => {
          asked.push(`stop by ${by}`);
          if (held) return { outcome: "unchanged", detail: "already stopped" };
          held = true;
          return { outcome: "stopped" };
        },
        fleetStart: (by) => {
          asked.push(`start by ${by}`);
          held = false;
          return { outcome: "started" };
        },
      },
    });
    const reader = await paired(h, ["read"], "reader");
    expect(
      (await fetch(`${h.url}/api/fleet/stop`, { method: "POST", headers: auth(reader) })).status,
    ).toBe(403);
    const operator = await paired(h, ["read", "operate"], "operator");
    const stop = await fetch(`${h.url}/api/fleet/stop`, {
      method: "POST",
      headers: auth(operator),
    });
    expect(await stop.json()).toEqual({ outcome: "stopped" });
    const again = await fetch(`${h.url}/api/fleet/stop`, {
      method: "POST",
      headers: auth(operator),
    });
    expect(await again.json()).toEqual({ outcome: "unchanged", detail: "already stopped" });
    const start = await fetch(`${h.url}/api/fleet/start`, {
      method: "POST",
      headers: auth(operator),
    });
    expect(await start.json()).toEqual({ outcome: "started" });
    expect(asked).toEqual([
      "stop by device:operator",
      "stop by device:operator",
      "start by device:operator",
    ]);
    // A body that carries `by` is refused; GET is not the verb.
    const forged = await fetch(`${h.url}/api/fleet/stop`, {
      method: "POST",
      headers: { ...auth(operator), "content-type": "application/json" },
      body: JSON.stringify({ by: "someone else" }),
    });
    expect(forged.status).toBe(400);
    expect((await fetch(`${h.url}/api/fleet/start`, { headers: auth(operator) })).status).toBe(405);
    expect(h.logged.join("\n")).toContain("device:operator asked for fleet stop — stopped");
  });

  test("a deployment with no hold refuses the verb in its own words", async () => {
    const h = await harness();
    const operator = await paired(h, ["read", "operate"]);
    const response = await fetch(`${h.url}/api/fleet/stop`, {
      method: "POST",
      headers: auth(operator),
    });
    expect(await response.json()).toEqual({
      outcome: "refused",
      detail: "this deployment takes no fleet stop over the API",
    });
  });
});
