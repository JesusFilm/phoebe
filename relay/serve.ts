// `phoebe relay serve` — the process (#506 §1).
//
// One Node HTTP server on a plain internal port, serving the console over HTTP
// and the fleet over one WebSocket path. TLS is the scaffolded Caddy sidecar's
// job, keyed on `RELAY_HOST`; the relay never terminates it, and an operator
// with their own proxy deletes the sidecar and points it here.
//
// Nothing here is the deployment container. That container still has no
// inbound listener and gains none: this is a separate image, a separate
// compose file, and a separate volume.

import { createServer, type Server } from "node:http";
import { mkdirSync } from "node:fs";
import { createAllowlist } from "./allowlist.ts";
import { createConsoleAssets } from "./console-assets.ts";
import { createDeviceCodes, createDevices } from "./devices.ts";
import { readRelayEnv, redirectUri, type RelayEnv } from "./env.ts";
import { createRelayHandler } from "./http.ts";
import { serveDeployments, type DeploymentGate } from "./deployments.ts";
import { createRelayEvents } from "./events.ts";
import { createLinks, createPairingTokens } from "./links.ts";
import { createReports } from "./reports.ts";
import { createGoogleIdentityProvider, type IdentityProvider } from "./oidc.ts";
import { createSessionStore } from "./sessions.ts";
import { RELAY_DEPLOYMENTS_PATH, RELAY_PROTOCOL } from "../src/contracts/relay-protocol.ts";
import { RELAY_ROUTES } from "../src/contracts/relay-routes.ts";

/**
 * The port the relay listens on inside its network. A constant, not a knob:
 * the scaffolded compose puts Caddy in front of it and nothing else can reach
 * it, so the only thing a setting here would buy is two files to keep in step.
 */
export const RELAY_PORT = 8787;

/** The relay volume's mount point in the scaffolded compose. */
export const DEFAULT_RELAY_DATA_DIR = "/data/relay";

export type StartRelayOptions = {
  /** Already read and validated; `runRelayServe` reads it from the process. */
  env: RelayEnv;
  /** The relay volume. */
  dataDir?: string;
  /**
   * Where the console build sits. Defaults to the one in this package, which is
   * the only value production has; a test points it at a directory it wrote.
   */
  consoleDir?: string;
  /** 0 asks the OS for a free port, which is how the tests bind. */
  port?: number;
  /** Overridden in tests; production talks to Google. */
  identity?: IdentityProvider;
  /**
   * The heartbeat interval and the dark threshold, for a test that would
   * otherwise wait twenty seconds to see one ping. Production uses the
   * constants in contracts and there is no way to set these from the outside.
   */
  heartbeatMs?: number;
  darkAfterMs?: number;
  /** Start-up lines. Defaults to stdout. */
  log?: (message: string) => void;
  /** Refusals and unreachable-Google complaints. Defaults to stderr. */
  warn?: (message: string) => void;
};

export type RunningRelay = {
  /** The port actually bound — the one that matters when `port` was 0. */
  port: number;
  server: Server;
  /** The deployment endpoint, for a test that wants to see who is connected. */
  deployments: DeploymentGate;
  close: () => Promise<void>;
};

/**
 * Build and bind the relay. Returns once it is listening, so a caller (a test,
 * or a later supervisor) can act on the bound port without polling.
 */
