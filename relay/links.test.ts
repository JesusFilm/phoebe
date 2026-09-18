// `links.json` and the token registry: what the relay remembers about a
// deployment, and what it deliberately forgets about a token.

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { fingerprintOf } from "../src/ed25519.ts";
import { generateDeploymentKey, type DeploymentKey } from "../bootstrap/relay-key.ts";
import { createLinks, createPairingTokens, LINKS_FILENAME, PAIRING_TOKEN_TTL_MS } from "./links.ts";

const volume = (): string => mkdtempSync(join(tmpdir(), "phoebe-relay-links-"));
const at = (iso: string): Date => new Date(iso);
const NOW = at("2026-09-18T10:00:00.000Z");

/**
 * What `pair` is handed for one deployment: both public halves of its key, as
 * the hello carries them (#549), plus the two strings the relay stores beside
 * them.
 */
const pairing = (
  key: DeploymentKey,
  name: string,
  by = "ops",
): { publicKey: string; boxKey: string; name: string; by: string } => ({
  publicKey: key.publicKey,
  boxKey: key.boxKey,
  name,
  by,
});

describe("links.json", () => {
  test("a relay that has never paired anything knows nobody", () => {
    expect(createLinks(volume()).all()).toEqual([]);
  });

  test("pairing records the public key, the name, and who minted the token", () => {
    const dataDir = volume();
    const key = generateDeploymentKey();
    const link = createLinks(dataDir).pair(pairing(key, "acme/widget", "ops@example.com"), NOW);
    expect(link).toEqual({
      publicKey: key.publicKey,
      boxKey: key.boxKey,
      fingerprint: fingerprintOf(key.publicKey),
      name: "acme/widget",
      firstSeen: NOW.toISOString(),
      lastSeen: NOW.toISOString(),
      pairedBy: "ops@example.com",
    });
  });

  test("the record survives the process that wrote it", () => {
    const dataDir = volume();
    const key = generateDeploymentKey();
    createLinks(dataDir).pair(pairing(key, "widget", "ops"), NOW);
    expect(createLinks(dataDir).find(key.publicKey)?.name).toBe("widget");
  });

  test("a key the relay does not hold is not a deployment", () => {
    const dataDir = volume();
    createLinks(dataDir).pair(pairing(generateDeploymentKey(), "widget", "ops"), NOW);
    expect(createLinks(dataDir).find(generateDeploymentKey().publicKey)).toBeNull();
  });

  test("re-pairing the same key keeps its first sighting and takes the new name", () => {
    const dataDir = volume();
    const key = generateDeploymentKey();
    const links = createLinks(dataDir);
    links.pair(pairing(key, "widget", "ops"), NOW);
    const again = links.pair(
      pairing(key, "widget-renamed", "someone-else"),
      at("2026-09-19T10:00:00.000Z"),
    );
    expect(links.all()).toHaveLength(1);
    expect(again.firstSeen).toBe(NOW.toISOString());
    expect(again.name).toBe("widget-renamed");
  });

  test("two deployments may share a name — the key is the identity", () => {
    const dataDir = volume();
    const links = createLinks(dataDir);
    links.pair(pairing(generateDeploymentKey(), "widget", "ops"), NOW);
    links.pair(pairing(generateDeploymentKey(), "widget", "ops"), NOW);
    expect(links.all()).toHaveLength(2);
    expect(new Set(links.all().map((link) => link.fingerprint)).size).toBe(2);
  });

  test("a completed handshake stamps the link", () => {
    const dataDir = volume();
    const key = generateDeploymentKey();
    const links = createLinks(dataDir);
    links.pair(pairing(key, "widget", "ops"), NOW);
    links.seen(key.publicKey, key.boxKey, at("2026-09-18T11:00:00.000Z"));
    expect(links.find(key.publicKey)?.lastSeen).toBe("2026-09-18T11:00:00.000Z");
  });

  test("a handshake re-records the box key the hello presented (#549)", () => {
    // A deployment whose key file predates box keys grows one on its next boot,
    // under the same signing key. The link has to learn it, or the console has
    // nowhere to encrypt to for a deployment that is plainly connected.
    const dataDir = volume();
    const key = generateDeploymentKey();
    const links = createLinks(dataDir);
    links.pair({ ...pairing(key, "widget"), boxKey: "" }, NOW);
    expect(links.find(key.publicKey)?.boxKey).toBe("");

    links.seen(key.publicKey, key.boxKey, at("2026-09-18T11:00:00.000Z"));

    expect(links.find(key.publicKey)?.boxKey).toBe(key.boxKey);
  });

  test("a links.json written before box keys existed reads as having none", () => {
    // Not a corrupt file and not an error: a link with a signing key and no way
    // to encrypt to it. Every reader downstream sees the empty string rather
    // than an absent field, so there is one shape to handle.
    const dataDir = volume();
    const key = generateDeploymentKey();
    writeFileSync(
      join(dataDir, LINKS_FILENAME),
      JSON.stringify({
        links: [
          {
            publicKey: key.publicKey,
            fingerprint: fingerprintOf(key.publicKey),
            name: "widget",
            firstSeen: NOW.toISOString(),
            lastSeen: NOW.toISOString(),
            pairedBy: "ops",
          },
        ],
      }),
    );

    expect(createLinks(dataDir).find(key.publicKey)?.boxKey).toBe("");
    expect(createLinks(dataDir).all()[0]?.boxKey).toBe("");
  });

  test("a handshake from a key nobody recorded stamps nothing", () => {
    const dataDir = volume();
    const links = createLinks(dataDir);
    const stranger = generateDeploymentKey();
    links.seen(stranger.publicKey, stranger.boxKey, NOW);
    expect(links.all()).toEqual([]);
  });

  test("forgetting deletes the link and hands back what went", () => {
    const dataDir = volume();
    const key = generateDeploymentKey();
    const links = createLinks(dataDir);
    const paired = links.pair(pairing(key, "widget", "ops"), NOW);

    const forgotten = links.forget(paired.fingerprint);

    expect(forgotten).toEqual(paired);
    expect(links.all()).toEqual([]);
    expect(links.find(key.publicKey)).toBeNull();
  });

  test("it takes the one it was asked for and leaves the rest", () => {
    const dataDir = volume();
    const links = createLinks(dataDir);
    const one = links.pair(pairing(generateDeploymentKey(), "widget", "ops"), NOW);
    links.pair(pairing(generateDeploymentKey(), "gadget", "ops"), NOW);

    links.forget(one.fingerprint);

    expect(links.all().map((link) => link.name)).toEqual(["gadget"]);
  });

  test("forgetting what was never there is null, not an error", () => {
    expect(createLinks(volume()).forget("fp-nobody")).toBeNull();
  });

  test("a forgotten deployment that pairs again is a new record", () => {
    const dataDir = volume();
    const links = createLinks(dataDir);
    const first = links.pair(pairing(generateDeploymentKey(), "widget", "ops"), NOW);
    links.forget(first.fingerprint);

    // A wiped volume means a new key, and the key is the identity.
    const second = links.pair(
      pairing(generateDeploymentKey(), "widget", "ops"),
      at("2026-09-19T10:00:00.000Z"),
    );

    expect(second.fingerprint).not.toBe(first.fingerprint);
    expect(second.firstSeen).toBe("2026-09-19T10:00:00.000Z");
  });

  test("a corrupt file reads as an empty relay rather than taking the process down", () => {
    const dataDir = volume();
    writeFileSync(join(dataDir, LINKS_FILENAME), "{ not json");
    expect(createLinks(dataDir).all()).toEqual([]);
  });

  test("the file is written whole, indented, and holds no private material", () => {
    const dataDir = volume();
    const key = generateDeploymentKey();
    createLinks(dataDir).pair(pairing(key, "widget", "ops"), NOW);
    const raw = readFileSync(join(dataDir, LINKS_FILENAME), "utf8");
    expect(JSON.parse(raw)).toHaveProperty("links");
    expect(raw).not.toContain("PRIVATE");
  });
});

