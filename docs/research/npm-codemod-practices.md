# How npm-ecosystem tools implement codemods / auto-migrations for user-owned files

Research notes, 2026-08-11. All claims verified against primary sources (official docs or
source code on GitHub); each section cites the owning source. Context: informs a
"deployment migration" facility for `phoebe upgrade` (engine at an arbitrary git ref
migrating a root `phoebe.config.ts` plus N tenant child configs).

## 1. Is there a standard codemod framework? What do major tools actually ship?

There is no single official standard, but there is a clear de-facto stack:

- **recast** (benjamn/recast) is the foundational layer. Its core guarantee is
  nondestructive partial reprinting: `recast.print(recast.parse(source)).code === source`,
  and only AST nodes you modify are pretty-printed; untouched code keeps its original
  formatting and comments. Source: https://github.com/benjamn/recast (README).
- **jscodeshift** (facebook/jscodeshift) is a multi-file runner + jQuery-like API
  *wrapped around recast*, maintained by Meta. Ships `--dry` and `--print` flags.
  Source: https://github.com/facebook/jscodeshift (README).
- **Codemod CLI** (codemod.com, `codemod` on npm) is a newer registry/runner. Primary
  engine is jssg (ast-grep for JS); jscodeshift and ts-morph are supported as legacy
  engines via workflows; `--dry-run` exists on `jssg run`. React's official codemods are
  distributed through it. Source: https://docs.codemod.com/cli.
- **ts-morph** is a general TS manipulation library, not a codemod runner. Its docs warn
  that after low-level text manipulation (`insertText`/`replaceText`/`removeText`) all
  previously navigated nodes are "forgotten" and error if reused — a real ergonomic cost
  for surgical edits. Source: https://ts-morph.com/manipulation/.

What major tools ship:

