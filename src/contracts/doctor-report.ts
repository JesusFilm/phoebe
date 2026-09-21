// What `phoebe doctor` concluded, as a type. The checks themselves — every one
// of which reads a file, an env var, a clone or GitHub — stay in src/doctor.ts;
// the shape lives here because the deployment report carries a doctor section
// (#507 §7) and every reader of that report renders it: `phoebe status`, the
// relay, the companion. None of them may load an engine that reaches a
// filesystem (#528).

/** A check's verdict. `unknown` is "not answerable here", never "probably fine". */
export type CheckState = "ok" | "warn" | "fail" | "unknown";

export type DoctorCheck = {
  id: string;
  state: CheckState;
  detail: string;
};

export type TenantDoctorRow = {
  path: string;
  slug: string | null;
  checks: DoctorCheck[];
};

export type DoctorReport = {
  checks: DoctorCheck[];
  tenants: TenantDoctorRow[];
  /** False when any deployment or tenant check failed. */
  ok: boolean;
};
