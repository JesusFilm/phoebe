// `companion.json` — the one file the companion owns (#527 §12).
//
// It lives in Electron's `userData` and holds three things: the local installs
// the operator has added, the relay this companion is paired with, and the
// preferences. That is all it holds. Every fact *about* an install — whether the
// folder is initialised, whether its container is up, what its config says — is
// derived on each read (install-facts.ts), because a fact written here is a fact
// that goes stale the moment someone runs `docker stop` in a terminal.
//
// An install's identity is its absolute directory. No generated id: the operator
// already has one name for this thing, and a second one is a second thing that
// can disagree with the first.
//
// The device token is not in here. It sits beside this file in the OS keyring
// (#523 §5, #554), because a file in `userData` is a file a backup tool copies.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { CompanionPreferences, InstallPatch } from "phoebe-agent/contracts";

/** The file's name under `userData`. */
export const COMPANION_FILE = "companion.json";

/** One stored install: a directory and when it was added. Nothing else. */
export type StoredInstall = {
  dir: string;
  addedAt: string;
  /** The display name the operator gave it, when they did. Absent means the folder's. */
  name?: string;
};

/** The whole file. */
export type CompanionFile = {
  installs: StoredInstall[];
  /** The relay this companion is paired with. #554 writes it at sign-in. */
  relay: { url: string } | null;
  preferences: CompanionPreferences;
};

/** What a companion with nothing in it looks like. */
export function emptyCompanionFile(): CompanionFile {
  return {
    installs: [],
    relay: null,
    preferences: { notifications: true, consoleTheme: "system" },
  };
}

/**
 * Read the file, or the empty one when it is not there yet.
 *
 * A file that does not parse **throws**. The alternative — starting empty over
 * the top of it — loses the operator's install list to a stray editor save and
 * says nothing; main turns this into a refusal that names the path, and the
 * operator fixes or deletes a file they can see.
 *
 * Fields that parse but are the wrong shape are dropped one by one instead. A
 * junk `preferences` block is not a reason to lose the installs beside it.
 */
export function readCompanionFile(file: string): CompanionFile {
  if (!existsSync(file)) return emptyCompanionFile();
  const raw = readFileSync(file, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `${file} does not parse as JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return coerce(parsed);
}

/**
 * Write the file. Through a temporary beside it, then a rename, so a crash
 * mid-write leaves the previous list rather than half of the new one.
 */
export function writeCompanionFile(file: string, contents: CompanionFile): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.writing`;
  writeFileSync(temporary, `${JSON.stringify(contents, null, 2)}\n`, "utf8");
  renameSync(temporary, file);
}

/**
 * Add a directory to the list. Absolute, and already present is a no-op rather
 * than a duplicate or an error — the operator asking twice for the same folder
 * means they want it there, which it is.
 */
export function addInstall(contents: CompanionFile, dir: string, addedAt: string): CompanionFile {
  // A typed path has to be a whole one. Resolving a relative one against the
  // companion's own working directory would record a folder nobody named.
  if (!path.isAbsolute(dir)) {
    throw new Error(`${dir} is not a full path. Type the folder's path from its root.`);
  }
  const absolute = path.resolve(dir);
  if (contents.installs.some((install) => install.dir === absolute)) return contents;
  return { ...contents, installs: [...contents.installs, { dir: absolute, addedAt }] };
}

/**
 * Change one install's own settings: its display name, or the folder it points
 * at. The entry keeps its date, and its name when only the folder moves. A
 * folder another entry already has is refused: two entries for one folder
 * would be two rail rows driving one container.
 */
export function updateInstall(
  contents: CompanionFile,
  dir: string,
  patch: InstallPatch,
): CompanionFile {
  const absolute = path.resolve(dir);
  const current = contents.installs.find((install) => install.dir === absolute);
  if (current === undefined) throw new Error(`${dir} is not an install this companion knows.`);
  let next: StoredInstall = { ...current };
  if (patch.label !== undefined) {
    const label = patch.label?.trim() ?? "";
    if (label === "") delete next.name;
    else next = { ...next, name: label };
  }
  if (patch.dir !== undefined) {
    if (!path.isAbsolute(patch.dir)) {
      throw new Error(`${patch.dir} is not a full path. Pick the folder from its root.`);
    }
    const moved = path.resolve(patch.dir);
    if (moved !== absolute && contents.installs.some((install) => install.dir === moved)) {
      throw new Error(`${moved} is already on the rail.`);
    }
    next = { ...next, dir: moved };
  }
  return {
    ...contents,
    installs: contents.installs.map((install) => (install.dir === absolute ? next : install)),
  };
}

/** Forget a directory. Deletes nothing on disk (#527 §12). */
export function removeInstall(contents: CompanionFile, dir: string): CompanionFile {
  const absolute = path.resolve(dir);
  return { ...contents, installs: contents.installs.filter((install) => install.dir !== absolute) };
}

/** Per-field coercion — see {@link readCompanionFile}. */
function coerce(parsed: unknown): CompanionFile {
  const empty = emptyCompanionFile();
  if (typeof parsed !== "object" || parsed === null) return empty;
  const record = parsed as Record<string, unknown>;

  const installs = Array.isArray(record["installs"])
    ? record["installs"].filter(isStoredInstall).map((install) => ({
        dir: path.resolve(install.dir),
        addedAt: install.addedAt,
        ...(typeof install.name === "string" && install.name.trim() !== ""
          ? { name: install.name }
          : {}),
      }))
    : empty.installs;

  const relayField = record["relay"];
  const relay =
    typeof relayField === "object" &&
    relayField !== null &&
    typeof (relayField as { url?: unknown }).url === "string"
      ? { url: (relayField as { url: string }).url }
      : null;

  const preferencesField = record["preferences"];
  const notifications =
    typeof preferencesField === "object" &&
    preferencesField !== null &&
    typeof (preferencesField as { notifications?: unknown }).notifications === "boolean"
      ? (preferencesField as { notifications: boolean }).notifications
      : empty.preferences.notifications;
  const consoleTheme =
    typeof preferencesField === "object" &&
    preferencesField !== null &&
    typeof (preferencesField as { consoleTheme?: unknown }).consoleTheme === "string"
      ? (preferencesField as { consoleTheme: string }).consoleTheme
      : empty.preferences.consoleTheme;

  return { installs, relay, preferences: { notifications, consoleTheme } };
}

function isStoredInstall(value: unknown): value is StoredInstall {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<StoredInstall>;
  return typeof candidate.dir === "string" && typeof candidate.addedAt === "string";
}
