// The console: a deployment's container output, as the page the rail opens.
//
// Picking an install on the rail lands here, the way picking a project in T3
// Code lands on its terminal. The header says which deployment and where it
// runs, which pipelines have a unit in flight and on what, and how many things
// are wrong (console-status.ts), with the gear onto its settings, the tabbed
// page (install-page.tsx, remote-page.tsx). Below, one tab per pipeline that
// has spoken (logs-channels.ts) and the lines, drawn on the chosen theme
// (console-themes.ts, log-line.tsx). Beside a local install's tabs is `cli`:
// what the last verb the companion ran on it printed (verb-run.ts). A start,
// an upgrade and a doctor are output too, and the console is where output is
// read. Open, it follows over the bridge and stops the stream when the
// deployment changes underneath it. What it shows is logs.ts's view; this file
// is the subscription and the drawing. The eraser in the header clears the tab
// that is open the way a terminal clears: by marking what has been read, not by
// throwing lines away (#677).
//
// **One pane, two arms** (map #690). A local install's lines come off Docker
// through `logs`; a remote's come off the deployment itself through
// `remotes.logs`, redacted before they left it. The pane does not know which:
// it is handed a stream to follow and a header to draw, and the two wrappers
// at the foot of this file build those from an install or a paired record.
// Only the `cli` tab is one arm's — a verb runs on this machine, against a
// folder here — so a remote console has no such tab.

import { ArrowDownToLine, CircleAlert, Eraser, Settings, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type UIEvent } from "react";
import { CANCELLABLE_VERBS } from "phoebe-agent/contracts";
import type {
  DesktopBridge,
  HostPlatform,
  LocalInstall,
  LocalReportEvent,
  RemoteRecord,
  VerbRun,
} from "phoebe-agent/contracts";
import { Button } from "~/components/ui/button";
import {
  consoleThemeProperties,
  resolveConsoleTheme,
  SYSTEM_CONSOLE_THEME,
  type ConsoleThemeChoice,
} from "./console-themes.ts";
import {
  channelStatus,
  channelTitle,
  consoleStatus,
  remoteConsoleStatus,
  type ChannelStatus,
  type ConsoleStatus,
} from "./console-status.ts";
import { HostIcon, hostTitle } from "./host-icon.tsx";
import {
  installReading,
  outcomeReading,
  problemCounts,
  type RailProblem,
} from "./local-install.ts";
import { LogLine } from "./log-line.tsx";
import {
  appendLogLine,
  drawnLines,
  EMPTY_LOGS,
  logsCleared,
  logsEnded,
  logsSeeded,
  runDrawn,
  type LogsView,
  type RunMark,
} from "./logs.ts";
import {
  ALL_CHANNEL,
  channelLabel,
  channelsIn,
  CLI_CHANNEL,
  tenantChannel,
} from "./logs-channels.ts";
import { remoteHost, remoteMarkClass, remoteRow } from "./remote-routes.ts";
import { useInstallRun } from "./verb-run.ts";

/**
 * Where a pane's lines come from. `key` is what the pane re-follows on: a
 * container that came back is a new stream, and the ended one below is not it.
 */
export type ConsoleStream = {
  key: string;
  /** Start following, or join; resolves with the lines held so far. */
  follow: () => Promise<string[]>;
  lines: (onLine: (line: string) => void) => () => void;
  ended: (onEnded: (reason: string) => void) => () => void;
  stop: () => Promise<void>;
};

/** What the header says about the deployment whose lines these are. */
export type ConsoleHeader = {
  name: string;
  /** The whole of it on hover: the folder, or the address. */
  title: string;
  /** Where it runs, for the header's mark; null while unknown. */
  host: HostPlatform | null;
  /** The mark's tone and the words beside the name. */
  reading: { tone: string; text: string };
  /** The mark's whole class, when it is not the tone alone: a remote's ring and core. */
  mark?: string;
};

