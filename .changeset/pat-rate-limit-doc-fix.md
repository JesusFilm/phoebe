---
"phoebe-agent": patch
---

Correct the PAT rate-limit model in github-app-mode.md. Fine-grained PATs share
their owner's 5,000 req/hr budget rather than each carrying an independent
allowance. The App arm's GraphQL budget scales to 12,500 points/hr for standard
installations (REST also 12,500 req/hr) and 10,000 points/hr for Enterprise
Cloud (REST 15,000 req/hr), making it the better choice for multi-tenant fleets.
