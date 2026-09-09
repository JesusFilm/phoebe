// The one path that writes a Phoebe-owned label onto an issue (#484). GitHub
// rejects an `--add-label` for a label the repository has never seen, so every
// write here is add-then-heal: try the add, and when the failure says the label
// does not exist, create it with Phoebe's own colour and description and try
// once more. A repo that has never heard of `processingLabel` or `mergedLabel`
// therefore needs no setup — the first write that wants one makes it, and once
// it exists no later write creates anything.
//
// A tenant renames these labels, so a name cannot identify one here. The role
// does, and the role is what picks the description a human reads in the repo's
// label list: a landed member wearing "Phoebe is working this issue" would be
// a lie told by the engine that created it.

import { isLabelAlreadyExistsError, isLabelNotFoundError } from "./gh-error.ts";

/** A label Phoebe applies itself: the tenant's name for it, and what it means. */
export type PhoebeLabel = {
  name: string;
  /** Shown beside the label in GitHub's label list when Phoebe creates it. */
  description: string;
};

/** The GitHub surface {@link addLabelCreatingIfMissing} needs. */
export type LabelWriter = {
  addIssueLabel(issueNumber: number, label: string): void;
  createLabel(name: string, description: string): void;
};

/** The label an issue wears while a run owns it (#365). */
export function processingLabelOf(config: { processingLabel: string }): PhoebeLabel {
  return { name: config.processingLabel, description: "Phoebe is working this issue" };
}

/**
 * The label a **landed member** wears (#449): its own PR has merged into the
 * feature branch, and it waits on the integration PR rather than on Phoebe.
 */
export function mergedLabelOf(config: { mergedLabel: string }): PhoebeLabel {
  return {
    name: config.mergedLabel,
    description: "Phoebe merged this issue's PR into its feature branch — awaiting integration",
  };
}

/**
 * Add `label` to `issueNumber`, creating the label in the repository when it is
 * not there yet.
 *
 * The create is reached only through a "Label not found" failure, so it happens
 * at most once per label per repository: the second call finds the label and
 * the add succeeds outright. Any other failure propagates unchanged — a 403 on
 * the add is not something a `gh label create` heals, and swallowing it would
 * hand the caller a claim it does not have. A failing retry propagates too.
 */
export function addLabelCreatingIfMissing(
  github: LabelWriter,
  issueNumber: number,
  label: PhoebeLabel,
  log: (line: string) => void,
): void {
  try {
    github.addIssueLabel(issueNumber, label.name);
  } catch (err) {
    if (!isLabelNotFoundError(err)) throw err;
    log(`Label "${label.name}" not found — creating it and retrying the add.`);
    try {
      github.createLabel(label.name, label.description);
    } catch (createErr) {
      // Another process won the race and created it first — that still gets
      // us a label to add, so treat it as success rather than failing the claim.
      if (!isLabelAlreadyExistsError(createErr)) throw createErr;
      log(`Label "${label.name}" already exists — another process created it first.`);
    }
    github.addIssueLabel(issueNumber, label.name);
  }
}
