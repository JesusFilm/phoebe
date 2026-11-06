// The GitHub Actions row, replayed against `gh api` output and OSV answers
// recorded live (fixtures/actions-*.json). actions-phoebe is this
// repository's own workflows, which were current when recorded; actions-sha
// is one workflow pinning tj-actions/changed-files by commit at v45.0.7, the
// version GHSA-mrrh-fwg8-r2c3 covers. The replay writes the workflows into a
// fresh checkout and answers a command only with what was recorded for it.

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import type { Advisory, Candidate } from "../candidate.ts";
import type { OsvClient, OsvQuery } from "../registry/osv.ts";
import { actionsRow, parseWorkflow } from "./actions.ts";
import type { Manifest, RowDeps, RunTool } from "./row.ts";

type Recorded = { cwd: string; command: string; args: string[]; code: number; stdout: string };
type Fixture = {
  files: Record<string, string>;
  runs: Recorded[];
  /** What OSV answered for each commit the row asked about. */
  osv: Record<string, Advisory[]>;
};

type Replay = {
  checkout: string;
  deps: RowDeps & { osv: OsvClient };
  calls: string[];
  asked: OsvQuery[];
  logged: string[];
};

function load(name: string): Fixture {
  return JSON.parse(
    readFileSync(join(import.meta.dirname, "fixtures", `${name}.json`), "utf8"),
  ) as Fixture;
}

