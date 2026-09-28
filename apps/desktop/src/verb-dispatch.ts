// Which verb a run actually runs (#527 §3, ADR 0001).
//
// Nine arms, in this process. No second Node, no `bin.mjs`, no stdout parsing:
// main ships the same package as the renderer, so it calls the verb functions
// directly and reads the typed outcome each one returns. That is the seam #552
// reshaped the verbs to expose, and this file is its only consumer.
//
// Seven of the eight are a `run<Verb>` call. The eighth is `secret set`, and
// it is the one verb with no engine function behind it on this arm: its two
// writers are the companion's own (secret-write.ts), because where a local
// secret goes depends on whether there is a container to put it in (#527 §8).
//
// **The local arm builds no envelope, and dials no relay.** Both write verbs
// here run against this machine — the config file under the operator's own
// hand, the secret through the container beside it — even when the same install
// is paired with a relay (#526). Sealing a value to a deployment the companion
// can reach across a filesystem, so that it could travel through a server, would
// be work done to reach somewhere it is already standing.
//
// `pair` is the arm that is not a bare engine verb. Pairing needs the relay's
// device token, which only the companion holds, so it is composed here out of a
// mint, two file writes and a nudge (pair.ts, #527 §14). That is one reason this
// module is a factory over what main holds rather than a bare function.
//
// Two things every arm has in common. Each verb's io is the run's line sink, so
// its output lands in the install tab rather than in whatever stream the
// companion's own process happens to own. And each verb's cwd is the install's
// directory — the companion never changes its own working directory, because one
// `process.chdir` would make two installs running in parallel into a race.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { app } from "electron";
import type { InstallState, VerbIo } from "phoebe-agent/contracts";
import { BridgeRefusal } from "./channels.ts";
import { deploymentDirOf } from "./deployment-dir.ts";
import { runConfigSet } from "../../../src/config-set.ts";
import {
  formatResolveFailure,
  resolveDeploymentCompose,
  type CommandRunner,
} from "../../../src/deployment-compose.ts";
import { runDoctor } from "../../../src/doctor.ts";
import { runInit } from "../../../src/init.ts";
import { runMigrate } from "../../../src/migrate.ts";
import { runStart } from "../../../src/start.ts";
import { runStop } from "../../../src/stop.ts";
import { runUpgrade } from "../../../src/upgrade.ts";
import { pairInstall, type PairArm } from "./pair.ts";
import {
  defaultStdinSpawner,
  secretSetOutcome,
  secretTargetOf,
  secretWriterFor,
  setSecretInContainer,
  setSecretInHostEnv,
} from "./secret-write.ts";
import type { Dispatch, Killable } from "./verb-runs.ts";
import { wslLocationOf, wslRunner, wslStdinSpawner } from "./wsl.ts";

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

/**
 * What the dispatch needs from outside itself, and both entries are main's.
 *
 * `installState` is `secret set`'s: which of the two writers takes a value is a
 * reading of the install's state at the moment of the write (#527 §8), and main
 * is the process that derives that state for everything else on screen.
 *
 * `relayArm` is `pair`'s: the relay arm pairing mints on, or null when this
 * companion is signed out. Read at the moment of the run rather than handed over
 * once: a sign-out between opening the window and pressing the button is the
 * ordinary case.
 */
export type DispatchDeps = {
  installState: (dir: string) => Promise<InstallState>;
  relayArm: () => PairArm | null;
};

