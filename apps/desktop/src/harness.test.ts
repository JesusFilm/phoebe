import path from "node:path";
import { describe, expect, test } from "vite-plus/test";
import type { CommandRunner } from "../../../src/deployment-compose.ts";
import {
  createHarness,
  cursorDigestsOf,
  cursorTarball,
  isBehind,
  latestLauncherVersion,
  latestVersion,
  needsCursorDigests,
  parseLauncherVersion,
  parseVersions,
  readHarnessPins,
  readLauncherPin,
  registryNpm,
  rewriteHarnessPin,
} from "./harness.ts";

/** The parts of a scaffolded Dockerfile this reads, with Cursor as the template pins it. */
const TEMPLATE = [
  "FROM node:24-bookworm-slim",
  "ARG PHOEBE_AGENT_VERSION=0.13.2",
  "RUN npm install -g phoebe-agent@${PHOEBE_AGENT_VERSION}",
  "",
  "# Provider agent CLI.",
  "ARG CURSOR_AGENT_VERSION=2026.07.23-e383d2b",
  "ARG CURSOR_AGENT_SHA256_X64=aaaa",
  "ARG CURSOR_AGENT_SHA256_ARM64=bbbb",
  "RUN curl -fsSL -o /tmp/cursor-agent.tar.gz \\",
  '      "https://downloads.cursor.com/lab/${CURSOR_AGENT_VERSION}/linux/x64/agent-cli-package.tar.gz"',
  "# Claude Code:  RUN npm install -g @anthropic-ai/claude-code@<version>",
  "# Codex:        RUN npm install -g @openai/codex@<version>",
  "",
  "ENV HOME=/home/phoebe",
  "# Drop privileges.",
  "USER phoebe",
  "",
].join("\n");

describe("what a Dockerfile says about each harness", () => {
  test("the template pins Cursor and installs nothing else, whatever its comments suggest", () => {
    expect(readHarnessPins(TEMPLATE)).toEqual({
      cursor: { kind: "pinned", version: "2026.07.23-e383d2b" },
      claude: { kind: "absent" },
      codex: { kind: "absent" },
    });
  });

  test("an npm harness is pinned by a version on the line or through an ARG", () => {
    const inline = `${TEMPLATE}RUN npm install -g @openai/codex@0.154.0\n`;
    const byArg = `${TEMPLATE}ARG CLAUDE_CODE_VERSION=2.1.228\nRUN npm install -g "@anthropic-ai/claude-code@\${CLAUDE_CODE_VERSION}"\n`;

    expect(readHarnessPins(inline).codex).toEqual({ kind: "pinned", version: "0.154.0" });
    expect(readHarnessPins(byArg).claude).toEqual({ kind: "pinned", version: "2.1.228" });
  });

  test("a bare package, a tag and an ARG nothing declares are all unpinned", () => {
    const bare = `${TEMPLATE}RUN npm install -g @anthropic-ai/claude-code @openai/codex@latest\n`;
    const dangling = `${TEMPLATE}RUN npm install -g @openai/codex@\${NOWHERE}\n`;

    expect(readHarnessPins(bare).claude).toEqual({ kind: "unpinned" });
    expect(readHarnessPins(bare).codex).toEqual({ kind: "unpinned" });
    expect(readHarnessPins(dangling).codex).toEqual({ kind: "unpinned" });
  });

  test("the vendor's installer pipe is Cursor with no pin", () => {
    expect(readHarnessPins("RUN curl https://cursor.com/install -fsS | bash\n").cursor).toEqual({
      kind: "unpinned",
    });
  });

  test("a package whose name only starts the same is another package", () => {
    expect(readHarnessPins("RUN npm install -g @openai/codex-extras@1.0.0\n").codex).toEqual({
      kind: "absent",
    });
  });
});

