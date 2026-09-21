// The preload — the whole of the companion's surface to the console bundle.
//
// It runs with context isolation on and the renderer sandboxed, so this is the
// only code that touches both worlds. Everything it exposes is declared in
// `phoebe-agent/contracts`; nothing here decides anything, it forwards.
//
// Exposing this global is also how the console bundle learns it is in the
// companion (#522 §4). The same bundle served by the relay in a browser finds
// nothing there and takes its browser arm.

import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { DESKTOP_BRIDGE_GLOBAL } from "phoebe-agent/contracts";
import type { DesktopBridge, RelayArmState, RelayEvent } from "phoebe-agent/contracts";
import { BRIDGE_CHANNELS, type BridgeResult } from "./channels.ts";

/** One invoke, with main's refusal turned back into a rejection. */
async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  const result = (await ipcRenderer.invoke(channel, ...args)) as BridgeResult<T>;
  if (result.ok) return result.value;
  // An Error, so the renderer's own `error instanceof Error` paths keep working,
  // with the contract's fields hung off it.
  throw Object.assign(new Error(result.error.message), {
    code: result.error.code,
    instruction: result.error.instruction,
  });
}

const bridge: DesktopBridge = {
  version: () => call<string>(BRIDGE_CHANNELS.version),
  relay: {
    state: () => call(BRIDGE_CHANNELS.relayState),
    signIn: (request) => call(BRIDGE_CHANNELS.relaySignIn, request),
    watch: (onState) => {
      const listener = (_event: IpcRendererEvent, state: RelayArmState) => {
        onState(state);
      };
      ipcRenderer.on(BRIDGE_CHANNELS.relayArm, listener);
      return () => {
        ipcRenderer.off(BRIDGE_CHANNELS.relayArm, listener);
      };
    },
    request: (request) => call(BRIDGE_CHANNELS.relayRequest, request),
    signOut: () => call(BRIDGE_CHANNELS.relaySignOut),
    events: (onEvent) => {
      const listener = (_event: IpcRendererEvent, relayEvent: RelayEvent) => {
        onEvent(relayEvent);
      };
      ipcRenderer.on(BRIDGE_CHANNELS.relayEvent, listener);
      return () => {
        ipcRenderer.off(BRIDGE_CHANNELS.relayEvent, listener);
      };
    },
  },
};

contextBridge.exposeInMainWorld(DESKTOP_BRIDGE_GLOBAL, bridge);
