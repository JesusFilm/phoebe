# Phoebe config seam

The vocabulary for how a `phoebe.config.ts` becomes the shape the engine
actually runs against, and how that shape crosses the boot → engine child
process boundary.

## Language

**Authored config**:
The user-facing shape of `phoebe.config.ts` (`PhoebeUserConfig`, `src/config/types.ts`) — only the five required fields plus whatever optional fields a repo chooses to override.
_Avoid_: user config, raw config

**Resolved configuration**:
`PhoebeConfig` — an authored config with defaults and the `PHOEBE_*` env overlay applied, plus resolved-only fields. What the engine actually runs against.
_Avoid_: resolved config (fine informally, but prefer the full term in docs), final config

**Resolved-only field**:
A `PhoebeConfig` field with no authored counterpart — derived rather than user-settable. Today the only one is `paths` (`PathsConfig`), derived from `repoSlug` and the deployment data base.
_Avoid_: derived field

**Launch snapshot**:
The versioned, non-secret JSON document `formatResolvedConfiguration` writes and `parseResolvedConfigurationSnapshot` reads (`src/config/snapshot.ts`) — boot resolves once and hands it to a supervised child via `BOOTSTRAP_RESOLVED_CONFIG_ENV`, carrying both the resolved configuration and the engine source as one atomic unit. A directly-invoked engine (no boot) has no snapshot and resolves the authored files itself instead.
_Avoid_: config snapshot, resolved snapshot
