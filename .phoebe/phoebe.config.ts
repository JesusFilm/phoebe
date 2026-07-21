// Dogfood config — Phoebe working its own repo (JesusFilm/phoebe).
//
// This is a *runtime-mounted* config (compose mounts it at
// /etc/phoebe/phoebe.config.ts), so it must load under Node's native ESM
// type-stripping with no reachable node_modules. That rules out the usual
// `import { defineConfig } from "phoebe-agent"` the scaffold ships — a bare
// specifier can't resolve from /etc/phoebe and ESM ignores NODE_PATH, so the
// engine would fail to import the config. `defineConfig` is only an identity
// helper anyway; a plain default-exported object is validated identically by
// the engine's resolveConfig(). We keep editor type-safety via a *type-only*
// import (erased at runtime) that resolves against this repo's own source.
import type { PhoebeUserConfig } from "../src/config-schema.ts";

const config: PhoebeUserConfig = {
  repoSlug: "JesusFilm/phoebe",
  repoUrl: "https://github.com/JesusFilm/phoebe.git",

  // This repo is pnpm + vite-plus (`vp`). The container enables corepack, so
  // `pnpm` resolves to the version pinned in package.json's `packageManager`.
  // installCommand is run by the engine (execSync) in each worktree;
  // check/test are rendered into the agent prompt and run by the agent.
  installCommand: "pnpm install --frozen-lockfile",
  checkCommand: "pnpm run check",
  testCommand: "pnpm run test",
  readyCommand: "pnpm run ready",

  // Dogfood with the Cursor provider (composer-2.5 default). Requires
  // CURSOR_API_KEY in the container env (see .env).
  defaultProvider: "cursor",

  // Self-update reinstalls the engine from npm on exit code 75, but we run a
  // locally-built engine tarball (npm only publishes the 0.0.0 stub — see
  // README). Empty selfUpdatePaths disables the self-update exit so the
  // supervisor never clobbers the local build with the npm stub.
  selfUpdatePaths: [],
};

export default config;
