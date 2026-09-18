// The layering guard on the host verbs (#552, map #497).
//
// Every verb is now callable in-process: `runInit`, `runStart`, `runStop`,
// `runUpgrade`, `runMigrate`, `runDoctor` each take options, write through an
// injected io, and return a typed outcome from `phoebe-agent/contracts`. The
// companion's main process calls them with an io that emits `run:line` events
// (#527 §3), which only works while the verbs themselves stay out of the
// process's streams.
//
// So: `process.argv`, `process.stdout`, `process.stderr`, `process.exit` and
// `process.exitCode` may appear in a verb module only inside its `run<Verb>Cli`
// wrapper. That wrapper is the CLI layer — it parses argv, prints, and decides
// the exit code. Everything else in the file answers to a caller that may have
// no terminal at all.
//
// The scan is textual, and deliberately so: nothing in the type system can say
// "this function may not reach a global". It segments each module by top-level
// declaration and asks which declaration a forbidden reference sits under.
// `process.env` and `process.cwd()` are not on the list — they are ambient
// facts a verb may read, not a stream it may write.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import type { HostVerb, OutcomeOf } from "./contracts/host-verb.ts";
import { runDoctor } from "./doctor.ts";
import { runInit } from "./init.ts";
import { runMigrate } from "./migrate.ts";
import { runStart } from "./start.ts";
import { runStop } from "./stop.ts";
import { runUpgrade } from "./upgrade.ts";

const srcDir = import.meta.dirname;

/** The six verbs the engine ships as modules, as module basenames. */
const VERBS = ["init", "start", "stop", "upgrade", "migrate", "doctor"] as const;

/**
 * The host verbs with no module here to scan. `pair` is composed in the
 * companion's main process out of a relay mint, two file writes and a nudge
 * (#527 §14, #558) — it needs the device token, which the engine never holds —
 * so there is no `src/pair.ts`. Naming it keeps the tie below honest: a seventh
 * *engine* verb would have to join VERBS instead of this list.
 */
const COMPANION_VERBS = ["pair"] as const;

// A compile-time tie between the lists this file names and the contract union.
// Adding a verb to one without the other stops type-checking, which is the
// only way the guard can stay honest about "every host verb".
type Listed = (typeof VERBS)[number] | (typeof COMPANION_VERBS)[number];
type MutuallyExhaustive = Listed extends HostVerb
  ? HostVerb extends Listed
    ? true
    : never
  : never;
const _verbsMatchTheContract: MutuallyExhaustive = true;
void _verbsMatchTheContract;

// Each verb hands back the outcome its contract entry names. `runMigrate`'s is
// the fleet report; `runInit`'s resolves through the overload a plain call picks.
type Yields<F, V extends HostVerb> = Awaited<F> extends OutcomeOf<V> ? true : never;
const _outcomes: [
  Yields<ReturnType<typeof runInit>, "init">,
  Yields<ReturnType<typeof runStart>, "start">,
  Yields<ReturnType<typeof runStop>, "stop">,
  Yields<ReturnType<typeof runUpgrade>, "upgrade">,
  Yields<ReturnType<typeof runMigrate>, "migrate">,
  Yields<ReturnType<typeof runDoctor>, "doctor">,
] = [true, true, true, true, true, true];
void _outcomes;

const FORBIDDEN = /\bprocess\.(argv|stdout|stderr|exit|exitCode)\b/;

/**
 * Blank out comment text while keeping every newline, so a doc comment that
 * *mentions* `process.exitCode` is not read as code and line positions still
 * line up. Line comments count only when `//` opens the line — that leaves a
 * `https://` inside a template literal alone, which a blanket strip would chew
 * through as far as the next newline.
 */
export function blankComments(source: string): string {
  const blank = (match: string): string => match.replace(/[^\n]/g, " ");
  return source.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/^[ \t]*\/\/[^\n]*/gm, blank);
}

/** A top-level declaration: `export async function foo`, `const bar`, `type Baz`. */
const DECLARATION =
  /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|const|let|var|class|type|interface|enum)\s+([A-Za-z_$][\w$]*)/;

/**
 * Which top-level declaration each line of a module belongs to. Lines before
 * the first declaration — imports, re-exports — are `"module scope"`, and hold
 * to the same rule.
 */
export function ownerByLine(source: string): string[] {
  const owners: string[] = [];
  let owner = "module scope";
  for (const line of source.split("\n")) {
    const declared = DECLARATION.exec(line);
    if (declared !== null) owner = declared[1]!;
    owners.push(owner);
  }
  return owners;
}

