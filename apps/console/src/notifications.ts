// Turning an alert into an OS notification (#524 §2, §5, §6, map #497).
//
// The alert is decided elsewhere and arrives here finished: the relay ran the
// edge rule over the links it holds, or the companion's main process ran the
// same rule over a local install's report. Nothing in this file decides whether
// something is wrong. What it decides is whether to interrupt, and what the
// banner says.
//
// **A clear replaces its raise in place** (#524 §5). Every notification carries
// a tag the OS folds on, so the clear overwrites the raise and an overnight
// dark that recovered is still there in the morning saying it recovered.
//
// **The tag is per route** (map #690, the owner's call in #699):
// `<route>/<deployment>/<pipeline>:<condition>`, where the route is `local`
// for a folder on this machine and `remote` for a paired record. A deployment
// reachable two ways is evaluated on each, so a wedge counts twice on the
// badge and notifies twice while both routes see it.
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
  /** A paired record, named by its deployment id (map #690). */
  | { arm: "remote"; deploymentId: string }
  /** A local install, named by its directory (#527 §12). */
  | { arm: "local"; install: string };

/** The tag one route's alert folds on. */
export function alertTag(input: {
  arm: AlertSubject["arm"];
  id: string;
  pipeline: string | null;
  condition: string;
}): string {
  const pipeline = input.pipeline === null ? "" : `/${input.pipeline}`;
  return `${input.arm}/${input.id}${pipeline}:${input.condition}`;
}

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
    return { tag: "test", title: "Phoebe", body: alert.text, subject: null, pipeline: null };
  }
  const name = alert.deployment.name;
  // The local arm names an install by its directory, the remote arm a record
  // by its deployment id; both ride in the body's `keyFingerprint` slot.
  const id = alert.deployment.keyFingerprint;
  const pipeline = alert.pipeline ?? null;
  return {
    tag: alertTag({ arm: input.arm, id, pipeline, condition: alert.condition }),
    title: name,
    // The name is the title, so the sentence drops the prefix it carries for a
    // webhook, where there is nowhere else to put it. Sliced rather than rebuilt
    // because the sentence is the alert's, not this file's (#515 §9).
    body: withoutPrefix(alert.text, `${name}: `),
    subject:
      input.arm === "remote" ? { arm: "remote", deploymentId: id } : { arm: "local", install: id },
    pipeline,
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
  /**
   * Show a banner that is already made, with the same two suppressions. For
   * what is not an alert and so has no edge rule behind it: updates on offer.
   */
  raise: (notifiable: Notifiable, manner: { enabled: boolean; focused: boolean }) => boolean;
};

/**
 * The raise path. One `new Notification` per edge, tagged so the OS folds it
 * onto whatever it is replacing, and silent — every time, not only for a clear.
 */
export function createNotifier(options: NotifierOptions): Notifier {
  const banner = (notifiable: Notifiable): void => {
    const notification = new options.Notification(notifiable.title, {
      body: notifiable.body,
      tag: notifiable.tag,
      silent: true,
    });
    notification.onclick = () => options.open(notifiable);
  };
  return {
    show(input) {
      const notifiable = notificationFor(input);
      if (notifiable === null) return null;
      banner(notifiable);
      return notifiable;
    },
    raise(notifiable, manner) {
      if (!manner.enabled || manner.focused) return false;
      banner(notifiable);
      return true;
    },
  };
}

function withoutPrefix(text: string, prefix: string): string {
  return text.startsWith(prefix) ? text.slice(prefix.length) : text;
}
