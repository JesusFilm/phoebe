// LocalAPI over the shared socket (map #690, #692): the status read, the Serve
// config read, and the URL the two make, against a fake GET.

import { describe, expect, test } from "vite-plus/test";
import {
  parseLocalApiStatus,
  readLocalApiStatus,
  serveConfigProxiesTo,
  tailnetUrlOf,
  type LocalApiGet,
} from "./tailscale-localapi.ts";

const RUNNING = JSON.stringify({
  BackendState: "Running",
  Self: { DNSName: "phoebe.tail4f2c.ts.net." },
  CertDomains: ["phoebe.tail4f2c.ts.net"],
});

describe("parseLocalApiStatus", () => {
  test("reads the state, the DNS name without its dot, and the cert domain", () => {
    expect(parseLocalApiStatus(RUNNING)).toEqual({
      backendState: "Running",
      dnsName: "phoebe.tail4f2c.ts.net",
      certDomain: "phoebe.tail4f2c.ts.net",
    });
  });

  test("before login both names are empty", () => {
    expect(
      parseLocalApiStatus(JSON.stringify({ BackendState: "NeedsLogin", Self: { DNSName: "" } })),
    ).toEqual({
      backendState: "NeedsLogin",
      dnsName: null,
      certDomain: null,
    });
    expect(parseLocalApiStatus("nope")).toBeNull();
  });
});

describe("over the socket", () => {
  const get: LocalApiGet = async (path) => {
    if (path === "/localapi/v0/status?peers=false") return { status: 200, body: RUNNING };
    if (path === "/localapi/v0/serve-config") {
      return {
        status: 200,
        body: JSON.stringify({
          Web: {
            "phoebe.tail4f2c.ts.net:443": {
              Handlers: { "/": { Proxy: "unix:/var/run/phoebe/api.sock" } },
            },
          },
        }),
      };
    }
    return { status: 404, body: "" };
  };

  test("status and the Serve proxy both read", async () => {
    const status = await readLocalApiStatus(get);
    expect(tailnetUrlOf(status)).toBe("https://phoebe.tail4f2c.ts.net");
    expect(await serveConfigProxiesTo(get, "/var/run/phoebe/api.sock")).toBe(true);
    expect(await serveConfigProxiesTo(get, "/elsewhere.sock")).toBe(false);
  });

  test("a daemon that does not answer is null, and a node not yet Running has no URL", async () => {
    const down: LocalApiGet = async () => {
      throw new Error("ENOENT");
    };
    expect(await readLocalApiStatus(down)).toBeNull();
    expect(await serveConfigProxiesTo(down, "/x")).toBeNull();
    expect(
      tailnetUrlOf({ backendState: "Starting", dnsName: "x.ts.net", certDomain: null }),
    ).toBeNull();
  });
});
