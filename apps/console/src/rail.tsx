// The rail — every install, always on screen.
//
// This is why variant C won the web prototype (#509): "is everything alive" is
// the first question the map asks, and the rail answers it from whatever page
// the operator is on. So it takes every install on this machine and renders
// them all, and the page beside it is none of its business.
//
// A local entry opens its console; the gear on it opens the install's tabbed
// page (#555). A workspace opens out to its children.
//
// Under the list sits the one line that is about the window itself: a newer
// companion, when there is one (#525 §3). It says nothing at all until there is
// something to click — a check that found nothing is not news.

import { useState } from "react";
import type {
  CompanionUpdate,
  HostPlatform,
  LocalInstall,
  LocalReportEvent,
} from "phoebe-agent/contracts";
import type { Surface } from "./companion.ts";
import {
  ArrowUpCircle,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Pause,
  Play,
  RotateCcw,
  Settings,
  Square,
  TriangleAlert,
} from "lucide-react";
import { Button } from "~/components/ui/button";
import { HostIcon, hostOfProcessPlatform, hostTitle } from "./host-icon.tsx";
import { Spinner } from "~/components/ui/spinner";
import {
  installActions,
  installReading,
  problemCounts,
  workspaceChildren,
  workspaceSummary,
  type RailProblem,
  type InstallAction,
  type RailChild,
} from "./local-install.ts";
import { HOME_HREF, SETTINGS_HREF } from "./route.ts";

export function Rail({
  surface,
  installs = [],
  selected = null,
  selectedChild = null,
  update = null,
  busy,
  reports,
  updates,
  platform,
  defaultExpanded,
  onSelect,
  onSettings,
  onChild,
  onChildSettings,
  onAction,
  onAdd,
  onHome,
  onDownload,
  onRestart,
}: {
  surface: Surface;
  /** The installs on this machine. Empty in a browser, which has none. */
  installs?: LocalInstall[];
  /** The install whose page is open, by directory. */
  selected?: string | null;
  /** The companion's own update. Null in a browser, which updates with a reload. */
  update?: CompanionUpdate | null;
  /** The installs with a verb run in flight, by directory (run-activity.ts). */
  busy?: ReadonlySet<string>;
  /** The latest read per install, by directory: what a workspace's children are doing. */
  reports?: Readonly<Record<string, LocalReportEvent>>;
  /** How many updates are on offer per install, by directory (update-alert.tsx). */
  updates?: Readonly<Record<string, number>>;
  /** The companion's `process.platform`: which host a local install runs on. */
  platform?: string;
  /** The workspaces opened out to their children to begin with, by directory. */
  defaultExpanded?: ReadonlySet<string>;
  onSelect?: (dir: string) => void;
  /** The gear: the install's tabbed page. Without it there is no gear. */
  onSettings?: (dir: string) => void;
  /** A workspace child: the console on the child's lines. */
  onChild?: (dir: string, child: RailChild) => void;
  /** The gear on a workspace child: that tenant's own config. */
  onChildSettings?: (dir: string, child: RailChild) => void;
  /** The tenant whose config is open, by folder. */
  selectedChild?: string | null;
  /** The entry shortcuts. Absent in a browser, which has no local arm. */
  onAction?: (dir: string, action: InstallAction) => void;
  onAdd?: () => void;
  /**
   * The brand: home. The hash does the moving; this is for when the hash is
   * already home's and setting it again changes nothing, so the open install
   * is closed here as well (as `onAdd` does).
   */
  onHome?: () => void;
  onDownload?: () => void;
  onRestart?: () => void;
}) {
  // Which workspaces are opened out to their children. Closed to begin with:
  // a rail of six workspaces opened out is a list, not a rail.
  // The host every non-WSL local install shares: this machine.
  const companionHost = platform === undefined ? null : hostOfProcessPlatform(platform);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => defaultExpanded ?? new Set());
  return (
    <nav className="rail" aria-label="This machine">
      <RailBrand surface={surface} {...(onHome === undefined ? {} : { onHome })} />
      <section className="rail-group" aria-label="This machine">
        <h2 className="rail-heading">
          This machine
          {onAdd === undefined ? null : (
            <button type="button" className="rail-add" onClick={onAdd}>
              + add
            </button>
          )}
        </h2>
        {installs.length === 0 ? (
          <p className="rail-empty">No local install yet.</p>
        ) : (
          installs.map((install) => (
            <InstallEntry
              key={install.dir}
              install={install}
              current={install.dir === selected}
              busy={busy?.has(install.dir) ?? false}
              updates={updates?.[install.dir] ?? 0}
              host={install.wsl === undefined ? companionHost : "wsl"}
              children={workspaceChildren(install, reports?.[install.dir] ?? null)}
              expanded={expanded.has(install.dir)}
              onToggle={() =>
                setExpanded((held) => {
                  const next = new Set(held);
                  if (next.has(install.dir)) next.delete(install.dir);
                  else next.add(install.dir);
                  return next;
                })
              }
              {...(onSelect !== undefined ? { onSelect } : {})}
              {...(onSettings !== undefined ? { onSettings } : {})}
              {...(onChild !== undefined ? { onChild } : {})}
              {...(onChildSettings !== undefined ? { onChildSettings } : {})}
              selectedChild={install.dir === selected ? selectedChild : null}
              {...(onAction !== undefined ? { onAction } : {})}
            />
          ))
        )}
      </section>
      <UpdateNotice
        update={update}
        {...(onDownload !== undefined ? { onDownload } : {})}
        {...(onRestart !== undefined ? { onRestart } : {})}
      />
      <RailFoot />
    </nav>
  );
}

