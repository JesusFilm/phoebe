# Host verbs are an in-process seam, not a CLI-only surface

`src/cli.ts` has carried a stance since v1. The CLI is the only programmatic
surface, there is no exported `run(config)`, and every consumer goes through one
load/resolve/install pipeline. The desktop companion (#522, #527) breaks the
assumption under it. Electron main ships inside the package at the same version
as the renderer, and it has to run `init`, `start`, `stop`, `upgrade`, `migrate`
and `doctor` on the operator's behalf, streaming their lines into the window and
rendering what each one decided.

So the stance is amended rather than dropped. Each host verb now exists twice.
`run<Verb>(opts)` takes its seams as arguments, writes through an injected
`VerbIo`, and returns a typed outcome from `phoebe-agent/contracts`. The
`run<Verb>Cli` wrapper beside it parses argv, prints, and sets the exit code. The
verb functions are an internal seam for a caller that ships the same package,
not a public API. The export map still offers `.` and `./contracts` only, and
nothing exports an engine entry point.

The alternative was for Electron main to shell out to the package's own
`bin.mjs`: a second Node process, the copy-out-of-`node_modules` dance the
launcher performs, and stdout parsing to recover a result the verb already knew.
Rejected on all three counts.

## Consequences

- A verb that reaches `process.stdout`, `process.argv` or `process.exitCode`
  works from a terminal and misbehaves everywhere else, so
  `src/host-verbs.test.ts` fails on any such reference outside a `run<Verb>Cli`
  wrapper. `process.env` and `process.cwd()` stay allowed. They are ambient
  facts, and every verb takes an override for them.
- Outcome types live in `src/contracts/`, away from the code that produces them,
  so a renderer can name a result without loading the Compose driver or the
  migration registry. `HostVerb` and `VerbOutcome` keep the mapping closed.
- A silent io is the default for an in-process call. The CLI binds the real
  streams. A verb called with no io prints nothing rather than writing into
  whatever stream the host process happens to own.
- Reversing this is now costly, because `apps/desktop` will depend on these
  signatures.
