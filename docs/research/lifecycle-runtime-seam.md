# Lifecycle runtime seam: design record

Design record, 2026-08-17. Context: issue #189 — _Deployment run options from the config
file (lifecycle runtime seam)_. Blocked by #186 (phoebe stop) and #187 (phoebe start),
whose concrete implementations produced the seam this design is drawn against.

## Background

`phoebe start` and `phoebe stop` hardcode `docker compose`. That was a deliberate
deferral: an abstraction with one implementation guesses at what varies and is usually
wrong. Issue #189 was opened to hold the intent and record the three shapes the commands
refuse to serve:

1. **No Docker / different container runtime.** E.g. `podman compose` rather than
   `docker compose`. Deliberately not handled by a fallback — a half-working abstraction
   over runtimes the engine cannot test is worse than none.
2. **Supervised directly without a container.** E.g. `phoebe boot` managed by `systemd`,
   with no container at all. The compose discovery path does not apply.
3. **Different compose file or invocation.** The scaffolded layout assumed by
   `resolveDeploymentCompose` (`container/compose.yml`, `.env` one level above) does not
   match every deployment.

With both #186 and #187 merged, the seam now exists in concrete form and the design can
be drawn against it rather than anticipated ahead of it.

## What the config declares

**Decision: literal shell command strings, not a runtime name.**

The field is a `deployment` block on `PhoebeUserConfig`:

```ts
deployment?: {
  startCommand: string;
  stopNowCommand?: string;
  stopCommand: string;
};
```

When `deployment` is absent the current compose driver runs unchanged — existing
deployments are unaffected. When `deployment` is present the lifecycle commands execute
the literal strings and report success or failure based on exit code (0 = success,
non-zero = failure).

**Why literal strings, not a runtime name.** The existing toolchain fields
(`installCommand`, `checkCommand`, `testCommand`, `readyCommand`) are all literal shell
strings — the config declares what to run, not which ecosystem to use. A `runtime: "podman"
| "systemd"` field would require the engine to encode knowledge of every runtime and its
flags, and adding a new shape would require an engine release. Literal commands put
that knowledge where it belongs: with the operator who knows the runtime. It is also more
flexible — `podman compose -f container/compose.yml up -d` and `systemctl start phoebe`
are both expressible without a runtime registry.

The `stopNowCommand` field is optional. When present it is used by `phoebe stop --now`
in place of `stopCommand`. When absent, `phoebe stop --now` falls back to `stopCommand`
(the operator encodes the short-grace semantics in their stop command, or accepts that
`--now` behaves identically to a normal stop for their runtime).

## Runtime-general vs compose-specific behaviours

### General — preserved for both the compose driver and the literal-command path

| Behaviour                                        | Notes                                                                                                                                                                                |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **In-container refusal** (`assertHostLifecycle`) | Start/stop are host-side in every shape — even a systemd-managed deployment is started from the host, not from within the service. The guard stays.                                  |
| **Exit-code semantics**                          | 0 = success, non-zero = failure. Universal.                                                                                                                                          |
| **`--now` flag concept**                         | Encodes "abandon the in-flight unit with a short grace". For custom runtimes the operator encodes this in `stopNowCommand` (or accepts that `--now` is equivalent to a normal stop). |

### Compose-specific — not generalized to the literal-command path

| Behaviour                                                | Why it stays compose-only                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Env-file discovery (`--env-file`)**                    | An artefact of Compose needing the deployment `.env` to substitute template variables. Other runtimes source their env differently (systemd unit files, podman quadlets, etc.).                                                                                                                                                                                                                  |
| **`container/compose.yml` path resolution**              | The scaffold layout is a compose convention.                                                                                                                                                                                                                                                                                                                                                     |
| **State queries (`docker compose ps -a --format json`)** | Structured JSON probe is Compose-specific. Other runtimes have no equivalent portable probe.                                                                                                                                                                                                                                                                                                     |
| **"Already running" pre-check before `phoebe start`**    | Requires the state query above. Lost on the literal-command path — `startCommand` should be idempotent where the operator cares.                                                                                                                                                                                                                                                                 |
| **"Already stopped" pre-check before `phoebe stop`**     | Same.                                                                                                                                                                                                                                                                                                                                                                                            |
| **"Exited immediately" post-start probe**                | Requires the state query and the settle wait. Lost on the literal-command path — `startCommand` should verify the service is up before exiting 0, or the operator accepts that a fast-exit failure is not detected.                                                                                                                                                                              |
| **Killed-mid-run detection (exit code 137)**             | SIGKILL on a Docker container produces exit code 137. This is Docker-specific, not a general property of all runtimes. A `systemctl stop` either completes or times out and kills; exit code 137 does not appear.                                                                                                                                                                                |
| **`--build` flag for image rebuild**                     | Compose-specific. Makes no sense for a systemd-managed process or a custom runtime that has no image. The `--build` flag is not forwarded to `startCommand`; when a literal deployment is active, `--build` is a no-op and the engine logs a warning to that effect. An operator who needs a rebuild encodes it in `startCommand` itself or a separate build step. Ticket B must test this case. |
| **`MISSING_ENV_MESSAGE` / required-variable detection**  | An artefact of Compose's `required variable` error format. Not emitted on the literal-command path.                                                                                                                                                                                                                                                                                              |
| **Drain grace encoding in the stop command**             | For compose the engine passes `-t 3600` to `docker compose stop`. For a literal stop command the operator encodes the timeout themselves (e.g. `systemctl stop --timeout=3600 phoebe`).                                                                                                                                                                                                          |

