// Guards the hardening invariants of the runtime image, across *both* copies of
// it: the shipped scaffold (`templates/container/Dockerfile`, the file consumers
// actually get) and the dogfood adaptation (`.phoebe/container/Dockerfile`).
//
// The two files deliberately differ — the dogfood carries no Phoebe code and
// gets its bootstrapper from a mount — but the security properties below are
// not among the permitted deviations. A fix that lands in only one of them is
// not a fix, which is exactly the failure mode this file exists to catch.
//
// A third image joins them at the end: the relay's, which `phoebe relay init`
// writes rather than ships. It is the deployment image minus every agent CLI,
// so it gets its own assertions — but the privilege drop is compared against
// the shipped scaffold rather than restated, for the same reason as above. The
// relay's compose file is checked alongside it, because the sidecar that
// terminates TLS and the volume they share are what make the image runnable.
//
// Every assertion runs against `instructionsOnly()`, never the raw file. These
// Dockerfiles document at length what they deliberately *stopped* doing, so the
// prose quotes the very things being asserted against — the note explaining why
// we no longer pipe the vendor installer into a shell contains the words
// `curl … | bash`, and the header comment lists all four `/data` paths. Matching
// against comments would let someone delete the real instruction and stay green.
//
// Like `vouched-file.test.ts`, this is repo governance rather than engine
// behaviour. It lives under `src/` because test files never ship (package.json
// `files` excludes `**/*.test.ts`) and `vp test` already covers this tree.

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { runRelayInit } from "../relay/init.ts";

const repoRoot = join(import.meta.dirname, "..");

const SCAFFOLD_DOCKERFILE = "templates/container/Dockerfile";
const DOGFOOD_DOCKERFILE = ".phoebe/container/Dockerfile";

const DOCKERFILES = {
  "templates/container/Dockerfile (shipped scaffold)": SCAFFOLD_DOCKERFILE,
  ".phoebe/container/Dockerfile (dogfood)": DOGFOOD_DOCKERFILE,
} as const;

/** The two named-volume mount points from compose.yml (#62 two-volume layout). */
const DATA_DIRS = ["/data/repos", "/data/engine"] as const;

function read(relPath: string): string {
  return readFileSync(join(repoRoot, relPath), "utf8");
}

/** The Dockerfile with `#` comment lines stripped — see the header note. */
function instructionsOnly(source: string): string {
  return source
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
}

/** Index of the first instruction line matching `pattern`, or -1. */
function instructionIndex(source: string, pattern: RegExp): number {
  return instructionsOnly(source)
    .split("\n")
    .findIndex((line) => pattern.test(line));
}

/**
 * The multi-line `RUN` that downloads, verifies, and links the provider CLI —
 * from `RUN set -eux;` through the last backslash-continued line.
 */
function providerInstallBlock(source: string): string {
  const lines = instructionsOnly(source).split("\n");
  const start = lines.findIndex((line) => line.startsWith("RUN set -eux;"));
  if (start === -1) return "";
  const block: string[] = [];
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    block.push(line);
    if (!line.trimEnd().endsWith("\\")) break;
  }
  return block.join("\n");
}

