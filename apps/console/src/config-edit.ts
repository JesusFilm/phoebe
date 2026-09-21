// Editing one config leaf from the console, as arithmetic over a report (#503,
// #547).
//
// The deployment is the authority on every edit. It holds the pen, it validates
// the patch against the loader it is actually running, and its refusal is the
// answer — with the exact manual edit attached. Nothing here overrules any of
// that. What this module decides is narrower and comes first: **which leaves get
// an edit affordance at all, and what the other ones say instead.**
//
// That question has to be answered here because a console cannot ask. There is
// no "is this editable" call on the rail, and inventing one would mean a round
// trip per row on a page with three hundred of them. So the console reads the
// same closed table the deployment refuses from — `CLOSED_EDIT_BLOCKS` in
// contracts, one table and two readers — plus the three facts the report already
// carries about a leaf: which file it came from, whether env decided it, and
// whether its value survives JSON.
//
// Where the two could still disagree, they disagree in the safe direction: a
// leaf this module offers and the deployment refuses ends in a refusal with an
// instruction, which is a screen an operator can act on. The reverse — hiding an
// edit the deployment would have taken — is the one that leaves somebody
// wondering, so nothing here guesses a refusal the table does not name.
//
// **One file is editable, and it is the root config.** Only `phoebe.config.ts`
// at the deployment root is bind-mounted read-write (#503), so a tenant's own
// config in a workspace is the operator's to edit in its own checkout. Rows say
// which they are by their `configPath`, and the tenant rows get the shell
// command for that file rather than a form that would be refused.

import { CLOSED_EDIT_BLOCKS } from "phoebe-agent/contracts";
import type {
  ConfigReport,
  DeploymentReport,
  EffectiveLeaf,
  EditReceipt,
} from "phoebe-agent/contracts";
import { reconcileOf } from "./report.ts";

/** A literal — everything a leaf may be set to. Not an object, and never a function. */
export type EditableValue = string | number | boolean | null;

/**
 * Whether the console may offer an edit on one leaf, and why not when it may
 * not. `why` is a sentence for the operator, not a reason code: the row it
 * lands in has no room for a legend.
 */
export type LeafEditability =
  | { editable: true }
  | {
      editable: false;
      why: string;
      /**
       * The file the operator would edit by hand, when it is known and is not
       * the one the console can write. What turns "not here" into "there".
       */
      file?: string;
    };

/**
 * May this leaf be edited from the console?
 *
 * The order is the order the refusals stop being about the console and start
 * being about the config: the file first (a tenant config is nobody's to write
 * from here, whatever the path says), then the closed blocks, then the leaf's
 * own value.
 */
export function leafEditability(opts: {
  path: string;
  leaf: EffectiveLeaf;
  /** The file this row's settings were read from, when the report names it. */
  configPath: string | undefined;
  /** The root config — the one file a console may ask a deployment to change. */
  root: ConfigReport["root"];
}): LeafEditability {
  if (opts.configPath === undefined) {
    return {
      editable: false,
      why:
        "this deployment does not name the file behind this row, so there is nothing to " +
        "address an edit to — its bootstrapper is older than the field that says",
    };
  }
  if (opts.configPath !== opts.root.path) {
    return {
      editable: false,
      file: opts.configPath,
      why:
        "this is a tenant's own config, and it lives in that tenant's checkout — the console " +
        "writes the deployment's root config and nothing else",
    };
  }
  if (opts.root.fingerprint === null) {
    return {
      editable: false,
      file: opts.root.path,
      why: "the deployment could not read its root config, so it will refuse every edit",
    };
  }
  const segments = opts.path.split(".");
  const closed = CLOSED_EDIT_BLOCKS.find((block) => block.prefix === segments[0]);
  if (closed !== undefined) return { editable: false, file: opts.root.path, why: closed.why };
  // A work kind's declaration is a module reference or an inline definition —
  // code either way, and opaque to a splice. Its settings are literals, so the
  // block is open exactly one level down.
  const kinds = segments.lastIndexOf("kinds");
  if (kinds !== -1 && segments.length !== kinds + 3) {
    return {
      editable: false,
      file: opts.root.path,
      why: "a work kind's declaration is code, not a literal — only the settings inside it can be set",
    };
  }
  if (opts.leaf.opaque === true) {
    return {
      editable: false,
      file: opts.root.path,
      why: "this value does not survive JSON — it is code, and a splice cannot see what it would replace",
    };
  }
  // `from` is set only on an env-sourced value (effective-config.ts), which
  // makes it the one test that catches both a `PHOEBE_*` overlay and an env
  // alias. Env beats file at a path, so a write here would land and go on being
  // ignored — the one outcome plainly worse than a refusal.
  if (opts.leaf.from !== undefined) {
    return {
      editable: false,
      file: opts.root.path,
      why: `\`${opts.leaf.via ?? "an environment variable"}\` sets this in the deployment's environment, and env beats file — a value written here would be shadowed`,
    };
  }
  return { editable: true };
}

