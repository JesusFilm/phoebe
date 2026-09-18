// What `phoebe boot` does about the `relay` block (#540) — the whole of it, so
// boot.ts gains a call rather than a policy.
//
// Two phases, because the report and the link each need the other. The report's
// identity has to exist before the live model is built, and the link has to
// report into that model once it does. So `prepareRelay` answers "who is this
// deployment" from the config and the volume, and `start` hands the link its
// reporting channel and dials.
//
// Both directions run through that one channel. The link writes its own state
// into the report's `relay` section, and reads the whole report back out of the
// model when it has a socket to push it down (#542).
//
// **The pairing decision is made here, once, out of two facts.** A key on the
// volume means this deployment has paired: it signs, and `PHOEBE_RELAY_TOKEN`
// is ignored (doctor keeps saying so until the operator removes it). No key and
// a token means a first pairing. No key and no token means an operator who set
// `relay.url` and stopped halfway — the link says so through the report and
// never dials, because there is nothing it could say to the relay.
//
// **What the console may ask this deployment to do arrives at `start`**, as
// {@link RelayVerbs} (#547). They are the supervisor's, not the config's — the
// config-edit pen is pointed at the running engine — so they are handed over
// with the reporting channel rather than read here. A verb this deployment does
// not have is refused in its own words by the link, never dropped.
//
// No `relay` block, or a block with no `url`: none of this runs, the report's
// relay section says `configured: false`, and the deployment is the deployment
// it was before this file existed.

import { readRelayField, type RelayField } from "../src/config-schema.ts";
import type { ConfigEdit, EditReceipt } from "../src/contracts/config-edit.ts";
import type { DeploymentArm, DeploymentIdentity } from "../src/contracts/deployment.ts";
import type { DeploymentState } from "./deployment-state.ts";
import { connectRelay, type RelayLink, type OpenRelaySocket } from "./relay-link.ts";
import {
  forgetDeploymentKey,
  generateDeploymentKey,
  readDeploymentKey,
  relayKeyPath,
  saveDeploymentKey,
  type DeploymentKey,
} from "./relay-key.ts";

/** The env var the operator pastes a freshly minted pairing token into. */
export const RELAY_TOKEN_ENV = "PHOEBE_RELAY_TOKEN";

/**
 * What a console may ask this deployment to *do*, as opposed to read (#503,
 * #547). One record rather than a parameter per verb: `secret-set` (#550)
 * lands beside `configSet` here, and the link is handed the whole of it.
 *
 * Each verb is optional, and an absent one is refused in its own words by the
 * link rather than dropped — a deployment that cannot do a thing says so, and a
 * console holding a request open is answered either way.
 */
export type RelayVerbs = {
  /** Apply one field patch to the root config, and answer with the receipt. */
  configSet?: (edit: ConfigEdit) => Promise<EditReceipt>;
};

export type PrepareRelayOptions = {
  /** The root config, as loaded — the only place a `relay` block is read from. */
  rootConfig: unknown;
  /** The deployment's default name when `relay.name` does not override it. */
  defaultName: string;
  arm: DeploymentArm;
  /** The data volume: where the key lives. */
  dataBase: string;
  env: NodeJS.ProcessEnv;
  log?: (message: string) => void;
  warn?: (message: string) => void;
  /** Injected by the tests; production dials a real socket. */
  open?: OpenRelaySocket;
};

/** The verbs, handed over at {@link PreparedRelay.start} rather than at prepare. */
export type StartRelayOptions = { verbs?: RelayVerbs };

export type PreparedRelay = {
  /** The report's identity section, read afresh at every publish. */
  identity: () => DeploymentIdentity;
  /**
   * Dial, reporting into the live model. A no-op with no `relay.url`.
   *
   * The verbs arrive here and not at prepare time because they are the
   * supervisor's, and the supervisor is built after the report is: the pen is
   * pointed at the running engine, and the report's identity has to exist
   * before either.
   */
  start: (deployment: DeploymentState, options?: StartRelayOptions) => void;
  /**
   * The report moved: push it up the link (#542). A no-op before {@link start},
   * with no relay configured, or while the socket is down — the next connection
   * opens with the whole report either way.
   */
  push: () => void;
  /** Stop dialling; the deployment is going down. */
  stop: () => void;
};

/**
 * Read the `relay` block and the volume, and decide who this deployment is.
 * Nothing dials until {@link PreparedRelay.start}.
 *
 * A malformed `relay` block is a warning, not a boot failure: the relay is a
 * console, and a deployment that refused to supervise its fleet over one is a
 * deployment that made monitoring load-bearing for work.
 */
export function prepareRelay(options: PrepareRelayOptions): PreparedRelay {
  const log = options.log ?? (() => {});
  const warn = options.warn ?? log;

  let relay: RelayField | undefined;
  try {
    relay = readRelayField(options.rootConfig as { relay?: unknown });
  } catch (error) {
    warn(
      `[phoebe] boot: ignoring the \`relay\` block — ${
        error instanceof Error ? error.message : String(error)
      } The fleet is unaffected; nothing will be dialled.`,
    );
    relay = undefined;
  }

  const name = relay?.name ?? options.defaultName;
  const keyPath = relayKeyPath(options.dataBase);
  let key: DeploymentKey | null = relay === undefined ? null : readDeploymentKey(keyPath);
  let link: RelayLink | null = null;

  return {
    identity: () => ({
      name,
      arm: options.arm,
      ...(key !== null ? { keyFingerprint: key.fingerprint } : {}),
      ...(relay !== undefined ? { relayUrl: relay.url } : {}),
    }),

    start(deployment, started = {}) {
      if (relay === undefined) return;
      const token = options.env[RELAY_TOKEN_ENV];
      log(`[phoebe] boot: relay ${relay.url} as ${name}.`);
      link = connectRelay({
        url: relay.url,
        name,
        key,
        pairingToken: token !== undefined && token.length > 0 ? token : undefined,
        mintKey: generateDeploymentKey,
        saveKey: (minted) => saveDeploymentKey(keyPath, minted),
        forgetKey: () => {
          forgetDeploymentKey(keyPath);
          key = null;
        },
        onPaired: (minted) => {
          // The fingerprint is part of the identity from the moment it exists,
          // and the model reads identity at publish time for exactly this.
          key = minted;
        },
        onStatus: (status) => deployment.noteRelay(status),
        // Pulled at the moment of every send rather than handed over, so a link
        // that reconnects after five minutes sends what the model holds then.
        report: () => deployment.latest(),
        ...(started.verbs?.configSet !== undefined ? { onConfigSet: started.verbs.configSet } : {}),
        log,
        warn,
        ...(options.open !== undefined ? { open: options.open } : {}),
      });
    },

    push() {
      link?.push();
    },

    stop() {
      link?.stop();
      link = null;
    },
  };
}
