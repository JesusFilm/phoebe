---
"phoebe-agent": minor
---

The settings catalogue: one precedence rule for env and file (#530).

- **One rule.** Every `PHOEBE_*` name is now one entry in a single catalogue (`src/settings-catalogue.ts`) holding its config path, its derived env name and its permanent aliases. The rule is: env beats file at a path, and a more specific path beats what it would inherit. The old split between an "overlay" and a list of "runtime toggles" is gone — it was never two rules, only one read from two places. The readers, `phoebe --help` and the configuration reference are all generated from the catalogue, and a test fails the build on any `PHOEBE_*` name in the tree that is neither catalogued nor declared a fact about where Phoebe runs (`PHOEBE_ENGINE_DIR`, `PHOEBE_DATA_DIR`).
- **Permanent aliases, no removal date.** `PHOEBE_AGENT` → `PHOEBE_DEFAULT_PROVIDER`, `PHOEBE_<KIND>_AGENT` → `PHOEBE_<KIND>_PROVIDER`, `PHOEBE_MAX_CONCURRENT_AGENTS` → `PHOEBE_DEPLOYMENT_SLOT_CAP`, `PHOEBE_SLOT_FLOOR_BUDGET` → `PHOEBE_DEPLOYMENT_SLOT_FLOOR_BUDGET`, `PHOEBE_RECONCILE_INTERVAL_MS` → `PHOEBE_DEPLOYMENT_RECONCILE_INTERVAL_MS`. The old names live in `.env` files, which no Phoebe command can edit, so they keep working with no end date. Set both and the canonical name wins. No migration, and no config field was renamed.
- **New `model` and `effort` config fields**, meaning "for the active provider" — the leaves `PHOEBE_MODEL` and `PHOEBE_EFFORT` have always set, now sayable in the config file too, above `defaultModels` / `defaultEfforts` and below a kind's own block.
- **Three host knobs on the `deployment` block**: `slotCap`, `slotFloorBudget` and `reconcileIntervalMs`, all optional and each beaten by its env name. A block carrying only knobs is valid and leaves compose driving start and stop; `startCommand` and `stopCommand` remain required together whenever either is named.
- **Two knobs now reach a fleet's engine children** that the supervisor's allowlist had missed: `PHOEBE_MAX_UNPRODUCTIVE_RUNS` (only its deprecated alias passed before) and `PHOEBE_<KIND>_RUN_TIMEOUT_MS`. The allowlist is derived from the catalogue, so it can no longer fall behind it.
- A custom work kind whose derived env names would collide with a catalogued name — a kind called `default`, deriving `PHOEBE_DEFAULT_PROVIDER` — is now a boot error naming both claimants.
