---
"phoebe-agent": patch
---

Correct the PAT rate-limit model in github-app-mode.md. Fine-grained PATs share
their owner's 5,000 req/hr budget rather than each carrying an independent
allowance. The App arm scales up to 12,500 req/hr (15,000 on Enterprise Cloud),
making it the better choice for multi-tenant fleets.
