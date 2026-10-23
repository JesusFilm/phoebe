// `remotes.json`: the deployments this companion is paired with over Tailscale
// (map #690; decided in #697 and #699), one record per deployment.
//
// What is stored is what a relaunch needs and nothing a read could derive: the
// URL and the label it was paired with, the session's scopes and expiry, the
// last thing heard and the last report (so a relaunch dates darkness from real
// last contact and a page is never empty), and the notified map (so a relaunch
// re-fires nothing already notified and can still clear what it raised). The
// bearer is not here; it is in the vault (vault.ts), keyed the same way.
//
// **Keyed on `deploymentId`.** A pairing whose descriptor names an id already
// held replaces that record's bearer and keeps its label, last report and
// notified map — that is "pair again". A local install whose report carries
// the same id is the same deployment with a second route, which the console
// draws from the two lists; nothing here joins them.
//
// Reachability is not stored. It is the supervisor's live reading
// (remote-supervisor.ts), derived afresh at every launch from `lastHeardAt`.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { NotifiedAlerts, RemoteRecord, StoredReport } from "phoebe-agent/contracts";

/** The file in `userData`. */
export const REMOTES_FILE = "remotes.json";

/** One record as the file holds it: the contract's record minus its live reading, plus the alert bookkeeping. */
export type StoredRemote = Omit<RemoteRecord, "reachability" | "blocked"> & {
  /** Last notified per condition — the companion's `alerts.json` for this remote. */
  notified: NotifiedAlerts;
  /** The first evaluation after a pair seeded the map and said nothing; every later one speaks. */
  seeded: boolean;
};

export type RemotesFile = { version: 1; remotes: StoredRemote[] };

export const EMPTY_REMOTES: RemotesFile = { version: 1, remotes: [] };

/** A missing, unreadable or malformed file is a companion paired with nothing. */
export function readRemotesFile(
  path: string,
  readFile: (target: string) => string = (target) => readFileSync(target, "utf8"),
): RemotesFile {
  let raw: string;
  try {
    raw = readFile(path);
  } catch {
    return EMPTY_REMOTES;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<RemotesFile>;
    if (!Array.isArray(parsed.remotes)) return EMPTY_REMOTES;
    return { version: 1, remotes: parsed.remotes.filter(isStoredRemote) };
  } catch {
    return EMPTY_REMOTES;
  }
}

/** Through a sibling temp file and `rename`, as every file the companion keeps is. */
export function writeRemotesFile(path: string, file: RemotesFile): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${process.pid}.${REMOTES_FILE}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

export type RemoteStore = {
  list: () => StoredRemote[];
  get: (deploymentId: string) => StoredRemote | null;
  /** Add or replace one record whole. */
  put: (record: StoredRemote) => void;
  /** Change some fields of one record; null when there is no such record. */
  patch: (deploymentId: string, fields: Partial<StoredRemote>) => StoredRemote | null;
  remove: (deploymentId: string) => boolean;
};

/** Open the store. Every read is a read of the file, so nothing here goes stale. */
export function createRemoteStore(options: {
  path: string;
  readFile?: (path: string) => string;
  writeFile?: (path: string, file: RemotesFile) => void;
}): RemoteStore {
  const read = (): RemotesFile => readRemotesFile(options.path, options.readFile);
  const write = (file: RemotesFile): void =>
    (options.writeFile ?? writeRemotesFile)(options.path, file);
  return {
    list: () => read().remotes,
    get: (deploymentId) =>
      read().remotes.find((record) => record.deploymentId === deploymentId) ?? null,
    put(record) {
      const file = read();
      const others = file.remotes.filter((held) => held.deploymentId !== record.deploymentId);
      write({ version: 1, remotes: [...others, record] });
    },
    patch(deploymentId, fields) {
      const file = read();
      const index = file.remotes.findIndex((record) => record.deploymentId === deploymentId);
      if (index === -1) return null;
      const next = { ...file.remotes[index]!, ...fields };
      file.remotes[index] = next;
      write(file);
      return next;
    },
    remove(deploymentId) {
      const file = read();
      const kept = file.remotes.filter((record) => record.deploymentId !== deploymentId);
      if (kept.length === file.remotes.length) return false;
      write({ version: 1, remotes: kept });
      return true;
    },
  };
}

/** The record a pair makes, before anything has been heard. */
export function freshRemote(fields: {
  deploymentId: string;
  url: string;
  name: string;
  label: string;
  arm: "sidecar" | "host";
  protocol: number;
  scopes: StoredRemote["scopes"];
  expiresAt: string;
  sessionId: string | null;
  pairedAt: string;
}): StoredRemote {
  return {
    ...fields,
    lastHeardAt: null,
    lastReport: null,
    notified: {},
    seeded: false,
  };
}

/** Enough of a shape check that a foreign or truncated entry is not a remote. */
function isStoredRemote(value: unknown): value is StoredRemote {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<StoredRemote>;
  return (
    typeof record.deploymentId === "string" &&
    typeof record.url === "string" &&
    typeof record.label === "string" &&
    Array.isArray(record.scopes) &&
    typeof record.expiresAt === "string"
  );
}

/** The record as the window sees it: the stored fields with the live reading on top. */
export function recordOf(
  stored: StoredRemote,
  reading: { reachability: RemoteRecord["reachability"]; blocked?: RemoteRecord["blocked"] },
): RemoteRecord {
  const { notified: _notified, seeded: _seeded, ...fields } = stored;
  return {
    ...fields,
    reachability: reading.reachability,
    ...(reading.blocked !== undefined ? { blocked: reading.blocked } : {}),
  };
}

export type { StoredReport };