/**
 * The dotted path as config source: `a.b.c` and `1` become `a: { b: { c: 1 } }`
 * — the nesting an operator retypes, not the path a console showed them. Keys
 * are quoted when they are not legal identifiers, which a work kind's name may
 * not be (`my-kind`).
 *
 * The deployment composes the same sentence for the refusals it authors
 * (`instructionFor` in src/config-edit.ts), and the console shows that one
 * whenever there is one. This exists for the case where there is not: an edit
 * the relay never delivered has no receipt, and "we could not reach it" without
 * the edit to make by hand is half an answer.
 */
export function manualEdit(opts: { file: string; path: string; value: EditableValue }): string {
  const key = (name: string): string =>
    /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
  const segments = opts.path.split(".");
  const source = segments
    .slice(0, -1)
    .reduceRight(
      (inner, name) => `${key(name)}: { ${inner} }`,
      `${key(segments.at(-1)!)}: ${JSON.stringify(opts.value)}`,
    );
  return `In ${opts.file}, write \`${source}\` by hand.`;
}

/**
 * The `phoebe config set` line for this edit, to run in the deployment's own
 * shell. Every refusal carries one beside the manual edit (#503): the verb is
 * the same code the console's patch would have run, so an operator with a
 * terminal is one paste away from the change the console could not make.
 *
 * `--config` is written out even for the root config, because the command is
 * copied into a shell whose working directory nobody here knows.
 */
export function configSetCommand(opts: {
  file: string;
  path: string;
  value: EditableValue;
}): string {
  return `phoebe config set ${opts.path} ${shellArg(JSON.stringify(opts.value))} --config ${shellArg(opts.file)}`;
}