/** Every forbidden reference in a module, named by the declaration it sits in. */
export function streamReferencesIn(source: string): Array<{ owner: string; line: string }> {
  const code = blankComments(source);
  const owners = ownerByLine(code);
  const found: Array<{ owner: string; line: string }> = [];
  code.split("\n").forEach((line, index) => {
    if (FORBIDDEN.test(line)) found.push({ owner: owners[index]!, line: line.trim() });
  });
  return found;
}

/** The CLI layer of a verb module: the one wrapper argv and the streams reach. */
function isCliLayer(owner: string): boolean {
  return owner.endsWith("Cli");
}

describe("host verbs stay above the process's streams", () => {
  test.each(VERBS)("%s.ts touches the streams only inside its Cli wrapper", (verb) => {
    const source = readFileSync(join(srcDir, `${verb}.ts`), "utf8");
    const offenders = streamReferencesIn(source)
      .filter(({ owner }) => !isCliLayer(owner))
      .map(({ owner, line }) => `${verb}.ts — ${owner}: ${line}`);
    expect(offenders).toEqual([]);
  });

  // The rule above passes vacuously for a module that prints nowhere at all, so
  // each verb is pinned to which of the two shapes it has.
  test.each(VERBS.filter((verb) => verb !== "init"))(
    "%s.ts still has a Cli wrapper doing the printing",
    (verb) => {
      const source = readFileSync(join(srcDir, `${verb}.ts`), "utf8");
      const inWrapper = streamReferencesIn(source).filter(({ owner }) => isCliLayer(owner));
      expect(inWrapper.length).toBeGreaterThan(0);
    },
  );

  test("init.ts reaches no stream at all — its CLI layer is runCli's init branch", () => {
    // `phoebe init` is dispatched inside cli.ts rather than through a
    // `runInitCli` of its own, because the branch also asks the crash-reporting
    // consent question and renders the workspace registration advice. So the
    // scaffolder module is stream-free outright.
    expect(streamReferencesIn(readFileSync(join(srcDir, "init.ts"), "utf8"))).toEqual([]);
  });

  test("a verb function that writes to stdout trips the guard", () => {
    const source = [
      "export async function runThing(opts: Opts): Promise<Outcome> {",
      '  process.stdout.write("oops");',
      "}",
    ].join("\n");
    expect(streamReferencesIn(source)).toEqual([
      { owner: "runThing", line: 'process.stdout.write("oops");' },
    ]);
  });

  test("a verb function that sets the exit code trips the guard", () => {
    const source = ["function half() {", "  process.exitCode = 1;", "}"].join("\n");
    expect(streamReferencesIn(source).map((f) => f.owner)).toEqual(["half"]);
  });

  test("the same write inside a Cli wrapper does not", () => {
    const source = [
      "export async function runThingCli(argv: readonly string[]): Promise<void> {",
      "  process.stdout.write(HELP);",
      "}",
    ].join("\n");
    expect(streamReferencesIn(source).every(({ owner }) => isCliLayer(owner))).toBe(true);
  });

  test("a doc comment naming process.exitCode is prose, not a reference", () => {
    const source = [
      "/** Returns the outcome; sets `process.exitCode` only via runThingCli. */",
      "export function runThing(): Outcome {",
      "  return { kind: 'ok' };",
      "}",
    ].join("\n");
    expect(streamReferencesIn(source)).toEqual([]);
  });

  test("process.env and process.cwd are ambient facts, not streams", () => {
    const source = [
      "export function runThing(opts: Opts): Outcome {",
      "  const dir = opts.cwd ?? process.cwd();",
      '  return { kind: "ok", token: process.env["GH_TOKEN"], dir };',
      "}",
    ].join("\n");
    expect(streamReferencesIn(source)).toEqual([]);
  });

  test("a url in a template literal does not swallow the code after it", () => {
    const source = [
      "const HELP = `see https://example.com/docs",
      "`;",
      "function half() {",
      "  process.exitCode = 1;",
      "}",
    ].join("\n");
    expect(streamReferencesIn(source).map((f) => f.owner)).toEqual(["half"]);
  });
});

describe("every host verb is callable in-process", () => {
  test.each([
    { verb: "init", fn: runInit },
    { verb: "start", fn: runStart },
    { verb: "stop", fn: runStop },
    { verb: "upgrade", fn: runUpgrade },
    { verb: "migrate", fn: runMigrate },
    { verb: "doctor", fn: runDoctor },
  ])("run$verb is exported as a function", ({ fn }) => {
    expect(typeof fn).toBe("function");
  });
});
