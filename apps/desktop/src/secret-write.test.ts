// The two local secret writers (#527 §8, #557).
//
// Contracts:
//   * Which writer is a reading of the install's state, not a choice.
//   * The container writer pipes the value on stdin — never in argv, where
//     `/proc/<pid>/cmdline` would hand it to any process on the host.
//   * The host writer edits the `.env` in place: an existing line is replaced
//     where it stands, a new key is appended, and the rest of the file survives.
//   * Nothing either writer returns, prints or throws carries the value.

import { describe, expect, test } from "vite-plus/test";
import {
  hostEnvPathFor,
  secretSetOutcome,
  secretTargetOf,
  secretWriterFor,
  setSecretInContainer,
  setSecretInHostEnv,
  withEnvValue,
  type StdinSpawner,
} from "./secret-write.ts";

const SECRET = "ghp_a_value_nobody_should_see";

/** An io that keeps every line, so a test can assert on what was *not* said. */
function recordingIo() {
  const lines: string[] = [];
  return {
    lines,
    io: { stdout: (line: string) => lines.push(line), stderr: (line: string) => lines.push(line) },
  };
}

describe("which writer takes the value", () => {
  test("a running install has a container to put it in", () => {
    expect(secretWriterFor("running")).toBe("container");
  });

  test("a stopped or freshly initialised one has only the file", () => {
    expect(secretWriterFor("stopped")).toBe("host-env");
    expect(secretWriterFor("not-initialised")).toBe("host-env");
  });
});

describe("the container writer", () => {
  const deployment = {
    deploymentDir: "/repos/widget",
    composeFile: "/repos/widget/container/compose.yml",
    containerDir: "/repos/widget/container",
    envFile: "/repos/widget/.env",
  };

  function spawner(code = 0) {
    const calls: Array<{ args: readonly string[]; input: string }> = [];
    const spawn: StdinSpawner = (spec) => {
      calls.push({ args: spec.args, input: spec.input });
      spec.onLine("stdout", "[phoebe] secret: wrote GH_TOKEN for acme/widget (edit e1) to …");
      return Promise.resolve({ code });
    };
    return { calls, spawn };
  }

  test("execs `phoebe secret set` in the container with the value on stdin", async () => {
    const { calls, spawn } = spawner();
    const { io } = recordingIo();

    await setSecretInContainer({ deployment, key: "GH_TOKEN", value: SECRET, io, spawner: spawn });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toContain("exec");
    expect(calls[0]!.args).toContain("-T");
    expect(calls[0]!.args.join(" ")).toContain("phoebe secret set GH_TOKEN");
    expect(calls[0]!.input).toBe(SECRET);
  });

  test("the value is in no argument — `/proc/<pid>/cmdline` is readable (#504)", async () => {
    const { calls, spawn } = spawner();
    const { io } = recordingIo();

    await setSecretInContainer({ deployment, key: "GH_TOKEN", value: SECRET, io, spawner: spawn });

    expect(calls[0]!.args.join(" ")).not.toContain(SECRET);
  });

  test("doctor is not chained in — the companion has its own run for that", async () => {
    const { calls, spawn } = spawner();
    const { io } = recordingIo();

    await setSecretInContainer({ deployment, key: "GH_TOKEN", value: SECRET, io, spawner: spawn });

    expect(calls[0]!.args).toContain("--no-doctor");
  });

  test("a named tenant rides through; without one the container decides", async () => {
    const { calls, spawn } = spawner();
    const { io } = recordingIo();

    await setSecretInContainer({
      deployment,
      key: "GH_TOKEN",
      value: SECRET,
      tenant: "acme/widget",
      io,
      spawner: spawn,
    });

    expect(calls[0]!.args.join(" ")).toContain("--tenant acme/widget");
  });

  test("the container's own lines reach the tab", async () => {
    const { spawn } = spawner();
    const { lines, io } = recordingIo();

    await setSecretInContainer({ deployment, key: "GH_TOKEN", value: SECRET, io, spawner: spawn });

    expect(lines.join("\n")).toContain("wrote GH_TOKEN");
    expect(lines.join("\n")).not.toContain(SECRET);
  });

  test("a non-zero exit is a thrown failure that names the key and not the value", async () => {
    const { spawn } = spawner(1);
    const { io } = recordingIo();

    await expect(
      setSecretInContainer({ deployment, key: "GH_TOKEN", value: SECRET, io, spawner: spawn }),
    ).rejects.toThrow(/GH_TOKEN/);
  });
});