/** A local install's console: its lines off Docker, and its verb runs on the `cli` tab. */
export function ConsoleView({
  bridge,
  install,
  host,
  report = null,
  problems = [],
  tenant = null,
  channel = null,
  theme = SYSTEM_CONSOLE_THEME,
  onSettings,
}: {
  bridge: DesktopBridge;
  install: LocalInstall;
  /** The last read main emitted for the install: what is working, and what is wrong. */
  report?: LocalReportEvent | null;
  /** Where the install runs, for the header's mark; null while unknown. */
  host: HostPlatform | null;
  /** What is wrong with the install itself: a container running as root (harness.ts). */
  problems?: readonly RailProblem[];
  /** A workspace child's slug, when the rail opened this from one: its lines first. */
  tenant?: string | null;
  /** The tab to open on, when something asked for one: `cli`, to watch a run. */
  channel?: string | null;
  /** The operator's theme choice (console-themes.ts, chosen on the settings page); "system" until read. */
  theme?: ConsoleThemeChoice;
  /** The gear: the install's tabbed page. */
  onSettings: () => void;
}) {
  // The verb the companion is running on this install, or last ran.
  const { run } = useInstallRun(bridge, install.dir);
  const status = consoleStatus(install, report, problems);
  // Followed again when the install's state moves: a container that came back
  // is a new stream, and the ended one below is not it.
  const stream = useMemo<ConsoleStream>(
    () => ({
      key: `${install.dir}#${install.state}`,
      follow: () => bridge.logs.follow(install.dir),
      lines: (onLine) =>
        bridge.logs.lines((line) => {
          if (line.install === install.dir) onLine(line.line);
        }),
      ended: (onEnded) =>
        bridge.logs.ended((end) => {
          if (end.install === install.dir) onEnded(end.reason);
        }),
      stop: () => bridge.logs.stop(install.dir),
    }),
    [bridge, install.dir, install.state],
  );
  return (
    <ConsolePane
      header={{ name: install.name, title: install.dir, host, reading: installReading(install) }}
      status={status}
      problems={problems}
      stream={stream}
      tenant={tenant}
      channel={channel}
      theme={theme}
      onSettings={onSettings}
      cli={{
        run,
        cancel: (runId) => void bridge.runs.cancel(runId).catch(() => undefined),
      }}
    />
  );
}

/**
 * A remote route's console (map #690): the deployment's own output over the
 * API, with its secrets redacted before it left. Followed again when the
 * record comes back to connected, as a local one is when its container does.
 */
export function RemoteConsoleView({
  bridge,
  record,
  now,
  tenant = null,
  theme = SYSTEM_CONSOLE_THEME,
  onSettings,
}: {
  bridge: DesktopBridge;
  record: RemoteRecord;
  now: Date;
  /** A workspace child's slug, when the rail opened this from one: its lines first. */
  tenant?: string | null;
  theme?: ConsoleThemeChoice;
  /** The gear: the remote's tabbed page. */
  onSettings: () => void;
}) {
  const row = remoteRow(record, now);
  const status = remoteConsoleStatus(row.reading);
  const host = remoteHost(row.reading);
  const connected = record.reachability === "connected";
  const stream = useMemo<ConsoleStream>(
    () => ({
      key: `${record.deploymentId}#${connected ? "connected" : "away"}`,
      follow: () => bridge.remotes.logs.follow(record.deploymentId),
      lines: (onLine) =>
        bridge.remotes.logs.lines((line) => {
          if (line.deploymentId === record.deploymentId) onLine(line.line);
        }),
      ended: (onEnded) =>
        bridge.remotes.logs.ended((end) => {
          if (end.deploymentId === record.deploymentId) onEnded(end.reason);
        }),
      stop: () => bridge.remotes.logs.stop(record.deploymentId),
    }),
    [bridge, record.deploymentId, connected],
  );
  return (
    <ConsolePane
      header={{
        name: record.name,
        title: record.url,
        host,
        reading: { tone: row.tone, text: row.text },
        mark: remoteMarkClass(row),
      }}
      status={status}
      stream={stream}
      tenant={tenant}
      theme={theme}
      onSettings={onSettings}
    />
  );
}

