// Filing against what GitHub already holds: leave, refresh, veto (and the
// veto lifting when the fingerprint moves), create, and the open cap counting
// a bundle once whether its issue, its PR or both are open. Then the GitHub
// calls each decision makes.

import { describe, expect, test } from "vite-plus/test";
import type { MentioningIssue, MentioningPr } from "../../src/github-client.ts";
import { stubGitHub } from "../../src/github-stub.ts";
import type { WorkKindRunCtx } from "../../src/work-kinds/definition.ts";
import type { Candidate } from "./candidate.ts";
import {
  applyFiling,
  decideFiling,
  DEPENDENCIES_LABEL,
  type FilingAction,
  type PlannedBundle,
} from "./filing.ts";
import { bundleKey, fingerprint, renderMarker } from "./fingerprint.ts";
import type { Bundle } from "./grouping.ts";

function candidate(pkg: string, target = "1.1.0", overrides: Partial<Candidate> = {}): Candidate {
  return {
    manager: "npm",
    package: pkg,
    current: "1.0.0",
    target,
    updateType: "minor",
    depType: "prod",
    workspace: "package.json",
    advisories: [],
    peers: [],
    ...overrides,
  };
}

function planned(group: string, ...candidates: Candidate[]): PlannedBundle {
  const bundle: Bundle = { manager: "npm", group, candidates };
  return { bundle, title: `title ${group}`, body: `body ${group}\n\n${markerOf(bundle)}\n` };
}

function markerOf(bundle: Bundle): string {
  return renderMarker({ key: bundleKey(bundle), fingerprint: fingerprint(bundle) });
}

function issue(
  number: number,
  bundle: Bundle | null,
  state: "open" | "closed",
  labels = ["dependencies", "phoebe:dependencies"],
  printOverride?: string,
): MentioningIssue {
  const body =
    bundle === null
      ? "no marker"
      : renderMarker({
          key: bundleKey(bundle),
          fingerprint: printOverride ?? fingerprint(bundle),
        });
  return {
    number,
    body,
    state,
    stateReason: state === "closed" ? "not_planned" : null,
    closedAt: state === "closed" ? "2026-10-01T00:00:00Z" : null,
    labels,
  };
}

function pr(number: number, body: string, state: "open" | "closed", merged = false): MentioningPr {
  return { number, body, state, merged };
}

const options = { routingLabel: "phoebe:dependencies", cap: 5 };
const actionsOf = (actions: FilingAction[]) =>
  actions.map((a) => ("issue" in a ? `${a.action} #${a.issue}` : a.action));

describe("decideFiling", () => {
  const react = planned("relation:react", candidate("react"), candidate("react-dom"));

  test("a new bundle is created", () => {
    expect(actionsOf(decideFiling([react], [], [], options))).toEqual(["create"]);
  });

  test("an open issue with the same fingerprint is left alone", () => {
    const issues = [issue(10, react.bundle, "open")];
    expect(actionsOf(decideFiling([react], issues, [], options))).toEqual(["leave #10"]);
  });

  test("an open issue with the same key and another fingerprint is refreshed", () => {
    const issues = [issue(10, react.bundle, "open", undefined, "000000000000")];
    const [action] = decideFiling([react], issues, [], options);
    expect(action).toMatchObject({ action: "update", issue: 10, previous: "000000000000" });
  });

  test("of several open issues for one key, the newest is the one kept current", () => {
    const issues = [issue(12, react.bundle, "open"), issue(10, react.bundle, "open", [], "0")];
    expect(actionsOf(decideFiling([react], issues, [], options))).toEqual(["leave #12"]);
  });

  test("a closed issue no merged PR closed vetoes its fingerprint", () => {
    const issues = [issue(10, react.bundle, "closed")];
    expect(actionsOf(decideFiling([react], issues, [], options))).toEqual(["vetoed #10"]);
  });

  test("a closed PR that never merged does not lift the veto", () => {
    const issues = [issue(10, react.bundle, "closed")];
    const prs = [pr(20, `Closes #10\n\n${markerOf(react.bundle)}`, "closed")];
    expect(actionsOf(decideFiling([react], issues, prs, options))).toEqual(["vetoed #10"]);
  });

  test("the veto lifts once the fingerprint moves: a new version or a new advisory", () => {
    const issues = [issue(10, react.bundle, "closed")];
    const newer = planned("relation:react", candidate("react", "1.2.0"), candidate("react-dom"));
    const advised = planned(
      "relation:react",
      candidate("react", "1.1.0", {
        advisories: [{ id: "GHSA-1111-2222-3333", severity: "low", fixedIn: "1.1.0" }],
      }),
      candidate("react-dom"),
    );
    expect(actionsOf(decideFiling([newer], issues, [], options))).toEqual(["create"]);
    expect(actionsOf(decideFiling([advised], issues, [], options))).toEqual(["create"]);
  });

  test("a closed issue a merged PR closed is no veto, by closing keyword or by marker", () => {
    const issues = [issue(10, react.bundle, "closed")];
    const byKeyword = [pr(20, "Fixes #10", "closed", true)];
    const byMarker = [pr(21, markerOf(react.bundle), "closed", true)];
    expect(actionsOf(decideFiling([react], issues, byKeyword, options))).toEqual(["create"]);
    expect(actionsOf(decideFiling([react], issues, byMarker, options))).toEqual(["create"]);
  });

  test("an issue without a marker is not the record", () => {
    expect(actionsOf(decideFiling([react], [issue(9, null, "open")], [], options))).toEqual([
      "create",
    ]);
  });

  describe("the open cap", () => {
    const others = Array.from({ length: 4 }, (_, i) =>
      planned(`package:p${i}`, candidate(`p${i}`)),
    );

    test("stops creating once open routed issues and open PRs reach it", () => {
      const openIssue = issue(30, planned("package:a", candidate("a")).bundle, "open");
      const openPr = pr(31, markerOf(planned("package:b", candidate("b")).bundle), "open");
      const actions = decideFiling(others, [openIssue], [openPr], { ...options, cap: 4 });
      expect(actionsOf(actions)).toEqual(["create", "create", "capped", "capped"]);
    });

    test("an issue and the PR working it count once", () => {
      const a = planned("package:a", candidate("a")).bundle;
      const actions = decideFiling(
        others,
        [issue(30, a, "open")],
        [pr(31, `Closes #30\n\n${markerOf(a)}`, "open")],
        { ...options, cap: 4 },
      );
      expect(actionsOf(actions)).toEqual(["create", "create", "create", "capped"]);
    });

    test("an open issue without the routing label does not count", () => {
      const tracking = issue(30, planned("package:a", candidate("a")).bundle, "open", [
        "dependencies",
        "security",
      ]);
      const actions = decideFiling(others, [tracking], [], { ...options, cap: 4 });
      expect(actionsOf(actions)).toEqual(["create", "create", "create", "create"]);
    });

    test("an open issue parked under phoebe:blocked holds no slot", () => {
      const parked = issue(30, planned("package:a", candidate("a")).bundle, "open", [
        "dependencies",
        "phoebe:dependencies",
        "phoebe:blocked",
      ]);
      const actions = decideFiling(others, [parked], [], { ...options, cap: 4 });
      expect(actionsOf(actions)).toEqual(["create", "create", "create", "create"]);
    });

    test("refreshing an open issue is never held by the cap", () => {
      const filed = issue(30, react.bundle, "open", undefined, "000000000000");
      const actions = decideFiling([react], [filed], [], { ...options, cap: 1 });
      expect(actionsOf(actions)).toEqual(["update #30"]);
    });

    test("no cap creates them all", () => {
      const actions = decideFiling(others, [], [], { ...options, cap: null });
      expect(actionsOf(actions)).toEqual(["create", "create", "create", "create"]);
    });
  });
});

