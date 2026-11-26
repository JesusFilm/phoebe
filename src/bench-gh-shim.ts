// The `gh` a bench trial sees (#940; spec #925). `bench run` puts a `gh` on the
// trial's PATH that runs this file, so the agent and the prompt's `!` expansions
// can call `gh` as they do in production, and nothing they do reaches GitHub:
//
//   - reads of the fixture's issue are served from the suite's snapshot, so the
//     agent sees the issue as it stood when Phoebe's PR opened
//   - writes (`pr create`, `issue comment`, `api -X POST`, …) are appended to
//     the trial's would-have file and answered with a plausible success, so the
//     agent carries on the way it would have
//   - every other read answers the way an empty repository would, or fails
//     with a message saying the trial is offline
//
// The trial's environment holds no GitHub credential, so even a call that
// slipped past this file to the real `gh` could not authenticate.
//
// Run as `node bench-gh-shim.ts <stateDir> <gh argv…>`. `<stateDir>` holds the
// snapshot `bench run` wrote and receives the would-have lines. Imports nothing
// from the engine but types, so a call costs one Node start.

import { spawnSync } from "node:child_process";
import { appendFileSync, closeSync, openSync, readFileSync, readSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BenchFixture, BenchWouldHave } from "./contracts/bench.ts";

/** What the shim knows: the repo, and the fixture whose issue it serves. */
export type GhShimSnapshot = {
  repo: string;
  defaultBranch: string;
  fixture: BenchFixture;
};

/** Inside a trial's shim state dir. */
export const GH_SHIM_SNAPSHOT_FILE = "snapshot.json";
export const GH_SHIM_WOULD_HAVE_FILE = "would-have.jsonl";

/** The most of a body file a would-have line keeps. */
export const BODY_FILE_MAX = 64 * 1024;

export type GhShimAnswer = {
  stdout: string;
  stderr: string;
  code: number;
  /** Set when the call was a write: the line to record. */
  wouldHave?: BenchWouldHave;
};

export type GhShimIo = {
  now: () => Date;
  cwd: string;
  /** Read a file the call names, `null` when it cannot be read. */
  readFile: (path: string) => string | null;
  readStdin: () => string;
  /** Run `jq` over JSON, `null` when no `jq` is installed. */
  jq: (json: string, filter: string) => { stdout: string; code: number } | null;
};

/** Subcommands that write, by group. Everything here is recorded and answered. */
const WRITES: Record<string, ReadonlySet<string>> = {
  issue: new Set([
    "comment",
    "create",
    "edit",
    "close",
    "reopen",
    "delete",
    "lock",
    "unlock",
    "pin",
    "unpin",
    "transfer",
    "develop",
  ]),
  pr: new Set([
    "create",
    "edit",
    "comment",
    "close",
    "reopen",
    "merge",
    "ready",
    "review",
    "lock",
    "unlock",
  ]),
  label: new Set(["create", "edit", "delete", "clone"]),
  release: new Set(["create", "edit", "delete", "upload", "delete-asset"]),
  repo: new Set(["create", "edit", "fork", "delete", "rename", "archive", "unarchive", "sync"]),
  workflow: new Set(["run", "enable", "disable"]),
  run: new Set(["rerun", "cancel", "delete"]),
  secret: new Set(["set", "delete"]),
  variable: new Set(["set", "delete"]),
  gist: new Set(["create", "edit", "delete"]),
  cache: new Set(["delete"]),
};

/** Reads that answer as an empty repository would: nothing open, nothing found. */
const EMPTY_LISTS: Record<string, ReadonlySet<string>> = {
  issue: new Set(["list"]),
  pr: new Set(["list"]),
  label: new Set(["list"]),
  release: new Set(["list"]),
  run: new Set(["list"]),
  search: new Set(["issues", "prs", "code", "commits", "repos"]),
};

