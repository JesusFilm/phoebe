import { describe, expect, test } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";
import { Rail } from "./rail.tsx";
import { SAMPLE_LINES, SettingsPage } from "./settings-page.tsx";
import { environment } from "./test-fixture.ts";

function noop(): void {}

describe("the settings page", () => {
  const page = renderToStaticMarkup(
    <SettingsPage
      surface="companion"
      environment={environment({ wslDistros: ["archlinux"] })}
      systemDark
      notifications
      onNotifications={noop}
      consoleTheme="nord"
      onConsoleTheme={noop}
    />,
  );

  test("carries the console theme picker with a sample drawn in the chosen theme", () => {
    expect(page).toContain('aria-label="Console theme"');
    expect(page).toContain('<option value="nord" selected="">Nord</option>');
    expect(page).toMatch(/class="settings-preview logs-lines" data-theme="nord"/);
    expect(page).toContain("--console-bg:#2e3440");
    for (const line of SAMPLE_LINES) {
      const [tag] = line.split(" ");
      expect(page).toContain(tag!.split("][")[0]!.replace(/\]$/, "]"));
    }
    expect(page).toContain('<span class="log-tag stderr">');
  });

  test("carries the notifications switch and what this companion runs on", () => {
    expect(page).toMatch(/<input type="checkbox" checked=""[^>]*>Desktop notifications/);
    expect(page).toContain("Docker is running");
    expect(page).toContain("<dd>archlinux</dd>");
    expect(page).toContain("<dd>0.13.0</dd>");
  });

  test("says what System comes out as, by the OS", () => {
    const light = renderToStaticMarkup(
      <SettingsPage
        surface="companion"
        environment={null}
        systemDark={false}
        notifications={false}
        consoleTheme="system"
        onConsoleTheme={noop}
      />,
    );

    expect(light).toContain('data-theme="phoebe-light"');
    expect(light).toContain("Reading what this machine has");
    // Without a way to save, the switch is drawn but not live.
    expect(light).toMatch(/<input type="checkbox" disabled=""/);
  });

  test("in a browser, says the settings are the companion's", () => {
    const browser = renderToStaticMarkup(
      <SettingsPage
        surface="browser"
        environment={null}
        systemDark={false}
        notifications={false}
        consoleTheme="system"
      />,
    );

    expect(browser).toContain("<h1>Settings</h1>");
    expect(browser).not.toContain("Console theme");
    expect(browser).toContain("companion app");
  });
});

describe("the companion's own update on the settings page", () => {
  function row(update: Parameters<typeof SettingsPage>[0]["update"], live = true) {
    return renderToStaticMarkup(
      <SettingsPage
        surface="companion"
        environment={null}
        systemDark
        notifications
        consoleTheme="system"
        update={update}
        {...(live ? { onCheckUpdate: noop, onDownloadUpdate: noop, onRestartUpdate: noop } : {})}
      />,
    );
  }

  test("says how updates work, and nothing more before main has answered", () => {
    const page = row(null);
    expect(page).toContain("downloads only when you ask");
    expect(page).not.toContain("Check for updates</button>");
  });

  test("up to date, with the button to ask again", () => {
    const page = row({ kind: "current" });
    expect(page).toContain("Phoebe is up to date.");
    expect(page).toContain('<button type="button">Check for updates</button>');
    expect(row({ kind: "current" }, false)).not.toContain("Check for updates</button>");
  });

  test("the next step is the one button shown", () => {
    expect(row({ kind: "available", version: "0.16.0" })).toContain(
      'Phoebe 0.16.0 is available.</span><button type="button">Download</button>',
    );
    expect(row({ kind: "downloading", version: "0.16.0", percent: 42 })).toContain(
      "Downloading Phoebe 0.16.0… 42%",
    );
    expect(row({ kind: "ready", version: "0.16.0" })).toContain(
      'Phoebe 0.16.0 installs when you quit.</span><button type="button">Restart now</button>',
    );
  });

  test("a failed check and an unsupported companion each say why", () => {
    const failed = row({ kind: "unread", message: "ENOTFOUND github.com" });
    expect(failed).toContain("The last check did not finish: ENOTFOUND github.com");
    expect(failed).toContain("Check for updates</button>");

    const mac = row({
      kind: "unsupported",
      reason: "the macOS build is unsigned",
      releases: "https://github.com/JesusFilm/phoebe/releases",
    });
    expect(mac).toContain("does not update itself: the macOS build is unsigned.");
    expect(mac).toContain('href="https://github.com/JesusFilm/phoebe/releases"');
    expect(mac).not.toContain("Check for updates</button>");
  });
});

describe("the gear at the foot of the rail", () => {
  test("is a bare gear onto the settings page on both surfaces, never a selected place", () => {
    const companion = renderToStaticMarkup(<Rail surface="companion" installs={[]} />);
    const browser = renderToStaticMarkup(<Rail surface="browser" />);

    for (const rail of [companion, browser]) {
      // The brand heads the rail and is the way home.
      expect(rail).toMatch(/<nav class="rail"[^>]*><a class="rail-brand" href="#\/">Phoebe/);
      expect(rail).toMatch(/<a class="rail-settings" href="#\/settings" aria-label="Settings"/);
      expect(rail).toMatch(
        /class="rail-settings"[^>]*>\s*<svg[^>]*lucide-settings[^>]*>[\s\S]*?<\/svg><\/a>/,
      );
      expect(rail).not.toMatch(/rail-settings[^>]*aria-current/);
      expect(rail).not.toMatch(/<\/svg><span>Settings<\/span>/);
    }
  });
});
