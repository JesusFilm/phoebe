import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { replayEventJournal } from "../src/event-journal.ts";
import { readStatusSnapshot } from "../src/status-store.ts";

assert.equal(
  existsSync("/.phoebe-container"),
  true,
  "status integration must run inside an isolated Phoebe container",
);

const sourceRoot = resolve(import.meta.dirname, "..");
const testRoot = mkdtempSync(join(tmpdir(), "phoebe-status-contract-"));
const seedDir = join(testRoot, "seed");
const originDir = join(testRoot, "origin.git");
const runtimeDir = join(testRoot, "runtime");
const fakeBinDir = join(testRoot, "bin");
const fakeGhStateDir = join(testRoot, "fake-gh");
const promptDir = join(runtimeDir, "prompts");
const stateDir = join(testRoot, "state");
const repoDir = join(testRoot, "repo");
const worktreesDir = join(testRoot, "worktrees");
const configPath = join(runtimeDir, "phoebe.config.ts");
const gitIdentity = {
  ...process.env,
  GIT_AUTHOR_NAME: "Phoebe Contract Test",
  GIT_AUTHOR_EMAIL: "phoebe-contract@example.invalid",
  GIT_COMMITTER_NAME: "Phoebe Contract Test",
  GIT_COMMITTER_EMAIL: "phoebe-contract@example.invalid",
};

function run(file, args, options = {}) {
  return execFileSync(file, args, {
    encoding: "utf8",
    env: gitIdentity,
    stdio: "pipe",
    ...options,
  });
}

function writeExecutable(path, contents) {
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}

try {
  mkdirSync(seedDir, { recursive: true });
  mkdirSync(fakeBinDir, { recursive: true });
  mkdirSync(fakeGhStateDir, { recursive: true });
  mkdirSync(promptDir, { recursive: true });

  run("git", ["init", "--bare", originDir]);
  run("git", ["init", "-b", "main", seedDir]);
  writeFileSync(join(seedDir, "README.md"), "# isolated contract fixture\n");
  run("git", ["-C", seedDir, "add", "README.md"]);
  run("git", ["-C", seedDir, "commit", "-m", "seed"]);
  run("git", ["-C", seedDir, "remote", "add", "origin", originDir]);
  run("git", ["-C", seedDir, "push", "-u", "origin", "main"]);
  run("git", ["--git-dir", originDir, "symbolic-ref", "HEAD", "refs/heads/main"]);

  writeExecutable(
    join(fakeBinDir, "gh"),
    `#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const stateDir = process.env.FAKE_GH_STATE;
if (!stateDir) process.exit(2);
mkdirSync(stateDir, { recursive: true });

if (args[0] === "issue" && args[1] === "list") {
  process.stdout.write(JSON.stringify([{
    number: 1,
    title: "Publish runtime status",
    body: "",
    labels: [{ name: "ready-for-agent" }],
    createdAt: "2026-01-01T00:00:00.000Z"
  }]));
} else if (args[0] === "pr" && args[1] === "list") {
  process.stdout.write(JSON.stringify(
    existsSync(join(stateDir, "pr-created")) ? [{ number: 7 }] : []
  ));
} else if (args[0] === "pr" && args[1] === "create") {
  writeFileSync(join(stateDir, "pr-created"), "7\\n");
  process.stdout.write("https://github.com/owner/repo/pull/7\\n");
} else {
  process.stderr.write("unsupported fake gh invocation: " + args.join(" ") + "\\n");
  process.exit(2);
}
`,
  );

  writeExecutable(
    join(fakeBinDir, "codex"),
    `#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

await new Promise((resolve) => {
  process.stdin.resume();
  process.stdin.on("end", resolve);
});
writeFileSync("contract-result.txt", "implemented by isolated fake agent\\n");
execFileSync("git", ["add", "contract-result.txt"], { stdio: "inherit" });
execFileSync("git", ["commit", "-m", "implement fixture"], { stdio: "inherit" });
process.stdout.write(JSON.stringify({
  type: "item.completed",
  item: { type: "agent_message", text: "Implemented the isolated fixture." }
}) + "\\n");
`,
  );

  const promptPath = join(promptDir, "work.md");
  writeFileSync(promptPath, "Implement issue {{ISSUE_NUMBER}} without network access.\n");
  writeFileSync(
    configPath,
    `export default {
  repoSlug: "owner/repo",
  repoUrl: ${JSON.stringify(originDir)},
  installCommand: "true",
  checkCommand: "true",
  testCommand: "true",
  readyCommand: "true",
  workOrder: ["issues"],
  defaultProvider: "codex",
  promptFiles: {
    issue: ${JSON.stringify(promptPath)},
    conflict: ${JSON.stringify(promptPath)},
    checks: ${JSON.stringify(promptPath)},
    reviews: ${JSON.stringify(promptPath)},
    research: ${JSON.stringify(promptPath)}
  },
  paths: {
    repoDir: ${JSON.stringify(repoDir)},
    worktreesDir: ${JSON.stringify(worktreesDir)},
    stateDir: ${JSON.stringify(stateDir)}
  }
};
`,
  );

  const env = {
    ...gitIdentity,
    PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`,
    GH_TOKEN: "isolated-gh-token",
    OPENAI_KEY: "isolated-provider-key",
    FAKE_GH_STATE: fakeGhStateDir,
    PHOEBE_RUNTIME_ID: "isolated-container-runtime",
  };
  const engine = spawnSync(
    process.execPath,
    [join(sourceRoot, "src", "cli.ts"), "--config", configPath, "--run-once"],
    {
      cwd: runtimeDir,
      env,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    },
  );
  assert.equal(
    engine.status,
    0,
    `real Phoebe run failed\nstdout:\n${engine.stdout}\nstderr:\n${engine.stderr}`,
  );

  const statusResult = readStatusSnapshot(stateDir);
  assert.equal(statusResult.available, true);
  if (!statusResult.available) throw new Error(statusResult.message);
  const status = statusResult.status;
  assert.equal(status.lifecycle.state, "stopped");
  assert.equal(status.lastSuccess?.sequence, 1);
  assert.equal(status.lastFailure, null);
  assert.equal(status.journal.latestSequence, 1);
  assert.equal(status.links.pullRequest, "https://github.com/owner/repo/pull/7");

  const replay = replayEventJournal(stateDir);
  assert.equal(replay.events.length, 1);
  assert.deepEqual(replay.missingRanges, []);
  assert.equal(replay.events[0]?.outcome, "success");
  assert.equal(replay.events[0]?.work.issueNumber, 1);
  assert.equal(replay.events[0]?.work.pullRequestNumber, 7);
  assert.equal(replay.events[0]?.links.pullRequest, "https://github.com/owner/repo/pull/7");

  const projection = spawnSync(
    process.execPath,
    [join(sourceRoot, "src", "cli.ts"), "status", "--json", "--config", configPath],
    {
      cwd: runtimeDir,
      env,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    },
  );
  assert.equal(
    projection.status,
    0,
    `status projection failed\nstdout:\n${projection.stdout}\nstderr:\n${projection.stderr}`,
  );
  assert.deepEqual(JSON.parse(projection.stdout), status);
  assert.equal(readFileSync(join(fakeGhStateDir, "pr-created"), "utf8"), "7\n");

  process.stdout.write("isolated Phoebe status/journal/CLI continuity: passed\n");
} finally {
  rmSync(testRoot, { recursive: true, force: true });
}