/** The brand, at the top of the rail, and the way home. */
function RailBrand({ surface, onHome }: { surface: Surface; onHome?: () => void }) {
  return (
    <a
      className="rail-brand"
      href={HOME_HREF}
      {...(onHome === undefined ? {} : { onClick: onHome })}
    >
      {surface === "companion" ? "Phoebe" : "Phoebe console"}
    </a>
  );
}

/**
 * The foot of the rail: a bare gear onto the console's own settings
 * (settings-page.tsx), where T3 Code keeps its. A control, not a place on the
 * rail, so it never reads as selected. The app's settings, not an install's:
 * those are behind the gear on the install's own entry.
 */
function RailFoot() {
  return (
    <footer className="rail-foot">
      <a className="rail-settings" href={SETTINGS_HREF} aria-label="Settings" title="Settings">
        <Settings size={16} aria-hidden="true" />
      </a>
    </footer>
  );
}

/**
 * The companion's own update, in one line at the foot of the rail.
 *
 * Three states have something to say and the rest do not. Checking, nothing
 * newer, and a feed nobody could read are all "carry on"; an unsupported
 * companion — macOS until signing lands, or one run from a checkout — is told
 * about a new build by the release page rather than by this line (#525 §3).
 */
function UpdateNotice({
  update,
  onDownload,
  onRestart,
}: {
  update: CompanionUpdate | null;
  onDownload?: () => void;
  onRestart?: () => void;
}) {
  if (update === null) return null;

  switch (update.kind) {
    case "available":
      return (
        <footer className="rail-update">
          Phoebe {update.version} is available.{" "}
          {onDownload === undefined ? null : (
            <button type="button" className="rail-add" onClick={onDownload}>
              Download
            </button>
          )}
        </footer>
      );
    case "downloading":
      return (
        <footer className="rail-update">
          Downloading Phoebe {update.version}… {update.percent}%
        </footer>
      );
    case "ready":
      return (
        <footer className="rail-update">
          Phoebe {update.version} installs when you quit.{" "}
          {onRestart === undefined ? null : (
            <button type="button" className="rail-add" onClick={onRestart}>
              Restart now
            </button>
          )}
        </footer>
      );
    default:
      return null;
  }
}

/**
 * One local install. A button rather than a div, because it is the one rail
 * entry that goes somewhere — and a thing you click should be a thing a keyboard
 * can reach.
 */
