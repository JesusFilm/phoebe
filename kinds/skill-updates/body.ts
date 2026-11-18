// The PR body and comments the `skill-updates` kind writes (#877). The kind
// writes the facts (what moved, what was skipped, what was overwritten); the
// agent pass writes the behaviour summary and the flags. The marker goes last.

import { renderMarker, renderNewerMarker } from "./plan.ts";
import type { SyncReport } from "./sync.ts";

export function prTitle(source: string, ref: string): string {
  return `Phoebe: update ${source} skills to ${shortRef(ref)}`;
}

/** A tag as it is; a commit to its first 12 characters. */
export function shortRef(ref: string): string {
  return /^[0-9a-f]{40}$/.test(ref) ? ref.slice(0, 12) : ref;
}

const code = (text: string) => `\`${text}\``;

function list(items: readonly string[]): string {
  return items.map((item) => `- ${item}`).join("\n");
}

export function renderBody(opts: {
  source: string;
  from: string;
  to: string;
  lockPath: string;
  report: SyncReport;
  /** The agent's per-skill summary, or null when it wrote none. */
  summary: string | null;
  /** The lines the agent flagged, or null when it flagged none. */
  flags: string | null;
  /** Vendored paths the agent changed and the kind put back. */
  reverted: readonly string[];
}): string {
  const { source, report } = opts;
  const sections: string[] = [];

  if (opts.flags !== null) {
    sections.push(
      "## Review before merging\n\n" +
        "The agent pass flagged these lines in the upstream diff. They read like instructions " +
        "to fetch URLs, run commands, read secrets or skip review. Every agent in this repository " +
        "would follow them, so read each one before merging.\n\n" +
        opts.flags.trim(),
    );
  }

  sections.push(
    `Updates the vendored skills from ${code(source)} from ${code(shortRef(opts.from))} ` +
      `to ${code(shortRef(opts.to))}, and their entries in ${code(opts.lockPath)}.`,
  );

  sections.push(
    "## What changed\n\n" +
      (opts.summary?.trim() || "The agent pass wrote no summary. Read the diff before merging."),
  );

  const rows = report.synced.map((s) => {
    const change =
      s.from !== null && s.from !== s.to
        ? `moved from ${code(s.from)} to ${code(s.to)}`
        : s.changed
          ? "updated"
          : "unchanged";
    return `| ${code(s.name)} | ${change} |`;
  });
  if (rows.length > 0)
    sections.push(["## Skills", "", "| Skill | Change |", "| --- | --- |", ...rows].join("\n"));

  const notes: string[] = [];
  if (report.added.length > 0) {
    notes.push(
      "## Added upstream\n\nNot vendored here. Vendoring one changes what agents are told, " +
        "so that is a person's call.\n\n" +
        list(report.added.map(code)),
    );
  }
  const removed = [
    ...report.removed.map(
      (n) => `${code(n)}: vendored here and left at ${code(shortRef(opts.from))}`,
    ),
    ...report.dropped.map(code),
  ];
  if (removed.length > 0) {
    notes.push(
      "## Removed upstream\n\nNothing was deleted here. Remove a vendored one by hand if you want it gone.\n\n" +
        list(removed),
    );
  }
  if (!report.previousKnown) {
    notes.push(
      `The commit the lock was on could not be fetched, so skills added or removed upstream are not listed.`,
    );
  }
  const skipped = [
    ...report.ambiguous.map(
      (a) => `${code(a.name)}: found at ${a.paths.map(code).join(" and ")}, so it was left alone`,
    ),
    ...report.ignored.map((n) => `${code(n)}: in \`ignore\``),
  ];
  if (skipped.length > 0) sections.push("## Skipped\n\n" + list(skipped));
  sections.push(...notes);
  if (report.localEditsDiscarded.length > 0) {
    sections.push(
      "## Local edits discarded\n\nThese vendored skills no longer matched their lock hash before the " +
        "sync, and were overwritten with upstream's files.\n\n" +
        list(report.localEditsDiscarded.map(code)),
    );
  }
  if (opts.reverted.length > 0) {
    sections.push(
      "## Agent edits reverted\n\nThe agent pass changed vendored files. They were put back before the push.\n\n" +
        list(opts.reverted.map(code)),
    );
  }

  sections.push(
    "---\n\n" +
      "Phoebe never merges this PR. Vendored skills are instructions every agent here follows. " +
      `Closing it unmerged stops ${code(`${source}@${shortRef(opts.to)}`)} from being proposed again; ` +
      "a newer ref still will be.",
  );
  sections.push(renderMarker({ source, ref: opts.to }));
  return sections.join("\n\n") + "\n";
}

/** The comment on a PR someone else has pushed to, when upstream has moved past it. */
export function renderNewerComment(source: string, ref: string): string {
  return (
    `${code(source)} has a newer ref, ${code(shortRef(ref))}. This branch has commits from ` +
    "someone other than Phoebe, so I've left it alone. Merge or close this PR and the next scan " +
    "proposes the newer ref.\n\n" +
    renderNewerMarker({ source, ref })
  );
}
