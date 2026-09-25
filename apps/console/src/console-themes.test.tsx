import { describe, expect, test } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";
import { applySgr, parseAnsi, PLAIN } from "./ansi.ts";
import { ConsoleThemePicker } from "./console-theme-picker.tsx";
import {
  CONSOLE_THEMES,
  consoleThemeById,
  consoleThemeChoiceOf,
  consoleThemeProperties,
  resolveConsoleTheme,
  SYSTEM_CONSOLE_THEME,
  TAG_ROLES,
} from "./console-themes.ts";
import { ansiStyleFor, LogLine, splitTags } from "./log-line.tsx";

const HEX = /^#[0-9a-f]{6}$/;

describe("the themes on offer", () => {
  test("every theme has a background, a foreground, a dim, a panel and sixteen ANSI colours", () => {
    for (const theme of CONSOLE_THEMES) {
      for (const value of [theme.bg, theme.fg, theme.dim, theme.panel, ...theme.ansi]) {
        expect(value, theme.id).toMatch(HEX);
      }
      expect(theme.ansi, theme.id).toHaveLength(16);
    }
  });

  test("ids are unique, and none is the word for the OS's say", () => {
    const ids = CONSOLE_THEMES.map((theme) => theme.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain(SYSTEM_CONSOLE_THEME);
    expect(consoleThemeById("nord")?.name).toBe("Nord");
    expect(consoleThemeById("no-such")).toBeNull();
  });

  test("system is Phoebe's own light or dark by the OS, and so is an id this build lacks", () => {
    expect(resolveConsoleTheme(SYSTEM_CONSOLE_THEME, false).id).toBe("phoebe-light");
    expect(resolveConsoleTheme(SYSTEM_CONSOLE_THEME, true).id).toBe("phoebe-dark");
    expect(resolveConsoleTheme("from-a-newer-console", true).id).toBe("phoebe-dark");
    expect(resolveConsoleTheme("solarized-light", true).id).toBe("solarized-light");
  });

  test("a stored choice is read back only when it is one; anything else is system", () => {
    expect(consoleThemeChoiceOf("dracula")).toBe("dracula");
    expect(consoleThemeChoiceOf(SYSTEM_CONSOLE_THEME)).toBe(SYSTEM_CONSOLE_THEME);
    expect(consoleThemeChoiceOf("no-such")).toBe(SYSTEM_CONSOLE_THEME);
    expect(consoleThemeChoiceOf(undefined)).toBe(SYSTEM_CONSOLE_THEME);
  });

  test("the properties name the console's colours and the tag roles off the palette", () => {
    const nord = consoleThemeById("nord")!;
    const properties = consoleThemeProperties(nord);
    expect(properties["--console-bg"]).toBe("#2e3440");
    expect(properties["--console-tag-pipeline"]).toBe(nord.ansi[TAG_ROLES.pipeline]);
    expect(properties["--console-tag-stderr"]).toBe(nord.ansi[TAG_ROLES.stderr]);
  });
});

describe("ANSI codes in a line", () => {
  test("a line with none is one plain run, and an empty line is nothing", () => {
    expect(parseAnsi("plain")).toEqual([{ text: "plain", style: PLAIN }]);
    expect(parseAnsi("")).toEqual([]);
  });

  test("colours, bold and reset split the line into runs", () => {
    const runs = parseAnsi("a \u001b[31mred\u001b[0m and \u001b[1;92mbright\u001b[m.");

    expect(runs.map((run) => run.text)).toEqual(["a ", "red", " and ", "bright", "."]);
    expect(runs[1]!.style.fg).toBe(1);
    expect(runs[2]!.style).toEqual(PLAIN);
    expect(runs[3]!.style).toMatchObject({ fg: 10, bold: true });
    expect(runs[4]!.style).toEqual(PLAIN);
  });

  test("256-colour and truecolour codes come out as exact values; the first sixteen as indexes", () => {
    expect(applySgr(PLAIN, "38;5;3").fg).toBe(3);
    expect(applySgr(PLAIN, "38;5;196").fg).toBe("rgb(255, 0, 0)");
    expect(applySgr(PLAIN, "38;5;244").fg).toBe("rgb(128, 128, 128)");
    expect(applySgr(PLAIN, "48;2;10;20;30").bg).toBe("rgb(10, 20, 30)");
    expect(applySgr({ ...PLAIN, fg: 1, bg: 2 }, "39;49")).toEqual(PLAIN);
  });

  test("codes that are not colour are dropped, and the text between them kept", () => {
    const runs = parseAnsi("\u001b[2K\u001b[1Gline \u001b]0;title\u0007kept\u001b[?25h");

    expect(runs.map((run) => run.text).join("")).toBe("line kept");
  });

  test("a style is a colour from the palette, or the exact value it named", () => {
    const palette = consoleThemeById("dracula")!.ansi;
    expect(ansiStyleFor({ ...PLAIN, fg: 1, bold: true }, palette)).toEqual({
      color: "#ff5555",
      fontWeight: 600,
    });
    expect(ansiStyleFor({ ...PLAIN, bg: "rgb(1, 2, 3)", dim: true }, palette)).toEqual({
      backgroundColor: "rgb(1, 2, 3)",
      opacity: 0.7,
    });
    expect(ansiStyleFor(PLAIN, palette)).toBeUndefined();
  });
});

describe("the tags at the head of a line", () => {
  test("the bootstrapper's, a pipeline's with its unit, and an agent's with stderr", () => {
    expect(splitTags("[phoebe] boot: ok")).toEqual({
      tags: [{ text: "[phoebe]", role: "boot" }],
      rest: " boot: ok",
    });
    expect(splitTags("[phoebe:JesusFilm/phoebe:research][issue 497] started")).toEqual({
      tags: [
        { text: "[phoebe:JesusFilm/phoebe:research]", role: "pipeline" },
        { text: "[issue 497]", role: "unit" },
      ],
      rest: " started",
    });
    expect(splitTags("[JesusFilm/phoebe:claude:stderr] warning").tags).toEqual([
      { text: "[JesusFilm/phoebe:claude:stderr]", role: "stderr" },
    ]);
    expect(splitTags("[JesusFilm/phoebe:claude] Reading").tags[0]!.role).toBe("agent");
  });

  test("a line with no tag is all message", () => {
    expect(splitTags("npm warn deprecated")).toEqual({ tags: [], rest: "npm warn deprecated" });
  });

  test("draws the tags by role and the message's colour from the palette", () => {
    const palette = consoleThemeById("nord")!.ansi;
    const markup = renderToStaticMarkup(
      <LogLine line={"[JesusFilm/phoebe:claude] done \u001b[32mok\u001b[0m"} palette={palette} />,
    );

    expect(markup).toContain('<span class="log-tag agent">[JesusFilm/phoebe:claude]</span>');
    expect(markup).toContain(`<span style="color:${palette[2]}">ok</span>`);
  });
});

describe("the picker", () => {
  test("offers system and every theme, light ones then dark, with the choice selected", () => {
    const markup = renderToStaticMarkup(
      <ConsoleThemePicker theme="nord" onChoose={() => undefined} />,
    );

    expect(markup).toContain('aria-label="Console theme"');
    expect(markup.match(/<option /g)).toHaveLength(CONSOLE_THEMES.length + 1);
    expect(markup).toMatch(/<option value="system">System<\/option><optgroup label="Light">/);
    expect(markup).toContain('<option value="nord" selected="">Nord</option>');
  });
});
