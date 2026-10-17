// The deployment API (map #690; decided in #694, #696 and #698): what a paired
// device reaches over Tailscale, served by the bootstrapper itself on
// `node:http` with no new dependency.
//
// **Where it listens is the arm's business, not this file's.** On the sidecar
// arm it is a Unix socket Serve proxies to, never a TCP port — in userspace
// mode netstack forwards an unserved tailnet port to loopback, so a loopback
// listener would answer every tailnet device around Serve. On the host arm it
// is `127.0.0.1:7463`, published loopback-only and served by the machine's own
// Tailscale. `listen` takes the arm; everything else here is the same.
//
// **Bearer only.** No route reads a cookie; `Origin` and `Sec-Fetch-Site` are
// ignored, since no page on this origin exists to be attacked through. The
// gate hashes the token and looks it up in the sessions store; missing,
// malformed, unknown, revoked or expired is one 401 with the reason, and the
// right token on the wrong scope is a 403 naming what it needs.
//
// **The deployment serves no console.** `GET /` is one plain-text line saying
// what this is; `/pair` is the same line as a 404, because the pairing link's
// fragment never reaches a server and there is nothing to run on it. Everything
// else not under `/api` is 404.
//
// **The stream is the only push.** `GET /api/events` opens with the latest
// report, then one per change, with a comment every 25 s so a reader can tell a
// quiet deployment from a dead socket. No `alert` event: the companion holds
// the clocks. No replay: a client that missed something reads `/api/report`.
// Sixteen streams at most; a revoked session's streams close at the moment of
// revoke.
//
// **The operate bodies are each verb's own input.** No `by`, no envelope, no
// fingerprint of the deployment: the URL names the deployment, and `by` is
// stamped here from the session — `pairedAs` when Tailscale supplied one,
// otherwise `device:<label>`. A body that carries `by` is a 400.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { chmodSync, existsSync, rmSync } from "node:fs";
import type { ConfigEdit, ConfigEditValue, EditReceipt } from "../src/contracts/config-edit.ts";
import type { DeploymentReport } from "../src/contracts/deployment.ts";
import {
  API_SOCKET_PATH,
  REMOTE_ROUTES,
  type DoctorRunResponse,
  type PairResponse,
  type RemoteDescriptor,
  type RemoteDeviceType,
  type RemoteScope,
  type SessionRow,
} from "../src/contracts/remote-protocol.ts";
import { REMOTE_CONTAINER_PORT } from "../src/config-schema.ts";
import type { SecretOutcome } from "../src/contracts/secrets.ts";
import { hashCode, normalizeCode, type PendingCodes } from "./pairing-codes.ts";
import { bearerToken, type Sessions } from "./remote-sessions.ts";

/** Bodies past this are 413. A config edit is bytes; a secret is bytes. */
export const MAX_BODY_BYTES = 64 * 1024;

/** The comment line's cadence on the stream. */
export const STREAM_KEEPALIVE_MS = 25_000;

/** Open streams at most; the next is 503. */
export const MAX_STREAMS = 16;

/** Rejected pair attempts per minute before every attempt gets 429 for a minute. */
export const PAIR_REJECTION_BUDGET = 10;
export const PAIR_BUDGET_WINDOW_MS = 60_000;

/** What `/api/secrets` answers with. */
export type SecretResponse = {
  outcome: SecretOutcome;
  tenant: string;
  key: string;
  editId?: string;
  detail: string;
};

/** What a session may ask this deployment to do, beyond reading. */
export type RemoteVerbs = {
  /** The pen (#503). Answers the receipt; a refusal is still a 200. */
  configSet?: (edit: ConfigEdit) => Promise<EditReceipt>;
  /** Run doctor because `by` asked. Answered within the moment. */
  doctorRun?: (by: string) => DoctorRunResponse;
  /** Set or clear one tenant secret. */
  secretSet?: (request: {
    id: string;
    tenant: string;
    key: string;
    value: string | null;
    by: string;
  }) => Promise<SecretResponse>;
};

export type RemoteApiDeps = {
  descriptor: () => RemoteDescriptor;
  sessions: Sessions;
  pending: PendingCodes;
  /** The report as last written, and when the file was written. */
  report: () => { report: DeploymentReport | null; builtAt: string | null };
  /** Called with a function to run on every report write; returns the unsubscribe. */
  onReport: (listener: () => void) => () => void;
  verbs?: RemoteVerbs;
  now?: () => number;
  log?: (line: string) => void;
  keepAliveMs?: number;
  maxStreams?: number;
  /** A fresh request id for a verb, when the body carried none. */
  newId?: () => string;
};

