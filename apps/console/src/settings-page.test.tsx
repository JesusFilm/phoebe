import { describe, expect, test } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";
import { Rail } from "./rail.tsx";
import { SAMPLE_LINES, SettingsPage } from "./settings-page.tsx";
import { environment, NOW } from "./test-fixture.ts";

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

describe("the gear at the foot of the rail", () => {
  test("is a bare gear onto the settings page on both surfaces, never a selected place", () => {
    const companion = renderToStaticMarkup(
      <Rail
        facts={[]}
        now={NOW}
        surface="companion"
        signedIn={false}
        installs={[]}
        signIn={null}
        onSignedIn={noop}
      />,
    );
    const browser = renderToStaticMarkup(
      <Rail facts={[]} now={NOW} surface="browser" signedIn signIn={null} onSignedIn={noop} />,
    );

    for (const rail of [companion, browser]) {
      // The brand heads the rail and is the way home, the fleet.
      expect(rail).toMatch(/<nav class="rail"[^>]*><a class="rail-brand" href="#\/fleet">Phoebe/);
      expect(rail).toMatch(/<a class="rail-settings" href="#\/settings" aria-label="Settings"/);
      expect(rail).toMatch(
        /class="rail-settings"[^>]*>\s*<svg[^>]*lucide-settings[^>]*>[\s\S]*?<\/svg><\/a>/,
      );
      expect(rail).not.toMatch(/rail-settings[^>]*aria-current/);
      expect(rail).not.toMatch(/<\/svg><span>Settings<\/span>/);
    }
  });
});
