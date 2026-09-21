// **Pair** — the composite run that joins a local install to the relay this
// companion is signed in to (#527 §14, #558).
//
// Four steps, in main, in one run:
//
//  1. Mint a pairing token on the relay with the device token main holds.
//  2. Write the relay's `wss://` address into the install's root config.
//  3. Write the token into the install's root `.env`.
//  4. Nudge the container, so it reads both.
//
// It is one run rather than four because the middle two are useless apart: a
// config pointing at a relay with no token dials and is refused, and a token
// with no address is a secret sitting in a file doing nothing. An operator who
// gets half way through this by hand has a deployment that says nothing useful
// about why it will not connect, which is the whole reason #503 asks for the
// one-click version.
//
// **The token is never in a line.** It goes from the relay's answer into the
// `.env` and nowhere else — not into the run's output, not into the outcome,
// not into a log. What the operator sees is that one was minted and when it
// expires, which is all there is to act on.
//
// **The nudge is `up -d`, not a restart.** The token reaches the container as an
// environment variable, and Compose resolves those from `.env` when it *creates*
// a container. So the step that delivers a pairing is the one that makes Compose
// notice the file moved and recreate the service; a container whose env did not
// change is left running, untouched, which is what makes this safe to run twice.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { RELAY_DEPLOYMENTS_PATH, RELAY_TOKEN_ENV } from "phoebe-agent/contracts";
import type { MintedPairingToken, PairOutcome, VerbIo } from "phoebe-agent/contracts";
import { editConfigGetRelay, editConfigSetRelayUrl } from "../../../src/config-handle.ts";
import {
  formatResolveFailure,
  resolveDeploymentCompose,
  runCompose,
  type CommandRunner,
} from "../../../src/deployment-compose.ts";
import { setDotenvValue } from "../../../src/dotenv-edit.ts";
import { BridgeRefusal } from "./channels.ts";
import { installConfigFacts } from "./install-facts.ts";

/** The config file at the root of an install. */
const CONFIG_FILE = "phoebe.config.ts";

/** The env file Compose reads beside it. */
const ENV_FILE = ".env";

/**
 * The relay arm, as pairing needs it: where it is, and one mint on it. Narrow on
 * purpose — the device token is main's and does not appear here, and neither
 * does the rest of the relay's API.
 */
export type PairArm = {
  /** The relay's own address, as the operator signed in to it. */
  url: string;
  /** `POST /api/pairing-tokens`, with the device token behind it (#540). */
  mint: () => Promise<MintedPairingToken>;
};

/** Every edge pairing touches, injectable so the whole of it runs in a test. */
export type PairDeps = {
  io: VerbIo;
  runner?: CommandRunner;
  read?: (file: string) => string;
  write?: (file: string, contents: string) => void;
  exists?: (file: string) => boolean;
};

/**
 * Pair one install. Throws {@link BridgeRefusal} for the states an operator can
 * do something about, and returns what it wrote for the ones it finished.
 */
export async function pairInstall(
  install: string,
  arm: PairArm,
  deps: PairDeps,
): Promise<PairOutcome> {
  const read = deps.read ?? ((file: string) => readFileSync(file, "utf8"));
  const write = deps.write ?? ((file: string, text: string) => writeFileSync(file, text, "utf8"));
  const exists = deps.exists ?? existsSync;
  const io = deps.io;

  const deployment = resolveDeploymentCompose(install, exists);
  if ("kind" in deployment) {
    throw new BridgeRefusal({
      code: "not-initialised",
      message: formatResolveFailure(deployment),
      instruction: "Run init on this folder first, then pair it.",
    });
  }

  const configPath = path.join(install, CONFIG_FILE);
  const configBefore = readOrRefuse(read, configPath);
  const relayUrl = deploymentsUrlFor(arm.url);
  const existing = editConfigGetRelay(configBefore);
  if (!existing.ok) {
    throw new BridgeRefusal({
      code: "refused",
      message: `${CONFIG_FILE} could not be read — ${existing.reason}`,
      instruction: `Add \`relay: { url: "${relayUrl}" }\` to ${CONFIG_FILE} by hand.`,
    });
  }
  const previous = existing.relay?.url ?? null;
  const deploymentName = installConfigFacts(install, configBefore).deploymentName;

  io.stdout(`[phoebe] pair ${deploymentName} with ${arm.url}`);

  // 1. The mint. First, because it is the only step that can fail for a reason
  //    outside this machine — and failing before anything is written leaves the
  //    install exactly as it was.
  io.stdout("  minting a pairing token…");
  const minted = await arm.mint();
  io.stdout(`  token minted, spendable until ${minted.expiresAt}`);

  // 2. The address.
  const edited = editConfigSetRelayUrl(configBefore, relayUrl);
  if (!edited.ok) {
    throw new BridgeRefusal({
      code: "refused",
      message: `${CONFIG_FILE} was left alone — ${edited.reason}`,
      instruction: `Set \`relay.url\` to "${relayUrl}" in ${CONFIG_FILE} by hand, then pair again.`,
    });
  }
  write(configPath, edited.content);
  io.stdout(
    previous === null || previous === relayUrl
      ? `  ${CONFIG_FILE}: relay.url = ${relayUrl}`
      : `  ${CONFIG_FILE}: relay.url ${previous} → ${relayUrl}`,
  );

  // 3. The token. Its value goes into the file and into no line above or below.
  const envPath = path.join(install, ENV_FILE);
  const envBefore = exists(envPath) ? readOrRefuse(read, envPath) : "";
  write(envPath, setDotenvValue(envBefore, RELAY_TOKEN_ENV, minted.token));
  io.stdout(`  ${ENV_FILE}: ${RELAY_TOKEN_ENV} written`);

  // 4. The nudge.
  io.stdout("  nudging the container so it reads both…");
  const nudge = await runCompose({
    deployment,
    args: ["up", "-d"],
    inheritStdio: true,
    ...(deps.runner !== undefined ? { runner: deps.runner } : {}),
  });
  if (nudge.code !== 0) {
    throw new BridgeRefusal({
      code: "refused",
      message: `the config and the token are written, but Compose refused to recreate the container (exit ${nudge.code})`,
      instruction: "Start the install again from this tab; the token is good until it is spent.",
    });
  }

  io.stdout(
    `[phoebe] Paired. The deployment spends the token on its next boot and keeps the key it ` +
      `mints; \`phoebe doctor\` reports \`relay: token-stale\` until ${RELAY_TOKEN_ENV} is taken ` +
      `back out of ${ENV_FILE}.`,
  );

  return {
    relayUrl,
    deploymentName,
    expiresAt: minted.expiresAt,
    movedRelay: previous !== null && previous !== relayUrl,
  };
}

/**
 * The `wss://` address a deployment dials, from the `https://` one an operator
 * signed in to. One letter apart, and the one letter every runbook warns about
 * (config-schema.ts) — so the companion derives it rather than asking for it
 * twice. A plain `http://` relay, which is a local one or a test, becomes `ws://`.
 */
export function deploymentsUrlFor(relayUrl: string): string {
  const dialled = new URL(RELAY_DEPLOYMENTS_PATH, relayUrl);
  dialled.protocol = dialled.protocol === "http:" ? "ws:" : "wss:";
  return dialled.toString();
}

/** Read a file, or refuse in terms that name it. */
function readOrRefuse(read: (file: string) => string, file: string): string {
  try {
    return read(file);
  } catch (error) {
    throw new BridgeRefusal({
      code: "unknown",
      message: `could not read ${file}: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}
