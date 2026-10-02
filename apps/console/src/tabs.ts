// The five tabs one deployment has, and which of them can say anything (#509,
// #526).
//
// Arm-neutral on purpose. A remote deployment's tabs are fed by the report the
// relay forwarded; a local install's by the report main read out of the
// container over the desktop bridge (#556). Neither of those facts is in this
// module, and neither is in the components that render against it — which is the
// whole point of the local read loop emitting the relay's own `report` event.
//
// What is here is the rule for when a tab has nothing: a deployment with no
// readable report has four empty tabs and one that still works, because config
// is the one thing that can be read off the disk with nothing running (#526).

/** In the order the tab strip draws them. */
export const DEPLOYMENT_TABS = ["overview", "pipelines", "doctor", "secrets", "config"] as const;

export type DeploymentTab = (typeof DEPLOYMENT_TABS)[number];

/**
 * What the overview's connection card says: which arm this deployment is reached
 * over, what names it there, and how the facts on the page got here.
 *
 * Three lines rather than one sentence, because an operator reading this is
 * usually answering one of the three questions and not the other two.
 */
export type ConnectionCard = {
  /** The arm, in the operator's words: a local install, or a relay. */
  arm: string;
  /** What identifies it — a path on this machine, a fingerprint on a relay. */
  detail: string;
  /** How these facts arrived. */
  note: string;
};

/** The config as the page can show it, from wherever this arm reads one. */
export type ConfigReading =
  | { kind: "file"; path: string; text: string; fingerprint: string }
  | { kind: "absent"; path: string };

/**
 * Can this tab say anything right now?
 *
 * Four of the five render a report and are empty without one. Config is not:
 * it is a file, and a stopped install's config is as true as a running one's.
 */
export function tabHasContent(
  tab: DeploymentTab,
  opts: { report: boolean; config: boolean },
): boolean {
  return tab === "config" ? opts.config : opts.report;
}
