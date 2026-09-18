// `devices.json` and the code that mints a row in it (#554).
//
// The two halves are tested together because they are one story: a code is
// spent, a token comes out, and from then on the token is the only way back to
// the person. What each test holds is the part of that story a mistake would be
// silent in — a token written to the volume in the clear, a code that works
// twice, a verifier that does not match being taken anyway.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { DEVICE_CODE_TTL_MS } from "../src/contracts/relay-routes.ts";
import {
  bearerToken,
  createDeviceCodes,
  createDevices,
  DEVICES_FILENAME,
  hashToken,
  LAST_SEEN_RESOLUTION_MS,
  MAX_DEVICE_NAME,
} from "./devices.ts";
import { pkceChallenge } from "./oidc.ts";

const ADA = { sub: "sub-ada", email: "ada@example.test" };
const NOW = new Date("2026-09-18T12:00:00.000Z");

/** `seconds` after `NOW`. */
function later(seconds: number): Date {
  return new Date(NOW.getTime() + seconds * 1000);
}

describe("the device store", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "phoebe-devices-"));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  function volume(): string {
    return readFileSync(join(dataDir, DEVICES_FILENAME), "utf8");
  }

  test("issues an opaque bearer and writes down only its hash", () => {
    const devices = createDevices(dataDir);

    const { token, device } = devices.issue(ADA, "ada-mbp (macOS)", NOW);

    expect(token).toEqual(expect.any(String));
    expect(volume()).not.toContain(token);
    expect(volume()).toContain(hashToken(token));
    expect(device).toEqual({
      id: expect.any(String),
      sub: "sub-ada",
      email: "ada@example.test",
      name: "ada-mbp (macOS)",
      createdAt: NOW.toISOString(),
      lastSeenAt: null,
    });
  });

  test("the id a remove names is not a piece of the token's digest", () => {
    const devices = createDevices(dataDir);

    const { token, device } = devices.issue(ADA, "ada-mbp", NOW);

    expect(hashToken(token)).not.toContain(device.id);
    expect(device.id).not.toContain(hashToken(token).slice(0, 8));
  });

  test("a bearer finds its device; a stranger's finds nothing", () => {
    const devices = createDevices(dataDir);
    const { token } = devices.issue(ADA, "ada-mbp", NOW);

    expect(devices.authenticate(token, NOW)?.sub).toBe("sub-ada");
    expect(devices.authenticate("made-up", NOW)).toBeNull();
    expect(devices.authenticate(undefined, NOW)).toBeNull();
    expect(devices.authenticate("", NOW)).toBeNull();
  });

  test("the record carries no hash out to a caller", () => {
    const devices = createDevices(dataDir);
    devices.issue(ADA, "ada-mbp", NOW);

    expect(devices.list()[0]).not.toHaveProperty("tokenHash");
  });

  test("last seen is stamped, but not on every request", () => {
    const devices = createDevices(dataDir);
    const { token } = devices.issue(ADA, "ada-mbp", NOW);

    const first = devices.authenticate(token, NOW);
    const straightAfter = devices.authenticate(token, later(1));
    const muchLater = devices.authenticate(token, later(LAST_SEEN_RESOLUTION_MS / 1000 + 1));

    expect(first?.lastSeenAt).toBe(NOW.toISOString());
    expect(straightAfter?.lastSeenAt).toBe(NOW.toISOString());
    expect(muchLater?.lastSeenAt).toBe(later(LAST_SEEN_RESOLUTION_MS / 1000 + 1).toISOString());
  });

  test("a token survives a fresh handle on the same volume — which is a relay restart", () => {
    const { token } = createDevices(dataDir).issue(ADA, "ada-mbp", NOW);

    expect(createDevices(dataDir).authenticate(token, NOW)?.email).toBe("ada@example.test");
  });

  test("revoking a bearer ends it and leaves the others alone", () => {
    const devices = createDevices(dataDir);
    const mine = devices.issue(ADA, "ada-mbp", NOW);
    const theirs = devices.issue(ADA, "ada-desktop", NOW);

    devices.revoke(mine.token);

    expect(devices.authenticate(mine.token, NOW)).toBeNull();
    expect(devices.authenticate(theirs.token, NOW)).not.toBeNull();
  });

  test("removing by id takes one device; removing by sub takes a person's whole set", () => {
    const devices = createDevices(dataDir);
    const mine = devices.issue(ADA, "ada-mbp", NOW);
    devices.issue(ADA, "ada-desktop", NOW);
    const bob = devices.issue({ sub: "sub-bob", email: "bob@example.test" }, "bob-pc", NOW);

    expect(devices.remove({ id: mine.device.id })).toBe(1);
    expect(devices.remove({ sub: "sub-ada" })).toBe(1);
    expect(devices.remove({ sub: "sub-ada" })).toBe(0);
    expect(devices.authenticate(bob.token, NOW)?.sub).toBe("sub-bob");
  });

  test("a name is trimmed and capped; an empty one still names something", () => {
    const devices = createDevices(dataDir);

    const long = devices.issue(ADA, "x".repeat(MAX_DEVICE_NAME + 50), NOW);
    const blank = devices.issue(ADA, "   ", NOW);

    expect(long.device.name).toHaveLength(MAX_DEVICE_NAME);
    expect(blank.device.name).toBe("a companion");
  });

  test("a missing or unreadable file is a relay nobody has signed a companion in to", () => {
    expect(createDevices(join(dataDir, "not-there")).list()).toEqual([]);
  });
});

