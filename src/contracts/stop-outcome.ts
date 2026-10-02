// What a drain did, as a closed union. Lives here rather than in src/stop.ts so
// a console can render the result of a stop without loading the Compose driver
// that produces it (#527 §4).

/** The state `phoebe stop` left the deployment container in. */
export type StopOutcome =
  | { kind: "stopped" }
  | { kind: "already-stopped" }
  | { kind: "no-container" }
  | { kind: "killed-mid-run" }
  | { kind: "stopped-now" }
  | { kind: "abandoned-now" };
