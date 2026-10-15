import { describe, expect, test } from "vite-plus/test";
import {
  ALL_CHANNEL,
  BOOT_CHANNEL,
  channelLabel,
  channelOf,
  channelsIn,
  CLI_CHANNEL,
  inChannel,
  tenantChannel,
} from "./logs-channels.ts";

const LINES = [
  "[phoebe] boot: engine source local — exec /opt/phoebe-engine/src/cli.ts",
  "[phoebe:JesusFilm/phoebe:work] cycle: nothing ready-for-agent, sleeping 30s",
  "[phoebe:JesusFilm/phoebe:research][issue 497] started",
  "[phoebe:JesusFilm/phoebe:work][conflicts pr:563][claude] Reading the conflict…",
  "[phoebe:JesusFilm/phoebe:work][conflicts pr:563][claude:stderr] warning: slow",
  "[phoebe:JesusFilm/youtube-studio:work] cycle: 1 candidate",
  "npm warn deprecated something",
];

describe("which channel a line is on", () => {
  test("an engine line is its tenant and pipeline, on behalf of a unit or not", () => {
    expect(channelOf(LINES[1] as string)).toBe("JesusFilm/phoebe:work");
    expect(channelOf(LINES[2] as string)).toBe("JesusFilm/phoebe:research");
  });

  // The agent opens with its pipeline's bracket (#686), so its lines, stderr
  // included, land on the channel the engine's do.
  test("an agent's lines are its pipeline's channel, stderr and all", () => {
    expect(channelOf(LINES[3] as string)).toBe("JesusFilm/phoebe:work");
    expect(channelOf(LINES[4] as string)).toBe("JesusFilm/phoebe:work");
  });

  // The deployment's name is read off the front of the bracket and left out of
  // the channel. A directory name may hold a colon, and a solo deployment's name
  // is its own slug, so the parse anchors on the slug from the right.
  test("whatever the deployment is called, the channel is the slug and the pipeline", () => {
    expect(channelOf("[ops:east:JesusFilm/phoebe:work][issue 7] started")).toBe(
      "JesusFilm/phoebe:work",
    );
    expect(channelOf("[JesusFilm/phoebe:JesusFilm/phoebe:work] cycle: 1 candidate")).toBe(
      "JesusFilm/phoebe:work",
    );
    expect(channelOf("[JesusFilm/phoebe:JesusFilm/phoebe:work][issue 7][claude:stderr] slow")).toBe(
      "JesusFilm/phoebe:work",
    );
  });

  test("a bracket with no slug in it is no pipeline's", () => {
    expect(channelOf("[claude] Reading the ticket…")).toBe(BOOT_CHANNEL);
    expect(channelOf("[phoebe:work] cycle")).toBe(BOOT_CHANNEL);
  });

  test("the bootstrapper's lines and untagged noise are boot", () => {
    expect(channelOf(LINES[0] as string)).toBe(BOOT_CHANNEL);
    expect(channelOf(LINES[6] as string)).toBe(BOOT_CHANNEL);
  });
});

/** The channels those lines arrived on, as logs.ts collects them. */
const SEEN = new Set(LINES.map(channelOf));