describe("what a Dockerfile says about the launcher", () => {
  test("the template pins it through its ARG", () => {
    expect(readLauncherPin(TEMPLATE)).toEqual({ kind: "pinned", version: "0.13.2" });
  });

  test("installed with no version is unpinned", () => {
    expect(readLauncherPin("RUN npm install -g phoebe-agent\n")).toEqual({ kind: "unpinned" });
  });

  test("a container that runs the engine from a mount installs none, whatever its paths are called", () => {
    expect(
      readLauncherPin(
        "# no `npm install -g phoebe-agent` here\nENV PHOEBE_ENGINE_DIR=/data/phoebe-agent\nCOPY . /opt/phoebe-agent\n",
      ),
    ).toEqual({ kind: "absent" });
  });
});

describe("upgrade's npm, answered from the registry", () => {
  const real = (args: readonly string[]) => `real:${args.join(" ")}`;

  test("answers the one question upgrade asks of the registry", () => {
    expect(registryNpm("0.14.1", real)(["view", "phoebe-agent", "version"])).toBe("0.14.1");
  });

  test("an unreachable registry throws, as a failed npm view does", () => {
    expect(() => registryNpm(null, real)(["view", "phoebe-agent", "version"])).toThrow(
      /could not be reached/,
    );
  });

  test("everything else goes to the real npm", () => {
    expect(registryNpm("0.14.1", real)(["ls", "-g", "--json"])).toBe("real:ls -g --json");
    expect(registryNpm("0.14.1", real)(["view", "left-pad", "version"])).toBe(
      "real:view left-pad version",
    );
  });

  test("the latest launcher is the registry's, and null when it cannot be had", async () => {
    const asked: string[] = [];
    expect(
      await latestLauncherVersion((url) => {
        asked.push(url);
        return Promise.resolve('{"version":"0.14.1"}');
      }),
    ).toBe("0.14.1");
    expect(asked).toEqual(["https://registry.npmjs.org/phoebe-agent/latest"]);
    expect(await latestLauncherVersion(() => Promise.reject(new Error("offline")))).toBeNull();
  });
});

