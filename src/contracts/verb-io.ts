// The two line sinks a host verb writes through. A verb never reaches
// `process.stdout` itself: the CLI binds these to the real streams, the
// companion binds them to the `run:line` events its renderer draws (#527 §2),
// and a test binds them to an array.
//
// Lines arrive without a trailing newline — whoever binds the sink decides what
// a line break is. The CLI appends "\n"; an event stream sends the string.

export type VerbIo = {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
};
