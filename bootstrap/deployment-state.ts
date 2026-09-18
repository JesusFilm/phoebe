// The live deployment report (#532) — the bootstrapper's in-memory model of
// what this whole deployment is doing, and the thing that writes
// `state/deployment.json` when it moves.
//
// Everything the report says is already known somewhere in `phoebe boot`; what
// was missing was one place holding all of it at once. This is that place. It
// is fed from four directions:
//
//   - **The supervision loop's hooks** — the live pipeline matrix each poll, and
//     the engine-axis reconcile as it starts.
//   - **The spawn wrapper boot already owns** — a child being spawned, being
//     asked to drain, and exiting. Those three moments are the whole of a
//     child's lifecycle, and boot sees each of them without the supervisor
//     needing a hook for it.
//   - **The engine's IPC** (bootstrap/engine-report-ipc.ts) — each child's
//     completed passes and its `status.json` writes.
//   - **Read at publish time** — the crash-loop record, the broker's numbers,
//     and whatever is on the tenants' disks that the live matrix does not
//     account for.
//
// Two rules keep it honest.
//
// **Derivation happens here, once.** A pipeline's state and its `wedged?`
// verdict are computed through src/pipeline-listing.ts — the one owner of both —
// and written into the file. A consumer renders them; `phoebe status`, the
// console and the companion cannot disagree about a pipeline because none of
// them decides anything.
//
// **A pass is not news.** A completed pass updates the pass clock in memory and
// publishes nothing: on a healthy idle pipeline it would rewrite the file every
// poll interval forever. What gets published is the *verdict* that clock feeds,
// when it flips — which the fleet poll re-derives anyway (#507).
//
// Nothing here may throw into the supervisor. A deployment that cannot write its
// own report is a deployment with a reporting fault, not a deployment that
// should stop working.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { HEALTHY_RUN_MS } from "./crash-loop.ts";
import type { EngineExit } from "./reconcile.ts";
import { pipelineId, type SupervisedPipeline } from "./pipelines.ts";
import type { CredentialArm } from "../src/contracts/credential-arm.ts";
import type {
  ChildExit,
  ChildLiveness,
  ChildState,
  ConfigSource,
  CrashLoopRecord,
  DeploymentIdentity,
  DeploymentReport,
  FleetCell,
  ReconcileState,
  RelayReport,
  SlotReport,
  TenantFacts,
} from "../src/contracts/deployment.ts";
import {
  EFFECTIVE_CONFIG_VERSION,
  type TenantEffectiveConfig,
} from "../src/contracts/effective-config.ts";
import type { StatusSnapshot } from "../src/contracts/status-snapshot.ts";
import { boundConfigRows, unknownConfig, type ConfigCollector } from "./config-report.ts";
import { PIPELINE_DEFAULTS } from "../src/config-schema.ts";
import { derivePaths } from "../src/paths.ts";
import {
  pipelineState,
  stateDirNames,
  wedgedVerdict,
  type PipelineSource,
} from "../src/pipeline-listing.ts";
import { readStatus, statusPathFor } from "../src/unit-event.ts";
import {
  deploymentReportPath,
  stampReport,
  writeDeploymentReport,
  type DeploymentDraft,
} from "./deployment-report.ts";

/**
 * A tenant discovery is holding, and why. The report shows it with its error
 * because a held tenant is the case an operator most needs the reason for — and
 * a tenant held before its config was ever readable has nothing else to show.
 */
export type HeldTenant = {
  /** The tenant's id — its config dir, the same key the matrix uses. */
  id: string;
  dir: string;
  envPath: string;
  slug: string | null;
  reason: string;
};

/** What the engine child running one pipeline last told the bootstrapper. */
export type EngineReport =
  | { kind: "pass"; pollIntervalMs: number | null }
  | { kind: "status"; snapshot: StatusSnapshot };

/**
 * The relay section as the link reports it (#540) — everything but the stamp,
 * which the report owns.
 */
