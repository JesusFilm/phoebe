// The **deployment report** — the whole object one deployment hands a console
// (#501, map #497). Not "snapshot" (that is `status.json`), not "state" (that is
// the directory), not "status" (that is the CLI verb).
//
// One deployment keeps one of these, as one fixed-size file on the data volume
// (`state/deployment.json`), rewritten atomically whenever any section moves.
// It is the single read model: `phoebe status` reads that file, the relay sender
// ships that file, and the companion renders what the relay forwarded. "The same
// model with no relay" is the same bytes.
//
// Two rules give the file its shape.
//
// **Derivation lives here.** A pipeline's state and its `wedged?` verdict are
// computed by the bootstrapper, from the one owner of that logic
// (src/pipeline-listing.ts), and written down. A consumer renders; it never
// recomputes, so a CLI and a web console cannot disagree about what a pipeline
// is doing. The raw `status.json` rides alongside for detail, not for arithmetic.
//
// **Fixed size.** Every section is a bounded set of current facts — never a log,
// never a history. What happened before now is the engine's stdout, which the
// host collects; nothing here grows with time or with uptime (#73).
//
// `schema` is the integer a reader checks before trusting the rest. It moves
// when a field's meaning changes in a way an older reader would misread; adding
// an optional field does not move it.

import type { CredentialArm } from "./credential-arm.ts";
import type { DoctorSection } from "./doctor.ts";
import type { PipelineSource, PipelineState, WedgedVerdict } from "./pipeline-state.ts";
import type { StatusSnapshot } from "./status-snapshot.ts";

/** The report shape this engine writes. Bump on a breaking change, never on an addition. */
export const DEPLOYMENT_SCHEMA = 1;

/** Which supervision arm the deployment runs: the root is the tenant, or a tree of them. */
export type DeploymentArm = "solo" | "workspace";

/**
 * Who this deployment is (#505). `name` defaults to the solo tenant's
 * `repoSlug` or the workspace root's directory name; `keyFingerprint` is absent
 * until the deployment has a relay key on its volume, which is what makes it
 * identifiable to anything outside the container.
 */
export type DeploymentIdentity = {
  name: string;
  keyFingerprint?: string;
  arm: DeploymentArm;
};

/** Where a supervised child is in its lifecycle, transients included. */
export type ChildState = "running" | "draining" | "exited";

/** How a child last ended. `signal` is a name (`SIGTERM`), never a number. */
export type ChildExit = { code: number | null; signal: string | null; at: string };

/**
 * One supervised pipeline's child, as the bootstrapper sees it — the process
 * line of the console's two lines per pipeline (#507). The other line is the
 * fleet cell's `state`, which comes from the snapshot rather than from here.
 */
export type ChildLiveness = {
  /** `<tenantId>#<pipeline>` — the key every section uses for a pipeline. */
  id: string;
  state: ChildState;
  /** When it entered `state`: running since, draining since, exited at. */
  since: string;
  /**
   * How many times this pipeline's child has died on its own since the container
   * booted. Counted at the death, so a child inside its respawn backoff already
   * shows the death that is about to bring it back.
   */
  restarts: number;
  /** Its last self-death was fast enough to count as a crash-loop tick (#401). */
  crashLooping: boolean;
  lastExit: ChildExit | null;
  /**
   * When this child last reported a completed loop pass over IPC — the clock the
   * `no-pass` wedged clause reads.
   *
   * **Never render it as an age.** The report is rewritten when something
   * changes, not once per pass, so a healthy idle pipeline's `lastPassAt`
   * deliberately goes stale between writes. The only published form of the pass
   * clock is `noPassForMs` inside a wedged verdict, which is stamped at the
   * moment the verdict is taken.
   */
  lastPassAt: string | null;
};

/** The crash-loop guard's record, as it stands (bootstrap/crash-loop.ts). */
export type CrashLoopRecord = {
  lastGoodSha: string | null;
  failingSha: string | null;
  failureCount: number;
};

