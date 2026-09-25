// The **desktop bridge** — the surface the companion's preload exposes to the
// console bundle, and the only way that bundle can tell it is running in the
// companion rather than in a browser (#522 §4, #527 §1).
//
// Types only, like the rest of contracts. The preload implements it over
// `ipcRenderer.invoke` and `ipcRenderer.on`; the renderer reads it off one
// global. Renderer and main ship in one bundle at one version (#521 §4), so
// there is no RPC library and no runtime schema layer between the two sides —
// this file is the whole agreement.
//
// What is declared here is the companion's two arms. The local arm is the
// installs on this machine, the environment they need, the verb runs that drive
// them (#555) and the reads the local read loop feeds the tabs (#556); the
// remote arm is the relay — a device session (#554) behind which `request` and
// `events` answer, and which refuses with `signed-out` until there is one.
//
// Beside the two arms is the one thing the companion does about itself: its
// updates (#525 §3). It is on this surface rather than inside main alone because
// the window is where an operator learns a newer build exists and where the
// click that fetches it happens.

import type { CompanionUpdate } from "./companion-update.ts";
import type { LogLine, LogsEnded } from "./container-logs.ts";
import type { CompanionEnvironment, CompanionPreferences, LocalInstall } from "./local-install.ts";
import type { LocalAlertEvent, LocalReportEvent } from "./local-report.ts";
import type { RelayEvent } from "./relay-events.ts";
import type { RelayIdentity } from "./relay-routes.ts";
import type { RunExit, RunLine, VerbRun, VerbRunRequest } from "./verb-run.ts";

/**
 * The global the preload writes the bridge onto, and the only thing the console
 * bundle looks at to learn which side of the seam it is running on (#522 §4).
 * Mirrored by hand in index.mjs, like every other value here.
 */
export const DESKTOP_BRIDGE_GLOBAL = "phoebe";

/**
 * Why a bridge call was refused. One closed set for both arms (#527 §16), so a
 * refusal renders the same way whether it came from Docker on this machine or
 * from the relay.
 */
export type DesktopBridgeErrorCode =
  | "not-initialised"
  | "docker-missing"
  | "container-not-running"
  | "busy"
  | "refused"
  | "signed-out"
  | "undelivered"
  | "unknown";

/**
 * The shape every rejected bridge call carries. `instruction` is the fallback
 * the operator can run by hand (#503), present only when there is one.
 */
export type DesktopBridgeError = {
  code: DesktopBridgeErrorCode;
  message: string;
  instruction?: string;
};

/**
 * Who the companion is signed in to, if anyone (#527 §9).
 *
 * `person` is the identity or null rather than a `signedIn` flag beside an
 * optional identity: two fields that can contradict each other are two fields a
 * page has to decide between.
 */
export type RelayArmState = {
  /** The relay this companion is paired with, or null before one is set. */
  url: string | null;
  /** The signed-in person, or null when there is no session. */
  person: RelayIdentity | null;
  /** Whether the session survives a relaunch. False with no keyring (#554). */
  persisted: boolean;
  /** What to tell the operator about the state above, when there is something. */
  reason?: string;
};

/**
 * How a renderer asks main to sign in (#554). The relay's URL is the only thing
 * the renderer supplies, because it is the only part of the flow that is the
 * operator's to type — everything after it is main's: the PKCE verifier, the
 * system browser, the scheme hop back, and the exchange.
 */
export type RelaySignInRequest = { url: string };

/** One call the companion makes on the relay's JSON API on the renderer's behalf. */
export type RelayPassthrough = {
  method: "GET" | "POST" | "DELETE";
  path: string;
  body?: unknown;
};

/**
 * The bridge itself. Every method returns a promise; every subscription returns
 * its own unsubscribe.
 */
