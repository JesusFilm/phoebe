// `phoebe-agent/contracts` — what every reader of a deployment shares: the
// engine and bootstrapper on the host, the relay, the web console, and the
// companion's renderer process (map #497, #521 §3).
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
// So contracts holds type declarations, the occasional pure constant, and pure
// computation over WebCrypto, and nothing that reaches a filesystem, a process,
// or a socket. Host code keeps importing these files from `src/` directly; the
// subpath export exists for everyone who installs the package instead.
//
// This file is the `types` condition; index.mjs is the `import` condition. A
// runtime value therefore lives in a sibling `.mjs` that both entries re-export
// — Node refuses to type-strip a `.ts` file under a `node_modules` segment, so
// an installed consumer's value import can never land on TypeScript. The `.mjs`
// carries JSDoc, which is what makes the re-export below a typed one.

export type { EnvelopeAad, SecretEnvelope } from "./secret-envelope.mjs";
export { openSecret, sealSecret } from "./secret-envelope.mjs";
export type { StopOutcome } from "./stop-outcome.ts";
export type {
  ConfigEdit,
  EditReceipt,
  EditRefusalReason,
  EditRefused,
  EditWritten,
} from "./config-edit.ts";
export { RELAY_ROUTES } from "./relay-routes.ts";
export type {
  RelayConnectionState,
  RelayDeploymentDetail,
  RelayDeploymentRow,
  RelayDoctorRunAnswer,
  RelayDoctorRunResult,
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
  RELAY_DOCTOR_RUN,
  RELAY_HEARTBEAT_MS,
  RELAY_MESSAGES,
  RELAY_PROTOCOL,
  RELAY_UNDELIVERED,
  type DeploymentToRelay,
  type DoctorRunOutcome,
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
// The edge rule itself (`alertEdges` and the body builders in alerts.ts) is not
// re-exported, for the reason above: it is the one piece of real logic in this
// directory, and a hand-written copy of it in index.mjs would be a second
// implementation of the thing whose whole point is that there is only one. Both
// readers live in this repo — the relay and the companion's main process — and
// both import alerts.ts directly (#524 §3).
export {
  ALERT_CONDITIONS,
  ALERT_DARK_AFTER_MS,
  ALERT_SCHEMA,
  type AlertBody,
  type AlertCondition,
  type AlertEdge,
  type AlertMessage,
  type AlertState,
  type AlertTestMessage,
  type ConnectionAlertFacts,
  type DeploymentAlertFacts,
  type DoctorVerdict,
  type LastAlert,
  type NotifiedAlert,
  type NotifiedAlerts,
  type PipelineAlertFacts,
  type RelayAlertFacts,
  type ReportAlertFacts,
} from "./alerts.ts";
export type { CredentialArm } from "./credential-arm.ts";
export type {
  CheckState,
  DoctorAttempt,
  DoctorCheck,
  DoctorFailure,
  DoctorReport,
  DoctorSection,
  DoctorTrigger,
  TenantDoctorRow,
} from "./doctor.ts";
export type { PipelineSource, PipelineState, WedgedVerdict } from "./pipeline-state.ts";
export type { CurrentUnit, StatusSnapshot, UnitRef } from "./status-snapshot.ts";
export {
  DEPLOYMENT_SCHEMA,
  type BootstrapperReport,
  type ConfigReport,
  type ConfigSource,
  type ChildExit,
  type ChildLiveness,
  type ChildState,
  type CrashLoopRecord,
  type DeploymentArm,
  type DeploymentIdentity,
  type DeploymentReport,
  type EditLedgerEntry,
  type FleetCell,
  type FleetReport,
  type ReconcileState,
  type RelayClose,
  type RelayReport,
  type RelayState,
  type SlotReport,
  type TenantFacts,
} from "./deployment.ts";
export { EFFECTIVE_CONFIG_VERSION } from "./effective-config.ts";
export type {
  ConfigWarning,
  EffectiveFields,
  EffectiveLeaf,
  EffectiveNode,
  EnvLocation,
  EnvPresence,
  SettingReader,
  SettingSource,
  ShadowedValue,
  TenantEffectiveConfig,
} from "./effective-config.ts";
