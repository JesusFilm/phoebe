---
"phoebe-agent": minor
---

The companion registers a GitHub App for a workspace from its setup steps, through GitHub's manifest flow: a browser tab posts the App's name and the five permissions, GitHub shows one page to confirm, and the App's id and private key come back into the deployment .env as GH_APP_ID and GH_APP_PRIVATE_KEY, with a link to install it on the repositories. A solo install is offered the same below its token field. The desktop bridge gains `github.createApp`. docs/github-app-mode.md now names the env vars the bootstrapper reads.
