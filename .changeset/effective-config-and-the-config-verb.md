---
"phoebe-agent": minor
---

Effective config and the `phoebe config` verb (#531).

- **A new read-only verb.** `phoebe config` prints every setting this deployment runs on, each with its value and where that value came from — the ladder resolved, not restated. `--json` emits the same object for a script or a console. Nothing is hidden: defaults print, and each pipeline's kinds print the values they will actually use, inherited ones included.
- **Six sources, one word each.** A leaf says `default`, `file`, `alias` (a permanent older name like `PHOEBE_AGENT`), `overlay` (a `PHOEBE_*` variable), `derived` (computed from another setting), or `inherited` from a shallower path. There is no `toggle`: after #530 there is one precedence rule, so env is one source and reads the same way everywhere.
- **What lost rides along.** Every leaf lists the values it beat, so "why isn't my config file value taking effect" is answered on the line above rather than reconstructed. That includes the provider-mismatch guard, which silences a kind block speaking for a different provider — until now it fired invisibly.
- **Bootstrapper-only fields are in the view**, tagged `reader: "bootstrapper"`: `engine`, `workspace`, `configDir`, `gitIdentity`, `reporting`, and the `deployment` block. An inline work-kind definition renders as a summary string marked `opaque`, since its `fetch` and `run` do not survive JSON.
- **A separate `env` section reports presence and location, never a value** — `GH_TOKEN`, each provider key, the App key, and every key a work kind declared, each as `{ present, from }` where `from` is `tenantEnv`, `rootEnv` or `process`. Confirming a secret arrived no longer means printing it.
- **Top-level `warnings`** index the deprecated aliases a tenant is using, so a console need not walk the tree to find them.
- **Per-tenant failure.** Run against a workspace root and every tenant reports; one whose config will not load is a single row carrying its error, and the exit code turns non-zero only when no tenant loaded at all.
- The leaf type lives in `phoebe-agent/contracts`, so a console can name a source without loading the engine.
