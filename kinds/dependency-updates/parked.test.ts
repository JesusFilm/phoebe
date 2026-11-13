// Parked dependency tickets (#862): reading the implementer's comments on a
// ticket wearing `phoebe:blocked`, and lifting the label when the ticket can
// pass with nobody acting.

import { describe, expect, test } from "vite-plus/test";
import { BLOCKED_MARKER, PHOEBE_BLOCKED_LABEL } from "../../src/blocked.ts";
import type { MentioningIssue } from "../../src/github-client.ts";
import { stubGitHub, type GitHubStubOverrides } from "../../src/github-stub.ts";
import type { WorkKindCtx } from "../../src/work-kinds/definition.ts";
import type { Candidate } from "../dependencies/candidate.ts";
import type { FilingAction, PlannedBundle } from "../dependencies/filing.ts";
import { parkedRecords, readParked, releaseParked, type ParkedIssue } from "./parked.ts";

const PHOEBE = "phoebe-bot";

function ctxFor(github: GitHubStubOverrides, logged: string[] = []) {
  return {
    github: stubGitHub(github).forCycle() as unknown as WorkKindCtx["github"],
    env: { PHOEBE_GH_LOGIN: PHOEBE },
    log: (line: string) => logged.push(line),
  };
}

function issue(
  number: number,
  labels: string[],
  state: "open" | "closed" = "open",
): MentioningIssue {
  return { number, body: "", state, stateReason: null, closedAt: null, labels };
}

const dropped = (...entries: string[]) =>
  ["Every bump dropped.", "", "## Dropped", "", ...entries, "", BLOCKED_MARKER].join("\n");

describe("readParked", () => {
  test("reads Phoebe's own comments on every issue, open or closed, and notes which wear phoebe:blocked", () => {
    const asked: number[] = [];
    const ctx = ctxFor({
      resolveLogin: (env) => env ?? "unset",
      issueTimeoutInputs: (n) => {
        asked.push(n);
        return {
          comments: [
            { body: "mine", createdAt: "2026-11-13T00:00:00Z", authorLogin: PHOEBE },
            { body: "a passer-by", createdAt: "2026-11-13T00:01:00Z", authorLogin: "drive-by" },
          ],
          extraActivityAt: null,
          baseline: "body:aa",
        };
      },
    });
    const parked = readParked(
      [
        issue(1, ["phoebe:dependencies", PHOEBE_BLOCKED_LABEL]),
        issue(2, ["phoebe:dependencies"]),
        issue(3, [PHOEBE_BLOCKED_LABEL], "closed"),
      ],
      ctx,
    );
    expect(asked).toEqual([1, 2, 3]);
    expect(parked).toEqual([
      { number: 1, open: true, blocked: true, comments: ["mine"] },
      { number: 2, open: true, blocked: false, comments: ["mine"] },
      { number: 3, open: false, blocked: true, comments: ["mine"] },
    ]);
    expect(parkedRecords(parked)).toEqual([
      { number: 1, body: "mine" },
      { number: 2, body: "mine" },
      { number: 3, body: "mine" },
    ]);
  });

  test("asks GitHub nothing when there are no issues", () => {
    expect(readParked([], ctxFor({}))).toEqual([]);
  });

  test("an issue whose comments cannot be read is logged and left out", () => {
    const logged: string[] = [];
    const ctx = ctxFor(
      {
        resolveLogin: () => PHOEBE,
        issueTimeoutInputs: () => {
          throw new Error("gh exploded");
        },
      },
      logged,
    );
    expect(readParked([issue(4, [PHOEBE_BLOCKED_LABEL])], ctx)).toEqual([]);
    expect(logged.join("\n")).toContain("Could not read the comments on #4");
  });
});

