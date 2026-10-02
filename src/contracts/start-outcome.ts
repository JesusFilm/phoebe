// What a start did, as a closed union. Lives here rather than in src/start.ts
// so a console can render the result of a start without loading the Compose
// driver that produces it (#527 §4).

/** The state `phoebe start` left the deployment container in. */
export type StartOutcome =
  | { kind: "started" }
  | { kind: "already-running" }
  | { kind: "exited-immediately"; exitCode: number | null };
