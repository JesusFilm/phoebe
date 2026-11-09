// Running the sources: all at once, each under its own deadline, a failure or
// a throw a log line, and the union in the listed order with duplicates merged.

import { describe, expect, test } from "vite-plus/test";
import type { Candidate } from "../candidate.ts";
import { runSources, type SourceRun } from "./run.ts";

function candidate(pkg: string, overrides: Partial<Candidate> = {}): Candidate {
  return {
    manager: "npm",
    package: pkg,
    current: "1.0.0",
    target: "1.1.0",
    updateType: "minor",
    depType: "prod",
    workspace: "package.json",
    advisories: [],
    peers: [],
    ...overrides,
  };
}

function source(name: string, run: SourceRun["run"], timeoutMs = 1_000): SourceRun {
  return { name, timeoutMs, run };
}

describe("runSources", () => {
  test("unions what finished, earlier sources first, and logs one line for all", async () => {
    const logged: string[] = [];
    const outcome = await runSources(
      [
        source("native", async () => ({
          ok: true,
          candidates: [candidate("a", { publishedAt: "2026-10-01T00:00:00Z" })],
        })),
        source("agent", async () => ({ ok: false, problem: "no file" })),
        source("renovate", async () => {
          throw new Error("spawn failed");
        }),
        source("late", async () => ({
          ok: true,
          candidates: [
            candidate("a", { publishedAt: "2020-01-01T00:00:00Z", repositoryUrl: "https://x/a" }),
            candidate("b"),
          ],
        })),
      ],
      { signal: new AbortController().signal, log: (l) => logged.push(l) },
    );
    expect(outcome.finished).toEqual(["native", "late"]);
    expect(outcome.candidates.map((c) => c.package)).toEqual(["a", "b"]);
    expect(outcome.candidates[0]).toMatchObject({
      publishedAt: "2026-10-01T00:00:00Z",
      repositoryUrl: "https://x/a",
    });
    expect(logged).toEqual([
      "sources: native 1 candidate(s), agent failed (no file), renovate failed (spawn failed), late 2 candidate(s).",
    ]);
  });

  test("a source past its deadline is aborted and counted failed while the rest stand", async () => {
    let aborted = false;
    const logged: string[] = [];
    const outcome = await runSources(
      [
        source(
          "hung",
          (signal) =>
            new Promise(() => {
              signal.addEventListener("abort", () => {
                aborted = true;
              });
            }),
          20,
        ),
        source("quick", async () => ({ ok: true, candidates: [candidate("a")] })),
      ],
      { signal: new AbortController().signal, log: (l) => logged.push(l) },
    );
    expect(aborted).toBe(true);
    expect(outcome.finished).toEqual(["quick"]);
    expect(logged[0]).toContain("hung failed (did not finish within 20ms)");
  });

  test("the sources run at once, not one after another", async () => {
    const started: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const waiting =
      (name: string): SourceRun["run"] =>
      async () => {
        started.push(name);
        if (started.length === 2) release();
        await gate;
        return { ok: true, candidates: [] };
      };
    await runSources([source("one", waiting("one")), source("two", waiting("two"))], {
      signal: new AbortController().signal,
      log: () => {},
    });
    expect(started).toEqual(["one", "two"]);
  });
});
