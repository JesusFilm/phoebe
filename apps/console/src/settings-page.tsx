// The settings page: the console's own preferences, behind the gear at the foot
// of the rail (`#/settings`), the way T3 Code keeps its settings behind the gear
// at the foot of its sidebar.
//
// Everything here is the operator's and about this window: the console's
// colours, whether the desktop is told about alerts, and what this companion is
// running on. Nothing about a deployment lives here; a deployment's settings are
// its own tabbed page (install-page.tsx), behind the gear on its rail entry.
// A plain browser has no companion behind it, so it gets the page with the one
// thing that is still true of it.

import type { CSSProperties } from "react";
import type { CompanionEnvironment, CompanionUpdate } from "phoebe-agent/contracts";
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
  "[phoebe:JesusFilm/phoebe:work][issues issue:88][claude] Reading the ticket and the map…",
  "[phoebe:JesusFilm/phoebe:work][issues issue:88][claude:stderr] warning: slow response from the API, retrying",
];

export function SettingsPage({
  surface,
  environment,
  systemDark,
  notifications,
  onNotifications,
  consoleTheme,
  onConsoleTheme,
  autoCheckUpdates = false,
  onAutoCheckUpdates,
  update = null,
  onCheckUpdate,
  onDownloadUpdate,
  onRestartUpdate,
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
  /** Check every install's agent versions on a timer (update-alert.tsx). */
  autoCheckUpdates?: boolean;
  onAutoCheckUpdates?: (wanted: boolean) => void;
  /** The companion's own update, as main knows it. Null before it answered. */
  update?: CompanionUpdate | null;
  onCheckUpdate?: () => void;
  onDownloadUpdate?: () => void;
  onRestartUpdate?: () => void;
}) {
  if (surface === "browser") {
    return (
      <main className="main settings-page">
        <h1>Settings</h1>
        <p className="muted">
          This console is open in a browser, which keeps nothing on this machine. The companion app
          has the settings a machine of its own needs: the console&apos;s colours and desktop
          notifications.
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

      <section className="settings-section" aria-labelledby="settings-updates">
        <h2 id="settings-updates">Updates</h2>
        <p className="muted">
          Check each workspace and install for newer agent versions: Phoebe&apos;s launcher and
          engine, and the Cursor, Claude Code and Codex CLIs its container carries. Shortly after
          launch and every few hours, the companion asks npm and Cursor what is newest and says so
          when an install is behind, with a button to update. It never updates anything by itself.
        </p>
        <label className="settings-row settings-check">
          <input
            type="checkbox"
            checked={autoCheckUpdates}
            disabled={onAutoCheckUpdates === undefined}
            onChange={(event) => onAutoCheckUpdates?.(event.target.checked)}
          />
          Check for updates automatically
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
        <p className="muted">
          The companion looks for a newer build of itself shortly after launch and every four hours.
          A new one downloads only when you ask, and installs when you quit, or sooner with Restart
          now.
        </p>
        <CompanionUpdateRow
          update={update}
          {...(onCheckUpdate === undefined ? {} : { onCheck: onCheckUpdate })}
          {...(onDownloadUpdate === undefined ? {} : { onDownload: onDownloadUpdate })}
          {...(onRestartUpdate === undefined ? {} : { onRestart: onRestartUpdate })}
        />
      </section>
    </main>
  );
}

/**
 * Where the companion's own update stands, as one row with the one button that
 * is the next step. The rail's foot says the same for the three states worth
 * interrupting for; this row also says "up to date", which is what a person
 * who came to the settings page to ask is here for.
 */
function CompanionUpdateRow({
  update,
  onCheck,
  onDownload,
  onRestart,
}: {
  update: CompanionUpdate | null;
  onCheck?: () => void;
  onDownload?: () => void;
  onRestart?: () => void;
}) {
  if (update === null) return null;
  const check =
    onCheck === undefined ? null : (
      <button type="button" onClick={onCheck}>
        Check for updates
      </button>
    );
  switch (update.kind) {
    case "unsupported":
      return (
        <div className="settings-row">
          <span className="settings-label">Update</span>
          <span>
            This companion does not update itself: {update.reason}.{" "}
            <a href={update.releases}>Releases</a>
          </span>
        </div>
      );
    case "checking":
      return (
        <div className="settings-row">
          <span className="settings-label">Update</span>
          <span className="muted">Checking for a newer Phoebe…</span>
        </div>
      );
    case "current":
      return (
        <div className="settings-row">
          <span className="settings-label">Update</span>
          <span>Phoebe is up to date.</span>
          {check}
        </div>
      );
    case "available":
      return (
        <div className="settings-row">
          <span className="settings-label">Update</span>
          <span>Phoebe {update.version} is available.</span>
          {onDownload === undefined ? null : (
            <button type="button" onClick={onDownload}>
              Download
            </button>
          )}
        </div>
      );
    case "downloading":
      return (
        <div className="settings-row">
          <span className="settings-label">Update</span>
          <span className="muted">
            Downloading Phoebe {update.version}… {update.percent}%
          </span>
        </div>
      );
    case "ready":
      return (
        <div className="settings-row">
          <span className="settings-label">Update</span>
          <span>Phoebe {update.version} installs when you quit.</span>
          {onRestart === undefined ? null : (
            <button type="button" onClick={onRestart}>
              Restart now
            </button>
          )}
        </div>
      );
    case "unread":
      return (
        <div className="settings-row">
          <span className="settings-label">Update</span>
          <span className="muted">The last check did not finish: {update.message}</span>
          {check}
        </div>
      );
  }
}
