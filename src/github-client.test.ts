// The GitHub client's own tests, written against the internal executor seam —
// the one place argv is observable. The loop's tests use the client's interface
// (a stub), so nothing there would catch a mistyped `--json` field, a missing
// `-R`, or a GraphQL cursor that never advances. Those three are what this file
// covers; per the design record there is no obligation to reach every method.

import { describe, expect, test } from "vite-plus/test";
import { asBranchRef, asPrNumber, asSha } from "./branded.ts";
import { resolveConfig, type PhoebeUserConfig } from "./config-schema.ts";
import { createGitHubClient, type GhExecutor, type GitHubClient } from "./github-client.ts";
import { buildUnitTimeoutMarker, decideTimeoutRecord } from "./quarantine.ts";

function minimalUser(): PhoebeUserConfig {
  return {
    repoSlug: "acme/widget",
    repoUrl: "https://github.com/acme/widget.git",
    installCommand: "npm ci",
    checkCommand: "npm run check",
    testCommand: "npm test",
    readyCommand: "npm run ready",
  };
}

type Call = { args: readonly string[]; input?: string; inherit?: boolean };

/** A recording executor returning canned stdout, one reply per call in order. */
function stubExec(replies: readonly string[]): { exec: GhExecutor; calls: Call[] } {
  const calls: Call[] = [];
  let n = 0;
  return {
    calls,
    exec: (args, opts) => {
      calls.push({ args, ...opts });
      return replies[n++] ?? "";
    },
  };
}

function clientWith(replies: readonly string[], overrides: Partial<PhoebeUserConfig> = {}) {
  const { exec, calls } = stubExec(replies);
  const github = createGitHubClient({
    config: resolveConfig({ ...minimalUser(), ...overrides }),
    env: {},
    internal: { exec, sleep: async () => {} },
  });
  return { github, calls };
}

/** The value of `--json` in a recorded argv, or undefined when there is none. */
function jsonFields(args: readonly string[]): string | undefined {
  const at = args.indexOf("--json");
  return at === -1 ? undefined : args[at + 1];
}

describe("GraphQL review-thread pagination", () => {
  function page(opts: {
    hasNextPage: boolean;
    endCursor: string | null;
    logins: readonly string[];
  }): string {
    return JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: { hasNextPage: opts.hasNextPage, endCursor: opts.endCursor },
              nodes: opts.logins.map((login) => ({
                isResolved: false,
                isOutdated: false,
                comments: { nodes: [{ createdAt: "2026-01-01T00:00:00Z", author: { login } }] },
              })),
            },
          },
        },
      },
    });
  }

  test("follows the cursor to the next page and concatenates every thread", () => {
    const { github, calls } = clientWith([
      page({ hasNextPage: true, endCursor: "CUR1", logins: ["alice"] }),
      page({ hasNextPage: false, endCursor: "CUR2", logins: ["bob", "carol"] }),
    ]);

    const threads = github.reviewThreads(asPrNumber(7));

    expect(calls).toHaveLength(2);
    expect(threads.map((t) => t.comments[0]?.authorLogin)).toEqual(["alice", "bob", "carol"]);
  });

  test("omits `after` on the first page and sends the previous cursor on the second", () => {
    const { github, calls } = clientWith([
      page({ hasNextPage: true, endCursor: "CUR1", logins: [] }),
      page({ hasNextPage: false, endCursor: null, logins: [] }),
    ]);

    github.reviewThreads(asPrNumber(7));

    const queryOf = (call: Call): string => {
      const at = call.args.findIndex((a) => a.startsWith("query="));
      return call.args[at] ?? "";
    };
    expect(queryOf(calls[0]!)).not.toContain("after:");
    expect(queryOf(calls[1]!)).toContain('after:"CUR1"');
    // The page size must survive the cursor splice, or page two silently
    // re-reads the first 100 threads forever.
    expect(queryOf(calls[1]!)).toContain('reviewThreads(first:100, after:"CUR1")');
  });

  test("passes owner, repo and PR number as typed GraphQL variables", () => {
    const { github, calls } = clientWith([
      page({ hasNextPage: false, endCursor: null, logins: [] }),
    ]);

    github.reviewThreads(asPrNumber(42));

    expect(calls[0]!.args).toEqual([
      "api",
      "graphql",
      "-f",
      expect.stringContaining("query=query($owner:String!,$repo:String!,$pr:Int!)"),
      "-f",
      "owner=acme",
      "-f",
      "repo=widget",
      "-F",
      "pr=42",
    ]);
  });

  test("a null comment author reads as no login rather than throwing", () => {
    const { github } = clientWith([
      JSON.stringify({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    isResolved: true,
                    isOutdated: false,
                    comments: { nodes: [{ createdAt: "2026-01-01T00:00:00Z", author: null }] },
                  },
                ],
              },
            },
          },
        },
      }),
    ]);

    expect(github.reviewThreads(asPrNumber(1))[0]?.comments[0]?.authorLogin).toBeNull();
  });
});

