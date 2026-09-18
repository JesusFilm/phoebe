import { readFileSync } from "node:fs";
import { defineConfig } from "vite-plus";

// One version for the engine and the apps (#521 §4): the companion carries the
// root package's, read here so the built main has it as a literal and nothing
// looks for a `package.json` on disk at runtime.
const { version } = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { version: string };

/** The two entry points, each built on its own pass. */
const ENTRIES = { main: "src/main.ts", preload: "src/preload.ts" };

// Two passes rather than one build with two entries, and the reason is the
// sandbox: a sandboxed preload gets a `require` that resolves `electron` and a
// handful of built-ins and nothing else, so a shared chunk beside it on disk —
// which is what one build emits for a module both entries import — is a file the
// preload can never load. Each entry is therefore bundled whole, alone.
//
// `--mode` picks the pass; `vp run build` runs both.
export default defineConfig(({ mode }) => {
  const entry = mode === "preload" ? "preload" : "main";
  return {
    build: {
      // Electron 44 runs Node 22 in main; nothing here is transpiled further down.
      target: "node22",
      outDir: "dist",
      // Only the first pass clears the directory — the second would take the
      // first's output with it.
      emptyOutDir: entry === "main",
      lib: {
        entry: { [entry]: ENTRIES[entry] },
        // The two halves take different formats, and each has no choice.
        //
        // The preload is CommonJS because a sandboxed preload has to be:
        // Electron loads an ES-module preload only with the sandbox off, and the
        // sandbox is worth more than the module syntax.
        //
        // Main is an ES module because it bundles the engine's host verbs
        // (#555, ADR 0001), and engine modules resolve their own shipped
        // resources through `import.meta`. A CommonJS pass replaces that with
        // `{}`, which turns a path walk into a throw at import time — main
        // would not finish loading. Electron has run an ESM main since v28.
        formats: [entry === "preload" ? "cjs" : "es"],
        fileName: () => `${entry}.${entry === "preload" ? "cjs" : "mjs"}`,
      },
      rollupOptions: {
        // Electron supplies its own module, and the built-ins are the runtime's.
        //
        // `electron-updater` is external for a different reason: it is CommonJS
        // with lazy `require`s for each platform's updater, and it reads
        // `app-update.yml` out of the packaged resources. Bundled into an ES
        // module those requires stop resolving, so it is left in
        // `node_modules` where electron-builder packs it as the production
        // dependency it is (#561).
        external: ["electron", "electron-updater", /^node:/],
      },
    },

    define: { __COMPANION_VERSION__: JSON.stringify(version) },

    test: {
      include: ["src/**/*.test.ts"],
    },
  };
});