/** Where the listener binds. */
export type ListenTarget = { arm: "sidecar"; socketPath?: string } | { arm: "host"; port?: number };

export type RemoteApi = {
  /** The request handler, for a test to drive without a socket. */
  handle: (request: IncomingMessage, response: ServerResponse) => void;
  /** Bind. Resolves once listening. */
  listen: (target: ListenTarget) => Promise<{ where: string }>;
  close: () => Promise<void>;
  /** Close every stream a session holds — a revoke's hook. */
  closeStreams: (sessionId: string) => void;
  /** How many streams are open now. */
  streams: () => number;
  /** The rejection budget's state, for doctor. */
  rejections: () => { count: number; exhausted: boolean };
};

type Caller = { row: SessionRow; by: string };

/** The one plain-text line `GET /` and `/pair` answer with. */
export function landingLine(name: string): string {
  return `${name} is a Phoebe deployment. It is reached through the Phoebe companion; there is nothing to see here in a browser.`;
}

/** Who the ledger names for a session: the Tailscale login when there was one, else the device. */
export function byOf(row: SessionRow): string {
  return row.pairedAs ?? `device:${row.label}`;
}

export function createRemoteApi(deps: RemoteApiDeps): RemoteApi {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  const keepAliveMs = deps.keepAliveMs ?? STREAM_KEEPALIVE_MS;
  const maxStreams = deps.maxStreams ?? MAX_STREAMS;
  const newId = deps.newId ?? (() => `req_${Math.random().toString(36).slice(2, 12)}`);

  /** Open streams, each tagged with its session so a revoke can find them. */
  const streams = new Map<ServerResponse, { sessionId: string; close: () => void }>();

  /** The pair budget: rejection stamps in the last minute, and when the lid went on. */
  let rejections: number[] = [];
  let lidUntil = 0;
  const trimRejections = (): void => {
    const since = now() - PAIR_BUDGET_WINDOW_MS;
    rejections = rejections.filter((at) => at > since);
  };
  const rejectPair = (): void => {
    trimRejections();
    rejections.push(now());
    if (rejections.length >= PAIR_REJECTION_BUDGET && lidUntil <= now()) {
      lidUntil = now() + PAIR_BUDGET_WINDOW_MS;
      log(
        `[phoebe] remote: ${rejections.length} pair attempts rejected in the last minute — ` +
          `every attempt answers 429 for the next 60 s.`,
      );
    }
  };

  let server: Server | null = null;

  const gate = (
    request: IncomingMessage,
    response: ServerResponse,
    needs: RemoteScope,
  ): Caller | null => {
    const token = bearerToken(request.headers.authorization);
    const auth = deps.sessions.authenticate(token, new Date(now()));
    if (!auth.ok) {
      response.setHeader("www-authenticate", "Bearer");
      json(response, 401, { error: "unauthenticated", reason: auth.reason });
      return null;
    }
    if (!auth.row.scopes.includes(needs)) {
      json(response, 403, { error: "forbidden", needs });
      return null;
    }
    return { row: auth.row, by: byOf(auth.row) };
  };

  async function pair(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (lidUntil > now()) {
      json(response, 429, { error: "too-many-attempts", retryAfterMs: lidUntil - now() });
      return;
    }
    const body = await readJsonBody(request);
    if (body === "too-large") {
      json(response, 413, { error: "body-too-large" });
      return;
    }
    const parsed = parsePairBody(body);
    if (parsed === null) {
      // A malformed body tells a guesser nothing about codes, so it is its own
      // error and ticks no budget.
      json(response, 400, { error: "bad-request" });
      return;
    }
    const normalized = normalizeCode(parsed.code);
    const spent = normalized === null ? null : deps.pending.spend(hashCode(normalized), now());
    if (spent === null) {
      // Unknown, spent and expired are one answer: a guesser learns nothing
      // about whether a code existed.
      rejectPair();
      json(response, 400, { error: "code-rejected" });
      return;
    }
    const login = request.headers["tailscale-user-login"];
    const pairedAs = typeof login === "string" && login.length > 0 ? login : null;
    const issued = deps.sessions.issue(
      {
        scopes: spent.scopes,
        label: parsed.client.label,
        deviceType: parsed.client.deviceType,
        os: parsed.client.os,
        pairedAs,
      },
      new Date(now()),
    );
    log(
      `[phoebe] remote: paired ${issued.row.label} (${issued.row.deviceType}, ${issued.row.os}` +
        `${pairedAs === null ? "" : `, ${pairedAs}`}) with ${spent.scopes.join("+")}.`,
    );
    const answer: PairResponse = {
      token: issued.token,
      expiresAt: issued.row.expiresAt,
      scopes: issued.row.scopes,
      deploymentId: deps.descriptor().deploymentId,
    };
    json(response, 200, answer);
  }

  function stream(request: IncomingMessage, response: ServerResponse, caller: Caller): void {
    if (streams.size >= maxStreams) {
      json(response, 503, { error: "too-many-streams", max: maxStreams });
      return;
    }
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    const send = (): void => {
      const latest = deps.report().report;
      if (latest === null) return;
      response.write(`event: report\ndata: ${JSON.stringify(latest)}\n\n`);
    };
    // The first event is the latest report: a client reads nothing else on
    // connect, and a reconnect after an outage lands on today's report.
    response.write(": connected\n\n");
    send();
    const unsubscribe = deps.onReport(send);
    const beat = setInterval(() => response.write(": keepalive\n\n"), keepAliveMs);
    beat.unref?.();
    let closed = false;
    const close = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(beat);
      unsubscribe();
      streams.delete(response);
      response.end();
    };
    streams.set(response, { sessionId: caller.row.id, close });
    request.on("close", close);
    response.on("close", close);
  }

  async function configSet(
    request: IncomingMessage,
    response: ServerResponse,
    caller: Caller,
  ): Promise<void> {
    const body = await readJsonBody(request);
    if (body === "too-large") return json(response, 413, { error: "body-too-large" });
    if (typeof body !== "object" || body === null)
      return json(response, 400, { error: "bad-request" });
    const record = body as Record<string, unknown>;
    if ("by" in record) {
      return json(response, 400, {
        error: "bad-request",
        detail: "the deployment stamps `by` from the session; a body must not carry one",
      });
    }
    const edit = parseConfigSet(record, newId);
    if (edit === null) return json(response, 400, { error: "bad-request" });
    if (deps.verbs?.configSet === undefined) {
      return json(response, 200, {
        receipt: refusal({ ...edit, by: caller.by }, "this deployment holds no pen", now()),
      });
    }
    let receipt: EditReceipt;
    try {
      receipt = await deps.verbs.configSet({ ...edit, by: caller.by });
    } catch (error) {
      receipt = refusal({ ...edit, by: caller.by }, messageOf(error), now());
    }
    log(`[phoebe] remote: ${caller.by} set ${edit.path} — ${receipt.state}.`);
    json(response, 200, { receipt });
  }

  async function doctorRun(
    request: IncomingMessage,
    response: ServerResponse,
    caller: Caller,
  ): Promise<void> {
    const body = await readJsonBody(request);
    if (body === "too-large") return json(response, 413, { error: "body-too-large" });
    if (typeof body === "object" && body !== null && "by" in (body as object)) {
      return json(response, 400, { error: "bad-request" });
    }
    let answer: DoctorRunResponse;
    if (deps.verbs?.doctorRun === undefined) {
      answer = { outcome: "refused", detail: "this deployment runs no doctor" };
    } else {
      try {
        answer = deps.verbs.doctorRun(caller.by);
      } catch (error) {
        answer = { outcome: "refused", detail: messageOf(error) };
      }
    }
    log(`[phoebe] remote: ${caller.by} asked for doctor — ${answer.outcome}.`);
    json(response, 200, answer);
  }

  async function secrets(
    request: IncomingMessage,
    response: ServerResponse,
    caller: Caller,
  ): Promise<void> {
    const body = await readJsonBody(request);
    if (body === "too-large") return json(response, 413, { error: "body-too-large" });
    if (typeof body !== "object" || body === null)
      return json(response, 400, { error: "bad-request" });
    const record = body as Record<string, unknown>;
    if ("by" in record) return json(response, 400, { error: "bad-request" });
    const tenant = record["tenant"];
    const key = record["key"];
    const value = record["value"];
    if (
      typeof tenant !== "string" ||
      tenant.length === 0 ||
      typeof key !== "string" ||
      key.length === 0 ||
      (value !== null && typeof value !== "string")
    ) {
      return json(response, 400, { error: "bad-request" });
    }
    if (deps.verbs?.secretSet === undefined) {
      return json(response, 200, {
        outcome: "refused",
        tenant,
        key,
        detail: "this deployment takes no secrets over the API",
      } satisfies SecretResponse);
    }
    let answer: SecretResponse;
    try {
      answer = await deps.verbs.secretSet({ id: newId(), tenant, key, value, by: caller.by });
    } catch (error) {
      answer = { outcome: "refused", tenant, key, detail: messageOf(error) };
    }
    // The key and the outcome, never the value: this line is the whole of what
    // the log carries about a secret.
    log(
      `[phoebe] remote: ${caller.by} ${value === null ? "cleared" : "set"} ${key} for ${tenant} — ${answer.outcome}.`,
    );
    json(response, 200, answer);
  }

  function handle(request: IncomingMessage, response: ServerResponse): void {
    void route(request, response).catch((error: unknown) => {
      log(`[phoebe] remote: request failed — ${messageOf(error)}`);
      if (!response.headersSent) json(response, 500, { error: "internal" });
      else response.end();
    });
  }

  async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://deployment");
    const path = url.pathname;
    const method = request.method ?? "GET";
    const name = deps.descriptor().name;

    if (path === REMOTE_ROUTES.descriptor) {
      if (method !== "GET") return json(response, 405, { error: "method-not-allowed" });
      return json(response, 200, deps.descriptor());
    }
    if (!path.startsWith("/api/")) {
      // One line, whatever was asked for: a tapped link lands somewhere that
      // says what it is. `/pair` is the pairing link's path; the fragment that
      // matters never reached us.
      return text(response, path === "/" ? 200 : 404, landingLine(name));
    }

    if (path === REMOTE_ROUTES.pair) {
      if (method !== "POST") return json(response, 405, { error: "method-not-allowed" });
      return pair(request, response);
    }
    if (path === REMOTE_ROUTES.report) {
      if (method !== "GET") return json(response, 405, { error: "method-not-allowed" });
      if (gate(request, response, "read") === null) return;
      return json(response, 200, deps.report());
    }
    if (path === REMOTE_ROUTES.events) {
      if (method !== "GET") return json(response, 405, { error: "method-not-allowed" });
      const caller = gate(request, response, "read");
      if (caller === null) return;
      return stream(request, response, caller);
    }
    if (path === REMOTE_ROUTES.session) {
      const caller = gate(request, response, "read");
      if (caller === null) return;
      if (method === "GET") {
        const { id, label, scopes, issuedAt, expiresAt } = caller.row;
        return json(response, 200, { id, label, scopes, issuedAt, expiresAt });
      }
      if (method === "DELETE") {
        // Idempotent: a second sign-out finds nothing and still says 204.
        deps.sessions.revoke(caller.row.id);
        closeStreams(caller.row.id);
        log(`[phoebe] remote: session revoked by ${caller.by} (signed out).`);
        return empty(response, 204);
      }
      return json(response, 405, { error: "method-not-allowed" });
    }
    if (path === REMOTE_ROUTES.sessions) {
      if (method !== "GET") return json(response, 405, { error: "method-not-allowed" });
      const caller = gate(request, response, "operate");
      if (caller === null) return;
      return json(response, 200, {
        sessions: deps.sessions.list(new Date(now())),
        self: caller.row.id,
      });
    }
    if (path.startsWith(`${REMOTE_ROUTES.sessions}/`)) {
      if (method !== "DELETE") return json(response, 405, { error: "method-not-allowed" });
      const caller = gate(request, response, "operate");
      if (caller === null) return;
      const id = decodeURIComponent(path.slice(REMOTE_ROUTES.sessions.length + 1));
      if (id === caller.row.id) return json(response, 409, { error: "revoke-self" });
      if (!deps.sessions.revoke(id)) return json(response, 404, { error: "not-found" });
      closeStreams(id);
      log(`[phoebe] remote: session ${id} revoked by ${caller.by}.`);
      return empty(response, 204);
    }
    if (path === REMOTE_ROUTES.configSet) {
      if (method !== "POST") return json(response, 405, { error: "method-not-allowed" });
      const caller = gate(request, response, "operate");
      if (caller === null) return;
      return configSet(request, response, caller);
    }
    if (path === REMOTE_ROUTES.doctorRun) {
      if (method !== "POST") return json(response, 405, { error: "method-not-allowed" });
      const caller = gate(request, response, "operate");
      if (caller === null) return;
      return doctorRun(request, response, caller);
    }
    if (path === REMOTE_ROUTES.secrets) {
      if (method !== "POST") return json(response, 405, { error: "method-not-allowed" });
      const caller = gate(request, response, "operate");
      if (caller === null) return;
      return secrets(request, response, caller);
    }
    return json(response, 404, { error: "not-found" });
  }

  function closeStreams(sessionId: string): void {
    // Deleting from a Map mid-iteration is defined: a closed stream drops
    // itself and the walk carries on.
    for (const entry of streams.values()) {
      if (entry.sessionId === sessionId) entry.close();
    }
  }

  return {
    handle,
    listen(target) {
      return new Promise((resolve, reject) => {
        const httpServer = createServer(handle);
        server = httpServer;
        httpServer.on("error", reject);
        if (target.arm === "sidecar") {
          const socketPath = target.socketPath ?? API_SOCKET_PATH;
          // A socket file an earlier process left is an address in use.
          if (existsSync(socketPath)) rmSync(socketPath, { force: true });
          httpServer.listen(socketPath, () => {
            try {
              // Serve connects as the sidecar's uid; the group is the shared tmpfs's.
              chmodSync(socketPath, 0o660);
            } catch {
              // The mode is a courtesy on a tmpfs already owned by this uid.
            }
            resolve({ where: socketPath });
          });
          return;
        }
        const port = target.port ?? REMOTE_CONTAINER_PORT;
        httpServer.listen(port, "127.0.0.1", () => {
          const bound = httpServer.address();
          const actual = typeof bound === "object" && bound !== null ? bound.port : port;
          resolve({ where: `127.0.0.1:${actual}` });
        });
      });
    },
    close() {
      for (const entry of streams.values()) entry.close();
      return new Promise((resolve) => {
        if (server === null) return resolve();
        server.close(() => resolve());
        server = null;
      });
    },
    closeStreams,
    streams: () => streams.size,
    rejections() {
      trimRejections();
      return { count: rejections.length, exhausted: lidUntil > now() };
    },
  };
}

