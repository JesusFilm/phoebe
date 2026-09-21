// `links.json` on the relay volume: which deployments this relay knows (#505
// §1, #506 §3), and the in-memory pairing tokens that let a new one in.
//
// A **link** is the relay's record of a deployment — public key, name, when it
// was first seen. The other half of the link is the key on the deployment's own
// volume, and neither half depends on the other's process being alive: a
// deployment can be paired while it is down, and a relay can be restarted
// without a deployment noticing anything but a reconnect. Boot reconciles.
//
// **The key is the identity; the name is decoration.** Two deployments may
// share a name and the relay will not care. It keys on the public key, and the
// fingerprint derived from it is what files and URLs are named after.
//
// **Pairing tokens live in memory and nowhere else.** A token is single-use and
// short-lived, so the worst a relay restart can do is void a token the operator
// minted a moment ago — cheap to redo, and cheaper than a credential on a disk.
// The same reasoning keeps them out of `links.json`: a spent token is not
// history worth keeping, it is a secret worth forgetting.

import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fingerprintOf } from "../src/ed25519.ts";

/** The file's name on the relay volume. */
export const LINKS_FILENAME = "links.json";

/** How long a minted pairing token stays spendable (#505 §1). */
export const PAIRING_TOKEN_TTL_MS = 15 * 60_000;

/** One deployment, as the relay records it. */
export type Link = {
  /** Raw Ed25519 public key, base64url — the identity, and the dedupe key. */
  publicKey: string;
  /**
   * Raw X25519 public key, base64url — the **box key** a console seals a secret
   * to (#549). Recorded from the hello that carried it, under a signature that
   * covered it, and re-recorded on every handshake so a deployment that grew a
   * box key on an upgrade is encryptable to as soon as it reconnects.
   *
   * Empty for a link paired by a relay older than box keys: a link with a
   * signing key and no way to encrypt to it. The console shows such a
   * deployment its secrets but cannot set one until it reconnects.
   */
  boxKey: string;
  /** Derived from the key; the name reports and URLs use. */
  fingerprint: string;
  /** What the deployment calls itself. Displayed, never matched on. */
  name: string;
  /** ISO 8601, set when the token was spent. */
  firstSeen: string;
  /** ISO 8601 of the last completed handshake, or null before the first. */
  lastSeen: string | null;
  /** The address that minted the token this link was paired with. */
  pairedBy: string;
};

/** The file's shape. An object, not a bare array, so it can grow a field. */
export type LinksFile = { links: Link[] };

export type Links = {
  /** Every link, in the order they were paired. */
  all: () => Link[];
  /** The link for one public key, or null when the relay knows no such key. */
  find: (publicKey: string) => Link | null;
  /**
   * Record a newly paired deployment. A key the relay already holds keeps its
   * `firstSeen` and takes the new name: re-pairing an existing key is an
   * operator repeating themselves, not a second deployment.
   */
  pair: (
    deployment: { publicKey: string; boxKey: string; name: string; by: string },
    now: Date,
  ) => Link;
  /**
   * Stamp a completed handshake, and re-record the box key it presented. Silent
   * when the key is unknown.
   */
  seen: (publicKey: string, boxKey: string, now: Date) => void;
  /**
   * **Forget** one deployment, by fingerprint (#505 §4). Returns the link that
   * went, or null when this relay never knew it.
   *
   * Deleting the record is the whole of forgetting: there is no tombstone and
   * no revocation list, because the key is the identity and a relay that holds
   * no link for a key has nothing to admit. The deployment hears about it as
   * the `unlinked` close code — on its live connection if it has one, on its
   * next dial otherwise — and stops dialling.
   */
  forget: (fingerprint: string) => Link | null;
};