describe("the host `.env` writer", () => {
  test("an existing key is replaced where it stands, comments and order intact", () => {
    const before = ["# the deployment token", "GH_TOKEN=old", "", "CURSOR_API_KEY=sk"].join("\n");

    expect(withEnvValue(before, "GH_TOKEN", "new").split("\n")).toEqual([
      "# the deployment token",
      "GH_TOKEN=new",
      "",
      "CURSOR_API_KEY=sk",
    ]);
  });

  test("a new key is appended, and a file with no trailing newline still parses", () => {
    expect(withEnvValue("GH_TOKEN=t", "OPENAI_KEY", "k")).toBe("GH_TOKEN=t\nOPENAI_KEY=k\n");
  });

  test("an empty file becomes one assignment", () => {
    expect(withEnvValue("", "GH_TOKEN", "t")).toBe("GH_TOKEN=t\n");
  });

  test("a commented-out key is not the key — the real one is added below it", () => {
    expect(withEnvValue("# GH_TOKEN=example\n", "GH_TOKEN", "t")).toBe(
      "# GH_TOKEN=example\nGH_TOKEN=t\n",
    );
  });

  test("an `export`-prefixed line is the same key", () => {
    expect(withEnvValue("export GH_TOKEN=old\n", "GH_TOKEN", "new")).toBe("GH_TOKEN=new\n");
  });

  test("a value with a newline is refused rather than truncated", () => {
    expect(() => withEnvValue("", "GH_TOKEN", "one\ntwo")).toThrow(/newline/);
  });

  test("the write lands beside the config, and says added or replaced without the value", () => {
    const written: Array<{ file: string; content: string }> = [];
    const { lines, io } = recordingIo();

    const file = setSecretInHostEnv({
      dir: "/repos/widget",
      key: "GH_TOKEN",
      value: SECRET,
      io,
      deps: {
        exists: () => true,
        read: () => "GH_TOKEN=old\n",
        write: (target, content) => written.push({ file: target, content }),
      },
    });

    expect(file).toBe(hostEnvPathFor("/repos/widget"));
    expect(written[0]!.content).toBe(`GH_TOKEN=${SECRET}\n`);
    expect(lines.join("\n")).toContain("replaced GH_TOKEN");
    expect(lines.join("\n")).not.toContain(SECRET);
  });

  test("a folder with no `.env` yet gets one, and the line says added", () => {
    const { lines, io } = recordingIo();

    setSecretInHostEnv({
      dir: "/repos/widget",
      key: "GH_TOKEN",
      value: SECRET,
      io,
      deps: { exists: () => false, read: () => "", write: () => undefined },
    });

    expect(lines.join("\n")).toContain("added GH_TOKEN");
  });
});

describe("the outcome", () => {
  test("names the writer and where the value landed, and carries no value", () => {
    const outcome = secretSetOutcome({
      key: "GH_TOKEN",
      tenant: null,
      writer: "host-env",
      target: secretTargetOf("host-env", "/repos/widget/.env"),
      at: "2026-09-18T10:00:00.000Z",
    });

    expect(outcome.writer).toBe("host-env");
    expect(outcome.target).toBe("/repos/widget/.env");
    expect(JSON.stringify(outcome)).not.toContain(SECRET);
  });

  test("the container arm names the store rather than a path on this machine", () => {
    expect(secretTargetOf("container", null)).toContain("data volume");
  });
});