// ───────────────────────────── bodies and answers ─────────────────────────────

/** The pair body, checked: a code and a client that says what it is. */
export function parsePairBody(
  body: unknown,
): { code: string; client: { label: string; deviceType: RemoteDeviceType; os: string } } | null {
  if (typeof body !== "object" || body === null) return null;
  const record = body as Record<string, unknown>;
  const code = record["code"];
  const client = record["client"];
  if (typeof code !== "string" || code.length === 0 || code.length > 64) return null;
  if (typeof client !== "object" || client === null) return null;
  const { label, deviceType, os } = client as Record<string, unknown>;
  if (typeof label !== "string" || label.length > 1024) return null;
  if (deviceType !== "desktop" && deviceType !== "mobile") return null;
  if (typeof os !== "string" || os.length > 200) return null;
  return { code, client: { label, deviceType, os } };
}

/**
 * A `config-set` body with the fields the pen reads, or null. `id` may be
 * absent — a client that carries none is given one — but `fingerprint` may
 * not: an edit with no fingerprint was composed blind. A value that is not a
 * literal (or a list of strings) is refused here rather than carried.
 */
export function parseConfigSet(
  record: Record<string, unknown>,
  newId: () => string,
): Omit<ConfigEdit, "by"> | null {
  const id = record["id"] === undefined ? newId() : record["id"];
  const path = record["path"];
  const fingerprint = record["fingerprint"];
  const value = record["value"];
  if (typeof id !== "string" || id.length === 0 || id.length > 128) return null;
  if (typeof path !== "string" || path.length === 0 || path.length > 256) return null;
  if (typeof fingerprint !== "string" || fingerprint.length === 0) return null;
  const literal =
    value === null ||
    ["string", "number", "boolean"].includes(typeof value) ||
    (Array.isArray(value) && value.every((item) => typeof item === "string"));
  if (!literal) return null;
  return { id, path, value: value as ConfigEditValue, fingerprint };
}

