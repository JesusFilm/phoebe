// The container's own output, kept in memory for a paired device (map #690).
//
// The container is log-stateless by decision (#73): nothing it prints goes to
// its volume, and Docker holds what the host collects. A device over the API
// has no Docker to ask, so the bootstrapper keeps the last lines here — the
// same bound the companion keeps per followed install — and serves them off
// `GET /api/logs` (remote-api.ts). Nothing here reaches disk, and nothing here
// redacts: the lines are kept as printed, and the listener redacts on the way
// out (redact-output.ts), so a value learned after a line was printed still
// covers it.
//
// Two sources, handled two ways. The bootstrapper's own lines are seen by
// wrapping `process.stdout.write` and `process.stderr.write`: the bytes still
// go where they went, and a copy is cut into lines here. Children are piped
// through (spawn-engine.mjs): with inherited stdio their lines never pass this
// process, so the spawner hands each chunk to a source here, and the source
// writes whole lines on to the real descriptor — whole lines, so two children
// printing at once cannot tear each other mid-line on the way to Docker, which
// inherited stdio guaranteed at the kernel and a pipe through one process
// otherwise would not.

import { StringDecoder } from "node:string_decoder";
import { MAX_LOG_LINES } from "../src/contracts/container-logs.ts";

/** A partial line past this is taken as a line: a runaway writer must not grow memory. */
export const MAX_PARTIAL_BYTES = 64 * 1024;

/** One child's two streams, as the spawner feeds them. */
export type OutputSource = {
  write: (stream: "stdout" | "stderr", chunk: string | Uint8Array) => void;
  /** The child is gone: a last partial line is a line. */
  end: () => void;
};

export type OutputTap = {
  /** The lines held, oldest first, at most `max`. */
  lines: () => string[];
  /** Every line as it is kept. Returns the unsubscribe. */
  onLine: (listener: (line: string) => void) => () => void;
  /** A source for one child: lines go to the real descriptor and into the ring. */
  source: () => OutputSource;
  /**
   * Wrap the process's own stdout and stderr so what the bootstrapper prints
   * is kept too. Returns the undo. The real write is captured here, and it is
   * what a child's lines are written through, so a wrapped stream never sees
   * a child's bytes twice.
   */
  install: () => () => void;
};

type Streams = { stdout: NodeJS.WriteStream; stderr: NodeJS.WriteStream };

export function createOutputTap(
  opts: { max?: number; streams?: Streams; maxPartialBytes?: number } = {},
): OutputTap {
  const max = opts.max ?? MAX_LOG_LINES;
  const maxPartial = opts.maxPartialBytes ?? MAX_PARTIAL_BYTES;
  const streams = opts.streams ?? { stdout: process.stdout, stderr: process.stderr };
  const held: string[] = [];
  const listeners = new Set<(line: string) => void>();

  // The real writes, bound once, so a child's bytes go to the descriptor and
  // not back through the wrapper that feeds the ring.
  const real = {
    stdout: streams.stdout.write.bind(streams.stdout),
    stderr: streams.stderr.write.bind(streams.stderr),
  };

  const keep = (line: string): void => {
    held.push(line);
    if (held.length > max) held.splice(0, held.length - max);
    for (const listener of listeners) {
      try {
        listener(line);
      } catch {
        // A listener is a stream; a dead one drops itself on close.
      }
    }
  };

  /** One stream's line cutter: a decoder for split multi-byte characters, and the tail. */
  const cutter = (
    onLine: (line: string) => void,
  ): { feed: (chunk: string | Uint8Array) => void; flush: () => void } => {
    const decoder = new StringDecoder("utf8");
    let rest = "";
    return {
      feed(chunk) {
        rest += typeof chunk === "string" ? chunk : decoder.write(Buffer.from(chunk));
        let newline = rest.indexOf("\n");
        while (newline !== -1) {
          onLine(rest.slice(0, newline).replace(/\r$/, ""));
          rest = rest.slice(newline + 1);
          newline = rest.indexOf("\n");
        }
        if (rest.length > maxPartial) {
          onLine(rest);
          rest = "";
        }
      },
      flush() {
        rest += decoder.end();
        if (rest.length > 0) onLine(rest);
        rest = "";
      },
    };
  };

  return {
    lines: () => [...held],
    onLine(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    source() {
      // One cutter per stream: a child's stderr tail must not be glued onto
      // its stdout's next line.
      const out = cutter((line) => {
        real.stdout(`${line}\n`);
        keep(line);
      });
      const err = cutter((line) => {
        real.stderr(`${line}\n`);
        keep(line);
      });
      return {
        write: (stream, chunk) => (stream === "stdout" ? out : err).feed(chunk),
        end: () => {
          out.flush();
          err.flush();
        },
      };
    },
    install() {
      const out = cutter(keep);
      const err = cutter(keep);
      const wrap = (
        stream: NodeJS.WriteStream,
        write: (chunk: string | Uint8Array, ...rest: unknown[]) => boolean,
        feed: (chunk: string | Uint8Array) => void,
      ): (() => void) => {
        const wrapped = (chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
          feed(chunk);
          return write(chunk, ...rest);
        };
        stream.write = wrapped as typeof stream.write;
        return () => {
          if (stream.write === (wrapped as typeof stream.write)) {
            stream.write = write as typeof stream.write;
          }
        };
      };
      const undoOut = wrap(streams.stdout, real.stdout as never, out.feed);
      const undoErr = wrap(streams.stderr, real.stderr as never, err.feed);
      return () => {
        undoOut();
        undoErr();
        out.flush();
        err.flush();
      };
    },
  };
}