describe.each(Object.entries(DOCKERFILES))("%s", (_label, relPath) => {
  test("drops out of root into a dedicated unprivileged user", () => {
    // Without a USER the whole workload — boot, the engine, the agent child,
    // and the target repo's install/check/test commands — runs as root.
    const instructions = instructionsOnly(read(relPath));
    expect(instructions).toMatch(/^RUN useradd .*\bphoebe\b/m);
    expect(instructions).toMatch(/^USER phoebe$/m);
  });

  test("creates and chowns the /data mount points before dropping privileges", () => {
    // Docker seeds a *fresh* named volume from the image's contents at that
    // path, ownership included. If the directory does not exist in the image,
    // Docker creates the mount point as root:root and the unprivileged user
    // cannot write its clone, worktrees, state, or engine checkouts. So these
    // have to be made and chowned while still root.
    //
    // Asserted against the `mkdir` instruction specifically: both paths are
    // also listed in the header comment of the shipped template, so a check for
    // the bare strings would survive deleting the line that does the work.
    const dockerfile = read(relPath);
    const mkdirLine = instructionsOnly(dockerfile)
      .split("\n")
      .find((line) => line.includes("mkdir -p /data"));
    expect(mkdirLine).toBeDefined();
    for (const dir of DATA_DIRS) {
      expect(mkdirLine).toContain(dir);
    }
    const chownIndex = instructionIndex(dockerfile, /chown -R phoebe:phoebe \/data/);
    const userIndex = instructionIndex(dockerfile, /^USER phoebe$/);
    expect(chownIndex).toBeGreaterThan(-1);
    expect(userIndex).toBeGreaterThan(chownIndex);
  });

  test("installs the provider CLI from a pinned, checksum-verified artifact", () => {
    // `curl … | bash` executes whatever the vendor serves at build time, and
    // bakes an unrecorded version into the image. Pin the artifact and verify
    // it instead.
    const instructions = instructionsOnly(read(relPath));
    expect(instructions).not.toMatch(/curl[^\n]*\|\s*(bash|sh)\b/);
    expect(instructions).toMatch(/^ARG CURSOR_AGENT_VERSION=/m);
    expect(instructions).toContain("sha256sum -c");
  });

  test("pins a checksum for every architecture it will build for", () => {
    // The build hard-fails on a digest mismatch, so a wrong or missing arm64
    // digest breaks the build for every Apple-silicon consumer while amd64
    // stays green — exactly the "fails to build for every consumer" trap.
    // Every arch the case arm names must have a digest, and vice versa.
    const block = providerInstallBlock(read(relPath));
    const instructions = instructionsOnly(read(relPath));
    for (const arch of ["X64", "ARM64"]) {
      expect(instructions).toMatch(
        new RegExp(`^ARG CURSOR_AGENT_SHA256_${arch}=[0-9a-f]{64}$`, "m"),
      );
      expect(block).toContain(`CURSOR_AGENT_SHA256_${arch}`);
    }
  });

  test("ships the vendored node 0711 (unreadable exec → non-dumpable, #61)", () => {
    // The agent runs as the same uid 10001 as every tenant's engine child. A
    // process that execs a binary it cannot *read* is made non-dumpable by the
    // kernel (would_dump() in fs/exec.c) — a same-uid sibling can't read its
    // /proc/<pid>/environ and lift another tenant's secrets. Enforced by shipping
    // the binary root:root mode 0711 (executable, not readable by others), inside
    // the pinned install block so it can't drift.
    //
    // The 0711 is on `node`, NOT on the `cursor-agent` entry point: every entry
    // point the vendor ships is a *shell script* that execs this bundled `node`,
    // and a shell script chmod-ed 0711 just fails to run (its interpreter can't
    // read it — `bash: agent: Permission denied`, exit 126). `node` is the
    // long-lived process that actually holds GH_TOKEN and the provider key
    // (src/agent-env.ts) in its environ, so it is the one that must be
    // non-dumpable — and every entry point funnels through it, so one chmod
    // covers them all. Guard against a regression back onto the wrapper.
    const block = providerInstallBlock(read(relPath));
    expect(block).toMatch(/chmod 0711 \/opt\/cursor-agent\/node/);
    expect(block).not.toMatch(/chmod 0711 \/opt\/cursor-agent\/cursor-agent/);
  });

  test("makes the system node non-dumpable (supervisor + engine children, #196)", () => {
    // The supervisor (`phoebe boot`) and every engine child run on the image's
    // system node. Without execute-only mode those long-lived processes stay
    // dumpable — a same-uid sibling can read /proc/<pid>/environ and lift
    // GH_TOKEN or a provider key. Root-owned 0711 makes every exec of this
    // binary non-dumpable (the kernel's unreadable-binary path in fs/exec.c,
    // not AT_SECURE, which stays 0 here). The shebang shims
    // (`npm`) are read by the *kernel*, not by node, so they are unaffected.
    const instructions = instructionsOnly(read(relPath));
    expect(instructions).toMatch(/RUN chmod 0711 "\$\(command -v node\)"/);
  });

  test("keeps the provider CLI on PATH as `agent` after the privilege drop", () => {
    // The engine spawns the provider CLI by bare name and the agent child
    // inherits only the allowlisted PATH (src/agent-env.ts), so an install
    // location the unprivileged user cannot resolve dies with `spawn agent
    // ENOENT` at the first work unit.
    const instructions = instructionsOnly(read(relPath));
    expect(instructions).toMatch(/ln -s \S+ \/usr\/local\/bin\/agent\b/);
  });
});

