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

export type { StopOutcome } from "./stop-outcome.ts";
export { RELAY_ROUTES } from "./relay-routes.ts";
export type {
  RelayConnectionState,
  RelayDeploymentDetail,
  RelayDeploymentRow,
  RelayIdentity,
  RelayRoute,
  RelayStoredReport,
} from "./relay-routes.ts";
export { RELAY_EVENTS } from "./relay-events.ts";
export type {
  RelayConnectionEvent,
  RelayEvent,
  RelayEventName,
  RelayReportEvent,
} from "./relay-events.ts";
// The two helpers in relay-protocol.ts (`relaySpeaks`, `relayMessageType`) are
// deliberately not re-exported: a function mirrored by hand into index.mjs is a
// second implementation, and no `toEqual` catches the day the two disagree.
// This repo's own relay and bootstrapper import them from the module directly.
export {
  RELAY_CLOSE,
  RELAY_DARK_AFTER_MS,
  RELAY_DEPLOYMENTS_PATH,
  RELAY_HEARTBEAT_MS,
  RELAY_MESSAGES,
  RELAY_PROTOCOL,
  RELAY_UNDELIVERED,
  type DeploymentToRelay,
  type RelayChallenge,
  type RelayCloseCode,
  type RelayConfigSet,
  type RelayDoctorRun,
  type RelayHeartbeat,
  type RelayHello,
  type RelayMessageType,
  type RelayReceipt,
  type RelayReportMessage,
  type RelayRequest,
  type RelaySecretSet,
  type RelayToDeployment,
} from "./relay-protocol.ts";
export { DESKTOP_BRIDGE_GLOBAL } from "./desktop-bridge.ts";
export type {
  DesktopBridge,
  DesktopBridgeError,
  DesktopBridgeErrorCode,
  RelayArmState,
  RelayPassthrough,
} from "./desktop-bridge.ts";
export type {
  CompanionEnvironment,
  CompanionPreferences,
  InstallState,
  LocalInstall,
} from "./local-install.ts";
export { CANCELLABLE_VERBS, MAX_RUN_LINES } from "./verb-run.ts";
export type { RunExit, RunLine, VerbRun, VerbRunRequest } from "./verb-run.ts";
export type { CredentialArm } from "./credential-arm.ts";
export type { PipelineSource, PipelineState, WedgedVerdict } from "./pipeline-state.ts";
export type { CurrentUnit, StatusSnapshot, UnitRef } from "./status-snapshot.ts";
export {
  DEPLOYMENT_SCHEMA,
  type BootstrapperReport,
  type ChildExit,
  type ChildLiveness,
  type ChildState,
  type CrashLoopRecord,
  type DeploymentArm,
  type DeploymentIdentity,
  type DeploymentReport,
  type FleetCell,
  type FleetReport,
  type ReconcileState,
  type RelayClose,
  type RelayReport,
  type RelayState,
  type SlotReport,
  type TenantFacts,
} from "./deployment.ts";

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