/** Flags that take a value, so the parser does not read the value as a positional. */
const VALUE_FLAGS = new Set([
  "-R",
  "--repo",
  "--json",
  "-q",
  "--jq",
  "-t",
  "--template",
  "-X",
  "--method",
  "-f",
  "--raw-field",
  "-F",
  "--field",
  "-H",
  "--header",
  "--input",
  "-b",
  "--body",
  "--body-file",
  "--title",
  "-B",
  "--base",
  "--head",
  "-l",
  "--label",
  "--add-label",
  "--remove-label",
  "-a",
  "--assignee",
  "-L",
  "--limit",
  "-s",
  "--state",
  "--search",
  "-m",
  "--milestone",
  "-p",
  "--project",
]);

type ParsedGh = {
  positionals: string[];
  flags: Map<string, string[]>;
};

function parseArgv(argv: readonly string[]): ParsedGh {
  const positionals: string[] = [];
  const flags = new Map<string, string[]>();
  const add = (name: string, value: string): void => {
    flags.set(name, [...(flags.get(name) ?? []), value]);
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith("--") && arg.includes("=")) {
      const eq = arg.indexOf("=");
      add(arg.slice(0, eq), arg.slice(eq + 1));
      continue;
    }
    if (arg.startsWith("-") && arg.length > 1) {
      if (VALUE_FLAGS.has(arg) && i + 1 < argv.length) {
        add(arg, argv[i + 1]!);
        i++;
      } else {
        add(arg, "");
      }
      continue;
    }
    positionals.push(arg);
  }
  return { positionals, flags };
}

function flag(parsed: ParsedGh, ...names: string[]): string | undefined {
  for (const name of names) {
    const values = parsed.flags.get(name);
    if (values !== undefined && values.length > 0) return values[values.length - 1];
  }
  return undefined;
}

function flagValues(parsed: ParsedGh, ...names: string[]): string[] {
  return names.flatMap((name) => parsed.flags.get(name) ?? []);
}

/** The issue number a `gh issue view` argument names: `12`, `#12`, or an issue URL. */
function issueArg(arg: string | undefined): number | null {
  if (arg === undefined) return null;
  const match = /^#?(\d+)$/.exec(arg) ?? /\/(?:issues|pull)\/(\d+)(?:[/?#].*)?$/.exec(arg);
  return match === null ? null : Number(match[1]);
}

/** The `owner/repo` an issue URL names, or null for a bare number. */
function urlRepo(arg: string | undefined): string | null {
  const match = /^https?:\/\/github\.com\/([^/]+\/[^/]+)\/(?:issues|pull)\/\d+/.exec(arg ?? "");
  return match === null ? null : match[1]!;
}

/** Whether an argument is a URL rather than a bare number. */
function isUrl(arg: string | undefined): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(arg ?? "");
}

/** `-R` values come as `owner/repo` or `HOST/owner/repo`; only github.com is the snapshot's host. */
function repoSlug(value: string): string | null {
  const parts = value.split("/");
  if (parts.length === 2) return value;
  if (parts.length === 3 && parts[0]!.toLowerCase() === "github.com")
    return `${parts[1]}/${parts[2]}`;
  return null;
}

/** Whether `-R`/`--repo` and an issue URL, when given, name the snapshot's repository. */
function namesSnapshotRepo(parsed: ParsedGh, snapshot: GhShimSnapshot): boolean {
  const arg = parsed.positionals[2];
  if (isUrl(arg) && urlRepo(arg) === null) return false;
  const flagged = flag(parsed, "-R", "--repo");
  const named = [flagged === undefined ? undefined : (repoSlug(flagged) ?? ""), urlRepo(arg)];
  return named.every(
    (repo) =>
      repo === undefined || repo === null || repo.toLowerCase() === snapshot.repo.toLowerCase(),
  );
}

function issueUrl(snapshot: GhShimSnapshot, number: number): string {
  return `https://github.com/${snapshot.repo}/issues/${number}`;
}

