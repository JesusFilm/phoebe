import { defineConfig } from "vite-plus";

export default defineConfig({
  // The bundle is served from the relay's root and from a custom scheme in the
  // companion (#522 §4), so every asset URL has to be relative to the document
  // rather than to a known origin.
  base: "./",
  build: {
    // Out of the workspace package and into a directory the root package
    // publishes, which is what lets `phoebe relay serve` hand the console out of
    // the one installed package (#522 §5). `apps/*` itself never ships.
    outDir: "../../console",
    emptyOutDir: true,
  },
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
