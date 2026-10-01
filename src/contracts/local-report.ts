// What the **local read loop** hands the console (#527 §5, §6, #556).
//
// A remote deployment's report reaches a page over the relay's SSE stream as a
// `report` event. A local install has no relay, no listener and no socket — the
// container is a process on this machine — so main reads the report out of it
// directly and emits the same word with the same payload underneath. That is
// the whole point of this file: the tabs render a report, and nothing in them
// asks which arm it arrived over.
//
// Two things differ, and both are identity rather than content. A remote
// deployment is named by its key fingerprint, because that is the only name the
// relay has for it; a local install is named by its directory, which is the
// local arm's identity everywhere else (#527 §12). And a local event carries the
// directory's own facts beside the report, because a stopped install has no
// report at all and still has a page to draw (#526).

import type { AlertMessage } from "./alerts.ts";
import type { LocalInstall } from "./local-install.ts";

/**
 * One report as a reader holds it: everything it needs to decide whether it can
 * read the body, and nothing about where it came from.
 */
export type StoredReport = {
  /** The report's own `schema`, hoisted so a reader can branch before it parses. */
  schema: number;
  /** When the reader took delivery, ISO 8601. */
  receivedAt: string;
  /** `state/deployment.json`, exactly as the deployment wrote it. */
  report: unknown;
};

/**
 * What main can learn about an install without a container to ask (#527 §6,
 * #508 §4). Re-read on every emission, never stored, for the same reason the
 * install's state is: a file edited in a terminal is edited behind the window's
 * back.
 *
 * The deployment's **arm** is not here. Whether a config declares a workspace is
 * a fact about the evaluated config, and evaluating `phoebe.config.ts` needs the
 * deployment's own Node and its own dependencies — which is the container, which
 * is the report. A regex over the file would be a guess wearing a fact's
 * clothes.
 */
export type InstallDirectoryFacts = {
  /** Absolute path to the root config, whether or not it is there. */
  configPath: string;
  /** The config file's text, or null when there is none to read. */
  configText: string | null;
  /**
   * A digest of that text. The handle a later edit checks against before it
   * writes (#503), and the one thing on this type that is cheap to compare.
   */
  configFingerprint: string | null;
  /**
   * The settings a form can offer, each with what the file says about it. Empty
   * for a config that will not parse; absent from a companion older than the
   * field.
   */
  configFields?: ConfigFieldFacts[];
  /** Is there a root `.env` beside the config? Its contents are never read here. */
  envPresent: boolean;
  /**
   * Is the bootstrapper running? The fact #508 §4 names, and the reason four of
   * the five tabs have nothing to draw when it is false.
   */
  bootstrapperRunning: boolean;
  /**
   * On a workspace, each child's own config, read the same way as the root's
   * (#503 keeps tenant configs the operator's; a companion on the same disk
   * is the operator's hand). Absent on a solo install and from a companion
   * older than the field.
   */
  tenants?: TenantConfigFacts[];
};

/**
 * One setting as a config file holds it, read off the source and never by
 * loading it. The settings are the catalogue's (src/settings-catalogue.ts), the
 * ones a file can carry and `config set` will write.
 */
export type ConfigFieldFacts = {
  /** The config path, which is also what a `config set` names. */
  path: string;
  /**
   * Whose setting it is: the deployment's, read off the root config alone, or a
   * tenant's. A workspace root carries the first kind and its children the
   * second; a solo install's one config carries both.
   */
  scope: "deployment" | "tenant";
  /** The env name that outranks the file at this path, where there is one. */
  env?: string;
  /** Why this row is shown and not offered for change, when it is not. */
  locked?: string;
  /**
   * The verb that changes this row, when it is not `config set`. The engine's
   * ref moves with `upgrade`, which runs the new ref's migrations with it.
   */
  via?: "upgrade";
  type: "string" | "number" | "integer" | "boolean" | "enum";
  /** The closed set of accepted values, for an `enum`. */
  values?: readonly string[];
  /**
   * Values worth offering for a `string`, none of them binding: the box takes
   * whatever is typed, and these are what it offers first.
   */
  suggestions?: readonly string[];
  /**
   * What the file says: nothing, a plain literal a form can show and replace,
   * or something computed, which is shown as written and left alone.
   */
  state: "unset" | "set" | "computed";
  /** The literal, when `state` is `set`. */
  value?: string | number | boolean | null;
  /** The source text, when `state` is `computed`. */
  raw?: string;
  /** What applies when the file says nothing, where there is a default. */
  default?: string | number | boolean;
};

/** One workspace child's config, as its folder holds it. */
export type TenantConfigFacts = {
  /** The child's folder, the key a `config set` on it names as `tenant`. */
  dir: string;
  /** The folder's name. */
  name: string;
  /** The config's `repoSlug`, when it states one. */
  slug: string | null;
  configPath: string;
  configText: string | null;
  configFingerprint: string | null;
  /** The child's settings, read the same way as the root's. */
  configFields?: ConfigFieldFacts[];
};

/**
 * One local read, finished. Emitted by the loop on every Docker lifecycle event,
 * every 15 s while the container is up, and on every `refresh`.
 *
 * `report` is null whenever there was nothing running to read one from, and the
 * `reason` beside it says which flavour of nothing it was. A page never renders
 * a report it was handed for an install that is no longer running (#526): the
 * facts on this event are the current ones, the report is as old as its
 * `receivedAt`, and the two disagreeing is exactly what a stale render looks
 * like.
 */
export type LocalReportEvent = {
  type: "report";
  /** The install's directory — the local arm's identity (#527 §12). */
  install: string;
  /** When main finished the read, ISO 8601. */
  at: string;
  /** The install as it stood at that moment. */
  facts: LocalInstall;
  /** What the folder says, container or no container. */
  directory: InstallDirectoryFacts;
  /** The report the container printed, or null. */
  report: StoredReport | null;
  /** Why there is no report, when there is none. */
  reason?: string;
};

/**
 * An alert the companion raised over a **local install** (#524 §3, #559).
 *
 * The same shape as the relay's `alert` event and for the same reason the
 * report events match: the window subscribes to one arm or the other and does
 * the same thing with what arrives. Only three conditions can appear here —
 * `wedged`, `crash-looping` and `doctor-fail` — because `dark` and `replaced`
 * are a relay's readings of a socket, and there is no socket between a folder on
 * this machine and the process watching it.
 *
 * The body's `deployment.keyFingerprint` is the install's directory, which is
 * the local arm's identity everywhere else, and its `name` is the install's.
 */
export type LocalAlertEvent = {
  type: "alert";
  /** The install's directory — the local arm's identity (#527 §12). */
  install: string;
  /** When main decided the edge had been crossed, ISO 8601. */
  at: string;
  alert: AlertMessage;
};
