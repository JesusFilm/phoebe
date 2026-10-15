import { describe, expect, test } from "vite-plus/test";
import {
  ALL_CHANNEL,
  BOOT_CHANNEL,
  channelLabel,
  channelOf,
  channelsIn,
  CLI_CHANNEL,
  linesIn,
  tenantChannel,
} from "./logs-channels.ts";

const LINES = [
  "[phoebe] boot: engine source local — exec /opt/phoebe-engine/src/cli.ts",
  "[phoebe:JesusFilm/phoebe:work] cycle: nothing ready-for-agent, sleeping 30s",
  "[phoebe:JesusFilm/phoebe:research][issue 497] started",
  "[JesusFilm/phoebe:work:claude] Reading the ticket…",
  "[JesusFilm/phoebe:work:claude:stderr] warning: slow",
  "[phoebe:JesusFilm/youtube-studio:work] cycle: 1 candidate",
  "npm warn deprecated something",
];

describe("which channel a line is on", () => {
  test("an engine line is its tenant and pipeline, on behalf of a unit or not", () => {
    expect(channelOf(LINES[1] as string)).toBe("JesusFilm/phoebe:work");
    expect(channelOf(LINES[2] as string)).toBe("JesusFilm/phoebe:research");
  });

  test("an agent's lines are the tenant, the pipeline and the command, stderr folded in", () => {
    expect(channelOf(LINES[3] as string)).toBe("JesusFilm/phoebe:work:claude");
    expect(channelOf(LINES[4] as string)).toBe("JesusFilm/phoebe:work:claude");
  });

  // The pipeline arrived on the agent bracket (#675) and `:stderr` still has to
  // fold: it is a suffix on the command, not a fourth segment of its own.
  test("stderr folds into its channel however many segments precede it", () => {
    expect(channelOf("[JesusFilm/phoebe:work:claude:stderr] warning")).toBe(
      "JesusFilm/phoebe:work:claude",
    );
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
      "JesusFilm/phoebe:work:claude",
      "JesusFilm/youtube-studio:work",
    ]);
  });

  test("boot is left out until the bootstrapper says something", () => {
    expect(channelsIn([LINES[1] as string])).toEqual([ALL_CHANNEL, "JesusFilm/phoebe:work"]);
    expect(channelsIn([])).toEqual([ALL_CHANNEL]);
  });

  test("a tab shows its own lines, unchanged, and all shows every line", () => {
    expect(linesIn(LINES, "JesusFilm/phoebe:work:claude")).toEqual([LINES[3], LINES[4]]);
    expect(linesIn(LINES, BOOT_CHANNEL)).toEqual([LINES[0], LINES[6]]);
    expect(linesIn(LINES, ALL_CHANNEL)).toEqual(LINES);
  });

  test("is labelled by the repo and the pipeline, the owner being the same on every tab", () => {
    expect(channelLabel("JesusFilm/phoebe:work")).toBe("phoebe:work");
    expect(channelLabel("JesusFilm/phoebe:work:claude")).toBe("phoebe:work:claude");
    expect(channelLabel(ALL_CHANNEL)).toBe("all");
    expect(channelLabel(BOOT_CHANNEL)).toBe("boot");
  });
});

describe("a workspace child's own tab", () => {
  const scope = tenantChannel("JesusFilm/phoebe");

  test("sits after boot, and is there before its first line", () => {
    expect(channelsIn([], scope)).toEqual([ALL_CHANNEL, scope]);
    expect(channelsIn(LINES, scope).slice(0, 3)).toEqual([ALL_CHANNEL, BOOT_CHANNEL, scope]);
  });

  test("shows every line under the slug, engine and agent alike, and nobody else's", () => {
    expect(linesIn(LINES, scope)).toEqual([LINES[1], LINES[2], LINES[3], LINES[4]]);
    expect(linesIn(LINES, tenantChannel("JesusFilm/youtube-studio"))).toEqual([LINES[5]]);
  });

  test("is labelled by the repo alone", () => {
    expect(channelLabel(scope)).toBe("phoebe");
  });
});

describe("the cli tab", () => {
  const lines = ["[phoebe] boot: ok", "[phoebe:acme/a:work] cycle"];

  test("is there once a verb has run, beside the bootstrapper's and ahead of the pipelines", () => {
    expect(channelsIn(lines, null, true)).toEqual([
      ALL_CHANNEL,
      BOOT_CHANNEL,
      CLI_CHANNEL,
      "acme/a:work",
    ]);
    expect(channelsIn(lines, "acme/a:*", true)).toEqual([
      ALL_CHANNEL,
      BOOT_CHANNEL,
      CLI_CHANNEL,
      "acme/a:*",
      "acme/a:work",
    ]);
  });

  test("is not a tab until one has, and no container line belongs to it", () => {
    expect(channelsIn(lines)).not.toContain(CLI_CHANNEL);
    // A container that prints the word is still the container's line.
    expect(channelOf("cli")).toBe(BOOT_CHANNEL);
    expect(channelLabel(CLI_CHANNEL)).toBe("cli");
  });
});
