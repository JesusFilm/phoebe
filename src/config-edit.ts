// The config-edit writer (#536; decision #503) — how `{ path, value }` becomes
// one changed literal in the root `phoebe.config.ts`, or a refusal that says
// exactly what to type instead.
//
// The deployment directory is bind-mounted `:ro`; the root config alone is
// mounted read-write (templates/container/compose.yml). So this module writes
// one file, in place on the same inode, and never creates, renames or deletes
// anything beside it. Every other config in a workspace is the operator's, and
// a refusal names the checkout to edit rather than reaching into it.
//
// Four rules shape the code below.
//
// **The splice is the mechanism.** The patch goes through
// {@link editConfigSetFieldAt}, which replaces one node's bytes and leaves every
// other byte — comments, formatting, the order of the keys — exactly as the
// operator wrote them. Nothing here formats, prints, or round-trips a config.
//
// **Refusals are decided from the file and the environment, never from a
// resolved config.** A writer that needed a config to resolve before it could
// say whether a leaf was editable could never fix the config that broke. So the
// closed set below is a path table plus the settings catalogue, both of which
// answer for a workspace root and for a file that will not load.
//
// **Every refusal carries the manual edit.** The console proposes and the
// operator applies; a refusal with a reason code and no instruction just moves
// the puzzle. {@link instructionFor} builds one for every arm.
//
// **The ledger is the idempotency key, not an audit log.** `state/config-edits.json`
// holds the edits this writer applied and the fingerprint it left behind. A
// redelivered id returns the original receipt; an operator's own edit to the
// file rolls the whole list off, because from that point the writer's record of
// what it put there is no longer what the file says.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ConfigEdit, EditReceipt, EditRefusalReason } from "./contracts/config-edit.ts";
import { editConfigSetFieldAt } from "./config-handle.ts";
import { SETTINGS, envNames, kindEnvNames, type Setting } from "./settings-catalogue.ts";

/** How many applied edits the ledger keeps. Fixed size, like every state file (#73). */
export const MAX_LEDGER_ENTRIES = 50;

/** The ledger's filename inside the deployment-level `state/` directory. */
export const CONFIG_EDITS_FILE = "config-edits.json";

/** Where the edit ledger lives, given the data volume's mount point. */
export function configEditLedgerPath(dataBase: string): string {
  return join(dataBase, "state", CONFIG_EDITS_FILE);
}

/** One applied edit, as the ledger records it. */
export type EditLedgerEntry = {
  id: string;
  file: string;
  path: string;
  value: string | number | boolean | null;
  at: string;
  by?: string;
  /**
   * The file's fingerprint as the writer left it. The newest entry's value is
   * what says whether the list is still the writer's own account of the file:
   * once the file moves by another hand, every entry rolls off.
   */
  after: string;
};

export type EditLedger = { version: number; applied: EditLedgerEntry[] };

/** The ledger shape version — bumped when an older reader would misread a field. */
export const EDIT_LEDGER_VERSION = 1;

const EMPTY_LEDGER: EditLedger = { version: EDIT_LEDGER_VERSION, applied: [] };

/** `sha256:<hex>` over a file's text — the fingerprint the report publishes. */
export function fingerprintOf(source: string): string {
  return `sha256:${createHash("sha256").update(source).digest("hex")}`;
}

// --- what may be edited -----------------------------------------------------

/**
 * The blocks no edit may reach, and the sentence each refusal says. Matched on
 * the first segment, so a block and everything under it go together.
 *
 * Most entries are things that are *somebody else's* to change rather than
 * things that are dangerous to write: a fleet declaration (git), an engine pin
 * (`phoebe upgrade`, so its migrations run), the host's own lifecycle, a pairing
 * the relay owns. The last two are different — `paths` and top-level
 * `workKinds` are places where a write would land and then be ignored, which is
 * the one outcome a refusal is plainly better than.
 */
const CLOSED_BLOCKS: readonly { prefix: string; why: string }[] = [
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
];

