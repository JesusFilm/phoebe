// `phoebe doctor` — deployment + tenant health checks, report-only (#169).
// `runDoctorCli` predates the ctx-based Command shape and still reads
// `process.*` directly — this wrapper only bridges its `process.exitCode`
// side effect into the return value dispatch expects.

import { runDoctorCli } from "../doctor.ts";
import type { Command } from "./types.ts";

export const doctorCommand: Command = {
  name: "doctor",
  summary: "phoebe doctor [--json]           Deployment + tenant health checks (report-only)",
  help: "phoebe doctor — deployment + tenant health checks\n\nSee `phoebe doctor --help`.\n",
  async run(argv) {
    await runDoctorCli(argv);
    return process.exitCode === undefined ? 0 : Number(process.exitCode);
  },
};