export type DesktopBridge = {
  /** The companion's version — the root package's, read at build time (#521 §4). */
  version: () => Promise<string>;
  /** Docker, the platform and the version, computed on demand (#527 §15). */
  environment: () => Promise<CompanionEnvironment>;
  /**
   * The local arm's list. Main owns `companion.json` and derives every fact on
   * it at read time, so the renderer holds no copy that can go stale (#527 §12).
   */
  installs: {
    list: () => Promise<LocalInstall[]>;
    /**
     * The folder picker. Null when the operator dismissed it.
     *
     * `inside: "wsl"` opens it at `\\wsl.localhost\`, where the distros are. The
     * Windows picker cannot be typed into and keeps that root under a "Linux"
     * node at the foot of its tree, so a folder inside a distro is reached by
     * starting there (apps/desktop/src/wsl.ts).
     */
    pick: (inside?: "wsl") => Promise<string | null>;
    /**
     * Adopt a folder. A folder that already carries a config is adopted as it
     * stands — the companion never re-inits over one (#555).
     */
    add: (dir: string) => Promise<LocalInstall[]>;
    /** Forget an install. Deletes nothing on disk (#527 §12). */
    remove: (dir: string) => Promise<LocalInstall[]>;
    /** The list again whenever it changed. Returns the unsubscribe. */
    changes: (onChange: (installs: LocalInstall[]) => void) => () => void;
    /**
     * Every read the local read loop finishes, for every install (#527 §5). The
     * same `report` event the relay's stream carries, so a page subscribes to
     * one or the other and renders the result the same way.
     */
    reports: (onReport: (event: LocalReportEvent) => void) => () => void;
    /**
     * Read one install now rather than waiting for the loop. Resolves with the
     * event it emitted — which on a stopped install is the directory's facts and
     * `report: null` (#527 §6).
     */
    refresh: (dir: string) => Promise<LocalReportEvent>;
    /**
     * Every alert main raised over a local install (#524 §3). The relay arm's
     * alerts arrive on `relay.events` instead, because there they are the
     * relay's to decide and main only forwards them — here main is the one
     * running the rule, over reports no relay ever sees.
     *
     * Nothing is replayed on subscribe (#524 §7). A window that opened late
     * has the fleet and the install list to read; an alert it missed was a
     * moment, and the moment is over.
     */
    alerts: (onAlert: (event: LocalAlertEvent) => void) => () => void;
  };
  /** The verb runs — see verb-run.ts for the three rules they hold to. */
  runs: {
    /** Start one. Resolves with the run's id, or rejects `busy` (#527 §2). */
    start: (request: VerbRunRequest) => Promise<string>;
    /** The install's current or last run, or null when it has never had one. */
    current: (install: string) => Promise<VerbRun | null>;
    /** SIGTERM the run's child. Refused for a verb that spawns none. */
    cancel: (runId: string) => Promise<void>;
    lines: (onLine: (line: RunLine) => void) => () => void;
    exits: (onExit: (exit: RunExit) => void) => () => void;
  };
  /**
   * A running install's container output, followed (container-logs.ts). One
   * stream per install, started by the first `follow` and reused by the next;
   * `stop` ends it. Lines and endings arrive for every followed install, tagged
   * with the install they belong to, so a pane filters for its own.
   */
  logs: {
    /**
     * Start following, or join the stream already running. Resolves with the
     * lines main holds so far — the tail Docker handed over, and whatever came
     * since — so a pane opened late starts full rather than empty. Rejects
     * `not-initialised` for a folder with no container to ask.
     */
    follow: (install: string) => Promise<string[]>;
    /** End the stream. Nothing is kept; the next follow starts afresh. */
    stop: (install: string) => Promise<void>;
    lines: (onLine: (line: LogLine) => void) => () => void;
    ended: (onEnded: (end: LogsEnded) => void) => () => void;
  };
  /**
   * The companion's own updates (#525 §3). One check at launch, and then
   * nothing moves without a call from here: `download` is the click, and the
   * install waits for the quit either way.
   */
  updates: {
    /** Where the update stands now. Answers on macOS too, with `unsupported`. */
    state: () => Promise<CompanionUpdate>;
    /** Fetch the available build. Refused unless one is waiting to be fetched. */
    download: () => Promise<void>;
    /** Install the downloaded build now instead of on the next quit. */
    restart: () => Promise<void>;
    /** Every change of state, pushed. Returns the unsubscribe. */
    changes: (onUpdate: (update: CompanionUpdate) => void) => () => void;
  };
  /** The operator's preferences, as `companion.json` holds them (#527 §12). */
  preferences: {
    get: () => Promise<CompanionPreferences>;
    set: (preferences: CompanionPreferences) => Promise<CompanionPreferences>;
  };
  /**
   * The remote arm. Main holds the device token and makes the calls, so the
   * renderer never learns the token and route knowledge stays in the console's
   * relay-client seam (#527 §9).
   */
  relay: {
    state: () => Promise<RelayArmState>;
    /**
     * Run a sign-in: the system browser opens, and this resolves once the code
     * has come back over the custom scheme and been exchanged. It rejects when
     * the operator abandons the attempt, which is a thing the rail can say.
     */
    signIn: (request: RelaySignInRequest) => Promise<RelayArmState>;
    /**
     * The arm's state, pushed whenever it changes without the renderer having
     * asked — a 401 on the event stream is the case this exists for, since
     * nothing the page did would otherwise tell it the session ended. Returns
     * the unsubscribe.
     */
    watch: (onState: (state: RelayArmState) => void) => () => void;
    request: (request: RelayPassthrough) => Promise<unknown>;
    /** The relay's event stream, re-emitted. Returns the unsubscribe. */
    events: (onEvent: (event: RelayEvent) => void) => () => void;
    /** Revoke the device token on the relay, then forget it here. */
    signOut: () => Promise<void>;
  };
};
