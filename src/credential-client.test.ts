// Engine credential-client tests (#211): request/answer/blocked/disconnect over
// a mock IPC channel, and the standalone (no-channel) path.

import { describe, expect, test } from "vite-plus/test";
import {
  BrokerDisconnectedError,
  createCredentialClient,
  CREDENTIAL_ANSWER,
  CREDENTIAL_BLOCKED,
  CREDENTIAL_REQUEST,
  CredentialRefreshBlockedError,
  type CredentialClient,
} from "./credential-client.ts";
import type { ParentChannel } from "./slot-client.ts";

function mockChannel(): ParentChannel & {
  sent: unknown[];
  emit: (message: unknown) => void;
  emitDisconnect: () => void;
  listenerCount: () => number;
} {
  const sent: unknown[] = [];
  const byEvent: Record<string, Set<(message: unknown) => void>> = {
    message: new Set(),
    disconnect: new Set(),
  };
  return {
    connected: true,
    send: (message) => sent.push(message),
    on: (event, listener) => byEvent[event]?.add(listener),
    off: (event, listener) => byEvent[event]?.delete(listener),
    sent,
    emit: (message) => byEvent.message!.forEach((l) => l(message)),
    emitDisconnect: () => byEvent.disconnect!.forEach((l) => l(undefined)),
    listenerCount: () => byEvent.message!.size + byEvent.disconnect!.size,
  };
}

describe("createCredentialClient", () => {
  test("returns null when there is no send (standalone → unbrokered)", () => {
    expect(createCredentialClient({})).toBeNull();
    expect(createCredentialClient({ connected: false, send: () => {} })).toBeNull();
  });

  test("returns null when on or off is missing (channel cannot deliver answers)", () => {
    const send = (): void => {};
    const on = (_e: string, _l: (m: unknown) => void): void => {};
    const off = (_e: string, _l: (m: unknown) => void): void => {};
    // Neither listener provided.
    expect(createCredentialClient({ send, connected: true })).toBeNull();
    // Only on provided, off absent.
    expect(createCredentialClient({ send, connected: true, on })).toBeNull();
    // Only off provided, on absent.
    expect(createCredentialClient({ send, connected: true, off })).toBeNull();
    // Both provided — should succeed.
    expect(createCredentialClient({ send, connected: true, on, off })).not.toBeNull();
  });

  test("requestLease sends a request with the budget and resolves with the token", async () => {
    const channel = mockChannel();
    const client = createCredentialClient(channel) as CredentialClient;

    let resolved: string | null | undefined;
    const pending = client.requestLease(120_000).then((t) => {
      resolved = t;
    });
    expect(channel.sent).toEqual([{ type: CREDENTIAL_REQUEST, budgetMs: 120_000 }]);
    expect(resolved).toBeUndefined();

    channel.emit({ type: CREDENTIAL_ANSWER, token: "ghs_testtoken" });
    await pending;
    expect(resolved).toBe("ghs_testtoken");
  });

  test("resolves with null when the supervisor answers with a null token (PAT arm)", async () => {
    const channel = mockChannel();
    const client = createCredentialClient(channel) as CredentialClient;

    const pending = client.requestLease(120_000);
    channel.emit({ type: CREDENTIAL_ANSWER, token: null });
    expect(await pending).toBeNull();
  });

  test("resolves with null when the token field is absent", async () => {
    const channel = mockChannel();
    const client = createCredentialClient(channel) as CredentialClient;

    const pending = client.requestLease(120_000);
    channel.emit({ type: CREDENTIAL_ANSWER });
    expect(await pending).toBeNull();
  });

  test("rejects with CredentialRefreshBlockedError on CREDENTIAL_BLOCKED", async () => {
    const channel = mockChannel();
    const client = createCredentialClient(channel) as CredentialClient;

    const pending = client.requestLease(120_000);
    channel.emit({ type: CREDENTIAL_BLOCKED });
    await expect(pending).rejects.toBeInstanceOf(CredentialRefreshBlockedError);
  });

  test("rejects with BrokerDisconnectedError if channel disconnects before an answer", async () => {
    const channel = mockChannel();
    const client = createCredentialClient(channel) as CredentialClient;

    const pending = client.requestLease(120_000);
    channel.emitDisconnect();
    await expect(pending).rejects.toBeInstanceOf(BrokerDisconnectedError);
    // Cleaned up — no leaked listeners.
    expect(channel.listenerCount()).toBe(0);
  });

  test("removes both listeners once the answer settles (no accumulation)", async () => {
    const channel = mockChannel();
    const client = createCredentialClient(channel) as CredentialClient;
    const pending = client.requestLease(120_000);
    expect(channel.listenerCount()).toBe(2);
    channel.emit({ type: CREDENTIAL_ANSWER, token: "ghs_x" });
    await pending;
    expect(channel.listenerCount()).toBe(0);
  });

  test("removes both listeners after a CREDENTIAL_BLOCKED rejection", async () => {
    const channel = mockChannel();
    const client = createCredentialClient(channel) as CredentialClient;
    const pending = client.requestLease(120_000);
    expect(channel.listenerCount()).toBe(2);
    channel.emit({ type: CREDENTIAL_BLOCKED });
    await expect(pending).rejects.toBeInstanceOf(CredentialRefreshBlockedError);
    expect(channel.listenerCount()).toBe(0);
  });

  test("ignores unrelated messages while waiting", async () => {
    const channel = mockChannel();
    const client = createCredentialClient(channel) as CredentialClient;
    let resolved = false;
    const pending = client.requestLease(120_000).then(() => {
      resolved = true;
    });
    channel.emit({ type: "something-else" });
    channel.emit("not even an object");
    channel.emit({ type: CREDENTIAL_REQUEST }); // own request type — should be ignored
    await Promise.resolve();
    expect(resolved).toBe(false);
    channel.emit({ type: CREDENTIAL_ANSWER, token: "ghs_y" });
    await pending;
    expect(resolved).toBe(true);
  });
});
