// A **local install** — a repository folder on this machine the companion drives
// through Docker Compose (#522 §1, glossary). The remote arm's noun is a
// deployment and it arrives through the relay; this is the other arm, and the
// two are different enough to deserve different words.
//
// What is stored and what is derived is the whole design here (#527 §12). An
// install's identity is its absolute directory, and the companion's file keeps
// that and the moment it was added. Everything else on this type — whether the
// folder is initialised, whether its container is up — is read fresh on every
// list, because a fact written into a file is a fact that goes stale the moment
// the operator runs `docker stop` in a terminal.

/**
 * What a local install is doing, in the three words Compose can actually answer
 * (#522 §7). The relay's connected / dark / unseen verdicts do not exist here:
 * darkness is a relay's inference from silence, and there is no silence to
 * infer from when the container is a process on this machine.
 */
export type InstallState = "running" | "stopped" | "not-initialised";

/** One local install, as the rail draws it. */
export type LocalInstall = {
  /** Absolute path to the folder. The install's identity (#527 §12). */
  dir: string;
  /** The folder's own name — what the rail shows, since `dir` is too long for it. */
  name: string;
  /**
   * What this install answers to on a relay (#505 §3) — `relay.name`, or the
   * solo `repoSlug`, or the folder's name. Beside {@link LocalInstall.name}
   * rather than instead of it, because they are two different names: one is what
   * the operator sees on the rail, the other is what a deployment row on a relay
   * is called, and a paired install is matched to its row by the second.
   */
  deploymentName: string;
  /**
   * The relay this install's root config dials, or null when it names none.
   * Read out of the config's `relay` block on every list, like everything else
   * here: the block is the pairing's own (#540), and the companion is not the
   * only thing that can write it.
   */
  relayUrl: string | null;
  /** When the operator added it, ISO 8601. The one derived-from-nothing field. */
  addedAt: string;
  /** Derived on every read, never stored. */
  state: InstallState;
  /**
   * The `phoebe-agent` version this install's container is built from — the
   * `ARG PHOEBE_AGENT_VERSION` pin in `container/Dockerfile`, which is what
   * actually runs in there and what `upgrade` moves (#525 §6).
   *
   * Null covers three cases that read as one on screen: no container yet, a
   * Dockerfile with no pin (the build takes whatever npm publishes), and a
   * Dockerfile that could not be read. In none of them is there a version to
   * state, and in none of them does anything refuse — the local arm reports this
   * beside the companion's own version and leaves the remedy to a button.
   */
  containerVersion: string | null;
  /**
   * The part of the state that is a guess rather than a reading — Docker absent,
   * the daemon down, Compose refusing. Present only when there is something to
   * say, because a line under every entry is a line nobody reads.
   */
  detail?: string;
  /**
   * Set when the folder is inside a WSL distro — `\\wsl.localhost\<distro>\…`
   * as Windows shows it. `dir` is the path the distro knows it by, and Docker
   * for this install is the distro's own, reached through `wsl.exe`
   * (apps/desktop/src/wsl.ts) rather than this machine's PATH. Absent for a
   * folder on the machine's own filesystem, which is every install elsewhere.
   */
  wsl?: { distro: string; dir: string };
};

/**
 * What the companion knows about the machine it is on (#527 §15). Computed on
 * demand rather than held, because Docker Desktop stopping is a thing that
 * happens between two clicks.
 *
 * Docker is **checked, never installed** (#522 §2). A missing daemon is a
 * sentence and a link, not a download.
 */
export type CompanionEnvironment = {
  /** The companion's version — the root package's (#521 §4). */
  companionVersion: string;
  /** `process.platform`, for the install tab's Docker instructions. */
  platform: string;
  docker: {
    /** Is `docker` on PATH at all? */
    present: boolean;
    /** What `docker compose version` answered, or null when it could not be asked. */
    composeVersion: string | null;
    /** Did the daemon answer? False when Docker is installed but not running. */
    daemonRunning: boolean;
  };
};

/**
 * The operator's preferences, as `companion.json` holds them (#527 §12). One
 * field today; notifications are raised in the renderer and this is the switch
 * that silences them (#524, §10).
 */
export type CompanionPreferences = {
  notifications: boolean;
};
