---
"phoebe-agent": minor
---

Spend limits. A `spend` block on the tenant or on `pipelines.<name>` sets a `warn` and a `ceiling`, each with optional `usd24h`, `usd7d`, `tokens24h` and `tokens7d`. `usd` counts API spend only, so a subscription estimate never trips it; `tokens` counts input plus output tokens. When a ceiling is reached, the bootstrapper holds admission on the pipelines it covers until the rolling window falls back under it or the ceiling is raised. Units already running finish, and a held observer refuses manual runs. The deployment report carries each cell's hold and the warning limits it has reached.