describe("releaseParked", () => {
  const candidate: Candidate = {
    manager: "npm",
    package: "electron",
    current: "45.3.1",
    target: "45.3.2",
    updateType: "patch",
    publishedAt: "2026-11-13T00:00:00Z",
    depType: "dev",
    workspace: "package.json",
    advisories: [],
    peers: [],
  };
  const planned: PlannedBundle = {
    bundle: { manager: "npm", group: "retry:electron", candidates: [candidate] },
    title: "Update electron to 45.3.2",
    body: "",
    render: () => ({ title: "Update electron to 45.3.2", body: "" }),
  };
  const leave = (n: number): FilingAction => ({ action: "leave", planned, issue: n, held: [] });
  const update = (n: number): FilingAction => ({
    action: "update",
    planned,
    issue: n,
    previous: "000000000000",
    held: [],
  });
  const parked = (number: number, comments: string[], open = true): ParkedIssue => ({
    number,
    open,
    blocked: true,
    comments,
  });

  function release(actions: FilingAction[], issues: ParkedIssue[]) {
    const removed: string[] = [];
    const logged: string[] = [];
    const ctx = ctxFor(
      {
        removeIssueLabel: (n, label) => {
          removed.push(`${n} ${label}`);
        },
      },
      logged,
    );
    return { released: releaseParked(actions, issues, ctx), removed, logged };
  }

  test("a ticket the scan still plans, parked only because its bumps were too new, is lifted", () => {
    const { released, removed, logged } = release(
      [leave(858)],
      [parked(858, [dropped("- `electron@45.3.2` (too new): published today")])],
    );
    expect(released).toEqual([858]);
    expect(removed).toEqual([`858 ${PHOEBE_BLOCKED_LABEL}`]);
    expect(logged).toEqual([
      `npm:retry:electron: lifted ${PHOEBE_BLOCKED_LABEL} from #858; its bumps were only too new.`,
    ]);
  });

  test("the newest comment decides: an older too-new park does not lift a real failure", () => {
    const { removed } = release(
      [leave(858)],
      [
        parked(858, [
          dropped("- `electron@45.3.2` (too new): published today"),
          dropped("- `electron@45.3.2`: the build broke"),
        ]),
      ],
    );
    expect(removed).toEqual([]);
  });

  test("a newer blocked run without drops ends the search, so the label stays", () => {
    const { removed } = release(
      [leave(858)],
      [
        parked(858, [
          dropped("- `electron@45.3.2` (too new): published today"),
          `The run stopped.\n\n${BLOCKED_MARKER}`,
        ]),
      ],
    );
    expect(removed).toEqual([]);
  });

  test("a ticket whose label is already gone is not touched", () => {
    const { removed } = release(
      [update(858)],
      [{ ...parked(858, [dropped("- `electron@45.3.2` (too new): today")]), blocked: false }],
    );
    expect(removed).toEqual([]);
  });

  test("a ticket parked for a real failure keeps its label while the bundle stands", () => {
    const { removed } = release(
      [leave(858)],
      [
        parked(858, [
          dropped(
            "- `electron@45.3.2` (too new): published today",
            "- `jsdom@31.0.1`: the tests fail",
          ),
        ]),
      ],
    );
    expect(removed).toEqual([]);
  });

  test("a refreshed bundle is lifted whatever parked it, since the bumps it failed are gone", () => {
    const { removed, logged } = release(
      [update(860)],
      [parked(860, [dropped("- `jsdom@31.0.1`: the tests fail")])],
    );
    expect(removed).toEqual([`860 ${PHOEBE_BLOCKED_LABEL}`]);
    expect(logged[0]).toContain("the bundle it was parked on has moved");
  });

  test("leaves a closed ticket, one parked with no dropped list, and one the scan does not plan", () => {
    const { removed } = release(
      [leave(1), leave(2), { action: "create", planned, held: [] }],
      [
        parked(1, [dropped("- `electron@45.3.2` (too new): today")], false),
        parked(2, [`A person has to decide.\n\n${BLOCKED_MARKER}`]),
        parked(3, [dropped("- `electron@45.3.2` (too new): today")]),
      ],
    );
    expect(removed).toEqual([]);
  });

  test("a label that cannot be removed is logged for the next scan", () => {
    const logged: string[] = [];
    const ctx = ctxFor(
      {
        removeIssueLabel: () => {
          throw new Error("gh exploded");
        },
      },
      logged,
    );
    const released = releaseParked(
      [leave(858)],
      [parked(858, [dropped("- `electron@45.3.2` (too new): today")])],
      ctx,
    );
    expect(released).toEqual([]);
    expect(logged[0]).toContain(`could not lift ${PHOEBE_BLOCKED_LABEL} from #858`);
  });
});
