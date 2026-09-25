import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite-plus";

export default defineConfig({
  // The bundle is served from the relay's root and from a custom scheme in the
  // companion (#522 §4), so every asset URL has to be relative to the document
  // rather than to a known origin.
  base: "./",
  // Tailwind 4 through its Vite plugin, which is how Coss UI's components are
  // styled (components.json). The `~` alias is the one the shadcn CLI writes
  // into every component it adds, so the pieces land importing each other.
  plugins: [tailwindcss()],
  resolve: {
    alias: { "~": fileURLToPath(new URL("./src", import.meta.url)) },
    // One React. Base UI reaches `react` through pnpm's symlinked package path
    // and the bundler took that for a second module: a tree-shaken copy whose
    // hook dispatcher react-dom never installs, so the first `useRef` inside a
    // Coss button threw and the window went blank. Dedupe resolves every
    // `react` and `react-dom` import to the same module.
    dedupe: ["react", "react-dom"],
  },
  server: {
    // Fixed and strict (#521 §7). The companion's main process loads this exact
    // URL when it is started with --dev, so a port that quietly moved because
    // something else held this one would put the wrong thing in the window.
    port: 5273,
    strictPort: true,
  },
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
