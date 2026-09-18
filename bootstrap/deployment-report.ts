// `state/deployment.json` — the file half of the deployment report (#532, #501).
//
// One deployment keeps one of these on its data volume, and it is the single
// read model: `phoebe status` reads it, the relay sender ships it, the companion
// renders what the relay forwarded. The type it holds is in contracts
// (src/contracts/deployment.ts), where a browser can load it; the live model
// that produces one is bootstrap/deployment-state.ts. This module owns three
// things those two deliberately do not: where the file lives, how it is
// replaced, and when it is worth replacing at all.
//
// **Where.** `<dataBase>/state/deployment.json`, beside the relay key #505 puts
// on the same volume. Tenant data nests two segments deep
// (`<dataBase>/<owner>/<repo>/`), so a deployment-level `state/` directory
// cannot be confused with a tenant's.
//
// **How.** Write a sibling temp file, `rename` it over the target. The same
// atomic replace `status.json` uses (#73) and for the same reason: a reader
// mid-write must see the whole old file or the whole new one, never half of
// either.
//
// **When.** On change, which needs a definition, because two fields in the
// report move constantly without anything happening. Each child's `lastPassAt`
// advances every poll of a perfectly idle engine, and the `updatedAt` stamps
// move whenever anything else does. So a draft is compared to what was last
// written with the pass clocks and the stamps taken out; if what is left is
// identical, nothing is written and the file keeps the stamps it had. That is
// what makes "rewritten on change" true rather than "rewritten on a timer", and
// it is the same rule #507 states for the relay: pushed when the wedged flag
// flips, not once per pass.
//
// A section's own `updatedAt` therefore means "when this section last moved",
// not "when we last looked" — which is the only reading that survives a console
// showing ages.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  DEPLOYMENT_SCHEMA,
  type BootstrapperReport,
  type ConfigReport,
  type DeploymentIdentity,
  type DeploymentReport,
  type FleetReport,
  type RelayReport,
} from "../src/contracts/deployment.ts";
import type { DoctorSection } from "../src/contracts/doctor.ts";

/** The report's filename inside the deployment-level `state/` directory. */
export const DEPLOYMENT_FILE = "deployment.json";

/** Where the report lives, given the data volume's mount point. */
export function deploymentReportPath(dataBase: string): string {
  return join(dataBase, "state", DEPLOYMENT_FILE);
}

/**
 * A report with the stamps left off: what the live model builds every time it is
 * asked, and what {@link stampReport} turns into a report worth writing — or
 * into nothing at all.
 */
export type DeploymentDraft = {
  identity: DeploymentIdentity;
  bootstrapper: Omit<BootstrapperReport, "updatedAt">;
  relay: Omit<RelayReport, "updatedAt">;
  fleet: Omit<FleetReport, "updatedAt">;
  config: Omit<ConfigReport, "updatedAt">;
  doctor: Omit<DoctorSection, "updatedAt">;
};

/**
 * One section as its content alone, with the pass clocks blanked — the one field
 * that advances without anything having happened (see `ChildLiveness.lastPassAt`).
 * Two of these comparing equal is what "nothing changed" means here.
 *
 * Only the clocks. A snapshot's own `updatedAt` is left in, because the engine
 * moving it means the engine wrote its file, which is exactly the news this
 * report exists to carry.
 */
function contentOf(section: unknown): string {
  return JSON.stringify(section, (key, field: unknown) =>
    key === "lastPassAt" ? undefined : field,
  );
}

/**
 * A written section as it was before it was stamped — the shape a draft has, so
 * the two are comparable. Rest-spread rather than a copy, so the key order the
 * stamp was appended to is preserved and `JSON.stringify` compares like with like.
 */
function unstamped<T extends { updatedAt: string }>(section: T): Omit<T, "updatedAt"> {
  const { updatedAt: _stamp, ...content } = section;
  return content;
}

/**
 * Stamp a draft against the last report written, or return null when the
 * deployment has not moved.
 *
 * Each section keeps its old stamp unless its own content moved, so a fleet that
 * churns while the bootstrapper sits still does not make the bootstrapper
 * section look fresh. The top-level stamp moves whenever any section does,
 * which makes it the age a console shows for the report as a whole.
 */
export function stampReport(
  draft: DeploymentDraft,
  previous: DeploymentReport | null,
  now: string,
): DeploymentReport | null {
  const identityMoved =
    previous === null || contentOf(previous.identity) !== contentOf(draft.identity);
  const bootstrapperMoved =
    previous === null ||
    contentOf(unstamped(previous.bootstrapper)) !== contentOf(draft.bootstrapper);
  const relayMoved =
    previous === null || contentOf(unstamped(previous.relay)) !== contentOf(draft.relay);
  const fleetMoved =
    previous === null || contentOf(unstamped(previous.fleet)) !== contentOf(draft.fleet);
  const configMoved =
    previous === null || contentOf(unstamped(previous.config)) !== contentOf(draft.config);
  // The doctor section moves on its own clock — a run starting, a run landing,
  // an attempt failing — and each of those is news. A run that finds exactly
  // what the last one found still moves it, because `at` is the age a console
  // shows, and an age that stopped advancing is the one thing worse than none.
  const doctorMoved =
    previous === null || contentOf(unstamped(previous.doctor)) !== contentOf(draft.doctor);
  if (
    !identityMoved &&
    !bootstrapperMoved &&
    !relayMoved &&
    !fleetMoved &&
    !configMoved &&
    !doctorMoved
  ) {
    return null;
  }
  return {
    schema: DEPLOYMENT_SCHEMA,
    identity: draft.identity,
    bootstrapper: {
      ...draft.bootstrapper,
      updatedAt: bootstrapperMoved ? now : (previous?.bootstrapper.updatedAt ?? now),
    },
    relay: {
      ...draft.relay,
      updatedAt: relayMoved ? now : (previous?.relay.updatedAt ?? now),
    },
    fleet: {
      ...draft.fleet,
      updatedAt: fleetMoved ? now : (previous?.fleet.updatedAt ?? now),
    },
    config: {
      ...draft.config,
      updatedAt: configMoved ? now : (previous?.config.updatedAt ?? now),
    },
    doctor: {
      ...draft.doctor,
      updatedAt: doctorMoved ? now : (previous?.doctor.updatedAt ?? now),
    },
    updatedAt: now,
  };
}

/**
 * Replace the report atomically. The temp name carries the pid so two processes
 * writing the same volume cannot clobber each other's partial file — the same
 * guard `writeStatus` uses.
 */
export function writeDeploymentReport(path: string, report: DeploymentReport): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${process.pid}.${DEPLOYMENT_FILE}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(report, null, 2)}\n`);
  renameSync(tmp, path);
}

/**
 * The report as it stands on disk, or null when there is none to read. Null for
 * a missing, unreadable or half-parsed file alike: a reader that cannot get the
 * whole report has nothing to say about the deployment, and the atomic write
 * above means a partial file is never what it is looking at.
 */
export function readDeploymentReport(path: string): DeploymentReport | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as DeploymentReport;
  } catch {
    return null;
  }
}
