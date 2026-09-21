// The host verbs, and what each one hands back. This is the closed union
// #527 §4 asks for: a second caller — the companion's main process today —
// switches on `verb` and gets the outcome type the CLI printer formats, with no
// cast and no stdout parsing.
//
// Adding a verb here without adding its outcome fails the type-check, which is
// the point: the bridge's `run:exit { runId, code, outcome? }` has to stay
// exhaustive as the write verbs land. `config set` and `secret set` are here
// (#557); `pair` follows with the device token (#540).
//
// The two write verbs are named with the space in them, as the CLI names them,
// because the string is what an operator reads: a run refused `busy` says
// "`phoebe config set` is already running on this install", and a verb called
// `configSet` would have said something nobody types.

import type { EditReceipt } from "./config-edit.ts";
import type { DoctorReport } from "./doctor.ts";
import type { InitOutcome } from "./init-report.ts";
import type { FleetMigrateReport } from "./migrate-report.ts";
import type { SecretSetOutcome } from "./secret-set.ts";
import type { StartOutcome } from "./start-outcome.ts";
import type { StopOutcome } from "./stop-outcome.ts";
import type { UpgradeOutcome } from "./upgrade-outcome.ts";

/** Every verb the host exposes in-process, named as the CLI names it. */
export type HostVerb =
  | "init"
  | "start"
  | "stop"
  | "upgrade"
  | "migrate"
  | "doctor"
  | "config set"
  | "secret set";

/** A finished verb run, tagged by the verb that produced it. */
export type VerbOutcome =
  | { verb: "init"; outcome: InitOutcome }
  | { verb: "start"; outcome: StartOutcome }
  | { verb: "stop"; outcome: StopOutcome }
  | { verb: "upgrade"; outcome: UpgradeOutcome }
  | { verb: "migrate"; outcome: FleetMigrateReport }
  | { verb: "doctor"; outcome: DoctorReport }
  | { verb: "config set"; outcome: EditReceipt }
  | { verb: "secret set"; outcome: SecretSetOutcome };

/** The outcome type of one verb — `OutcomeOf<"stop">` is `StopOutcome`. */
export type OutcomeOf<V extends HostVerb> = Extract<VerbOutcome, { verb: V }>["outcome"];
