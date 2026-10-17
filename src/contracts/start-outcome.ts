// What a start did, as a closed union. Lives here rather than in src/start.ts
// so a console can render the result of a start without loading the Compose
// driver that produces it (#527 §4).

/**
 * What `phoebe start` did about Serve on the host arm (map #690), when the
 * config names that arm. Absent on the sidecar arm, where containerboot owns
 * Serve, and with no `remote` block at all.
 *
 *   - `ready`     the tailnet URL answers with this deployment's descriptor.
 *   - `pending`   the mapping is in place but the first-request certificate is
 *                 still being issued; the URL will answer shortly.
 *   - `refused`   nothing was changed, and `detail` says why: Tailscale is not
 *                 running, a mapping on the port points somewhere else, or
 *                 something that is not this deployment answers there.
 */
export type ServeOutcome =
  | { state: "ready"; url: string }
  | { state: "pending"; url: string }
  | { state: "refused"; detail: string };

/** The state `phoebe start` left the deployment container in. */
export type StartOutcome =
  | { kind: "started"; serve?: ServeOutcome }
  | { kind: "already-running"; serve?: ServeOutcome }
  | { kind: "exited-immediately"; exitCode: number | null };
