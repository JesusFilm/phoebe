---
"phoebe-agent": minor
---

Remove the nested (`repos/<owner>/<repo>/`) layout; **solo and workspace are the
only supported layouts** (#169). Nested was never used in a real deployment, and
workspace mode covers every fleet case it was meant to — and better, since
children are self-configured repos rather than config dirs the operator
hand-assembles.

Breaking, with no deprecation window:

- The surviving single-repo layout is renamed **`flat` → `solo`** everywhere —
  `InitProfile`, the discovery `mode` discriminant, help text, log lines, and
  docs — so code, docs, and `examples/` share one vocabulary.
- `phoebe init` gains an explicit `--solo` flag alongside `--workspace` /
  `--tenant`. Default behaviour is unchanged: no flag ⇒ solo.
- `phoebe add-repo` and `phoebe remove-repo` are **deleted** — both were
  nested-only. Workspace children are scaffolded by `phoebe init --tenant`, and
  registering or unregistering one is an edit to the deployment-root config the
  operator owns.
- `--repo <owner/repo>` is **deleted**, along with the config-selection ladder it
  drove. It existed only to pick a nested tenant's config. So that it fails loudly
  rather than surviving as a no-op alias, engine mode now **rejects any
  unrecognised flag** instead of forwarding it — the engine reads its flags with
  `argv.includes(...)`, so a forwarded unknown flag was silently dropped and a
  typo like `--dry-runn` would run the opposite of what was asked. `--run-once`,
  `--dry-run`, `--config`/`-c`, and `--help`/`-h` are unchanged.
- `phoebe list` and `phoebe purge` survive minus their nested arms. `list`
  enumerates workspace children and reports no tenants in solo; `purge` now
  refuses whenever a live config still claims the slug — including a _held_
  child, whose engine may still be running — and its advice names no removed
  verb.
- A deployment root that still carries a `repos/` directory **fails boot** with
  `nested \`repos/\` layout was removed in 0.4.0; use workspace mode`. That guard
  is an error message, not a mode: without it such a tree would fall through to
  solo and die on a misleading "missing required field".
- `examples/nested/` is retired; `examples/` ships solo and workspace.

`/data/repos/<owner>/<repo>/` is untouched — that is the runtime data layout for
every tenant, unrelated to the removed config-side `repos/`.
