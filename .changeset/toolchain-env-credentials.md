---
"phoebe-agent": minor
---

The engine's credentials no longer ride into toolchain spawns. `installCommand` runs in a worktree that may sit at a PR branch head, where the branch's install hooks execute as the engine's child — its environment now drops `GH_TOKEN`, `GH_APP_ID`/`GH_APP_PRIVATE_KEY`, and every configured provider API key while still inheriting the operator's toolchain env whole (registry tokens, proxies, `NODE_OPTIONS`). The prompt `` !`cmd` `` expansions keep `GH_TOKEN` — the shipped templates open with `gh` calls — but likewise stop seeing provider keys. An install that needs GitHub auth of its own (private git dependencies, GitHub Packages) must bring a dedicated token; the engine's minted credential is not it. `docs/trust.md` gains "The config is code": loading the config or a custom kind module is executing it, why an unmerged PR can't smuggle a kind in, and what `prScope` actually bounds.
