import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    include: [
      "src/**/*.test.ts",
      "bootstrap/**/*.test.ts",
      "kinds/**/*.test.ts",
      "scripts/**/*.test.ts",
    ],
    // Installs a resolved config into src/resolved-config.ts before any test
    // module loads (orchestrator/prompt/etc. read config at import time).
    setupFiles: ["./src/test-setup.ts"],
  },
  lint: {
    // Consumer-owned template files are not real project sources — they
    // contain unresolved {{PLACEHOLDER}} tokens that only become valid code
    // after `phoebe init` renders them into a consumer's repo. Vendored
    // third-party bundles are pre-minified and not subject to project lint rules.
    ignorePatterns: ["templates/**", "src/migrations/vendor/**"],
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {
    // Vendored agent skill docs keep their upstream formatting; unrendered
    // templates are shaped for consumers' repos, not this one. Vendored
    // third-party bundles are pre-minified and must not be reformatted.
    // CHANGELOG.md is written by `changeset version` on the release PR and
    // never by hand: a changeset with two paragraphs renders as a tight list
    // with a whitespace-only line between them, which the formatter rejects,
    // and the next `changeset version` would write it back the same way.
    ignorePatterns: [
      ".agents/skills/**/*.md",
      "templates/**",
      "src/migrations/vendor/**",
      "CHANGELOG.md",
    ],
  },
});
