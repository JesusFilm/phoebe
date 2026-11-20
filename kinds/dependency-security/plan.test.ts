// The security plan: each severity branch (over the threshold with a fix,
// over it without one, under it), the fix target, the collapse across
// sources, and the body each branch renders.

import { describe, expect, test } from "vite-plus/test";
import type { Advisory, Candidate } from "../dependencies/candidate.ts";
import { parseMarker } from "../dependencies/fingerprint.ts";
import { MIN_SEVERITY_DEFAULT } from "../dependencies/policy.ts";
import type { PhoebeLabel } from "../../src/labels.ts";
import { readIssueRows } from "../dependencies/issue-body.ts";
import { movedKey, planSecurity } from "./plan.ts";

const routingLabel: PhoebeLabel = { name: "phoebe:dependencies", description: "" };
const options = {
  minSeverity: MIN_SEVERITY_DEFAULT,
  routingLabel,
  bootstrapperPin: "skip" as const,
  transitive: "bundle" as const,
};
const individual = { ...options, transitive: "individual" as const };

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

  test("an override with a later advisory moves to that fix, not to the newest major", () => {
    const pin = { override: true, workspace: "pnpm-workspace.yaml", current: "4.3.2" } as const;
    const later = advisory("GHSA-later", "high", "4.3.5");
    const plan = planSecurity(
      [
        candidate("js-yaml", { ...pin, advisories: [later] }),
        candidate("js-yaml", { ...pin, target: "5.5.0", updateType: "major" }),
      ],
      options,
    );
    expect(plan.planned.map((p) => p.routed)).toEqual([true]);
    expect(plan.planned[0]!.bundle.candidates).toEqual([
      candidate("js-yaml", { ...pin, target: "4.3.5", updateType: "patch", advisories: [later] }),
    ]);
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

  test("a development dependency files at critical, and its high is counted under the threshold", () => {
    const high = advisory("GHSA-high", "high", "1.0.3");
    const critical = advisory("GHSA-crit", "critical", "1.0.4");
    const plan = planSecurity(
      [
        candidate("prod-high", { advisories: [high] }),
        candidate("dev-high", { depType: "dev", advisories: [high] }),
        candidate("dev-critical", { depType: "dev", advisories: [high, critical] }),
      ],
      options,
    );
    expect(plan.planned.map((p) => p.bundle.group)).toEqual([
      "security:dev-critical",
      "security:prod-high",
    ]);
    expect(plan.planned[0]!.bundle.candidates[0]!.advisories).toEqual([critical]);
    expect(plan.below).toBe(1);
  });

  test("a package in both sections lists only the rows over their own threshold", () => {
    const high = advisory("GHSA-high", "high", "1.0.3");
    const plan = planSecurity(
      [
        candidate("lodash", { advisories: [high] }),
        candidate("lodash", { depType: "dev", workspace: "web/package.json", advisories: [high] }),
      ],
      options,
    );
    expect(plan.planned).toHaveLength(1);
    expect(plan.planned[0]!.bundle.candidates.map((c) => c.depType)).toEqual(["prod"]);
    expect(plan.planned[0]!.body).toContain(
      "at or above the threshold for its dependency type (`high` for production, `critical` for development)",
    );
    expect(plan.below).toBe(1);
  });

  test("one severity for both sides files a development high, and the body names it alone", () => {
    const plan = planSecurity(
      [candidate("vitest", { depType: "dev", advisories: [advisory("GHSA-h", "high", "1.0.3")] })],
      { ...options, minSeverity: { prod: "high", dev: "high" } },
    );
    expect(plan.planned.map((p) => p.bundle.group)).toEqual(["security:vitest"]);
    expect(plan.planned[0]!.body).toContain("for its advisories at or above `high`, though");
  });

  describe("with no fix released", () => {
    const high = advisory("GHSA-high", "high", null);
    const groups = (candidates: Candidate[]) => {
      const plan = planSecurity(candidates, individual);
      return { planned: plan.planned.map((p) => [p.bundle.group, p.routed]), plan };
    };

    test("a transitive high files nothing and is counted", () => {
      const { planned, plan } = groups([
        candidate("picomatch", { depType: "prod", via: ["vite-plus"], advisories: [high] }),
      ]);
      expect(planned).toEqual([]);
      expect(plan.unfixable).toBe(1);
      expect(plan.below).toBe(0);
    });

    test("a direct high is tracked", () => {
      const { planned, plan } = groups([candidate("lodash", { advisories: [high] })]);
      expect(planned).toEqual([["security:lodash", false]]);
      expect(plan.unfixable).toBe(0);
    });

    test("a transitive critical is tracked", () => {
      const { planned } = groups([
        candidate("tar", {
          via: ["expo"],
          advisories: [advisory("GHSA-crit", "critical", null)],
        }),
      ]);
      expect(planned).toEqual([["security:tar", false]]);
    });

    test("a high whose route is not known is tracked", () => {
      const unknown = candidate("qs", { advisories: [high] });
      delete unknown.via;
      expect(groups([unknown]).planned).toEqual([["security:qs", false]]);
    });

    test("a routed issue lists the fixed transitive row and leaves the unfixed one out", () => {
      const { plan } = groups([
        candidate("minimatch", {
          current: "9.0.9",
          via: ["electron-builder"],
          advisories: [advisory("GHSA-fixed", "high", "9.0.10")],
        }),
        candidate("minimatch", {
          current: "10.2.6",
          via: ["electron-builder"],
          advisories: [high],
        }),
      ]);
      expect(plan.planned.map((p) => p.routed)).toEqual([true]);
      expect(plan.planned[0]!.bundle.candidates.map((c) => c.current)).toEqual(["9.0.9"]);
      expect(plan.planned[0]!.body).not.toContain("10.2.6");
      expect(plan.unfixable).toBe(1);
    });
  });

  test("under the threshold: not filed, and counted", () => {
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
      individual,
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

  test("criticals come first and are exempt from the cap; a tracking issue holds no slot", () => {
    const plan = planSecurity(
      [
        candidate("a-high", { advisories: [advisory("GHSA-a", "high", "1.0.1")] }),
        candidate("b-tracking", { advisories: [advisory("GHSA-b", "critical", null)] }),
        candidate("c-critical", {
          advisories: [
            advisory("GHSA-c", "critical", "1.0.1"),
            advisory("GHSA-d", "high", "1.0.2"),
          ],
        }),
      ],
      options,
    );
    expect(plan.planned.map((p) => [p.bundle.group, p.slot])).toEqual([
      ["security:c-critical", "exempt"],
      ["security:a-high", undefined],
      ["security:b-tracking", "none"],
    ]);
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

  describe("the transitive bundle", () => {
    const high = (id: string, fixedIn: string) => advisory(id, "high", fixedIn);
    const transitive = (pkg: string, overrides: Partial<Candidate> = {}) =>
      candidate(pkg, { via: ["expo"], advisories: [high(`GHSA-${pkg}`, "1.0.1")], ...overrides });
    const shape = (plan: ReturnType<typeof planSecurity>) =>
      plan.planned.map(
        (p) =>
          `${p.bundle.manager}:${p.bundle.group}: ${p.bundle.candidates.map((c) => `${c.package}@${c.target}`).join(", ")}`,
      );

    test("transitive fixes of one manager ride together; a direct fix keeps its own issue", () => {
      const plan = planSecurity(
        [
          transitive("tar"),
          transitive("undici"),
          transitive("ws"),
          candidate("zod", { advisories: [high("GHSA-zod", "1.0.1")] }),
          transitive("regex", { manager: "cargo", workspace: "Cargo.toml" }),
        ],
        options,
      );
      expect(shape(plan)).toEqual([
        "cargo:security-transitive: regex@1.0.1",
        "npm:security-transitive: tar@1.0.1, undici@1.0.1, ws@1.0.1",
        "npm:security:zod: zod@1.0.1",
      ]);
      const [, bundle] = plan.planned;
      expect(bundle!.routed).toBe(true);
      expect(bundle!.slot).toBeUndefined();
      expect(bundle!.title).toBe("Security fixes for transitive packages (npm)");
      expect(bundle!.labels?.map((l) => l.name)).toEqual([
        "dependencies",
        "security",
        "phoebe:dependencies",
      ]);
      expect(bundle!.body).toContain("Make lockfile fixes only.");
      expect(bundle!.body).toContain("do not add an override");
      expect(parseMarker(bundle!.body)?.key).toBe("npm:security-transitive");
    });

    test("a transitive critical gets its own issue and stays out of the bundle", () => {
      const plan = planSecurity(
        [
          transitive("tar"),
          transitive("ip", { advisories: [advisory("GHSA-ip", "critical", "1.0.1")] }),
        ],
        options,
      );
      expect(shape(plan)).toEqual([
        "npm:security:ip: ip@1.0.1",
        "npm:security-transitive: tar@1.0.1",
      ]);
      expect(plan.planned[0]!.slot).toBe("exempt");
    });

    test("a package's direct rows go to its own issue and its transitive rows to the bundle", () => {
      const advisories = [high("GHSA-zod", "1.0.1")];
      const plan = planSecurity(
        [
          candidate("zod", { advisories }),
          candidate("zod", { workspace: "web/package.json", via: ["next"], advisories }),
        ],
        options,
      );
      expect(plan.planned.map((p) => [p.bundle.group, p.bundle.candidates[0]!.workspace])).toEqual([
        ["security-transitive", "web/package.json"],
        ["security:zod", "package.json"],
      ]);
    });

    test('`transitive: "individual"` plans one issue per package, with the per-package body', () => {
      const plan = planSecurity([transitive("tar"), transitive("ws")], individual);
      expect(shape(plan)).toEqual(["npm:security:tar: tar@1.0.1", "npm:security:ws: ws@1.0.1"]);
      expect(plan.planned[0]!.title).toBe("Security advisories in tar (npm)");
      expect(plan.planned[0]!.body).toMatch(/^Security fix for `tar` under `npm`\./);
      expect(plan.planned[0]!.body).toContain("| 1.0.0 | 1.0.1 | transitive, through `expo` |");
    });

    test("one table row per package and version, read back as a row per workspace", () => {
      const workspaces = ["apps/a/package.json", "apps/b/package.json", "package.json"];
      const plan = planSecurity(
        workspaces.map((workspace, i) => transitive("tar", { workspace, via: [`parent-${i}`] })),
        options,
      );
      const body = plan.planned[0]!.body;
      expect(body).toContain(
        "| `tar` | `apps/a/package.json`, `apps/b/package.json`, `package.json` | prod | 1.0.0 | 1.0.1 " +
          "| `parent-0`, `parent-1`, `parent-2` |",
      );
      expect(body.split("\n").filter((line) => line.startsWith("| `tar`"))).toHaveLength(1);
      expect(readIssueRows(body)).toEqual(
        workspaces.map((workspace) => ({
          package: "tar",
          workspace,
          target: "1.0.1",
          advisories: ["GHSA-tar"],
        })),
      );
    });

    test("a body over the limit keeps the rows that fit, in order, and counts the rest", () => {
      const names = Array.from({ length: 40 }, (_, i) => `pkg-${String(i).padStart(2, "0")}`);
      const whole = planSecurity(
        names.map((name) => transitive(name)),
        options,
      );
      expect(whole.overflow.size).toBe(0);
      const limit = Math.floor(whole.planned[0]!.body.length / 2);

      const plan = planSecurity(
        names.map((name) => transitive(name)),
        { ...options, bodyLimit: limit },
      );
      const [bundle] = plan.planned;
      const kept = bundle!.bundle.candidates.map((c) => c.package);
      expect(bundle!.body.length).toBeLessThanOrEqual(limit);
      expect(kept.length).toBeGreaterThan(0);
      expect(kept).toEqual(names.slice(0, kept.length));
      expect(plan.overflow).toEqual(new Map([["npm:security-transitive", 40 - kept.length]]));
    });

    test("a row the bundle's implementer dropped is planned per package, opening with where it came from", () => {
      const moved = new Map([[movedKey("npm", "tar", "1.0.1"), 41]]);
      const plan = planSecurity([transitive("tar"), transitive("ws")], { ...options, moved });
      expect(shape(plan)).toEqual([
        "npm:security-transitive: ws@1.0.1",
        "npm:security:tar: tar@1.0.1",
      ]);
      const own = plan.planned[1]!;
      expect(own.body).toMatch(
        /^Dropped from #41; it needs more than a lockfile fix\.\n\nSecurity fix for `tar` under `npm`\./,
      );
      expect(own.body).toContain("override");
      expect(plan.planned[0]!.body).not.toContain("`tar`");
    });

    test("a drop names one version; the same package at a new target goes back to the bundle", () => {
      const moved = new Map([[movedKey("npm", "tar", "1.0.1"), 41]]);
      const newer = transitive("tar", { advisories: [high("GHSA-tar-2", "1.0.5")] });
      const plan = planSecurity([newer], { ...options, moved });
      expect(shape(plan)).toEqual(["npm:security-transitive: tar@1.0.5"]);
    });

    test("a drop of a direct dependency moves nothing", () => {
      const moved = new Map([[movedKey("npm", "zod", "1.0.1"), 41]]);
      const plan = planSecurity([candidate("zod", { advisories: [high("GHSA-zod", "1.0.1")] })], {
        ...options,
        moved,
      });
      expect(plan.planned[0]!.body).not.toContain("Dropped from");
    });
  });
});
