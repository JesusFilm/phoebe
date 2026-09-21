// The update rules: one check, nothing without a click, and two companions that
// do not update at all.

import { describe, expect, test } from "vite-plus/test";
import type { CompanionUpdate } from "phoebe-agent/contracts";
import { RELEASES_PAGE, type FeedChoice, type UpdateFeed } from "./update-feed.ts";
import { createCompanionUpdates, type UpdaterControls } from "./updates.ts";

/** An updater that records what it was asked to do and answers nothing. */
function fakeUpdater() {
  const calls: string[] = [];
  const feeds: UpdateFeed[] = [];
  const updater: UpdaterControls = {
    autoDownload: true,
    autoInstallOnAppQuit: false,
    allowDowngrade: true,
    setFeedURL: (feed) => {
      feeds.push(feed);
    },
    checkForUpdates: () => {
      calls.push("check");
      return Promise.resolve(null);
    },
    downloadUpdate: () => {
      calls.push("download");
      return Promise.resolve([]);
    },
    quitAndInstall: () => {
      calls.push("quitAndInstall");
    },
  };
  return { updater, calls, feeds };
}

/** A packaged Linux companion — the case where updates happen. */
function updates(
  choice: FeedChoice = { kind: "latest" },
  over: { platform?: string; packaged?: boolean } = {},
) {
  const { updater, calls, feeds } = fakeUpdater();
  const seen: CompanionUpdate[] = [];
  const arm = createCompanionUpdates({
    updater,
    platform: over.platform ?? "linux",
    packaged: over.packaged ?? true,
    feed: () => Promise.resolve(choice),
    onChange: (update) => seen.push(update),
  });
  return { arm, updater, calls, feeds, seen };
}

describe("the three flags", () => {
  test("no automatic download, no downgrade, install on quit", () => {
    const { updater } = updates();

    expect(updater.autoDownload).toBe(false);
    expect(updater.allowDowngrade).toBe(false);
    expect(updater.autoInstallOnAppQuit).toBe(true);
  });

  test("an unsupported companion leaves the updater alone", () => {
    const { updater } = updates({ kind: "latest" }, { platform: "darwin" });

    expect(updater.autoDownload).toBe(true);
  });
});

describe("the launch check", () => {
  test("points the updater at the feed and asks once", async () => {
    const { arm, calls, feeds } = updates({ kind: "pinned", version: "0.12.0" });
    await arm.check();

    expect(feeds).toEqual([
      { provider: "generic", url: `${RELEASES_PAGE}/download/phoebe-agent@0.12.0` },
    ]);
    expect(calls).toEqual(["check"]);
    expect(arm.state()).toEqual({ kind: "checking" });
  });

  test("a feed nobody could read asks nothing", async () => {
    const { arm, calls } = updates({ kind: "unread", message: "fetch failed" });
    await arm.check();

    expect(calls).toEqual([]);
    expect(arm.state()).toEqual({ kind: "unread", message: "fetch failed" });
  });

  test("macOS does not check at all, and says why", async () => {
    const { arm, calls } = updates({ kind: "latest" }, { platform: "darwin" });
    await arm.check();

    expect(calls).toEqual([]);
    expect(arm.state()).toMatchObject({ kind: "unsupported", releases: RELEASES_PAGE });
    expect((arm.state() as { reason: string }).reason).toContain("unsigned");
  });

  test("a checkout does not check either", async () => {
    const { arm, calls } = updates({ kind: "latest" }, { packaged: false });
    await arm.check();

    expect(calls).toEqual([]);
    expect((arm.state() as { reason: string }).reason).toContain("checkout");
  });
});

describe("what the updater reports", () => {
  test("nothing newer is current", () => {
    const { arm, seen } = updates();
    arm.notAvailable();

    expect(arm.state()).toEqual({ kind: "current" });
    expect(seen).toEqual([{ kind: "current" }]);
  });

  test("an available build waits for the click", async () => {
    const { arm, calls } = updates();
    arm.available("0.14.0");

    expect(arm.state()).toEqual({ kind: "available", version: "0.14.0" });
    expect(calls).toEqual([]);

    await arm.download();
    expect(calls).toEqual(["download"]);
    expect(arm.state()).toEqual({ kind: "downloading", version: "0.14.0", percent: 0 });
  });

  test("progress keeps the version the download started on", async () => {
    const { arm } = updates();
    arm.available("0.14.0");
    await arm.download();
    arm.progress(41.7);

    expect(arm.state()).toEqual({ kind: "downloading", version: "0.14.0", percent: 42 });
  });

  test("a downloaded build installs on quit, or now if asked", () => {
    const { arm, calls } = updates();
    arm.available("0.14.0");
    arm.downloaded("0.14.0");

    expect(arm.state()).toEqual({ kind: "ready", version: "0.14.0" });

    arm.restart();
    expect(calls).toEqual(["quitAndInstall"]);
  });

  test("a failure is unread rather than a state that never moves", () => {
    const { arm } = updates();
    arm.failed(new Error("ENOTFOUND github.com"));

    expect(arm.state()).toEqual({ kind: "unread", message: "ENOTFOUND github.com" });
  });

  test("a late event cannot overwrite an unsupported companion", () => {
    const { arm } = updates({ kind: "latest" }, { platform: "darwin" });
    arm.available("0.14.0");

    expect(arm.state()).toMatchObject({ kind: "unsupported" });
  });
});

describe("refusing what is not the next step", () => {
  test("downloading before there is anything to download", async () => {
    const { arm, calls } = updates();

    await expect(arm.download()).rejects.toMatchObject({
      error: { code: "refused", message: "there is no update to download" },
    });
    expect(calls).toEqual([]);
  });

  test("restarting before a build is staged", () => {
    const { arm } = updates();

    expect(() => arm.restart()).toThrowError("there is no update to install");
  });

  test("macOS refuses with the release page to go to instead", async () => {
    const { arm } = updates({ kind: "latest" }, { platform: "darwin" });

    await expect(arm.download()).rejects.toMatchObject({
      error: { code: "refused", instruction: `Download it from ${RELEASES_PAGE}.` },
    });
  });
});