export type RelayStatus = Omit<RelayReport, "updatedAt">;

/**
 * A deployment that dials nothing. Not an absent section: "this deployment has
 * no relay" is a fact a console states, and it states it from here.
 */
export const UNCONFIGURED_RELAY: RelayStatus = {
  configured: false,
  state: "unpaired",
  nextRetryAt: null,
  lastClose: null,
};

export type DeploymentStateDeps = {
  /**
   * Who this deployment is (#505). Read at publish time rather than handed over
   * once: `keyFingerprint` appears the moment a first pairing completes, and a
   * deployment that paired mid-run should not have to wait for a restart to say
   * so.
   */
  identity: () => DeploymentIdentity;
  /** The data volume's mount point — the report's home and the tenants' state dirs. */
  dataBase: string;
  /** The crash-loop guard's record, read at publish time. */
  crashLoop: () => CrashLoopRecord;
  /** The slot broker's numbers, read at publish time. */
  slots: () => SlotReport;
  /**
   * The root config an edit checks itself against (#503), read at publish time.
   * Cheap on a steady deployment: the hash is re-taken only when the file's stat
   * moves (bootstrap/config-report.ts).
   */
  rootConfig: () => ConfigSource;
  /**
   * The last config edit this deployment applied to its own root config (#536),
   * read at publish time from the edit ledger. Read rather than notified,
   * because the edit and the reconcile it causes can happen in different
   * processes: a shell `phoebe config set` writes the file and the supervisor
   * finds it on the next poll, exactly as it finds a hand edit. Absent for a
   * deployment that has never been edited through the verb.
   */
  lastEditId?: () => string | null;
  /** One tenant's credential arm, resolved the one shared way (#162). */
  armOf: (tenant: { envPath: string }) => CredentialArm;
  now?: () => number;
  /** Persist a report worth writing. Injected so tests never touch a disk. */
  write?: (report: DeploymentReport) => void;
  readSnapshot?: (path: string) => StatusSnapshot | null;
  listStateDirs?: (stateDir: string) => string[];
  exists?: (path: string) => boolean;
  /** How long a child must live to stop counting as crash-looping (#401). */
  healthyRunMs?: number;
  /** The report could not be written. One log line; never a throw. */
  onWriteError?: (error: unknown) => void;
  /**
   * The report moved and was written (#542). The relay link's cue to push it;
   * the link reads the report itself through {@link DeploymentState.latest}, so
   * this is a signal rather than a delivery. Never called when nothing changed,
   * which is what makes the push "on change" rather than "on a timer".
   */
  onReport?: () => void;
};

/** What the bootstrapper tells the model. Every method is safe to call at any time. */
export type DeploymentState = {
  /** A fresh materialization: which ref, which commit, what it is avoiding. */
  noteEngine: (engine: {
    ref: string | null;
    sha: string | null;
    quarantinedSha: string | null;
    /**
     * How to ask *this* checkout for a tenant's effective config (#535). It
     * arrives with the engine because the answer is the engine's: a relaunch
     * onto a different commit is a different answer, and a new collector is how
     * the cached rows are dropped without a second trigger.
     */
    config?: ConfigCollector;
  }) => void;
  /** The engine axis moved; the fleet is draining onto a new engine. */
  noteReconcile: (reason: "config" | "ref") => void;
  /** A child was spawned for this pipeline. Ends a reconcile: the fleet is back up. */
  noteSpawn: (pipeline: SupervisedPipeline) => void;
  /** We asked this child to stop — its exit is expected. */
  noteDraining: (pipelineId: string) => void;
  /** This child is gone, however it went. */
  noteExit: (pipelineId: string, exit: EngineExit) => void;
  /** One child's IPC report — a completed pass, or a snapshot it just wrote. */
  noteEngineReport: (pipelineId: string, report: EngineReport) => void;
  /** The live pipeline matrix, as of this poll. */
  notePipelines: (pipelines: readonly SupervisedPipeline[]) => void;
  /**
   * Where the relay link stands (#540). Never called on a deployment with no
   * `relay` block — that is what leaves the section at {@link UNCONFIGURED_RELAY}.
   */
  noteRelay: (status: RelayStatus) => void;
  /**
   * The tenants discovery is holding right now, with their reasons. Nothing is
   * held until something says so, which is also solo's whole answer: the root is
   * the tenant, and a root that will not load never reaches supervision.
   */
  noteHolds: (held: readonly HeldTenant[]) => void;
  /** Rebuild the report and write it if anything moved. */
  publish: () => void;
  /**
   * The report as it was last written, or null before the first one. What the
   * relay link sends, and the only copy: a reader that held its own would be
   * holding a second answer to a question with one (#542).
   */
  latest: () => DeploymentReport | null;
};

