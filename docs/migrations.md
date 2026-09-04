# Writing deployment migrations

**Who this is for:** engine contributors writing a `Migration`. Operators want
[`upgrading.md`](upgrading.md) instead.

Engine-contributor guide for the `Migration` interface. This is an **internal
authoring reference**. Operators reading `upgrading.md` are never handed this.
For the operator view of what migrations do to your deployment, see
[`upgrading.md` → `phoebe migrate`](upgrading.md#phoebe-migrate-reshaping-your-files-for-the-current-ref).

## What a migration is

A **deployment migration** is a detect-and-fix operation over one deployment
directory. It detects whether some change is needed (a missing prompt file, an
outdated config field, a config that predates a new work kind), describes what
it will do, and applies a set of writes if applicable. Migrations are:

- **Idempotent by construction.** `detect` returns `null` once `apply` has run,
  so a second `phoebe migrate` call reports everything not-applicable.
- **Ordered.** The registry is a hand-ordered array; migrations run in
  declaration order within each directory.
- **Per-directory.** Each migration sees exactly one deployment directory at a
  time. The runner walks root first, then workspace children.
- **Never cumulative.** A migration that ships stays in the registry forever.
  Removing a migration from the set would strand older deployments that never
  had a chance to apply it. **The set never shrinks.**

## The `Migration` interface

```ts
export type Migration = {
  id: string; // kebab-case slug, stable forever
  title: string; // one-line summary for reports
  appliesTo: readonly MigrationRole[];
  detect: (dir: string, readFile: (relPath: string) => string | null) => unknown;
  describe: (data: unknown) => string;
  apply: (
    dir: string,
    data: unknown,
    readFile: (relPath: string) => string | null,
  ) => Record<string, string> | ConfigRefusal;
  verify?: (ctx: MigrationVerifyContext) => Promise<void>;
};
```

## The three roles

```ts
export type MigrationRole = "solo-root" | "workspace-root" | "tenant";
```

| Role             | What it is                                                  |
| ---------------- | ----------------------------------------------------------- |
| `solo-root`      | A solo (single-repo) deployment root                        |
| `workspace-root` | A multi-tenant deployment root (carries `workspace:` block) |
| `tenant`         | A workspace child directory (carries a per-tenant config)   |

A migration declares which roles it targets in `appliesTo`. The runner skips a
migration entirely when the current directory's role is not in the list.

## `detect → describe → apply`

### `detect`

```ts
detect(dir: string, readFile: (relPath: string) => string | null): unknown
```

`readFile(relPath)` returns the raw file content, never a parsed config object,
because the config being migrated may not yet satisfy the target schema. Return `null`
to signal not-applicable; return any non-null value to signal applicable. The
returned value (`data`) is passed verbatim to `describe` and `apply`.

`detect` must not write anything. Throwing counts as a failure for this
migration; the runner records it and moves on.

### `describe`

```ts
describe(data: unknown): string
```

One-line description of what this migration did. Shown in the human report and
the `--json` envelope's `detail` field. Called only when `detect` returned
non-null (i.e., when the migration is applicable).

### `apply`

```ts
apply(
  dir: string,
  data: unknown,
  readFile: (relPath: string) => string | null,
): Record<string, string> | ConfigRefusal
```

Return a map of `{ relPath: content }` for every file to write. The runner
**stages** these writes, capturing the pre-image of each path and then writing
all of them, and afterwards runs post-apply validation. If validation fails, the runner
reverts this migration's writes in-place (same inode, no rename-over) before
marking it `failed`. That revert is best-effort rather than transactional. See
[Stage-and-flush-on-`applied` atomicity](#stage-and-flush-on-applied-atomicity).

Return a `ConfigRefusal` when the config is too dynamic to rewrite safely:

```ts
import { ConfigRefusal } from "../config-handle.ts";

return new ConfigRefusal(`add "research" to the workOrder array in phoebe.config.ts`);
```

A `ConfigRefusal` is not a failure. The deployment is left unmodified and the
migration is marked `manual` with the instruction printed verbatim. The operator
makes the edit by hand.

`apply` must not write to disk directly. Only the runner flushes writes, so an
exception inside `apply` before it returns leaves nothing on disk.

### `verify`, a migration's own post-apply check

```ts
verify?: (ctx: MigrationVerifyContext) => Promise<void>
```

Optional, and run after the generic post-apply validation has passed. Throwing
reverts this migration's writes exactly as a validation failure does; the report
says `failed` with `verification failed (reverted)`.

The schema check answers "is this config still valid?". A migration that
**reshapes** rather than adds has a second question to answer — "does it still
mean the same thing?" — and that is what `verify` is for. `ctx.loadConfig()`
loads the migrated file the way the engine does; `ctx.loadConfig(source)` loads
source text that is not on disk, through a throwaway sibling of the config so
its relative imports still resolve. The pre-migration source is gone from disk
by then, so pass it through `detect`'s data if the check needs it:

```ts
async verify(ctx) {
  const { content } = ctx.data as DetectData; // the source detect read
  const before = resolution(await ctx.loadConfig(content));
  const after = resolution(await ctx.loadConfig());
  if (before !== after) throw new Error(`the move changed what this tenant runs: …`);
}
```

An additive migration does not need one. Reach for it when the migration could
plausibly be faithful-looking and wrong.

## `ConfigHandle`, the parser-based config-edit layer

Config migrations call `configHandle`, the narrow API that bounds what a
migration may touch:

```ts
import { configHandle } from "../config-handle.ts";

const result = configHandle.appendWorkKind(content, "research");
if (result.ok) {
  return { "phoebe.config.ts": result.content };
}
return new ConfigRefusal(`add "research" to the workOrder array in phoebe.config.ts`);
```

`ConfigHandle` exposes only the specific operations migrations need. The
`workspace:` block and tenant-list operations are **absent by design**: the
handle's shape is the enforcement mechanism, not review discipline. No migration
may add, remove, or reorder tenants.

`ConfigEditResult` is `{ ok: true; content: string } | { ok: false; reason: string }`.
On `ok: false`, the edit is ambiguous or unsafe. Return a `ConfigRefusal` with
the manual instruction.

### Moving a field: `moveField`

`setField` writes scalar literals. A field whose value is a whole block —
`workKinds`, `promptFiles` — is moved instead, by source range:

```ts
const moved = configHandle.moveField(content, ["workOrder"], ["pipelines", "work", "order"]);
```

Both paths are full paths from the config object, so a nested key moves as
readily as a top-level one (`["promptFiles", "issue"]` →
`["pipelines", "work", "kinds", "issues", "promptFile"]`). Object literals the
destination path names but the config does not have yet are created around the
value; the last segment is the key it lands under, so a move renames as it goes.

What it guarantees:

- The value's **source range** is what moves. Comments inside it travel with it.
  Its inner lines are reindented for the new depth, and every byte outside the
  ranges the move touches is untouched.
- The value is **never read**. Anything computed rather than written out — a
  spread, a reference, a call, a template literal, a computed key, a shorthand —
  is refused, because relocating an expression is not the same as relocating a
  literal. Refuse to the operator; do not work around it.
- A comment sitting **above** the moved field is not part of its range and stays
  where it was. Say so in the operator instruction if the migration moves a
  field that usually carries one.

A destination key that already exists is a refusal too: the migration cannot
pick which of the two the operator meant.

`listKeys(content, path)` reads the keys of a nested block in source order, and
tells an absent block (`found: false`) from an empty one. It is how a migration
enumerates what to move without reading any value.

### What an author may assume

The handle parses with the vendored `@babel/parser` and splices by
source range (UTF-16 code-unit offsets, as returned by the parser and used by
`String.slice`). Every character outside the targeted node is left untouched.
That comes from the mechanism itself rather than from a printer's round-trip
fidelity.

An author writing a config migration may assume:

1. **The config object is a plain object literal.** `resolveConfigObject` refuses
   anything that is not an `ObjectExpression` at the end of the resolution chain.
2. **No spread elements in the object.** A key present via `...spread` reads as
   `undefined`, so the handle refuses early and no migration ever sees it.
3. **No computed keys.** `[expr]: value` is refused before field lookup.
4. **No duplicate keys.** The handle checks the full property list and refuses
   on the first duplicate.
5. **No post-declaration mutations.** `config.x = ...` assignments after the
   object literal are detected and refused, because the literal's fields are the
   canonical shape.
6. **The config is resolved through the standard forms.** Every scaffolded and
   example config is supported (see below); anything else is a `ConfigRefusal`
   with an exact manual instruction.

### Supported config forms

Both resolution paths that `loadUserConfig` accepts are supported:

```ts
// Templates and examples: the standard form
import type { PhoebeUserConfig } from "phoebe-agent";
const config: PhoebeUserConfig = { ... };
export default config;

// This repo's own config (defineConfig form)
const config = defineConfig({ ... });
export default config;

// Inline export
export default defineConfig({ ... });
export default { ... };

// Named export (loadUserConfig named form)
export const config = { ... };
```

Additionally: `satisfies` / `as` / `as const` type annotations on the expression,
`let` instead of `const`, and quoted string keys are all supported.

### Closed refusal set

All refusals are AST-shape checks on nodes already in hand, so they are cheap and
precise and never require running the config. Each refusal case has one
fixture test in `src/config-handle.test.ts`.

Two are silent-failure cases. They must be tested rather than documented as
prose, because forgetting to refuse corrupts a config instead of erroring:

- **`...spread` in the object.** A key present via the spread reads as
  `undefined`, so a naive migration adds a duplicate key.
- **Shorthand property.** A naive read returns the identifier name rather than the
  runtime value.

The complete closed set:

| Case                                           | Why it refuses                                                                    |
| ---------------------------------------------- | --------------------------------------------------------------------------------- |
| `...spread` in the object                      | spread key reads `undefined` → silent duplicate                                   |
| Shorthand property (write)                     | value is an identifier, not a literal                                             |
| `export { default } from "..."`                | re-export has no local default to resolve                                         |
| `defineConfig(reference)`                      | argument must be an inline object literal                                         |
| Conditional default export                     | ternary/logical expression is not a config object                                 |
| No default export and no `export const config` | neither resolution path applies                                                   |
| Computed key `[expr]: value`                   | key is not statically known                                                       |
| Duplicate keys                                 | result of a write would be ambiguous                                              |
| Non-literal value (for writes)                 | `process.env.X`, call, template, reference. Reads OK as `raw`, never writable     |
| `config.x = ...` mutation after literal        | literal fields are the canonical shape, and mutations are invisible to the handle |

The set above is what `resolveConfigObject` checks about the config object
itself. [`moveField`](#moving-a-field-movefield) applies the same rules a level
down, to the value it is asked to relocate, and adds two of its own: a
destination key that already exists, and an intermediate on either path that is
not a plain object literal.

### Why `rewriteEngineRef` does not use this handle

`rewriteEngineRef` in `src/upgrade.ts` is a regex-based rewriter that predates
this parser layer and operates at the **old CLI's** layer, running before the
`engine.ref` flip, which means before the target checkout exists. The
parser handle lives in the **target checkout**. The one process that would
consume a parser-based rewrite (the running `phoebe boot`) is by definition the
one that may predate it. They cannot share code at runtime despite sharing a
repo. Retrofitting `rewriteEngineRef` onto this layer would require the old CLI
to import from the new checkout, which it does not have.

## Artifact migrations (create-if-absent)

Artifact migrations scaffold files that may be missing from older deployments.
The invariant is create-if-absent: **never overwrite an operator file**. `detect`
must return `null` when the target file already exists, so `apply` is never
called if the file is present. The flush enforces this at write time too: for
entries whose pre-image was absent (`before=null`), it uses an atomic no-clobber
create (`open` with `wx`) so that a file appearing after `detect` fails with
EEXIST rather than being silently overwritten.

```ts
export const myMigration: Migration = {
  id: "add-my-prompt",
  title: "Scaffold missing my-prompt.md",
  appliesTo: ["solo-root"],

  detect(_dir, readFile) {
    return readFile("prompts/my-prompt.md") === null ? true : null;
  },

  describe() {
    return "scaffold prompts/my-prompt.md from the shipped default";
  },

  apply() {
    return { "prompts/my-prompt.md": SHIPPED_CONTENT };
  },
};
```

## Stage-and-flush-on-`applied` atomicity

The runner's flush-and-validate loop:

1. `apply` returns staged writes (or a `ConfigRefusal`).
2. For each `relPath`, capture the pre-image (`readFileSync` or `null` for new
   files).
3. Write all staged files to disk (same-inode `writeFileSync`).
4. Run post-apply validation: `loadUserConfig` → `validateUserConfig`, then the
   migration's own [`verify`](#verify-a-migrations-own-post-apply-check) if it
   declares one.
5. **If both pass**, append the journal entries and mark `applied`.
6. **If either fails**, revert every write from this migration in-place (new
   files are deleted; modified files are written back to their pre-image). Mark
   `failed`. The runner continues with the next migration.

A throw inside `apply` before it returns leaves nothing on disk. `apply` is pure,
returning staged writes rather than performing them, so nothing has been flushed
yet.

**The revert is best-effort, not a transaction.** Once the flush begins, the
runner cannot guarantee it can undo it. One case leaves files behind:

- A revert step that itself fails, such as an `unlink` or write-back hitting a
  permission error or a vanished directory, is swallowed so the remaining entries
  still get their chance. That file keeps its migrated content.

A throw partway through the flush loop (EACCES, ENOSPC, a vanished directory, or
EEXIST from the no-clobber create for new files) triggers a revert pass over the
entries already written in that migration before recording `failed`. The runner
then continues to the next migration.

Neither failure mode can produce an _invalid_ deployment silently: post-apply
validation runs against what is actually on disk, so a config left in a bad state
is reported as `failed` rather than passing. But do not write a migration whose
correctness depends on revert being all-or-nothing. When the report says
`failed`, treat "the tree is back to its pre-migration state" as the expected
case rather than a guarantee. `git status` in the affected repo is the ground
truth, and it is why Phoebe never commits for you.

## Registering a migration

Migrations live one per file in `src/migrations/` and are registered by hand in
`src/migrations/index.ts`:

```ts
import { myMigration } from "./my-migration.ts";

export const MIGRATIONS: readonly Migration[] = [
  // ... existing migrations ...
  myMigration, // ← append at the end unless an ordering dependency requires otherwise
];
```

Execution order is the array order, never inferred from filenames. Add new
migrations at the end; only move one earlier if it is a prerequisite for
another.

## The mandated three-assertion idempotence test

Every migration must have a test that verifies three assertions:

1. **Applies.** `detect` returns non-null on a deployment that needs it; `apply`
   returns the expected file map (or the expected `ConfigRefusal`).
2. **Idem.** Running the migration against the output of step 1, where `detect`
   returns `null` for not-applicable.
3. **Role filter.** The migration does not apply to roles it does not target
   (`appliesTo` check).

```ts
describe("myMigration idempotence", () => {
  test("applies when the file is absent", () => {
    const data = myMigration.detect("/dir", () => null);
    expect(data).not.toBeNull();
    const writes = myMigration.apply("/dir", data, () => null);
    expect(writes).toEqual({ "prompts/my-prompt.md": expect.stringContaining("…") });
  });

  test("not-applicable when the file already exists", () => {
    const data = myMigration.detect("/dir", (p) =>
      p === "prompts/my-prompt.md" ? "existing" : null,
    );
    expect(data).toBeNull();
  });

  test("does not target workspace-root", () => {
    expect(myMigration.appliesTo).not.toContain("workspace-root");
  });
});
```

The three-assertion pattern is not optional: it is the minimum that proves
detect and apply are actually inverse of each other, not just independently
correct.
