// The security plan: each severity branch (over the threshold with a fix,
// over it without one, under it), the fix target, the collapse across
// sources, and the body each branch renders.

import { describe, expect, test } from "vite-plus/test";
import type { Advisory, Candidate } from "../dependencies/candidate.ts";
import { parseMarker } from "../dependencies/fingerprint.ts";
import type { PhoebeLabel } from "../../src/labels.ts";
import { planSecurity } from "./plan.ts";

const routingLabel: PhoebeLabel = { name: "phoebe:dependencies", description: "" };
const options = { minSeverity: "high" as const, routingLabel, bootstrapperPin: "skip" as const };

function candidate(pkg: string, overrides: Partial<Candidate> = {}): Candidate {
  return {
    manager: "npm",
    package: pkg,
    current: "1.0.0",
    target: "1.0.0",
    updateType: "patch",
    depType: "prod",
    workspace: "package.json",
    advisories: [],
    peers: [],
    via: [],
    ...overrides,
  };
}

const advisory = (id: string, severity: Advisory["severity"], fixedIn: string | null) => ({
  id,
  severity,
  fixedIn,
});

describe("planSecurity", () => {
  test("over the threshold with a fix: a routed issue targeting the fix exactly", () => {
    const plan = planSecurity(
      [
        candidate("lodash", {
          target: "4.0.0",
          updateType: "major",
          publishedAt: "2026-11-01T00:00:00Z",
          advisories: [advisory("GHSA-high", "high", "1.0.3")],
        }),
      ],
      options,
    );
    expect(plan.planned).toHaveLength(1);
    const [p] = plan.planned;
    expect(p!.routed).toBe(true);
    expect(p!.bundle.group).toBe("security:lodash");
    expect(p!.bundle.candidates).toEqual([
      candidate("lodash", {
        target: "1.0.3",
        updateType: "patch",
        advisories: [advisory("GHSA-high", "high", "1.0.3")],
      }),
    ]);
    expect(p!.labels?.map((l) => l.name)).toEqual([
      "dependencies",
      "security",
      "phoebe:dependencies",
    ]);
    expect(p!.title).toBe("Security advisories in lodash (npm)");
    expect(p!.body).toContain("| `lodash` | `package.json` | prod | 1.0.0 | 1.0.3 | direct |");
    expect(p!.body).not.toContain("override");
    expect(parseMarker(p!.body)?.key).toBe("npm:security:lodash");
  });

  test("over the threshold with no fix: a tracking issue without the routing label", () => {
    const plan = planSecurity(
      [candidate("minimist", { advisories: [advisory("GHSA-crit", "critical", null)] })],
      options,
    );
    const [p] = plan.planned;
    expect(p!.routed).toBe(false);
    expect(p!.bundle.candidates[0]!.target).toBe("1.0.0");
    expect(p!.labels?.map((l) => l.name)).toEqual(["dependencies", "security"]);
    expect(p!.body).toMatch(/^Tracking `minimist` under `npm`\./);
    expect(p!.body).toContain("adds the `phoebe:dependencies` label");
    expect(p!.body).toContain("| `minimist` | `package.json` | prod | 1.0.0 | direct |");
  });

  test("under the threshold: not filed, and counted as left to dependency-updates", () => {
    const plan = planSecurity(
      [
        candidate("a", { advisories: [advisory("GHSA-low", "moderate", "1.0.1")] }),
        candidate("b", { target: "2.0.0" }),
      ],
      options,
    );
    expect(plan.planned).toEqual([]);
    expect(plan.below).toBe(1);
  });

  test("only advisories at or over the threshold ride the issue, and the highest fix wins", () => {
    const plan = planSecurity(
      [
        candidate("a", {
          advisories: [
            advisory("GHSA-1", "high", "1.0.2"),
            advisory("GHSA-2", "critical", "1.0.4"),
            advisory("GHSA-3", "low", "1.9.0"),
          ],
        }),
      ],
      options,
    );
    const [c] = plan.planned[0]!.bundle.candidates;
    expect(c!.target).toBe("1.0.4");
    expect(c!.advisories.map((a) => a.id)).toEqual(["GHSA-1", "GHSA-2"]);
  });

  test("one occurrence across sources and targets collapses, advisories unioned by id", () => {
    const plan = planSecurity(
      [
        candidate("a", { target: "1.2.0", advisories: [advisory("GHSA-1", "high", "1.0.2")] }),
        candidate("a", {
          target: "2.0.0",
          advisories: [advisory("GHSA-1", "low", "1.0.2"), advisory("GHSA-2", "high", null)],
        }),
      ],
      options,
    );
    expect(plan.planned[0]!.bundle.candidates).toHaveLength(1);
    expect(plan.planned[0]!.bundle.candidates[0]!.advisories).toEqual([
      advisory("GHSA-1", "high", "1.0.2"),
      advisory("GHSA-2", "high", null),
    ]);
  });

  test("a transitive package says how it is reached, and that the fix is a parent bump or an override", () => {
    const advisories = [advisory("GHSA-qs", "high", "6.5.3")];
    const unknown = candidate("qs", {
      current: "6.5.2",
      workspace: "web/package.json",
      advisories,
    });
    delete unknown.via;
    const plan = planSecurity(
      [candidate("qs", { current: "6.5.2", via: ["express"], advisories }), unknown],
      options,
    );
    const body = plan.planned[0]!.body;
    expect(body).toContain("| 6.5.2 | 6.5.3 | transitive, through `express` |");
    expect(body).toContain("| `web/package.json` | prod | 6.5.2 | 6.5.3 | not known |");
    expect(body).toContain("bump of the dependency that pulls it in");
    expect(body).toContain("override");
  });

  test("an advisory on the Dockerfile's phoebe-agent pin is left to phoebe upgrade, unless asked for", () => {
    const pin = candidate("phoebe-agent", {
      manager: "dockerfile",
      current: "0.7.1",
      workspace: "container/Dockerfile",
      advisories: [advisory("GHSA-pin", "high", "0.7.2")],
    });
    const skipped = planSecurity([pin], options);
    expect(skipped.planned).toEqual([]);
    expect(skipped.bootstrapper).toBe(1);

    const proposed = planSecurity([pin], { ...options, bootstrapperPin: "propose" });
    expect(proposed.planned.map((p) => p.bundle.group)).toEqual(["security:phoebe-agent"]);
    expect(proposed.bootstrapper).toBe(0);
  });

  test("routed issues come before tracking ones, one bundle per package", () => {
    const plan = planSecurity(
      [
        candidate("a", { advisories: [advisory("GHSA-a", "high", null)] }),
        candidate("b", { advisories: [advisory("GHSA-b", "high", "1.0.1")] }),
        candidate("b", {
          workspace: "web/package.json",
          advisories: [advisory("GHSA-b", "high", "1.0.1")],
        }),
      ],
      options,
    );
    expect(plan.planned.map((p) => [p.bundle.group, p.routed, p.bundle.candidates.length])).toEqual(
      [
        ["security:b", true, 2],
        ["security:a", false, 1],
      ],
    );
  });
});