describe("applyFiling", () => {
  test("creates with both labels, refreshes with one comment, and leaves the rest", () => {
    const calls: string[] = [];
    const github = stubGitHub({
      createIssue: (opts) => {
        calls.push(`create ${opts.title}`);
        return 40;
      },
      addIssueLabel: (n, label) => {
        if (label === "phoebe:dependencies" && !calls.includes("created label")) {
          throw Object.assign(new Error("gh failed"), {
            stderr:
              "failed to update https://github.com/acme/widget/issues/40: 'phoebe:dependencies' not found\n",
          });
        }
        calls.push(`label #${n} ${label}`);
      },
      createLabel: () => {
        calls.push("created label");
      },
      updateIssueBody: (n, body) => {
        calls.push(`body #${n} ${body.split("\n")[0]}`);
      },
      postUnitComment: (target, body) => {
        calls.push(`comment #${target.id} ${body}`);
      },
    });
    const logged: string[] = [];
    const a = planned("package:a", candidate("a"));
    const b = planned("package:b", candidate("b"));
    const c = planned("package:c", candidate("c"));
    const counts = applyFiling(
      [
        { action: "create", planned: a },
        { action: "update", planned: b, issue: 41, previous: "000000000000" },
        { action: "leave", planned: c, issue: 42 },
        { action: "capped", planned: c },
      ],
      { github: github.forCycle() as WorkKindRunCtx["github"], log: (l) => logged.push(l) },
      [DEPENDENCIES_LABEL, { name: "phoebe:dependencies", description: "route" }],
    );
    expect(calls).toEqual([
      "create title package:a",
      "label #40 dependencies",
      "created label",
      "label #40 phoebe:dependencies",
      "body #41 body package:b",
      `comment #41 Phoebe refreshed this issue: the bundle now proposes 1 update(s) (fingerprint 000000000000 → ${fingerprint(b.bundle)}).`,
    ]);
    expect(counts).toEqual({ create: 1, update: 1, leave: 1, vetoed: 0, capped: 1 });
    expect(logged.at(-1)).toBe(
      "filing: 1 filed, 1 refreshed, 1 unchanged, 0 vetoed by a closed issue, 1 held by the open cap.",
    );
  });

  test("a label that cannot be added is logged, not thrown", () => {
    const github = stubGitHub({
      createIssue: () => 50,
      addIssueLabel: () => {
        throw new Error("HTTP 502");
      },
    });
    const logged: string[] = [];
    applyFiling(
      [{ action: "create", planned: planned("package:a", candidate("a")) }],
      { github: github.forCycle() as WorkKindRunCtx["github"], log: (l) => logged.push(l) },
      [DEPENDENCIES_LABEL],
    );
    expect(logged[0]).toContain('filed #50 but could not add label "dependencies"');
  });
});
