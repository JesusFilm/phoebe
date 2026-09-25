// The three states a local install can be in, and where each one comes from.

import path from "node:path";
import { describe, expect, test } from "vite-plus/test";
import type { CommandRunner } from "../../../src/deployment-compose.ts";
import { allInstallFacts, directoryFacts, installFacts } from "./install-facts.ts";

const DIR = "/repos/youtube-studio";
const STORED = { dir: DIR, addedAt: "2026-09-18T09:00:00.000Z" };

/** A folder holding whatever files the test names, and nothing else. */
function folder(...files: string[]): (file: string) => boolean {
  const present = new Set([DIR, ...files.map((file) => path.join(DIR, file))]);
  return (file) => present.has(file);
}

const INITIALISED = folder("phoebe.config.ts", path.join("container", "compose.yml"));

/** A Dockerfile carrying the pin `upgrade` writes and reads (src/upgrade.ts). */
function dockerfile(version: string | null): (file: string) => string {
  const pin = version === null ? "" : `ARG PHOEBE_AGENT_VERSION=${version}\n`;
  return () => `FROM node:24-bookworm-slim\n${pin}RUN npm i -g phoebe-agent\n`;
}

/** A Compose that answers `ps` with the rows given. */
function compose(rows: unknown[], code = 0): CommandRunner {
  return () => Promise.resolve({ code, stdout: JSON.stringify(rows), stderr: "" });
}

describe("what a folder is", () => {
  test("a folder with no compose file is not initialised, which is what init is for", async () => {
    const facts = await installFacts(STORED, { exists: folder() });

    expect(facts.state).toBe("not-initialised");
    expect(facts.detail).toBe("no container/compose.yml yet");
  });

  test("a workspace child says so rather than offering to init over the top of it", async () => {
    const facts = await installFacts(STORED, { exists: folder("phoebe.config.ts") });

    expect(facts.state).toBe("not-initialised");
    expect(facts.detail).toContain("workspace child");
  });

  test("a folder that is gone is named as gone, not as a folder waiting for init", async () => {
    const facts = await installFacts(STORED, { exists: () => false });

    expect(facts.state).toBe("not-initialised");
    expect(facts.detail).toContain("not on disk");
  });

  test("carries the folder's own name, because the rail has no room for the path", async () => {
    const facts = await installFacts(STORED, { exists: INITIALISED, dockerPresent: false });

    expect(facts.name).toBe("youtube-studio");
    expect(facts.dir).toBe(DIR);
    expect(facts.addedAt).toBe(STORED.addedAt);
  });
});

describe("what Compose says", () => {
  test("a running phoebe service is a running install", async () => {
    const facts = await installFacts(STORED, {
      exists: INITIALISED,
      runner: compose([{ Service: "phoebe", State: "running" }]),
    });

    expect(facts).toEqual({
      ...STORED,
      name: "youtube-studio",
      deploymentName: "youtube-studio",
      relayUrl: null,
      state: "running",
      containerVersion: null,
    });
  });

  test("an exited container is stopped, with nothing to explain", async () => {
    const facts = await installFacts(STORED, {
      exists: INITIALISED,
      runner: compose([{ Service: "phoebe", State: "exited", ExitCode: 0 }]),
    });

    expect(facts.state).toBe("stopped");
    expect(facts.detail).toBeUndefined();
  });

  test("a container that was never created is stopped too", async () => {
    const facts = await installFacts(STORED, { exists: INITIALISED, runner: compose([]) });

    expect(facts.state).toBe("stopped");
  });

  test("restarting counts as running — it is not a state the rail has a word for", async () => {
    const facts = await installFacts(STORED, {
      exists: INITIALISED,
      runner: compose([{ Service: "phoebe", State: "restarting" }]),
    });

    expect(facts.state).toBe("running");
  });
});

