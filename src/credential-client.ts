// The engine's side of the installation-token credential lease (#211) — the
// client half of the supervisor's per-tenant token cache (bootstrap/credential-ipc.ts).
//
// A GitHub App installation token expires after 60 minutes. The child's env is
// frozen at spawn, but `process.env` is a live cell — refreshing is an
// assignment in the running child, not a respawn. The engine gains exactly one
// new capability: the supervisor may hand it a replacement token.
//
// Symmetric to the slot client (src/slot-client.ts), over the same IPC channel.
// A standalone engine — dev / local-mount / `--run-once`, spawned without an IPC
// channel — has no supervisor to ask, so `createCredentialClient` returns null
// and the loop proceeds with its existing credential. The channel's presence is
// the only thing that distinguishes the two, so the same engine binary works in
// both worlds.

import { BrokerDisconnectedError, type ParentChannel } from "./slot-client.ts";

export { BrokerDisconnectedError };

/** Message types on the supervisor↔child IPC channel for credential leases. */
export const CREDENTIAL_REQUEST = "phoebe:credential:request";
export const CREDENTIAL_ANSWER = "phoebe:credential:answer";
export const CREDENTIAL_BLOCKED = "phoebe:credential:blocked";

export type CredentialClient = {
  /**
   * Request a credential lease; resolves with the fresh token (string) when
   * the supervisor mints one, or null when the supervisor signals "nothing to
   * give" (the PAT arm — the child's existing credential is already correct).
   *
   * Rejects with `CredentialRefreshBlockedError` when the supervisor cannot
   * provide a usable credential (App arm, mint failed) — the caller must not
   * start the unit.
   *
   * Rejects with `BrokerDisconnectedError` when the IPC channel closes while
   * a request is outstanding — the supervisor is gone, and the engine stops.
   *
   * `budgetMs` is the child's resolved run timeout plus ten minutes; only the
   * child computes it, so the supervisor's cache remains provenance-blind.
   */
  requestLease(budgetMs: number): Promise<string | null>;
};

/**
 * The supervisor could not answer with a usable credential on the App arm
 * (mint failed or rate-limited). The engine must not start the unit — it might
 * be holding an expired token and cannot complete work it cannot authenticate.
 * The loop continues; the next cycle will retry the lease.
 */
export class CredentialRefreshBlockedError extends Error {
  constructor() {
    super(
      "supervisor could not provide a usable installation token — unit admission blocked this cycle",
    );
    this.name = "CredentialRefreshBlockedError";
  }
}

function isAnswer(message: unknown): boolean {
  return (
    typeof message === "object" &&
    message !== null &&
    (message as { type?: unknown }).type === CREDENTIAL_ANSWER
  );
}

function isBlocked(message: unknown): boolean {
  return (
    typeof message === "object" &&
    message !== null &&
    (message as { type?: unknown }).type === CREDENTIAL_BLOCKED
  );
}

/**
 * Build a credential client bound to the parent IPC channel, or null when there
 * is no channel (a standalone engine — run with its existing credential). The
 * engine works one unit at a time, so at most one lease request is ever
 * outstanding per child. The listener is removed as soon as it settles.
 *
 * On `disconnect` while a request is outstanding: rejects with
 * `BrokerDisconnectedError`. The engine stops rather than proceeding on a
 * credential it could not renew — the supervisor is gone.
 */
export function createCredentialClient(proc: ParentChannel): CredentialClient | null {
  if (
    typeof proc.send !== "function" ||
    typeof proc.on !== "function" ||
    typeof proc.off !== "function" ||
    proc.connected === false
  )
    return null;
  const send = proc.send.bind(proc);
  return {
    requestLease(budgetMs: number): Promise<string | null> {
      return new Promise<string | null>((resolve, reject) => {
        const onMessage = (message: unknown): void => {
          if (isBlocked(message)) {
            cleanup();
            reject(new CredentialRefreshBlockedError());
            return;
          }
          if (!isAnswer(message)) return;
          cleanup();
          const token = (message as { token?: unknown }).token;
          resolve(typeof token === "string" ? token : null);
        };
        const onDisconnect = (): void => {
          cleanup();
          reject(new BrokerDisconnectedError());
        };
        const cleanup = (): void => {
          proc.off?.("message", onMessage);
          proc.off?.("disconnect", onDisconnect);
        };
        proc.on?.("message", onMessage);
        proc.on?.("disconnect", onDisconnect);
        send({ type: CREDENTIAL_REQUEST, budgetMs });
      });
    },
  };
}