describe("pairing tokens", () => {
  test("a minted token is spendable once", () => {
    const tokens = createPairingTokens();
    const { token } = tokens.mint("ops@example.com", NOW);
    expect(tokens.spend(token, NOW)).toEqual({ spent: true, by: "ops@example.com" });
    expect(tokens.spend(token, NOW)).toEqual({ spent: false });
  });

  test("a token nobody minted is refused the same way a spent one is", () => {
    expect(createPairingTokens().spend("guessed", NOW)).toEqual({ spent: false });
  });

  test("it expires on its own, whether or not anybody comes for it", () => {
    const tokens = createPairingTokens();
    const { token } = tokens.mint("ops", NOW);
    const late = new Date(NOW.getTime() + PAIRING_TOKEN_TTL_MS + 1);
    expect(tokens.spend(token, late)).toEqual({ spent: false });
    expect(tokens.outstanding(late)).toBe(0);
  });

  test("the expiry it reports is the one it enforces", () => {
    const tokens = createPairingTokens(60_000);
    const minted = tokens.mint("ops", NOW);
    expect(minted.expiresAt).toBe(new Date(NOW.getTime() + 60_000).toISOString());
    expect(tokens.spend(minted.token, new Date(NOW.getTime() + 59_000))).toMatchObject({
      spent: true,
    });
  });

  test("two mints are two tokens, and both are outstanding until spent", () => {
    const tokens = createPairingTokens();
    const first = tokens.mint("ops", NOW);
    const second = tokens.mint("ops", NOW);
    expect(first.token).not.toBe(second.token);
    expect(tokens.outstanding(NOW)).toBe(2);
    tokens.spend(first.token, NOW);
    expect(tokens.outstanding(NOW)).toBe(1);
  });

  test("the token is long enough that guessing is not a strategy", () => {
    const { token } = createPairingTokens().mint("ops", NOW);
    expect(Buffer.from(token, "base64url")).toHaveLength(32);
  });
});
