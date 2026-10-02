// Turning an alert into an OS notification (#524 §2, §5, §6, map #497).
//
// The alert is decided elsewhere and arrives here finished: the relay ran the
// edge rule over the links it holds, or the companion's main process ran the
// same rule over a local install's report. Nothing in this file decides whether
// something is wrong. What it decides is whether to interrupt, and what the
// banner says.
//
// **A clear replaces its raise in place** (#524 §5). Every notification carries
// the tag `<deployment or install>:<condition>`, so the OS folds the pair: at
// most one banner per (deployment, condition) is on screen, the clear overwrites
// the raise, and an overnight dark that recovered is still there in the morning
// saying it recovered. That is also why the tag leaves the pipeline out — the
// alert's own key has it, and folding three wedged pipelines into one line is
// what keeps a bad afternoon from being twenty banners.
//
// **Three manners, all decided** (#524 §6). Silent, because a sound is a
// second interruption nobody asked for. Suppressed while the window is focused,
// because the page already says it. And clickable, which is the device's answer
// to the webhook's `url`.
//
// **Nothing is replayed** (#524 §7). A reconnect delivers no backlog, so this
// never sees one, and there is nothing here that would catch up if it did.

import type { AlertBody } from "phoebe-agent/contracts";

/** Which arm an alert came in on, and therefore which page a click opens. */
export type AlertSubject =
  | { arm: "relay"; fingerprint: string }
  /** A local install, named by its directory (#527 §12). */
  | { arm: "local"; install: string };

/** One banner, ready for whatever is going to show it. */
export type Notifiable = {
  /** What the OS folds on (#524 §5). */
  tag: string;
  title: string;
  body: string;
  /** Where a click goes, or null for the test alert, which is about no one. */
  subject: AlertSubject | null;
  /** Set on `wedged` and `crash-looping`: the tab a click should land on. */
  pipeline: string | null;
};

/**
 * What to show for one alert, or null when nothing should be. Pure, so the two
 * suppressions are a thing a test can state rather than a thing a browser has
 * to be put in the right mood to demonstrate.
 */
export function notificationFor(input: {
  alert: AlertBody;
  arm: AlertSubject["arm"];
  /** The operator's "desktop notifications" preference (#524 §8). */
  enabled: boolean;
  /** Is the companion's window focused? If so, say nothing (#524 §6). */
  focused: boolean;
}): Notifiable | null {
  if (!input.enabled || input.focused) return null;
  const { alert } = input;
  if (alert.kind === "test") {
    return { tag: "test", title: "Phoebe relay", body: alert.text, subject: null, pipeline: null };
  }
  const name = alert.deployment.name;
  const id = alert.deployment.keyFingerprint;
  return {
    tag: `${id}:${alert.condition}`,
    title: name,
    // The name is the title, so the sentence drops the prefix it carries for a
    // webhook, where there is nowhere else to put it. Sliced rather than rebuilt
    // because the sentence is the alert's, not this file's (#515 §9).
    body: withoutPrefix(alert.text, `${name}: `),
    subject:
      input.arm === "relay" ? { arm: "relay", fingerprint: id } : { arm: "local", install: id },
    pipeline: alert.pipeline ?? null,
  };
}

/**
 * As much of the web `Notification` API as this module touches. Structural
 * rather than the DOM's own type so a test needs no browser — and `onclick`
 * takes the event the DOM would pass, because the real constructor's handler
 * does and a narrower signature would not accept it.
 */
export type NotificationLike = new (
  title: string,
  init: { body: string; tag: string; silent: boolean },
) => { onclick: ((event: Event) => unknown) | null };

export type NotifierOptions = {
  /** The constructor, injected so a test needs no OS and no permission. */
  Notification: NotificationLike;
  /** Bring the window forward and open the subject's page (#524 §6). */
  open: (notifiable: Notifiable) => void;
};

export type Notifier = {
  /** Show one alert, if it should be shown. Returns what was shown, or null. */
  show: (input: {
    alert: AlertBody;
    arm: AlertSubject["arm"];
    enabled: boolean;
    focused: boolean;
  }) => Notifiable | null;
};

/**
 * The raise path. One `new Notification` per edge, tagged so the OS folds it
 * onto whatever it is replacing, and silent — every time, not only for a clear.
 */
export function createNotifier(options: NotifierOptions): Notifier {
  return {
    show(input) {
      const notifiable = notificationFor(input);
      if (notifiable === null) return null;
      const notification = new options.Notification(notifiable.title, {
        body: notifiable.body,
        tag: notifiable.tag,
        silent: true,
      });
      notification.onclick = () => options.open(notifiable);
      return notifiable;
    },
  };
}

function withoutPrefix(text: string, prefix: string): string {
  return text.startsWith(prefix) ? text.slice(prefix.length) : text;
}
