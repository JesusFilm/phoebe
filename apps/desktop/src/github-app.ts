// Creating a GitHub App from the setup steps (contracts/github-app.ts).
//
// GitHub's manifest flow, end to end: a page on 127.0.0.1 that posts the
// manifest to github.com, GitHub's one confirm page, a redirect back to the
// same listener with a code, and one API call that trades the code for the
// App's id and private key. The listener exists for the minutes the operator
// is on GitHub and not a moment longer; it binds to loopback on a port the OS
// picks, and it answers nothing but the two paths it is waiting for, with a
// state it generated and checks.
//
// The private key lands in the deployment `.env` as `GH_APP_PRIVATE_KEY`, on
// one line in double quotes with `\n` where the PEM has line breaks. Compose
// expands those when it reads the file (checked against `docker compose
// config`), so the bootstrapper sees the PEM as GitHub wrote it. The key
// passes through this module on its way there and is held by nothing.

import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { GithubAppCreated, GithubAppRequest, VerbIo } from "phoebe-agent/contracts";
import { BridgeRefusal } from "./channels.ts";
import { setSecretInHostEnv } from "./secret-write.ts";

/** The App's permissions: the same five grants as the PAT, in GitHub's manifest names. */
export const APP_PERMISSIONS: Readonly<Record<string, "read" | "write">> = {
  metadata: "read",
  contents: "write",
  pull_requests: "write",
  issues: "write",
  actions: "read",
};

/** Where the App's "homepage" link goes. GitHub requires one. */
export const APP_HOMEPAGE = "https://github.com/JesusFilm/phoebe";

/** How long the operator has on GitHub before the listener gives up. */
export const APP_FLOW_TIMEOUT_MS = 15 * 60 * 1000;

export const GH_APP_ID_KEY = "GH_APP_ID";
export const GH_APP_PRIVATE_KEY_KEY = "GH_APP_PRIVATE_KEY";

/** The manifest GitHub's form takes. */
export function appManifest(opts: { name: string; redirectUrl: string }): Record<string, unknown> {
  return {
    name: opts.name,
    url: APP_HOMEPAGE,
    redirect_url: opts.redirectUrl,
    public: false,
    default_permissions: APP_PERMISSIONS,
    default_events: [],
  };
}

/** Where the manifest is posted: an organisation's page, or the user's own. */
export function manifestAction(
  owner: string,
  kind: "Organization" | "User",
  state: string,
): string {
  const base =
    kind === "Organization"
      ? `https://github.com/organizations/${encodeURIComponent(owner)}/settings/apps/new`
      : "https://github.com/settings/apps/new";
  return `${base}?state=${encodeURIComponent(state)}`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** The page the browser opens on: a form that posts the manifest to GitHub on load. */
export function manifestPage(opts: { action: string; manifest: Record<string, unknown> }): string {
  const json = escapeHtml(JSON.stringify(opts.manifest));
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Phoebe: creating a GitHub App</title></head>
<body style="font: 15px system-ui; margin: 40px; max-width: 40em">
<p>Taking you to GitHub to confirm the App…</p>
<form id="manifest" action="${escapeHtml(opts.action)}" method="post">
<input type="hidden" name="manifest" value="${json}">
<noscript><button type="submit">Continue to GitHub</button></noscript>
</form>
<script>document.getElementById("manifest").submit();</script>
</body></html>`;
}

/** What the browser shows once the App exists. */
export function donePage(created: GithubAppCreated): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Phoebe: GitHub App created</title></head>
<body style="font: 15px system-ui; margin: 40px; max-width: 40em">
<h1 style="font-size: 20px">${escapeHtml(created.name)} is registered</h1>
<p>Its id and private key are in the deployment's <code>.env</code>. One thing is left, and it is on GitHub:</p>
<p><a href="${escapeHtml(created.installUrl)}">Install ${escapeHtml(created.name)} on the repositories Phoebe serves</a>, and only those.</p>
<p>Then close this tab. The companion has what it needs.</p>
</body></html>`;
}

export function failPage(message: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Phoebe: the App was not created</title></head>
<body style="font: 15px system-ui; margin: 40px; max-width: 40em">
<h1 style="font-size: 20px">The App was not created</h1>
<p>${escapeHtml(message)}</p>
<p>Close this tab and try again from the companion.</p>
</body></html>`;
}

/** The PEM as one `.env` value: double-quoted, line breaks as `\n`, which Compose expands. */
export function pemEnvValue(pem: string): string {
  return `"${pem.trim().replace(/\r?\n/g, "\\n")}\\n"`;
}

/** One request the listener answered. */
export type Answer = { status: number; body: string };

/** A loopback listener, abstracted so the flow is testable without a socket. */
export type Listener = {
  port: number;
  close: () => void;
};
export type Serve = (handle: (url: URL) => Promise<Answer>) => Promise<Listener>;

export type AppFlowDeps = {
  fetchFn?: typeof fetch;
  /** Open a URL in the operator's browser. */
  open: (url: string) => Promise<void>;
  serve?: Serve;
  /** Write one key into the deployment `.env`. Returns the file. */
  writeEnv?: (dir: string, key: string, value: string) => string;
  state?: () => string;
  timeoutMs?: number;
};

/** The real listener: loopback only, a port the OS picks. */
export const serveOnLoopback: Serve = (handle) =>
  new Promise((resolve, reject) => {
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      handle(url).then(
        (answer) => {
          response.writeHead(answer.status, { "content-type": "text/html; charset=utf-8" });
          response.end(answer.body);
        },
        (error: unknown) => {
          response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
          response.end(error instanceof Error ? error.message : String(error));
        },
      );
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("the listener has no port"));
        return;
      }
      resolve({ port: address.port, close: () => server.close() });
    });
  });

/** Whether `owner` is an organisation or a user, which decides where the manifest goes. */
async function ownerKind(owner: string, fetchFn: typeof fetch): Promise<"Organization" | "User"> {
  try {
    const response = await fetchFn(`https://api.github.com/users/${encodeURIComponent(owner)}`, {
      headers: { accept: "application/vnd.github+json" },
    });
    if (!response.ok) return "User";
    const body = (await response.json()) as { type?: unknown };
    return body.type === "Organization" ? "Organization" : "User";
  } catch {
    return "User";
  }
}

