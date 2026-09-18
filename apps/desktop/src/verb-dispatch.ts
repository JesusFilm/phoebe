// Which verb a run actually runs (#527 §3, ADR 0001).
//
// Six arms, six `run<Verb>` calls, in this process. No second Node, no
// `bin.mjs`, no stdout parsing: main ships the same package as the renderer, so
// it calls the verb functions directly and reads the typed outcome each one
// returns. That is the seam #552 reshaped the verbs to expose, and this file is
// its only consumer.
//
// Two things every arm has in common. Each verb's io is the run's line sink, so
// its output lands in the install tab rather than in whatever stream the
// companion's own process happens to own. And each verb's cwd is the install's
// directory — the companion never changes its own working directory, because one
// `process.chdir` would make two installs running in parallel into a race.

import { spawn } from "node:child_process";
import path from "node:path";
import { app } from "electron";
import type { VerbIo } from "phoebe-agent/contracts";
import type { CommandRunner } from "../../../src/deployment-compose.ts";
import { runDoctor } from "../../../src/doctor.ts";
import { runInit } from "../../../src/init.ts";
import { runMigrate } from "../../../src/migrate.ts";
import { runStart } from "../../../src/start.ts";
import { runStop } from "../../../src/stop.ts";
import { runUpgrade } from "../../../src/upgrade.ts";
import type { Dispatch, Killable } from "./verb-runs.ts";

/** The config file that sits at the root of an install. */
const CONFIG_FILE = "phoebe.config.ts";

/**
 * Where the package's shipped `templates/` and `prompts/` are, for `init`.
 *
 * Main is a bundle, so the walk-up from a module's own directory that works in a
 * checkout has nothing to walk in a packaged app — the sources are gone and the
 * resources sit beside the executable. Packaging is #561's; this is the hook it
 * fills.
 */
function packageRoot(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "phoebe-agent")
    : path.join(import.meta.dirname, "..", "..", "..");
}

/** The real dispatch — one arm per verb. */
export const dispatchVerb: Dispatch = async (request, { io, register }) => {
  const install = request.install;
  const configPath = path.join(install, CONFIG_FILE);
  const runner = streamingRunner(io, register);

  switch (request.verb) {
    case "init": {
      // `init` prints nothing of its own (#552) and returns the file lists
      // instead, so the run says what it is doing and then what it did. An
      // install tab with an empty output box and a green tick reads as a button
      // that did nothing.
      io.stdout(`[phoebe] init ${install}`);
      const outcome = runInit({
        targetDir: install,
        ...(request.profile !== undefined ? { profile: request.profile } : {}),
        deps: { packageRoot: packageRoot() },
      });
      for (const file of outcome.created) io.stdout(`  created  ${file}`);
      for (const file of outcome.updated) io.stdout(`  updated  ${file}`);
      for (const file of outcome.skipped) io.stdout(`  kept     ${file}`);
      return { verb: "init", outcome };
    }

    case "start": {
      const outcome = await runStart({
        build: request.build ?? false,
        deps: { cwd: install, runner, io },
      });
      return { verb: "start", outcome };
    }

    case "stop": {
      const outcome = await runStop({
        now: request.now ?? false,
        deps: { cwd: install, runner, io },
      });
      return { verb: "stop", outcome };
    }

    case "upgrade": {
      // The companion always passes a target, so upgrade's TTY picker is never
      // reached (#527 §3). It asks no consent question either: the dep defaults
      // to never asking, which is the right answer with no terminal.
      const outcome = await runUpgrade({
        check: request.check ?? true,
        target: request.target ?? "both",
        ...(request.ref !== undefined ? { ref: request.ref } : {}),
        configPath,
        deps: { cwd: install, io },
      });
      return { verb: "upgrade", outcome };
    }

    case "migrate": {
      io.stdout(`[phoebe] migrate ${install}`);
      const outcome = await runMigrate({ configPath, check: request.check ?? false });
      return { verb: "migrate", outcome };
    }

    case "doctor": {
      io.stdout(`[phoebe] doctor ${install}`);
      const outcome = await runDoctor({ configDir: install });
      return { verb: "doctor", outcome };
    }
  }
};

/**
 * The Compose runner a verb run drives its children through.
 *
 * It answers the same two modes the CLI's runner does, and the difference is
 * where the output goes. A probe (`ps`, inspect) is captured and parsed, and its
 * output is JSON nobody wants in the tab. A lifecycle command asks for inherited
 * stdio because in a terminal the operator watches it scroll — here that same
 * request means "stream this", and each line becomes a `run:line`.
 *
 * Every child it spawns is registered, which is what gives cancel something to
 * signal (#527 §2).
 */
export function streamingRunner(io: VerbIo, register: (child: Killable) => void): CommandRunner {
  return (spec) =>
    new Promise((resolve, reject) => {
      const child = spawn(spec.file, spec.args as string[], {
        cwd: spec.cwd,
        stdio: ["ignore", "pipe", "pipe"],
      });
      register(child);

      const stream = spec.inheritStdio === true;
      let stdout = "";
      let stderr = "";
      // Chunks arrive at the socket's convenience, not at line boundaries, so a
      // partial last line is held back until the newline that completes it.
      let stdoutRest = "";
      let stderrRest = "";

      child.stdout?.on("data", (chunk: Buffer | string) => {
        stdout += String(chunk);
        if (stream) stdoutRest = emitLines(stdoutRest + String(chunk), io.stdout);
      });
      child.stderr?.on("data", (chunk: Buffer | string) => {
        stderr += String(chunk);
        if (stream) stderrRest = emitLines(stderrRest + String(chunk), io.stderr);
      });

      child.on("error", reject);
      child.on("close", (code) => {
        if (stream) {
          if (stdoutRest.length > 0) io.stdout(stdoutRest);
          if (stderrRest.length > 0) io.stderr(stderrRest);
        }
        resolve({ code: code ?? 1, stdout, stderr });
      });
    });
}

/** Emit every complete line in `buffered`; return the incomplete tail. */
function emitLines(buffered: string, emit: (line: string) => void): string {
  const pieces = buffered.split("\n");
  const rest = pieces.pop() ?? "";
  for (const piece of pieces) emit(piece.replace(/\r$/, ""));
  return rest;
}
