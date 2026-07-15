import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
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