// One table drives both argv axes: every method's `gh` invocation is checked for
// the repo pin, and the ones that read JSON are checked for their exact field
// list. Keeping them in one place means a method added to the client without a
// case here is visibly absent rather than silently half-covered.
type ArgvCase = {
  name: string;
  call: (g: GitHubClient) => void;
  replies: string[];
  /** The exact `--json` value this method must ask for, when it reads JSON. */
  fields?: string;
};

const ARGV_CASES: ArgvCase[] = [
  {
    name: "listReadyIssues",
    call: (g) => void g.listReadyIssues(),
    replies: ["[]"],
    fields: "number,title,body,labels,createdAt",
  },
  {
    name: "listResearchIssues",
    call: (g) => void g.listResearchIssues(),
    replies: ["[]"],
    fields: "number,title,body,labels,createdAt",
  },
  {
    name: "issueBody",
    call: (g) => void g.issueBody(1),
    replies: [JSON.stringify({ body: "" })],
    fields: "body",
  },
  {
    name: "listOpenPhoebePrs",
    call: (g) => void g.listOpenPhoebePrs(),
    replies: ["[]"],
    fields: "number,headRefName,isDraft,isCrossRepository,labels,author",
  },
  {
    name: "currentMergeInfo",
    call: (g) => void g.currentMergeInfo(asPrNumber(1)),
    replies: [
      JSON.stringify({
        number: 1,
        headRefName: "b",
        headRefOid: "s",
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
      }),
    ],
    fields: "number,headRefName,headRefOid,mergeable,mergeStateStatus",
  },
  {
    name: "prCommentBodies",
    call: (g) => void g.prCommentBodies(asPrNumber(1)),
    replies: [JSON.stringify({ comments: [] })],
    fields: "comments",
  },
  {
    name: "reviewSummaryComments",
    call: (g) => void g.reviewSummaryComments(asPrNumber(1)),
    replies: [JSON.stringify({ comments: [] })],
    fields: "comments",
  },
  {
    name: "commitCheckItems",
    call: (g) => void g.commitCheckItems(asSha("abc")),
    replies: ["[]"],
    fields: "workflowName,status,conclusion",
  },
  {
    name: "issueTimeoutInputs",
    call: (g) => void g.issueTimeoutInputs(1),
    replies: [JSON.stringify({ body: "", comments: [] })],
    fields: "comments,body",
  },
  {
    name: "prTimeoutInputs",
    call: (g) => void g.prTimeoutInputs(asPrNumber(1)),
    replies: [JSON.stringify({ headRefOid: "s", comments: [], commits: [] })],
    fields: "comments,commits,headRefOid",
  },
  {
    name: "listQuarantinedIssues",
    call: (g) => void g.listQuarantinedIssues(),
    replies: ["[]"],
    fields: "number,body,comments",
  },
  {
    name: "listQuarantinedPrs",
    call: (g) => void g.listQuarantinedPrs(),
    replies: ["[]"],
    fields: "number,headRefOid,comments",
  },
  {
    name: "findIssuePr",
    call: (g) => void g.findIssuePr(1),
    replies: ["[]"],
    fields: "number",
  },
  {
    name: "issueAuthorLogin",
    call: (g) => void g.issueAuthorLogin(1),
    replies: [JSON.stringify({ author: null })],
    fields: "author",
  },
  { name: "postPrComment", call: (g) => g.postPrComment(asPrNumber(1), "hi"), replies: [""] },
  {
    name: "postUnitComment",
    call: (g) => g.postUnitComment({ objectType: "issue", id: 1 }, "hi"),
    replies: [""],
  },
  {
    name: "addQuarantineLabel",
    call: (g) => g.addQuarantineLabel({ objectType: "pr", id: 1 }),
    replies: [""],
  },
  {
    name: "removeQuarantineLabel",
    call: (g) => g.removeQuarantineLabel({ objectType: "pr", id: 1 }),
    replies: [""],
  },
  {
    name: "createPr",
    call: (g) =>
      g.createPr({ head: asBranchRef("phoebe/issue-1"), base: "main", title: "t", body: "b" }),
    replies: [""],
  },
];