/** The fixture's issue as `gh issue view --json` names its fields. */
function issueJson(snapshot: GhShimSnapshot): Record<string, unknown> {
  const { issue } = snapshot.fixture;
  return {
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: "OPEN",
    closed: false,
    url: issueUrl(snapshot, issue.number),
    labels: [],
    assignees: [],
    milestone: null,
    comments: issue.comments.map((comment) => ({
      author: { login: comment.author ?? "ghost" },
      body: comment.body,
      createdAt: comment.createdAt,
    })),
  };
}

function pick(object: Record<string, unknown>, fields: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields.split(",").map((piece) => piece.trim())) {
    if (field.length === 0) continue;
    out[field] = field in object ? object[field] : null;
  }
  return out;
}

/** `--json`/`--jq` output, the way gh prints it. */
function jsonOutput(value: unknown, parsed: ParsedGh, io: GhShimIo): GhShimAnswer {
  const json = JSON.stringify(value);
  const filter = flag(parsed, "--jq", "-q");
  if (filter === undefined)
    return { stdout: `${JSON.stringify(value, null, 2)}\n`, stderr: "", code: 0 };
  const ran = io.jq(json, filter);
  if (ran === null) {
    return {
      stdout: "",
      stderr:
        "gh (bench): no jq here to apply --jq, so this read fails rather than print unfiltered JSON.\n",
      code: 1,
    };
  }
  return { stdout: ran.stdout, stderr: "", code: ran.code };
}

function issueText(snapshot: GhShimSnapshot, withComments: boolean): string {
  const { issue } = snapshot.fixture;
  const head = [
    `title:\t${issue.title}`,
    "state:\tOPEN",
    "labels:\t",
    `comments:\t${issue.comments.length}`,
    `number:\t${issue.number}`,
    "--",
    issue.body,
  ].join("\n");
  if (!withComments) return `${head}\n`;
  const comments = issue.comments.map((comment) =>
    [
      `author:\t${comment.author ?? "ghost"}`,
      `created:\t${comment.createdAt}`,
      "--",
      comment.body,
    ].join("\n"),
  );
  return `${[head, ...comments].join("\n--\n")}\n`;
}

function offline(what: string): GhShimAnswer {
  return {
    stdout: "",
    stderr: `gh: \`${what}\` is not available offline: this is a bench trial with no network and only the issue's snapshot.\n`,
    code: 1,
  };
}

function notFoundIssue(number: number): GhShimAnswer {
  return {
    stdout: "",
    stderr: `GraphQL: Could not resolve to an issue or pull request with the number of ${number}. (repository.issue)\n`,
    code: 1,
  };
}

/** The text a write's body file held, read now: the file may be gone by the time anyone reads the record. */
function bodyFileOf(parsed: ParsedGh, group: string, io: GhShimIo): string | undefined {
  const paths: string[] = [];
  if (group === "api") {
    for (const field of flagValues(parsed, "-F", "--field")) {
      const at = field.indexOf("=@");
      if (at > 0) paths.push(field.slice(at + 2));
    }
    const input = flag(parsed, "--input");
    if (input !== undefined) paths.push(input);
  } else {
    const file = flag(parsed, "--body-file", "-F");
    if (file !== undefined) paths.push(file);
  }
  const path = paths[0];
  if (path === undefined) return undefined;
  const text = path === "-" ? io.readStdin() : io.readFile(resolve(io.cwd, path));
  if (text === null) return undefined;
  return text.length > BODY_FILE_MAX ? text.slice(0, BODY_FILE_MAX) : text;
}

/** What a write prints on success, so an agent reading the output carries on. */
function writeOutput(
  snapshot: GhShimSnapshot,
  group: string,
  verb: string,
  parsed: ParsedGh,
): string {
  const { fixture } = snapshot;
  if (group === "pr" && verb === "create") {
    return `https://github.com/${snapshot.repo}/pull/${fixture.pr.number}\n`;
  }
  if ((group === "issue" || group === "pr") && verb === "comment") {
    const target = issueArg(parsed.positionals[2]) ?? fixture.issue.number;
    return `${issueUrl(snapshot, target)}#issuecomment-1\n`;
  }
  if (group === "issue" && verb === "create")
    return `${issueUrl(snapshot, fixture.issue.number + 1)}\n`;
  if (group === "api") return "{}\n";
  return "";
}

