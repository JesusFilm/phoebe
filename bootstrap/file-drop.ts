// A **file drop**: one process asks another for something by writing a file
// into a directory the other watches, and reads the answer back from a
// sibling directory (map #690). Two drops use it — the root-only mint drop
// (#695), where the asker is `phoebe pair` running as root and the owner check
// is what makes the gate a gate, and the revoke drop (#696), where the asker
// is `phoebe sessions revoke` running as uid 10001 and the point is that the
// bootstrapper stays the one process that writes the sessions file.
//
// The watcher side is `fs.watch` plus a one-second poll, because `fs.watch`
// on a bind mount or a tmpfs is not something to rely on alone. The asker side
// writes to a temp name and renames, so the watcher never reads half a file,
// and waits a bounded time for the ack.

import { watch, type FSWatcher } from "node:fs";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

/** How often the watcher looks even when `fs.watch` says nothing. */
export const DROP_POLL_MS = 1_000;

/** What the watcher reads about one file before it acts. */
export type DropFile = { name: string; uid: number; content: string };

export type DropWatcherDeps = {
  /** The directory asks land in. */
  dir: string;
  /** Where acks go, created on demand. */
  ackDir: string;
  /** Only files owned by this uid are read. Absent: any owner. */
  requireUid?: number;
  /**
   * Handle one ask. The string returned is the ack's content; the ask file is
   * left to the asker to delete, so a slow asker still finds its ack.
   */
  onFile: (file: DropFile) => string;
  /** Injectable file system, for tests. */
  fs?: {
    readdir?: (dir: string) => string[];
    stat?: (path: string) => { uid: number; isFile: () => boolean };
    readFile?: (path: string) => string;
    writeFile?: (path: string, content: string) => void;
    mkdir?: (dir: string) => void;
    watch?: (dir: string, onChange: () => void) => { close: () => void } | null;
  };
  setInterval?: (fn: () => void, ms: number) => { unref?: () => void; clear: () => void };
  log?: (line: string) => void;
};

export type DropWatcher = { scan: () => void; stop: () => void };

function defaultWatch(dir: string, onChange: () => void): { close: () => void } | null {
  let watcher: FSWatcher;
  try {
    watcher = watch(dir, { persistent: false }, () => onChange());
  } catch {
    return null;
  }
  watcher.on("error", () => {});
  return { close: () => watcher.close() };
}

/**
 * Watch `dir`. Every file is handled once; a file that reappears under the same
 * name is handled again, which an asker never does since every ask has a fresh
 * nonce.
 */
export function watchDrop(deps: DropWatcherDeps): DropWatcher {
  const fs = {
    readdir: deps.fs?.readdir ?? ((dir: string) => readdirSync(dir)),
    stat: deps.fs?.stat ?? ((path: string) => statSync(path)),
    readFile: deps.fs?.readFile ?? ((path: string) => readFileSync(path, "utf8")),
    writeFile:
      deps.fs?.writeFile ?? ((path: string, content: string) => writeFileSync(path, content)),
    mkdir: deps.fs?.mkdir ?? ((dir: string) => mkdirSync(dir, { recursive: true })),
    watch: deps.fs?.watch ?? defaultWatch,
  };
  const log = deps.log ?? (() => {});
  const seen = new Set<string>();

  const scan = (): void => {
    let names: string[];
    try {
      names = fs.readdir(deps.dir);
    } catch {
      return;
    }
    for (const name of names) {
      // The asker's own temp file, mid-write: never read, never acked.
      if (name.startsWith(".") || seen.has(name)) continue;
      const path = join(deps.dir, name);
      let info: { uid: number; isFile: () => boolean };
      try {
        info = fs.stat(path);
      } catch {
        continue;
      }
      if (!info.isFile()) continue;
      if (deps.requireUid !== undefined && info.uid !== deps.requireUid) {
        // Not ours to read: the owner check is the whole of the gate.
        seen.add(name);
        log(`[phoebe] boot: ignoring ${path} — owned by uid ${info.uid}, not ${deps.requireUid}.`);
        continue;
      }
      let content: string;
      try {
        content = fs.readFile(path);
      } catch {
        continue;
      }
      seen.add(name);
      let ack: string;
      try {
        ack = deps.onFile({ name, uid: info.uid, content });
      } catch (error) {
        ack = `refused ${error instanceof Error ? error.message : String(error)}`;
      }
      try {
        fs.mkdir(deps.ackDir);
        fs.writeFile(join(deps.ackDir, name.replace(/\.json$/, "")), `${ack}\n`);
      } catch (error) {
        log(
          `[phoebe] boot: could not acknowledge ${path} — ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    // Forget names that are gone, so the set stays the size of the drop.
    for (const name of seen) if (!names.includes(name)) seen.delete(name);
  };

  const watcher = fs.watch(deps.dir, scan);
  const timer = (deps.setInterval ?? defaultInterval)(scan, DROP_POLL_MS);
  timer.unref?.();
  scan();
  return {
    scan,
    stop() {
      watcher?.close();
      timer.clear();
    },
  };
}

function defaultInterval(fn: () => void, ms: number): { unref: () => void; clear: () => void } {
  const handle = setInterval(fn, ms);
  return { unref: () => handle.unref?.(), clear: () => clearInterval(handle) };
}

/** What an ask got back. */
export type DropAnswer =
  | { kind: "ok"; detail: string }
  | { kind: "refused"; detail: string }
  | { kind: "unanswered" };

export type DropAskDeps = {
  dir: string;
  ackDir: string;
  /** How long to wait for the ack. */
  waitMs: number;
  /** How often to look for it. */
  pollMs?: number;
  fs?: {
    writeFile?: (path: string, content: string) => void;
    rename?: (from: string, to: string) => void;
    exists?: (path: string) => boolean;
    readFile?: (path: string) => string;
    remove?: (path: string) => void;
  };
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

/**
 * Drop one ask and wait for its ack. The ask file and the ack are both deleted
 * on the way out whatever happened, so the drop is empty at rest — an ask that
 * was never picked up is not left for the next boot to find.
 */
export async function askDrop(
  nonce: string,
  content: string,
  deps: DropAskDeps,
): Promise<DropAnswer> {
  const fs = {
    writeFile: deps.fs?.writeFile ?? ((path: string, body: string) => writeFileSync(path, body)),
    rename: deps.fs?.rename ?? ((from: string, to: string) => renameSync(from, to)),
    exists: deps.fs?.exists ?? ((path: string) => existsSync(path)),
    readFile: deps.fs?.readFile ?? ((path: string) => readFileSync(path, "utf8")),
    remove: deps.fs?.remove ?? ((path: string) => rmSync(path, { force: true })),
  };
  const sleep = deps.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? Date.now;
  const file = join(deps.dir, `${nonce}.json`);
  const tmp = join(deps.dir, `.${nonce}.tmp`);
  const ack = join(deps.ackDir, nonce);
  fs.writeFile(tmp, content);
  fs.rename(tmp, file);
  const deadline = now() + deps.waitMs;
  try {
    while (true) {
      if (fs.exists(ack)) {
        const answer = fs.readFile(ack).trim();
        if (answer === "ok" || answer.startsWith("ok ")) {
          return { kind: "ok", detail: answer.slice(2).trim() };
        }
        return { kind: "refused", detail: answer.replace(/^refused\s*/, "") };
      }
      if (now() >= deadline) return { kind: "unanswered" };
      await sleep(deps.pollMs ?? 100);
    }
  } finally {
    fs.remove(file);
    fs.remove(ack);
  }
}
