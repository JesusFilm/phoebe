import { describe, expect, test } from "vite-plus/test";
import { runAgent, type AgentChild, type SpawnAgent } from "./run-agent.ts";
import { PROVIDERS } from "./providers.ts";

type Listener = (...args: never[]) => void;

function makeFakeChild(): {
  child: AgentChild;
  written: string[];
  ended: () => boolean;
  emitStdout: (data: string) => void;
  emitStderr: (data: string) => void;
  close: (code: number | null) => void;
} {
  const listeners = new Map<string, Listener[]>();
  const on = (key: string, listener: Listener): void => {
    listeners.set(key, [...(listeners.get(key) ?? []), listener]);
  };
  const emit = (key: string, ...args: unknown[]): void => {
    for (const listener of listeners.get(key) ?? []) {
      (listener as (...a: unknown[]) => void)(...args);
    }
  };
  const written: string[] = [];
  let stdinEnded = false;
  const child: AgentChild = {
    stdout: { on: (event, l) => on(`stdout:${event}`, l as Listener) },
    stderr: { on: (event, l) => on(`stderr:${event}`, l as Listener) },
    stdin: {
      write: (data: string) => written.push(data),
      end: () => {
        stdinEnded = true;
      },
    },
    on: (event: string, l: Listener) => on(`child:${event}`, l),
  };
  return {
    child,
    written,
    ended: () => stdinEnded,
    emitStdout: (data) => emit("stdout:data", Buffer.from(data)),
    emitStderr: (data) => emit("stderr:data", Buffer.from(data)),
    close: (code) => emit("child:close", code),
  };
}

describe("runAgent", () => {
  test("spawns the provider command with the given cwd and env, pipes stdin, maps exit code", async () => {
    const fake = makeFakeChild();
    let spawned: {
      file: string;
      args: readonly string[];
      cwd: string;
      env: Record<string, string>;
    } | null = null;
    const spawn: SpawnAgent = (file, args, opts) => {
      spawned = { file, args, ...opts };
      queueMicrotask(() => {
        fake.emitStdout(`${JSON.stringify({ type: "result", result: "finished" })}\n`);
        fake.close(0);
      });
      return fake.child;
    };

    const result = await runAgent({
      provider: PROVIDERS.claude,
      model: "claude-m",
      prompt: "the prompt",
      cwd: "/work/tree",
      env: { PATH: "/bin", CI: "true" },
      spawn,
      log: () => {},
    });

    expect(spawned!.file).toBe("claude");
    expect(spawned!.cwd).toBe("/work/tree");
    expect(spawned!.env).toEqual({ PATH: "/bin", CI: "true" });
    expect(fake.written.join("")).toBe("the prompt");
    expect(fake.ended()).toBe(true);
    expect(result).toEqual({ exitCode: 0, resultText: "finished" });
  });

  test("keeps the last result across chunk-split lines and maps failure exit codes", async () => {
    const fake = makeFakeChild();
    const spawn: SpawnAgent = () => {
      queueMicrotask(() => {
        const line = JSON.stringify({ type: "result", result: "partial answer" });
        fake.emitStdout(line.slice(0, 10));
        fake.emitStdout(`${line.slice(10)}\n`);
        fake.close(3);
      });
      return fake.child;
    };

    const result = await runAgent({
      provider: PROVIDERS.claude,
      model: "m",
      prompt: "p",
      cwd: "/w",
      env: {},
      spawn,
      log: () => {},
    });

    expect(result).toEqual({ exitCode: 3, resultText: "partial answer" });
  });

  test("tenant prefixes log brackets as [owner/repo:provider]", async () => {
    const fake = makeFakeChild();
    const claudeTextLine = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "Reading file" }] },
    });
    const claudeToolLine = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }] },
    });
    const spawn: SpawnAgent = () => {
      queueMicrotask(() => {
        fake.emitStdout(`${claudeTextLine}\n`);
        fake.emitStdout(`${claudeToolLine}\n`);
        fake.close(0);
      });
      return fake.child;
    };
    const logged: string[] = [];
    await runAgent({
      provider: PROVIDERS.claude,
      model: "m",
      prompt: "p",
      cwd: "/w",
      env: {},
      spawn,
      log: (line) => logged.push(line),
      tenant: "JesusFilm/phoebe",
    });
    expect(logged).toEqual([
      "[JesusFilm/phoebe:claude] Reading file",
      "[JesusFilm/phoebe:claude] Bash: ls",
    ]);
  });

  // With several units in flight in one row (#423), the tenant and the provider
  // no longer say which run a line came from. The unit does.
  test("with a unit, log brackets name it beside the tenant and provider", async () => {
    const fake = makeFakeChild();
    const claudeTextLine = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "Reading file" }] },
    });
    const spawn: SpawnAgent = () => {
      queueMicrotask(() => {
        fake.emitStdout(`${claudeTextLine}\n`);
        fake.emitStderr("cli warning\n");
        fake.close(0);
      });
      return fake.child;
    };
    const logged: string[] = [];
    await runAgent({
      provider: PROVIDERS.claude,
      model: "m",
      prompt: "p",
      cwd: "/w",
      env: {},
      spawn,
      log: (line) => logged.push(line),
      tenant: "JesusFilm/phoebe",
      unit: "issues issue:88",
    });
    expect(logged).toEqual([
      "[JesusFilm/phoebe:claude][issues issue:88] Reading file",
      "[JesusFilm/phoebe:claude:stderr][issues issue:88] cli warning",
    ]);
  });

  test("without tenant, log brackets use bare provider name", async () => {
    const fake = makeFakeChild();
    const claudeTextLine = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "Reading file" }] },
    });
    const spawn: SpawnAgent = () => {
      queueMicrotask(() => {
        fake.emitStdout(`${claudeTextLine}\n`);
        fake.close(0);
      });
      return fake.child;
    };
    const logged: string[] = [];
    await runAgent({
      provider: PROVIDERS.claude,
      model: "m",
      prompt: "p",
      cwd: "/w",
      env: {},
      spawn,
      log: (line) => logged.push(line),
    });
    expect(logged).toEqual(["[claude] Reading file"]);
  });

  test("null exit code (signal kill) maps to failure", async () => {
    const fake = makeFakeChild();
    const spawn: SpawnAgent = () => {
      queueMicrotask(() => fake.close(null));
      return fake.child;
    };
    const result = await runAgent({
      provider: PROVIDERS.codex,
      model: "m",
      prompt: "p",
      cwd: "/w",
      env: {},
      spawn,
      log: () => {},
    });
    expect(result.exitCode).toBe(1);
  });
});
