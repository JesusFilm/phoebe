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
// remote arm is the deployments paired over Tailscale (map #690) — one record
// per deployment behind which `request` answers with the bearer added, and a
// supervisor per record that feeds the tabs the same report event.
//
// Beside the two arms is the one thing the companion does about itself: its
// updates (#525 §3). It is on this surface rather than inside main alone because
// the window is where an operator learns a newer build exists and where the
// click that fetches it happens.

import type {
  BootstrapExit,
  BootstrapLine,
  BootstrapNeed,
  BootstrapPlan,
  BootstrapRun,
  BootstrapTool,
} from "./bootstrap.ts";
import type { CompanionUpdate } from "./companion-update.ts";
import type { GithubAppCreated, GithubAppRequest } from "./github-app.ts";
import type { GithubTokenVerdict } from "./github-token.ts";
import type { LogLine, LogsEnded } from "./container-logs.ts";
import type {
  CompanionEnvironment,
  CompanionPreferences,
  InstallPatch,
  LocalInstall,
} from "./local-install.ts";
import type {
  ClaudeSignInOutcome,
  HarnessApplyOutcome,
  HarnessName,
  HarnessRemoveOutcome,
  HarnessReport,
  HarnessReportEvent,
  HarnessUpdate,
  HarnessUpdateOutcome,
  ToolAddOutcome,
} from "./harness.ts";
import type {
  InstallRepair,
  LocalAlertEvent,
  LocalReportEvent,
  RepairOutcome,
} from "./local-report.ts";
import type {
  PairResult,
  RemoteAlertEvent,
  RemoteLogLine,
  RemoteLogsEnded,
  RemotePassthrough,
  RemoteRecord,
  RemoteReportEvent,
  RemoteResponse,
  RevokeOutcome,
  SessionRow,
} from "./remote-record.ts";
import type { RunExit, RunLine, VerbRun, VerbRunRequest } from "./verb-run.ts";

/** What was right-clicked, as much as the menu needs to know. */
export type ContextMenuRequest =
  /** A field: cut, copy, paste, select all, all the OS's own. */
  | { kind: "edit"; selection: string }
  /** Selected text anywhere else: copy. */
  | { kind: "text"; selection: string }
  /** The console's lines: copy the selection, the line under the pointer, or every line. */
  | { kind: "console"; selection: string; line: string | null; lines: number }
  /**
   * An install or a tenant on the rail: open its folder, or a terminal in it.
   * `dir` is the folder as the companion holds it, so a WSL install's is the
   * `\wsl.localhost\…` path and main opens that inside the distro.
   */
  | { kind: "folder"; dir: string };

/**
 * What the menu chose. The edit set answers nothing: the OS has already done
 * it. The folder choices are carried out by main before it answers, because a
 * window cannot open Explorer or a terminal; the answer is for the record.
 */