## In-container refusal

The refusal holds for all shapes. `phoebe start` and `phoebe stop` are host-side
operator commands in every deployment topology:

- Docker Compose: obvious — there is no Docker socket inside the container.
- Podman Compose: same structure.
- Systemd: the managed service is on the host; `systemctl start` is a host command.

`assertHostLifecycle` is not compose-specific. It stays on the common path before any
runtime branching.

## What changes and what does not

**Unchanged by adding the `deployment` field:**

- All existing compose-based deployments (field absent → compose driver runs as today).
- The `start`/`stop` CLI interface (`--help`, `--build`, `--now`, argument parsing, exit
  codes).
- The in-container refusal guard.
- Docker availability check — omitted on the literal-command path (the operator controls
  what binary is invoked).

**Added for the literal-command path:**

- When `deployment` is present, `phoebe start` spawns `startCommand` via the shell
  (`/bin/sh -c`), inherits stdio, and reports success or failure by exit code.
- When `deployment` is present, `phoebe stop` spawns `stopCommand` (or `stopNowCommand`
  for `--now`), inherits stdio, and reports success or failure by exit code.
- Execution context for literal commands: the working directory is the repo root (same
  as the engine process); the child inherits `process.env` from the engine; no `.env`
  file is loaded (env-file discovery is compose-specific, see table above).
- Validation at config load: `startCommand` and `stopCommand` are required together;
  `stopNowCommand` is optional. Blank strings are rejected (`command.trim().length === 0`
  rejects whitespace-only values, not just empty strings, because `/bin/sh -c "   "`
  exits 0 and would silently succeed without doing anything).

**Dropped for the literal-command path** (the operator bears responsibility):

- Pre-checks (already running / already stopped).
- Post-start probe (exited immediately).
- Killed-mid-run detection.
- Env-file discovery and the `--env-file` flag.
- `--build` flag forwarding.
- Missing-env detection.

## Follow-up tickets

Two buildable tickets come out of this design:

**Ticket A — Add `deployment` to `PhoebeUserConfig`.**

- Add the `deployment?: { startCommand, stopCommand, stopNowCommand? }` block to the
  `PhoebeUserConfig` type in `src/config-schema.ts`.
- Add validation in `validateUserConfig`: require both `startCommand` and `stopCommand`
  when the block is present; reject blank strings (`command.trim().length === 0` —
  whitespace-only values must fail, not just empty strings); validate that
  `stopNowCommand`, if present, is non-blank by the same rule.
- Document the field in `docs/configuration.md` alongside the other operator-facing
  config fields.

**Ticket B — Wire `phoebe start` and `phoebe stop` to the `deployment` block.**

- In `runStart` / `runStartCli` (`src/start.ts`): when `deployment.startCommand` is
  present in the loaded config, skip the compose resolve path, skip docker-on-PATH
  check, skip all state queries, and invoke `startCommand` via `/bin/sh -c` with
  inherited stdio. Exit code 0 → return the existing `StartOutcome` success value;
  non-zero → throw (or return) the established failure result that `runStartCli`
  already maps to a non-zero CLI exit code. The CLI exit-code mapping is unchanged.
- In `runStop` / `runStopCli` (`src/stop.ts`): when `deployment.stopCommand` is
  present, skip the compose resolve path, skip docker-on-PATH check, skip all state
  queries, and invoke `stopCommand` (or `stopNowCommand` for `--now`) via
  `/bin/sh -c`. Exit code 0 → return the existing `StopOutcome` success value;
  non-zero → throw (or return) the established failure result. The CLI exit-code
  mapping is unchanged.
- The in-container refusal guard runs before the runtime branch in both commands.
- Unit tests cover: literal-command happy path, non-zero exit → failure, in-container
  refusal still fires, (for stop) `--now` falling back to `stopCommand` when
  `stopNowCommand` is absent, and `--build` passed with a literal deployment logs a
  warning and is otherwise a no-op (the command still runs, build is not triggered).

Note: ticket B reads the loaded config, which means both `runStart` and `runStop` need
to accept the resolved config (or a loaded-config read) as a dependency alongside their
existing deps. The current signatures do not pass a config — they only read the
filesystem to discover `container/compose.yml`. Ticket B must thread the config through.
The same dependency injection pattern used for `CommandRunner` and `exists` applies.
