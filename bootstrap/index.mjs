// Runtime surface of the `phoebe-agent` package — what a consumer's
// `phoebe.config.ts` resolves when it imports from `phoebe-agent`. Node resolves
// a bare package specifier into `node_modules`, where Node 24 won't type-strip
// `.ts`, so this entry must be JS. It is trivially small: the only thing a
// consumer calls at runtime is `defineConfig`, an identity helper (its typed
// signature lives in index.ts, the package `types` entry). Everything else the
// package exposes is types-only. The bootstrapper's real logic is TypeScript —
// see bootstrap/cli.ts, reached via the bin launcher (bootstrap/bin.mjs).
export const defineConfig = (config) => config;
