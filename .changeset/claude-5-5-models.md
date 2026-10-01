---
"phoebe-agent": minor
---

The Claude models Phoebe runs move to the current generation. The shipped `defaultModels.claude` is `claude-sonnet-5-5` (was `claude-sonnet-4-6`), and the `sentry` kind's most-capable default is `claude-opus-5-5` (was `claude-opus-5`), still at `high` effort. A consumer that names its own `defaultModels.claude` or a kind `model` is unaffected. The engine repo's own configs move to `claude-opus-5-5` / `claude-sonnet-5-5` the opus kinds keep `high`, and `reviews` runs sonnet-5.5 at `medium` rather than the `low` floor, since Sonnet 5.5 at `low` tends to skip the check that exercises a change.