describe("pinning a harness", () => {
  test("moves the ARG it is installed through, and says what it was", () => {
    const before = `${TEMPLATE}ARG CLAUDE_CODE_VERSION=2.1.228\nRUN npm install -g "@anthropic-ai/claude-code@\${CLAUDE_CODE_VERSION}"\n`;
    const out = rewriteHarnessPin(before, "claude", "2.1.287");

    expect(out).toMatchObject({ ok: true, from: "2.1.228" });
    if (!out.ok) return;
    expect(out.content).toContain("ARG CLAUDE_CODE_VERSION=2.1.287");
    expect(out.content).toContain('"@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"');
  });

  test("gives a bare package a version, and leaves its neighbour on the line alone", () => {
    const before = `${TEMPLATE}RUN npm install -g @anthropic-ai/claude-code @openai/codex\n`;
    const out = rewriteHarnessPin(before, "claude", "2.1.287");

    expect(out).toMatchObject({ ok: true, from: null });
    if (!out.ok) return;
    expect(out.content).toContain(
      "RUN npm install -g @anthropic-ai/claude-code@2.1.287 @openai/codex\n",
    );
    // The commented example above it is not an instruction, and is not touched.
    expect(out.content).toContain(
      "# Claude Code:  RUN npm install -g @anthropic-ai/claude-code@<version>",
    );
  });

  test("replaces a version written on the line", () => {
    const out = rewriteHarnessPin(
      `${TEMPLATE}RUN npm install -g @openai/codex@0.154.0\n`,
      "codex",
      "0.160.0",
    );

    expect(out).toMatchObject({ ok: true, from: "0.154.0" });
    if (out.ok) expect(out.content).toContain("RUN npm install -g @openai/codex@0.160.0\n");
  });

  test("adds one the Dockerfile lacks beside the global install already there", () => {
    const out = rewriteHarnessPin(TEMPLATE, "claude", "2.1.287");

    expect(out).toMatchObject({ ok: true, from: null });
    if (!out.ok) return;
    const lines = out.content.split("\n");
    const at = lines.indexOf("RUN npm install -g phoebe-agent@${PHOEBE_AGENT_VERSION}");
    expect(lines.slice(at + 1, at + 5)).toEqual([
      "",
      '# The CLI the "claude" provider spawns. Pinned, so a rebuild gets the same one.',
      "ARG CLAUDE_CODE_VERSION=2.1.287",
      'RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"',
    ]);
    // Ahead of the point the image takes the unprivileged user's HOME.
    expect(out.content.indexOf("claude-code@$")).toBeLessThan(out.content.indexOf("ENV HOME="));
    expect(readHarnessPins(out.content).claude).toEqual({ kind: "pinned", version: "2.1.287" });
  });

  test("with no global install to sit beside, goes above the drop to the unprivileged user", () => {
    const out = rewriteHarnessPin(
      "FROM node:24\n# Drop privileges.\nUSER phoebe\n",
      "codex",
      "0.160.0",
    );

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.content.split("\n").slice(1, 6)).toEqual([
      '# The CLI the "codex" provider spawns. Pinned, so a rebuild gets the same one.',
      "ARG CODEX_VERSION=0.160.0",
      'RUN npm install -g "@openai/codex@${CODEX_VERSION}"',
      "",
      "# Drop privileges.",
    ]);
  });

  test("a Dockerfile with nowhere to put it is refused with the lines to add", () => {
    const out = rewriteHarnessPin("FROM node:24\n", "codex", "0.160.0");

    expect(out).toMatchObject({ ok: false });
    if (!out.ok) expect(out.instruction).toContain("ARG CODEX_VERSION=0.160.0");
  });

  test("Cursor's version and both digests move together", () => {
    expect(needsCursorDigests(TEMPLATE)).toBe(true);
    const out = rewriteHarnessPin(TEMPLATE, "cursor", "2026.10.01-e373342", {
      x64: "1111",
      arm64: "2222",
    });

    expect(out).toMatchObject({ ok: true, from: "2026.07.23-e383d2b" });
    if (!out.ok) return;
    expect(out.content).toContain("ARG CURSOR_AGENT_VERSION=2026.10.01-e373342\n");
    expect(out.content).toContain("ARG CURSOR_AGENT_SHA256_X64=1111\n");
    expect(out.content).toContain("ARG CURSOR_AGENT_SHA256_ARM64=2222\n");
    // A version with digests left behind would fail the build's own check.
    expect(rewriteHarnessPin(TEMPLATE, "cursor", "2026.10.01-e373342")).toMatchObject({
      ok: false,
    });
  });

  test("a Dockerfile without the Cursor block has no pin to move", () => {
    expect(
      rewriteHarnessPin("FROM node:24\nUSER phoebe\n", "cursor", "2026.10.01-x"),
    ).toMatchObject({ ok: false });
  });

  test("keeps the file's line endings", () => {
    const crlf = TEMPLATE.replace(/\n/g, "\r\n");
    const out = rewriteHarnessPin(crlf, "claude", "2.1.287");

    expect(out.ok && !/[^\r]\n/.test(out.content)).toBe(true);
  });
});

describe("behind or not", () => {
  test("compares the numbers, for npm versions and Cursor's dated builds alike", () => {
    expect(isBehind("2.1.228", "2.1.287")).toBe(true);
    expect(isBehind("2.1.287", "2.1.287")).toBe(false);
    expect(isBehind("2.2.0", "2.1.287")).toBe(false);
    expect(isBehind("2026.07.23-e383d2b", "2026.10.01-e373342")).toBe(true);
    // The same day's other build is not the latest either.
    expect(isBehind("2026.10.01-aaaaaaa", "2026.10.01-e373342")).toBe(true);
  });

  test("says nothing when either side is unknown", () => {
    expect(isBehind(null, "1.0.0")).toBeNull();
    expect(isBehind("1.0.0", null)).toBeNull();
    expect(isBehind("nightly", "1.0.0")).toBeNull();
  });
});

