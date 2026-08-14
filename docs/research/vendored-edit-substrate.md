# Which format-preserving TS editor is cheapest to vendor

Research notes, 2026-08-14. Answers [#249](https://github.com/JesusFilm/phoebe/issues/249);
downstream of [#232](https://github.com/JesusFilm/phoebe/issues/232), which settled that the
edit substrate must be **vendored** — a committed, prebuilt bundle imported by relative path
from `src/migrations/`, because neither runtime resolves a bare specifier.

Everything below was measured, not remembered. Every size, dep count and pass/fail is the
output of a command reproduced in the section that reports it. Package facts come from the
registry (`npm view`) and from the packages' own source in `node_modules`; behavioural facts
come from running the candidate against the four real configs in this repo.

## Verdict

**Vendor `@babel/parser@8.0.4` alone, and keep the get/set/remove logic as ordinary repo
TypeScript.** The substrate we need is a *parser with accurate source offsets*, not a
printer. Once every edit in the demand is a string splice at a node's byte range, untouched
bytes are untouched *by construction* — there is no reprint step that could touch them.

- **Vendored artifact:** 286,210 bytes minified (279 KB; 71,710 B gzipped), one file, ESM.
- **Transitive deps folded in:** 3 (`@babel/types`, `@babel/helper-string-parser`,
  `@babel/helper-validator-identifier`) — all MIT, all from the Babel monorepo.
- **Runtime fit:** zero `require`, zero `node:` builtin imports, zero dynamic `import()`. It
  needs no `createRequire` banner, no `__dirname` shim, no wasm sidecar.

**Runner-up: recast@0.24.0 + @babel/parser@8.0.4** — the incumbent. It lost on two counts,
either of which is disqualifying on its own:

1. **It is 2.2× the bytes for a printer we do not need** — 632,842 B vs 286,210 B, and 8
   transitive deps vs 3.
2. **It does not actually satisfy criterion 1 for removals.** Deleting a property causes
   recast to reprint the enclosing object, and the reprint changes bytes in untouched
   regions — see [§4](#4-recast--babelparser-the-incumbent). Ironically the substrate chosen
   for byte-fidelity is the one candidate that fails the byte-fidelity test on this repo's
   own `phoebe.config.ts`.

## 1. The table

Bundle = single-file minified ESM produced by esbuild 0.28.2 with
`--bundle --format=esm --platform=node --target=node24 --minify --legal-comments=none`
over an entry that re-exports the library's public API. "Deps folded in" counts packages
installed *beyond* the ones named, i.e. what the bundle actually swallows.

| Candidate | TS? | Format-preserving? | Bundle | gzip | Deps folded in | Licence(s) | Pure JS? | Shim needed? |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **`@babel/parser@8.0.4` + splice** | yes | yes (no printer in the loop) | **279 KB** | 70 KB | **3** | MIT | yes | **none** |
| `acorn@8.18.0` + `acorn-typescript@1.4.13` + splice | **no — see §6** | yes | 222 KB | 60 KB | 0 | MIT | yes | none |
| `magicast@0.5.4` | yes | partly (drops trailing newline) | 487 KB | 125 KB | 5 | MIT | yes | none |
| `recast@0.24.0` + `@babel/parser@8.0.4` | yes | **no — see §4** | 618 KB | 150 KB | 8 | MIT | yes | `createRequire` |
| `typescript@5.9.3` (parser only) + splice | yes | yes | 3.4 MB | 999 KB | 0 | Apache-2.0 | yes | `createRequire` + `__filename`/`__dirname` |
| `ts-morph@28.0.0` | yes | yes (but see §5) | 6.7 MB | 1.5 MB | 9 | MIT + Apache-2.0 (bundles `typescript.js`) | yes | `createRequire` + `__filename`/`__dirname` |
| `oxc-parser@0.144.0` | yes | n/a | — | — | 19 platform bindings | MIT | **no — napi** | disqualified |
| `@swc/core@1.16.0` | yes | n/a | — | — | 12 platform bindings | Apache-2.0 | **no — napi** | disqualified |
| `hermes-parser@0.37.0` | yes | n/a | — | — | 1 | MIT | **no — wasm blob** | disqualified |
| `typescript@7.0.2` (current `latest`) | yes | n/a | — | — | 20 platform packages | Apache-2.0 | **no — native Go** | disqualified |

Sizes, verbatim:

```
$ for f in libonly/*.mjs; do n=$(basename $f .mjs); esbuild $f --bundle --format=esm \
    --platform=node --target=node24 --minify --legal-comments=none --outfile=libdist/$n.mjs; \
    printf "%-12s %10s bytes  %8s gzip\n" "$n" "$(stat -c%s libdist/$n.mjs)" \
    "$(gzip -c libdist/$n.mjs | wc -c)"; done
acorn            227702 bytes     61164 gzip
babel            286210 bytes     71711 gzip
magicast         499230 bytes    128256 gzip
recast           632842 bytes    153988 gzip
typescript      3560579 bytes   1022656 gzip
ts-morph        7056867 bytes   1611346 gzip
```

Dep trees, verbatim (`npm i -E --ignore-scripts <spec>` in an empty dir, then list
`node_modules`):

```
@babel/parser@8.0.4          -> @babel/parser @babel/types
                                @babel/helper-string-parser @babel/helper-validator-identifier
acorn + acorn-typescript     -> acorn acorn-typescript
magicast@0.5.4               -> magicast source-map-js @babel/parser @babel/types
                                @babel/helper-string-parser @babel/helper-validator-identifier
recast@0.24.0 + @babel/parser-> recast ast-types esprima source-map tiny-invariant tslib
                                @babel/parser @babel/types
                                @babel/helper-string-parser @babel/helper-validator-identifier
typescript@5.9.3             -> typescript
ts-morph@28.0.0              -> ts-morph @ts-morph/common code-block-writer balanced-match
                                brace-expansion fdir minimatch path-browserify picomatch tinyglobby
```

## 2. Why "parser + splice" beats "parser + printer"

The demand settled in #232 answer (b) is `getField` / `setField` / `removeField` on paths one
level deep, plus appending to `workOrder`. Every one of those is a **local** text operation:

| Operation | Splice |
| --- | --- |
| `setField(["promptFiles","issue"], v)` where the key exists | replace `[value.start, value.end)` with `JSON.stringify(v)` |
| `setField` where the key is new | insert `key: value,` before `}`, copying the last property's indent and comma style |
| `setField` where the *parent* is new | insert `promptFiles: { issue: v },` at the top level |
| `removeField(["engine"])` | delete the property's line span plus its trailing comma |
| `appendToArray(["workOrder"], v)` | insert before `]`, copying the last element's indent |

None of these needs a printer. A printer is what a codemod needs when it rewrites *structure*
— and #232 explicitly scoped structural surgery out. Dropping the printer is what removes
339 KB, 5 transitive packages, and the entire class of reprint artifacts.

The property is stronger than "format-preserving": with splices, a byte outside the edited
range **cannot** change, because nothing writes it. Format preservation stops being a library
behaviour you trust and becomes an invariant of the mechanism.

## 3. The test matrix, and how it was run

Five fixtures, all real: `templates/phoebe.config.ts`, `templates/phoebe.config.workspace.ts`,
`examples/solo/phoebe.config.ts`, this repo's own `phoebe.config.ts` (the
`export const config = defineConfig({...})` form), plus the README-style
`export default defineConfig({...})` snippet. Four assertions each:

1. `print(parse(src)) === src` with no edit (pure round-trip).
2. `getField` reaches a top-level scalar through the shape's resolution chain.
3. `setField(["promptFiles","issue"], "ZZZ.md")` — a nested set, creating `promptFiles` where
   absent — and no line outside the target changes.
4. `removeField` of a top-level key — and no line outside the target changes.

Results (20 assertions per candidate):

| Candidate | Result |
| --- | --- |
| `@babel/parser` + splice | 17 pass / 3 "fail" — all three are the *intentional* removal of the deleted key's own leading comment block, which the harness counts as a stray line. No other byte moves. |
| `acorn` + `acorn-typescript` + splice | 17 pass / 3 same-as-above on these fixtures, but **fails outright on `satisfies`** (§6) |
| `typescript@5.9.3` parser + splice | 17 pass / 3 same-as-above |
| `ts-morph@28.0.0` | 20 pass, but its *insertions* reformat (§5) |
| `recast@0.24.0` | 15 pass / 5 fail — every removal (§4) |
| `magicast@0.5.4` | **3 pass / 17 fail** (§7) |

The two "stray line" categories are a policy choice, not a defect: when `engine` is deleted
from `templates/phoebe.config.ts`, its 13-line explanatory comment block goes with it. Leaving
it would orphan a comment describing a key that no longer exists. recast does the same thing
(comments are attached to nodes); the splice engine does it because it walks upward over
contiguous `//` lines, and can be told not to.

## 4. recast + @babel/parser (the incumbent)

recast's headline guarantee holds where it is advertised: `recast.print(recast.parse(src))`
round-tripped all five fixtures byte-identically, and `setField` on an existing value is
byte-perfect (source: https://github.com/benjamn/recast README; verified here).

**Removals are not.** Deleting `configDir` from this repo's own `phoebe.config.ts` produces:

```diff
   installCommand: "pnpm install --frozen-lockfile",
+
   checkCommand: "pnpm run check",
@@
-  // As a workspace tenant, reuse this repo's standalone `.phoebe/` folder: the
-  ... (5 comment lines)
-  configDir: ".phoebe",
-
@@
-  },
+  }
```

Three things happened. The middle hunk is the intended edit. The other two are not:

- **A blank line was inserted ~20 lines above the edit**, between `installCommand` and
  `checkCommand`. That region was never touched by the migration.
- **The trailing comma of the last surviving property was dropped.** This one is fixable:
  passing `{ trailingComma: true }` to `recast.print` stops it.

The blank line is not fixable by an option, is not an artifact of how the AST was mutated
(reproduced identically with `properties.splice()` in place and with `properties.filter()`),
and is not a 0.24 regression — `recast@0.23.21` + `@babel/parser@7.29.7` reproduces it byte
for byte. It happens because removing an element makes recast reprint the enclosing object,
and the reprint reflows blank lines around comments.

Criterion 1 of #249 says "an edit must leave every untouched byte … exactly as it found it."
recast does not, for the removal half of the demand, on this repo's largest real config.

**It also needs a bundling shim.** `recast/main.js` calls `require("fs")` and
`recast/lib/util.js` calls `require("os")` inside a function body. esbuild cannot lift those
into static ESM imports from inside a CJS wrapper, so the bundle contains esbuild's dynamic
`require` shim and throws **at import time**:

```
Error: Dynamic require of "fs" is not supported
    at file:///tmp/iso/vendor/recast.min.mjs:1:383
```

Curable with `--banner:js='import{createRequire as __cr}from"node:module";var require=__cr(import.meta.url);'`
— which works, because `createRequire` resolves builtins regardless of location — but it is
one more moving part in a blob that has to be right on every branch.

## 5. ts-morph

Passed all 20 assertions and is the only candidate whose *removal* leaves the deleted key's
leading comment in place (arguably wrong, definitely minimal). But:

- **6.7 MB minified.** `@ts-morph/common@0.29.0` ships its own `dist/typescript.js` at
  9,143,384 bytes — vendoring ts-morph means vendoring the whole TypeScript compiler, and
  carrying its **Apache-2.0** attribution alongside ts-morph's MIT.
- **Insertions do not match the file.** `addPropertyAssignment` uses ts-morph's own
  formatting, not the file's:

  ```diff
     engine: { source: "github", ref: "main" },
  +    promptFiles: {
  +        issue: "ZZZ.md"
  +    }
   };
  ```

  Four-space indent into a two-space file, no trailing comma. Tunable via
  `manipulationSettings`, but it is a per-file style guess we would be making on a user's
  config.
- Needs both the `createRequire` banner **and** `__filename`/`__dirname` shims; without them
  the bundle throws `ReferenceError: __filename is not defined in ES module scope`.
- Its own docs warn that after low-level text manipulation all previously navigated nodes are
  "forgotten" and error if reused (https://ts-morph.com/manipulation/).

## 6. acorn + acorn-typescript — the cheapest, and it does not work

At 222 KB / 60 KB gzipped with **zero** transitive deps it is the smallest thing that could
plausibly work, and it passed the fixture matrix. It is disqualified by criterion 1: it
cannot parse the `satisfies` operator, which #249 names as present in the config shapes.

```
$ node -e "const acorn=require('acorn'); const {tsPlugin}=require('acorn-typescript');
  const P=acorn.Parser.extend(tsPlugin());
  for (const src of ['const c = { a: 1 } satisfies P;','const c = { a: 1 } as const;',
                     'const c: Pick<P,\"a\"> = { a: 1 };'])
  { try { P.parse(src,{sourceType:'module',ecmaVersion:'latest',locations:true});
      console.log('OK   ',src);} catch(e){console.log('FAIL ',src,'=>',e.message);} }"
FAIL  const c = { a: 1 } satisfies P; => Unexpected token (1:19)
OK    const c = { a: 1 } as const;
OK    const c: Pick<P,"a"> = { a: 1 };
```

A parser that throws on a config it was pointed at cannot even produce a `manual` verdict
honestly — it produces a parse error. It also silently requires `locations: true`
("You have to enable options.locations while using acorn-typescript"), and is a
single-maintainer package versus Babel's monorepo.

## 7. magicast — right idea, wrong shapes

magicast is purpose-built for exactly this job ("modify JS/TS config files preserving
formatting", https://github.com/unjs/magicast) and its proxy API is by far the nicest to
write against. It scores **3 pass / 17 fail** here, because of what it can reach:

```
$ node -e "…parseModule(readFileSync('examples/solo/phoebe.config.ts'))…"
default type: object identifier
```

`mod.exports.default` for `export default config;` proxies the **`Identifier` node itself**.
There is no step that follows the identifier back to `const config = { … }`. Its exports proxy
(`node_modules/magicast/dist/builders-*.js`) reads `ExportDefaultDeclaration` /
`ExportNamedDeclaration` off the program body directly, and its `deleteProperty` on `default`
does `root.body.splice(i, 1)` — deleting the whole export statement. Its README only ever
demonstrates the inline `export default { … }` form.

`const config: PhoebeUserConfig = { … }; export default config;` is the shape used by **both**
templates and **all four** examples — i.e. every config Phoebe scaffolds. magicast reaches
none of them. It also drops the file's trailing newline on a no-op round-trip
(`src` ends `"g;\n"`, output ends `"ig;"`), so every write would dirty the last line.

## 8. Why not `typescript` itself

Two reasons, one of which is new.

`typescript@5.9.3`'s parser works fine (17/20, identical to Babel's) and has **zero**
dependencies — but it bundles to 3.4 MB, 12× the Babel parser, for a parse tree we use
identically, and it needs both bundling shims.

The new reason: **`typescript@latest` is now 7.0.2, and it is not pure JS.** Its
`dependencies` are 20 platform packages (`@typescript/typescript-linux-x64`,
`@typescript/typescript-darwin-arm64`, …) — the native Go port. A committed blob cannot carry
those cleanly. Anyone reaching for "just use the compiler the repo already has" needs to know
that pinning `typescript@5.x` is now a deliberate act, not the default.

## 9. The recommendation, concretely

### Layout

```
src/migrations/
  vendor/
    babel-parser.mjs      <- the only vendored byte; generated, never hand-edited
    LICENSE               <- MIT text + Babel copyright (see §10)
  config-edit.ts          <- ordinary repo TypeScript: locator + splice engine + tests
```

Vendoring only the third-party parser and keeping our logic as reviewable, testable,
type-checked `.ts` is the point of the split: the committed blob is 100% upstream code, so
the CI freshness check is a byte comparison against a deterministic rebuild, and the logic
that actually decides what a migration does stays in normal code review.

### The build command

`@babel/parser@8.0.4` is `"type": "module"` and ships native ESM
(`"exports": { ".": { "default": "./lib/index.js" } }`), which is why the bundle comes out
free of `require` entirely. Reproducible, and pinned end to end:

```sh
#!/usr/bin/env bash
# scripts/build-edit-substrate.sh — regenerates src/migrations/vendor/babel-parser.mjs
set -euo pipefail
out="$(cd "$(dirname "$0")/.." && pwd)/src/migrations/vendor/babel-parser.mjs"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
cd "$tmp"
npm init -y >/dev/null
npm i --ignore-scripts --no-audit --no-fund -E @babel/parser@8.0.4 esbuild@0.28.2 >/dev/null
printf 'export { parse } from "@babel/parser";\n' > entry.mjs
./node_modules/.bin/esbuild entry.mjs \
  --bundle --format=esm --platform=node --target=node24 --minify \
  --legal-comments=none \
  --outfile=bundle.mjs
{ printf '// @generated by scripts/build-edit-substrate.sh — DO NOT EDIT.\n'
  printf '// Bundled from @babel/parser@8.0.4 (MIT). See ./LICENSE.\n'
  cat bundle.mjs; } > "$out"
```

Output, verified:

```
$ ls -l out1.mjs; gzip -c out1.mjs | wc -c; sha256sum out1.mjs out2.mjs
bytes: 286210
gzip:  71710
85a911f69ff3eb5e1e298e1f917811b728c3ca538548d7f05915791159bf5760  out1.mjs
85a911f69ff3eb5e1e298e1f917811b728c3ca538548d7f05915791159bf5760  out2.mjs
$ node -e "import('./out1.mjs').then(m=>console.log(Object.keys(m)))"
[ 'parse' ]
```

Two independent builds are byte-identical, so #232's "CI check to stop it drifting" is
`./scripts/build-edit-substrate.sh && git diff --exit-code src/migrations/vendor/`.

### Runtime fit, proven

The decisive test — a `.ts` migration module, type-stripped by Node 24, importing a `.ts`
sibling that imports the vendored `.mjs` by relative path, from a directory with **no
`node_modules` anywhere up the tree** (`/tmp/node_modules` and `/node_modules` both verified
absent):

```
$ cd /tmp/final && node probe.ts
template-solo.ts      => your-org/your-repo                  | promptFiles.issue: undefined
template-workspace.ts => { source: "github", ref: "main" }   | promptFiles.issue: undefined
example-solo.ts       => acme/widget                         | promptFiles.issue: undefined
repo-defineconfig.ts  => JesusFilm/phoebe                    | promptFiles.issue: ../prompts/issues-prompt.md
```

and a full edit round-trip in the same conditions:

```
$ node migrations/probe.ts
edited ok: true | engine gone: true
comment block intact: true
```

The bundle contains no `require(`, no `from"node:…"`, and no dynamic `import()` (the single
`import()` substring in the minified file is inside a diagnostic message string).

## 10. Licence and attribution

`@babel/parser@8.0.4` and all three folded-in packages are **MIT**:

| Package | Version | Licence header |
| --- | --- | --- |
| `@babel/parser` | 8.0.4 | `Copyright (C) 2012-2014 by various contributors (see AUTHORS)` |
| `@babel/types` | 8.0.4 | `MIT License / Copyright (c) 2014-present Sebastian McKenzie and other contributors` |
| `@babel/helper-string-parser` | 8.0.0 | same |
| `@babel/helper-validator-identifier` | 8.0.4 | same |

MIT requires the copyright notice and permission notice to ride along with the redistributed
code. The packages ship **no legal comments inside their `dist`** — building with
`--legal-comments=eof` produces a byte-identical file to `--legal-comments=none` (286,210 B
both ways), so esbuild has nothing to preserve and the obligation must be met explicitly. Hence
`src/migrations/vendor/LICENSE` plus the two-line generated header in the build script above.

For contrast: vendoring ts-morph would drag Apache-2.0 in via the `typescript.js` inside
`@ts-morph/common`, adding a NOTICE-style obligation to a blob we regenerate often.

## 11. What the winner cannot express — the `manual` boundary

The locator (default export → identifier → const declaration → optional call unwrap) plus
splice covers every shape this repo ships. Below is the measured boundary. `get` is what
`getField(["repoSlug"])` returned; anything not "reachable" must produce a `manual` verdict
rather than an edit.

| Shape | Reached? |
| --- | --- |
| `const config: PhoebeUserConfig = {…}; export default config;` (both templates, all examples) | yes |
| `const config: Pick<PhoebeUserConfig,"engine"\|"workspace"> = {…}` (workspace template) | yes |
| `export const config = defineConfig({…}); export default config;` (this repo) | yes |
| `export default defineConfig({…})` (README form) | yes |
| `export default { … }` inline | yes |
| `{…} satisfies P` / `{…} as const` / `as Record<…>` | yes |
| `let config = {…}` | yes |
| quoted key (`"repoSlug": …`) | yes |
| file also contains `enum` / `namespace` / decorators / class static blocks | yes (parses fine) |

**Must refuse → `manual`:**

| Shape | What happens if you don't refuse |
| --- | --- |
| `export { default } from "./base.ts"` | no object to edit; the config lives in another file |
| `export default defineConfig(inner)` where `inner` is a reference | no object literal at the call site |
| `export default cond ? {…} : {…}` | two candidate objects, no way to pick |
| no default export at all | nothing to resolve |
| object contains a `...spread` | `getField` returns `undefined` for a key that *is* present via the spread — a migration would "helpfully" add a duplicate |
| shorthand property `{ repoSlug }` | naive read returns the **identifier text**, not the value. Check `property.shorthand` and refuse |
| computed key `{ [k]: … }` | key is unknown statically; a set would create a real duplicate |
| duplicate keys in the literal | reading returns the first; writing the wrong one silently changes nothing |
| value is a template literal, `process.env.X`, a call, or a reference (`promptFiles: pf`) | can be *read back as source text* for a detect-check, but must never be overwritten with a literal |
| `const config = {…}; config.checkCommand = "x";` later in the file | the literal is reachable but is not the whole story |

Everything in the refuse column is detectable from the same parse — they are all AST shape
tests on nodes we already have — so the refusal is cheap and precise, which is exactly what
#178's `RewriteResult`-shaped refusals over a narrow `ConfigHandle` want. Because those
refusal semantics are substrate-agnostic (settled in #232), none of this changes the
interface; it only fills in the list of conditions `docs/migrations.md` (#180) has to teach.

**What a migration author may assume**, then: a config is a single object literal reachable
from the default export through at most one identifier and one call unwrap; keys are static
identifiers or string literals; values you may *write* are string, number and boolean
literals and one-level-deep object literals; you may read any value back as source text; and
anything outside that produces a `manual` verdict, never a partial edit.

## Sources

- `npm view <pkg> version license dependencies dist.unpackedSize` for every candidate
  (registry, 2026-08-14).
- Package source in `node_modules`: `recast/lib/util.js`, `recast/main.js`,
  `recast/parsers/_babel_options.js`, `magicast/dist/builders-pgs2P7Vh.js`,
  `@ts-morph/common/dist/typescript.js`, and the `LICENSE` file of each package.
- recast README, https://github.com/benjamn/recast — the nondestructive-reprint guarantee.
- magicast README, https://github.com/unjs/magicast — documents only inline `export default {}`.
- ts-morph manipulation docs, https://ts-morph.com/manipulation/ — forgotten-node warning.
- esbuild 0.28.2, invoked as shown; all sizes are `stat -c%s` on its output.
- Node v24.19.0 for every runtime test.