describe("when Docker cannot be asked", () => {
  test("no docker on PATH means nothing is running, and says which", async () => {
    const facts = await installFacts(STORED, { exists: INITIALISED, dockerPresent: false });

    expect(facts.state).toBe("stopped");
    expect(facts.detail).toContain("not on PATH");
  });

  test("a daemon that is down is one line, not a stack", async () => {
    const facts = await installFacts(STORED, {
      exists: INITIALISED,
      runner: () =>
        Promise.resolve({
          code: 1,
          stdout: "",
          stderr: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock.\n  at x\n",
        }),
    });

    expect(facts.state).toBe("stopped");
    expect(facts.detail).toBe(
      "Cannot connect to the Docker daemon at unix:///var/run/docker.sock.",
    );
  });

  test("a probe that throws is a fact about the machine, not a broken list", async () => {
    const facts = await installFacts(STORED, {
      exists: INITIALISED,
      runner: () => Promise.reject(new Error("spawn docker ENOENT")),
    });

    expect(facts.state).toBe("stopped");
    expect(facts.detail).toBe("spawn docker ENOENT");
  });

  test("never invents a fourth state", async () => {
    // Three states and no fourth (#522 §7). Every path above lands on one of
    // them, which is what lets the rail draw an install with three words.
    for (const deps of [
      { exists: folder() },
      { exists: INITIALISED, dockerPresent: false },
      { exists: INITIALISED, runner: compose([{ Service: "phoebe", State: "running" }]) },
    ]) {
      const facts = await installFacts(STORED, deps);
      expect(["running", "stopped", "not-initialised"]).toContain(facts.state);
    }
  });
});

describe("the whole list", () => {
  test("keeps the stored order, so the rail does not reshuffle between reads", async () => {
    const stored = ["/repos/c", "/repos/a", "/repos/b"].map((dir) => ({
      dir,
      addedAt: "2026-09-18T09:00:00.000Z",
    }));

    const facts = await allInstallFacts(stored, { exists: () => false });

    expect(facts.map((install) => install.name)).toEqual(["c", "a", "b"]);
  });
});

