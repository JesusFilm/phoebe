// The one home for the bootstrapper's child-process signal plumbing.
//
// Both the published bin launcher (bin.mjs) and `phoebe boot` (boot.ts) exec a
// `node <entry>` child with inherited stdio and need the same behaviour: forward
// the stop signals so a container SIGTERM reaches the real process (the engine's
// graceful drain), then die however the child died. Keeping it in one module
// stops the two callers from drifting on the fiddly exit/re-raise handling.
//
// Plain JS, not TypeScript: bin.mjs runs first, still inside node_modules, where
// Node 24 refuses to type-strip `.ts`. boot.ts imports it untyped (same as
// materialize.mjs) from the materialized copy outside node_modules.

import { spawn } from "node:child_process";

/**
 * Spawn `node <entry> <args...>` with inherited stdio, forwarding SIGINT/SIGTERM
 * to it, and propagate its exit: re-raise a killing signal so this process dies
 * the same way, or exit with the child's code. Returns the child handle.
 *
 * `onSpawnError` overrides the default handling of a spawn failure (print
 * `[phoebe] <message>` and exit 1); callers that want to surface it differently
 * pass their own.
 */
export function spawnEngine(entry, args, { onSpawnError } = {}) {
  const child = spawn(process.execPath, [entry, ...args], { stdio: "inherit" });

  const forwarders = new Map();
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const forward = () => child.kill(signal);
    forwarders.set(signal, forward);
    process.on(signal, forward);
  }
  const clearForwarders = () => {
    for (const [signal, forward] of forwarders) process.off(signal, forward);
  };

  child.on("error", (error) => {
    clearForwarders();
    if (onSpawnError) {
      onSpawnError(error);
      return;
    }
    console.error(`[phoebe] ${error.message}`);
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    clearForwarders();
    if (signal) {
      // Re-raise so this process dies of the same signal, not a clean 0. The
      // forwarder is removed first (above), otherwise re-raising just re-runs it
      // — a no-op kill on the dead child — and this process would fall through
      // and exit 0, hiding the child's signal death from its parent.
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });

  return child;
}