describe("the one-time code", () => {
  const VERIFIER = "a".repeat(43);
  const GRANT = { ...ADA, name: "ada-mbp", challenge: pkceChallenge(VERIFIER) };

  test("spends once, for the verifier it was bound to", () => {
    const codes = createDeviceCodes();
    const code = codes.mint(GRANT, 0);

    expect(codes.spend(code, VERIFIER, 0)).toEqual({ ...ADA, name: "ada-mbp" });
    expect(codes.spend(code, VERIFIER, 0)).toBeNull();
  });

  test("a wrong verifier is refused, and burns the code with it", () => {
    const codes = createDeviceCodes();
    const code = codes.mint(GRANT, 0);

    // The scheme hop is the exposure: any app on the machine can register
    // `phoebe://` and be handed the code. Only the verifier tells them apart,
    // and a guess must not leave the code there for the next guess.
    expect(codes.spend(code, "b".repeat(43), 0)).toBeNull();
    expect(codes.spend(code, VERIFIER, 0)).toBeNull();
  });

  test("expires after sixty seconds", () => {
    const codes = createDeviceCodes();
    const code = codes.mint(GRANT, 0);

    expect(codes.spend(code, VERIFIER, DEVICE_CODE_TTL_MS + 1)).toBeNull();
  });

  test("a code nobody minted is not a grant", () => {
    const codes = createDeviceCodes();

    expect(codes.spend("guessed", VERIFIER, 0)).toBeNull();
    expect(codes.spend(undefined, VERIFIER, 0)).toBeNull();
    expect(codes.spend("x", undefined, 0)).toBeNull();
  });
});

describe("the bearer header", () => {
  test("reads the token out, whatever case the scheme is written in", () => {
    expect(bearerToken("Bearer abc")).toBe("abc");
    expect(bearerToken("bearer abc")).toBe("abc");
    expect(bearerToken("  Bearer abc  ")).toBe("abc");
  });

  test("is not fooled by another scheme or by nothing at all", () => {
    expect(bearerToken("Basic abc")).toBeUndefined();
    expect(bearerToken("Bearer")).toBeUndefined();
    expect(bearerToken("Bearer ")).toBeUndefined();
    expect(bearerToken(undefined)).toBeUndefined();
  });
});
