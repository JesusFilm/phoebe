---
"phoebe-agent": patch
---

The `sentry` kind's `environments` option takes an empty list, which turns the environment filter off. Before, the list had to name at least one environment, and the default is `["production"]`: Sentry answers 404 for an environment name the organisation has never seen, so a project whose events carry no environment, or another name, failed every scan with no value that would fix it. The default is unchanged.