const quiet: VerbIo = { stdout: () => undefined, stderr: () => undefined };

/** Only one flow at a time: a second listener would be a second state nobody asked for. */
let inFlight = false;

/**
 * Register the App and put its credentials into the deployment `.env` under
 * `dir`. Resolves when GitHub has answered and the file is written; rejects
 * when the operator did not finish within the timeout, GitHub refused the
 * code, or the write failed. The browser shows the same outcome.
 */
export async function createGithubApp(
  dir: string,
  request: GithubAppRequest,
  deps: AppFlowDeps,
): Promise<GithubAppCreated> {
  if (inFlight) {
    throw new BridgeRefusal({
      code: "busy",
      message: "a GitHub App is already being created",
      instruction: "Finish or close the GitHub tab that is open, then try again.",
    });
  }
  const fetchFn = deps.fetchFn ?? fetch;
  const serve = deps.serve ?? serveOnLoopback;
  const writeEnv =
    deps.writeEnv ?? ((at, key, value) => setSecretInHostEnv({ dir: at, key, value, io: quiet }));
  const state = (deps.state ?? (() => randomBytes(16).toString("hex")))();
  const timeoutMs = deps.timeoutMs ?? APP_FLOW_TIMEOUT_MS;

  inFlight = true;
  let listener: Listener | null = null;
  let settle: {
    resolve: (created: GithubAppCreated) => void;
    reject: (error: Error) => void;
  } | null = null;
  const outcome = new Promise<GithubAppCreated>((resolve, reject) => {
    settle = { resolve, reject };
  });

  try {
    const kind = await ownerKind(request.owner, fetchFn);
    listener = await serve(async (url) => {
      if (url.pathname === "/start") {
        const manifest = appManifest({
          name: request.name,
          redirectUrl: `http://127.0.0.1:${listener?.port ?? 0}/callback`,
        });
        return {
          status: 200,
          body: manifestPage({ action: manifestAction(request.owner, kind, state), manifest }),
        };
      }
      if (url.pathname === "/callback") {
        if (url.searchParams.get("state") !== state) {
          return {
            status: 400,
            body: failPage("the state did not match; this was not the page the companion opened"),
          };
        }
        const code = url.searchParams.get("code");
        if (code === null || code.length === 0) {
          return { status: 400, body: failPage("GitHub sent no code back") };
        }
        try {
          const created = await convert(code, request, dir, fetchFn, writeEnv);
          settle?.resolve(created);
          return { status: 200, body: donePage(created) };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          settle?.reject(new Error(message));
          return { status: 502, body: failPage(message) };
        }
      }
      return { status: 404, body: failPage("not a page the companion is waiting for") };
    });
    await deps.open(`http://127.0.0.1:${listener.port}/start`);

    const timer = setTimeout(
      () =>
        settle?.reject(
          new Error(
            `GitHub did not send the App back within ${Math.round(timeoutMs / 60000)} minutes`,
          ),
        ),
      timeoutMs,
    );
    timer.unref?.();
    try {
      return await outcome;
    } finally {
      clearTimeout(timer);
    }
  } finally {
    listener?.close();
    inFlight = false;
  }
}

/** Trade the code for the App, and write what came back where it goes. */
async function convert(
  code: string,
  request: GithubAppRequest,
  dir: string,
  fetchFn: typeof fetch,
  writeEnv: (dir: string, key: string, value: string) => string,
): Promise<GithubAppCreated> {
  const response = await fetchFn(
    `https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`,
    {
      method: "POST",
      headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
    },
  );
  if (response.status !== 201) {
    let message = `HTTP ${response.status}`;
    try {
      const body = (await response.json()) as { message?: unknown };
      if (typeof body.message === "string") message += `: ${body.message}`;
    } catch {
      // Nothing more to say than the status.
    }
    throw new Error(`GitHub refused the code (${message})`);
  }
  const app = (await response.json()) as {
    id?: unknown;
    slug?: unknown;
    name?: unknown;
    html_url?: unknown;
    pem?: unknown;
  };
  if (typeof app.id !== "number" || typeof app.pem !== "string" || typeof app.slug !== "string") {
    throw new Error("GitHub's answer had no id, slug or key in it");
  }
  const htmlUrl =
    typeof app.html_url === "string" ? app.html_url : `https://github.com/apps/${app.slug}`;
  writeEnv(dir, GH_APP_ID_KEY, String(app.id));
  const envFile = writeEnv(dir, GH_APP_PRIVATE_KEY_KEY, pemEnvValue(app.pem));
  return {
    id: String(app.id),
    slug: app.slug,
    name: typeof app.name === "string" ? app.name : request.name,
    owner: request.owner,
    htmlUrl,
    installUrl: `${htmlUrl}/installations/new`,
    envFile,
  };
}
