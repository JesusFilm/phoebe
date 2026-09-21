---
"phoebe-agent": patch
---

The repo becomes a pnpm workspace so the apps that ship beside the engine have
somewhere to live. `phoebe-agent` stays at the root and packs the same files it
did before; `apps/*` is empty until the desktop console lands. The root `ready`
gate now ends in `vp run -r build`.