/** The pane itself, over whichever stream it was handed. Exported for the tests. */
export function ConsolePane({
  header,
  status,
  problems: ofInstall = [],
  stream,
  tenant = null,
  channel: wanted = null,
  theme = SYSTEM_CONSOLE_THEME,
  onSettings,
  cli,
}: {
  header: ConsoleHeader;
  /** What the report says is happening now, beside what the lines say happened. */
  status: ConsoleStatus;
  /** What is wrong with the deployment itself rather than with a tenant of it. */
  problems?: readonly RailProblem[];
  stream: ConsoleStream;
  /** A workspace child's slug, when the rail opened this from one: its lines first. */
  tenant?: string | null;
  /** The tab to open on, when something asked for one: `cli`, to watch a run. */
  channel?: string | null;
  theme?: ConsoleThemeChoice;
  onSettings: () => void;
  /** The verb runs, where the arm has them: the `cli` tab and its cancel. */
  cli?: { run: VerbRun | null; cancel: (runId: string) => void };
}) {
  const [view, setView] = useState<LogsView>(EMPTY_LOGS);
  // The tab: every pipeline that has spoken is one (logs-channels.ts), and the
  // stream stays one stream underneath — a tab only chooses which lines show.
  // Opened from a workspace child, the child's own tab is there from the start
  // and is the one open, before its first line.
  const scope = tenant === null ? null : tenantChannel(tenant);
  const [channel, setChannel] = useState(wanted ?? scope ?? ALL_CHANNEL);
  const run = cli?.run ?? null;
  const channels = channelsIn(view.channels, scope, run !== null || wanted === CLI_CHANNEL);
  const shown = channels.includes(channel) ? channel : ALL_CHANNEL;
  const isCli = shown === CLI_CHANNEL;
  const lines = isCli ? [] : drawnLines(view, shown);
  const cliRunning = run !== null && run.exit === undefined;

  // Main holds one run per install and the next replaces it. A restart is two,
  // and its stop is worth reading after its start has begun, so the runs this
  // console has watched stay on the tab above the current one, as a terminal
  // keeps what scrolled past. Only for as long as the console is open, and the
  // eraser below is how the operator says they are done with them.
  const [past, setPast] = useState<VerbRun[]>([]);
  // What a clear on that tab read: the run it was on, and how far down it.
  const [runMark, setRunMark] = useState<RunMark | null>(null);
  const current = run === null ? null : runDrawn(run, runMark);
  const latest = useRef<VerbRun | null>(null);
  useEffect(() => {
    const before = latest.current;
    if (before !== null && run !== null && before.runId !== run.runId) {
      // As it was drawn, so a run cleared while it ran stays cleared once it
      // has scrolled up into the runs above the current one.
      setPast((held) => [...held, runDrawn(before, runMark)].slice(-PAST_RUNS));
    }
    latest.current = run;
  }, [run, runMark]);

  // A verb that starts while the console is open is what the operator just
  // pressed, so its tab comes forward. The run that was already there when the
  // console opened is left where it is: opening a console is not asking for it.
  const firstRun = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const id = run?.runId ?? null;
    if (firstRun.current === undefined) {
      // Null until main answers; the first answer is the run that was there.
      firstRun.current = id;
      return;
    }
    if (id !== null && id !== firstRun.current) {
      firstRun.current = id;
      if (run?.exit === undefined) setChannel(CLI_CHANNEL);
    }
  }, [run?.runId, run?.exit]);
  // The header speaks for what the console is showing: one tenant's, when the
  // rail opened it from a child, and the whole deployment's otherwise.
  const scoped = channelStatus(status, scope ?? ALL_CHANNEL);
  // The deployment's own trouble is every tenant's, so a tenant's header has it too.
  const headed =
    scope === null ? scoped : { ...scoped, problems: [...ofInstall, ...scoped.problems] };
  const working =
    scope === null
      ? status.working
      : status.working.filter((pipeline) => pipeline.channel.startsWith(scope.slice(0, -1)));
  const [listing, setListing] = useState(false);

  // "System" is Phoebe's own light or dark by the OS, and follows it as it moves.
  const systemDark = useSystemDark();
  const palette = resolveConsoleTheme(theme, systemDark);
  const themed = consoleThemeProperties(palette) as CSSProperties;

  // Followed afresh whenever the stream's key moves (see ConsoleStream).
  useEffect(() => {
    let live = true;
    setView(EMPTY_LOGS);
    stream.follow().then(
      (held) => {
        if (live) setView(logsSeeded(held));
      },
      (error: unknown) => {
        if (live) {
          setView(logsEnded(EMPTY_LOGS, error instanceof Error ? error.message : String(error)));
        }
      },
    );
    const offLines = stream.lines((line) => setView((held) => appendLogLine(held, line)));
    const offEnded = stream.ended((reason) => setView((held) => logsEnded(held, reason)));
    return () => {
      live = false;
      offLines();
      offEnded();
      void stream.stop().catch(() => undefined);
    };
  }, [stream]);

  // Pinned to the bottom until the operator scrolls up to read something, and
  // pinned again when they scroll back down — or press the button.
  const box = useRef<HTMLPreElement>(null);
  const [pinned, setPinned] = useState(true);
  useEffect(() => {
    const element = box.current;
    if (pinned && element !== null) element.scrollTop = element.scrollHeight;
  }, [view, pinned, shown, run?.lines.length, past.length, runMark]);
  const onScroll = (event: UIEvent<HTMLPreElement>): void => {
    const element = event.currentTarget;
    setPinned(element.scrollTop + element.clientHeight >= element.scrollHeight - 4);
  };

  // There is something to clear while output is drawn: lines on a container's
  // tab, and on the cli tab the runs above the current one and the current
  // run's own lines. A run's `$ phoebe <verb>` heading is not output, the way
  // the ending under the lines is not, so neither is what the button is for.
  const drawn = isCli ? past.length + (current?.lines.length ?? 0) : lines.length;
  // Read, and done with: what the open tab shows stops being drawn and the pane
  // pins back to the bottom, so the next line arrives under an empty console.
  // The lines themselves stay where they are (logs.ts), and Docker holds the
  // output regardless — a fresh follow re-tails it.
  const clear = (): void => {
    if (isCli) {
      setPast([]);
      if (run !== null) setRunMark({ runId: run.runId, after: run.lines.at(-1) ?? null });
    } else {
      setView((held) => logsCleared(held, shown));
    }
    setPinned(true);
  };

  return (
    <main
      className={`main console-view scheme-${palette.scheme}`}
      aria-label={`Console for ${header.name}`}
      data-theme={palette.id}
      style={themed}
    >
      <header className="console-bar">
        <span className="console-name">
          <span
            className="platform"
            title={hostTitle(header.host)}
            aria-label={hostTitle(header.host)}
          >
            <HostIcon host={header.host} />
          </span>
          <span className={header.mark ?? `mark ${header.reading.tone}`} aria-hidden="true" />
          <h1 title={header.title}>{header.name}</h1>
          <span className="console-state">{header.reading.text}</span>
          {working.length === 0 ? null : (
            <span className="console-activity" aria-label="Working now">
              {working.map((pipeline) => (
                <button
                  key={pipeline.channel}
                  type="button"
                  className="console-working"
                  title={channelTitle(pipeline.channel, channelStatus(status, pipeline.channel))}
                  onClick={() => setChannel(pipeline.channel)}
                >
                  <span className="console-pulse" aria-hidden="true" />
                  {pipeline.label}
                  {pipeline.units.length === 0 ? null : (
                    <span className="console-unit">{pipeline.units.join(", ")}</span>
                  )}
                </button>
              ))}
            </span>
          )}
        </span>
        <span className="console-controls">
          {headed.problems.length === 0 ? null : (
            <button
              type="button"
              className="console-problems-toggle"
              aria-expanded={listing}
              title={headed.problems.map(problemLine).join("\n")}
              onClick={() => setListing((open) => !open)}
            >
              <ProblemCounts problems={headed.problems} />
            </button>
          )}
          <Button
            variant="ghost"
            size="icon-xs"
            className="console-clear"
            title="Clear the console"
            aria-label="Clear the console"
            disabled={drawn === 0}
            onClick={clear}
          >
            <Eraser aria-hidden="true" />
          </Button>
          {pinned ? null : (
            <Button
              variant="ghost"
              size="icon-xs"
              title="Follow the newest lines"
              aria-label="Follow the newest lines"
              onClick={() => setPinned(true)}
            >
              <ArrowDownToLine aria-hidden="true" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon-xs"
            className="console-settings"
            title={`Settings for ${header.name}`}
            aria-label={`Settings for ${header.name}`}
            onClick={onSettings}
          >
            <Settings aria-hidden="true" />
          </Button>
        </span>
      </header>
      <nav className="console-tabs" aria-label="Pipelines">
        {channels.map((name) => {
          // "all" is the header's own subject, so its tab carries nothing extra.
          // The CLI's is lit while a verb runs, and marked when one failed.
          const tab =
            name === ALL_CHANNEL
              ? NOTHING
              : name === CLI_CHANNEL
                ? cliStatus(run)
                : channelStatus(status, name);
          const what =
            name === ALL_CHANNEL
              ? "Every line the container printed"
              : name === CLI_CHANNEL
                ? "What phoebe printed when the companion last ran a verb on this install"
                : name === scope
                  ? `Every line from ${tenant}`
                  : name;
          return (
            <button
              key={name}
              type="button"
              className={`console-channel${name === shown ? " current" : ""}${tab.active ? " active" : ""}`}
              aria-pressed={name === shown}
              title={channelTitle(what, tab)}
              onClick={() => setChannel(name)}
            >
              {tab.active ? <span className="console-pulse" aria-hidden="true" /> : null}
              {channelLabel(name)}
              <ProblemCounts problems={tab.problems} />
            </button>
          );
        })}
      </nav>
      {listing && headed.problems.length > 0 ? (
        <ul className="console-problem-list" aria-label="What is wrong">
          {headed.problems.map((problem, index) => (
            <li key={index} className={problem.level}>
              {problem.level === "error" ? (
                <CircleAlert size={12} aria-hidden="true" />
              ) : (
                <TriangleAlert size={12} aria-hidden="true" />
              )}
              {problem.text}
            </li>
          ))}
        </ul>
      ) : null}
      <pre className="logs-lines" ref={box} onScroll={onScroll}>
        {isCli ? (
          current === null ? (
            <span className="console-quiet">Nothing has run on this install yet.</span>
          ) : (
            [...past, current].map((one) => (
              <span key={one.runId} className="cli-run">
                <span className="console-quiet">
                  $ phoebe {one.verb}
                  {"\n"}
                </span>
                {one.lines.map((line, index) => (
                  <span key={index} className={line.stream === "stderr" ? "cli-stderr" : undefined}>
                    <LogLine line={line.line} palette={palette.ansi} />
                  </span>
                ))}
              </span>
            ))
          )
        ) : view.lines.length === 0 ? (
          // An empty pane says why it is empty where the eye is: a stream that
          // was refused or ended before a line came has only this to show.
          <span className={view.ended === null ? "console-quiet" : "console-quiet console-refused"}>
            {view.ended ?? "Waiting for the container to print something…"}
          </span>
        ) : (
          lines.map((line, index) => <LogLine key={index} line={line} palette={palette.ansi} />)
        )}
      </pre>
      {isCli ? (
        run === null ? null : (
          <p
            className={`console-ended console-cli${run.exit !== undefined && run.exit.code !== 0 ? " failed" : ""}`}
            role="status"
          >
            <code>phoebe {run.verb}</code>
            {" · "}
            {run.exit === undefined
              ? "running…"
              : run.exit.code === 0
                ? "finished"
                : `exited ${run.exit.code}`}
            {run.exit?.outcome === undefined ? null : ` · ${outcomeReading(run.exit.outcome)}`}
            {cliRunning && cli !== undefined && CANCELLABLE_VERBS.includes(run.verb) ? (
              <button
                type="button"
                className="console-cancel"
                onClick={() => cli.cancel(run.runId)}
              >
                Cancel
              </button>
            ) : null}
          </p>
        )
      ) : view.ended === null || view.lines.length === 0 ? null : (
        <p className="console-ended">{view.ended}</p>
      )}
    </main>
  );
}

const NOTHING = { active: false, units: [], problems: [] };

/** How many earlier runs the cli tab keeps above the current one. */
const PAST_RUNS = 50;

/** The CLI tab's standing: lit while a verb runs, and an error when the last one failed. */
function cliStatus(run: VerbRun | null): ChannelStatus {
  if (run === null) return NOTHING;
  if (run.exit === undefined) return { active: true, units: [run.verb], problems: [] };
  return run.exit.code === 0
    ? NOTHING
    : {
        active: false,
        units: [],
        problems: [{ level: "error", text: `phoebe ${run.verb} exited ${run.exit.code}` }],
      };
}

/** One problem as a line of hover text. */
function problemLine(problem: RailProblem): string {
  return `${problem.level === "error" ? "Error" : "Warning"} — ${problem.text}`;
}

/**
 * How many errors and warnings, as two small counts with an icon each, in the
 * theme's red and yellow. Nothing at all when there are none, so the tabs and
 * the header that do carry one stand out.
 */
function ProblemCounts({ problems }: { problems: readonly RailProblem[] }) {
  const { errors, warnings } = problemCounts(problems);
  if (errors === 0 && warnings === 0) return null;
  return (
    <span className="console-problems">
      {errors === 0 ? null : (
        <span
          className="console-problem error"
          aria-label={`${errors} ${errors === 1 ? "error" : "errors"}`}
        >
          <CircleAlert size={12} aria-hidden="true" />
          {errors}
        </span>
      )}
      {warnings === 0 ? null : (
        <span
          className="console-problem warning"
          aria-label={`${warnings} ${warnings === 1 ? "warning" : "warnings"}`}
        >
          <TriangleAlert size={12} aria-hidden="true" />
          {warnings}
        </span>
      )}
    </span>
  );
}

/** Whether the OS is dark right now, kept current as it changes. */
export function useSystemDark(): boolean {
  const query =
    typeof window === "undefined" ? null : window.matchMedia("(prefers-color-scheme: dark)");
  const [dark, setDark] = useState(query?.matches ?? false);
  useEffect(() => {
    if (query === null) return;
    const onChange = (): void => setDark(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, [query]);
  return dark;
}
