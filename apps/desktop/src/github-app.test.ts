// The manifest flow, driven without a socket or a browser: the page the
// listener serves, the state it checks, the code it trades, the key it writes.

import { describe, expect, test } from "vite-plus/test";
import {
  APP_PERMISSIONS,
  appManifest,
  createGithubApp,
  donePage,
  manifestAction,
  manifestPage,
  pemEnvValue,
  type Answer,
  type Serve,
} from "./github-app.ts";

const PEM = "-----BEGIN RSA PRIVATE KEY-----\nMIIEabc\ndef\n-----END RSA PRIVATE KEY-----\n";

describe("the manifest", () => {
  test("carries the five permissions, no events, and the redirect back to the listener", () => {
    const manifest = appManifest({
      name: "phoebe-acme",
      redirectUrl: "http://127.0.0.1:4321/callback",
    });

    expect(manifest).toEqual({
      name: "phoebe-acme",
      url: "https://github.com/JesusFilm/phoebe",
      redirect_url: "http://127.0.0.1:4321/callback",
      public: false,
      default_permissions: APP_PERMISSIONS,
      default_events: [],
    });
    expect(APP_PERMISSIONS).toEqual({
      metadata: "read",
      contents: "write",
      pull_requests: "write",
      issues: "write",
      actions: "read",
    });
  });

  test("is posted to the organisation's page or the user's own, with the state", () => {
    expect(manifestAction("acme", "Organization", "s3cr3t")).toBe(
      "https://github.com/organizations/acme/settings/apps/new?state=s3cr3t",
    );
    expect(manifestAction("octocat", "User", "s3cr3t")).toBe(
      "https://github.com/settings/apps/new?state=s3cr3t",
    );
  });

  test("the page posts it on load, with the JSON escaped into the field", () => {
    const page = manifestPage({
      action: "https://github.com/settings/apps/new?state=x",
      manifest: { name: 'a "quoted" <name>' },
    });

    expect(page).toContain('action="https://github.com/settings/apps/new?state=x" method="post"');
    expect(page).toContain(
      'name="manifest" value="{&quot;name&quot;:&quot;a \\&quot;quoted\\&quot; &lt;name&gt;&quot;}"',
    );
    expect(page).toContain('document.getElementById("manifest").submit()');
  });
});

describe("the key in the .env", () => {
  test("is one double-quoted line with the breaks as backslash-n, which Compose expands", () => {
    expect(pemEnvValue(PEM)).toBe(
      '"-----BEGIN RSA PRIVATE KEY-----\\nMIIEabc\\ndef\\n-----END RSA PRIVATE KEY-----\\n"',
    );
    expect(pemEnvValue(PEM)).not.toContain("\n");
    expect(pemEnvValue("a\r\nb")).toBe('"a\\nb\\n"');
  });
});

/** A listener the test drives by hand, and a GitHub that answers the conversion. */
function harness(over: { convert?: { status: number; body: unknown }; ownerType?: string } = {}) {
  let handle: ((url: URL) => Promise<Answer>) | null = null;
  let closed = 0;
  const serve: Serve = (given) => {
    handle = given;
    return Promise.resolve({ port: 4321, close: () => void closed++ });
  };
  const opened: string[] = [];
  const written: [string, string, string][] = [];
  const calls: { method: string; url: string }[] = [];
  const fetchFn: typeof fetch = (input, init) => {
    const url = input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
    calls.push({ method: init?.method ?? "GET", url });
    if (url.startsWith("https://api.github.com/users/")) {
      return Promise.resolve(
        new Response(JSON.stringify({ type: over.ownerType ?? "Organization" }), { status: 200 }),
      );
    }
    if (url.includes("/app-manifests/")) {
      const answer = over.convert ?? {
        status: 201,
        body: {
          id: 12345,
          slug: "phoebe-acme",
          name: "phoebe-acme",
          html_url: "https://github.com/apps/phoebe-acme",
          pem: PEM,
        },
      };
      return Promise.resolve(new Response(JSON.stringify(answer.body), { status: answer.status }));
    }
    return Promise.reject(new Error(`unexpected ${url}`));
  };
  const flow = createGithubApp(
    "/repos/fleet",
    { owner: "acme", name: "phoebe-acme" },
    {
      fetchFn,
      serve,
      open: (url) => {
        opened.push(url);
        return Promise.resolve();
      },
      writeEnv: (dir, key, value) => {
        written.push([dir, key, value]);
        return `${dir}/.env`;
      },
      state: () => "STATE",
      timeoutMs: 50,
    },
  );
  const ask = async (path: string): Promise<Answer> => {
    for (let i = 0; i < 10 && handle === null; i++) await new Promise((r) => setTimeout(r, 0));
    if (handle === null) throw new Error("the listener never started");
    return handle(new URL(path, "http://127.0.0.1:4321"));
  };
  return {
    flow,
    ask,
    opened,
    written,
    calls,
    get closed() {
      return closed;
    },
  };
}