function record(
  argv: readonly string[],
  command: string,
  parsed: ParsedGh,
  group: string,
  io: GhShimIo,
): BenchWouldHave {
  const bodyFile = bodyFileOf(parsed, group, io);
  return {
    at: io.now().toISOString(),
    command,
    argv: [...argv],
    ...(bodyFile !== undefined ? { bodyFile } : {}),
  };
}

/** `gh api`: a write when it says so or carries fields, as gh itself decides. */
function answerApi(
  argv: readonly string[],
  parsed: ParsedGh,
  snapshot: GhShimSnapshot,
  io: GhShimIo,
): GhShimAnswer {
  const method = (flag(parsed, "-X", "--method") ?? "").toUpperCase();
  const hasFields =
    flagValues(parsed, "-f", "--raw-field", "-F", "--field").length > 0 ||
    flag(parsed, "--input") !== undefined;
  const isWrite = method !== "" ? method !== "GET" && method !== "HEAD" : hasFields;
  if (isWrite) {
    return {
      stdout: writeOutput(snapshot, "api", "", parsed),
      stderr: "",
      code: 0,
      wouldHave: record(argv, "api", parsed, "api", io),
    };
  }
  const path = (parsed.positionals[1] ?? "").replace(/^\//, "");
  const issuePath = /^repos\/([^/]+\/[^/]+)\/issues\/(\d+)(\/comments)?$/;
  const parsedPath = issuePath.exec(path);
  const match =
    parsedPath !== null &&
    (parsedPath[1] === "{owner}/{repo}" ||
      parsedPath[1]!.toLowerCase() === snapshot.repo.toLowerCase())
      ? [parsedPath[0], parsedPath[2], parsedPath[3]]
      : null;
  if (match !== null && Number(match[1]) === snapshot.fixture.issue.number) {
    const issue = issueJson(snapshot);
    const rest =
      match[2] === undefined
        ? { ...issue, comments: snapshot.fixture.issue.comments.length, user: null }
        : snapshot.fixture.issue.comments.map((comment) => ({
            user: { login: comment.author ?? "ghost" },
            body: comment.body,
            created_at: comment.createdAt,
          }));
    return jsonOutput(rest, parsed, io);
  }
  return offline(`gh api ${path}`);
}

/**
 * Answer one `gh` call. Pure but for what `io` reads, so a test drives it with
 * no process and no file.
 */
export function answerGh(
  argv: readonly string[],
  snapshot: GhShimSnapshot,
  io: GhShimIo,
): GhShimAnswer {
  const parsed = parseArgv(argv);
  const [group = "", verb = ""] = parsed.positionals;
  const command = group === "api" ? "api" : `${group} ${verb}`.trim();

  if (group === "" || group === "help" || flag(parsed, "--help", "-h") !== undefined) {
    return {
      stdout: "gh (bench shim): reads come from the issue snapshot; writes are recorded.\n",
      stderr: "",
      code: 0,
    };
  }
  if (group === "--version" || group === "version") {
    return { stdout: "gh version 0.0.0 (phoebe bench shim)\n", stderr: "", code: 0 };
  }
  if (group === "api") return answerApi(argv, parsed, snapshot, io);
  if (WRITES[group]?.has(verb) === true) {
    return {
      stdout: writeOutput(snapshot, group, verb, parsed),
      stderr: "",
      code: 0,
      wouldHave: record(argv, command, parsed, group, io),
    };
  }
  if (group === "issue" && verb === "view") {
    const number = issueArg(parsed.positionals[2]);
    if (number === null)
      return { stdout: "", stderr: "gh: issue view needs an issue number\n", code: 1 };
    if (number !== snapshot.fixture.issue.number || !namesSnapshotRepo(parsed, snapshot)) {
      return notFoundIssue(number);
    }
    const fields = flag(parsed, "--json");
    if (fields !== undefined) return jsonOutput(pick(issueJson(snapshot), fields), parsed, io);
    return {
      stdout: issueText(snapshot, parsed.flags.has("--comments") || parsed.flags.has("-c")),
      stderr: "",
      code: 0,
    };
  }
  if (EMPTY_LISTS[group]?.has(verb) === true) {
    if (flag(parsed, "--json") !== undefined) return jsonOutput([], parsed, io);
    return { stdout: "", stderr: "", code: 0 };
  }
  if (group === "pr" && ["view", "status", "diff", "checks"].includes(verb)) {
    return { stdout: "", stderr: "no pull requests found for the current branch\n", code: 1 };
  }
  if (group === "repo" && verb === "view") {
    const [owner = "", name = ""] = snapshot.repo.split("/");
    const repo = {
      name,
      nameWithOwner: snapshot.repo,
      owner: { login: owner },
      url: `https://github.com/${snapshot.repo}`,
      defaultBranchRef: { name: snapshot.defaultBranch },
    };
    const fields = flag(parsed, "--json");
    if (fields !== undefined) return jsonOutput(pick(repo, fields), parsed, io);
    return { stdout: `name:\t${snapshot.repo}\n`, stderr: "", code: 0 };
  }
  if (group === "auth" && verb === "status") {
    return {
      stdout: "github.com\n  ✓ Logged in to github.com (phoebe bench shim, offline)\n",
      stderr: "",
      code: 0,
    };
  }
  return offline(`gh ${command}`);
}

function systemJq(json: string, filter: string): { stdout: string; code: number } | null {
  const ran = spawnSync("jq", ["-r", filter], { input: json, encoding: "utf8" });
  if (ran.error !== undefined) return null;
  return { stdout: ran.stdout, code: ran.status ?? 1 };
}

/**
 * The first `BODY_FILE_MAX` bytes of a file, never the whole of it. A stream
 * (`drain`) is read to its end with the rest dropped, so the writer can finish.
 */
function readPrefix(path: string, drain: boolean): string | null {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return null;
  }
  try {
    const kept = Buffer.alloc(BODY_FILE_MAX);
    const scratch = Buffer.alloc(64 * 1024);
    let filled = 0;
    for (;;) {
      const room = BODY_FILE_MAX - filled;
      const target = room > 0 ? kept : scratch;
      const read = readSync(
        fd,
        target,
        room > 0 ? filled : 0,
        room > 0 ? room : scratch.length,
        null,
      );
      if (read === 0) break;
      if (room > 0) filled += read;
      else if (!drain) break;
      if (!drain && BODY_FILE_MAX - filled === 0) break;
    }
    return kept.subarray(0, filled).toString("utf8");
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

function readOrNull(path: string): string | null {
  return readPrefix(path, false);
}

/** The shim's process: read the snapshot, answer, record a write, exit with gh's code. */
export function runGhShim(stateDir: string, argv: readonly string[]): number {
  const snapshot = JSON.parse(
    readFileSync(join(stateDir, GH_SHIM_SNAPSHOT_FILE), "utf8"),
  ) as GhShimSnapshot;
  const answer = answerGh(argv, snapshot, {
    now: () => new Date(),
    cwd: process.cwd(),
    readFile: readOrNull,
    readStdin: () => readPrefix("/dev/stdin", true) ?? "",
    jq: systemJq,
  });
  if (answer.wouldHave !== undefined) {
    appendFileSync(
      join(stateDir, GH_SHIM_WOULD_HAVE_FILE),
      `${JSON.stringify(answer.wouldHave)}\n`,
    );
  }
  process.stdout.write(answer.stdout);
  process.stderr.write(answer.stderr);
  return answer.code;
}

function isEntrypoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  const [stateDir, ...argv] = process.argv.slice(2);
  if (stateDir === undefined) {
    process.stderr.write("usage: bench-gh-shim.ts <stateDir> <gh argv…>\n");
    process.exitCode = 2;
  } else {
    process.exitCode = runGhShim(stateDir, argv);
  }
}
