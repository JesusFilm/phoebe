// What the console's header says about the pipelines behind its tabs.
//
// The console is the container's output, and output says what happened. What
// is happening now, and what is wrong, are in the install's report: which
// pipeline has a unit in flight and what kind of unit it is, which one is
// wedged or crash-looping, which tenant is held. This reads those off the same
// report the rail does, keyed the way the tabs are (logs-channels.ts), so a tab
// and the header above it can carry them.
//
// Pure. console-view.tsx draws it.

import type { LocalInstall, LocalReportEvent } from "phoebe-agent/contracts";
import { harnessPin, providerOf } from "./harness.ts";
import {
  cellProblems,
  crashLoopingCells,
  fleetTenantProblems,
  renderableReport,
  workspaceChildren,
  type RailProblem,
} from "./local-install.ts";
import { ALL_CHANNEL, channelLabel, tenantChannel } from "./logs-channels.ts";
import { readReport } from "./report.ts";

/** One tab's standing: whether its pipeline is working, on what, and what is wrong with it. */
export type ChannelStatus = {
  /** A unit is in flight. */
  active: boolean;
  /** The units in flight, as the log tags them: `issue 497`. */
  units: string[];
  problems: RailProblem[];
};

const QUIET: ChannelStatus = { active: false, units: [], problems: [] };

/** A pipeline with a unit in flight, as the header names it. */
export type WorkingPipeline = {
  /** The tab it speaks on: `<owner>/<repo>:<pipeline>`. */
  channel: string;
  /** The tab's own label. */
  label: string;
  units: string[];
};

export type ConsoleStatus = {
  /** Every pipeline working right now, in the fleet's order. */
  working: WorkingPipeline[];
  /** Everything wrong on the install, errors before warnings. */
  problems: RailProblem[];
  /** By tab: one pipeline's, and each tenant's whole set under `<slug>:*`. */
  channels: Map<string, ChannelStatus>;
};

/**
 * The install's standing, off its latest read. A stopped install has nothing
 * working, and still has whatever the host found: a `.env` the container
 * cannot read is as true stopped as running.
 */
export function consoleStatus(
  install: LocalInstall,
  event: LocalReportEvent | null,
  /** What is wrong with the install itself rather than with a tenant of it: its container, its image. */
  ofInstall: readonly RailProblem[] = [],
): ConsoleStatus {
  const reading = readReport(renderableReport(install, event));
  const report = reading.kind === "read" ? reading.report : null;
  const working: WorkingPipeline[] = [];
  const problems: RailProblem[] = [];
  const channels = new Map<string, ChannelStatus>();
  const workspace = install.workspace !== undefined;

  // What the host knows, by slug: the rail's rows on a workspace, where each
  // child's `.env` and provider have been checked; the one config on a solo.
  const rows = workspace ? workspaceChildren(install, event) : [];
  const soloProvider = workspace ? null : providerOf(event?.directory.configFields);
  const soloWarnings: RailProblem[] =
    soloProvider !== null && harnessPin(event, soloProvider)?.kind === "absent"
      ? [{ level: "warning", text: `its provider (${soloProvider}) has no CLI in the container` }]
      : [];

  if (report !== null) {
    const crashLooping = crashLoopingCells(report);
    for (const tenant of report.fleet.tenants) {
      if (tenant.slug === null) continue;
      const units: string[] = [];
      let active = false;
      for (const cell of report.fleet.cells) {
        if (cell.tenant.id !== tenant.id) continue;
        const channel = `${tenant.slug}:${cell.pipeline}`;
        const running = (cell.snapshot?.currentUnits ?? []).map(
          (current) => `${current.unit.kind} ${current.unit.id}`,
        );
        const wrong = cellProblems(cell, crashLooping);
        const cellActive = cell.state === "working";
        channels.set(channel, {
          active: cellActive,
          units: running,
          problems: [...wrong.errors, ...wrong.warnings],
        });
        if (cellActive) {
          active = true;
          units.push(...running);
          working.push({ channel, label: channelLabel(channel), units: running });
        }
      }
      const row = rows.find((candidate) => candidate.slug === tenant.slug);
      const tenantProblems = workspace
        ? (row?.problems ?? fleetTenantProblems(report, tenant))
        : fleetTenantProblems(report, tenant, { errors: [], warnings: soloWarnings });
      channels.set(tenantChannel(tenant.slug), { active, units, problems: tenantProblems });
    }
  }

  if (workspace) {
    // Every child the workspace lists, in the fleet or not, each problem said
    // with whose it is: the header speaks for all of them at once.
    for (const row of rows) {
      const whose = row.slug === null ? row.label : channelLabel(tenantChannel(row.slug));
      for (const problem of row.problems) {
        problems.push({ level: problem.level, text: `${whose}: ${problem.text}` });
      }
    }
  } else if (report !== null) {
    for (const tenant of report.fleet.tenants) {
      problems.push(...fleetTenantProblems(report, tenant, { errors: [], warnings: soloWarnings }));
    }
  } else {
    problems.push(...soloWarnings);
  }

  // The install's own first: a container that cannot run a unit at all is the
  // cause under whatever each tenant goes on to report.
  problems.unshift(...ofInstall);
  // Errors ahead of warnings across the whole install, each level in the order found.
  const errors = problems.filter((problem) => problem.level === "error");
  const warnings = problems.filter((problem) => problem.level !== "error");
  return { working, problems: [...errors, ...warnings], channels };
}

/**
 * One tab's standing. "all" speaks for the install. A pipeline's tab and a
 * tenant's are looked up. Any other tab under a tenant is an agent's own output
 * (`<owner>/<repo>:claude`), which is busy exactly when its tenant has a unit
 * in flight and has no problems of its own to carry. The bootstrapper's is quiet.
 */
export function channelStatus(status: ConsoleStatus, channel: string): ChannelStatus {
  if (channel === ALL_CHANNEL) {
    return {
      active: status.working.length > 0,
      units: status.working.flatMap((pipeline) => pipeline.units),
      problems: status.problems,
    };
  }
  const exact = status.channels.get(channel);
  if (exact !== undefined) return exact;
  const colon = channel.indexOf(":");
  if (colon === -1) return QUIET;
  const tenant = status.channels.get(tenantChannel(channel.slice(0, colon)));
  return tenant === undefined
    ? QUIET
    : { active: tenant.active, units: tenant.units, problems: [] };
}

/** A tab's hover text: what it is, then what it is working on and what is wrong. */
export function channelTitle(what: string, status: ChannelStatus): string {
  return [
    what,
    ...(status.active
      ? [status.units.length === 0 ? "Working" : `Working on ${status.units.join(", ")}`]
      : []),
    ...status.problems.map(
      (problem) => `${problem.level === "error" ? "Error" : "Warning"} — ${problem.text}`,
    ),
  ].join("\n");
}