describe("the flow", () => {
  test("opens the browser on the listener, posts to the org, trades the code, writes both keys", async () => {
    const h = harness();

    const start = await h.ask("/start");
    expect(h.opened).toEqual(["http://127.0.0.1:4321/start"]);
    expect(start.status).toBe(200);
    expect(start.body).toContain(
      "https://github.com/organizations/acme/settings/apps/new?state=STATE",
    );
    expect(start.body).toContain("http://127.0.0.1:4321/callback");

    const back = await h.ask("/callback?code=C0DE&state=STATE");
    expect(back.status).toBe(200);
    expect(back.body).toContain("https://github.com/apps/phoebe-acme/installations/new");

    const created = await h.flow;
    expect(created).toEqual({
      id: "12345",
      slug: "phoebe-acme",
      name: "phoebe-acme",
      owner: "acme",
      htmlUrl: "https://github.com/apps/phoebe-acme",
      installUrl: "https://github.com/apps/phoebe-acme/installations/new",
      envFile: "/repos/fleet/.env",
    });
    expect(h.calls.find((call) => call.url.includes("/app-manifests/"))).toEqual({
      method: "POST",
      url: "https://api.github.com/app-manifests/C0DE/conversions",
    });
    expect(h.written).toEqual([
      ["/repos/fleet", "GH_APP_ID", "12345"],
      ["/repos/fleet", "GH_APP_PRIVATE_KEY", pemEnvValue(PEM)],
    ]);
    expect(h.closed).toBe(1);
  });

  test("a user owner posts to the personal page", async () => {
    const h = harness({ ownerType: "User" });
    const start = await h.ask("/start");
    expect(start.body).toContain('action="https://github.com/settings/apps/new?state=STATE"');
    await h.ask("/callback?code=C0DE&state=STATE");
    await h.flow;
  });

  test("a callback with the wrong state is refused and the flow keeps waiting", async () => {
    const h = harness();
    await h.ask("/start");

    const wrong = await h.ask("/callback?code=C0DE&state=OTHER");
    expect(wrong.status).toBe(400);
    expect(wrong.body).toContain("the state did not match");
    expect(h.written).toEqual([]);

    const right = await h.ask("/callback?code=C0DE&state=STATE");
    expect(right.status).toBe(200);
    await h.flow;
  });

  test("a code GitHub refuses fails the flow, with GitHub's words, and writes nothing", async () => {
    const h = harness({ convert: { status: 404, body: { message: "Not Found" } } });
    await h.ask("/start");

    const back = await h.ask("/callback?code=STALE&state=STATE");
    expect(back.status).toBe(502);
    expect(back.body).toContain("GitHub refused the code (HTTP 404: Not Found)");
    await expect(h.flow).rejects.toThrow("GitHub refused the code (HTTP 404: Not Found)");
    expect(h.written).toEqual([]);
    expect(h.closed).toBe(1);
  });

  test("an operator who never comes back is a timeout, and the listener closes", async () => {
    const h = harness();
    await h.ask("/start");
    await expect(h.flow).rejects.toThrow("did not send the App back within");
    expect(h.closed).toBe(1);
  });

  test("the done page names the install link", () => {
    const page = donePage({
      id: "1",
      slug: "phoebe-acme",
      name: "phoebe-acme",
      owner: "acme",
      htmlUrl: "https://github.com/apps/phoebe-acme",
      installUrl: "https://github.com/apps/phoebe-acme/installations/new",
      envFile: "/repos/fleet/.env",
    });
    expect(page).toContain('href="https://github.com/apps/phoebe-acme/installations/new"');
    expect(page).toContain("phoebe-acme is registered");
  });
});