function writeFiles(files: Record<string, string>): string {
  const checkout = mkdtempSync(join(tmpdir(), "phoebe-actions-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(checkout, path)), { recursive: true });
    writeFileSync(join(checkout, path), text);
  }
  return checkout;
}

function replay(
  fixture: Fixture,
  opts: { files?: Record<string, string>; osv?: OsvClient["advisories"] } = {},
): Replay {
  const checkout = writeFiles(opts.files ?? fixture.files);
  const calls: string[] = [];
  const asked: OsvQuery[] = [];
  const logged: string[] = [];
  const run: RunTool = async (command, args, cwd) => {
    const at = relative(checkout, cwd) || ".";
    const shown = `${at}$ ${command} ${args.join(" ")}`;
    calls.push(shown);
    const recorded = fixture.runs.find(
      (r) => r.cwd === at && r.command === command && r.args.join(" ") === args.join(" "),
    );
    if (recorded === undefined) {
      return { ok: false, missing: false, problem: `unrecorded: ${shown}` };
    }
    return { ok: true, code: recorded.code, stdout: recorded.stdout };
  };
  const osv: OsvClient = {
    advisories:
      opts.osv ??
      (async (queries) => {
        asked.push(...queries);
        return {
          ok: true,
          value: queries.map((q) => ("commit" in q ? (fixture.osv[q.commit] ?? []) : [])),
        };
      }),
  };
  return { checkout, deps: { run, log: (line) => logged.push(line), osv }, calls, asked, logged };
}

async function propose(r: Replay): Promise<Candidate[]> {
  const row = actionsRow(r.deps);
  const manifests = await row.detect(r.checkout);
  expect(manifests).toHaveLength(1);
  const result = await row.candidates(manifests[0]!);
  if (!result.ok) throw new Error(result.problem);
  return result.value;
}

const phoebe = load("actions-phoebe");
const sha = load("actions-sha");

/** One of this repository's workflows with `from` swapped for `to`, as if it had fallen behind. */
function behind(path: string, from: string, to: string): Record<string, string> {
  const text = phoebe.files[path]!;
  expect(text).toContain(from);
  return { ...phoebe.files, [path]: text.split(from).join(to) };
}

describe("parseWorkflow", () => {
  test("reads each remote uses: form and skips local actions and docker images", () => {
    const pins = parseWorkflow(
      [
        "jobs:",
        "  call:",
        "    uses: octo-org/shared/.github/workflows/build.yml@v2",
        "  build:",
        "    steps:",
        "      # uses: commented/out@v1",
        "      - uses: actions/checkout@v4",
        "      - name: init",
        "        uses: github/codeql-action/init@v3.1",
        `      - uses: "actions/setup-node@v4.1.0"`,
        "      - uses: 'pnpm/action-setup@v4' # trailing note",
        "      - uses: actions/github-script@3A2844B7E9C422D3C10D287C895573F7108DA1B3 # v9.0.0",
        "      - uses: ./.github/actions/local",
        "      - uses: docker://alpine:3.20",
        "      - uses: dtolnay/rust-toolchain@stable",
      ].join("\n"),
    );
    expect(pins).toEqual([
      { package: "octo-org/shared", ref: "v2", style: "tag", comment: null },
      { package: "actions/checkout", ref: "v4", style: "tag", comment: null },
      { package: "github/codeql-action", ref: "v3.1", style: "tag", comment: null },
      { package: "actions/setup-node", ref: "v4.1.0", style: "tag", comment: null },
      { package: "pnpm/action-setup", ref: "v4", style: "tag", comment: "trailing" },
      {
        package: "actions/github-script",
        ref: "3A2844B7E9C422D3C10D287C895573F7108DA1B3",
        style: "sha",
        comment: "v9.0.0",
      },
      { package: "dtolnay/rust-toolchain", ref: "stable", style: "tag", comment: null },
    ]);
  });
});

describe("github-actions row on this repository", () => {
  test("claims every workflow once gh answers", async () => {
    const r = replay(phoebe);
    const manifests = await actionsRow(r.deps).detect(r.checkout);
    expect(manifests).toEqual<Manifest[]>([
      {
        checkout: r.checkout,
        path: ".github/workflows",
        workspaces: [
          ".github/workflows/changeset.yml",
          ".github/workflows/ready.yml",
          ".github/workflows/release.yml",
          ".github/workflows/vouch.yml",
        ],
      },
    ]);
    expect(r.calls).toEqual([".$ gh --version"]);
  });

  test("proposes nothing for workflows that were current, asking GitHub once per repository", async () => {
    const r = replay(phoebe);
    expect(await propose(r)).toEqual([]);
    expect(r.logged).toEqual([]);
    expect(r.asked).toEqual([]);
    const repos = r.calls.filter((c) => c.includes("/releases?")).map((c) => c.split(" ")[4]);
    expect(repos).toEqual([
      "repos/actions/checkout/releases?per_page=100",
      "repos/actions/github-script/releases?per_page=100",
      "repos/changesets/action/releases?per_page=100",
      "repos/mitchellh/vouch/releases?per_page=100",
      "repos/voidzero-dev/setup-vp/releases?per_page=100",
    ]);
    expect(r.calls).toHaveLength(1 + 2 * repos.length);
  });

  test("a floating major tag behind moves to the next floating major, dated by its first release", async () => {
    const files = behind(
      ".github/workflows/ready.yml",
      "actions/checkout@v7",
      "actions/checkout@v6",
    );
    const r = replay(phoebe, { files });
    expect(await propose(r)).toEqual<Candidate[]>([
      {
        manager: "github-actions",
        package: "actions/checkout",
        current: "v6",
        target: "v7",
        updateType: "major",
        // v7.0.0's release; the floating tag has pointed somewhere since then.
        publishedAt: "2026-06-18T13:53:05Z",
        depType: "prod",
        workspace: ".github/workflows/ready.yml",
        advisories: [],
        peers: [],
        repositoryUrl: "https://github.com/actions/checkout",
      },
    ]);
    // OSV is asked about the commit v6 points at today.
    expect(r.asked).toEqual([
      {
        ecosystem: "GitHub Actions",
        name: "actions/checkout",
        commit: "d23441a48e516b6c34aea4fa41551a30e30af803",
      },
    ]);
  });

  test("a full version tag behind moves to the newest release, a tag staying a tag", async () => {
    const files = behind(
      ".github/workflows/release.yml",
      "changesets/action@v2.1.2",
      "changesets/action@v2.1.0",
    );
    const [candidate, ...rest] = await propose(replay(phoebe, { files }));
    expect(rest).toEqual([]);
    expect(candidate).toMatchObject({
      package: "changesets/action",
      current: "v2.1.0",
      target: "v2.1.2",
      updateType: "patch",
      publishedAt: "2026-09-07T11:58:11Z",
      workspace: ".github/workflows/release.yml",
    });
  });

  test("a SHA pin behind stays a SHA pin, with the tag in a trailing comment", async () => {
    const files = behind(
      ".github/workflows/vouch.yml",
      "mitchellh/vouch/action/check-user@d66fa29a64600490892131ad87597c30c91fcac4 # v1.5.0",
      "mitchellh/vouch/action/check-user@c6d80ead49839655b61b422700b7a3bc9d0804a9 # v1.4.2",
    );
    const r = replay(phoebe, { files });
    const [candidate, ...rest] = await propose(r);
    expect(rest).toEqual([]);
    expect(candidate).toMatchObject({
      package: "mitchellh/vouch",
      current: "c6d80ead49839655b61b422700b7a3bc9d0804a9 # v1.4.2",
      target: "d66fa29a64600490892131ad87597c30c91fcac4 # v1.5.0",
      updateType: "minor",
      publishedAt: "2026-07-12T20:29:27Z",
      workspace: ".github/workflows/vouch.yml",
    });
    expect(r.asked).toEqual([
      {
        ecosystem: "GitHub Actions",
        name: "mitchellh/vouch",
        commit: "c6d80ead49839655b61b422700b7a3bc9d0804a9",
      },
    ]);
  });
});

describe("github-actions row on a SHA-pinned tj-actions/changed-files", () => {
  test("resolves the pin to its tag, proposes a SHA target, and carries OSV's advisory for the commit", async () => {
    const r = replay(sha);
    const candidates = await propose(r);
    expect(candidates).toEqual<Candidate[]>([
      {
        manager: "github-actions",
        package: "actions/checkout",
        current: "v4.1.0",
        target: "v4.4.0",
        updateType: "minor",
        publishedAt: "2026-07-20T15:36:10Z",
        depType: "prod",
        workspace: ".github/workflows/changed.yml",
        advisories: [],
        peers: [],
        repositoryUrl: "https://github.com/actions/checkout",
      },
      {
        manager: "github-actions",
        package: "actions/checkout",
        current: "v4.1.0",
        target: "v7.0.1",
        updateType: "major",
        publishedAt: "2026-07-20T15:10:05Z",
        depType: "prod",
        workspace: ".github/workflows/changed.yml",
        advisories: [],
        peers: [],
        repositoryUrl: "https://github.com/actions/checkout",
      },
      // v45.0.5 through v45.0.9 all point at the pinned commit, so the newest
      // patch is no move and only the major is proposed. The comment names
      // which of those tags the pin is.
      {
        manager: "github-actions",
        package: "tj-actions/changed-files",
        current: "a284dc1814e3fd07f2e34267fc8f81227ed29fb8 # v45.0.7",
        target: "9426d40962ed5378910ee2e21d5f8c6fcbf2dd96 # v47.0.6",
        updateType: "major",
        publishedAt: "2026-04-18T11:20:20Z",
        depType: "prod",
        workspace: ".github/workflows/changed.yml",
        // OSV files the compromise under the CVE alias with a git range and
        // no package version, so the client reads no fixed version for it.
        advisories: [{ id: "CVE-2025-30066", severity: "high", fixedIn: null }],
        peers: [],
        repositoryUrl: "https://github.com/tj-actions/changed-files",
      },
    ]);
    expect(r.asked).toEqual([
      {
        ecosystem: "GitHub Actions",
        name: "actions/checkout",
        commit: "8ade135a41bc03ea155e62e844d188df1ea18608",
      },
      {
        ecosystem: "GitHub Actions",
        name: "tj-actions/changed-files",
        commit: "a284dc1814e3fd07f2e34267fc8f81227ed29fb8",
      },
    ]);
  });

  test("logs a branch pin and a commit no tag points at instead of proposing them", async () => {
    const r = replay(sha);
    await propose(r);
    expect(r.logged).toEqual([
      "github-actions row: 1 pin(s) on a ref that is not a version, not proposed: tj-actions/changed-files@main.",
      "github-actions row: 1 commit pin(s) no version tag points at, not proposed: tj-actions/changed-files@0e58ed8671d6b60d0890c21b07f8835ace038e67.",
    ]);
  });

  test("a failed OSV lookup is a log line and the candidates go out without advisories", async () => {
    const r = replay(sha, {
      osv: async () => ({ ok: false, source: "osv", status: 503, error: "querybatch: HTTP 503" }),
    });
    const candidates = await propose(r);
    expect(candidates.map((c) => c.target)).toEqual([
      "v4.4.0",
      "v7.0.1",
      "9426d40962ed5378910ee2e21d5f8c6fcbf2dd96 # v47.0.6",
    ]);
    expect(candidates.every((c) => c.advisories.length === 0)).toBe(true);
    expect(r.logged).toContain(
      "github-actions row: OSV failed (querybatch: HTTP 503); candidates carry no advisories.",
    );
  });

  test("a repository GitHub will not answer for leaves the others proposed", async () => {
    const workflow = sha.files[".github/workflows/changed.yml"]!;
    const files = {
      ".github/workflows/changed.yml": `${workflow}      - uses: nobody/gone@v1\n`,
    };
    const r = replay(sha, { files });
    const candidates = await propose(r);
    expect(candidates).toHaveLength(3);
    expect(r.logged[0]).toMatch(
      /^github-actions row: could not read nobody\/gone from GitHub \(unrecorded: .*\); its pins are not proposed\.$/,
    );
  });
});

describe("github-actions row detection", () => {
  test("a checkout with no workflows claims nothing and runs nothing", async () => {
    const r = replay(phoebe, { files: { "README.md": "# none\n" } });
    expect(await actionsRow(r.deps).detect(r.checkout)).toEqual([]);
    expect(r.calls).toEqual([]);
  });

  test("leaves the workflows to the agent fallback when gh is not installed", async () => {
    const r = replay(phoebe);
    const row = actionsRow({
      ...r.deps,
      run: async () => ({ ok: false, missing: true, problem: "gh is not installed" }),
    });
    expect(await row.detect(r.checkout)).toEqual([]);
    expect(r.logged).toEqual([
      "github-actions row: gh is not installed; 4 workflow(s) left to the agent fallback.",
    ]);
  });
});
