---
"phoebe-agent": patch
---

A GitHub rate-limit 403 is now reported as one, not as a permission failure
(#201). Failed `gh` calls are classified from their stderr — `rate limit` vs
`Resource not accessible by …` — and a rate-limit hit is rethrown as
`GitHub rate limit exhausted (graphql|core) — resets at <time>`, with the reset
time fetched from `/rate_limit` (which does not count against the primary
quota). Operators reading
the log can now tell "wait" from "fix the token".
