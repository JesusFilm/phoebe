# Vendored edit substrate: which format-preserving TS editor is cheapest to vendor

Research notes, 2026-08-14. All claims verified against primary sources (official npm
registry, package tarballs, and live bundle measurements); each section cites its source.
Context: [Vendored edit substrate: which format-preserving TS editor is cheapest to
vendor](https://github.com/JesusFilm/phoebe/issues/249) — child of the deployment
migrations map ([#177](https://github.com/JesusFilm/phoebe/issues/177)).

## Background

Issue #232 settled that the config-edit substrate must be **vendored** — a committed,
prebuilt bundle imported by relative path from `src/migrations/`, because neither the
github-checkout engine runtime nor the npm-CLI materialized runtime has `node_modules`
available. The original map choice ("edit substrate is recast") cannot be imported as a
bare specifier. This document answers the follow-on question: _which library is actually
cheapest to vendor while still meeting the demand?_

The demand (#232, answer (b)): `getField` / `setField` / `removeField` on paths one level
deep — top-level scalars plus keys inside `promptFiles`, `providerEnv`, `defaultModels`,
`defaultEfforts`, `paths`, and appending to the `workOrder` array. The configs to be
edited are TypeScript files using `const config: <annotation> = { … }; export default
config;` (all examples/, templates/phoebe.config.ts) and `export const config =
defineConfig({ … }); export default config;` (phoebe.config.ts itself).

The key format-preservation requirement: **every untouched byte, including heavy comment
blocks, must be left exactly as it was found.** This is achievable through two distinct
mechanisms:

- **CST-preserving reprinting (recast's model):** the printer emits original bytes for
  any AST node that was not modified.
- **Range-splice:** use the parser solely to locate the character ranges of properties and
  their values; perform all edits as string surgery on those ranges. Untouched bytes are
  never touched — they remain byte-identical by construction, without needing a printer at
  all.

For the concrete demand (replacing a string literal value, removing a property,
appending an array element), **range-splice is sufficient.** The modified node is always
a string literal or array literal whose replacement text can be written directly. A CST
reprinter is overkill for this scope.

This reframes the search: we need the **lightest parser that reliably handles the
TypeScript syntax present in these configs**, not the lightest full rewriter.

## TypeScript syntax the parser must handle

From the actual config files in this repo:

```ts
import type { PhoebeUserConfig } from "phoebe-agent";         // type-only import
const config: PhoebeUserConfig = { … };                       // type annotation
const config: Pick<PhoebeUserConfig, "engine" | "workspace"> = { … }; // generic type
export const config = defineConfig({ … });                    // defineConfig call
export default config;
```

And from `phoebe.config.ts` (uses `satisfies`-compatible patterns). None of the files use
the `satisfies` operator in the config body, but the template preamble comments include
the word; acorn-typescript support for `satisfies` was confirmed in the changelog for
v1.4.13 (2024-01-03).

## Candidates evaluated

### @babel/parser v8.0.4

**Source:** npm registry (`registry.npmjs.org/@babel/parser/8.0.4`), tarball inspection.

- **Version:** 8.0.0 series, latest `8.0.4`
- **Module format:** ESM only — `"type": "module"` in package.json; `lib/index.js` uses
  named ESM exports (`export { parse, parseExpression, tokTypes, getLine, getColumn }`)
  at the bottom of the file with zero `import` statements anywhere in the file. The
  library is **completely self-contained** in a single 481 KB file.
- **Runtime dependencies in bundle:** **0** — despite `@babel/types` appearing in the npm
  `dependencies` field, grepping `lib/index.js` for `from '@babel/types'` returns zero
  hits. The types package is not imported at runtime in v8.
- **Measured size:**
  - Unminified (copy-to-vendor): **481 KB** (`lib/index.js`, confirmed via tarball)
  - Minified (`esbuild --bundle=false --minify --platform=node --target=node24`): **287 KB**
    (measured on actual file)
- **TypeScript support:** full, including type-only imports, generic annotations,
  `satisfies`. Parser is the reference implementation used by the entire Babel ecosystem.
- **License:** MIT — no attribution text required
- **Pure JS:** yes — no wasm sidecar, no native addon
- **Prebuilt bundle:** **yes** — `lib/index.js` is already a single self-contained file;
  no build step required to vendor

### acorn 8.18.0 + acorn-typescript 1.4.13

**Source:** npm registry, tarball inspection, esbuild bundle measurement (measured).

- **Module format:** acorn publishes both CJS (`dist/acorn.js`, 245 KB) and ESM
  (`dist/acorn.mjs`, 233 KB); acorn-typescript publishes ESM at `lib/index.mjs`
  (105 KB), which imports `acorn` by bare specifier. **Neither is self-contained alone.**
  Requires esbuild to produce a single-file vendor bundle.
- **Runtime dependencies:** acorn has 0; acorn-typescript lists acorn as a peerDep (no
  hidden deps). After bundling: 0 external imports.
- **Measured size:** combined esbuild bundle (`--bundle --format=esm --minify
--platform=node --target=node24`): **227 KB** (measured on actual packages)
- **TypeScript support:** acorn-typescript supports `satisfies` (changelog, v1.4.13,
  2024-01-03); `import type`, generic type annotations, Pick<>, union types all parse
  correctly. **Last release: 2024-01-03** — no updates in the 2.5 years since.
- **License:** MIT (both) — no attribution text required
- **Pure JS:** yes
- **Prebuilt bundle:** no — must build with esbuild or similar to merge both packages

### recast 0.24.0 (with either parser)

**Source:** npm registry.

- **Module format:** CJS only — no `"type": "module"`, no exports map; requires bundling
  to produce ESM
- **Dependencies:** 5 runtime deps (`ast-types`, `esprima`, `source-map`, `tiny-invariant`,
  `tslib`); ast-types itself is CJS-only
- **Measured size:** bundlephobia full-dep-tree — ~339 KB minified (does not include the
  parser)
- **What it provides:** CST-preserving reprinting (the "never regenerate untouched bytes"
  guarantee is in the printer, not just the parser)
- **Verdict:** ruled out — the format-preservation requirement is met by range-splice
  alone; adding recast's printer doubles or triples the bundle with no gain for the
  demand's scope. CJS-only format adds further bundling complexity.

### ts-morph 28.0.0 / @ts-morph/bootstrap 0.29.0

**Source:** npm registry.

- **Total size:** ~14.3 MB (bundles the full TypeScript compiler in `@ts-morph/common`)
- **Format preservation:** **no** — reprints the entire file through the TypeScript
  printer; whitespace and comments outside the changed node are not byte-preserved
- **Module format:** CJS
- **Verdict:** ruled out — wrong tool for format-preserving config edits, and far too
  large to vendor

### putout 42.11.0

**Source:** npm registry.

- **Format preservation:** no — uses its own `@putout/printer`, a full code generator
  that reformats the whole file, not a CST-preserving reprinter
- **Transitive deps:** 150+
- **Verdict:** ruled out — a full codemod framework, not a targeted config editor;
  dep count and lack of format preservation both disqualify it

## Comparison table

| Candidate                  | TS support | Format preservation | Minified KB     | Transitive deps | License | Pure JS |
| -------------------------- | ---------- | ------------------- | --------------- | --------------- | ------- | ------- |
| **@babel/parser v8.0.4**   | Full       | range-splice¹       | **287 KB**      | **0**           | MIT     | Yes     |
| acorn + acorn-typescript   | Full²      | range-splice¹       | **227 KB**      | 0               | MIT     | Yes     |
| recast 0.24.0 (any parser) | via parser | CST reprinting      | 339 KB + parser | 5               | MIT     | Yes     |
| ts-morph 28.0.0            | Full       | No                  | ~14 000 KB      | bundled TS      | MIT     | Yes     |
| putout 42.11.0             | Full       | No                  | large           | 150+            | MIT     | Yes     |

¹ "Range-splice" means: use the parser to locate character ranges; perform edits as
string surgery on those ranges. Untouched bytes are preserved by never touching them,
not by reprinting.

² acorn-typescript last released 2024-01-03 (2.5 years ago); all TypeScript features
present in the current configs are supported, but future syntax coverage is unverified.

## Recommendation

**Winner: `@babel/parser` v8.0.4** (287 KB minified; 481 KB if copied unminified)

**Runner-up: acorn 8.18.0 + acorn-typescript 1.4.13** (227 KB bundled+minified) — loses
on two counts: (a) requires an esbuild bundling step to merge the two packages into a
single file, while @babel/parser is already self-contained; (b) acorn-typescript has not
had a release in 2.5 years, creating an unverified risk for any TypeScript syntax that
appears in future config files. The 60 KB size advantage does not outweigh carrying a
stale peerDep into a committed vendor bundle with no visibility into its maintenance
trajectory.

The key insight driving both over recast: **recast's CST reprinting is not needed for
this demand**. All edits in scope (replace a string literal value, remove a property line,
append an array element) can be expressed as character-range splices using positions the
parser already provides. The "format-preserving" requirement is satisfied because
untouched bytes are never regenerated at all. Adding recast's printer would roughly triple
the bundle size with no functional gain.

## Exact version and vendor bundle command

**Version to pin:** `@babel/parser@8.0.4`

`lib/index.js` in this version is a single, self-contained ESM file with no `import`
statements and a single named `export` line at the bottom. It can be vendored with or
without a minification step:

**Option A — copy unminified (no build tool required, 481 KB):**

```bash
pnpm add -D @babel/parser@8.0.4
cp node_modules/@babel/parser/lib/index.js src/migrations/vendor/babel-parser.js
pnpm remove @babel/parser
git add src/migrations/vendor/babel-parser.js
```

**Option B — minify with esbuild (287 KB, requires esbuild in devDependencies):**

```bash
pnpm add -D @babel/parser@8.0.4 esbuild
./node_modules/.bin/esbuild node_modules/@babel/parser/lib/index.js \
  --bundle=false --format=esm --platform=node --target=node24 \
  --minify --outfile=src/migrations/vendor/babel-parser.js
pnpm remove @babel/parser esbuild   # or keep if already needed elsewhere
git add src/migrations/vendor/babel-parser.js
```

The committed file is then imported by relative path from migration source:

```ts
import { parse } from "../../vendor/babel-parser.js";
// parse(content, { sourceType: "module", plugins: ["typescript"] })
```

**CI drift check** (regenerate and diff to detect stale vendor):

```bash
./node_modules/.bin/esbuild node_modules/@babel/parser/lib/index.js \
  --bundle=false --format=esm --platform=node --target=node24 \
  --minify --outfile=/tmp/babel-parser-fresh.js
diff src/migrations/vendor/babel-parser.js /tmp/babel-parser-fresh.js
```

## Capabilities the winner cannot express within the demand — falls to `manual`

The `@babel/parser` substrate is a **parser with position data**; the actual edit
operations are hand-written range splices on top of it. Within the concrete demand
(getField / setField / removeField / appendWorkKind, one level deep), the following
shapes cannot be handled automatically and must emit a `ConfigRefusal` (the `manual`
verdict):

1. **Non-literal property values.** A property whose value is a spread (`...base`),
   a call expression (`resolvePrompts()`), a conditional expression, or a template
   literal cannot have its bytes replaced safely with a string splice. The parser
   identifies these shapes; the substrate refuses rather than corrupting the file.

2. **Computed property keys.** `{ [key]: value }` cannot be located by name without
   evaluating `key`. Refuse.

3. **Setting an object-valued field from scratch.** If a migration needs to introduce
   a property whose value is itself an object literal (e.g., adding an `engine: { … }`
   key that is not already present), serializing the object literal is within reach for
   simple shapes but must be implemented explicitly in the substrate — it is not
   automatic. Outside the current demand, which only sets string/string-array values
   (all `promptFiles.*`, `providerEnv.*`, etc. values are strings).

4. **Configs using the `defineConfig` call where the call itself contains nested spreads
   or dynamic arguments.** The navigation (default-export → const-declaration → optional
   `defineConfig()` call-expression unwrap → object-literal) is deterministic for the
   shapes documented in templates/ and examples/; any other shape refuses.

None of these affect the config shapes currently scaffolded or documented in this repo.
The refusal path (#178's `ConfigRefusal` + `manual` verdict) is already in place.