export async function startRelay(options: StartRelayOptions): Promise<RunningRelay> {
  const dataDir = options.dataDir ?? DEFAULT_RELAY_DATA_DIR;
  const log = options.log ?? ((message: string) => process.stdout.write(`${message}\n`));
  mkdirSync(dataDir, { recursive: true });

  const callback = redirectUri(options.env.host, RELAY_ROUTES.callback);
  const warn = options.warn ?? ((message: string) => process.stderr.write(`${message}\n`));
  // One registry, shared: the console mints into it over HTTP and the
  // deployment endpoint spends out of it over the socket.
  const tokens = createPairingTokens();
  const links = createLinks(dataDir);
  // The reports outlive the process; the stream watching them does not. One is
  // on the volume for exactly that reason (#506 §3), and the other is a set of
  // open responses that a restart closes and a browser redials.
  const reports = createReports(dataDir);
  const events = createRelayEvents({ warn });
  const consoleAssets = createConsoleAssets(options.consoleDir);
  // The knot this unties: the socket endpoint needs the HTTP server, the server
  // needs the handler, and the handler needs the endpoint. One `let` and a
  // thunk, assigned before the port is bound and therefore before any request
  // can reach the thunk.
  let deployments: DeploymentGate | null = null;
  const handler = createRelayHandler({
    allowlist: createAllowlist(dataDir, options.env.allowedEmails),
    tokens,
    fleet: () => {
      if (deployments === null) throw new Error("the deployment endpoint is not attached yet");
      return deployments;
    },
    reports,
    events,
    console: consoleAssets,
    sessions: createSessionStore(),
    // The companions, on the volume, and the codes that mint one, in memory.
    // The split is the lifetime: a device token outlives the process by design
    // (#523 §3) and a one-time code cannot outlive one OS handover.
    devices: createDevices(dataDir),
    deviceCodes: createDeviceCodes(),
    identity:
      options.identity ??
      createGoogleIdentityProvider({
        clientId: options.env.clientId,
        clientSecret: options.env.clientSecret,
        redirectUri: callback,
      }),
    publicOrigin: new URL(callback).origin,
    warn,
  });

  const server = createServer((request, response) => {
    void Promise.resolve(handler(request, response)).catch((error: unknown) => {
      // A handler that throws is this repo's bug, not the caller's. Say so on
      // stderr and answer with a body rather than leaving the socket hanging.
      process.stderr.write(
        `[phoebe:relay] unhandled error on ${request.method} ${request.url}: ${
          error instanceof Error ? (error.stack ?? error.message) : String(error)
        }\n`,
      );
      if (!response.headersSent) response.writeHead(500, { "content-type": "text/plain" });
      response.end("Internal error\n");
    });
  });

  const gate = serveDeployments({
    server,
    links,
    tokens,
    reports,
    events,
    log,
    warn,
    ...(options.heartbeatMs !== undefined ? { heartbeatMs: options.heartbeatMs } : {}),
    ...(options.darkAfterMs !== undefined ? { darkAfterMs: options.darkAfterMs } : {}),
  });
  deployments = gate;

  const port = await listen(server, options.port ?? RELAY_PORT);
  log(`[phoebe:relay] listening on port ${port}`);
  log(`[phoebe:relay] sign in at ${new URL(RELAY_ROUTES.signIn, new URL(callback).origin).href}`);
  log(
    consoleAssets.built
      ? `[phoebe:relay] serving the console from ${consoleAssets.dir}`
      : `[phoebe:relay] no console build at ${consoleAssets.dir} — the API answers, the pages do not`,
  );
  log(
    options.env.allowedEmails.length > 0
      ? `[phoebe:relay] allowlist seeded from ALLOWED_EMAILS: ${options.env.allowedEmails.join(", ")}`
      : `[phoebe:relay] ALLOWED_EMAILS is empty — the first verified sign-in claims this relay`,
  );

  log(
    `[phoebe:relay] deployments dial ${RELAY_DEPLOYMENTS_PATH} — ` +
      `${links.all().length} link(s) recorded, protocol ${RELAY_PROTOCOL}`,
  );

  return {
    port,
    server,
    deployments: gate,
    close: async () => {
      // The sockets first: a deployment closed cleanly reconnects to the relay
      // that comes back, where one dropped by the listener going out from under
      // it waits out a backoff for no reason.
      await gate.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    },
  };
}

/**
 * Run until stopped. The relay is a long-lived main process, so `SIGTERM` and
 * `SIGINT` close the listener and let the process end rather than being killed
 * mid-response — the same courtesy `phoebe boot` extends to the engine.
 */
export async function runRelayServe(argv: {
  env: NodeJS.ProcessEnv;
  dataDir?: string;
  port?: number;
}): Promise<void> {
  const relay = await startRelay({
    env: readRelayEnv(argv.env),
    ...(argv.dataDir !== undefined ? { dataDir: argv.dataDir } : {}),
    ...(argv.port !== undefined ? { port: argv.port } : {}),
  });
  await new Promise<void>((resolve) => {
    const stop = (signal: NodeJS.Signals) => () => {
      process.stdout.write(`[phoebe:relay] ${signal} — closing\n`);
      void relay.close().then(resolve, resolve);
    };
    process.once("SIGTERM", stop("SIGTERM"));
    process.once("SIGINT", stop("SIGINT"));
  });
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => {
      const address = server.address();
      server.removeListener("error", reject);
      if (address === null || typeof address === "string") {
        reject(new Error(`relay bound to an unexpected address: ${String(address)}`));
        return;
      }
      resolve(address.port);
    });
  });
}
