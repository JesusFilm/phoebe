// The manners, stated. Every rule in #524 §5 and §6 is one assertion here, and
// none of them needs a browser: the constructor is injected and the two
// suppressions are arguments.

import { describe, expect, test } from "vite-plus/test";
import type { AlertBody, AlertMessage } from "phoebe-agent/contracts";
import { createNotifier, notificationFor, type Notifiable } from "./notifications.ts";

function alert(overrides: Partial<AlertMessage> = {}): AlertMessage {
  return {
    schema: 1,
    kind: "alert",
    condition: "dark",
    state: "raised",
    deployment: { name: "acme-site", keyFingerprint: "ff00" },
    since: "2026-09-18T09:55:00.000Z",
    detail: "no heartbeat for 5 min",
    text: "acme-site: dark (no heartbeat for 5 min)",
    url: "https://relay.example/#/d/ff00",
    ...overrides,
  };
}

/** A `Notification` that records rather than shows. */
function recorder() {
  const shown: { title: string; body: string; tag: string; silent: boolean }[] = [];
  const clicks: (() => void)[] = [];
  class Recorded {
    onclick: ((event: Event) => unknown) | null = null;
    constructor(title: string, init: { body: string; tag: string; silent: boolean }) {
      shown.push({ title, ...init });
      clicks.push(() => this.onclick?.(new Event("click")));
    }
  }
  return { Notification: Recorded, shown, click: (index: number) => clicks[index]?.() };
}

const SHOWING = { enabled: true, focused: false } as const;

describe("whether to interrupt at all", () => {
  test("nothing is shown with the preference off (#524 §8)", () => {
    expect(
      notificationFor({ alert: alert(), arm: "relay", enabled: false, focused: false }),
    ).toBeNull();
  });

  test("nothing is shown while the window is focused (#524 §6)", () => {
    expect(
      notificationFor({ alert: alert(), arm: "relay", enabled: true, focused: true }),
    ).toBeNull();
  });

  test("a clear is suppressed on the same terms as its raise", () => {
    const cleared = alert({ state: "cleared", text: "acme-site: no longer dark" });

    expect(
      notificationFor({ alert: cleared, arm: "relay", enabled: true, focused: true }),
    ).toBeNull();
  });
});

describe("what the banner says", () => {
  test("the name is the title and the sentence is the body", () => {
    const shown = notificationFor({ alert: alert(), arm: "relay", ...SHOWING })!;

    expect(shown.title).toBe("acme-site");
    expect(shown.body).toBe("dark (no heartbeat for 5 min)");
  });

  test("a sentence that does not lead with the name is carried whole", () => {
    const odd = alert({ text: "something else entirely" });

    expect(notificationFor({ alert: odd, arm: "relay", ...SHOWING })!.body).toBe(
      "something else entirely",
    );
  });

  test("the test alert names the relay and points at nobody (#515 §13)", () => {
    const probe: AlertBody = {
      schema: 1,
      kind: "test",
      by: "ada@example.test",
      at: "2026-09-18T10:00:00.000Z",
      text: "Phoebe relay test alert, sent by ada@example.test. Alerting is configured.",
      url: "https://relay.example/",
    };

    const shown = notificationFor({ alert: probe, arm: "relay", ...SHOWING })!;

    expect(shown.title).toBe("Phoebe relay");
    expect(shown.subject).toBeNull();
  });
});

describe("the tag, which is how a clear replaces its raise (#524 §5)", () => {
  test("is the deployment and the condition", () => {
    expect(notificationFor({ alert: alert(), arm: "relay", ...SHOWING })!.tag).toBe("ff00:dark");
  });

  test("so a clear lands on the raise it is about", () => {
    const raise = notificationFor({ alert: alert(), arm: "relay", ...SHOWING })!;
    const clear = notificationFor({
      alert: alert({ state: "cleared", text: "acme-site: no longer dark" }),
      arm: "relay",
      ...SHOWING,
    })!;

    expect(clear.tag).toBe(raise.tag);
  });

  test("and two conditions on one deployment do not fold into each other", () => {
    const dark = notificationFor({ alert: alert(), arm: "relay", ...SHOWING })!;
    const replaced = notificationFor({
      alert: alert({ condition: "replaced" }),
      arm: "relay",
      ...SHOWING,
    })!;

    expect(replaced.tag).not.toBe(dark.tag);
  });

  test("two pipelines of one deployment do fold, which is what stops twenty banners", () => {
    const one = notificationFor({
      alert: alert({ condition: "wedged", pipeline: "acme-site/sentry" }),
      arm: "relay",
      ...SHOWING,
    })!;
    const two = notificationFor({
      alert: alert({ condition: "wedged", pipeline: "acme-site/build" }),
      arm: "relay",
      ...SHOWING,
    })!;

    expect(two.tag).toBe(one.tag);
  });

  test("a local install is tagged by its directory, the local arm's identity", () => {
    const local = alert({ deployment: { name: "youtube-studio", keyFingerprint: "/repos/ys" } });

    expect(notificationFor({ alert: local, arm: "local", ...SHOWING })!.tag).toBe("/repos/ys:dark");
  });
});

describe("where a click goes (#524 §6)", () => {
  test("a relay alert points at the deployment", () => {
    const shown = notificationFor({ alert: alert(), arm: "relay", ...SHOWING })!;

    expect(shown.subject).toEqual({ arm: "relay", fingerprint: "ff00" });
  });

  test("a local alert points at the install", () => {
    const local = alert({ deployment: { name: "youtube-studio", keyFingerprint: "/repos/ys" } });

    expect(notificationFor({ alert: local, arm: "local", ...SHOWING })!.subject).toEqual({
      arm: "local",
      install: "/repos/ys",
    });
  });

  test("the pipeline rides along, for the tab a click should land on", () => {
    const wedged = alert({ condition: "wedged", pipeline: "acme-site/sentry" });

    expect(notificationFor({ alert: wedged, arm: "relay", ...SHOWING })!.pipeline).toBe(
      "acme-site/sentry",
    );
  });
});

describe("the notifier", () => {
  test("shows one silent notification per edge (#524 §6)", () => {
    const fake = recorder();
    const notifier = createNotifier({ Notification: fake.Notification, open: () => {} });

    notifier.show({ alert: alert(), arm: "relay", ...SHOWING });

    expect(fake.shown).toEqual([
      {
        title: "acme-site",
        body: "dark (no heartbeat for 5 min)",
        tag: "ff00:dark",
        silent: true,
      },
    ]);
  });

  test("shows nothing when the rules say nothing, and constructs nothing either", () => {
    const fake = recorder();
    const notifier = createNotifier({ Notification: fake.Notification, open: () => {} });

    const shown = notifier.show({ alert: alert(), arm: "relay", enabled: true, focused: true });

    expect(shown).toBeNull();
    expect(fake.shown).toEqual([]);
  });

  test("a click hands the whole banner back, subject and all", () => {
    const fake = recorder();
    const opened: Notifiable[] = [];
    const notifier = createNotifier({
      Notification: fake.Notification,
      open: (notifiable) => opened.push(notifiable),
    });
    notifier.show({ alert: alert(), arm: "relay", ...SHOWING });

    fake.click(0);

    expect(opened).toHaveLength(1);
    expect(opened[0]!.subject).toEqual({ arm: "relay", fingerprint: "ff00" });
  });
});
