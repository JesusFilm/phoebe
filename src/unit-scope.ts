// How one work unit's names become its own (#423).
//
// Before several units ran inside one pipeline, everything a unit needed on
// disk could be keyed by its kind: one `scratch/<kind>`, one
// `worktrees/readonly/<kind>`, one lease reading `pipeline=<name>`. With two
// units of one kind in flight that keying is a collision — the second unit's
// preparation deletes the first's directory out from under a running agent —
// and with two units of *different* kinds it is still a collision whenever
// their branches derive the same worktree dir (an `issues` unit on issue 5 and
// a `conflicts` unit on a PR whose head branch is `issue-5`).
//
// So the unit's identity, `(kind, ref)`, joins the name. `kind` is already a
// safe segment: built-in names are hardcoded literals and custom ones are
// validated against `CUSTOM_WORK_KIND_NAME_RE` at config load, so both are
// `[a-z][a-z0-9-]*`. `ref` is not — it is kind-owned, contractually no more
// than a non-empty single-line string, and nothing may parse it. It is
// therefore the part that gets encoded.

import { join } from "node:path";
import type { UnitRef } from "./unit-event.ts";

/** Characters a ref may keep: the portable filename set, minus `%`. */
const SAFE_REF_CHAR = /^[A-Za-z0-9._-]$/;

/**
 * Encode a kind-owned ref as one path-safe segment.
 *
 * Percent-encode every byte outside `[A-Za-z0-9._-]`, `%` included. Encoding
 * `%` itself is what makes the mapping injective rather than merely safe: with
 * it, `a/b` and `a%2Fb` are distinct refs that stay distinct as directories,
 * and no ref can spell a path separator, a `..`, or a shell metacharacter. The
 * price is a directory name an operator reads rather than recognises —
 * `issue%3A88` for `issue:88` — which is the trade the collision is worth.
 *
 * Bytes, not code points: a ref carrying non-ASCII becomes its UTF-8
 * percent-encoding, the same rule a URL uses, so the result is ASCII whatever
 * the input.
 */
export function encodeUnitRef(ref: string): string {
  let encoded = "";
  for (const byte of Buffer.from(ref, "utf8")) {
    const char = String.fromCharCode(byte);
    encoded += SAFE_REF_CHAR.test(char)
      ? char
      : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return encoded;
}

/**
 * One unit's directory under `base` — `<base>/<kind>/<encoded ref>`.
 *
 * Both per-unit directories are this shape: the plain-directory workspace
 * under `scratch/`, and the detached read-only tree under
 * `worktrees/readonly/`. The kind stays its own segment so a `find` by kind
 * still works and the encoding only ever has to cover the ref.
 */
export function unitDir(base: string, unit: UnitRef): string {
  return join(base, unit.kind, encodeUnitRef(unit.id));
}

/**
 * Who a worktree lease belongs to: `<pipeline>#<kind>:<encoded ref>`.
 *
 * The `#` is the seam the boot-time lease break reads across — it takes the
 * pipeline segment alone, so a row still breaks its own leases without knowing
 * units exist (see `leasePipeline`). Past it, the unit segment is what stops a
 * sibling unit of the same row from stealing a tree: `releaseWorktree`
 * compares the whole owner, so anything but this unit's own lease ends the
 * attempt in a skip.
 *
 * Encoded, because the reason is parsed out of `git worktree list --porcelain`
 * on whitespace, and a ref may contain spaces. `kind` cannot contain `:` or
 * `%`, so the join stays injective.
 */
export function unitOwner(pipeline: string, unit: UnitRef): string {
  return `${pipeline}#${unit.kind}:${encodeUnitRef(unit.id)}`;
}
