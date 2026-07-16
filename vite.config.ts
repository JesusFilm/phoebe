import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // Installs a resolved config into src/resolved-config.ts before any test
    // module loads (orchestrator/prompt/etc. read config at import time).
    setupFiles: ["./src/test-setup.ts"],
  },
  lint: {
    // Consumer-owned template files are not real project sources — they
    // contain unresolved {{PLACEHOLDER}} tokens that only become valid code
    // after `phoebe init` renders them into a consumer's repo.
    ignorePatterns: ["dist/**", "templates/**"],
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {
    // Vendored agent skill docs keep their upstream formatting; unrendered
    // templates are shaped for consumers' repos, not this one.
    ignorePatterns: [".agents/skills/**/*.md", "templates/**"],
  },
});