type ChildRecord = {
  pipeline: SupervisedPipeline;
  state: ChildState;
  /** When it entered {@link state}, in ms. */
  since: number;
  spawnedAt: number;
  restarts: number;
  crashLooping: boolean;
  lastExit: ChildExit | null;
  lastPassAt: number | null;
  /** The cadence this pipeline reported; the default until its first pass. */
  pollIntervalMs: number;
  /** The snapshot its engine last wrote, as handed over rather than re-read. */
  snapshot: StatusSnapshot | null;
};

const iso = (ms: number): string => new Date(ms).toISOString();

/**
 * The reconcile section with the last applied edit's id on it. Stamped at
 * publish rather than carried in the live state: the id outlives the reconcile
 * it set going, and a console reading an idle deployment still wants to know
 * which edit it settled on.
 */
function withLastEdit(state: ReconcileState, lastEditId: string | null): ReconcileState {
  return lastEditId === null ? state : { ...state, lastEditId };
}

/**
 * How a tenant names itself in the config section when the engine never got to
 * answer for it: its slug if discovery recovered one, else its directory. The
 * engine's own rows name themselves — `repoSlug`, or the config's path.
 */
function nameOf(tenant: { slug: string | null; dir: string }): string {
  return tenant.slug ?? tenant.dir;
}

/**
 * Build the live model. Nothing is written until something is noted: a
 * deployment that has not come up yet has no report to make.
 */
