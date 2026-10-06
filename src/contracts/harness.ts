// The AI harness: the agent CLI a provider spawns, and which one a container has.
//
// The engine runs a unit by spawning its provider's CLI by bare name, so the
// container has to carry that CLI, and the version it carries is whatever the
// install's Dockerfile installed on the day the image was built. Nothing else
// in a deployment says which version that is. These are the facts a console
// needs to say it, and the one edit that moves it: the pin in the Dockerfile.
//
// Types only. A console draws these; the half that reads a Dockerfile, asks a
// container and looks a version up is the companion's.

/** A provider's CLI, named as the provider is in the config. */
export type HarnessName = "cursor" | "claude" | "codex";

/** What the Dockerfile says about one harness. */
export type HarnessPin =
  /** Installed at exactly this version, on every build. */
  | { kind: "pinned"; version: string }
  /** Installed with no version, so each build takes whatever is newest that day. */
  | { kind: "unpinned" }
  /** Not installed. A tenant whose provider this is cannot run a unit. */
  | { kind: "absent" };

/** One harness on one install. */
export type HarnessFacts = {
  harness: HarnessName;
  pin: HarnessPin;
  /**
   * What the running container answered `--version` with. Null when no
   * container was asked, and when the one asked does not have it.
   */
  running: string | null;
  /** The newest published version, when one has been looked up. */
  latest: string | null;
  /**
   * Whether the install is behind `latest`: by its pin, or by the running
   * container when nothing is pinned. Null when either side is unknown.
   */
  behind: boolean | null;
};

/**
 * The launcher: the engine's own npm package, which the image installs and the
 * container boots from. Not a harness, and moved by `upgrade` rather than by a
 * harness update, because moving it can mean migrations. It is pinned in the
 * same file and stale in the same way, so its facts are read with theirs.
 */
export type LauncherFacts = Omit<HarnessFacts, "harness">;

/**
 * Who the install's container runs as, against who its Dockerfile says it
 * should. A container is made from an image, and an image is whatever the
 * Dockerfile said on the day it was built: a folder scaffolded since, or a
 * Dockerfile edited since, changes nothing until a rebuild. The case that
 * matters is root. Claude Code refuses to run unattended as root, so a
 * container still on an image from before the Dockerfile dropped privileges
 * fails every unit on that provider, and says so only as one line in a log.
 */
export type ContainerUserFacts = {
  /**
   * Whether the container runs as root: asked of the running container, or of
   * the image it would start from when it is stopped. Null when neither could
   * be asked.
   */
  root: boolean | null;
  /** Whether the Dockerfile ends on a non-root `USER`, so an image built from it would not be root. */
  dockerfileDrops: boolean;
};

/** Every harness on one install, as the last check found them. */
export type HarnessReport = {
  /** The Dockerfile that was read, or null when the install has none. */
  dockerfile: string | null;
  harnesses: HarnessFacts[];
  launcher: LauncherFacts;
  user: ContainerUserFacts;
  /** Whether a running container answered. False for a stopped install. */
  containerAsked: boolean;
  /** When `latest` was last looked up, ISO-8601. Null before the first lookup. */
  latestAt: string | null;
};

/** A harness and the version to pin it to. */
export type HarnessUpdate = { harness: HarnessName; version: string };

/**
 * What became of an update. Moving the pin changes the Dockerfile and nothing
 * else: the container keeps the CLI it was built with until the image is
 * rebuilt, which is a run of its own.
 */
export type HarnessUpdateOutcome =
  | {
      kind: "moved";
      harness: HarnessName;
      /** The version the file pinned before, or null when it pinned none. */
      from: string | null;
      to: string;
      /** The Dockerfile that was written. */
      file: string;
    }
  | { kind: "unchanged"; harness: HarnessName; version: string }
  | {
      kind: "refused";
      harness: HarnessName;
      why: string;
      /** The edit to make by hand, when there is one to name. */
      instruction: string | null;
    };

/**
 * What came of putting a pinned harness into a running container.
 *
 * The version the Dockerfile pins is installed beside the one the container
 * has, and the command is switched to it in one step. A unit already running
 * keeps the files it started on; the next unit spawned gets the new one. So
 * this never changes a CLI under a unit that is using it. A container made
 * fresh from the old image loses it, which is what the pin and a rebuild are for.
 */
export type HarnessApplyOutcome =
  | { kind: "applied"; harness: HarnessName; version: string }
  | { kind: "refused"; harness: HarnessName; why: string };

/** One install's report, whichever check produced it: a page's, or the automatic one. */
export type HarnessReportEvent = { install: string; report: HarnessReport };
