// The console's build, as the relay hands it out (#543).
//
// The handler is given a directory a test wrote, so the assertions are about the
// rules — which paths it answers, which it leaves alone, what it refuses to read —
// rather than about whatever `vp run -r build` last produced.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createServer, type Server, type ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { CONSOLE_DIR, createConsoleAssets } from "./console-assets.ts";

let dir: string;
let server: Server | null = null;
let origin: string;

/** A bare server that asks the console first and 404s in JSON otherwise. */
async function serve(built: boolean): Promise<void> {
  if (built) {
    writeFileSync(join(dir, "index.html"), "<!doctype html><title>Phoebe console</title>\n");
    mkdirSync(join(dir, "assets"), { recursive: true });
    writeFileSync(join(dir, "assets", "index-abc123.js"), "console.log(1)\n");
    writeFileSync(join(dir, "assets", "index-abc123.css"), ":root{color:red}\n");
  }
  const assets = createConsoleAssets(dir);
  const listener = createServer((request, response) => {
    void assets
      .serve(new URL(request.url ?? "/", "http://relay.test").pathname, response)
      .then((answered) => {
        if (!answered) response.writeHead(404, { "content-type": "application/json" }).end("{}");
      });
  });
  await new Promise<void>((resolve) => listener.listen(0, resolve));
  const address = listener.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  origin = `http://127.0.0.1:${address.port}`;
  server = listener;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "phoebe-console-"));
});

afterEach(async () => {
  if (server !== null) {
    const listener = server;
    server = null;
    await new Promise<void>((resolve, reject) =>
      listener.close((error) => (error ? reject(error) : resolve())),
    );
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("where the build is", () => {
  test("is a directory of the package the relay itself ships in", () => {
    // Not a setting: the relay finds the console because they ship together, in a
    // checkout and in node_modules alike.
    expect(basename(CONSOLE_DIR)).toBe("console");
    const manifest = JSON.parse(readFileSync(join(CONSOLE_DIR, "..", "package.json"), "utf8")) as {
      name: string;
      files: string[];
    };
    expect(manifest.name).toBe("phoebe-agent");
    // And the package publishes it, which is the whole point of building there.
    expect(manifest.files).toContain("console");
  });

  test("a publish builds it, because the build is generated and not committed", () => {
    // `console/` is gitignored, so a publish from a clean checkout would ship a
    // relay whose pages 503 unless something builds first. `prepublishOnly` is
    // where that lives rather than in the release workflow: it fires on
    // `npm publish` — which is what `changeset publish` shells out to — and not
    // on `npm pack`, so it cannot slow the packaging checks down.
    const manifest = JSON.parse(readFileSync(join(CONSOLE_DIR, "..", "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(manifest.scripts.prepublishOnly).toContain("build");
  });
});

describe("the path a request names", () => {
  test("never resolves outside the build, however it is spelled", async () => {
    // Through `serve` directly: a `fetch` client normalizes `..` out of a URL
    // before it reaches the wire, so the only way to hand the relay a traversal
    // is to hand it one.
    const assets = createConsoleAssets(dir);
    writeFileSync(join(dir, "index.html"), "<!doctype html>\n");
    writeFileSync(join(dir, "..", "phoebe-console-outside.txt"), "secret\n");

    for (const path of [
      "/../phoebe-console-outside.txt",
      "/assets/../../phoebe-console-outside.txt",
      "/%2e%2e/phoebe-console-outside.txt",
      "/..%2f..%2fetc%2fpasswd",
      "/assets/%00../index.html",
      "/%zz",
    ]) {
      const written: string[] = [];
      const answered = await assets.serve(path, fakeResponse(written));
      expect(written.join(""), path).not.toContain("secret");
      // Either refused outright, or resolved to a file inside the build that is
      // not there — never the file outside it.
      expect(answered, path).toBe(false);
    }

    rmSync(join(dir, "..", "phoebe-console-outside.txt"), { force: true });
  });
});

describe("a built console", () => {
  beforeEach(() => serve(true));

  test("the root is the document every hash route is served under", async () => {
    const response = await fetch(`${origin}/`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await response.text()).toContain("Phoebe console");
  });

  test("the document is never cached, so a new build is picked up", async () => {
    expect((await fetch(`${origin}/`)).headers.get("cache-control")).toBe("no-cache");
  });

  test("a hashed asset is immutable, because its name carries its content", async () => {
    const response = await fetch(`${origin}/assets/index-abc123.js`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(response.headers.get("cache-control")).toContain("immutable");
  });

  test("stylesheets get their own type rather than a byte stream", async () => {
    expect((await fetch(`${origin}/assets/index-abc123.css`)).headers.get("content-type")).toBe(
      "text/css; charset=utf-8",
    );
  });

  test("a path with no file behind it is left for the caller to refuse", async () => {
    // No single-page fallback: the console routes on the hash, so a 404 here is
    // the relay still being able to say a route does not exist.
    const response = await fetch(`${origin}/nope`);

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
  });

  test("a directory is not a file, and is not served as one", async () => {
    expect((await fetch(`${origin}/assets`)).status).toBe(404);
  });

  test("a HEAD carries the headers and no body", async () => {
    const response = await fetch(`${origin}/assets/index-abc123.js`, { method: "HEAD" });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
  });
});

describe("a package assembled without building the console", () => {
  beforeEach(() => serve(false));

  test("says so in a sentence at the root, and blames itself", async () => {
    const response = await fetch(`${origin}/`);

    expect(response.status).toBe(503);
    expect(response.headers.get("content-type")).toContain("text/plain");
    const body = await response.text();
    expect(body).toContain("console's build is not in this package");
    expect(body).toContain("vp run -r build");
  });

  test("an asset request is not answered with prose", async () => {
    expect((await fetch(`${origin}/assets/index-abc123.js`)).status).toBe(404);
  });

  test("reports itself unbuilt, which is what the start-up line reads", () => {
    expect(createConsoleAssets(dir).built).toBe(false);
  });
});

/** Just enough of `ServerResponse` for `serve` to write into. */
function fakeResponse(written: string[]): ServerResponse {
  const response = {
    writeHead: () => response,
    end: (body?: unknown) => {
      if (typeof body === "string") written.push(body);
      else if (body instanceof Buffer) written.push(body.toString("utf8"));
      return response;
    },
  };
  return response as unknown as ServerResponse;
}
