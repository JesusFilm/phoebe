import { describe, expect, test } from "vite-plus/test";
import type { SkillLock } from "../../src/skill-lock.ts";
import {
  decide,
  groupSources,
  matureCommit,
  nextTag,
  parseMarker,
  renderMarker,
  renderNewerMarker,
  sourceBranch,
  tagLadder,
  vetoedRefs,
  type SourcePr,
} from "./plan.ts";

const DAY = 86_400_000;

describe("tagLadder and nextTag", () => {
  const tags = ["v1.3.2", "v1.3.3", "v1.4.0", "v2.0.0", "v2.1.0", "v3.0.0-rc.1", "latest"];

  test("the newest of the current major first, then the newest of each later major", () => {
    expect(tagLadder("v1.3.2", tags)).toEqual(["v1.4.0", "v2.1.0"]);
  });

  test("nothing newer is an empty ladder", () => {
    expect(tagLadder("v2.1.0", tags)).toEqual([]);
    expect(nextTag("v2.1.0", tags, new Set())).toBeNull();
  });

  test("the minor is proposed before the major", () => {
    expect(nextTag("v1.3.2", tags, new Set())).toBe("v1.4.0");
  });

  test("a vetoed minor does not block the major", () => {
    expect(nextTag("v1.3.2", tags, new Set(["v1.4.0"]))).toBe("v2.1.0");
  });

  test("a veto lifts once upstream moves past it", () => {
    expect(nextTag("v1.3.2", [...tags, "v1.4.1"], new Set(["v1.4.0"]))).toBe("v1.4.1");
  });

  test("a major's own ladder starts on the next major", () => {
    expect(nextTag("v1.4.0", ["v1.4.0", "v2.0.0"], new Set())).toBe("v2.0.0");
  });
});

describe("matureCommit", () => {
  const now = 100 * DAY;
  const log = [
    { sha: "c4", committedAt: now - 1 * DAY },
    { sha: "c3", committedAt: now - 4 * DAY },
    { sha: "c2", committedAt: now - 5 * DAY },
    { sha: "c1", committedAt: now - 10 * DAY },
  ];

  test("the newest commit at least minAge old", () => {
    expect(matureCommit(log, ["c1"], now, 3 * DAY, new Set())).toBe("c3");
  });

  test("nothing when every newer commit is younger", () => {
    expect(matureCommit(log, ["c1"], now, 20 * DAY, new Set())).toBeNull();
    expect(matureCommit(log.slice(0, 2), ["c3"], now, 3 * DAY, new Set())).toBeNull();
  });

  test("nothing when the lock is already on the newest mature commit", () => {
    expect(matureCommit(log, ["c3"], now, 3 * DAY, new Set())).toBeNull();
  });

  test("a vetoed commit is not traded for an older one", () => {
    expect(matureCommit(log, ["c1"], now, 3 * DAY, new Set(["c3"]))).toBeNull();
  });
});

describe("groupSources", () => {
  const lock: SkillLock = {
    version: 2,
    skills: {
      a: { source: "o/tags", ref: "v1.3.2", commit: "x1", computedHash: "h", sourceType: "github" },
      b: { source: "o/tags", ref: "v1.4.0", commit: "x2", computedHash: "h", sourceType: "github" },
      c: { source: "o/head", commit: "y1", computedHash: "h", sourceType: "github" },
      d: { source: "o/ignored", ref: "v1.0.0", commit: "z", computedHash: "h" },
    },
  };

  test("groups by source, takes the highest tag, and leaves an all-ignored source out", () => {
    expect(groupSources(lock, ["d"])).toEqual([
      {
        source: "o/head",
        sourceType: "github",
        pin: { kind: "commit", branch: null, commits: ["y1"] },
        lockedCommit: "y1",
        skills: ["c"],
        ignored: [],
      },
      {
        source: "o/tags",
        sourceType: "github",
        pin: { kind: "tag", ref: "v1.4.0" },
        lockedCommit: "x2",
        skills: ["a", "b"],
        ignored: [],
      },
    ]);
  });

  test("an ignored skill is listed but does not set the pin", () => {
    const [tags] = groupSources(lock, ["b", "d"]).filter((s) => s.source === "o/tags");
    expect(tags!.pin).toEqual({ kind: "tag", ref: "v1.3.2" });
    expect(tags!.ignored).toEqual(["b"]);
  });
});

describe("markers and branches", () => {
  test("a marker round-trips, and the last one wins", () => {
    const marker = { source: "mattpocock/skills", ref: "v1.4.0" };
    expect(renderMarker(marker)).toBe("<!-- phoebe-skills source=mattpocock/skills ref=v1.4.0 -->");
    const body = `${renderMarker({ source: "x/y", ref: "v0" })}\n\n${renderMarker(marker)}\n`;
    expect(parseMarker(body)).toEqual(marker);
    expect(parseMarker("no marker")).toBeNull();
  });

  test("one stable branch per source", () => {
    expect(sourceBranch("phoebe/", "mattpocock/skills")).toBe(
      "phoebe/skill-updates/mattpocock-skills",
    );
    expect(sourceBranch("phoebe/", "https://git.example.com/a/b.git")).toBe(
      "phoebe/skill-updates/git-example-com-a-b",
    );
  });
});

describe("vetoedRefs and decide", () => {
  const pr = (number: number, state: SourcePr["state"], ref: string): SourcePr => ({
    number,
    state,
    isDraft: false,
    body: `body\n${renderMarker({ source: "o/s", ref })}`,
  });

  test("only PRs closed unmerged veto, and only their own source", () => {
    const prs = [pr(1, "closed", "v1.4.0"), pr(2, "merged", "v1.3.0"), pr(3, "open", "v2.0.0")];
    expect([...vetoedRefs(prs, "o/s")]).toEqual(["v1.4.0"]);
    expect([...vetoedRefs(prs, "o/other")]).toEqual([]);
  });

  const base = { source: "o/s", proposal: "v1.5.0", foreign: false, comments: [] };

  test("no open PR opens one", () => {
    expect(decide({ ...base, open: null })).toEqual({ action: "open" });
  });

  test("an open PR at the proposal is left alone", () => {
    expect(decide({ ...base, proposal: "v1.4.0", open: pr(3, "open", "v1.4.0") }).action).toBe(
      "nothing",
    );
  });

  test("an open PR behind the proposal is refreshed", () => {
    const open = pr(3, "open", "v1.4.0");
    expect(decide({ ...base, open })).toEqual({ action: "refresh", pr: open });
  });

  test("someone else's commit turns a refresh into one comment", () => {
    const open = pr(3, "open", "v1.4.0");
    expect(decide({ ...base, open, foreign: true })).toEqual({ action: "notify", pr: open });
    const said = `note\n${renderNewerMarker({ source: "o/s", ref: "v1.5.0" })}`;
    expect(decide({ ...base, open, foreign: true, comments: [said] }).action).toBe("nothing");
  });
});