/** One argument, quoted when a shell would otherwise read it as more than one. */
function shellArg(text: string): string {
  return /^[A-Za-z0-9_./:@-]+$/.test(text) ? text : `'${text.replaceAll("'", `'\\''`)}'`;
}

/**
 * Where a written edit has got to, read off the deployment's own report (#503
 * "Outcome").
 *
 * The receipt ends at `written`; what the deployment did next is the report's
 * news, and this is the reading of it. One reconcile path means there is nothing
 * else to watch: the write nudged the same loop the stat poll nudges, so the
 * deployment drains onto the new config and comes back idle with `lastEditId`
 * naming the edit that caused it.
 *
 *  - `reconciling` — the fleet is draining onto the new config.
 *  - `settled` — idle, and `lastEditId` is this edit. The leaf below it now
 *    reads `file` with the new value, which is the proof it took.
 *  - `waiting` — the report has not caught up yet. A push is on its way or the
 *    deployment is between reports; either way the answer is "not yet", never
 *    "it did not work".
 */
export type EditProgress = "reconciling" | "settled" | "waiting";

export function editProgress(editId: string, report: DeploymentReport | null): EditProgress {
  const reconcile = report === null ? null : reconcileOf(report);
  if (reconcile === null) return "waiting";
  if (reconcile.phase === "reconciling") return "reconciling";
  return reconcile.lastEditId === editId ? "settled" : "waiting";
}

/** The receipt's own word, or the relay's — what the console is holding. */
export type EditAnswer =
  | { kind: "written"; receipt: EditReceipt & { state: "written" } }
  | { kind: "refused"; receipt: EditReceipt & { state: "refused" } }
  | {
      /** The relay never got it there: no receipt exists, and none is coming. */
      kind: "undelivered";
    }
  | {
      /** A word neither this console nor its relay knows. Quoted, not guessed at. */
      kind: "unknown";
      outcome: string;
    };

/**
 * One relay answer, narrowed. The body came over HTTP from a relay carrying a
 * deployment's bytes, so nothing in it is trusted: a receipt that does not have
 * the two fields every arm of it carries is read as the word alone.
 */
export function readEditAnswer(answer: { outcome: string; receipt?: unknown }): EditAnswer {
  if (answer.outcome === "undelivered") return { kind: "undelivered" };
  const receipt = answer.receipt;
  const state = isRecord(receipt) ? receipt["state"] : undefined;
  if (state === "written" && typeof receipt === "object") {
    return { kind: "written", receipt: receipt as EditReceipt & { state: "written" } };
  }
  if (state === "refused" && typeof receipt === "object") {
    return { kind: "refused", receipt: receipt as EditReceipt & { state: "refused" } };
  }
  return { kind: "unknown", outcome: answer.outcome };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The value an operator typed, as the literal the wire carries. JSON when it
 * parses as JSON, a plain string otherwise — the same reading `phoebe config
 * set` gives an argv value (src/config-set.ts), so a console and a shell cannot
 * disagree about what `42` means.
 *
 * An object or an array parses as JSON and is still not a literal, so it is
 * refused here rather than sent: a leaf holds a literal, and the far end would
 * have nowhere to put one.
 */
export function readTypedValue(text: string): { ok: true; value: EditableValue } | { ok: false } {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: true, value: "" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { ok: true, value: text };
  }
  if (parsed === null || ["string", "number", "boolean"].includes(typeof parsed)) {
    return { ok: true, value: parsed as EditableValue };
  }
  return { ok: false };
}

/**
 * What the panel under an edited row says, for every one of the four answers.
 *
 * The sentences live here and not in the component for the reason every
 * derivation in this console does, plus one: a receipt is the only screen in
 * the console an operator reads *after* something changed on a machine they
 * cannot see, and each arm of it has to be worth reading on its own. A test
 * over strings is how that stays true.
 *
 * `lead` is the outcome in a sentence. `detail` is the exact manual edit — the
 * deployment's own words when it wrote them, this console's when the deployment
 * never got the ask. `command` is the `phoebe config set` line, on every arm
 * where making the change by hand is the way forward, which is every refusal
 * (#503 "Fallback is console proposes, operator applies").
 */
export type EditPanel = {
  tone: "good" | "bad";
  lead: string;
  detail?: string;
  command?: string;
};

export function editPanel(opts: {
  answer: EditAnswer;
  /** The literal that was sent. A refusal does not carry one; this side does. */
  value: EditableValue;
  path: string;
  /** The root config, for the arms with no receipt to name a file. */
  root: ConfigReport["root"];
  /** The report as it stands, for following a write into its reconcile. */
  report: DeploymentReport;
  /** The edit's id, which is what `reconcile.lastEditId` is matched against. */
  id: string;
}): EditPanel {
  const { answer } = opts;
  if (answer.kind === "written") {
    return {
      tone: "good",
      lead: `Written to ${answer.receipt.file}${answer.receipt.by === undefined ? "" : ` for ${answer.receipt.by}`}.`,
      detail: PROGRESS_LINE[editProgress(opts.id, opts.report)],
    };
  }
  if (answer.kind === "refused") {
    return {
      tone: "bad",
      lead: `Refused: ${answer.receipt.why}.`,
      // The deployment's own instruction, never a second one composed here: it
      // knows which file it refused about and this side is guessing.
      detail: answer.receipt.instruction,
      command: configSetCommand({
        file: answer.receipt.file,
        path: answer.receipt.path,
        value: opts.value,
      }),
    };
  }
  if (answer.kind === "undelivered") {
    return {
      tone: "bad",
      lead:
        "The relay never got this to the deployment, so nothing was written and nothing is " +
        "queued — re-issue it when the deployment is connected again.",
      detail: manualEdit({ file: opts.root.path, path: opts.path, value: opts.value }),
      command: configSetCommand({ file: opts.root.path, path: opts.path, value: opts.value }),
    };
  }
  return {
    tone: "bad",
    lead: `The answer was "${answer.outcome}", which this console does not know how to read.`,
    detail: manualEdit({ file: opts.root.path, path: opts.path, value: opts.value }),
    command: configSetCommand({ file: opts.root.path, path: opts.path, value: opts.value }),
  };
}

/** The three readings of a written edit's progress, as sentences (#503). */
const PROGRESS_LINE: Record<EditProgress, string> = {
  reconciling:
    "The deployment is draining its fleet onto the new config. Nothing is applied except through the file.",
  settled:
    "The deployment has reconciled onto this edit and is idle again. The leaf above now reads file, with the new value.",
  waiting:
    "Waiting for the deployment's next report. The write is on disk; what it does about it arrives the way every other fact does.",
};

/**
 * What a leaf the console may not write offers instead: the sentence, the manual
 * edit, and the command. One shape for every arm of the closed set, so no
 * refusal is a dead end (#503).
 */
export function fallbackPanel(opts: {
  editability: Extract<LeafEditability, { editable: false }>;
  path: string;
  value: EditableValue;
  root: ConfigReport["root"];
}): { why: string; detail: string; command: string } {
  const file = opts.editability.file ?? opts.root.path;
  return {
    why: opts.editability.why,
    detail: manualEdit({ file, path: opts.path, value: opts.value }),
    command: configSetCommand({ file, path: opts.path, value: opts.value }),
  };
}
