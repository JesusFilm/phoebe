// Engine slot-client tests (#59): request/grant/release over a mock IPC channel,
// and the standalone (no-channel) unbrokered path.

import { describe, expect, test } from "vite-plus/test";
import {
  createSlotClient,
  SLOT_ACQUIRE,
  SLOT_GRANTED,
  SLOT_RELEASE,
  type ParentChannel,
} from "./slot-client.ts";

function mockChannel(): ParentChannel & {
  sent: unknown[];
  emit: (message: unknown) => void;
  emitDisconnect: () => void;
  listenerCount: () => number;
} {
  const sent: unknown[] = [];
  // Event-aware, like the real IPC channel: `message` and `disconnect` are
  // distinct, so a `disconnect` handler never fires on an inbound message.
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

describe("createSlotClient", () => {
  test("returns null when there is no send (standalone → unbrokered)", () => {
    expect(createSlotClient({})).toBeNull();
    expect(createSlotClient({ connected: false, send: () => {} })).toBeNull();
  });

  test("acquire sends an acquire message and resolves on the grant", async () => {
    const channel = mockChannel();
    const client = createSlotClient(channel);
    expect(client).not.toBeNull();

    let resolved = false;
    const pending = client!.acquire().then(() => {
      resolved = true;
    });
    expect(channel.sent).toEqual([{ type: SLOT_ACQUIRE }]);
    expect(resolved).toBe(false);

    channel.emit({ type: SLOT_GRANTED });
    await pending;
    expect(resolved).toBe(true);
  });

  test("removes both its listeners once granted (no accumulation)", async () => {
    const channel = mockChannel();
    const client = createSlotClient(channel)!;
    const pending = client.acquire();
    // One `message` listener (the grant) + one `disconnect` listener (the
    // supervisor-died settle path).
    expect(channel.listenerCount()).toBe(2);
    channel.emit({ type: SLOT_GRANTED });
    await pending;
    expect(channel.listenerCount()).toBe(0);
  });

  test("settles (unbrokered) if the channel disconnects before a grant", async () => {
    const channel = mockChannel();
    const client = createSlotClient(channel)!;
    let resolved = false;
    const pending = client.acquire().then(() => {
      resolved = true;
    });
    expect(resolved).toBe(false);
    channel.emitDisconnect();
    await pending;
    expect(resolved).toBe(true);
    // And it cleaned up after itself — no leaked listeners.
    expect(channel.listenerCount()).toBe(0);
  });

  test("ignores unrelated messages while waiting", async () => {
    const channel = mockChannel();
    const client = createSlotClient(channel)!;
    let resolved = false;
    const pending = client.acquire().then(() => {
      resolved = true;
    });
    channel.emit({ type: "something-else" });
    channel.emit("not even an object");
    await Promise.resolve();
    expect(resolved).toBe(false);
    channel.emit({ type: SLOT_GRANTED });
    await pending;
    expect(resolved).toBe(true);
  });

  test("release sends a release message", () => {
    const channel = mockChannel();
    const client = createSlotClient(channel)!;
    client.release();
    expect(channel.sent).toEqual([{ type: SLOT_RELEASE }]);
  });
});