/**
 * The refusal this file writes itself when there is no pen or the pen threw:
 * `unwritable`, with the manual edit, as every refusal carries (#503).
 */
function refusal(edit: ConfigEdit, why: string, at: number): EditReceipt {
  const file = "phoebe.config.ts";
  return {
    id: edit.id,
    state: "refused",
    file,
    path: edit.path,
    reason: "unwritable",
    why,
    instruction: `Edit ${file} by hand: set \`${edit.path}\` to ${JSON.stringify(edit.value)}.`,
    at: new Date(at).toISOString(),
    ...(edit.by !== undefined ? { by: edit.by } : {}),
  };
}

/** The body as JSON, `{}` for none, or `"too-large"` past the cap. */
export async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) return "too-large";
    chunks.push(buffer);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    return null;
  }
}

function json(response: ServerResponse, status: number, body: unknown): void {
  const payload = `${JSON.stringify(body)}\n`;
  response
    .writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(payload),
      "cache-control": "no-store",
    })
    .end(payload);
}

function text(response: ServerResponse, status: number, body: string): void {
  const payload = `${body}\n`;
  response
    .writeHead(status, {
      "content-type": "text/plain; charset=utf-8",
      "content-length": Buffer.byteLength(payload),
      "cache-control": "no-store",
    })
    .end(payload);
}

function empty(response: ServerResponse, status: number): void {
  response.writeHead(status, { "cache-control": "no-store" }).end();
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
