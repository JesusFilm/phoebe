// The **config edit** — one field patch to a deployment's root config, and the
// **edit receipt** the deployment answers with (#503; map #497).
//
// A console never sends a file. It sends `{ path, value }` against a fingerprint
// it was shown, and the deployment either writes that one leaf in place or
// refuses and says exactly what to type by hand. That asymmetry is the whole
// design: the operator's repository stays the source of truth, and the console
// is a way of moving one literal in it, not a second author of the file.
//
// Both shapes are here rather than beside the writer because three processes
// name them — the bootstrapper that applies the edit, the relay that carries it,
// and the console that renders what came back.

/**
 * One field patch. `path` is a dotted path into the config object, the same path
 * a leaf of the effective-config tree carries, so what a console shows is what
 * it can ask to change.
 *
 * `fingerprint` is the optimistic-concurrency check: the `sha256:` of the file
 * the caller was shown, straight out of the report's config section. It is
 * required, not optional — an edit with no fingerprint is an edit made blind,
 * and there is no merge here to recover from one.
 */
export type ConfigEdit = {
  /** Caller-chosen id. The same id twice is the same edit, answered identically. */
  id: string;
  path: string;
  /** The new value. A leaf is a literal; nothing here carries an object or a function. */
  value: string | number | boolean | null;
  /** The `sha256:<hex>` the caller read, from the report's config section. */
  fingerprint: string;
  /** The allowlisted email the relay stamped on the edit; absent for a shell run. */
  by?: string;
};

/**
 * Why an edit was refused. Each name is a different thing for an operator to do,
 * which is the only reason to have more than one of them:
 *
 *   - `stale`         the file moved since it was read — reload and look again.
 *   - `not-editable`  nothing is wrong with the file; this leaf is not the
 *                     console's to write. The instruction says where it is.
 *   - `not-literal`   the leaf exists but is not a plain literal (a call, a
 *                     template, an inline definition), so a splice cannot see
 *                     what it would be overwriting.
 *   - `invalid`       the patched config does not load. The disk is untouched.
 *   - `unreadable`    the config could not be read at all.
 *   - `unwritable`    the write itself failed — most often the `:ro` mount.
 */
export type EditRefusalReason =
  | "stale"
  | "not-editable"
  | "not-literal"
  | "invalid"
  | "unreadable"
  | "unwritable";

/** The edit landed: the file now holds `value` at `path`. */
export type EditWritten = {
  id: string;
  state: "written";
  /** The file that was written. */
  file: string;
  path: string;
  value: string | number | boolean | null;
  /** The `sha256:<hex>` of the file as the writer left it — the next edit's check. */
  fingerprint: string;
  at: string;
  by?: string;
};

/** The edit did not land, and the disk is exactly as it was. */
export type EditRefused = {
  id: string;
  state: "refused";
  file: string;
  path: string;
  reason: EditRefusalReason;
  /** One sentence naming why, in the operator's terms. */
  why: string;
  /**
   * The exact manual edit, always. Every refusal is "console proposes, operator
   * applies" — a refusal with no instruction would leave the operator to work
   * out from a reason code what the console already knew.
   */
  instruction: string;
  at: string;
  by?: string;
};

/**
 * The deployment's answer to a config edit. It ends here: `written` or
 * `refused`, with no pending arm and nothing to poll. Whether the reconcile that
 * a write set going has finished is the deployment report's news, not this
 * object's — `reconcile.lastEditId` ties the two together.
 */
export type EditReceipt = EditWritten | EditRefused;
