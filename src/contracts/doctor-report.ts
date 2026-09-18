// The deployment health report. Lives here rather than in src/doctor.ts so the
// five tabs of a console can render a report without loading the checks that
// produce it — which reach GitHub, git, npm and the data volume (#527 §4). The
// deployment report carries a doctor section too (#507 §7), and every reader of
// that report renders it: `phoebe status`, the relay, the companion. None of
// them may load an engine that reaches a filesystem (#528).

/** A scheduled kind's declared key that its pipeline's env does not hold (#425). */
export type MissingDeclaredEnvKey = { pipeline: string; kind: string; key: string };

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
