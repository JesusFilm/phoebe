/// <reference types="vite-plus/client" />

/**
 * The root package's version, read at build time and defined into the bundle by
 * `vite.config.ts` (#521 §4). The companion carries the engine's version rather
 * than one of its own, so nothing reads a `package.json` at runtime to find it.
 */
declare const __COMPANION_VERSION__: string;
