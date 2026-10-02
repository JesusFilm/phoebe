// The console: a local install's container output, as the page the rail opens.
//
// Picking an install on the rail lands here, the way picking a project in T3
// Code lands on its terminal. The header says which install and where it runs,
// which pipelines have a unit in flight and on what, and how many things are
// wrong (console-status.ts), with the gear onto its settings, the tabbed page
// (install-page.tsx). Below, one tab per pipeline that has spoken
// (logs-channels.ts) and the lines, drawn on the chosen theme (console-themes.ts,
// log-line.tsx). Open, it follows over the bridge and stops the stream when the
// install changes underneath it. What it shows is logs.ts's view; this file is
// the subscription and the drawing.

import { ArrowDownToLine, CircleAlert, Settings, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties, type UIEvent } from "react";
import type {
  DesktopBridge,
  HostPlatform,
  LocalInstall,
  LocalReportEvent,
} from "phoebe-agent/contracts";
import { Button } from "~/components/ui/button";
import {
  consoleThemeProperties,
  resolveConsoleTheme,
  SYSTEM_CONSOLE_THEME,
  type ConsoleThemeChoice,
} from "./console-themes.ts";
import { channelStatus, channelTitle, consoleStatus } from "./console-status.ts";
import { HostIcon, hostTitle } from "./host-icon.tsx";
import { installReading, problemCounts, type RailProblem } from "./local-install.ts";
import { LogLine } from "./log-line.tsx";
import { appendLogLine, EMPTY_LOGS, logsEnded, logsSeeded, type LogsView } from "./logs.ts";
import { ALL_CHANNEL, channelLabel, channelsIn, linesIn, tenantChannel } from "./logs-channels.ts";

export function ConsoleView({
  bridge,
  install,
  host,
  report = null,
  tenant = null,
  theme = SYSTEM_CONSOLE_THEME,
  onSettings,
}: {
  bridge: DesktopBridge;
  install: LocalInstall;
  /** The last read main emitted for the install: what is working, and what is wrong. */
  report?: LocalReportEvent | null;
  /** Where the install runs, for the header's mark; null while unknown. */
  host: HostPlatform | null;
  /** A workspace child's slug, when the rail opened this from one: its lines first. */
  tenant?: string | null;
  /** The operator's theme choice (console-themes.ts, chosen on the settings page); "system" until read. */
  theme?: ConsoleThemeChoice;
  /** The gear: the install's tabbed page. */
  onSettings: () => void;
}) {
  const [view, setView] = useState<LogsView>(EMPTY_LOGS);
  // The tab: every pipeline that has spoken is one (logs-channels.ts), and the
  // stream stays one stream underneath — a tab only chooses which lines show.
  // Opened from a workspace child, the child's own tab is there from the start
  // and is the one open, before its first line.
  const scope = tenant === null ? null : tenantChannel(tenant);
  const [channel, setChannel] = useState(scope ?? ALL_CHANNEL);
  const channels = channelsIn(view.lines, scope);
  const shown = channels.includes(channel) ? channel : ALL_CHANNEL;
  const lines = linesIn(view.lines, shown);
  const reading = installReading(install);
  // What the report says is happening now, beside what the lines say happened.
  const status = consoleStatus(install, report);
  // The header speaks for what the console is showing: one tenant's, when the
  // rail opened it from a child, and the whole install's otherwise.
  const header = channelStatus(status, scope ?? ALL_CHANNEL);
  const working =
    scope === null
      ? status.working
      : status.working.filter((pipeline) => pipeline.channel.startsWith(scope.slice(0, -1)));
  const [listing, setListing] = useState(false);

  // "System" is Phoebe's own light or dark by the OS, and follows it as it moves.
  const systemDark = useSystemDark();
  const palette = resolveConsoleTheme(theme, systemDark);
  const themed = consoleThemeProperties(palette) as CSSProperties;

  // Followed again when the install's state moves: a container that came back
  // is a new stream, and the ended one below is not it.
  useEffect(() => {
    let live = true;
    setView(EMPTY_LOGS);
    bridge.logs.follow(install.dir).then(
      (held) => {
        if (live) setView(logsSeeded(held));
      },
      (error: unknown) => {
        if (live) {
          setView(logsEnded(EMPTY_LOGS, error instanceof Error ? error.message : String(error)));
        }
      },
    );
    const offLines = bridge.logs.lines((line) => {
      if (line.install === install.dir) setView((current) => appendLogLine(current, line.line));
    });
    const offEnded = bridge.logs.ended((end) => {
      if (end.install === install.dir) setView((current) => logsEnded(current, end.reason));
    });
    return () => {
      live = false;
      offLines();
      offEnded();
      void bridge.logs.stop(install.dir).catch(() => undefined);
    };
  }, [bridge, install.dir, install.state]);

  // Pinned to the bottom until the operator scrolls up to read something, and
  // pinned again when they scroll back down — or press the button.
  const box = useRef<HTMLPreElement>(null);
  const [pinned, setPinned] = useState(true);
  useEffect(() => {
    const element = box.current;
    if (pinned && element !== null) element.scrollTop = element.scrollHeight;
  }, [view, pinned]);
  const onScroll = (event: UIEvent<HTMLPreElement>): void => {
    const element = event.currentTarget;
    setPinned(element.scrollTop + element.clientHeight >= element.scrollHeight - 4);
  };

  return (
    <main
      className={`main console-view scheme-${palette.scheme}`}
      aria-label={`Console for ${install.name}`}
      data-theme={palette.id}
      style={themed}
    >
      <header className="console-bar">
        <span className="console-name">
          <span className="platform" title={hostTitle(host)} aria-label={hostTitle(host)}>
            <HostIcon host={host} fallback="local" />
          </span>
          <span className={`mark ${reading.tone}`} aria-hidden="true" />
          <h1 title={install.dir}>{install.name}</h1>
          <span className="console-state">{reading.text}</span>
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
          {header.problems.length === 0 ? null : (
            <button
              type="button"
              className="console-problems-toggle"
              aria-expanded={listing}
              title={header.problems.map(problemLine).join("\n")}
              onClick={() => setListing((open) => !open)}
            >
              <ProblemCounts problems={header.problems} />
            </button>
          )}
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
            title={`Settings for ${install.name}`}
            aria-label={`Settings for ${install.name}`}
            onClick={onSettings}
          >
            <Settings aria-hidden="true" />
          </Button>
        </span>
      </header>
      <nav className="console-tabs" aria-label="Pipelines">
        {channels.map((name) => {
          // "all" is the header's own subject, so its tab carries nothing extra.
          const tab = name === ALL_CHANNEL ? NOTHING : channelStatus(status, name);
          const what =
            name === ALL_CHANNEL
              ? "Every line the container printed"
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
      {listing && header.problems.length > 0 ? (
        <ul className="console-problem-list" aria-label="What is wrong">
          {header.problems.map((problem, index) => (
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
        {view.lines.length === 0 && view.ended === null ? (
          <span className="console-quiet">Waiting for the container to print something…</span>
        ) : (
          lines.map((line, index) => <LogLine key={index} line={line} palette={palette.ansi} />)
        )}
      </pre>
      {view.ended === null ? null : <p className="console-ended">{view.ended}</p>}
    </main>
  );
}

const NOTHING = { active: false, units: [], problems: [] };

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