export type ContextMenuChoice =
  | "copy"
  | "copy-line"
  | "copy-all"
  | "select-all"
  | "open-folder"
  | "open-terminal";

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
    /**
     * Change an install's own settings: its display name, or the folder it
     * points at. A folder another entry already has is refused. Answers the
     * list, like add and remove, and the directory the entry now lives at as
     * main stored it — so a page open on a moved entry follows it to the key
     * the list carries, not to the path as picked.
     */
    update: (
      dir: string,
      patch: InstallPatch,
    ) => Promise<{ installs: LocalInstall[]; dir: string }>;
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
     * Put one thing right on an install, and read it again. Never run on main's
     * own initiative: every repair changes something on the operator's disk, so
     * each is a button somebody pressed.
     */
    repair: (dir: string, repair: InstallRepair) => Promise<RepairOutcome>;
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
  /**
   * The agent CLIs an install's container carries (harness.ts). A check reads
   * the Dockerfile and asks the running container; it asks the network for the
   * newest versions only when `lookUp` is set. An update moves one pin in the
   * Dockerfile and rebuilds nothing: the rebuild is a `start --build` run.
   */
  harness: {
    check: (dir: string, opts: { lookUp: boolean }) => Promise<HarnessReport>;
    update: (dir: string, update: HarnessUpdate) => Promise<HarnessUpdateOutcome>;
    /** Take one harness out of the Dockerfile. Rebuilds nothing; the container keeps it until then. */
    remove: (dir: string, harness: HarnessName) => Promise<HarnessRemoveOutcome>;
    /** Write a tool's install into the Dockerfile: `pnpm`, `yarn`, `bun`, or the companion's others. Rebuilds nothing. */
    addTool: (dir: string, tool: string) => Promise<ToolAddOutcome>;
    /**
     * Open a terminal on this machine running `claude setup-token`, Claude
     * Code's own sign-in, which ends by printing a long-lived token. The token
     * comes back through `secret set`, as every other secret does.
     */
    signInClaude: () => Promise<ClaudeSignInOutcome>;
    /**
     * Put the version the Dockerfile pins into the running container, without
     * a rebuild and without touching a unit in flight.
     */
    apply: (dir: string, harness: HarnessName) => Promise<HarnessApplyOutcome>;
    /**
     * Every report main produces: a page's check, and the automatic one the
     * `autoCheckUpdates` preference turns on. Returns the unsubscribe.
     */
    reports: (onReport: (event: HarnessReportEvent) => void) => () => void;
  };

  /**
   * The right-click menu. The window says what was clicked and main draws the
   * OS menu for it, answering with what was chosen; the window does the
   * copying from text it already has, and main does the opening of a folder
   * or a terminal, which only it can. Null when the menu was dismissed, and
   * for the edit set, which the OS carries out itself.
   */
  menu: {
    show: (request: ContextMenuRequest) => Promise<ContextMenuChoice | null>;
  };

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
    /**
     * Ask the feed now rather than wait for the timer. Nothing on an
     * unsupported companion, and nothing while a download is in flight or a
     * build is staged.
     */
    check: () => Promise<void>;
    /** Fetch the available build. Refused unless one is waiting to be fetched. */
    download: () => Promise<void>;
    /** Install the downloaded build now instead of on the next quit. */
    restart: () => Promise<void>;
    /** Every change of state, pushed. Returns the unsubscribe. */
    changes: (onUpdate: (update: CompanionUpdate) => void) => () => void;
  };
  /**
   * GitHub, for the setup steps (contracts/github-token.ts). The token travels
   * as an argument and is held for the call; the verdict carries no value.
   */
  github: {
    /** The five non-mutating probes against `slug`, with `token`. */
    verifyToken: (slug: string, token: string) => Promise<GithubTokenVerdict>;
    /**
     * Register a GitHub App through GitHub's manifest flow and put its id and
     * key into the deployment `.env` under `dir`. Opens the browser; resolves
     * when GitHub has answered. Refused while one is in flight.
     */
    createApp: (dir: string, request: GithubAppRequest) => Promise<GithubAppCreated>;
  };
  /**
   * Setting up this machine (contracts/bootstrap.ts): what the companion
   * would run to get Docker installed or started, and the one step at a time
   * it runs on a click.
   */
  bootstrap: {
    /** What this machine needs and what can be offered, read fresh. */
    plan: () => Promise<BootstrapPlan>;
    /** Run one step from the plan. Refused while one runs, or when the plan no longer offers it. */
    run: (step: { tool: BootstrapTool; need: BootstrapNeed }) => Promise<BootstrapRun>;
    /** The step running now or the last one, or null when none has run. */
    current: () => Promise<BootstrapRun | null>;
    lines: (onLine: (line: BootstrapLine) => void) => () => void;
    exits: (onExit: (exit: BootstrapExit) => void) => () => void;
  };
  /**
   * The machine's facts, pushed whenever main learns they moved: after a setup
   * step, as Docker comes up. Returns the unsubscribe.
   */
  environmentChanges: (onChange: (environment: CompanionEnvironment) => void) => () => void;
  /** The operator's preferences, as `companion.json` holds them (#527 §12). */
  preferences: {
    get: () => Promise<CompanionPreferences>;
    set: (preferences: CompanionPreferences) => Promise<CompanionPreferences>;
  };
  /**
   * The remote arm (map #690): the deployments this companion is paired with
   * over Tailscale. Main holds the records and the bearers (the bearer in the
   * OS keyring through `safeStorage`, never on a record), runs one supervisor
   * per record, and emits one `remote` event per change the way the local read
   * loop emits `report`.
   */
  remotes: {
    list: () => Promise<RemoteRecord[]>;
    /**
     * Read the descriptor, then spend the code. Keyed on `deploymentId`: a URL
     * whose descriptor names an id already held replaces that record's bearer
     * and keeps its label, last report and notified map — "pair again". Never
     * returns the bearer.
     */
    pair: (input: { url: string; code: string; label: string }) => Promise<PairResult>;
    /** One request to one remote, the bearer added in main. */
    request: (deploymentId: string, passthrough: RemotePassthrough) => Promise<RemoteResponse>;
    /** `DELETE /api/session`, then drop the record. The row goes. */
    signOut: (deploymentId: string) => Promise<void>;
    /** Drop the record without a request — a blocked row's way out. */
    forget: (deploymentId: string) => Promise<void>;
    /** `GET /api/sessions` on one remote, as the Devices panel draws it. */
    sessions: (deploymentId: string) => Promise<SessionRow[]>;
    /** `DELETE /api/sessions/:id` on one remote. */
    revoke: (deploymentId: string, sessionId: string) => Promise<RevokeOutcome>;
    /**
     * A remote's container output, followed over `GET /api/logs` with the
     * bearer added in main: what the local arm's `logs` reads off Docker, read
     * off the deployment instead, with its secrets redacted before they left
     * it. One stream per record, started by the first `follow` and joined by
     * the next; `stop` ends it and keeps nothing. `follow` resolves with the
     * backlog the deployment sent, so a pane opens full, and rejects when the
     * deployment could not be reached or refused the stream.
     */
    logs: {
      follow: (deploymentId: string) => Promise<string[]>;
      stop: (deploymentId: string) => Promise<void>;
      lines: (onLine: (line: RemoteLogLine) => void) => () => void;
      ended: (onEnded: (end: RemoteLogsEnded) => void) => () => void;
    };
    /** The list again whenever it changed. Returns the unsubscribe. */
    changes: (onChange: (records: RemoteRecord[]) => void) => () => void;
    /** Every supervisor emission: the record with its report and reachability. */
    reports: (onReport: (event: RemoteReportEvent) => void) => () => void;
    /** Every alert main raised over a remote. Nothing is replayed on subscribe. */
    alerts: (onAlert: (event: RemoteAlertEvent) => void) => () => void;
    /**
     * Is Tailscale up on this machine? A quick `tailscale status`, cached for
     * 60 s so the rail's banner never spawns it repeatedly. Null when no CLI
     * was found at all.
     */
    tailscale: () => Promise<{ running: boolean; detail: string } | null>;
  };
};