describe("what the container answered", () => {
  test("reads a version out of each CLI's own way of printing one", () => {
    expect(
      parseVersions(
        "agent|2026.07.23-e383d2b\nclaude|2.1.269 (Claude Code)\ncodex|codex-cli 0.154.0\n",
      ),
    ).toEqual({ cursor: "2026.07.23-e383d2b", claude: "2.1.269", codex: "0.154.0" });
  });

  test("the launcher's version is read off the same output", () => {
    expect(parseLauncherVersion("agent|1.2.3\nphoebe-agent|0.13.0\n")).toBe("0.13.0");
    expect(parseLauncherVersion("agent|1.2.3\nphoebe-agent|\n")).toBeNull();
    expect(parseLauncherVersion("agent|1.2.3\n")).toBeNull();
  });

  test("a CLI the container lacks, or one that printed nothing, is null", () => {
    expect(parseVersions("agent|\nclaude|\n")).toEqual({ cursor: null, claude: null, codex: null });
  });
});

describe("the newest published version", () => {
  test("is the registry's latest for an npm harness", async () => {
    const asked: string[] = [];
    const version = await latestVersion("claude", (url) => {
      asked.push(url);
      return Promise.resolve('{"name":"@anthropic-ai/claude-code","version":"2.1.287"}');
    });

    expect(version).toBe("2.1.287");
    expect(asked).toEqual(["https://registry.npmjs.org/@anthropic-ai/claude-code/latest"]);
  });

  test("is the build Cursor's installer would fetch, read out of it and never run", async () => {
    const version = await latestVersion("cursor", () =>
      Promise.resolve(
        'DOWNLOAD_URL="https://downloads.cursor.com/lab/2026.10.01-e373342/${OS}/${ARCH}/agent-cli-package.tar.gz"\n',
      ),
    );

    expect(version).toBe("2026.10.01-e373342");
  });

  test("is null when the lookup fails or answers with something that is not a version", async () => {
    expect(await latestVersion("codex", () => Promise.reject(new Error("offline")))).toBeNull();
    expect(
      await latestVersion("codex", () => Promise.resolve('{"version":"1.0.0 && rm -rf /"}')),
    ).toBeNull();
  });
});

