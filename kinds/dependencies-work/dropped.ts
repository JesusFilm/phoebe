// The "Dropped" section of a dependencies PR (ADR 0003): the bumps the
// implementer could not make pass, in a shape the detector reads back to
// re-file each one on its own. When every bump drops there is no PR, and the
// same section sits in the implementer's comment on the issue instead (#862).
// The prompt tells the agent to write exactly this shape; this module is the
// reading side.

/**
 * One bump the implementer dropped: the package and the version it failed at.
 * `tooNew` marks a bump the package manager refused only because the release
 * is younger than its minimum release age. Nothing is wrong with that version
 * and it passes once the release ages, so it is not a failure.
 */
export type DroppedBump = { package: string; version: string; tooNew: boolean };

/** The heading the section opens with. */
export const DROPPED_HEADING = "## Dropped";

// `- \`<package>@<version>\` (too new): <reason>`, the tag only on a
// release-age refusal. The name match is greedy, so the version is whatever
// follows the last `@`, and a scoped `@scope/name` keeps its leading `@`.
const ENTRY_RE = /^- `(.+)@([^@\s`]+)`(\s*\(too new\))?/i;

/**
 * Every bump listed under the body's `## Dropped` heading, in order, or an
 * empty list when there is no such heading. The section runs to the next
 * heading of level one or two. Lines that are not entries (the failing
 * output, its `<details>` wrapper) are skipped.
 */
export function parseDropped(body: string): DroppedBump[] {
  const dropped: DroppedBump[] = [];
  let inSection = false;
  let inFence = false;
  for (const line of body.split(/\r?\n/)) {
    if (line.trimStart().startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (/^#{1,2}\s/.test(line)) {
      inSection = line.trim() === DROPPED_HEADING;
      continue;
    }
    if (!inSection) continue;
    const match = ENTRY_RE.exec(line);
    if (match !== null) {
      dropped.push({ package: match[1]!, version: match[2]!, tooNew: match[3] !== undefined });
    }
  }
  return dropped;
}