describe("the two Dockerfiles stay in step", () => {
  const pinArgs = (source: string) =>
    instructionsOnly(source)
      .split("\n")
      .filter((line) => line.startsWith("ARG CURSOR_AGENT_"));

  test("identical provider CLI pins", () => {
    // Bumping the pin in one file and not the other would silently give the
    // dogfood a different agent than every consumer runs.
    const scaffold = pinArgs(read(SCAFFOLD_DOCKERFILE));
    const dogfood = pinArgs(read(DOGFOOD_DOCKERFILE));
    expect(scaffold.length).toBeGreaterThan(0);
    expect(dogfood).toEqual(scaffold);
  });

  test("byte-identical provider CLI install block", () => {
    // The pins alone are not enough: the download URL, the extract flags, the
    // install prefix, and the symlink targets can all drift while the three ARG
    // values still match. This is the file whose whole premise is that a fix
    // landing in only one copy is not a fix, so compare the work, not just the
    // constants.
    const scaffold = providerInstallBlock(read(SCAFFOLD_DOCKERFILE));
    const dogfood = providerInstallBlock(read(DOGFOOD_DOCKERFILE));
    expect(scaffold).not.toBe("");
    expect(dogfood).toBe(scaffold);
  });

  test("identical privilege-drop instructions", () => {
    const dropInstructions = (source: string) =>
      instructionsOnly(source)
        .split("\n")
        .filter((line) => /^(USER |ENV HOME=|RUN useradd)/.test(line));
    expect(dropInstructions(read(DOGFOOD_DOCKERFILE))).toEqual(
      dropInstructions(read(SCAFFOLD_DOCKERFILE)),
    );
  });
});

// ------------------------------------------------------------- the relay image

/**
 * The relay scaffold as an operator actually gets it: rendered into a temp dir
 * by `phoebe relay init`, not read out of `templates/`. The template carries
 * `{{CLI_VERSION}}` where the version pin goes, so only the built file can be
 * checked for a pin at all — and a scaffolder that stopped writing one of these
 * files would fail here rather than in someone's deployment.
 */
function relayScaffold(): { dockerfile: string; compose: string } {
  const dir = mkdtempSync(join(tmpdir(), "phoebe-relay-scaffold-"));
  runRelayInit({ targetDir: dir });
  return {
    dockerfile: readFileSync(join(dir, "relay", "Dockerfile"), "utf8"),
    compose: readFileSync(join(dir, "relay", "compose.yml"), "utf8"),
  };
}

/** One `  <name>:` service block out of a compose file, comments stripped. */
function serviceBlock(compose: string, name: string): string {
  const lines = instructionsOnly(compose).split("\n");
  const start = lines.findIndex((line) => line === `  ${name}:`);
  if (start === -1) return "";
  const block: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== "" && !/^ {4}/.test(line)) break;
    block.push(line);
  }
  return block.join("\n");
}

/** The names under the top-level `volumes:` key. */
function namedVolumes(compose: string): string[] {
  const lines = instructionsOnly(compose).split("\n");
  const start = lines.findIndex((line) => line === "volumes:");
  if (start === -1) return [];
  const names: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== "" && !/^\s/.test(line)) break;
    const match = /^ {2}([\w-]+):\s*$/.exec(line);
    if (match) names.push(match[1]!);
  }
  return names;
}