export function createDeploymentState(deps: DeploymentStateDeps): DeploymentState {
  const now = deps.now ?? Date.now;
  const write =
    deps.write ??
    ((report: DeploymentReport) =>
      writeDeploymentReport(deploymentReportPath(deps.dataBase), report));
  const readSnapshot = deps.readSnapshot ?? readStatus;
  const listStateDirs = deps.listStateDirs ?? ((stateDir: string) => stateDirNames(stateDir));
  const exists = deps.exists ?? existsSync;
  const healthyRunMs = deps.healthyRunMs ?? HEALTHY_RUN_MS;

  const children = new Map<string, ChildRecord>();
  let live: readonly SupervisedPipeline[] = [];
  let holds: readonly HeldTenant[] = [];
  let engine = {
    ref: null as string | null,
    sha: null as string | null,
    quarantinedSha: null as string | null,
  };
  let reconcile: ReconcileState = { phase: "idle", since: iso(now()) };
  let relay: RelayStatus = UNCONFIGURED_RELAY;
  let last: DeploymentReport | null = null;
  /** The running engine's collector — set by `noteEngine`, dropped with the launch. */
  let collector: ConfigCollector | null = null;
  /** The config section as it stands: already ordered, already inside its budget. */
  let config: { tenants: TenantEffectiveConfig[]; omitted: number } = { tenants: [], omitted: 0 };

  /**
   * Re-read every tenant's effective config and re-fit the section.
   *
   * Called from the two hooks that can move it — the poll's pipeline matrix and
   * the hold list — never from `publish`, because a cache miss here spawns an
   * engine process per tenant and `publish` runs on every child's every status
   * write. The collector answers from its cache unless a tenant's config or
   * `.env` actually moved, so a steady fleet pays a stat per tenant per poll.
   *
   * A held tenant carries its discovery error rather than the resolution it had
   * before it was held (#501 §5): the settings of a tenant nobody can read are
   * unknown, and the last good ones are the most convincing way to be wrong.
   * A tenant nothing has asked yet — the window before the first engine is
   * materialized — has no row at all rather than a manufactured one.
   */
  const refreshConfig = (): void => {
    const heldById = new Map(holds.map((hold) => [hold.id, hold] as const));
    const rows: { id: string; row: TenantEffectiveConfig }[] = [];
    const asked = new Set<string>();
    for (const pipeline of live) {
      const tenant = pipeline.tenant;
      if (asked.has(tenant.id)) continue;
      asked.add(tenant.id);
      const held = heldById.get(tenant.id);
      if (held !== undefined) {
        rows.push({ id: tenant.id, row: unknownConfig(nameOf(tenant), `held — ${held.reason}`) });
        continue;
      }
      if (collector === null) continue;
      rows.push({
        id: tenant.id,
        row: collector.read({
          id: tenant.id,
          configPath: tenant.configPath,
          envPath: tenant.envPath,
          cwd: tenant.dir,
        }),
      });
    }
    for (const held of holds) {
      if (asked.has(held.id)) continue;
      asked.add(held.id);
      rows.push({ id: held.id, row: unknownConfig(nameOf(held), `held — ${held.reason}`) });
    }
    rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    config = boundConfigRows(rows.map((entry) => entry.row));
  };

  /** The tenant a cell belongs to, with the facts `phoebe list` shows for it. */
  const factsFor = (
    tenant: { id: string; dir: string; envPath: string; slug: string | null },
    held: HeldTenant | undefined,
  ): TenantFacts => ({
    id: tenant.id,
    slug: tenant.slug,
    path: tenant.dir,
    held: held !== undefined,
    reason: held?.reason ?? null,
    // A hold that landed before the config was readable never recovered a slug;
    // one that landed after (a failed enumeration, a failed mint) did. That is
    // the same test `phoebe list` lights a held row's columns from (#140).
    configValid: held === undefined || tenant.slug !== null,
    envPresent: exists(tenant.envPath),
    retainedData: tenant.slug !== null && exists(join(deps.dataBase, tenant.slug)),
    arm: deps.armOf(tenant),
  });

  const cellFor = (opts: {
    id: string;
    facts: TenantFacts;
    name: string;
    source: PipelineSource;
    disabled: boolean;
    concurrency: number | null;
    snapshot: StatusSnapshot | null;
    pollIntervalMs: number;
    lastPassAt: number | null;
    since: number | null;
    at: number;
  }): FleetCell => ({
    id: opts.id,
    tenant: opts.facts,
    pipeline: opts.name,
    source: opts.source,
    disabled: opts.disabled,
    concurrency: opts.concurrency,
    state: pipelineState(opts.snapshot),
    wedged: wedgedVerdict({
      snapshot: opts.snapshot,
      pollIntervalMs: opts.pollIntervalMs,
      lastPassAt: opts.lastPassAt,
      since: opts.since,
      now: opts.at,
    }),
    snapshot: opts.snapshot,
  });

  /**
   * The fleet matrix: every live pipeline, plus whatever is on the tenants'
   * disks that no live pipeline accounts for.
   *
   * A directory with no live pipeline behind it is `stale` — a renamed or
   * deleted pipeline whose snapshot outlived it — except under a held tenant
   * running nothing, where the pipeline set is exactly what could not be read
   * and the honest provenance is `disk`. Same three-way answer `phoebe list`
   * gives, from the same evidence.
   */
  const buildFleet = (at: number): { tenants: TenantFacts[]; cells: FleetCell[] } => {
    const heldById = new Map(holds.map((hold) => [hold.id, hold] as const));
    const tenants = new Map<
      string,
      { id: string; dir: string; envPath: string; slug: string | null }
    >();
    for (const pipeline of live) tenants.set(pipeline.tenant.id, pipeline.tenant);
    for (const hold of holds) if (!tenants.has(hold.id)) tenants.set(hold.id, hold);

    const cells: FleetCell[] = [];
    const rows: TenantFacts[] = [];
    for (const [tenantId, tenant] of tenants) {
      const facts = factsFor(tenant, heldById.get(tenantId));
      rows.push(facts);
      const stateDir =
        tenant.slug === null ? null : derivePaths(tenant.slug, deps.dataBase).stateDir;
      const mine = live.filter((pipeline) => pipeline.tenant.id === tenantId);
      for (const pipeline of mine) {
        const record = children.get(pipeline.id);
        const running = record?.state === "running";
        const snapshot =
          record?.snapshot ??
          (stateDir === null
            ? null
            : readSnapshot(statusPathFor(stateDir, pipeline.pipeline.name)));
        cells.push(
          cellFor({
            id: pipeline.id,
            facts,
            name: pipeline.pipeline.name,
            source: "enumerated",
            disabled: pipeline.pipeline.disabled,
            concurrency: pipeline.pipeline.concurrency,
            snapshot,
            pollIntervalMs: record?.pollIntervalMs ?? PIPELINE_DEFAULTS.pollIntervalMs,
            lastPassAt: running ? (record?.lastPassAt ?? null) : null,
            since: running ? (record?.spawnedAt ?? null) : null,
            at,
          }),
        );
      }
      if (stateDir === null) continue;
      const known = new Set(mine.map((pipeline) => pipeline.pipeline.name));
      const source: PipelineSource = facts.held && mine.length === 0 ? "disk" : "stale";
      for (const name of listStateDirs(stateDir)) {
        if (known.has(name)) continue;
        const snapshot = readSnapshot(statusPathFor(stateDir, name));
        // An empty directory says nothing about a pipeline a held tenant may or
        // may not declare; a stale one is worth reporting whatever it holds.
        if (snapshot === null && source === "disk") continue;
        cells.push(
          cellFor({
            id: pipelineId(tenantId, name),
            facts,
            name,
            source,
            disabled: false,
            concurrency: null,
            snapshot,
            pollIntervalMs: PIPELINE_DEFAULTS.pollIntervalMs,
            lastPassAt: null,
            since: null,
            at,
          }),
        );
      }
    }
    const byId = <T extends { id: string }>(a: T, b: T): number =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    return { tenants: rows.sort(byId), cells: cells.sort(byId) };
  };

  const livenessOf = (at: number): ChildLiveness[] => {
    const rows: ChildLiveness[] = [];
    for (const record of children.values()) {
      // A child that has been up past the healthy window has proved itself, so
      // it is no longer crash-looping — the same moment the supervisor's own
      // universality bookkeeping clears the mark. Banked on the record rather
      // than recomputed, so the mark survives the exit that follows.
      if (record.state === "running" && at - record.spawnedAt >= healthyRunMs) {
        record.crashLooping = false;
      }
      rows.push({
        id: record.pipeline.id,
        state: record.state,
        since: iso(record.since),
        restarts: record.restarts,
        crashLooping: record.crashLooping,
        lastExit: record.lastExit,
        lastPassAt: record.lastPassAt === null ? null : iso(record.lastPassAt),
      });
    }
    return rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  };

  const publish = (): void => {
    try {
      const at = now();
      const draft: DeploymentDraft = {
        identity: deps.identity(),
        bootstrapper: {
          engineRef: engine.ref,
          engineSha: engine.sha,
          quarantinedSha: engine.quarantinedSha,
          crashLoop: deps.crashLoop(),
          reconcile: withLastEdit(reconcile, deps.lastEditId?.() ?? null),
          children: livenessOf(at),
          slots: deps.slots(),
        },
        relay,
        fleet: buildFleet(at),
        config: {
          version: collector?.version() ?? EFFECTIVE_CONFIG_VERSION,
          root: deps.rootConfig(),
          tenants: config.tenants,
          omitted: config.omitted,
        },
      };
      const next = stampReport(draft, last, iso(at));
      if (next === null) return;
      write(next);
      last = next;
    } catch (error) {
      deps.onWriteError?.(error);
      return;
    }
    // Outside the try: a relay that throws on the way to a socket is not a
    // failure to write the report, and must not be reported as one.
    deps.onReport?.();
  };

  return {
    noteEngine(next) {
      engine = { ref: next.ref, sha: next.sha, quarantinedSha: next.quarantinedSha };
      if (next.config !== undefined) {
        collector = next.config;
        // A new checkout is a new answer, so the section is re-read here rather
        // than left until the next poll: a reconcile onto a different engine is
        // exactly when an operator is watching the report.
        refreshConfig();
      }
      publish();
    },

    noteReconcile(reason) {
      reconcile = { phase: "reconciling", reason, since: iso(now()) };
      publish();
    },

    noteSpawn(pipeline) {
      const at = now();
      const previous = children.get(pipeline.id);
      children.set(pipeline.id, {
        pipeline,
        state: "running",
        since: at,
        spawnedAt: at,
        restarts: previous?.restarts ?? 0,
        // Sticky across a respawn: a pipeline that keeps dying instantly is
        // crash-looping between attempts as much as during them.
        crashLooping: previous?.crashLooping ?? false,
        lastExit: previous?.lastExit ?? null,
        lastPassAt: null,
        pollIntervalMs: previous?.pollIntervalMs ?? PIPELINE_DEFAULTS.pollIntervalMs,
        // The snapshot on disk is the old process's last word. Dropping it here
        // would blank a working pipeline's cell for a whole poll; keeping it is
        // what the file itself would have said anyway.
        snapshot: previous?.snapshot ?? null,
      });
      // A fleet that is spawning again is a fleet that has finished reconciling.
      if (reconcile.phase === "reconciling") reconcile = { phase: "idle", since: iso(at) };
      publish();
    },

    noteDraining(pipelineId) {
      const record = children.get(pipelineId);
      if (record === undefined || record.state !== "running") return;
      record.state = "draining";
      record.since = now();
      // A child we stopped is a child whose next start is ours to make; its death
      // is evidence about nothing.
      record.crashLooping = false;
      publish();
    },

    noteExit(pipelineId, exit) {
      const record = children.get(pipelineId);
      if (record === undefined) return;
      const at = now();
      const expected = record.state === "draining";
      record.lastExit = { code: exit.code, signal: exit.signal, at: iso(at) };
      record.state = "exited";
      record.since = at;
      if (!expected) {
        record.restarts += 1;
        record.crashLooping = at - record.spawnedAt < healthyRunMs;
      }
      publish();
    },

    noteEngineReport(pipelineId, report) {
      const record = children.get(pipelineId);
      if (record === undefined) return;
      if (report.kind === "pass") {
        record.lastPassAt = now();
        if (report.pollIntervalMs !== null && report.pollIntervalMs > 0) {
          record.pollIntervalMs = report.pollIntervalMs;
        }
        // Deliberately no publish: see the header. The clock feeds a verdict the
        // next poll re-derives, and a pass by itself is not news.
        return;
      }
      record.snapshot = report.snapshot;
      publish();
    },

    notePipelines(pipelines) {
      live = [...pipelines];
      // A pipeline the matrix no longer names is a pipeline this deployment no
      // longer runs: drop its liveness rather than reporting a child nobody will
      // ever respawn. Anything it left on disk comes back as a stale cell.
      const named = new Set(live.map((pipeline) => pipeline.id));
      const orphaned: string[] = [];
      for (const id of children.keys()) if (!named.has(id)) orphaned.push(id);
      for (const id of orphaned) children.delete(id);
      refreshConfig();
      publish();
    },

    noteRelay(status) {
      relay = status;
      publish();
    },

    noteHolds(held) {
      holds = [...held];
      refreshConfig();
      publish();
    },

    publish,

    latest: () => last,
  };
}
