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
import type {
  CompanionUpdate,
  DesktopBridge,
  LocalInstall,
  RelayEvent,
  RunExit,
  RunLine,
} from "phoebe-agent/contracts";
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

/** One subscription, with its own unsubscribe. */
function subscribe<T>(channel: string, onEvent: (payload: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, payload: T) => {
    onEvent(payload);
  };
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.off(channel, listener);
  };
}

const bridge: DesktopBridge = {
  version: () => call<string>(BRIDGE_CHANNELS.version),
  environment: () => call(BRIDGE_CHANNELS.environment),
  installs: {
    list: () => call(BRIDGE_CHANNELS.installsList),
    pick: () => call(BRIDGE_CHANNELS.installsPick),
    add: (dir) => call(BRIDGE_CHANNELS.installsAdd, dir),
    remove: (dir) => call(BRIDGE_CHANNELS.installsRemove, dir),
    changes: (onChange) => subscribe<LocalInstall[]>(BRIDGE_CHANNELS.installsChanged, onChange),
  },
  runs: {
    start: (request) => call(BRIDGE_CHANNELS.runStart, request),
    current: (install) => call(BRIDGE_CHANNELS.runCurrent, install),
    cancel: (runId) => call(BRIDGE_CHANNELS.runCancel, runId),
    lines: (onLine) => subscribe<RunLine>(BRIDGE_CHANNELS.runLine, onLine),
    exits: (onExit) => subscribe<RunExit>(BRIDGE_CHANNELS.runExit, onExit),
  },
  updates: {
    state: () => call(BRIDGE_CHANNELS.updateState),
    download: () => call(BRIDGE_CHANNELS.updateDownload),
    restart: () => call(BRIDGE_CHANNELS.updateRestart),
    changes: (onUpdate) => subscribe<CompanionUpdate>(BRIDGE_CHANNELS.updateChanged, onUpdate),
  },
  preferences: {
    get: () => call(BRIDGE_CHANNELS.preferencesGet),
    set: (preferences) => call(BRIDGE_CHANNELS.preferencesSet, preferences),
  },
  relay: {
    state: () => call(BRIDGE_CHANNELS.relayState),
    request: (request) => call(BRIDGE_CHANNELS.relayRequest, request),
    signOut: () => call(BRIDGE_CHANNELS.relaySignOut),
    events: (onEvent) => subscribe<RelayEvent>(BRIDGE_CHANNELS.relayEvent, onEvent),
  },
};

contextBridge.exposeInMainWorld(DESKTOP_BRIDGE_GLOBAL, bridge);
