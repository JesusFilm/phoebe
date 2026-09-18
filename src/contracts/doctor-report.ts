// The deployment health report. Lives here rather than in src/doctor.ts so the
// five tabs of a console can render a report without loading the checks that
// produce it — which reach GitHub, git, npm and the data volume (#527 §4).

/** A scheduled kind's declared key that its pipeline's env does not hold (#425). */
export type MissingDeclaredEnvKey = { pipeline: string; kind: string; key: string };

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
