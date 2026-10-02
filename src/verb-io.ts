// The two bindings of a verb's line sinks that the engine itself provides.
//
// `VerbIo` is a contract type (#552): a host verb writes its progress through
// it and never reaches `process.stdout`, so the same verb can stream into a
// terminal, into a companion's `run:line` events, or into a test's array. The
// bindings live here rather than in each verb module because the CLI layer
// wants the same one six times over, and a verb module that named
// `process.stdout` would fail the layering guard in host-verbs.test.ts.

import type { VerbIo } from "./contracts/verb-io.ts";

/**
 * Write each line to the real streams, newline-terminated. The CLI wrappers'
 * binding — this is what makes `phoebe stop` print.
 */
export const PROCESS_IO: VerbIo = {
  stdout: (line) => process.stdout.write(`${line}\n`),
  stderr: (line) => process.stderr.write(`${line}\n`),
};

/**
 * Drop every line. The default a verb falls back to when its caller passed no
 * sink: silence is the honest default for an in-process call, where there is no
 * terminal to write to and a stray write would land in whatever stream the host
 * process happens to own.
 */
export const SILENT_IO: VerbIo = {
  stdout: () => {},
  stderr: () => {},
};
