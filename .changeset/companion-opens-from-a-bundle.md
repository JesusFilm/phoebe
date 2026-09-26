---
"phoebe-agent": patch
---

The companion opens again. `init` read the root `package.json` through `new URL("../package.json", import.meta.url)` at module load, and the bundler turned that into a `data:` URL that `readFileSync` refuses, so main threw before the window appeared. The read is now lazy and goes through the bundler-safe path helper, and the companion hands `init` its own version rather than looking for a manifest beside the bundle.