describe("the -R repo suffix", () => {
  test.each(ARGV_CASES)("$name pins the call to the configured repo", (c) => {
    const { github, calls } = clientWith(c.replies);
    c.call(github);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.args.slice(-2), `${c.name} argv: ${call.args.join(" ")}`).toEqual([
        "-R",
        "acme/widget",
      ]);
    }
  });

  test("`gh api` calls carry no -R — the endpoint already names the resource", () => {
    const login = clientWith([JSON.stringify({ login: "phoebe-bot" })]);
    login.github.resolveLogin(undefined);
    expect(login.calls[0]!.args).toEqual(["api", "user"]);

    const user = clientWith([JSON.stringify({ login: "ada", id: 7, type: "User" })]);
    user.github.lookupUser("ada");
    expect(user.calls[0]!.args).toEqual(["api", "users/ada"]);
  });

  test("a login supplied by the environment wins without any call at all", () => {
    const { github, calls } = clientWith([]);
    expect(github.resolveLogin("injected-bot")).toBe("injected-bot");
    expect(calls).toHaveLength(0);
  });
});

describe("--json field lists", () => {
  // A misspelled field is not an error to `gh`: it yields `undefined` at the
  // mapper, so the loop sees an empty title, a null SHA, or no comments and
  // simply finds no work. Each case pins the exact list its mapper reads.
  test.each(ARGV_CASES.filter((c) => c.fields !== undefined))(
    "$name asks for exactly $fields",
    (c) => {
      const { github, calls } = clientWith(c.replies);
      c.call(github);
      expect(jsonFields(calls[0]!.args)).toBe(c.fields);
    },
  );

  test("blockerPrState asks each PR query for `number` and only then reads the issue", () => {
    const { github, calls } = clientWith([
      "[]",
      "[]",
      JSON.stringify({ state: "CLOSED", stateReason: "COMPLETED" }),
    ]);

    expect(github.blockerPrState(12).blockerCompleted).toBe(true);
    expect(jsonFields(calls[0]!.args)).toBe("number");
    expect(jsonFields(calls[1]!.args)).toBe("number");
    expect(jsonFields(calls[2]!.args)).toBe("state,stateReason");
  });

  test("the two blocker PR queries differ only in --state", () => {
    const { github, calls } = clientWith(["[]", "[]", JSON.stringify({ state: "OPEN" })]);
    github.blockerPrState(12);
    expect(calls[0]!.args).toContain("open");
    expect(calls[1]!.args).toContain("merged");
    expect(calls[0]!.args).toContain("phoebe/issue-12");
  });
});

describe("deleted comment authors", () => {
  // `gh` reports a comment from a deleted account with a null author. Every login
  // read in the client keeps that `null` — nobody's login, and so never Phoebe's —
  // so a single ghost comment cannot take a work unit down with a TypeError, and
  // cannot be mistaken for a comment Phoebe posted either.
  test("reviewSummaryComments reads a null author as no login", () => {
    const { github } = clientWith([
      JSON.stringify({
        comments: [
          { body: "gone", createdAt: "2026-01-01T00:00:00Z", author: null },
          { body: "here", createdAt: "2026-01-02T00:00:00Z", author: { login: "phoebe-bot" } },
        ],
      }),
    ]);

    expect(github.reviewSummaryComments(asPrNumber(1)).map((c) => c.authorLogin)).toEqual([
      null,
      "phoebe-bot",
    ]);
  });

  test("issueTimeoutInputs reads a null author as no login", () => {
    const { github } = clientWith([
      JSON.stringify({
        body: "issue body",
        comments: [{ body: "gone", createdAt: "2026-01-01T00:00:00Z", author: null }],
      }),
    ]);

    expect(github.issueTimeoutInputs(1).comments[0]?.authorLogin).toBeNull();
  });

  // The two halves of the divergence the design record named, asserted together
  // for the first time: the client's read of a missing author, and the pure
  // comparison that read feeds. Before this, one file coerced the login and a
  // different file's test documented the coercion in prose.
  test("a ghost comment reaches decideTimeoutRecord as foreign activity", () => {
    const { github } = clientWith([
      JSON.stringify({
        body: "issue body",
        comments: [
          { body: buildUnitTimeoutMarker(1), createdAt: "2026-01-01T00:00:00Z", author: null },
          { body: "still broken?", createdAt: "2026-01-02T00:00:00Z", author: null },
        ],
      }),
    ]);

    const inputs = github.issueTimeoutInputs(1);
    const record = decideTimeoutRecord({
      comments: inputs.comments,
      phoebeLogin: "phoebe-bot",
      extraActivityAt: inputs.extraActivityAt,
      k: 3,
    });

    // The ghost comment is newer than the timeout marker, so the count resets to
    // this timeout alone rather than carrying the marker's 1.
    expect(record).toEqual({ count: 1, quarantine: false });
  });
});