/** The dispatch — one arm per verb. */
export function createDispatchVerb(deps: DispatchDeps): Dispatch {
  return async (request, { io, register }) => {
    const install = request.install;
    // The deployment's files may sit in `.phoebe/` under the folder
    // (deployment-dir.ts). Every verb but init works on that root; init
    // scaffolds the folder itself, since it runs only where there is none.
    const root = deploymentDirOf(install).dir;
    const configPath = path.join(root, CONFIG_FILE);
    // An install inside a WSL distro drives the distro's Docker, so every child
    // a verb spawns runs in there (wsl.ts). The file-writing verbs — init,
    // config set, upgrade, migrate, doctor — reach the folder as Windows shows it
    // and need nothing.
    const wsl = wslLocationOf(install);
    const runner =
      wsl === null ? streamingRunner(io, register) : wslRunner(wsl, streamingRunner(io, register));
    // This machine's PATH says nothing about the distro's; its Compose answers
    // for itself, and a distro with no Docker fails the run with its own words.
    const dockerInDistro = wsl === null ? {} : { dockerAvailable: true };

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
          // The pin a scaffolded image installs is this companion's own version,
          // which is the root package's (#521 §4). Left to its default, `init`
          // would look for a `package.json` beside the bundle and find the app's.
          params: { cliVersion: __COMPANION_VERSION__ },
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
          deps: { cwd: root, runner, io, ...dockerInDistro },
        });
        return { verb: "start", outcome };
      }

      case "stop": {
        const outcome = await runStop({
          now: request.now ?? false,
          deps: { cwd: root, runner, io, ...dockerInDistro },
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
          deps: { cwd: root, io },
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
        const outcome = await runDoctor({ configDir: root });
        return { verb: "doctor", outcome };
      }

      case "config set": {
        // The fingerprint the window was shown rides in the request (#527 §11), so
        // an edit composed against a config a terminal has since changed is
        // refused `stale` here exactly as it would be over a relay.
        // On a workspace the edit may name a child; the child's folder has to
        // be under the install, or the request is not this install's to make.
        const target =
          request.tenant === undefined ? configPath : tenantConfigPath(install, request.tenant);
        io.stdout(`[phoebe] config set ${request.path} in ${target}`);
        const outcome = await runConfigSet(
          {
            configPath: target,
            path: request.path,
            value: request.value,
            fingerprint: request.fingerprint,
          },
          // No ledger: the ledger answers a redelivered edit, and there is no
          // delivery here to repeat. The volume one would live on is inside the
          // container this edit deliberately does not go through.
          { ledgerPath: null },
        );
        io.stdout(
          outcome.state === "written"
            ? `  written — the deployment reconciles onto it the way it would a hand edit`
            : `  refused (${outcome.reason}): ${outcome.why}`,
        );
        if (outcome.state === "refused") io.stdout(`  ${outcome.instruction}`);
        return { verb: "config set", outcome };
      }

      case "secret set": {
        // Nothing about the value is printed, here or below. What the operator
        // watches is which writer took it and where it landed.
        const writer = secretWriterFor(await deps.installState(install));
        io.stdout(
          writer === "container"
            ? `[phoebe] secret set ${request.key} — through the container on ${install}`
            : `[phoebe] secret set ${request.key} — into this install's .env on ${install}`,
        );
        let target: string;
        if (writer === "container") {
          const deployment = resolveDeploymentCompose(root);
          if ("kind" in deployment) throw new Error(formatResolveFailure(deployment));
          await setSecretInContainer({
            deployment,
            key: request.key,
            value: request.value,
            ...(request.tenant !== undefined ? { tenant: request.tenant } : {}),
            io,
            ...(wsl === null ? {} : { spawner: wslStdinSpawner(wsl, defaultStdinSpawner) }),
          });
          target = secretTargetOf(writer, null);
        } else {
          target = secretTargetOf(
            writer,
            setSecretInHostEnv({ dir: root, key: request.key, value: request.value, io }),
          );
        }
        io.stdout(
          writer === "container"
            ? "  the running engine picks it up on its next relaunch"
            : "  it reaches the engine the next time this install starts",
        );
        return {
          verb: "secret set",
          outcome: secretSetOutcome({
            key: request.key,
            tenant: request.tenant ?? null,
            writer,
            target,
            at: new Date().toISOString(),
          }),
        };
      }
      case "pair": {
        const arm = deps.relayArm();
        if (arm === null) {
          throw new BridgeRefusal({
            code: "signed-out",
            message: "this companion is not signed in to a relay, so there is nothing to pair with",
            instruction: "Sign in to a relay on the rail, then pair this install.",
          });
        }
        const outcome = await pairInstall(install, arm, { io, runner });
        return { verb: "pair", outcome };
      }
    }
  };
}

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

/**
 * A workspace child's config, for a `config set` that names the child. The
 * folder has to sit under the install and carry a config: a path that walks
 * out of the install, or names a folder with nothing to edit, is refused
 * before anything is read.
 */
function tenantConfigPath(install: string, tenant: string): string {
  const inside = path.relative(install, tenant);
  if (inside === "" || inside.startsWith("..") || path.isAbsolute(inside)) {
    throw new Error(`${tenant} is not a child of ${install}.`);
  }
  const file = path.join(tenant, CONFIG_FILE);
  if (!existsSync(file)) throw new Error(`${tenant} has no ${CONFIG_FILE} to change.`);
  return file;
}
