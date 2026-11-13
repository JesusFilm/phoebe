---
"phoebe-agent": minor
---

Setup asks for **Workflows: Read and write** as a sixth GitHub grant. The companion's "Create a token on GitHub" link ticks it, the App manifest requests it, and the token check and `scripts/verify-tenant-token.mjs` report it beside the other five. Without it GitHub refuses any push that changes a file under `.github/workflows/`, which Phoebe hits when it catches a PR branch up with a base that carries a workflow change. A token or App installation created before this needs the grant added by hand: onboarding §2 and `github-app-mode.md` §3 say where.
