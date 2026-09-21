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

/** What `add` did. Adding someone already listed is not an edit, and says so. */
export type Addition =
  | { kind: "added"; entry: AllowlistEntry }
  | { kind: "already-listed"; entry: AllowlistEntry }
  | { kind: "bad-email" };

/**
 * What `remove` did. The refusals are the two the People page has to word
 * differently: an address nobody holds, and one the environment holds.
 *
 * Removing yourself is not among them. The list does not know who is asking —
 * that is the session's fact, and the route that holds one enforces it.
 */
export type Removal =
  | { kind: "removed"; entry: AllowlistEntry }
  | { kind: "from-environment" }
  | { kind: "no-such-person" };

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
  /**
   * Add one person by address, stamped with the address of whoever added them
   * (#505 §6). No `sub`: the operator typed the only thing a human knows, and
   * the first login that matches fills the rest in.
   */
  add: (email: string, by: string, now: Date) => Addition;
  /**
   * Remove one person by address. An environment entry is refused rather than
   * deleted — it is not in the file to delete, and it would come back at the
   * next start, which would make the UI a liar.
   */
  remove: (email: string) => Removal;
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

  /** The file's entries, then every environment entry the file does not name. */
  function all(): AllowlistEntry[] {
    const fromFile = read().entries;
    const known = new Set(fromFile.map((entry) => entry.email));
    return [...fromFile, ...fromEnvironment.filter((entry) => !known.has(entry.email))];
  }

  return {
    entries: all,

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

    add(rawEmail, by, now) {
      const email = normalizeEmail(rawEmail);
      if (email === null) return { kind: "bad-email" };

      const listed = all().find((entry) => entry.email === email);
      if (listed !== undefined) return { kind: "already-listed", entry: listed };

      const entry: AllowlistEntry = { email, addedBy: by, addedAt: now.toISOString() };
      const file = read();
      file.entries.push(entry);
      write(file);
      return { kind: "added", entry };
    },

    remove(rawEmail) {
      const email = normalizeEmail(rawEmail);
      if (email === null) return { kind: "no-such-person" };

      const file = read();
      const entry = file.entries.find((candidate) => candidate.email === email);
      if (entry === undefined) {
        return fromEnvironment.some((candidate) => candidate.email === email)
          ? { kind: "from-environment" }
          : { kind: "no-such-person" };
      }
      write({ entries: file.entries.filter((candidate) => candidate !== entry) });
      return { kind: "removed", entry };
    },
  };
}

/**
 * One typed address as the list stores them, or null when it is not an address
 * at all. Trimmed and lowercased, because Google's `email` claim is not
 * case-normalised and a person who types `Ada@` must match the login that
 * arrives as `ada@`.
 *
 * The shape check is deliberately the weakest one that still means something:
 * one `@`, something either side, no whitespace. Whether an address exists is
 * Google's answer, not a regular expression's, and a stricter pattern here only
 * ever refuses a real person their real address.
 */
export function normalizeEmail(raw: string): string | null {
  const email = raw.trim().toLowerCase();
  const at = email.indexOf("@");
  if (at < 1 || at !== email.lastIndexOf("@")) return null;
  if (at === email.length - 1) return null;
  if (/\s/.test(email)) return null;
  return email;
}

/**
 * Is this entry the person holding the session asking? On `sub` where there is
 * one, on the address otherwise — the same order `admit` matches in, so an
 * entry that has seen a login is judged by the identity Google keys, and one
 * that has not is judged by the only thing it carries.
 */
export function isSelf(entry: AllowlistEntry, identity: VerifiedIdentity): boolean {
  if (entry.sub !== undefined) return entry.sub === identity.sub;
  return entry.email === identity.email.toLowerCase();
}
