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
export type {
  ConfigEdit,
  EditReceipt,
  EditRefusalReason,
  EditRefused,
  EditWritten,
} from "./config-edit.ts";
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
