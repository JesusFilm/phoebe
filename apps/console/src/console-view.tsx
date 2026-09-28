// The console: a local install's container output, as the page the rail opens.
//
// Picking an install on the rail lands here, the way picking a project in T3
// Code lands on its terminal. The header says which install and where it runs,
// with the gear onto its settings, the tabbed page
// (install-page.tsx). Below, one tab per pipeline that has spoken
// (logs-channels.ts) and the lines, drawn on the chosen theme (console-themes.ts,
// log-line.tsx). Open, it follows over the bridge and stops the stream when the
// install changes underneath it. What it shows is logs.ts's view; this file is
// the subscription and the drawing.

import { ArrowDownToLine, Settings } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties, type UIEvent } from "react";
import type { DesktopBridge, HostPlatform, LocalInstall } from "phoebe-agent/contracts";
import { Button } from "~/components/ui/button";
import {
  consoleThemeProperties,
  resolveConsoleTheme,
  SYSTEM_CONSOLE_THEME,
  type ConsoleThemeChoice,
} from "./console-themes.ts";
import { HostIcon, hostTitle } from "./host-icon.tsx";
import { installReading } from "./local-install.ts";
import { LogLine } from "./log-line.tsx";
import { appendLogLine, EMPTY_LOGS, logsEnded, logsSeeded, type LogsView } from "./logs.ts";
import { ALL_CHANNEL, channelLabel, channelsIn, linesIn, tenantChannel } from "./logs-channels.ts";

export function ConsoleView({
  bridge,
  install,
  host,
  tenant = null,
  theme = SYSTEM_CONSOLE_THEME,
  onSettings,
}: {
  bridge: DesktopBridge;
  install: LocalInstall;
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
        </span>
        <span className="console-controls">
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
        {channels.map((name) => (
          <button
            key={name}
            type="button"
            className={`console-channel${name === shown ? " current" : ""}`}
            aria-pressed={name === shown}
            title={
              name === ALL_CHANNEL
                ? "Every line the container printed"
                : name === scope
                  ? `Every line from ${tenant}`
                  : name
            }
            onClick={() => setChannel(name)}
          >
            {channelLabel(name)}
          </button>
        ))}
      </nav>
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
