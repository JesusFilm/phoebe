---
"phoebe-agent": patch
---

The agent child now inherits `COREPACK_HOME` when the container sets it. Without it, the agent's `pnpm` or `yarn` ignored the corepack cache the engine's install used and fell back to `~/.cache/node/corepack`, a second cache the agent's own user could write. If your image prepares a root-owned corepack cache, the agent now runs from that cache too. If you don't set `COREPACK_HOME`, nothing changes.
