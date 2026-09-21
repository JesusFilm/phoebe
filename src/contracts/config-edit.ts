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

/**
 * The blocks no config edit may reach, and the sentence each refusal says.
 * Matched on a path's first segment, so a block and everything under it go
 * together.
 *
 * It is here rather than beside the writer because two processes read it and
 * only one of them refuses: the deployment decides (src/config-edit.ts), and a
 * console reads the same table to know which leaves to offer an edit on at all.
 * A console that guessed would either offer a write the deployment refuses or
 * hide one it would have taken.
 *
 * Most entries are things that are *somebody else's* to change rather than
 * things that are dangerous to write: a fleet declaration (git), an engine pin
 * (`phoebe upgrade`, so its migrations run), the host's own lifecycle, a
 * pairing the relay owns. The last two are different — `paths` and top-level
 * `workKinds` are places where a write would land and then be ignored, which is
 * the one outcome a refusal is plainly better than.
 */
export const CLOSED_EDIT_BLOCKS: readonly { prefix: string; why: string }[] = [
  {
    prefix: "workspace",
    why: "the fleet declaration is yours — adding, removing or reordering tenants is a git edit, never a console one",
  },
  {
    prefix: "engine",
    why: "`engine.ref` picks which engine runs and moves with `phoebe upgrade`, so the migrations for the new ref run with it",
  },
  {
    prefix: "relay",
    why: "the relay block is the pairing's own, written when a deployment is paired rather than edited field by field",
  },
  {
    prefix: "deployment",
    why: "the `deployment` block holds the host's lifecycle commands, which run outside the container and are not the container's to rewrite",
  },
  {
    prefix: "paths",
    why: "`paths` is derived from `repoSlug` and the data volume; nothing at that path is read from the file",
  },
  {
    prefix: "workKinds",
    why: "top-level `workKinds` is the permanent alias for `pipelines.work.kinds` — set it at the path the effective config prints",
  },
] as const;
