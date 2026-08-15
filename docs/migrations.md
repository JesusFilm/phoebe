# Writing deployment migrations

Engine-contributor guide for the `Migration` interface. This is an **internal
authoring reference** — operators reading `upgrading.md` are never handed this.
For the operator view of what migrations do to your deployment, see
[`upgrading.md` → `phoebe migrate`](upgrading.md#phoebe-migrate--reshaping-your-files-for-the-current-ref).

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

`readFile(relPath)` returns the raw file content (never a parsed config object —
the config being migrated may not yet satisfy the target schema). Return `null`
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
**stages** these writes — it captures the pre-image of each path, then writes
all of them — then runs post-apply validation. If validation fails, the runner
reverts this migration's writes in-place (same inode, no rename-over) before
marking it `failed`. That revert is best-effort rather than transactional — see
[Stage-and-flush-on-`applied` atomicity](#stage-and-flush-on-applied-atomicity).

Return a `ConfigRefusal` when the config is too dynamic to rewrite safely:

```ts
import { ConfigRefusal } from "../config-handle.ts";

return new ConfigRefusal(`add "research" to the workOrder array in phoebe.config.ts`);
```

A `ConfigRefusal` is not a failure — the deployment is left unmodified and the
migration is marked `manual` with the instruction printed verbatim. The operator
makes the edit by hand.

`apply` must not write to disk directly. Only the runner flushes writes, so an
exception inside `apply` before it returns leaves nothing on disk.

## `ConfigHandle` — the parser-based config-edit substrate

Config migrations call `configHandle` — the narrow API that bounds what a
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
On `ok: false`, the edit is ambiguous or unsafe — return a `ConfigRefusal` with
the manual instruction.

### What an author may assume

The substrate parses with the vendored `@babel/parser` and splices by byte
offset. Every byte outside the targeted node is left untouched — this is a
property of the mechanism, not of a printer's round-trip fidelity.

An author writing a config migration may assume:

1. **The config object is a plain object literal.** `resolveConfigObject` refuses
   anything that is not an `ObjectExpression` at the end of the resolution chain.
2. **No spread elements in the object.** A key present via `...spread` reads as
   `undefined`; the substrate refuses early so no migration ever sees it.
3. **No computed keys.** `[expr]: value` is refused before field lookup.
4. **No duplicate keys.** The substrate checks the full property list and refuses
   on the first duplicate.
5. **No post-declaration mutations.** `config.x = ...` assignments after the
   object literal are detected and refused — the literal's fields are the
   canonical shape.
6. **The config is resolved through the standard forms.** Every scaffolded and
   example config is supported (see below); anything else is a `ConfigRefusal`
   with an exact manual instruction.

### Supported config forms

Both resolution paths that `loadUserConfig` accepts are supported:

```ts
// Templates / examples — the standard form
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

All refusals are AST-shape checks on nodes already in hand — they are cheap,
precise, and do not require running the config. Each refusal case has one
fixture test in `src/config-handle.test.ts`.

Two are "silent failure" cases — they must be tested rather than documented as
prose, because "we forgot to refuse" corrupts a config instead of erroring:

- **`...spread` in the object** — a key present via the spread reads as
  `undefined`; a naive migration adds a duplicate key.
- **Shorthand property** — a naive read returns the identifier name, not the
  runtime value.

The complete closed set:

| Case                                           | Why it refuses                                                                   |
| ---------------------------------------------- | -------------------------------------------------------------------------------- |
| `...spread` in the object                      | spread key reads `undefined` → silent duplicate                                  |
| Shorthand property (write)                     | value is an identifier, not a literal                                            |
| `export { default } from "..."`                | re-export has no local default to resolve                                        |
| `defineConfig(reference)`                      | argument must be an inline object literal                                        |
| Conditional default export                     | ternary/logical expression is not a config object                                |
| No default export and no `export const config` | neither resolution path applies                                                  |
| Computed key `[expr]: value`                   | key is not statically known                                                      |
| Duplicate keys                                 | result of a write would be ambiguous                                             |
| Non-literal value (for writes)                 | `process.env.X`, call, template, reference — reads OK as `raw`, never writable   |
| `config.x = ...` mutation after literal        | literal fields are the canonical shape; mutations are invisible to the substrate |

### Why `rewriteEngineRef` does not use this substrate

`rewriteEngineRef` in `src/upgrade.ts` is a regex-based rewriter that predates
this parser substrate and operates at the **old CLI's** layer — it runs before
the `engine.ref` flip, which means before the target checkout exists. The
parser substrate lives in the **target checkout**. The one process that would
consume a parser-based rewrite (the running `phoebe boot`) is by definition the
one that may predate it. They cannot share code at runtime despite sharing a
repo — retrofitting `rewriteEngineRef` onto this substrate would require the
old CLI to import from the new checkout, which it does not have.

## Artifact migrations (create-if-absent)

Artifact migrations scaffold files that may be missing from older deployments.
The invariant is create-if-absent: **never overwrite an operator file**. `detect`
must return `null` when the target file already exists, so `apply` is never
called if the file is present.

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
4. Run post-apply validation: `loadUserConfig` → `validateUserConfig`.
5. **If validation succeeds**, append the journal entries and mark `applied`.
6. **If validation fails**, revert every write from this migration in-place (new
   files are deleted; modified files are written back to their pre-image). Mark
   `failed`. The runner continues with the next migration.

A throw inside `apply` before it returns leaves nothing on disk: `apply` is pure
— it returns staged writes rather than performing them — so nothing has been
flushed yet.

**The revert is best-effort, not a transaction.** Once the flush begins, the
runner cannot guarantee it can undo it. Two cases leave files behind:

- A revert step that itself fails — an `unlink` or write-back hitting a
  permission error or a vanished directory — is swallowed so the remaining
  entries still get their chance. That file keeps its migrated content.
- A flush that throws partway through its own loop leaves the writes that already
  landed on disk, with no revert pass over them.

Both are rare, and neither can produce an _invalid_ deployment silently: post-apply
validation runs against what is actually on disk, so a config left in a bad state
is reported as `failed` rather than passing. But do not write a migration whose
correctness depends on revert being all-or-nothing. When the report says
`failed`, treat "the tree is back to its pre-migration state" as the expected
case and not a guarantee — `git status` in the affected repo is the ground truth,
and it is why Phoebe never commits for you.

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
2. **Idem.** Running the migration against the output of step 1 — `detect`
   returns `null` (not-applicable).
3. **Role filter.** The migration does not apply to roles it does not target
   (`appliesTo` check).

```ts
describe("myMigration — idempotence", () => {
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
