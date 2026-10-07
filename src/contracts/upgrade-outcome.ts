// What `phoebe upgrade` reported or moved. Lives here rather than in
// src/upgrade.ts so a console can render an upgrade without loading the half
// that rewrites a config in place and shells out to git and npm (#527 §4).

/** Which half (or halves) of the deployment an upgrade moves. */
export type UpgradeTarget = "engine" | "cli" | "both";

/** The `--check` probe: where each half stands against its latest. */
export type UpgradeCheckReport = {
  engine: {
    source: "github" | "local";
    /** The configured ref (defaults applied); null for a local mount. */
    ref: string | null;
    /** Highest release tag on the engine repo; null when unreachable. */
    latest: string | null;
    /** True when the ref is a branch/other ref that already tracks a tip. */
    tracking: boolean;
    /** Behind the latest release; null when it cannot be determined. */
    behind: boolean | null;
  };
  cli: {
    installed: string | null;
    latest: string | null;
    behind: boolean | null;
    /** Present when `installed` reflects the container/Dockerfile ARG pin rather than npm ls -g. */
    source?: "dockerfile";
  };
  /** False when either half is known to be behind. */
  ok: boolean;
};

/**
 * What became of one half. A refusal is not a throw: upgrade reports the exact
 * edit it declined to make and leaves the deployment where it was, so the CLI
 * turns this into exit 1 and the companion into a red line, both from the same
 * value.
 */
export type UpgradeHalfOutcome =
  | { kind: "moved"; from: string | null; to: string }
  | { kind: "unchanged"; reason: "already-current" | "nothing-pinned" | "baked-into-image" }
  | { kind: "refused"; stage: "migrate" | "flip" | "pin" }
  /** The CLI half after the engine half was refused — `--both` must not straddle. */
  | { kind: "skipped"; reason: "engine-refused" };

/**
 * The upgrade verb's outcome. `ok` is the verdict the CLI turns into an exit
 * code: false when the probe found a half behind, or when a half was refused.
 */
export type UpgradeOutcome =
  | { kind: "checked"; report: UpgradeCheckReport; ok: boolean }
  | {
      kind: "upgraded";
      target: UpgradeTarget;
      /** Null when this run did not touch that half. */
      engine: UpgradeHalfOutcome | null;
      cli: UpgradeHalfOutcome | null;
      ok: boolean;
    };
