// Spawn an agent CLI for one work unit and stream its output. The child's
// argv/stdin come from the provider; the env is the caller-built allowlist
// (see ../agent-env.ts) — never the orchestrator's full process.env.

import { spawn as nodeSpawn } from "node:child_process";
import { DEFAULT_PIPELINE_NAME } from "../config-schema.ts";
import { unitTag } from "../unit-event.ts";
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
  /** Reasoning-effort level, when the deployment configured one. */
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
  /**
   * The deployment's name, opening the pipeline bracket the engine's own lines
   * carry: `[<deployment>:owner/repo:work][issues issue:88][cursor]` (#686).
   * Defaults to the tenant's slug, as the engine's own default does.
   */
  deployment?: string;
  /**
   * Repo slug (`owner/repo`). With it, every line opens with the engine's
   * pipeline bracket and the provider moves to a bracket of its own, last:
   * `[<deployment>:owner/repo:work][cursor]`. Without it the line is
   * `[cursor]` alone.
   */
  tenant?: string;
  /**
   * Which pipeline spawned this agent, the bracket's last segment (#675): a
   * tenant runs one engine process per pipeline (#418/#420), so without it two
   * pipelines on the same provider pour their agent output into one stream with
   * nothing to tell them apart. Defaults to `work`.
   */
  pipeline?: string;
  /**
   * The unit this agent is working, `<kind> <ref>`, as a bracket between the
   * pipeline's and the provider's:
   * `[<deployment>:owner/repo:work][issues issue:88][cursor]`. With several units
   * in flight in one pipeline (#423), the tenant, pipeline and provider no longer
   * say which run a line came from. The same shape `ctx.log` and the engine's git
   * and install output use, so one unit's whole stream greps as one thing.
   */
  unit?: string;
}): Promise<AgentRunResult> {
  const { provider, model, effort, prompt, cwd, env } = opts;
  const spawn = opts.spawn ?? defaultSpawn;
  const log = opts.log ?? ((line: string) => console.log(line));
  // Everything in front of the provider bracket is the engine's own prefix, so an
  // agent line differs from an engine line on its pipeline only by that last
  // bracket (#686).
  const pipeline = opts.pipeline ?? DEFAULT_PIPELINE_NAME;
  const unit = opts.unit ? `[${opts.unit}]` : "";
  const head = opts.tenant
    ? `${unitTag(opts.deployment ?? opts.tenant, opts.tenant, pipeline)}${unit}`
    : "";
  const out = `${head}[${provider.name}]`;
  const err = `${head}[${provider.name}:stderr]`;

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
          if (text) log(`${out} ${text}`);
        } else if (event.type === "tool_call") {
          log(`${out} ${event.name}: ${event.args}`);
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
      if (text) log(`${err} ${text}`);
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