describe("what the folder says with no container", () => {
  const RUNNING = {
    dir: DIR,
    name: "youtube-studio",
    addedAt: STORED.addedAt,
    state: "running" as const,
    deploymentName: "youtube-studio",
    relayUrl: null,
    containerVersion: null,
  };

  test("carries the config's text and a fingerprint of it", () => {
    const facts = directoryFacts(RUNNING, {
      exists: folder("phoebe.config.ts", ".env"),
      read: () => "export default defineConfig({})\n",
    });

    expect(facts.configPath).toBe(path.join(DIR, "phoebe.config.ts"));
    expect(facts.configText).toBe("export default defineConfig({})\n");
    // The writer's own format, so the fingerprint a window was shown is the
    // one `config set` checks itself against (#503, #527 §11).
    expect(facts.configFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(facts.envPresent).toBe(true);
  });

  test("the same text fingerprints the same, and an edit moves it", () => {
    const read = (text: string) => () => text;
    const before = directoryFacts(RUNNING, { exists: folder("phoebe.config.ts"), read: read("a") });
    const same = directoryFacts(RUNNING, { exists: folder("phoebe.config.ts"), read: read("a") });
    const after = directoryFacts(RUNNING, { exists: folder("phoebe.config.ts"), read: read("b") });

    expect(same.configFingerprint).toBe(before.configFingerprint);
    expect(after.configFingerprint).not.toBe(before.configFingerprint);
  });

  test("no config is no text and no fingerprint, rather than an empty one", () => {
    const facts = directoryFacts(RUNNING, { exists: folder() });

    expect(facts.configText).toBeNull();
    expect(facts.configFingerprint).toBeNull();
    expect(facts.envPresent).toBe(false);
  });

  test("a config that cannot be read reads as one that is not there", () => {
    const facts = directoryFacts(RUNNING, {
      exists: folder("phoebe.config.ts"),
      read: () => {
        throw new Error("EACCES");
      },
    });

    expect(facts.configText).toBeNull();
  });

  test("the bootstrapper is running exactly when the container is", () => {
    const exists = folder("phoebe.config.ts");

    expect(directoryFacts(RUNNING, { exists }).bootstrapperRunning).toBe(true);
    expect(directoryFacts({ ...RUNNING, state: "stopped" }, { exists }).bootstrapperRunning).toBe(
      false,
    );
  });
});

describe("what the root config says", () => {
  const CONFIG = path.join(DIR, "phoebe.config.ts");

  /** A folder whose config holds `extra` inside the config object. */
  function withConfig(extra: string): { read: (file: string) => string } {
    return {
      read: (file) => {
        if (file !== CONFIG) throw new Error(`nothing reads ${file}`);
        return `const config = {\n  repoSlug: "jesusfilm/youtube-studio",${extra}\n};\nexport default config;\n`;
      },
    };
  }

  test("a config with no relay block dials nothing", async () => {
    const facts = await installFacts(STORED, {
      exists: INITIALISED,
      dockerPresent: false,
      ...withConfig(""),
    });

    expect(facts.relayUrl).toBeNull();
  });

  test("the relay block's url is the relay this install dials", async () => {
    const facts = await installFacts(STORED, {
      exists: INITIALISED,
      dockerPresent: false,
      ...withConfig(`\n  relay: { url: "wss://relay.example.test/deployments" },`),
    });

    expect(facts.relayUrl).toBe("wss://relay.example.test/deployments");
  });

  test("with no relay name, the deployment answers to its repoSlug", async () => {
    const facts = await installFacts(STORED, {
      exists: INITIALISED,
      dockerPresent: false,
      ...withConfig(""),
    });

    expect(facts.deploymentName).toBe("jesusfilm/youtube-studio");
    // Beside the folder's own name, not instead of it — the rail draws one and
    // the relay's rows are matched on the other.
    expect(facts.name).toBe("youtube-studio");
  });

  test("`relay.name` wins, because that is what the deployment tells the relay", async () => {
    const facts = await installFacts(STORED, {
      exists: INITIALISED,
      dockerPresent: false,
      ...withConfig(`\n  relay: { url: "wss://r.test/deployments", name: "the-fleet" },`),
    });

    expect(facts.deploymentName).toBe("the-fleet");
  });

  test("a config that will not parse is read as a config with nothing in it", async () => {
    const facts = await installFacts(STORED, {
      exists: INITIALISED,
      dockerPresent: false,
      read: () => "const config = {",
    });

    expect(facts.relayUrl).toBeNull();
    expect(facts.deploymentName).toBe("youtube-studio");
    // And the install itself is still readable: a broken config is not a reason
    // for the rail to lose the entry.
    expect(facts.state).toBe("stopped");
  });

  test("a folder with no config yet answers with its own name", async () => {
    const facts = await installFacts(STORED, { exists: folder() });

    expect(facts.deploymentName).toBe("youtube-studio");
    expect(facts.relayUrl).toBeNull();
  });
});

describe("which phoebe-agent the container is on", () => {
  test("is the Dockerfile's pin — what the image is built from, and what upgrade moves", async () => {
    const facts = await installFacts(STORED, {
      exists: INITIALISED,
      dockerPresent: false,
      readFile: dockerfile("0.12.1"),
    });

    expect(facts.containerVersion).toBe("0.12.1");
  });

  test("is read for a stopped install too — that is exactly when it is asked for", async () => {
    const facts = await installFacts(STORED, {
      exists: INITIALISED,
      runner: compose([{ Service: "phoebe", State: "exited", ExitCode: 0 }]),
      readFile: dockerfile("0.12.1"),
    });

    expect(facts.state).toBe("stopped");
    expect(facts.containerVersion).toBe("0.12.1");
  });

  test("an unpinned Dockerfile has no version to state", async () => {
    // The build takes whatever npm published last; there is no number here.
    const facts = await installFacts(STORED, {
      exists: INITIALISED,
      dockerPresent: false,
      readFile: dockerfile(null),
    });

    expect(facts.containerVersion).toBeNull();
  });

  test("a Dockerfile that cannot be read is null, and the install is still listed", async () => {
    const facts = await installFacts(STORED, {
      exists: INITIALISED,
      dockerPresent: false,
      readFile: () => {
        throw new Error("EACCES");
      },
    });

    expect(facts.containerVersion).toBeNull();
    expect(facts.state).toBe("stopped");
  });

  test("a folder with no container has none either, and nothing threw looking", async () => {
    const facts = await installFacts(STORED, {
      exists: folder("phoebe.config.ts"),
      readFile: () => {
        throw new Error("nothing should have been read");
      },
    });

    expect(facts.containerVersion).toBeNull();
    expect(facts.state).toBe("not-initialised");
  });
});

describe("a repo that is a workspace child at its root and a deployment in .phoebe/", () => {
  const NESTED = folder(
    "phoebe.config.ts",
    path.join(".phoebe", "phoebe.config.ts"),
    path.join(".phoebe", ".env"),
    path.join(".phoebe", "container", "compose.yml"),
  );
  // Two configs: the tenant entry at the root, and the deployment's own below.
  const configs = (file: string): string =>
    file === path.join(DIR, ".phoebe", "phoebe.config.ts")
      ? 'const config = {\n  repoSlug: "acme/solo",\n  relay: { url: "wss://relay.acme/deployments" },\n};\nexport default config;\n'
      : 'const config = {\n  repoSlug: "acme/child",\n};\nexport default config;\n';

  test("is driven from .phoebe/, and says so", async () => {
    const seen: { args: readonly string[]; cwd?: string | undefined }[] = [];
    const runner: CommandRunner = (spec) => {
      seen.push(spec);
      return Promise.resolve({
        code: 0,
        stdout: JSON.stringify([{ Service: "phoebe", State: "running" }]),
        stderr: "",
      });
    };

    const facts = await installFacts(STORED, {
      exists: NESTED,
      read: configs,
      readFile: dockerfile("0.13.0"),
      runner,
    });

    expect(facts.state).toBe("running");
    expect(facts.deploymentDir).toBe(".phoebe");
    expect(facts.containerVersion).toBe("0.13.0");
    expect(seen[0]?.cwd).toBe(path.join(path.resolve(DIR), ".phoebe", "container"));
  });

  test("its name and relay are the deployment's, not the tenant entry's", async () => {
    const facts = await installFacts(STORED, {
      exists: NESTED,
      read: configs,
      dockerPresent: false,
    });

    expect(facts.deploymentName).toBe("acme/solo");
    expect(facts.relayUrl).toBe("wss://relay.acme/deployments");
  });

  test("the directory facts read the deployment's config and .env", () => {
    const facts = directoryFacts(
      {
        dir: DIR,
        name: "youtube-studio",
        deploymentName: "acme/solo",
        relayUrl: null,
        addedAt: STORED.addedAt,
        state: "stopped",
        containerVersion: null,
        deploymentDir: ".phoebe",
      },
      { exists: NESTED, read: configs },
    );

    expect(facts.configPath).toBe(path.join(DIR, ".phoebe", "phoebe.config.ts"));
    expect(facts.configText).toContain("acme/solo");
    expect(facts.envPresent).toBe(true);
  });

  test("a stock layout carries no deploymentDir, because there is nothing to say", async () => {
    const facts = await installFacts(STORED, { exists: INITIALISED, dockerPresent: false });

    expect(facts.deploymentDir).toBeUndefined();
  });
});

describe("what the rail calls it", () => {
  test("the operator's label when there is one, else the folder's name", async () => {
    const exists = () => false;
    const plain = await installFacts({ dir: "/repos/youtube-studio", addedAt: "2026-09-18T09:00:00.000Z" }, { exists });
    expect(plain.name).toBe("youtube-studio");
    expect(plain.label).toBeUndefined();
    const named = await installFacts(
      { dir: "/repos/youtube-studio", addedAt: "2026-09-18T09:00:00.000Z", name: "Studio" },
      { exists },
    );
    expect(named.name).toBe("Studio");
    expect(named.label).toBe("Studio");
  });
});

describe("a workspace root", () => {
  const WORKSPACE =
    'const config = {\n  engine: { ref: "main" },\n  workspace: { depth: 1 },\n};\nexport default config;\n';
  const CHILD = (slug: string) =>
    `const config = {\n  repoSlug: "${slug}",\n};\nexport default config;\n`;
  const present = new Set([
    DIR,
    path.join(DIR, "phoebe.config.ts"),
    path.join(DIR, "container", "compose.yml"),
    path.join(DIR, "widget", "phoebe.config.ts"),
    path.join(DIR, "api", "phoebe.config.ts"),
  ]);
  const sources: Record<string, string> = {
    [path.join(DIR, "phoebe.config.ts")]: WORKSPACE,
    [path.join(DIR, "widget", "phoebe.config.ts")]: CHILD("acme/widget"),
    [path.join(DIR, "api", "phoebe.config.ts")]: CHILD("acme/api"),
  };
  const deps = {
    exists: (file: string) => present.has(file),
    read: (file: string) => {
      const source = sources[file];
      if (source === undefined) throw new Error(`no ${file}`);
      return source;
    },
    listDirs: (dir: string) => (dir === DIR ? ["widget", "node_modules", "api", ".git"] : []),
    dockerPresent: false,
  };

  test("lists its children as the bootstrapper would find them, by slug", async () => {
    const facts = await installFacts(STORED, deps);

    expect(facts.workspace?.children.map((child) => child.slug)).toEqual([
      "acme/api",
      "acme/widget",
    ]);
    expect(facts.workspace?.children[0]?.dir).toBe(path.join(DIR, "api"));
  });

  test("a solo install has no children to list", async () => {
    const facts = await installFacts(STORED, {
      exists: INITIALISED,
      read: () => CHILD("acme/solo"),
      dockerPresent: false,
    });

    expect(facts.workspace).toBeUndefined();
  });
});

describe("an install inside a WSL distro", () => {
  const B = "\\";
  const WSL_DIR = `${B}${B}wsl.localhost${B}archlinux${B}home${B}mike${B}development`;
  const WSL_STORED = { dir: WSL_DIR, addedAt: "2026-09-22T09:00:00.000Z" };

  // The folder as Windows shows it, and as the resolver re-spells it — the same
  // set on Windows, two spellings on a POSIX test runner, where `resolve` treats
  // the UNC path as relative. Both are answered so the test holds on either.
  function wslFolder(...files: string[]): (file: string) => boolean {
    const roots = [WSL_DIR, path.resolve(WSL_DIR)];
    const present = new Set(
      roots.flatMap((root) => [root, ...files.map((f) => path.join(root, f))]),
    );
    return (file) => present.has(file);
  }
  const WSL_INITIALISED = wslFolder("phoebe.config.ts", path.join("container", "compose.yml"));

  /** A Compose that records what it was asked to run and answers `ps` with `rows`. */
  function recording(rows: unknown[]): {
    runner: CommandRunner;
    seen: { file: string; args: readonly string[] }[];
  } {
    const seen: { file: string; args: readonly string[] }[] = [];
    const runner: CommandRunner = (spec) => {
      seen.push(spec);
      return Promise.resolve({ code: 0, stdout: JSON.stringify(rows), stderr: "" });
    };
    return { runner, seen };
  }

  test("says which distro it is in and where, beside the path Windows shows", async () => {
    const facts = await installFacts(WSL_STORED, { exists: wslFolder(), dockerPresent: false });

    expect(facts.dir).toBe(WSL_DIR);
    expect(facts.name).toBe("development");
    expect(facts.wsl).toEqual({ distro: "archlinux", dir: "/home/mike/development" });
  });

  test("a folder on this machine carries no distro", async () => {
    const facts = await installFacts(STORED, { exists: folder(), dockerPresent: false });

    expect(facts.wsl).toBeUndefined();
  });

  test("asks the distro's Compose through wsl.exe, and reads the state it answers", async () => {
    const { runner, seen } = recording([{ Service: "phoebe", State: "running" }]);

    const facts = await installFacts(WSL_STORED, {
      exists: WSL_INITIALISED,
      readFile: dockerfile("0.13.0"),
      runner,
    });

    // The path translation itself is wsl.test.ts's: on a POSIX test runner
    // `resolve` re-spells the UNC path into something no distro has a name for.
    expect(facts.state).toBe("running");
    expect(seen[0]?.file).toBe("wsl.exe");
    expect(seen[0]?.args.slice(0, 2)).toEqual(["-d", "archlinux"]);
    expect(seen[0]?.args).toContain("--exec");
    expect(seen[0]?.args).toContain("docker");
    expect(seen[0]?.args).toContain("compose");
  });

  test("this machine having no docker is not a verdict on the distro", async () => {
    const { runner, seen } = recording([]);

    const facts = await installFacts(WSL_STORED, {
      exists: WSL_INITIALISED,
      readFile: dockerfile("0.13.0"),
      dockerPresent: false,
      runner,
    });

    expect(seen).toHaveLength(1);
    expect(facts.state).toBe("stopped");
    expect(facts.detail).toBeUndefined();
  });
});
