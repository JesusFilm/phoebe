// The settings page: the console's own preferences, behind the gear at the foot
// of the rail (`#/settings`), the way T3 Code keeps its settings behind the gear
// at the foot of its sidebar.
//
// Everything here is the operator's and about this window: the console's
// colours, whether the desktop is told about alerts, and what this companion is
// running on. Nothing about a deployment lives here; a deployment's settings are
// its own tabbed page (install-page.tsx), behind the gear on its rail entry.
// A browser the relay served has no companion behind it, so it gets the page
// with the one thing that is still true of it.

import type { CSSProperties } from "react";
import type { CompanionEnvironment } from "phoebe-agent/contracts";
import { ConsoleThemePicker } from "./console-theme-picker.tsx";
import {
  consoleThemeProperties,
  resolveConsoleTheme,
  type ConsoleThemeChoice,
} from "./console-themes.ts";
import { dockerReading } from "./local-install.ts";
import { LogLine } from "./log-line.tsx";
import type { Surface } from "./companion.ts";

/** A few lines of the kind the console shows, so a theme can be judged before it is chosen. */
export const SAMPLE_LINES: readonly string[] = [
  "[phoebe] boot: engine v0.13.0, 2 pipelines for JesusFilm/phoebe",
  "[phoebe:JesusFilm/phoebe:work] cycle: nothing ready-for-agent, sleeping 30s",
  "[phoebe:JesusFilm/phoebe:research][issue 497] started",
  "[JesusFilm/phoebe:claude] Reading the ticket and the map…",
  "[JesusFilm/phoebe:claude:stderr] warning: slow response from the API, retrying",
];

export function SettingsPage({
  surface,
  environment,
  systemDark,
  notifications,
  onNotifications,
  consoleTheme,
  onConsoleTheme,
}: {
  surface: Surface;
  /** What main found on this machine, or null before it answered. */
  environment: CompanionEnvironment | null;
  /** Whether the OS is dark now, for what "System" comes out as in the preview. */
  systemDark: boolean;
  notifications: boolean;
  onNotifications?: (wanted: boolean) => void;
  consoleTheme: ConsoleThemeChoice;
  onConsoleTheme?: (choice: ConsoleThemeChoice) => void;
}) {
  if (surface === "browser") {
    return (
      <main className="main settings-page">
        <h1>Settings</h1>
        <p className="muted">
          This console is the relay&apos;s, served to a browser. It keeps nothing on this machine
          beyond your sign-in, which is on the top bar. The companion app has the settings a machine
          of its own needs: the console&apos;s colours and desktop notifications.
        </p>
      </main>
    );
  }

  const theme = resolveConsoleTheme(consoleTheme, systemDark);
  const docker = dockerReading(environment);

  return (
    <main className="main settings-page">
      <h1>Settings</h1>

      <section className="settings-section" aria-labelledby="settings-console">
        <h2 id="settings-console">Console</h2>
        <p className="muted">
          The colours the console draws an install&apos;s log lines in. System is Phoebe&apos;s own
          light or dark, whichever the OS is; the rest are terminal schemes at their published
          values.
        </p>
        <div className="settings-row">
          <span className="settings-label">Theme</span>
          {onConsoleTheme === undefined ? (
            <span>{theme.name}</span>
          ) : (
            <ConsoleThemePicker theme={consoleTheme} onChoose={onConsoleTheme} />
          )}
        </div>
        <pre
          className="settings-preview logs-lines"
          data-theme={theme.id}
          style={consoleThemeProperties(theme) as CSSProperties}
          aria-label={`A sample of the console in ${theme.name}`}
        >
          {SAMPLE_LINES.map((line, index) => (
            <LogLine key={index} line={line} palette={theme.ansi} />
          ))}
        </pre>
      </section>

      <section className="settings-section" aria-labelledby="settings-notifications">
        <h2 id="settings-notifications">Notifications</h2>
        <p className="muted">
          A desktop notification when a local install needs a hand: a pipeline wedged, a crash loop,
          a container that stopped. The OS asks its own permission the first time this is turned on,
          and never again.
        </p>
        <label className="settings-row settings-check">
          <input
            type="checkbox"
            checked={notifications}
            disabled={onNotifications === undefined}
            onChange={(event) => onNotifications?.(event.target.checked)}
          />
          Desktop notifications
        </label>
      </section>

      <section className="settings-section" aria-labelledby="settings-companion">
        <h2 id="settings-companion">This companion</h2>
        <p className="muted">
          {docker.kind === "probing"
            ? "Reading what this machine has…"
            : docker.kind === "missing"
              ? "Docker is not on PATH, so nothing local can run."
              : docker.kind === "daemon-down"
                ? "Docker is installed but its daemon is not running."
                : docker.text}
        </p>
        {environment === null ? null : (
          <dl className="settings-facts">
            <dt>Companion</dt>
            <dd>{environment.companionVersion}</dd>
            <dt>Platform</dt>
            <dd>{environment.platform}</dd>
            <dt>WSL distros</dt>
            <dd>
              {environment.wslDistros.length === 0 ? "none" : environment.wslDistros.join(", ")}
            </dd>
          </dl>
        )}
      </section>
    </main>
  );
}
