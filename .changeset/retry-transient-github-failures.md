---
"phoebe-agent": patch
---

Retry transient GitHub failures with backoff instead of failing the cycle. Captured `gh` calls that die with a 5xx or a network-level error (connection reset, TLS timeout, the GraphQL server-error catch-all) now retry twice, 2s then 8s, before the error propagates; rate-limit and permission failures still fail immediately, since a few seconds of waiting can't fix either. `git fetch origin` retries on any failure — a fetch is idempotent, and a GitHub 504 mid-negotiation used to cost a whole cycle or an engine restart. Writes with inherited stdio (comments, labels, `pr create`) are deliberately not retried: there is no captured stderr to classify, and a blind re-send after an ambiguous failure could double-post.
