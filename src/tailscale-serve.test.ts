// Serve reconciliation on the host arm (map #690): the three outcomes at the
// probe, the refuse-on-foreign-mapping rule from #706, the certificate wait,
// and a `tskey-` that never reaches any line — all against a scripted
// `tailscale` and a fake fetch.

import { describe, expect, test } from "vite-plus/test";
import type { CommandResult, CommandRunner } from "./deployment-compose.ts";
import {
  classifyServeStderr,
  findTailscaleCli,
  inspectServe,
  MACOS_BUNDLE_CLI,
  parseTailscaleStatus,
  probeDescriptor,
  reconcileServe,
  serveTargetOn,
  tailnetUrl,
  type ServeDeps,
} from "./tailscale-serve.ts";

const DNS = "beast.tail4f2c.ts.net";
const OWN = {
  deploymentId: "dep_OWN",
  name: "acme/widget",
  protocol: 1,
  version: "0.15.0",
  arm: "host",
};

function status(backendState = "Running", dnsName: string | null = `${DNS}.`): string {
  return JSON.stringify({ BackendState: backendState, Self: { DNSName: dnsName ?? "" } });
}

function serveConfig(mappings: Record<string, string>): string {
  const Web: Record<string, unknown> = {};
  for (const [site, proxy] of Object.entries(mappings)) {
    Web[site] = { Handlers: { "/": { Proxy: proxy } } };
  }
  return JSON.stringify({ TCP: { "443": { HTTPS: true } }, Web });
}

/** A `tailscale` that answers by argv. */
function fakeCli(answers: {
  status?: CommandResult;
  serveStatus?: CommandResult;
  serveBg?: CommandResult;
}): { run: CommandRunner; calls: string[][] } {
  const calls: string[][] = [];
  const run: CommandRunner = async (spec) => {
    calls.push([...spec.args]);
    const [verb, sub] = spec.args;
    if (verb === "status") return answers.status ?? { code: 0, stdout: status(), stderr: "" };
    if (verb === "serve" && sub === "status") {
      return answers.serveStatus ?? { code: 0, stdout: serveConfig({}), stderr: "" };
    }
    if (verb === "serve" && sub === "--bg")
      return answers.serveBg ?? { code: 0, stdout: "", stderr: "" };
    throw new Error(`unexpected tailscale ${spec.args.join(" ")}`);
  };
  return { run, calls };
}

type Answer = { status: number; body?: unknown } | Error;