describe("the tabs", () => {
  test("are all, then boot, then each channel in the order it first spoke", () => {
    expect(channelsIn(SEEN)).toEqual([
      ALL_CHANNEL,
      BOOT_CHANNEL,
      "JesusFilm/phoebe:work",
      "JesusFilm/phoebe:research",
      "JesusFilm/youtube-studio:work",
    ]);
  });

  test("give a pipeline one tab, its agent's lines and the engine's together", () => {
    const labels = channelsIn(SEEN).map(channelLabel);
    expect(labels.filter((label) => label === "phoebe:work")).toHaveLength(1);
    expect(labels).not.toContain("phoebe:work:claude");
  });

  test("boot is left out until the bootstrapper says something", () => {
    expect(channelsIn(new Set(["JesusFilm/phoebe:work"]))).toEqual([
      ALL_CHANNEL,
      "JesusFilm/phoebe:work",
    ]);
    expect(channelsIn(new Set())).toEqual([ALL_CHANNEL]);
  });

  // The tabs are the channels seen, handed over by logs.ts, and not a read of
  // the lines held: a channel whose lines are all gone — cleared, or dropped by
  // the bound — keeps its tab, which is where the operator asks what it is
  // saying now.
  test("are the channels seen, whether or not a line of theirs is still held", () => {
    expect(channelsIn(new Set([BOOT_CHANNEL, "acme/a:work"]))).toEqual([
      ALL_CHANNEL,
      BOOT_CHANNEL,
      "acme/a:work",
    ]);
  });

  test("a line belongs to its own tab and to all, and to no other pipeline's", () => {
    expect(inChannel(channelOf(LINES[1] as string), "JesusFilm/phoebe:work")).toBe(true);
    expect(inChannel(channelOf(LINES[3] as string), "JesusFilm/phoebe:work")).toBe(true);
    expect(inChannel(channelOf(LINES[4] as string), "JesusFilm/phoebe:work")).toBe(true);
    expect(inChannel(channelOf(LINES[3] as string), "JesusFilm/phoebe:research")).toBe(false);
    expect(inChannel(channelOf(LINES[0] as string), BOOT_CHANNEL)).toBe(true);
    expect(inChannel(channelOf(LINES[6] as string), BOOT_CHANNEL)).toBe(true);
    for (const line of LINES) expect(inChannel(channelOf(line), ALL_CHANNEL)).toBe(true);
  });

  test("is labelled by the repo and the pipeline, the owner being the same on every tab", () => {
    expect(channelLabel("JesusFilm/phoebe:work")).toBe("phoebe:work");
    expect(channelLabel(ALL_CHANNEL)).toBe("all");
    expect(channelLabel(BOOT_CHANNEL)).toBe("boot");
  });
});

describe("a workspace child's own tab", () => {
  const scope = tenantChannel("JesusFilm/phoebe");

  test("sits after boot, and is there before its first line", () => {
    expect(channelsIn(new Set(), scope)).toEqual([ALL_CHANNEL, scope]);
    expect(channelsIn(SEEN, scope).slice(0, 3)).toEqual([ALL_CHANNEL, BOOT_CHANNEL, scope]);
  });

  test("takes every line under the slug, engine and agent alike, and nobody else's", () => {
    for (const line of [LINES[1], LINES[2], LINES[3], LINES[4]]) {
      expect(inChannel(channelOf(line as string), scope)).toBe(true);
    }
    expect(inChannel(channelOf(LINES[5] as string), scope)).toBe(false);
    expect(
      inChannel(channelOf(LINES[5] as string), tenantChannel("JesusFilm/youtube-studio")),
    ).toBe(true);
  });

  test("is labelled by the repo alone", () => {
    expect(channelLabel(scope)).toBe("phoebe");
  });
});

describe("the cli tab", () => {
  const seen = new Set([BOOT_CHANNEL, "acme/a:work"]);

  test("is there once a verb has run, beside the bootstrapper's and ahead of the pipelines", () => {
    expect(channelsIn(seen, null, true)).toEqual([
      ALL_CHANNEL,
      BOOT_CHANNEL,
      CLI_CHANNEL,
      "acme/a:work",
    ]);
    expect(channelsIn(seen, "acme/a:*", true)).toEqual([
      ALL_CHANNEL,
      BOOT_CHANNEL,
      CLI_CHANNEL,
      "acme/a:*",
      "acme/a:work",
    ]);
  });

  test("is not a tab until one has, and no container line belongs to it", () => {
    expect(channelsIn(seen)).not.toContain(CLI_CHANNEL);
    // A container that prints the word is still the container's line.
    expect(channelOf("cli")).toBe(BOOT_CHANNEL);
    expect(channelLabel(CLI_CHANNEL)).toBe("cli");
  });
});
