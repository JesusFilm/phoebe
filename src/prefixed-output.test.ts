// Attributable child output (#423). Against real children, because what is
// being claimed is that a command's *whole* output — both streams, a line at a
// time, whatever it exits with — reaches the caller stamped, and a fake spawn
// would only test the assembly of the strings.

import { describe, expect, test } from "vite-plus/test";
import { outputLines, prefixedWriter, runCommandPrefixed } from "./prefixed-output.ts";

describe("outputLines", () => {
  test("splits on newlines and drops the blanks", () => {
    expect(outputLines("first\n\nsecond\n")).toEqual(["first", "second"]);
  });

  test("strips the carriage return git writes when it thinks it has a terminal", () => {
    expect(outputLines("Switched to branch\r\nAlready up to date\r\n")).toEqual([
      "Switched to branch",
      "Already up to date",
    ]);
  });

  test("no output is no lines, not one empty one", () => {
    expect(outputLines("")).toEqual([]);
    expect(outputLines("   \n\t\n")).toEqual([]);
  });
});

describe("prefixedWriter", () => {
  test("stamps every line it is given", () => {
    const written: string[] = [];
    const write = prefixedWriter("[phoebe:acme/widget:work][issues issue:88]", (line) =>
      written.push(line),
    );
    write("Installing dependencies");
    expect(written).toEqual(["[phoebe:acme/widget:work][issues issue:88] Installing dependencies"]);
  });
});

describe("runCommandPrefixed", () => {
  /** Run `command`, returning every line it produced through `echo`. */
  async function capture(command: string): Promise<{ lines: string[]; error: Error | null }> {
    const lines: string[] = [];
    let error: Error | null = null;
    try {
      await runCommandPrefixed({
        command,
        cwd: process.cwd(),
        env: process.env,
        timeoutMs: 30_000,
        echo: (line) => lines.push(`[unit] ${line}`),
      });
    } catch (thrown) {
      error = thrown as Error;
    }
    return { lines, error };
  }

  test("both streams reach the caller, and every line is stamped", async () => {
    const { lines, error } = await capture("echo to-stdout; echo to-stderr 1>&2");

    expect(error).toBeNull();
    expect(lines).toContain("[unit] to-stdout");
    expect(lines).toContain("[unit] to-stderr");
    // The acceptance in one assertion: nothing escaped unattributed.
    expect(lines.every((line) => line.startsWith("[unit] "))).toBe(true);
  });

  test("a line split across two writes arrives whole, not halved", async () => {
    const { lines } = await capture(`printf 'one-'; sleep 0.05; printf 'line\n'`);

    expect(lines).toEqual(["[unit] one-line"]);
  });

  test("output written before a failure is not lost with it", async () => {
    const { lines, error } = await capture("echo made-it-this-far; exit 3");

    expect(lines).toEqual(["[unit] made-it-this-far"]);
    expect(error?.message).toContain("exit 3");
  });

  // The install command failing is how a unit learns its branch is broken, so
  // the rejection is load-bearing rather than tidiness.
  test("a non-zero exit rejects, naming the command", async () => {
    const { error } = await capture("exit 1");

    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toContain("exit 1");
  });

  // An install that leaves something running behind it holds the pipe open, so
  // `close` never arrives. The synchronous runner this replaced returned at the
  // command's exit; this one has to as well, or the unit hangs to its deadline.
  test("a command that exits while a background process holds the pipe still settles", async () => {
    const { lines, error } = await capture("sleep 5 & echo parent-done");

    expect(error).toBeNull();
    expect(lines).toContain("[unit] parent-done");
  });

  test("a command that outlives its budget is killed and rejected", async () => {
    const lines: string[] = [];
    await expect(
      runCommandPrefixed({
        command: "sleep 30",
        cwd: process.cwd(),
        env: process.env,
        timeoutMs: 50,
        echo: (line) => lines.push(line),
      }),
    ).rejects.toThrow(/timed out/);
  });
});
