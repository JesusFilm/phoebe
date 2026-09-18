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

    expect(facts).toEqual({ ...STORED, name: "youtube-studio", state: "running" });
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
  };

  test("carries the config's text and a fingerprint of it", () => {
    const facts = directoryFacts(RUNNING, {
      exists: folder("phoebe.config.ts", ".env"),
      read: () => "export default defineConfig({})\n",
    });

    expect(facts.configPath).toBe(path.join(DIR, "phoebe.config.ts"));
    expect(facts.configText).toBe("export default defineConfig({})\n");
    expect(facts.configFingerprint).toMatch(/^[0-9a-f]{16}$/);
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
