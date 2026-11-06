// Running a row's tool. The rows only read, but a package manager can still
// hang on a registry, so every run has a deadline, and output is collected in
// full rather than streamed because every command a row runs prints one JSON
// document (or one JSON value per line) that is only useful whole.

import { spawn } from "node:child_process";
import type { RunTool, ToolOutput } from "./row.ts";

/** Five minutes: an audit is one registry round trip, a listing none. */
export const TOOL_TIMEOUT_MS = 5 * 60_000;

export type ToolRunnerOptions = {
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
};

/**
 * A `RunTool` that spawns the command. Corepack's download prompt is turned
 * off, since nobody is there to answer it: a project that pins its manager in
 * `packageManager` gets that version fetched rather than a hung run.
 */
export function createToolRunner(opts: ToolRunnerOptions): RunTool {
  const timeoutMs = opts.timeoutMs ?? TOOL_TIMEOUT_MS;
  const env = { ...opts.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" };
  return (command, args, cwd) =>
    new Promise<ToolOutput>((resolve) => {
      const child = spawn(command, [...args], {
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: timeoutMs,
        signal: opts.signal,
      });
      const stdout: Buffer[] = [];
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString("utf8")).slice(-2_000);
      });
      const shown = `${command} ${args.join(" ")}`;
      child.once("error", (error: NodeJS.ErrnoException) => {
        resolve(
          error.code === "ENOENT"
            ? { ok: false, missing: true, problem: `${command} is not installed` }
            : { ok: false, missing: false, problem: `${shown} failed: ${error.message}` },
        );
      });
      child.once("close", (code, signal) => {
        if (code === null) {
          resolve({ ok: false, missing: false, problem: `${shown} was killed by ${signal}` });
          return;
        }
        const out = Buffer.concat(stdout).toString("utf8");
        if (code !== 0 && out.trim().length === 0) {
          const last = stderr.trim().split("\n").pop();
          resolve({
            ok: false,
            missing: false,
            problem: `${shown} exited ${code}${last ? `: ${last}` : ""}`,
          });
          return;
        }
        resolve({ ok: true, code, stdout: out });
      });
    });
}