describe("the relay image `phoebe relay init` scaffolds", () => {
  test("drops into the same unprivileged user, the same way", () => {
    // The relay holds GOOGLE_CLIENT_SECRET in its environment for the life of
    // the process. Everything the deployment image does to keep a secret out of
    // a sibling's reach applies here unchanged, so the lines are compared
    // against that image rather than restated.
    const dropInstructions = (source: string) =>
      instructionsOnly(source)
        .split("\n")
        .filter((line) => /^(USER |ENV HOME=|RUN useradd)/.test(line));

    expect(dropInstructions(relayScaffold().dockerfile)).toEqual(
      dropInstructions(read(SCAFFOLD_DOCKERFILE)),
    );
  });

  test("creates and chowns /data before dropping privileges", () => {
    // One volume, mounted at /data and shared with the TLS sidecar. The relay
    // is the service that seeds it (compose has Caddy depend on the relay), so
    // the ownership the volume inherits is the one set here.
    const dockerfile = relayScaffold().dockerfile;
    const mkdirLine = instructionsOnly(dockerfile)
      .split("\n")
      .find((line) => line.includes("mkdir -p /data"));
    expect(mkdirLine).toContain("/data/relay");
    const chownIndex = instructionIndex(dockerfile, /chown -R phoebe:phoebe \/data/);
    expect(chownIndex).toBeGreaterThan(-1);
    expect(instructionIndex(dockerfile, /^USER phoebe$/)).toBeGreaterThan(chownIndex);
  });

  test("makes the system node non-dumpable (#196)", () => {
    expect(instructionsOnly(relayScaffold().dockerfile)).toMatch(
      /RUN chmod 0711 "\$\(command -v node\)"/,
    );
  });

  test("installs the relay from a pinned version and nothing else", () => {
    // "The image is the container Dockerfile minus agent CLIs" (#506 §1). A
    // provider CLI here would be a second thing to pin and a much larger blast
    // radius on a host that answers the public internet.
    const instructions = instructionsOnly(relayScaffold().dockerfile);
    const globalInstalls = instructions
      .split("\n")
      .filter((line) => line.includes("npm install -g"));

    expect(globalInstalls).toHaveLength(1);
    expect(globalInstalls[0]).toContain("phoebe-agent@${PHOEBE_AGENT_VERSION}");
    expect(instructions).toMatch(/^ARG PHOEBE_AGENT_VERSION=\d+\.\d+\.\d+$/m);
    expect(instructions).not.toMatch(/cursor|claude-code|@openai\/codex/);
    expect(instructions).not.toMatch(/curl[^\n]*\|\s*(bash|sh)\b/);
  });

  test("its main process is `phoebe relay serve`, behind tini", () => {
    const instructions = instructionsOnly(relayScaffold().dockerfile);

    expect(instructions).toMatch(
      /^ENTRYPOINT \["\/usr\/bin\/tini", "--", "phoebe", "relay", "serve"\]$/m,
    );
    // No EXPOSE: only the sidecar on the compose network reaches 8787.
    expect(instructions).not.toMatch(/^\s*EXPOSE\b/m);
  });
});

describe("the relay compose file `phoebe relay init` scaffolds", () => {
  test("runs the relay from the Dockerfile beside it", () => {
    const relay = serviceBlock(relayScaffold().compose, "relay");

    expect(relay).toMatch(/^\s+build:$/m);
    expect(relay).toMatch(/^\s+context: \.$/m);
  });

  test("passes the relay its four environment variables, ALLOWED_EMAILS blankable", () => {
    // `:?` refuses a blank value; `?` refuses only an unset one. ALLOWED_EMAILS
    // gets the second because blank is an answer there (#506 §9): it means the
    // first verified sign-in claims the relay.
    const relay = serviceBlock(relayScaffold().compose, "relay");

    for (const name of ["RELAY_HOST", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]) {
      expect(relay).toContain(`${name}: "\${${name}:?`);
    }
    expect(relay).toContain('ALLOWED_EMAILS: "${ALLOWED_EMAILS?');
  });

  test("puts a Caddy sidecar keyed on RELAY_HOST in front of it (#506 §2)", () => {
    const caddy = serviceBlock(relayScaffold().compose, "caddy");

    expect(caddy).toMatch(/image: caddy:\d+\.\d+\.\d+-alpine$/m);
    expect(caddy).toContain('"--from"');
    expect(caddy).toContain("${RELAY_HOST:?");
    expect(caddy).toContain('"relay:8787"');
    // The relay never terminates TLS, so the sidecar is the only front door.
    expect(caddy).toContain('"80:80"');
    expect(caddy).toContain('"443:443"');
    expect(serviceBlock(relayScaffold().compose, "relay")).not.toMatch(/^\s+ports:$/m);
  });

  test("one named volume, mounted by both services (#506 §3)", () => {
    // The relay writes /data/relay, Caddy writes /data/caddy under the
    // XDG_DATA_HOME its image sets. Two mounts, one thing to back up — and
    // certificates that survive a restart instead of being re-issued.
    const compose = relayScaffold().compose;

    expect(namedVolumes(compose)).toEqual(["relay-data"]);
    expect(serviceBlock(compose, "relay")).toContain("- relay-data:/data");
    expect(serviceBlock(compose, "caddy")).toContain("- relay-data:/data");
  });

  test("Caddy starts after the relay, so the relay seeds the shared volume", () => {
    // Docker seeds a fresh named volume from the image of whichever container
    // mounts it first, ownership included. The Caddy image carries no /data at
    // all; started first, it would leave /data root-owned and the unprivileged
    // relay unable to write its own directory.
    const caddy = serviceBlock(relayScaffold().compose, "caddy");

    expect(caddy).toMatch(/depends_on:\n\s+- relay$/m);
  });
});