/**
 * The catalogue entry addressed by a config path, tenant-level or per-kind.
 *
 * The per-kind arm asks two questions, because the catalogue answers per-kind
 * settings in two ways: a knob that exists at two depths carries a `kindField`
 * (`defaultProvider` / `provider`), while a knob that only ever existed per kind
 * is catalogued at its own dotted path (`kinds.issues.base`).
 */
function settingFor(segments: readonly string[]): { entry: Setting; kind?: string } | null {
  const direct = SETTINGS.find((entry) => entry.path === segments.join("."));
  if (direct !== undefined) return { entry: direct };
  const at = segments.lastIndexOf("kinds");
  if (at === -1 || segments.length !== at + 3) return null;
  const [kind, field] = [segments[at + 1]!, segments[at + 2]!];
  const entry =
    SETTINGS.find((candidate) => candidate.path === `kinds.${kind}.${field}`) ??
    SETTINGS.find((candidate) => candidate.kindField === field);
  return entry === undefined ? null : { entry, kind };
}

/** Every env name that would beat the file at this path, whatever its depth. */
function envNamesAt(segments: readonly string[]): readonly string[] {
  const found = settingFor(segments);
  if (found === null) return [];
  return found.kind === undefined
    ? envNames(found.entry)
    : [...kindEnvNames(found.entry, found.kind), ...envNames(found.entry)];
}

export type Editability = { ok: true } | { ok: false; reason: EditRefusalReason; why: string };

/**
 * May this path be written, and if not, why not? Read the refusals in the order
 * they are listed: a closed block is closed whatever the environment says, and a
 * leaf the environment already sets would take the write and then go on being
 * ignored, which is the one outcome worse than a refusal.
 */
export function editabilityOf(path: string, env: NodeJS.ProcessEnv): Editability {
  const refuse = (why: string): Editability => ({ ok: false, reason: "not-editable", why });
  if (path.trim() === "" || path.split(".").some((segment) => segment.trim() === "")) {
    return refuse(`"${path}" is not a config path`);
  }
  const segments = path.split(".");
  for (const block of CLOSED_BLOCKS) {
    if (segments[0] === block.prefix) return refuse(block.why);
  }
  // A work kind's declaration is a module reference or an inline definition —
  // code either way, and opaque to a splice. Its *settings* are literals, so the
  // block is open exactly one level down and only at a catalogued knob.
  const at = segments.lastIndexOf("kinds");
  if (at !== -1 && segments.length !== at + 3) {
    return refuse(
      "a work kind's declaration is code, not a literal — only the settings inside it can be set",
    );
  }
  const found = settingFor(segments);
  if (found?.entry.envOnly === true) {
    return refuse(
      `\`${path}\` has no field in the config file — \`${found.entry.env}\` is the only channel that sets it`,
    );
  }
  if (at !== -1 && found?.kind === undefined) {
    return refuse(`\`${segments[at + 2]!}\` is not a per-kind setting`);
  }
  for (const name of envNamesAt(segments)) {
    const value = env[name];
    if (value !== undefined && value !== "") {
      return refuse(
        `\`${name}\` is set in this deployment's environment, and env beats file — a value written here would be shadowed`,
      );
    }
  }
  return { ok: true };
}

// --- the instruction --------------------------------------------------------

/**
 * The dotted path as config source: `a.b.c` and `1` become `a: { b: { c: 1 } }`
 * — the nesting an operator retypes, not the path a console showed them. Keys
 * are quoted when they are not legal identifiers, which work-kind names may not
 * be (`my-kind`).
 */
function nestedSource(segments: readonly string[], value: string): string {
  const key = (name: string): string =>
    /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
  return segments
    .slice(0, -1)
    .reduceRight(
      (inner, name) => `${key(name)}: { ${inner} }`,
      `${key(segments.at(-1)!)}: ${value}`,
    );
}

/**
 * The exact manual edit, for every refusal. One sentence naming the file and the
 * literal to put in it, then the reason-specific tail — what to do *instead* of
 * retrying, which is the half a reason code cannot carry.
 */
