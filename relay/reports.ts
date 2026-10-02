// `reports/<fingerprint>.json` on the relay volume: the latest deployment
// report, per deployment, and nothing else (#542, decided in #501 and #506 §3).
//
// **The latest only.** A report is the whole of what one deployment is doing
// right now, so the one that arrives replaces the one that was there. No
// history, no deltas, no growth with uptime — the same fixed-size rule the
// report itself is written under on the deployment's own volume (#73).
//
// **On disk, so a restart tells the truth.** A relay that kept reports in
// memory would come back from a deploy saying it had never heard of a fleet it
// has been holding for a week — **unseen** where the honest answer is
// last-known plus **dark**. The file is what makes the difference, and it is
// the only reason this is a file at all.
//
// **Opaque, all the way through.** The relay lifts `schema` out of the message
// so a reader can branch on it, and writes the body down without looking
// inside. Nothing here imports the report's type, and nothing here derives a
// pipeline's state from it: derivation lives in the deployment (#501), and a
// relay that recomputed one would be a second opinion a console could catch
// disagreeing with the CLI.
//
// The fingerprint names the file, so every path this module builds is checked
// against the shape `fingerprintOf` produces before it touches the volume. A
// fingerprint arrives from a link most of the time and from a URL the rest of
// it, and only one of those two is trustworthy.

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RelayStoredReport } from "../src/contracts/relay-routes.ts";
import { isFingerprint } from "../src/ed25519.ts";

/** The directory on the relay volume that holds one file per deployment. */
export const REPORTS_DIRNAME = "reports";

/** What a deployment's `report` message carries, once the relay has read its envelope. */
export type IncomingReport = {
  /** The report's own schema integer. */
  schema: number;
  /** The body, exactly as it arrived. */
  report: unknown;
};

export type Reports = {
  /** Replace this deployment's report. Returns what a reader will now see. */
  save: (fingerprint: string, incoming: IncomingReport, now: Date) => RelayStoredReport | null;
  /** The latest report from one deployment, or null when there has been none. */
  find: (fingerprint: string) => RelayStoredReport | null;
  /** Drop one deployment's report — what **forget** does to it. */
  forget: (fingerprint: string) => void;
};

/**
 * Open the report store on `dataDir`. Reads hit the disk every time: the file
 * is the truth, it is kilobytes, and a cache would be one more thing to be
 * wrong after a write from a process that is not this one.
 */
export function createReports(dataDir: string): Reports {
  const dir = join(dataDir, REPORTS_DIRNAME);

  /** The file for a fingerprint, or null when the string is not one. */
  function pathOf(fingerprint: string): string | null {
    return isFingerprint(fingerprint) ? join(dir, `${fingerprint}.json`) : null;
  }

  return {
    save(fingerprint, incoming, now) {
      const path = pathOf(fingerprint);
      if (path === null) return null;
      const stored: RelayStoredReport = {
        fingerprint,
        schema: incoming.schema,
        receivedAt: now.toISOString(),
        report: incoming.report,
      };
      mkdirSync(dir, { recursive: true });
      // Through a temp file and `rename`, the way every other file on either
      // volume is replaced: a console reading mid-write sees the whole old
      // report or the whole new one, never half of either.
      const tmp = join(dir, `.${process.pid}.${fingerprint}.json.tmp`);
      writeFileSync(tmp, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
      renameSync(tmp, path);
      return stored;
    },

    find(fingerprint) {
      const path = pathOf(fingerprint);
      if (path === null) return null;
      // A missing, unreadable or half-parsed file is a relay that has heard no
      // report from this deployment. There is nothing partial to report: the
      // atomic write above means a reader never sees half a file, so anything
      // unreadable here is a volume problem and the honest answer is the same.
      try {
        return JSON.parse(readFileSync(path, "utf8")) as RelayStoredReport;
      } catch {
        return null;
      }
    },

    forget(fingerprint) {
      const path = pathOf(fingerprint);
      if (path === null) return;
      rmSync(path, { force: true });
    },
  };
}
