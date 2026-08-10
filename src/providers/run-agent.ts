// Spawn an agent CLI for one work unit and stream its output. The child's
// argv/stdin come from the provider; the env is the caller-built allowlist
// (see ../agent-env.ts) — never the orchestrator's full process.env.

import { spawn as nodeSpawn } from "node:child_process";
import type { Provider } from "./types.ts";

export type AgentRunResult = {
  exitCode: number;
  /** Last `result` event the provider emitted, if any. */
  resultText: string;
};

/** Minimal child-process surface so tests can inject a fake spawn. */
export type AgentChild = {
  stdout: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown };
  stderr: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown };
  stdin: { write(data: string): unknown; end(): unknown };
  on(event: "error", listener: (err: Error) => void): unknown;
  on(event: "close", listener: (code: number | null) => void): unknown;
  /** Terminate the child (SIGTERM → escalated SIGKILL by the run-timeout, #72). */
  kill?(signal?: NodeJS.Signals): boolean;
};

/** Grace between SIGTERM and SIGKILL when a run deadline aborts the agent (#72). */
export const AGENT_KILL_GRACE_MS = 5_000;

export type SpawnAgent = (
  file: string,
  args: readonly string[],
  opts: { cwd: string; env: Record<string, string> },
) => AgentChild;

const defaultSpawn: SpawnAgent = (file, args, opts) =>
  nodeSpawn(file, args, { ...opts, stdio: ["pipe", "pipe", "pipe"] });

export async function runAgent(opts: {
  provider: Provider;
  model: string;
  /** Claude-CLI-specific (#155) — threaded to `buildCommand` the same way `model` is; other providers ignore it. */
  effort?: string;
  prompt: string;
  cwd: string;
  env: Record<string, string>;
  spawn?: SpawnAgent;
  log?: (line: string) => void;
  /**
   * Abort the run — kills the agent child (SIGTERM, escalated to SIGKILL after a
   * short grace since the vendored `cursor-agent` has no cooperative-drain
   * handshake). The run-timeout (#72) fires this when the whole-unit budget
   * expires; the `close` handler then settles the promise as usual.
   */
  signal?: AbortSignal;
}): Promise<AgentRunResult> {
  const { provider, model, effort, prompt, cwd, env } = opts;
  const spawn = opts.spawn ?? defaultSpawn;
  const log = opts.log ?? ((line: string) => console.log(line));

  const command = provider.buildCommand({ prompt, model, effort });
  const [file, ...args] = command.argv;
  if (!file) {
    throw new Error(`Provider "${provider.name}" built an empty command.`);
  }

  return new Promise<AgentRunResult>((resolve, reject) => {
    const child = spawn(file, args, { cwd, env });
    let resultText = "";
    let stdoutBuffer = "";

    const onAbort = (): void => {
      if (!child.kill) return;
      child.kill("SIGTERM");
      const grace = setTimeout(() => child.kill?.("SIGKILL"), AGENT_KILL_GRACE_MS);
      // Don't let the escalation timer keep the loop alive past the child's exit.
      (grace as unknown as { unref?: () => void }).unref?.();
    };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    const handleLine = (line: string): void => {
      for (const event of provider.parseStreamLine(line)) {
        if (event.type === "text") {
          const text = event.text.trim();
          if (text) log(`[${provider.name}] ${text}`);
        } else if (event.type === "tool_call") {
          log(`[${provider.name}] ${event.name}: ${event.args}`);
        } else {
          resultText = event.result;
        }
      }
    };

    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) handleLine(line);
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString().trim();
      if (text) log(`[${provider.name}:stderr] ${text}`);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (stdoutBuffer) handleLine(stdoutBuffer);
      resolve({ exitCode: code ?? 1, resultText });
    });

    if (command.stdin !== undefined) {
      child.stdin.write(command.stdin);
    }
    child.stdin.end();
  });
}
