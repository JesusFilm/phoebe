// `phoebe relay leave` — the host verb that ends a pairing from this side (#505
// §4, #541).
//
// **Leave and forget are two halves that do not need each other.** Leaving
// deletes the deployment key; forgetting, on the relay, deletes the link.
// Either alone is enough to end the connection, and neither side has to
// cooperate for the other to work — which is the point. An operator who has
// lost access to the relay can still stop a deployment dialling it, and an
// operator whose deployment is gone can still clear it off the console.
//
// What this does *not* do is edit the config. Removing `relay.url` is the thing
// that stops boot dialling at all, and rewriting a consumer's
// `phoebe.config.ts` from under them is not this verb's business: it prints the
// one line they have to delete instead. Until they do, boot finds no key and no
// token, reports `unpaired`, and says so — which is true, and harmless.
//
// There is no key rotation here or anywhere else. Re-keying is leave, forget,
// pair again (#505 §4).

import { existsSync } from "node:fs";
import { forgetDeploymentKey, relayKeyPath } from "./relay-key.ts";

export type RelayLeaveResult = {
  /** Where the key was looked for — worth printing, since it is volume-relative. */
  keyPath: string;
  /** Was there a key to delete? A second `leave` is a no-op, not an error. */
  deleted: boolean;
};

/**
 * Delete this deployment's key and say what is left to do. Idempotent: leaving
 * twice is leaving once, because the question the operator is asking ("is this
 * deployment paired?") has the same answer both times.
 */
export function relayLeave(deps: {
  /** The data volume, as `resolveDataBase` reads it from the environment. */
  dataBase: string;
  log?: (message: string) => void;
}): RelayLeaveResult {
  const log = deps.log ?? ((message: string) => process.stdout.write(`${message}\n`));
  const keyPath = relayKeyPath(deps.dataBase);
  if (!existsSync(keyPath)) {
    log(
      `[phoebe] relay: no deployment key at ${keyPath} — this deployment is not paired, ` +
        "so there is nothing to leave.",
    );
    return { keyPath, deleted: false };
  }
  forgetDeploymentKey(keyPath);
  log(
    `[phoebe] relay: deleted the deployment key at ${keyPath}. This deployment can no longer ` +
      "prove who it is to its relay.",
  );
  log(
    "[phoebe] relay: two things are left, and neither happens on its own — remove the `relay` " +
      "block from the root `phoebe.config.ts` so boot stops dialling, and forget this " +
      "deployment on the relay, which still holds its link.",
  );
  return { keyPath, deleted: true };
}
