import { defineConfig } from "vite-plus";

export default defineConfig({
  fmt: {
    // Vendored agent skill docs keep their upstream formatting.
    ignorePatterns: [".agents/skills/**/*.md"],
  },
});