/** Is the bootstrapper relaunching the fleet onto a different engine, and why? */
export type ReconcileState =
  | { phase: "idle"; since: string }
  | { phase: "reconciling"; reason: "config" | "ref"; since: string };

/** The global concurrency broker's numbers (#407): the cap and what is against it. */
export type SlotReport = {
  capacity: number;
  inUse: number;
  waiting: number;
  /** Over-cap grants outstanding fleet-wide — the slot floor's breach, bounded. */
  overGranted: number;
  floorBudget: number;
};

/** What the bootstrapper itself is doing. */
export type BootstrapperReport = {
  /** The engine ref as the config names it; `"local"` for a mounted engine. */
  engineRef: string | null;
  /** The commit actually running. Null for a local mount — there is nothing to name. */
  engineSha: string | null;
  /**
   * The commit this launch is running away from, when it is a crash-loop
   * fallback: the deployment is deliberately behind its own config, and that is
   * worth saying out loud.
   */
  quarantinedSha: string | null;
  crashLoop: CrashLoopRecord;
  reconcile: ReconcileState;
  /** One entry per supervised pipeline, keyed the same as the fleet's cells. */
  children: ChildLiveness[];
  slots: SlotReport;
  updatedAt: string;
};

/**
 * Tenant-level facts, as `phoebe list` shows them. They repeat across the cells
 * of one tenant on purpose: a console's row is the (tenant × pipeline) cell, and
 * a reader that had to join two tables to draw one row would be recomputing.
 */
export type TenantFacts = {
  /** The tenant's normalized config dir — its reconcile identity. */
  id: string;
  /** `owner/repo` when discovery recovered it; null otherwise. */
  slug: string | null;
  /** Display path: the tenant directory. */
  path: string;
  /** Discovery or enumeration would skip this tenant now; its children may still run. */
  held: boolean;
  /** Why it is held — the discovery error itself. Null when it is not. */
  reason: string | null;
  configValid: boolean;
  envPresent: boolean;
  retainedData: boolean;
  arm: CredentialArm;
};

/** One (tenant × pipeline) cell: the fleet matrix, one row per entry. */
export type FleetCell = {
  /** `<tenantId>#<pipeline>`. */
  id: string;
  tenant: TenantFacts;
  /** The pipeline's name within its tenant. */
  pipeline: string;
  source: PipelineSource;
  /** The pipeline's hot off-switch. False for a cell that was not enumerated. */
  disabled: boolean;
  /** The declared `concurrency` — the N in `working k/N`; null when unknown. */
  concurrency: number | null;
  /** Derived from the snapshot below, once, here. */
  state: PipelineState;
  /** Derived here too, and widened by the pass clock the bootstrapper holds. */
  wedged: WedgedVerdict;
  /** The raw `status.json` as the engine last wrote it; null when there is none. */
  snapshot: StatusSnapshot | null;
};

export type FleetReport = {
  /**
   * Every tenant this deployment knows about, pipelines or no pipelines. A
   * tenant held before its config was ever readable runs nothing and so fills no
   * cell, and it is exactly the tenant an operator needs to see — so the rows
   * are listed here and the matrix below is what hangs off them.
   */
  tenants: TenantFacts[];
  /** The (tenant × pipeline) matrix, one entry per cell. */
  cells: FleetCell[];
  updatedAt: string;
};

/** The whole report. One file, one model, every reader. */
export type DeploymentReport = {
  schema: number;
  identity: DeploymentIdentity;
  bootstrapper: BootstrapperReport;
  fleet: FleetReport;
  /**
   * What the last `phoebe doctor` run found, with its age (#507 §4). The
   * bootstrapper spawns those runs; a manual `phoebe doctor` prints and touches
   * nothing here.
   */
  doctor: DoctorSection;
  /** When any section last moved. */
  updatedAt: string;
};
