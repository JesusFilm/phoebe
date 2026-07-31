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
  listenerCount: () => number;
} {
  const sent: unknown[] = [];
  const listeners = new Set<(message: unknown) => void>();
  return {
    connected: true,
    send: (message) => sent.push(message),
    on: (_event, listener) => listeners.add(listener),
    off: (_event, listener) => listeners.delete(listener),
    sent,
    emit: (message) => listeners.forEach((l) => l(message)),
    listenerCount: () => listeners.size,
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

  test("removes its message listener once granted (no accumulation)", async () => {
    const channel = mockChannel();
    const client = createSlotClient(channel)!;
    const pending = client.acquire();
    expect(channel.listenerCount()).toBe(1);
    channel.emit({ type: SLOT_GRANTED });
    await pending;
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
