---
"phoebe-agent": patch
---

Document the Claude Code CLI version floor. The CLI rejects a model released after it with a `does not support this model` error, and the unit ends with `Agent exited with code 1`; the current models (`claude-opus-5-5`, `claude-sonnet-5-5`, the latter the shipped `defaultModels.claude`) need CLI 2.1.280 or newer. `docs/claude-subscription-auth.md` now says so beside the install step, and notes that an unpinned `npm install -g @anthropic-ai/claude-code` stays frozen at the version the image was built with until a `docker compose build --no-cache`. The engine repo's own dogfood image pin moves to 2.1.287.