export function instructionFor(opts: {
  file: string;
  path: string;
  value: string | number | boolean | null;
  reason: EditRefusalReason;
}): string {
  const literal = JSON.stringify(opts.value);
  const segments = opts.path.split(".");
  const edit = `In ${opts.file}, write \`${nestedSource(segments, literal)}\` by hand.`;
  switch (opts.reason) {
    case "stale":
      return `${edit} The file changed since you read it — reload it and look at the new value first.`;
    case "not-editable":
      return `${edit} Nothing here will apply it for you.`;
    case "not-literal":
      return `${edit} The value there now is computed, so replacing it is a judgement about the author's intent.`;
    case "invalid":
      return `${edit} The config does not load with that value, so check it against \`phoebe config\` before you do.`;
    case "unreadable":
      return `${edit} The deployment could not read the file at all — check the mount first.`;
    case "unwritable":
      return `${edit} The deployment could not write the file — check that it is mounted read-write.`;
  }
}

// --- the ledger -------------------------------------------------------------

/**
 * The ledger as it stands against the file's current fingerprint. Entries roll
 * off whole when the newest one no longer describes the file: the operator
 * edited or committed by hand, and from there the writer's list is history
 * rather than "edits not yet in a commit".
 */
export function liveLedger(raw: string | null, fingerprint: string): EditLedger {
  if (raw === null) return EMPTY_LEDGER;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return EMPTY_LEDGER;
  }
  const applied = (parsed as { applied?: unknown } | null)?.applied;
  if (!Array.isArray(applied) || applied.length === 0) return EMPTY_LEDGER;
  const entries = applied as EditLedgerEntry[];
  if (entries.at(-1)?.after !== fingerprint) return EMPTY_LEDGER;
  return { version: EDIT_LEDGER_VERSION, applied: entries };
}

/** The receipt a redelivered edit gets back: the original one, rebuilt from its entry. */
function receiptOf(entry: EditLedgerEntry): EditReceipt {
  return {
    id: entry.id,
    state: "written",
    file: entry.file,
    path: entry.path,
    value: entry.value,
    fingerprint: entry.after,
    at: entry.at,
    ...(entry.by !== undefined ? { by: entry.by } : {}),
  };
}

/** The newest applied edit's id, or null — what the report's reconcile section shows. */
export function lastEditIdOf(ledger: EditLedger): string | null {
  return ledger.applied.at(-1)?.id ?? null;
}

// --- the writer -------------------------------------------------------------

/** Whether a patched config loads, as the running engine's own loader answers. */
export type PatchValidator = (candidate: {
  /** The config source with the patch already spliced in. */
  source: string;
  path: string;
  value: string | number | boolean | null;
}) => Promise<{ ok: true } | { ok: false; reason: string }>;

export type ConfigEditDeps = {
  /** The one file this writer may touch — the root config's read-write mount. */
  file: string;
  /**
   * `<dataBase>/state/config-edits.json`, or null to keep no ledger.
   *
   * Null is the local arm's answer (#557). The ledger exists to answer a
   * *redelivered* edit with its original receipt, and redelivery is a property
   * of the relay: a message the deployment acknowledged after the socket closed
   * arrives again. The companion writing an install's config on this machine has
   * no socket to lose and no second delivery to answer, and the volume the
   * ledger would live on is inside the container it is not going through.
   */
  ledgerPath: string | null;
  validate: PatchValidator;
  /** The environment the deployment resolves settings against. */
  env?: NodeJS.ProcessEnv;
  readFile?: (path: string) => string;
  /** In place, on the same inode: a single-file bind mount does not survive a rename. */
  writeFile?: (path: string, content: string) => void;
  now?: () => number;
  /**
   * Break the reconcile poll's wait now, so the drain starts on the write rather
   * than up to an interval later. Absent for a writer in its own process — a
   * shell `phoebe config set` cannot reach the supervisor's loop, and the stat
   * poll picks the edit up exactly as it picks up a hand edit.
   */
  nudge?: () => void;
};

const readOrNull = (path: string, read: (path: string) => string): string | null => {
  try {
    return read(path);
  } catch {
    return null;
  }
};

