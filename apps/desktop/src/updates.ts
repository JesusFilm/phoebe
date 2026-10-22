// The companion's own updates: a check at launch, every four hours and on
// request; a download on a click; an install on quit or on a restart (#525 §3,
// revised in #722).
//
// `electron-updater` does the fetching. What lives here is every decision about
// it, held away from Electron so the rules are testable: when a check may run,
// what a refusal says, and which state the window is shown. Main supplies the
// updater and turns its events into the five calls at the bottom of this file.
//
// #525 §3 chose one check at launch and no poll, so an operator who left the
// companion open for a week never heard of a release. The revision keeps the
// one rule that mattered there: nothing downloads without a click. A check is
// a read of `latest.yml` and nothing else, so it can run on a timer; a
// download is 120 MB and an install swaps the app out, so both still wait to
// be asked.
//
// Three flags carry three of the decisions, set once and never moved:
// `autoDownload` false, because nothing downloads without a click; `allowDowngrade`
// false, because a relay behind this companion is #525 §4's refusal and never an
// offer to go back; `autoInstallOnAppQuit` true, because a tool that is driving
// Docker on this machine installs itself when the operator is done with it and
// not a moment earlier.
//
// Two companions do not update at all. macOS is unsigned this effort and
// Squirrel.Mac refuses an unsigned bundle, so the check does not run there — a
// macOS operator learns of a newer build from the release page. And a companion
// run out of a checkout is a `git pull` away from newer by definition. Both say
// so rather than sitting on a state that never moves (#527's note on #525).

import type { CompanionUpdate } from "phoebe-agent/contracts";
import { BridgeRefusal } from "./channels.ts";
import { feedFor, RELEASES_PAGE, type FeedChoice, type UpdateFeed } from "./update-feed.ts";

/**
 * How often a running companion asks again. Four hours: a release is a
 * merge a human makes a few times a week, and a check is one small GET.
 */
export const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;

/** The slice of `electron-updater`'s `autoUpdater` this drives. */
export type UpdaterControls = {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowDowngrade: boolean;
  setFeedURL: (feed: UpdateFeed) => void;
  checkForUpdates: () => Promise<unknown>;
  downloadUpdate: () => Promise<unknown>;
  quitAndInstall: () => void;
};

/**
 * The updates arm. The first four are the bridge's; the five below them are the
 * updater's events, which main forwards because only main can hear them.
 */
export type CompanionUpdates = {
  state: () => CompanionUpdate;
  /**
   * A check: read the feed, point the updater at it, ask. Fired at launch, on
   * the timer, and from the settings page. A no-op while a download is in
   * flight or a build is staged, because a fresh `checking` would throw away
   * the one state the operator is waiting on.
   */
  check: () => Promise<void>;
  download: () => Promise<void>;
  restart: () => void;
  available: (version: string) => void;
  notAvailable: () => void;
  progress: (percent: number) => void;
  downloaded: (version: string) => void;
  failed: (error: unknown) => void;
};

export type UpdatesDeps = {
  updater: UpdaterControls;
  /** `process.platform`. macOS does not update until the signing task lands. */
  platform: string;
  /** `app.isPackaged`. A checkout updates with git, not with this. */
  packaged: boolean;
  /** Which feed applies, asked again on every check (update-feed.ts). */
  feed: () => Promise<FeedChoice>;
  /** Told on every change, so a window that is already open follows along. */
  onChange: (update: CompanionUpdate) => void;
};

export function createCompanionUpdates(deps: UpdatesDeps): CompanionUpdates {
  const blocked = unsupportedReason(deps.platform, deps.packaged);

  if (blocked === null) {
    deps.updater.autoDownload = false;
    deps.updater.allowDowngrade = false;
    deps.updater.autoInstallOnAppQuit = true;
  }

  let state: CompanionUpdate =
    blocked === null
      ? { kind: "checking" }
      : { kind: "unsupported", reason: blocked, releases: RELEASES_PAGE };

  function settle(next: CompanionUpdate): void {
    // An unsupported companion stays unsupported: nothing is listening to an
    // updater that was never started, but a late event from one must not
    // overwrite the sentence the window is showing.
    if (state.kind === "unsupported") return;
    state = next;
    deps.onChange(state);
  }

  /** What `download` and `restart` refuse with when they are not the next step. */
  function notNow(what: string): BridgeRefusal {
    return new BridgeRefusal(
      state.kind === "unsupported"
        ? {
            code: "refused",
            message: state.reason,
            instruction: `Download it from ${RELEASES_PAGE}.`,
          }
        : { code: "refused", message: `there is no update to ${what}` },
    );
  }

  return {
    state: () => state,

    check: async () => {
      if (blocked !== null) return;
      if (state.kind === "downloading" || state.kind === "ready") return;
      try {
        const choice = await deps.feed();
        const feed = feedFor(choice);
        if (feed === null) {
          // Signed in to a relay that did not answer. No feed, no check — see
          // update-feed.ts for why this is not a fall back to `latest`.
          settle({ kind: "unread", message: choice.kind === "unread" ? choice.message : "" });
          return;
        }
        settle({ kind: "checking" });
        deps.updater.setFeedURL(feed);
        await deps.updater.checkForUpdates();
      } catch (error) {
        settle({ kind: "unread", message: messageOf(error) });
      }
    },

    download: async () => {
      if (state.kind !== "available") throw notNow("download");
      const { version } = state;
      settle({ kind: "downloading", version, percent: 0 });
      try {
        await deps.updater.downloadUpdate();
      } catch (error) {
        settle({ kind: "unread", message: messageOf(error) });
      }
    },

    restart: () => {
      if (state.kind !== "ready") throw notNow("install");
      deps.updater.quitAndInstall();
    },

    available: (version) => settle({ kind: "available", version }),
    notAvailable: () => settle({ kind: "current" }),
    // Rounded, because the percentage is a sentence on a rail and not a gauge.
    // The version comes off the state rather than off the event, which carries
    // bytes and a rate and no version at all.
    progress: (percent) => {
      if (state.kind !== "downloading") return;
      settle({ kind: "downloading", version: state.version, percent: Math.round(percent) });
    },
    downloaded: (version) => settle({ kind: "ready", version }),
    failed: (error) => settle({ kind: "unread", message: messageOf(error) }),
  };
}

/** Why this companion does not update itself, or null when it does. */
function unsupportedReason(platform: string, packaged: boolean): string | null {
  if (!packaged) return "a companion run from a checkout updates with git, not from a release";
  if (platform === "darwin") {
    return "the macOS build is unsigned, so it cannot install an update — download the new one instead";
  }
  return null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
