import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // Installs a resolved config into src/resolved-config.ts before any test
    // module loads (orchestrator/prompt/etc. read config at import time).
    setupFiles: ["./src/test-setup.ts"],
  },
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {
    // Vendored agent skill docs keep their upstream formatting.
    ignorePatterns: [".agents/skills/**/*.md"],
  },
});