/**
 * Apply one field patch to the root config, and answer with a receipt.
 *
 * The order of the checks is the order in which they stop costing something:
 * the ledger first (a redelivered edit does no work at all), then the
 * fingerprint, then the closed set, then the splice, and only then the engine's
 * loader — which is the one step that spawns a process. Nothing is written until
 * every one of them has passed, so a refused edit always leaves the disk exactly
 * as it was.
 */
export async function applyConfigEdit(
  edit: ConfigEdit,
  deps: ConfigEditDeps,
): Promise<EditReceipt> {
  const read = deps.readFile ?? ((path: string) => readFileSync(path, "utf8"));
  // In place, never through a temp file and a rename: the root config is a
  // single-file bind mount, and a rename would replace the inode the mount is
  // pinned to — the container would keep the old file and the host would keep
  // the new one.
  const write =
    deps.writeFile ?? ((path: string, content: string) => writeFileSync(path, content, "utf8"));
  const now = deps.now ?? Date.now;
  const env = deps.env ?? process.env;

  const refuse = (reason: EditRefusalReason, why: string): EditReceipt => ({
    id: edit.id,
    state: "refused",
    file: deps.file,
    path: edit.path,
    reason,
    why,
    instruction: instructionFor({
      file: deps.file,
      path: edit.path,
      value: edit.value,
      reason,
    }),
    at: new Date(now()).toISOString(),
    ...(edit.by !== undefined ? { by: edit.by } : {}),
  });

  const source = readOrNull(deps.file, read);
  if (source === null) return refuse("unreadable", `${deps.file} could not be read`);
  const fingerprint = fingerprintOf(source);

  const ledger =
    deps.ledgerPath === null
      ? EMPTY_LEDGER
      : liveLedger(readOrNull(deps.ledgerPath, read), fingerprint);
  const applied = ledger.applied.find((entry) => entry.id === edit.id);
  if (applied !== undefined) return receiptOf(applied);

  if (edit.fingerprint !== fingerprint) {
    return refuse(
      "stale",
      `the config changed since you loaded it (you sent ${edit.fingerprint}, the file is ${fingerprint})`,
    );
  }

  const editability = editabilityOf(edit.path, env);
  if (!editability.ok) return refuse(editability.reason, editability.why);

  const spliced = editConfigSetFieldAt(source, edit.path.split("."), edit.value);
  if (!spliced.ok) return refuse("not-literal", spliced.reason);

  const verdict = await deps.validate({
    source: spliced.content,
    path: edit.path,
    value: edit.value,
  });
  if (!verdict.ok) return refuse("invalid", verdict.reason);

  const after = fingerprintOf(spliced.content);
  const at = new Date(now()).toISOString();
  const entry: EditLedgerEntry = {
    id: edit.id,
    file: deps.file,
    path: edit.path,
    value: edit.value,
    at,
    ...(edit.by !== undefined ? { by: edit.by } : {}),
    after,
  };
  try {
    write(deps.file, spliced.content);
  } catch (error) {
    return refuse(
      "unwritable",
      `${deps.file} could not be written — ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  // The ledger follows the write, never leads it: a ledger entry for an edit
  // that did not land would answer a redelivery with a receipt for a value the
  // file does not hold. A ledger write that fails costs idempotency for one
  // edit, which is the cheaper of the two failures.
  const ledgerPath = deps.ledgerPath;
  if (ledgerPath !== null) {
    try {
      if (deps.writeFile === undefined) mkdirSync(dirname(ledgerPath), { recursive: true });
      write(
        ledgerPath,
        `${JSON.stringify(
          {
            version: EDIT_LEDGER_VERSION,
            applied: [...ledger.applied, entry].slice(-MAX_LEDGER_ENTRIES),
          },
          null,
          2,
        )}\n`,
      );
    } catch {
      /* c8 ignore next -- the write above is the edit; the ledger is bookkeeping */
    }
  }
  deps.nudge?.();
  return receiptOf(entry);
}
