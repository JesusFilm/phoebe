// `phoebe-agent/contracts` — the pure-TypeScript types every reader of a
// deployment shares: the engine and bootstrapper on the host, the relay, the
// web console, and the companion's renderer process (map #497, #521 §3).
//
// Two rules hold this subpath together, and purity.test.ts enforces both:
//
//  1. Nothing reachable from here imports a Node built-in. A browser bundle has
//     no `node:fs`; one such import anywhere in the closure and the whole
//     subpath stops loading in a renderer.
//  2. Nothing under this directory imports a value from outside it. Types erase
//     at build time; a value import would drag engine code — and the built-ins
//     behind it — along with it.
//
// So contracts holds type declarations and the occasional pure constant, and
// nothing that reaches a filesystem, a process, or a socket. Host code keeps
// importing these files from `src/` directly; the subpath export exists for
// everyone who installs the package instead.
//
// A runtime value added here has to be mirrored by hand in index.mjs. Node
// refuses to type-strip a `.ts` file under a `node_modules` segment, so an
// installed consumer's value import lands on the `.mjs`, never on this file.

// The host verbs and their outcomes (#552). One entry per verb, plus the closed
// union a second caller switches on.
export type { HostVerb, OutcomeOf, VerbOutcome } from "./host-verb.ts";
export type { VerbIo } from "./verb-io.ts";
export type {
  InitOutcome,
  InitProfile,
  InitReport,
  InitScaffoldOutcome,
  InitTenantOutcome,
} from "./init-report.ts";
export type { StartOutcome } from "./start-outcome.ts";
export type { StopOutcome } from "./stop-outcome.ts";
export type {
  UpgradeCheckReport,
  UpgradeHalfOutcome,
  UpgradeOutcome,
  UpgradeTarget,
} from "./upgrade-outcome.ts";
export type {
  FleetMigrateReport,
  JournalEntry,
  MigrateReport,
  MigrationResult,
  MigrationRole,
  MigrationState,
  TenantMigrateEntry,
  TenantVerdict,
} from "./migrate-report.ts";
export type {
  CheckState,
  DoctorCheck,
  DoctorReport,
  MissingDeclaredEnvKey,
  TenantDoctorRow,
} from "./doctor-report.ts";
