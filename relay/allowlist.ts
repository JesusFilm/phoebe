// `allowlist.json` on the relay volume: who may sign in (#505 §6, #499 §7).
//
// Three rules decide every login, and they are all here:
//
//  1. A person is keyed on Google's `sub`, never on their address. Google says
//     `sub` is unique and never reused and that email is not an identifier; an
//     address can change hands, and the operator who typed one into the People
//     page typed the only thing a human knows.
//  2. The operator therefore adds emails, and the first login that matches one
//     back-fills the `sub` beside it. From then on the match is on `sub` and
//     the recorded address merely follows what Google reports.
//  3. An empty list is an unclaimed relay: the first verified login seeds it
//     and gets in. `ALLOWED_EMAILS` merges in at every start, so a production
//     relay with that variable filled is never unclaimed and the seed never
//     fires — which is the point of the variable (#499 §7, "exposure window").
//
// Entries from `ALLOWED_EMAILS` are *not* written to the file. They are the
// environment's entries, recomputed at every start, and the People page shows
// them as "from environment" and refuses to remove them: lockout recovery is
// editing that variable and restarting, which only works if the file is not
// quietly holding a copy.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** One person on the list. `sub` is absent until their first login fills it. */
export type AllowlistEntry = {
  /** Google's subject identifier, once seen. */
  sub?: string;
  /** Lowercased address — what the operator typed, or what Google reported. */
  email: string;
  /** `bootstrap` for the seeding login, `environment` for `ALLOWED_EMAILS`. */
  addedBy: string;
  /** ISO 8601. */
  addedAt: string;
};

/** The file's shape. An object, not a bare array, so it can grow a field. */
export type AllowlistFile = { entries: AllowlistEntry[] };

/** The verified identity a login presents to the list. */
export type VerifiedIdentity = { sub: string; email: string };

/** What `admit` decided. */
export type Admission =
  | { kind: "seeded"; entry: AllowlistEntry }
  | { kind: "matched"; entry: AllowlistEntry }
  | { kind: "refused" };

export type Allowlist = {
  /** Every entry the relay knows, the file's first and the environment's after. */
  entries: () => AllowlistEntry[];
  /**
   * Decide one login: seed, match, or refuse. `now` stamps a seeded entry.
   *
   * Synchronous on purpose. A single Node process cannot interleave
   * synchronous code, so read-decide-write is itself the write lock the
   * research asks for and two simultaneous first logins cannot both seed.
   */
  admit: (identity: VerifiedIdentity, now: Date) => Admission;
};

/** The name the file has on the relay volume. */
export const ALLOWLIST_FILENAME = "allowlist.json";

// Environment entries predate every login by construction; a fixed timestamp
// says "as old as this relay" without inventing a moment that never happened.
const EPOCH = "1970-01-01T00:00:00.000Z";

/**
 * Open the allowlist on `dataDir`, merging `allowedEmails` (`ALLOWED_EMAILS`,
 * already parsed and lowercased) as unremovable environment entries.
 */
export function createAllowlist(dataDir: string, allowedEmails: readonly string[]): Allowlist {
  const path = join(dataDir, ALLOWLIST_FILENAME);
  const fromEnvironment: AllowlistEntry[] = allowedEmails.map((email) => ({
    email,
    addedBy: "environment",
    addedAt: EPOCH,
  }));

  /** A missing, unreadable or malformed file is an empty list — unclaimed. */
  function read(): AllowlistFile {
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      return { entries: [] };
    }
    try {
      const parsed = JSON.parse(raw) as Partial<AllowlistFile>;
      return { entries: Array.isArray(parsed.entries) ? parsed.entries : [] };
    } catch {
      return { entries: [] };
    }
  }

  /** Write through a sibling temp file and `rename`, as `status.json` does. */
  function write(file: AllowlistFile): void {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = join(dirname(path), `.${process.pid}.${ALLOWLIST_FILENAME}.tmp`);
    writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, path);
  }

  return {
    entries() {
      const fromFile = read().entries;
      const known = new Set(fromFile.map((entry) => entry.email));
      return [...fromFile, ...fromEnvironment.filter((entry) => !known.has(entry.email))];
    },

    admit(identity, now) {
      const email = identity.email.toLowerCase();
      const file = read();

      if (file.entries.length === 0 && fromEnvironment.length === 0) {
        const entry: AllowlistEntry = {
          sub: identity.sub,
          email,
          addedBy: "bootstrap",
          addedAt: now.toISOString(),
        };
        write({ entries: [entry] });
        return { kind: "seeded", entry };
      }

      const bySub = file.entries.find((entry) => entry.sub === identity.sub);
      if (bySub) {
        // Google reports the current address; the record follows it.
        if (bySub.email !== email) {
          bySub.email = email;
          write(file);
        }
        return { kind: "matched", entry: bySub };
      }

      const byEmail = file.entries.find(
        (entry) => entry.sub === undefined && entry.email === email,
      );
      if (byEmail) {
        byEmail.sub = identity.sub;
        write(file);
        return { kind: "matched", entry: byEmail };
      }

      // An environment entry keeps no `sub`: it is defined by the address in
      // the variable and comes back with that address at the next start, so
      // there is nowhere durable to put one.
      const fromVariable = fromEnvironment.find((entry) => entry.email === email);
      if (fromVariable) return { kind: "matched", entry: fromVariable };

      return { kind: "refused" };
    },
  };
}