describe("the check and the update", () => {
  const DIR = path.resolve("/repos/ws");
  const DOCKERFILE = path.join(DIR, "container", "Dockerfile");
  const COMPOSE = path.join(DIR, "container", "compose.yml");
  const WITH_CLAUDE = `${TEMPLATE}ARG CLAUDE_CODE_VERSION=2.1.228\nRUN npm install -g "@anthropic-ai/claude-code@\${CLAUDE_CODE_VERSION}"\n`;

  function setup(content: string | null = WITH_CLAUDE) {
    const files = new Map<string, string>([[COMPOSE, "services: {}\n"]]);
    if (content !== null) files.set(DOCKERFILE, content);
    const fetched: string[] = [];
    const digested: string[] = [];
    const ran: (readonly string[])[] = [];
    const runner: CommandRunner = (spec) => {
      ran.push(spec.args);
      // An apply ends on what the one command answers; a check lists them all.
      const applied = spec.args.includes("-u")
        ? spec.args.at(-3) === "claude"
          ? "2.1.228 (Claude Code)\n"
          : "2026.07.23-e383d2b\n"
        : null;
      return Promise.resolve({
        code: 0,
        stdout:
          applied ??
          "agent|2026.07.23-e383d2b\nclaude|2.1.228 (Claude Code)\ncodex|\nphoebe-agent|0.13.0\n",
        stderr: "",
      });
    };
    const harness = createHarness({
      exists: (file) => files.has(file),
      read: (file) => files.get(file) ?? "",
      write: (file, text) => void files.set(file, text),
      runnerFor: () => runner,
      fetchText: (url) => {
        fetched.push(url);
        if (url.includes("phoebe-agent")) return Promise.resolve('{"version":"0.14.1"}');
        if (url.includes("claude-code")) return Promise.resolve('{"version":"2.1.287"}');
        if (url.includes("codex")) return Promise.resolve('{"version":"0.160.0"}');
        return Promise.resolve("https://downloads.cursor.com/lab/2026.10.01-e373342/linux/x64/");
      },
      digest: (url) => {
        digested.push(url);
        return Promise.resolve(url.includes("arm64") ? "arm-digest" : "x64-digest");
      },
      now: () => new Date("2026-10-01T12:00:00Z"),
    });
    return { harness, files, fetched, digested, ran };
  }

  test("opening a page reads the file and asks the container, and nothing else", async () => {
    const { harness, fetched, ran } = setup();

    const report = await harness.check({ dir: DIR, running: true, lookUp: false });

    expect(fetched).toEqual([]);
    expect(ran).toHaveLength(1);
    expect(report).toMatchObject({ dockerfile: DOCKERFILE, containerAsked: true, latestAt: null });
    // The launcher is read beside them: what the file pins, what the container has.
    expect(report.launcher).toEqual({
      pin: { kind: "pinned", version: "0.13.2" },
      running: "0.13.0",
      latest: null,
      behind: null,
    });
    expect(report.harnesses).toEqual([
      {
        harness: "cursor",
        pin: { kind: "pinned", version: "2026.07.23-e383d2b" },
        running: "2026.07.23-e383d2b",
        latest: null,
        behind: null,
      },
      {
        harness: "claude",
        pin: { kind: "pinned", version: "2.1.228" },
        running: "2.1.228",
        latest: null,
        behind: null,
      },
      { harness: "codex", pin: { kind: "absent" }, running: null, latest: null, behind: null },
    ]);
  });

  test("a look-up fills in the latest, and the next check still has it", async () => {
    const { harness, fetched } = setup();

    const looked = await harness.check({ dir: DIR, running: false, lookUp: true });
    const after = await harness.check({ dir: DIR, running: false, lookUp: false });

    expect(fetched).toHaveLength(4);
    expect(looked.latestAt).toBe("2026-10-01T12:00:00.000Z");
    expect(looked.launcher).toEqual({
      pin: { kind: "pinned", version: "0.13.2" },
      running: null,
      latest: "0.14.1",
      behind: true,
    });
    expect(after.launcher.latest).toBe("0.14.1");
    expect(looked.harnesses.map((row) => [row.latest, row.behind])).toEqual([
      ["2026.10.01-e373342", true],
      ["2.1.287", true],
      // Not installed, so there is nothing to be behind with.
      ["0.160.0", null],
    ]);
    expect(after.harnesses.map((row) => row.latest)).toEqual(
      looked.harnesses.map((row) => row.latest),
    );
    // A stopped install has no container to ask, and is not asked.
    expect(looked.containerAsked).toBe(false);
  });

  test("an unpinned harness is behind by what the container has", async () => {
    const { harness } = setup(`${TEMPLATE}RUN npm install -g @anthropic-ai/claude-code\n`);

    const report = await harness.check({ dir: DIR, running: true, lookUp: true });

    expect(report.harnesses[1]).toMatchObject({
      pin: { kind: "unpinned" },
      running: "2.1.228",
      behind: true,
    });
  });

  test("a folder with no Dockerfile reports nothing installed, and no file", async () => {
    const { harness } = setup(null);

    const report = await harness.check({ dir: DIR, running: false, lookUp: false });

    expect(report.dockerfile).toBeNull();
    expect(report.harnesses.every((row) => row.pin.kind === "absent")).toBe(true);
  });

  test("an update writes the pin and says what moved", async () => {
    const { harness, files, digested } = setup();

    const outcome = await harness.update(DIR, { harness: "claude", version: "2.1.287" });

    expect(outcome).toEqual({
      kind: "moved",
      harness: "claude",
      from: "2.1.228",
      to: "2.1.287",
      file: DOCKERFILE,
    });
    expect(files.get(DOCKERFILE)).toContain("ARG CLAUDE_CODE_VERSION=2.1.287");
    // Only Cursor needs digests.
    expect(digested).toEqual([]);
  });

  test("Cursor's update fetches both architectures' tarballs for their digests", async () => {
    const { harness, files, digested } = setup();

    const outcome = await harness.update(DIR, { harness: "cursor", version: "2026.10.01-e373342" });

    expect(outcome).toMatchObject({ kind: "moved", from: "2026.07.23-e383d2b" });
    expect(digested).toEqual([
      cursorTarball("2026.10.01-e373342", "x64"),
      cursorTarball("2026.10.01-e373342", "arm64"),
    ]);
    expect(files.get(DOCKERFILE)).toContain("ARG CURSOR_AGENT_SHA256_X64=x64-digest");
    expect(files.get(DOCKERFILE)).toContain("ARG CURSOR_AGENT_SHA256_ARM64=arm-digest");
  });

  test("applying puts the pinned version into the container, as root, beside the old one", async () => {
    const { harness, ran } = setup();

    // The fake container answers with 2.1.228, which is what the file pins.
    const outcome = await harness.apply(DIR, "claude");

    expect(outcome).toEqual({ kind: "applied", harness: "claude", version: "2.1.228" });
    const argv = ran[0]!;
    const at = argv.indexOf("exec");
    expect(argv.slice(at, at + 5)).toEqual(["exec", "-T", "-u", "root", "phoebe"]);
    // The command, the package and the version go in as arguments, not as script.
    expect(argv.slice(-3)).toEqual(["claude", "@anthropic-ai/claude-code", "2.1.228"]);
    const script = argv[argv.indexOf("-c") + 1]!;
    expect(script).toContain('npm install -g --prefix "$d.tmp" "$pkg@$v"');
    expect(script).toContain('mv -Tf "/usr/local/bin/$h.new" "/usr/local/bin/$h"');
    expect(script).not.toContain("2.1.228");
  });

  test("Cursor is applied from its tarball, checked against the digests the file pins", async () => {
    const { harness, ran } = setup();

    const outcome = await harness.apply(DIR, "cursor");

    expect(outcome).toEqual({ kind: "applied", harness: "cursor", version: "2026.07.23-e383d2b" });
    expect(ran[0]!.slice(-3)).toEqual(["2026.07.23-e383d2b", "aaaa", "bbbb"]);
    expect(ran[0]![ran[0]!.indexOf("-c") + 1]).toContain("sha256sum -c -");
    expect(cursorDigestsOf("FROM node:24\n")).toEqual({ x64: "", arm64: "" });
  });

  test("a container that answers another version after the switch is not called applied", async () => {
    const { harness, files } = setup();
    files.set(DOCKERFILE, WITH_CLAUDE.replace("2.1.228", "2.1.287"));

    const outcome = await harness.apply(DIR, "claude");

    expect(outcome).toMatchObject({ kind: "refused" });
    if (outcome.kind === "refused") expect(outcome.why).toContain("answers 2.1.228");
  });

  test("nothing is applied that the Dockerfile does not pin", async () => {
    const { harness, ran } = setup(`${TEMPLATE}RUN npm install -g @anthropic-ai/claude-code\n`);

    expect(await harness.apply(DIR, "claude")).toMatchObject({ kind: "refused" });
    expect(await harness.apply(DIR, "codex")).toMatchObject({ kind: "refused" });
    expect(ran).toEqual([]);
  });

  test("the version already pinned is left alone", async () => {
    const { harness, files } = setup();

    expect(await harness.update(DIR, { harness: "claude", version: "2.1.228" })).toEqual({
      kind: "unchanged",
      harness: "claude",
      version: "2.1.228",
    });
    expect(files.get(DOCKERFILE)).toBe(WITH_CLAUDE);
  });

  test("anything that is not a version is refused before the file is touched", async () => {
    const { harness, files } = setup();

    const outcome = await harness.update(DIR, {
      harness: "claude",
      version: "1.0.0\nRUN curl evil",
    });

    expect(outcome).toMatchObject({ kind: "refused" });
    expect(files.get(DOCKERFILE)).toBe(WITH_CLAUDE);
    expect(await harness.update(DIR, { harness: "claude", version: "$(id)" })).toMatchObject({
      kind: "refused",
    });
  });

  test("no Dockerfile is a refusal that names the file", async () => {
    const { harness } = setup(null);

    const outcome = await harness.update(DIR, { harness: "claude", version: "2.1.287" });

    expect(outcome).toMatchObject({ kind: "refused" });
    if (outcome.kind === "refused") expect(outcome.why).toContain(DOCKERFILE);
  });
});
