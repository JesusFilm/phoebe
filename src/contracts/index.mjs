// Runtime surface of `phoebe-agent/contracts` — the `import` condition of the
// subpath export. Almost everything here is types, and types leave nothing
// behind at runtime; what is left is the handful of pure constants a reader
// needs to *check* something, written twice by hand.
//
// Twice, because Node will not type-strip a `.ts` file out of node_modules: an
// installed consumer's `import { DEPLOYMENT_SCHEMA } from "phoebe-agent/contracts"`
// resolves to this file and never to index.ts. The type condition points at the
// `.ts`, so a type-checker reads the documented declaration and a runtime reads
// this. src/contracts/deployment.test.ts and src/contracts/index.test.ts hold
// the copies to the same value; bootstrap/index.mjs exists for the same reason.

/** The `schema` integer `state/deployment.json` carries — see deployment.ts. */
export const DEPLOYMENT_SCHEMA = 1;

/** The effective config's own shape version — see effective-config.ts. */
export const EFFECTIVE_CONFIG_VERSION = 1;

/** The `schema` integer every alert body carries (#515 §9) — see alerts.ts. */
export const ALERT_SCHEMA = 1;

/** How long after the last heartbeat silence becomes an alert (#515 §4). */
export const ALERT_DARK_AFTER_MS = 300_000;

/** The five conditions (#515 §3). Mirror of `ALERT_CONDITIONS` in alerts.ts. */
export const ALERT_CONDITIONS = ["dark", "wedged", "crash-looping", "doctor-fail", "replaced"];
/**
 * The config-edit closed set (#503). Mirror of `CLOSED_EDIT_BLOCKS` in
 * config-edit.ts; the doc comments live there.
 */
export const CLOSED_EDIT_BLOCKS = [
  {
    prefix: "workspace",
    why: "the fleet declaration is yours — adding, removing or reordering tenants is a git edit, never a console one",
  },
  {
    prefix: "engine",
    why: "`engine.ref` picks which engine runs and moves with `phoebe upgrade`, so the migrations for the new ref run with it",
  },
  {
    prefix: "deployment",
    why: "the `deployment` block holds the host's lifecycle commands, which run outside the container and are not the container's to rewrite",
  },
  {
    prefix: "paths",
    why: "`paths` is derived from `repoSlug` and the data volume; nothing at that path is read from the file",
  },
  {
    prefix: "workKinds",
    why: "top-level `workKinds` is the permanent alias for `pipelines.work.kinds` — set it at the path the effective config prints",
  },
];

/** The global the companion's preload exposes its bridge on — see desktop-bridge.ts. */
export const DESKTOP_BRIDGE_GLOBAL = "phoebe";

/** How many lines of a verb run main keeps — see verb-run.ts (#527 §13). */
export const MAX_RUN_LINES = 2000;

/** The verbs a companion can cancel — see verb-run.ts (#527 §2). */
export const CANCELLABLE_VERBS = ["start", "stop"];

/** How many log lines main keeps per followed install — see container-logs.ts. */
export const MAX_LOG_LINES = 2000;

/** How far back a log follow starts — see container-logs.ts. */
export const LOG_TAIL_LINES = 200;
