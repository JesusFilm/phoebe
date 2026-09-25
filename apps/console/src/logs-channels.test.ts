import { describe, expect, test } from "vite-plus/test";
import {
  ALL_CHANNEL,
  BOOT_CHANNEL,
  channelLabel,
  channelOf,
  channelsIn,
  linesIn,
} from "./logs-channels.ts";

const LINES = [
  "[phoebe] boot: engine source local — exec /opt/phoebe-engine/src/cli.ts",
  "[phoebe:JesusFilm/phoebe:work] cycle: nothing ready-for-agent, sleeping 30s",
  "[phoebe:JesusFilm/phoebe:research][issue 497] started",
  "[JesusFilm/phoebe:claude] Reading the ticket…",
  "[JesusFilm/phoebe:claude:stderr] warning: slow",
  "[phoebe:JesusFilm/youtube-studio:work] cycle: 1 candidate",
  "npm warn deprecated something",
];

describe("which channel a line is on", () => {
  test("an engine line is its tenant and pipeline, on behalf of a unit or not", () => {
    expect(channelOf(LINES[1] as string)).toBe("JesusFilm/phoebe:work");
    expect(channelOf(LINES[2] as string)).toBe("JesusFilm/phoebe:research");
  });

  test("an agent's lines are the tenant and the command, stderr folded in", () => {
    expect(channelOf(LINES[3] as string)).toBe("JesusFilm/phoebe:claude");
    expect(channelOf(LINES[4] as string)).toBe("JesusFilm/phoebe:claude");
  });

  test("the bootstrapper's lines and untagged noise are boot", () => {
    expect(channelOf(LINES[0] as string)).toBe(BOOT_CHANNEL);
    expect(channelOf(LINES[6] as string)).toBe(BOOT_CHANNEL);
  });
});

describe("the tabs", () => {
  test("are all, then boot, then each channel in the order it first spoke", () => {
    expect(channelsIn(LINES)).toEqual([
      ALL_CHANNEL,
      BOOT_CHANNEL,
      "JesusFilm/phoebe:work",
      "JesusFilm/phoebe:research",
      "JesusFilm/phoebe:claude",
      "JesusFilm/youtube-studio:work",
    ]);
  });

  test("boot is left out until the bootstrapper says something", () => {
    expect(channelsIn([LINES[1] as string])).toEqual([ALL_CHANNEL, "JesusFilm/phoebe:work"]);
    expect(channelsIn([])).toEqual([ALL_CHANNEL]);
  });

  test("a tab shows its own lines, unchanged, and all shows every line", () => {
    expect(linesIn(LINES, "JesusFilm/phoebe:claude")).toEqual([LINES[3], LINES[4]]);
    expect(linesIn(LINES, BOOT_CHANNEL)).toEqual([LINES[0], LINES[6]]);
    expect(linesIn(LINES, ALL_CHANNEL)).toEqual(LINES);
  });

  test("is labelled by the repo and the pipeline, the owner being the same on every tab", () => {
    expect(channelLabel("JesusFilm/phoebe:work")).toBe("phoebe:work");
    expect(channelLabel("JesusFilm/phoebe:claude")).toBe("phoebe:claude");
    expect(channelLabel(ALL_CHANNEL)).toBe("all");
    expect(channelLabel(BOOT_CHANNEL)).toBe("boot");
  });
});