/** A fetch that answers by URL; an Error is a transport failure. */
function fakeFetch(answers: Record<string, Answer | Answer[]>): typeof fetch {
  const queue = new Map<string, Answer[]>();
  for (const [url, answer] of Object.entries(answers)) {
    queue.set(url, Array.isArray(answer) ? [...answer] : [answer]);
  }
  return (async (input: string | URL | Request) => {
    const asked = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = asked.replace("/.well-known/phoebe/deployment", "");
    const list = queue.get(url) ?? [];
    const next = list.length > 1 ? list.shift()! : (list[0] ?? new Error(`ECONNREFUSED ${url}`));
    if (next instanceof Error) throw next;
    return new Response(next.body === undefined ? "" : JSON.stringify(next.body), {
      status: next.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

function deps(
  cli: { run: CommandRunner },
  fetchFn: typeof fetch,
  extra: Partial<ServeDeps> = {},
): ServeDeps & { logged: string[] } {
  const logged: string[] = [];
  return {
    run: cli.run,
    fetchFn,
    env: { PATH: "/usr/bin" },
    access: (path) => {
      if (path !== "/usr/bin/tailscale") throw new Error("ENOENT");
    },
    platform: "linux",
    readProcVersion: () => "Linux version 6.6",
    sleep: async () => {},
    log: (line) => logged.push(line),
    logged,
    ...extra,
  };
}

const PORTS = { port: 7463, httpsPort: 443 };
const LOOPBACK = "http://127.0.0.1:7463";
const URL_443 = `https://${DNS}`;

describe("finding the CLI", () => {
  test("PATH first, then the macOS bundle, then tailscale.exe through WSL interop", () => {
    const onPath = findTailscaleCli({
      run: async () => ({ code: 0, stdout: "", stderr: "" }),
      fetchFn: fetch,
      env: { PATH: "/opt/bin:/usr/bin" },
      access: (path) => {
        if (path !== "/usr/bin/tailscale") throw new Error("ENOENT");
      },
      platform: "linux",
      readProcVersion: () => "Linux",
    });
    expect(onPath).toEqual({ file: "/usr/bin/tailscale", via: "path" });

    const bundle = findTailscaleCli({
      run: async () => ({ code: 0, stdout: "", stderr: "" }),
      fetchFn: fetch,
      env: { PATH: "/usr/bin" },
      access: (path) => {
        if (path !== MACOS_BUNDLE_CLI) throw new Error("ENOENT");
      },
      platform: "darwin",
    });
    expect(bundle).toEqual({ file: MACOS_BUNDLE_CLI, via: "macos-bundle" });

    const wsl = findTailscaleCli({
      run: async () => ({ code: 0, stdout: "", stderr: "" }),
      fetchFn: fetch,
      env: { PATH: "/usr/bin" },
      access: () => {
        throw new Error("ENOENT");
      },
      platform: "linux",
      readProcVersion: () => "Linux version 6.6.87.2-microsoft-standard-WSL2",
    });
    expect(wsl).toEqual({ file: "tailscale.exe", via: "wsl-interop" });

    const none = findTailscaleCli({
      run: async () => ({ code: 0, stdout: "", stderr: "" }),
      fetchFn: fetch,
      env: { PATH: "/usr/bin" },
      access: () => {
        throw new Error("ENOENT");
      },
      platform: "linux",
      readProcVersion: () => "Linux version 6.6",
    });
    expect(none).toBeNull();
  });
});

describe("reading the CLI's answers", () => {
  test("status: the trailing dot comes off the DNS name; an empty name is null", () => {
    expect(parseTailscaleStatus(status())).toEqual({ backendState: "Running", dnsName: DNS });
    expect(parseTailscaleStatus(status("NeedsLogin", ""))).toEqual({
      backendState: "NeedsLogin",
      dnsName: null,
    });
    expect(parseTailscaleStatus("not json")).toBeNull();
  });

  test("serve status: the proxy on this node's port, case-insensitive on the host", () => {
    const config = serveConfig({
      [`${DNS.toUpperCase()}:443`]: LOOPBACK,
      [`${DNS}:8443`]: "http://127.0.0.1:3000",
    });
    expect(serveTargetOn(config, DNS, 443)).toBe(LOOPBACK);
    expect(serveTargetOn(config, DNS, 8443)).toBe("http://127.0.0.1:3000");
    expect(serveTargetOn(config, DNS, 5733)).toBeNull();
    expect(serveTargetOn("{}", DNS, 443)).toBeNull();
  });

  test("the tailnet URL carries the port only when it is not 443", () => {
    expect(tailnetUrl(DNS, 443)).toBe(URL_443);
    expect(tailnetUrl(DNS, 8443)).toBe(`https://${DNS}:8443`);
  });

  test("stderr is classified by anchored patterns and never quoted", () => {
    expect(classifyServeStderr("Logged out. Run `tailscale up`")).toBe("not-logged-in");
    expect(classifyServeStderr("error: Access is denied. tskey-auth-abc123")).toBe(
      "permission-denied",
    );
    expect(classifyServeStderr("error: no handler found for 443")).toBe("no-existing-handler");
    expect(classifyServeStderr("something else entirely tskey-xyz")).toBe("unknown");
  });
});

describe("the probe", () => {
  test("a descriptor, an unreachable URL, a stale mapping, and a stranger", async () => {
    const fetchFn = fakeFetch({
      "https://ok": { status: 200, body: OWN },
      "https://stale": { status: 502 },
      "https://other": { status: 200, body: { hello: "world" } },
      "https://teapot": { status: 418 },
    });
    expect(await probeDescriptor("https://ok", fetchFn)).toEqual({
      kind: "descriptor",
      deploymentId: "dep_OWN",
      name: "acme/widget",
    });
    expect((await probeDescriptor("https://stale", fetchFn)).kind).toBe("unreachable");
    expect((await probeDescriptor("https://down", fetchFn)).kind).toBe("unreachable");
    expect((await probeDescriptor("https://other", fetchFn)).kind).toBe("other");
    expect((await probeDescriptor("https://teapot", fetchFn)).kind).toBe("other");
  });
});

describe("reconcileServe", () => {
  test("unreachable on the tailnet: maps it, waits for the certificate, and reports ready", async () => {
    const cli = fakeCli({});
    const fetchFn = fakeFetch({
      [LOOPBACK]: { status: 200, body: OWN },
      // Unreachable before the mapping, then the certificate lands on the second poll.
      [URL_443]: [
        new Error("ECONNREFUSED"),
        new Error("TLS handshake"),
        { status: 200, body: OWN },
      ],
    });
    const d = deps(cli, fetchFn);
    const outcome = await reconcileServe(PORTS, d);
    expect(outcome).toEqual({ state: "ready", url: URL_443 });
    expect(cli.calls).toContainEqual(["serve", "--bg", "--https=443", LOOPBACK]);
    expect(d.logged.join("\n")).toMatch(/waiting for .* certificate/);
  });

  test("a stale mapping (502) is mapped over, like an unreachable one", async () => {
    const cli = fakeCli({
      serveStatus: { code: 0, stdout: serveConfig({ [`${DNS}:443`]: LOOPBACK }), stderr: "" },
    });
    const fetchFn = fakeFetch({
      [LOOPBACK]: { status: 200, body: OWN },
      [URL_443]: [{ status: 502 }, { status: 200, body: OWN }],
    });
    const outcome = await reconcileServe(PORTS, deps(cli, fetchFn));
    expect(outcome).toEqual({ state: "ready", url: URL_443 });
    expect(cli.calls).toContainEqual(["serve", "--bg", "--https=443", LOOPBACK]);
  });

  test("our own descriptor already there: left alone", async () => {
    const cli = fakeCli({});
    const fetchFn = fakeFetch({
      [LOOPBACK]: { status: 200, body: OWN },
      [URL_443]: { status: 200, body: OWN },
    });
    const outcome = await reconcileServe(PORTS, deps(cli, fetchFn));
    expect(outcome).toEqual({ state: "ready", url: URL_443 });
    expect(cli.calls.some((call) => call[1] === "--bg")).toBe(false);
  });

  test("another Phoebe deployment answers there: refused and named", async () => {
    const cli = fakeCli({});
    const fetchFn = fakeFetch({
      [LOOPBACK]: { status: 200, body: OWN },
      [URL_443]: { status: 200, body: { ...OWN, deploymentId: "dep_OTHER", name: "someone/else" } },
    });
    const outcome = await reconcileServe(PORTS, deps(cli, fetchFn));
    expect(outcome.state).toBe("refused");
    expect((outcome as { detail: string }).detail).toMatch(
      /different Phoebe deployment \(someone\/else\)/,
    );
    expect(cli.calls.some((call) => call[1] === "--bg")).toBe(false);
  });

  test("something that is not Phoebe answers there: refused, nothing overwritten", async () => {
    const cli = fakeCli({});
    const fetchFn = fakeFetch({
      [LOOPBACK]: { status: 200, body: OWN },
      [URL_443]: { status: 200, body: { title: "a dashboard" } },
    });
    const outcome = await reconcileServe(PORTS, deps(cli, fetchFn));
    expect(outcome.state).toBe("refused");
    expect((outcome as { detail: string }).detail).toMatch(/not as a Phoebe deployment/);
    expect(cli.calls.some((call) => call[1] === "--bg")).toBe(false);
  });

  test("a mapping on the port that points elsewhere is refused before any probe (#706)", async () => {
    const cli = fakeCli({
      serveStatus: {
        code: 0,
        stdout: serveConfig({ [`${DNS}:443`]: "http://127.0.0.1:3000" }),
        stderr: "",
      },
    });
    // The tailnet URL would even have said "unreachable" — the mapping check wins.
    const fetchFn = fakeFetch({ [LOOPBACK]: { status: 200, body: OWN } });
    const outcome = await reconcileServe(PORTS, deps(cli, fetchFn));
    expect(outcome.state).toBe("refused");
    expect((outcome as { detail: string }).detail).toMatch(
      /already proxies to http:\/\/127\.0\.0\.1:3000/,
    );
    expect(cli.calls.some((call) => call[1] === "--bg")).toBe(false);
  });

  test("the certificate not landing in time is `pending`, with the URL", async () => {
    const cli = fakeCli({});
    const fetchFn = fakeFetch({ [LOOPBACK]: { status: 200, body: OWN } });
    let clock = 0;
    const d = deps(cli, fetchFn, {
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });
    const outcome = await reconcileServe(PORTS, d);
    expect(outcome).toEqual({ state: "pending", url: URL_443 });
    expect(d.logged.join("\n")).toMatch(/certificate is still being issued/);
  });

  test("a logged-out node is refused by state, never as a MagicDNS problem", async () => {
    const cli = fakeCli({ status: { code: 0, stdout: status("NeedsLogin", ""), stderr: "" } });
    const outcome = await inspectServe(PORTS, deps(cli, fakeFetch({})));
    expect(outcome.state).toBe("refused");
    expect((outcome as { detail: string }).detail).toMatch(/NeedsLogin, not Running/);
  });

  test("nothing on loopback is refused with the overlay named", async () => {
    const cli = fakeCli({});
    const outcome = await inspectServe(PORTS, deps(cli, fakeFetch({})));
    expect(outcome.state).toBe("refused");
    expect((outcome as { detail: string }).detail).toMatch(/compose\.tailscale-host\.yml/);
  });

  test("no CLI anywhere is refused with the sidecar arm offered", async () => {
    const cli = fakeCli({});
    const outcome = await inspectServe(
      PORTS,
      deps(cli, fakeFetch({}), {
        access: () => {
          throw new Error("ENOENT");
        },
      }),
    );
    expect(outcome).toEqual({ state: "refused", detail: expect.stringMatching(/sidecar arm/) });
  });

  test("a `tskey-` on the CLI's stderr never appears in the outcome or a log line", async () => {
    const cli = fakeCli({
      status: {
        code: 1,
        stdout: "",
        stderr: "backend error: key tskey-auth-k1234567CNTRL-abcdef rejected",
      },
    });
    const d = deps(cli, fakeFetch({}));
    const outcome = await reconcileServe(PORTS, d);
    const everything = JSON.stringify(outcome) + d.logged.join("\n");
    expect(everything).not.toContain("tskey-");
    expect(outcome.state).toBe("refused");
  });

  test("a non-443 port rides in the URL and the serve argv", async () => {
    const cli = fakeCli({});
    const url = `https://${DNS}:8443`;
    const fetchFn = fakeFetch({
      "http://127.0.0.1:9000": { status: 200, body: OWN },
      [url]: [new Error("ECONNREFUSED"), { status: 200, body: OWN }],
    });
    const outcome = await reconcileServe({ port: 9000, httpsPort: 8443 }, deps(cli, fetchFn));
    expect(outcome).toEqual({ state: "ready", url });
    expect(cli.calls).toContainEqual(["serve", "--bg", "--https=8443", "http://127.0.0.1:9000"]);
  });
});