/** Open `links.json` on `dataDir`. Reads are lazy; writes are atomic. */
export function createLinks(dataDir: string): Links {
  const path = join(dataDir, LINKS_FILENAME);

  /**
   * A missing, unreadable or malformed file is a relay that knows nobody.
   *
   * A file written before box keys existed has no `boxKey` on its links, and
   * every reader downstream treats that field as present-but-empty rather than
   * as optional. Filled in here, on the way out, so there is one place that
   * knows the old shape.
   */
  function read(): LinksFile {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<LinksFile>;
      const links = Array.isArray(parsed.links) ? parsed.links : [];
      return {
        links: links.map((link) => ({
          ...link,
          boxKey: typeof link.boxKey === "string" ? link.boxKey : "",
        })),
      };
    } catch {
      return { links: [] };
    }
  }

  /** Write through a sibling temp file and `rename`, as the allowlist does. */
  function write(file: LinksFile): void {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = join(dirname(path), `.${process.pid}.${LINKS_FILENAME}.tmp`);
    writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, path);
  }

  return {
    all: () => read().links,

    find: (publicKey) => read().links.find((link) => link.publicKey === publicKey) ?? null,

    pair(deployment, now) {
      const file = read();
      const existing = file.links.find((link) => link.publicKey === deployment.publicKey);
      if (existing !== undefined) {
        existing.name = deployment.name;
        existing.boxKey = deployment.boxKey;
        existing.lastSeen = now.toISOString();
        write(file);
        return existing;
      }
      const link: Link = {
        publicKey: deployment.publicKey,
        boxKey: deployment.boxKey,
        fingerprint: fingerprintOf(deployment.publicKey),
        name: deployment.name,
        firstSeen: now.toISOString(),
        lastSeen: now.toISOString(),
        pairedBy: deployment.by,
      };
      file.links.push(link);
      write(file);
      return link;
    },

    seen(publicKey, boxKey, now) {
      const file = read();
      const link = file.links.find((entry) => entry.publicKey === publicKey);
      if (link === undefined) return;
      link.lastSeen = now.toISOString();
      link.boxKey = boxKey;
      write(file);
    },

    forget(fingerprint) {
      const file = read();
      const link = file.links.find((entry) => entry.fingerprint === fingerprint);
      if (link === undefined) return null;
      write({ links: file.links.filter((entry) => entry !== link) });
      return link;
    },
  };
}

/** A minted token, as the console shows it exactly once. */
export type PairingToken = {
  token: string;
  expiresAt: string;
};

export type PairingTokens = {
  /** Mint one. The string is shown once and the relay keeps only its expiry. */
  mint: (by: string, now: Date) => PairingToken;
  /**
   * Spend one, or refuse. Refusal covers unknown, expired and already-spent
   * alike: the relay says `token-spent` to all three, because distinguishing
   * them out loud would tell a guesser which of their guesses was close.
   */
  spend: (token: string, now: Date) => { spent: true; by: string } | { spent: false };
  /** How many are outstanding — what a console shows beside the mint button. */
  outstanding: (now: Date) => number;
};

/**
 * The token registry. In memory by decision, so a restart voids what is
 * unspent; `expiresAt` is enforced on spend rather than on a sweep timer, and
 * expired entries are dropped whenever the map is walked.
 */
export function createPairingTokens(ttlMs: number = PAIRING_TOKEN_TTL_MS): PairingTokens {
  const minted = new Map<string, { expiresAt: number; by: string }>();

  const sweep = (now: Date): void => {
    for (const [token, record] of minted) {
      if (record.expiresAt <= now.getTime()) minted.delete(token);
    }
  };

  return {
    mint(by, now) {
      sweep(now);
      // 256 bits. The token is the only thing standing between a stranger and a
      // link on this relay for the fifteen minutes it lives.
      const token = randomBytes(32).toString("base64url");
      const expiresAt = now.getTime() + ttlMs;
      minted.set(token, { expiresAt, by });
      return { token, expiresAt: new Date(expiresAt).toISOString() };
    },

    spend(token, now) {
      sweep(now);
      const record = minted.get(token);
      if (record === undefined) return { spent: false };
      minted.delete(token);
      return { spent: true, by: record.by };
    },

    outstanding(now) {
      sweep(now);
      return minted.size;
    },
  };
}
