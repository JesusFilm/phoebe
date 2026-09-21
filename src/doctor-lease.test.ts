// The credential leases a spawned doctor is handed (#507 §5): what crosses the
// process boundary, and what a malformed value must not do to a run.

import { describe, expect, test } from "vite-plus/test";
import { DOCTOR_LEASE_ENV, encodeDoctorLeases, parseDoctorLeases } from "./doctor-lease.ts";

describe("doctor leases", () => {
  test("a lease book round-trips through the child's env", () => {
    const leases = { "acme/widget": "ghs_one", "acme/gadget": "ghs_two" };
    expect(parseDoctorLeases(encodeDoctorLeases(leases))).toEqual(leases);
  });

  test("nothing to lease encodes to nothing, so the var is never set at all", () => {
    expect(encodeDoctorLeases({})).toBe("");
    expect(encodeDoctorLeases({ "acme/widget": "" })).toBe("");
  });

  test("a manual run has no leases and reads none", () => {
    expect(parseDoctorLeases(undefined)).toEqual({});
    expect(parseDoctorLeases("")).toEqual({});
  });

  test("a malformed value is no leases, never a broken run", () => {
    expect(parseDoctorLeases("not json")).toEqual({});
    expect(parseDoctorLeases("[1,2,3]")).toEqual({});
    expect(parseDoctorLeases("null")).toEqual({});
    expect(parseDoctorLeases('{"acme/widget": 42}')).toEqual({});
  });

  test("the env key is one constant both sides read", () => {
    expect(DOCTOR_LEASE_ENV).toBe("PHOEBE_DOCTOR_LEASES");
  });
});
