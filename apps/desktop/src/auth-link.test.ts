// What the companion will and will not take from a URL the OS handed it.
//
// Any program on the machine can ask the shell to open `phoebe://auth?code=…`,
// so this parser is attacker-reachable. It is not what makes a forged code
// useless — the PKCE verifier on the exchange is — but it is what keeps a
// malformed URL from being an exception in main.

import { describe, expect, test } from "vite-plus/test";
import { authCodeIn, authCodeInArgv } from "./auth-link.ts";

describe("the sign-in deep link", () => {
  test("reads the one-time code out", () => {
    expect(authCodeIn("phoebe://auth?code=abc123")).toBe("abc123");
    expect(authCodeIn("phoebe://auth/?code=abc123")).toBe("abc123");
  });

  test("decodes a code that had to be escaped to fit in a query", () => {
    expect(authCodeIn("phoebe://auth?code=a%2Fb%2Bc")).toBe("a/b+c");
  });

  test("is not the console's own host on the same scheme", () => {
    expect(authCodeIn("phoebe://console/index.html?code=abc")).toBeNull();
  });

  test("is not another scheme, a missing code, or a string that is not a URL", () => {
    expect(authCodeIn("https://auth?code=abc")).toBeNull();
    expect(authCodeIn("phoebe://auth")).toBeNull();
    expect(authCodeIn("phoebe://auth?code=")).toBeNull();
    expect(authCodeIn("not a url")).toBeNull();
  });

  test("finds the link among an app's own arguments, which is how Windows delivers it", () => {
    expect(
      authCodeInArgv(["/opt/phoebe/phoebe", "--allow-file-access", "phoebe://auth?code=abc123"]),
    ).toBe("abc123");
    expect(authCodeInArgv(["/opt/phoebe/phoebe", "--dev"])).toBeNull();
  });
});
