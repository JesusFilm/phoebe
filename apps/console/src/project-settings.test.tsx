import { describe, expect, test } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";
import { ProjectSettings } from "./project-settings.tsx";
import { install } from "./test-fixture.ts";

const settle = () => Promise.resolve();

describe("a project's own settings", () => {
  test("offers the display name with the folder's name as the placeholder, and the location", () => {
    const markup = renderToStaticMarkup(
      <ProjectSettings
        install={install({ dir: "/repos/youtube-studio", name: "youtube-studio" })}
        onUpdate={settle}
        onPickLocation={() => Promise.resolve(null)}
      />,
    );

    expect(markup).toContain('aria-label="This project"');
    expect(markup).toContain(">Display name</label>");
    expect(markup).toContain(">Location</label>");
    expect(markup).toContain('placeholder="youtube-studio"');
    expect(markup).toContain('value=""');
    // Nothing typed yet, so nothing to save.
    expect(markup).toMatch(/<button type="submit"[^>]*disabled=""[^>]*>Save<\/button>/);
    expect(markup).toMatch(/<input[^>]*readonly=""[^>]*value="\/repos\/youtube-studio"/i);
    expect(markup).toContain(">Change…</button>");
  });

  test("shows the label that is set, and names the folder it stands in for", () => {
    const markup = renderToStaticMarkup(
      <ProjectSettings
        install={install({ dir: "C:\\repos\\ys", name: "Studio", label: "Studio" })}
        onUpdate={settle}
        onPickLocation={() => Promise.resolve(null)}
      />,
    );

    expect(markup).toContain('value="Studio"');
    expect(markup).toContain('placeholder="ys"');
    expect(markup).toContain('<span class="mono">ys</span>');
  });

  test("a WSL install's folder is named by its Linux path", () => {
    const markup = renderToStaticMarkup(
      <ProjectSettings
        install={install({
          dir: "\\\\wsl.localhost\\archlinux\\home\\mike\\phoebe",
          name: "phoebe",
          wsl: { distro: "archlinux", dir: "/home/mike/phoebe" },
        })}
        onUpdate={settle}
        onPickLocation={() => Promise.resolve(null)}
      />,
    );

    expect(markup).toContain('placeholder="phoebe"');
  });
});
