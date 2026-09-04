// Attributable child output (#423).
//
// One engine process used to run one unit, so a child that inherited the
// engine's stdout was unambiguous: whatever it printed, it printed on behalf of
// the only thing running. A pipeline with `concurrency` above 1 breaks that.
// Two `git fetch`es and two installs write to one terminal, their lines
// interleave, and nothing in the stream says which unit produced which — the
// operator reads a merge conflict and cannot tell whose it is.
//
// So the inheriting children stop inheriting. They pipe, and every line they
// produce is stamped with the unit it belongs to before the engine prints it.
// The two callers are the git runner (see `withOutputPrefix` in git-model.ts)
// and the configured install command, below.

import { spawn } from "node:child_process";

/**
 * The lines worth printing from a chunk of captured child output.
 *
 * Blank lines go: a stamped blank line is a prefix and nothing else, which is
 * noise in a shared stream rather than the spacing it was in a terminal. A
 * trailing `\r` goes with them — git writes CRLF when it thinks it is talking
 * to a terminal, and the stray carriage return would land mid-log.
 */
export function outputLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.replace(/\r$/, ""))
    .filter((line) => line.trim().length > 0);
}

/** A line sink that stamps `prefix` on everything written through it. */
export function prefixedWriter(
  prefix: string,
  write: (line: string) => void,
): (line: string) => void {
  return (line) => write(`${prefix} ${line}`);
}

/**
 * Run a shell command to completion, handing `echo` each line it prints on
 * either stream as it prints it.
 *
 * Async, unlike the git model's captured calls, and for one reason: this runs
 * the tenant's install command, which can take minutes. Buffering it until it
 * exits would leave an operator watching a hung install with nothing on screen,
 * which is exactly the case where the output matters most. The lines stay live;
 * only their attribution is new.
 *
 * Rejects on a non-zero exit, on a spawn failure, and on the timeout — the
 * contract the `execSync` call this replaced had, since a failed install must
 * still fail its unit.
 */
export function runCommandPrefixed(opts: {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  echo: (line: string) => void;
}): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(opts.command, {
      shell: true,
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    // One buffer per stream: a line is only complete once its newline arrives,
    // and a chunk boundary lands mid-line often enough to matter.
    const buffers = { stdout: "", stderr: "" };
    const take = (stream: "stdout" | "stderr", chunk: Buffer | string): void => {
      const pending = buffers[stream] + chunk.toString();
      const lines = pending.split("\n");
      buffers[stream] = lines.pop() ?? "";
      for (const line of lines) {
        for (const complete of outputLines(line)) opts.echo(complete);
      }
    };
    const flush = (): void => {
      for (const stream of ["stdout", "stderr"] as const) {
        for (const line of outputLines(buffers[stream])) opts.echo(line);
        buffers[stream] = "";
      }
    };

    // `close` waits for every pipe to reach EOF, and a command that leaves a
    // background process holding one never gets there. So settling is guarded
    // and reachable three ways: the clean `close`, the timeout, and an `exit`
    // that has not produced a `close` shortly after — the last of which is what
    // an install spawning a daemon looks like, and what the synchronous runner
    // this replaced returned from.
    let settled = false;
    const finish = (outcome: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      flush();
      child.stdout?.destroy();
      child.stderr?.destroy();
      outcome();
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() =>
        reject(new Error(`Command timed out after ${opts.timeoutMs}ms: ${opts.command}`)),
      );
    }, opts.timeoutMs);
    timer.unref?.();

    child.stdout?.on("data", (chunk: Buffer) => take("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => take("stderr", chunk));
    child.on("error", (error) => finish(() => reject(error)));

    const settleWithCode = (code: number | null): void =>
      finish(() =>
        code === 0
          ? resolve()
          : reject(new Error(`Command failed with exit ${code ?? 1}: ${opts.command}`)),
      );
    child.on("close", settleWithCode);
    child.on("exit", (code) => {
      const grace = setTimeout(() => settleWithCode(code), ORPHANED_PIPE_GRACE_MS);
      grace.unref?.();
    });
  });
}

/** How long an exited command's pipes may stay open before we stop waiting. */
const ORPHANED_PIPE_GRACE_MS = 1_000;