function InstallEntry({
  install,
  current,
  busy,
  updates = 0,
  host,
  children,
  expanded,
  onToggle,
  onSelect,
  onSettings,
  onChild,
  onChildSettings,
  selectedChild,
  onAction,
}: {
  install: LocalInstall;
  current: boolean;
  /** A verb run is in flight on this install: the shortcuts give way to a spinner. */
  busy: boolean;
  /** How many updates the last check found on offer. */
  updates?: number;
  /** Where it runs: this machine's host, or a WSL distro. Null while the host is unknown. */
  host: HostPlatform | null;
  /** A workspace's children, read against its report; empty for a solo install. */
  children: RailChild[];
  expanded: boolean;
  onToggle: () => void;
  onSelect?: (dir: string) => void;
  /** The gear: the install's tabbed page. */
  onSettings?: (dir: string) => void;
  /** A child row: the console on that child's lines. */
  onChild?: (dir: string, child: RailChild) => void;
  /** A child's gear: that tenant's own config. */
  onChildSettings?: (dir: string, child: RailChild) => void;
  /** The child whose config is open, by folder. */
  selectedChild: string | null;
  /** The shortcuts: start on a stopped install; pause, stop and restart on a running one. */
  onAction?: (dir: string, action: InstallAction) => void;
}) {
  const reading = installReading(install);
  const actions = onAction === undefined ? [] : installActions(install);
  const workspace = install.workspace !== undefined;
  // The fleet under it, summed, so a closed workspace still says what is wrong.
  // A stopped one has nothing to sum unless the host found something: a `.env`
  // the container cannot read is as true stopped as running.
  const summed = workspaceSummary(children);
  const summary =
    install.state === "running" || (summed !== null && summed.errors + summed.warnings > 0)
      ? summed
      : null;
  // Where it runs, as T3 Code's project list marks each project with its host.
  const platformTitle = hostTitle(host, install.wsl?.distro);
  return (
    <div className={`rail-entry local state-${reading.tone}${current ? " current" : ""}`}>
      {workspace ? (
        <button
          type="button"
          className="rail-chevron"
          aria-expanded={expanded}
          aria-label={expanded ? `Collapse ${install.name}` : `Expand ${install.name}`}
          title={expanded ? "Hide the children" : `${children.length} in this workspace`}
          onClick={onToggle}
        >
          {expanded ? (
            <ChevronDown size={13} aria-hidden="true" />
          ) : (
            <ChevronRight size={13} aria-hidden="true" />
          )}
        </button>
      ) : null}
      <button
        type="button"
        className="rail-select"
        // A long name is cut to the line (console.css); the whole of it on hover.
        title={install.name}
        aria-current={current ? "page" : undefined}
        onClick={() => onSelect?.(install.dir)}
      >
        <div className="name">
          <span className={`mark ${reading.tone}`} aria-hidden="true" />
          <span className="platform" title={platformTitle} aria-label={platformTitle}>
            <HostIcon host={host} />
          </span>
          {install.name}
        </div>
        <div className="sub">
          {reading.text}
          {updates === 0 ? null : (
            <span
              className="rail-updates"
              title={`${updates} ${updates === 1 ? "update" : "updates"} available`}
              aria-label={`${updates} ${updates === 1 ? "update" : "updates"} available`}
            >
              <ArrowUpCircle size={11} aria-hidden="true" />
              {updates}
            </span>
          )}
        </div>
      </button>
      {busy ? (
        // Something is running on this install and its end is what changes the
        // shortcuts, so until then there is one thing to show: that it is going.
        // Turning, unless the OS asked for less motion, in which case it fades.
        <span className="rail-actions">
          <Spinner
            className="rail-spinner motion-safe:animate-spin motion-reduce:animate-pulse"
            size={14}
            strokeWidth={2.25}
            aria-label={`Working on ${install.name}`}
          />
        </span>
      ) : (
        // The shortcuts: one click from the rail, without opening the page
        // first. The page opens anyway, so the run's output has somewhere to
        // land (local-install.ts, `installActions`). Coss UI's button, ghost
        // and icon-sized, as T3 Code draws its own. The gear is the install's
        // settings: the tabbed page, where init, start, upgrade, secrets, the
        // report's tabs and forget live. The name itself opens the console.
        <span className="rail-actions">
          {actions.map((action) => {
            const [Icon, label] = ACTION_ICONS[action];
            return (
              <Button
                key={action}
                variant="ghost"
                size="icon-xs"
                className="rail-action"
                title={`${label} ${install.name}`}
                aria-label={`${label} ${install.name}`}
                onClick={() => onAction?.(install.dir, action)}
              >
                <Icon strokeWidth={2.25} aria-hidden="true" />
              </Button>
            );
          })}
          {onSettings === undefined ? null : (
            <Button
              variant="ghost"
              size="icon-xs"
              className="rail-gear"
              title={`Settings for ${install.name}`}
              aria-label={`Settings for ${install.name}`}
              onClick={() => onSettings(install.dir)}
            >
              <Settings aria-hidden="true" />
            </Button>
          )}
        </span>
      )}
      {summary === null ? null : (
        // A line of its own under the entry, the width of the rail: beside the
        // name it has the shortcuts for neighbours and is cut to nothing.
        <div className="rail-summary">
          {summary.text}
          <ProblemBadges
            errors={summary.errors}
            warnings={summary.warnings}
            title={`Across the tenants of ${install.name}`}
          />
        </div>
      )}
      {workspace && expanded ? (
        <ul className="rail-children" aria-label={`Children of ${install.name}`}>
          {children.length === 0 ? (
            <li className="rail-child muted">no children with a config yet</li>
          ) : (
            children.map((child) => (
              <li
                key={child.dir}
                className={`rail-child-row${child.dir === selectedChild ? " current" : ""}`}
              >
                <button
                  type="button"
                  className={`rail-child${child.enabled === false ? " disabled" : ""}`}
                  // The folder, and under it everything the badges are counting.
                  title={[child.dir, ...child.problems.map(problemLine)].join("\n")}
                  onClick={() => onChild?.(install.dir, child)}
                >
                  <span
                    className={`mark ${child.tone}${child.active ? " active" : ""}`}
                    aria-hidden="true"
                  />
                  <span className="label">{child.label}</span>
                  <ProblemBadges {...problemCounts(child.problems)} />
                  {child.text === "" ? null : <span className="word">{child.text}</span>}
                </button>
                {onChildSettings === undefined ? null : (
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="rail-gear"
                    title={`Config of ${child.label}`}
                    aria-label={`Config of ${child.label}`}
                    onClick={() => onChildSettings(install.dir, child)}
                  >
                    <Settings aria-hidden="true" />
                  </Button>
                )}
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}

/** One problem as a line of hover text. */
function problemLine(problem: RailProblem): string {
  return `${problem.level === "error" ? "Error" : "Warning"} — ${problem.text}`;
}

/**
 * How many errors and warnings, as two small counts with an icon each. Nothing
 * at all when there are none: a rail of zeroes is a rail nobody reads, and the
 * rows that do carry one stand out because the rest carry nothing.
 */
function ProblemBadges({
  errors,
  warnings,
  title,
}: {
  errors: number;
  warnings: number;
  title?: string;
}) {
  if (errors === 0 && warnings === 0) return null;
  return (
    <span className="rail-problems" {...(title === undefined ? {} : { title })}>
      {errors === 0 ? null : (
        <span
          className="rail-problem error"
          aria-label={`${errors} ${errors === 1 ? "error" : "errors"}`}
        >
          <CircleAlert size={11} aria-hidden="true" />
          {errors}
        </span>
      )}
      {warnings === 0 ? null : (
        <span
          className="rail-problem warning"
          aria-label={`${warnings} ${warnings === 1 ? "warning" : "warnings"}`}
        >
          <TriangleAlert size={11} aria-hidden="true" />
          {warnings}
        </span>
      )}
    </span>
  );
}

/** Each shortcut's icon and the verb it is read as. Lucide, as T3 Code draws. */
const ACTION_ICONS: Record<InstallAction, [typeof Play, string]> = {
  start: [Play, "Start"],
  pause: [Pause, "Pause"],
  stop: [Square, "Stop"],
  restart: [RotateCcw, "Restart"],
};