describe("the per-cycle client", () => {
  const openPrsReply = JSON.stringify([
    {
      number: 5,
      headRefName: "phoebe/issue-5",
      isDraft: false,
      isCrossRepository: false,
      labels: [],
      author: { login: "phoebe-bot" },
    },
  ]);
  const mergeInfoReply = (mergeable: string): string =>
    JSON.stringify({
      number: 5,
      headRefName: "phoebe/issue-5",
      headRefOid: "deadbeef",
      mergeable,
      mergeStateStatus: "CLEAN",
    });

  test("openPrs() lists once per cycle and serves the memo thereafter", () => {
    const { github, calls } = clientWith([openPrsReply]);
    const cycle = github.forCycle();

    expect(cycle.openPrs()).toEqual(cycle.openPrs());
    expect(calls).toHaveLength(1);
  });

  test("a second cycle re-lists rather than inheriting the first cycle's memo", () => {
    const { github, calls } = clientWith([openPrsReply, openPrsReply]);

    github.forCycle().openPrs();
    github.forCycle().openPrs();

    expect(calls).toHaveLength(2);
  });

  test("mergeInfo() retries while GitHub still reports UNKNOWN, then memoizes", async () => {
    const { github, calls } = clientWith([
      mergeInfoReply("UNKNOWN"),
      mergeInfoReply("UNKNOWN"),
      mergeInfoReply("CONFLICTING"),
    ]);
    const cycle = github.forCycle();

    const info = await cycle.mergeInfo(asPrNumber(5));

    expect(info.mergeable).toBe("CONFLICTING");
    expect(calls).toHaveLength(3);
    await cycle.mergeInfo(asPrNumber(5));
    expect(calls).toHaveLength(3);
  });

  test("mergeInfo() gives up after the retry budget and returns the UNKNOWN answer", async () => {
    const { github, calls } = clientWith([
      mergeInfoReply("UNKNOWN"),
      mergeInfoReply("UNKNOWN"),
      mergeInfoReply("UNKNOWN"),
      mergeInfoReply("MERGEABLE"),
    ]);

    const info = await github.forCycle().mergeInfo(asPrNumber(5));

    expect(info.mergeable).toBe("UNKNOWN");
    expect(calls).toHaveLength(3);
  });

  test("currentMergeInfo() is the un-memoized read the post-agent re-check needs", () => {
    const { github, calls } = clientWith([mergeInfoReply("UNKNOWN"), mergeInfoReply("MERGEABLE")]);

    expect(github.currentMergeInfo(asPrNumber(5)).mergeable).toBe("UNKNOWN");
    expect(github.currentMergeInfo(asPrNumber(5)).mergeable).toBe("MERGEABLE");
    expect(calls).toHaveLength(2);
  });
});

describe("error enrichment", () => {
  test("a rate-limited call is reclassified and dated from the rate_limit probe", () => {
    const reset = Math.floor(Date.UTC(2026, 0, 2, 3, 4, 0) / 1000);
    const calls: Call[] = [];
    const exec: GhExecutor = (args, opts) => {
      calls.push({ args, ...opts });
      if (args[1] === "rate_limit") {
        return JSON.stringify({ resources: { core: { reset }, graphql: { reset } } });
      }
      const error = new Error("gh failed") as Error & { stderr: string };
      error.stderr = "API rate limit exceeded";
      throw error;
    };
    const github = createGitHubClient({
      config: resolveConfig(minimalUser()),
      env: {},
      internal: { exec },
    });

    expect(() => github.listReadyIssues()).toThrow(/rate limit/i);
    expect(calls.at(-1)!.args).toEqual(["api", "rate_limit"]);
  });

  test("an unclassifiable failure rethrows the original error untouched", () => {
    const github = createGitHubClient({
      config: resolveConfig(minimalUser()),
      env: {},
      internal: {
        exec: () => {
          throw new Error("spawn gh ENOENT");
        },
      },
    });

    expect(() => github.listReadyIssues()).toThrow("spawn gh ENOENT");
  });
});
