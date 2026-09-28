// The **local read loop** (#527 §5, §6, #556) — how a local install's tabs get
// fed with no relay, no listener and nothing inside the container dialling out.
//
// Two clocks, because one of each is wrong on its own. Compose's event stream
// says the moment a container starts or dies, and says nothing at all about one
// that has been up for an hour; a 15 s poll says how that container is doing,
// and takes up to 15 s to notice it is gone. Together they are the same pair of
// facts the relay arm gets from a socket and a heartbeat — which is why what
// comes out of here is the relay's own `report` event, in the relay's own shape.
//
// The loop reads; it does not remember. Every emission carries the install's
// facts as they stood at that moment beside the report as it was then, so a page
// is never left holding a report from a container that has since stopped. What a
// page does with the last one it saw is the page's decision, and #526 made it:
// a stopped install renders config and the stopped fact, not a report with an
// age on it.
//
// Nothing in here spawns anything or touches a disk. The seams are the whole
// interface, and the test drives them with neither Docker nor a clock.

import { RELAY_EVENTS } from "phoebe-agent/contracts";
import type {
  InstallDirectoryFacts,
  InstallState,
  LocalInstall,
  LocalReportEvent,
} from "phoebe-agent/contracts";
import { BridgeRefusal } from "./channels.ts";
import type { ContainerRead } from "./container-read.ts";

/** How often a running install is re-read (#527 §5). */
export const LOCAL_READ_INTERVAL_MS = 15_000;

export type LocalReadDeps = {
  /** This install's facts right now, or null when it is no longer one. */
  facts: (dir: string) => Promise<LocalInstall | null>;
  /** What the folder says, container or no container. */
  directory: (install: LocalInstall) => InstallDirectoryFacts;
  /** One exec of `phoebe status --json` in the install's container. */
  read: (install: LocalInstall) => Promise<ContainerRead>;
  /** Subscribe to the container's lifecycle. Returns the unsubscribe. */
  watch: (install: LocalInstall, onChange: () => void) => () => void;
  /** Where a finished read goes. Main broadcasts it to every window. */
  emit: (event: LocalReportEvent) => void;
  now?: () => Date;
  intervalMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
};

export type LocalReads = {
  /**
   * Bring the loop in line with the install list: watch the new ones, drop the
   * forgotten ones. Called with every list main derives, so adding a folder
   * starts reading it without a second code path.
   */
  sync: (installs: readonly LocalInstall[]) => void;
  /** Read one install now and answer with the event that went out (#527 §6). */
  refresh: (dir: string) => Promise<LocalReportEvent>;
  /** Drop every watcher and timer. The app is quitting. */
  stop: () => void;
};

type Watched = {
  unwatch: () => void;
  timer: unknown;
  /** The state this install was in when it was subscribed to. */
  state: InstallState;
  /**
   * Reads for one install are serialised. Two `docker compose exec`s racing on
   * one container is a second exec for no reason, and a refresh landing on top
   * of the poll would emit two events describing the same moment.
   */
  chain: Promise<unknown>;
};

export function createLocalReads(deps: LocalReadDeps): LocalReads {
  const now = deps.now ?? (() => new Date());
  const intervalMs = deps.intervalMs ?? LOCAL_READ_INTERVAL_MS;
  const setTimer =
    deps.setTimer ??
    ((fn, ms) => {
      const handle = setTimeout(fn, ms);
      // A poll must not be the reason the app stays alive at quit time.
      handle.unref?.();
      return handle;
    });
  const clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));

  const watched = new Map<string, Watched>();

  function disarm(entry: Watched): void {
    if (entry.timer !== null) clearTimer(entry.timer);
    entry.timer = null;
  }

  /** Re-arm the poll, but only while there is a container answering it. */
  function rearm(dir: string, running: boolean): void {
    const entry = watched.get(dir);
    if (entry === undefined) return;
    disarm(entry);
    // A stopped install is woken by its Compose event stream, not by a timer.
    // Polling `ps` every 15 s on a container nobody has started is work with no
    // question behind it.
    if (running) entry.timer = setTimer(() => void read(dir), intervalMs);
  }

  /** One read, start to emitted event. Never throws for a reason of its own. */
  async function readOnce(dir: string): Promise<LocalReportEvent> {
    const facts = await deps.facts(dir);
    if (facts === null) {
      throw new BridgeRefusal({
        code: "refused",
        message: `${dir} is not a local install the companion knows`,
        instruction: "Add the folder on the rail, then read it again.",
      });
    }
    const directory = deps.directory(facts);
    const at = now().toISOString();
    const base = { type: RELAY_EVENTS.report, install: dir, at, facts, directory } as const;

    if (facts.state !== "running") {
      rearm(dir, false);
      const event: LocalReportEvent = {
        ...base,
        report: null,
        reason: facts.detail ?? notRunningReason(facts),
      };
      deps.emit(event);
      return event;
    }

    const result = await deps.read(facts);
    rearm(dir, true);
    const event: LocalReportEvent = result.ok
      ? {
          ...base,
          report: { schema: result.schema, receivedAt: at, report: result.report },
        }
      : { ...base, report: null, reason: result.reason };
    deps.emit(event);
    return event;
  }

  /** Queue a read behind whatever this install is already doing. */
  function read(dir: string): Promise<LocalReportEvent> {
    const entry = watched.get(dir);
    if (entry === undefined) return readOnce(dir);
    const next = entry.chain.then(
      () => readOnce(dir),
      () => readOnce(dir),
    );
    // The chain swallows outcomes so one failed read does not poison the next.
    entry.chain = next.catch(() => undefined);
    return next;
  }

  /** Open this install's event stream, and read it once. */
  function begin(install: LocalInstall, entry: Watched): void {
    entry.state = install.state;
    // Subscribed before the first read, so a container that starts during it is
    // not a start nobody heard.
    entry.unwatch = deps.watch(install, () => void read(install.dir));
    void read(install.dir);
  }

  return {
    sync(installs) {
      const listed = new Set(installs.map((install) => install.dir));

      for (const [dir, entry] of watched) {
        if (listed.has(dir)) continue;
        disarm(entry);
        entry.unwatch();
        watched.delete(dir);
      }

      for (const install of installs) {
        const existing = watched.get(install.dir);
        if (existing !== undefined) {
          // A folder that was not initialised had no compose project to
          // subscribe to, so its watcher was a no-op. `init` gives it one, and
          // that transition is the one with no Docker event behind it — the
          // stream has to be opened here or the install stays unwatched.
          if (existing.state === "not-initialised" && install.state !== "not-initialised") {
            existing.unwatch();
            begin(install, existing);
          }
          existing.state = install.state;
          continue;
        }
        const entry: Watched = {
          unwatch: () => undefined,
          timer: null,
          state: install.state,
          chain: Promise.resolve(),
        };
        watched.set(install.dir, entry);
        begin(install, entry);
      }
    },

    refresh(dir) {
      return read(dir);
    },

    stop() {
      for (const entry of watched.values()) {
        disarm(entry);
        entry.unwatch();
      }
      watched.clear();
    },
  };
}

/** What to say about an install that has no container to read (#508 §4). */
function notRunningReason(install: LocalInstall): string {
  return install.state === "not-initialised"
    ? "this folder has no Phoebe install in it yet"
    : "the container is not running, so there is nothing to report";
}