| Tool | Framework used |
|---|---|
| Next.js `@next/codemod` | jscodeshift transforms; `upgrade` also shells out to the codemod.com CLI for React 19 codemods (source: https://github.com/vercel/next.js/tree/canary/packages/next-codemod, `bin/upgrade.ts`) |
| Angular `ng update` | Its own Schematics engine (`@angular-devkit/schematics`), virtual-FS tree based — not recast/jscodeshift (source: https://github.com/angular/angular-cli, `packages/angular/cli/src/commands/update/`) |
| Storybook `automigrate` | Bespoke "Fix" plugin system; file edits via its own `ConfigFile` (babel parse + recast print) (source: https://github.com/storybookjs/storybook, `code/lib/cli-storybook/src/automigrate/`, `code/core/src/csf-tools/ConfigFile.ts`) |
| ESLint `@eslint/migrate-config` | One-shot generator, no AST editing of user code (source: https://github.com/eslint/rewrite/tree/main/packages/migrate-config) |
| Vite | No codemod tooling at all; manual migration guide plus *runtime* back-compat shims in the config loader (e.g. `optimizeDeps.esbuildOptions` auto-converted to `rolldownOptions`) (source: https://vite.dev/guide/migration) |

Takeaway: big tools do **not** adopt a shared migration framework; they build a thin
bespoke runner and reuse recast (directly or via jscodeshift) for the actual text edits.

## 2. How do tools decide which migrations apply?

Two clear camps, and one hybrid:

**Version-keyed (run the delta between fromVersion and toVersion):**

- **Angular `ng update`**: each package's `package.json` has an `ng-update` block pointing
  at a `migrations` schematic collection. The CLI filters schematics by semver range —
  literally `'>' + from + ' <=' + to` matched with `semver.satisfies()` — sorts them with
  `semver.compare`, runs required migrations first, then user-selected optional ones.
  Source: `packages/angular/cli/src/commands/update/utilities/migration.ts` in
  https://github.com/angular/angular-cli.
- **Next.js `@next/codemod upgrade`**: every transform in `TRANSFORMER_INQUIRER_CHOICES`
  carries a `version` field (`'6.0.0'` … `'16.x'`); upgrade computes the window between the
  installed version and the target version and offers exactly the codemods in that window.
  Source: `packages/next-codemod/lib/utils.ts` and `bin/upgrade.ts` in
  https://github.com/vercel/next.js.

**Detect-and-fix / idempotent (verified from Storybook source):**

- **Storybook `automigrate`**: each fix implements
  `check: (options: CheckOptions) => Promise<ResultType | null>` — `null` means "this
  project doesn't exhibit the deprecated shape, skip". The runner loops over all fixes,
  calls `check()` against the live project state (parsed `main.ts`, installed versions,
  story paths), and only prompts/runs fixes whose check returned a result. There is no
  per-fix version-range gating in the current `Fix` type (a `versionRange` field existed
  historically — the `CommandFix` type still `Omit`s it — but `BaseFix` no longer carries
  it). Because applicability is re-detected from project state every run, fixes are
  naturally idempotent and re-runnable. Source:
  `code/lib/cli-storybook/src/automigrate/types.ts` and `automigrate/index.ts` in
  https://github.com/storybookjs/storybook (branch `next`).

**One-shot converters:** `@eslint/migrate-config` doesn't version or detect anything; it
reads the legacy `.eslintrc.*` and emits a brand-new `eslint.config.mjs`, explicitly
documented as not guaranteed to work when the old config contained logic. Source:
https://github.com/eslint/rewrite/tree/main/packages/migrate-config.

Prisma and Vite ship **no** config codemods — both rely on deprecation warnings plus
manual migration guides, and Vite additionally accepts old config shapes at runtime and
converts them internally (https://vite.dev/guide/migration).

## 3. How do they edit hand-authored TS/JS while preserving comments/formatting?

- **Recast-style AST-with-original-printing is the dominant approach.** jscodeshift is a
  recast wrapper (https://github.com/facebook/jscodeshift). Storybook's `ConfigFile`
  parses `main.ts`/`preview.ts` with babel, traverses with babel, and prints with
  `recast.print(config._ast)` so unmodified code round-trips byte-identical; it only works
  on statically analyzable configs (object-literal default export or resolvable
  identifier) and errors with "Could not set the field as the default export is not an
  object" otherwise. Source: `code/core/src/csf-tools/ConfigFile.ts` in
  https://github.com/storybookjs/storybook.
- **Regenerate-and-overwrite** is used only when the target file is being *replaced
  wholesale by a new format*: ESLint's flat-config migrator writes a fresh file
  (https://github.com/eslint/rewrite/tree/main/packages/migrate-config), and Next.js's
  `next-lint-to-eslint-cli` codemod creates a new `eslint.config.mjs`
  (https://nextjs.org/docs/app/guides/upgrading/codemods).
- **Angular schematics** operate on a virtual host tree with recorded text
  insert/delete/replace operations (surgical text edits, not reprinting), committed to
  disk only when the schematic succeeds — closest existing analogue to "magic-string
  surgical edits". Source: https://github.com/angular/angular-cli
  (`@angular-devkit/schematics` engine used by `commands/update`).
- **magic-string** is widespread in bundler/plugin code-generation but is not the primary
  mechanism in any of the major user-project migrators surveyed.

In practice: recast (directly or via jscodeshift) for in-place edits of hand-authored
files; whole-file generation only for format-replacement migrations.

## 4. Sequencing vs the version bump; reporting; partial failure; dry-run

**Ordering — every surveyed tool installs the new version FIRST, then migrates,
running the migration code that ships inside the newly installed version:**

- Angular: applies the package update plan, runs `packageManager.install()`, clears
  Node's module cache, then `executeMigrations()` loads migration collections from the
  freshly installed packages (`ng-update.migrations` path in each package.json). Source:
  `packages/angular/cli/src/commands/update/cli.ts`.
- Next.js: `upgrade` rewrites package.json, runs installation, and only then runs
  `runTransform()` / external codemods; a code comment notes `--allow-dirty` is needed for
  the codemod.com CLI "because the upgrade above modified package.json and the lockfile".
  Source: `packages/next-codemod/bin/upgrade.ts`.
- Storybook: `upgrade` prechecks, updates package.json versions, installs dependencies,
  then `runAutomigrations(...)`, then a `doctor` health-check pass. Source:
  `code/lib/cli-storybook/src/upgrade.ts`.

Note this is the opposite of Phoebe's current "migrate-then-flip-ref" leaning — but the
reason these tools migrate *after* install is that the migrations live in the new
package, so installing is the only way to obtain them. An engine fetched at a git ref can
run the new ref's migration code against the old deployment *before* flipping the active
ref, achieving the same "new code migrates old artifacts" property with better rollback.

**Partial failure:**

- Angular is fail-fast: `if (!success) { return 1; }` — the first failed migration aborts
  the rest (source: `commands/update/utilities/migration.ts`).
- Storybook is fail-soft: a throwing `check()` logs a warning, records `CHECK_FAILED`,
  and the loop continues; a failing `run()` records `FAILED`; the upgrade completes and
  prints a categorized per-fix summary (source: `automigrate/index.ts`).

**Reporting:** Storybook has the richest model — an explicit `FixStatus` enum
(`SUCCEEDED`, `FAILED`, `CHECK_FAILED`, `UNNECESSARY`, `SKIPPED`, `MANUAL_SUCCEEDED`,
`MANUAL_SKIPPED`) plus `promptType: 'auto' | 'manual' | 'notification' | 'command'`, so a
fix can be "we can't do this for you, here's the link" without pretending to run
(source: `automigrate/types.ts`).

**Dry-run:** universal. jscodeshift `--dry`/`--print`; `@next/codemod` `--dry`/`--print`
(https://nextjs.org/docs/app/guides/upgrading/codemods); Storybook `--dry-run` still runs
every `check()` but forces `runAnswer = { fix: false }` so you get the full applicability
report with zero writes (source: `automigrate/index.ts`); Codemod CLI `--dry-run`
(https://docs.codemod.com/cli).

## 5. Uncommitted changes in the user's git tree

Three distinct postures, all verified in source:

- **Hard block (require clean tree):**
  - Angular `ng update`: `checkCleanGit()` runs `git status --porcelain -z`; if dirty,
    errors with "Repository is not clean. Please commit or stash any changes before
    updating." Bypass: `--allow-dirty` (which still warns "Update changes will be mixed
    with pre-existing changes."). It can also auto-commit each step via
    `--create-commits` (`git add -A` + `--no-verify`). Source:
    `packages/angular/cli/src/commands/update/utilities/git.ts` and `cli.ts`.
  - `@next/codemod <transform>`: `checkGitStatus()` (via `is-git-clean`) exits 1 with
    "before we continue, please stash or commit your git changes." unless `--force`.
    Notably, a directory that is *not a git repo at all* is treated as clean. Source:
    `packages/next-codemod/lib/utils.ts`.
  - Codemod CLI: has the same class of check — Next's own upgrade flow must pass
    `--allow-dirty` to it after having touched package.json (source:
    `packages/next-codemod/bin/upgrade.ts`).
- **Neither check nor warn:** Storybook `upgrade`/`automigrate` performs no git
  cleanliness check anywhere in the upgrade or automigrate paths — it prompts per-fix
  before writing instead (sources: `code/lib/cli-storybook/src/upgrade.ts`,
  `automigrate/index.ts`).
- **Auto-commit as opt-in:** only Angular offers it (`--create-commits`); nobody commits
  by default. No surveyed tool does "warn-after-write" as its primary posture.

## Implications for Phoebe

- **Detect-and-fix is precedented and battle-tested.** Storybook — the closest analogue
  (migrating a user-owned TS config + N project artifacts) — converged on exactly the
  shape Phoebe is leaning toward: `check() → result | null`, idempotent, re-runnable, no
  version bookkeeping in the deployment. Version-keyed ranges (Angular/Next) exist to
  avoid re-running non-idempotent transforms; if Phoebe's migrations are idempotent by
  construction, that machinery buys nothing. Storybook's history (it dropped
  `versionRange` from `BaseFix`) suggests version-gating on top of detection wasn't
  pulling its weight.
- **Adopt Storybook's status vocabulary.** A per-migration
  `succeeded/failed/check_failed/unnecessary/manual` report, fail-soft across tenants
  (one tenant's parse failure must not block the other N-1), matches both Storybook's
  model and Phoebe's "nothing per-dir is fatal" precedent from map #127.
- **For editing `phoebe.config.ts`:** the ecosystem answer to "preserve comments and
  formatting" is recast printing over a babel/esprima parse, with a hard scope limit to
  statically analyzable shapes and a graceful "could not migrate automatically, here's
  what to change" fallback (Storybook's `manual` promptType). That is compatible with
  Phoebe's "surgical text edits with report-only fallback" leaning; recast-via-AST is the
  more proven implementation of "surgical" than regex/magic-string.
- **Migrate-then-flip-ref is sound and strictly better than the ecosystem norm.** Others
  migrate after install only because migrations ship inside the new package. Phoebe's
  engine-at-ref architecture lets the *new* engine's migration code run against the old
  deployment before the ref flips — same invariant (new code owns the migration), plus a
  clean abort path: if migration fails, the ref never flips.
- **Write-but-never-commit is the majority posture** (only Angular auto-commits, and only
  opt-in). Given Phoebe already never writes the root config on its own initiative
  (map #127), the Angular-style *preflight* is the piece worth borrowing: a cheap
  `git status --porcelain` check with a warn-or-block before touching configs, plus
  `--check`/dry-run that runs all detection and prints the report with zero writes
  (Storybook's `dryRun` pattern) — which also composes naturally with `phoebe doctor`'s
  report-only convention.
