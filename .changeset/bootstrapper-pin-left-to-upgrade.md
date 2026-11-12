---
"phoebe-agent": patch
---

The dependency detectors no longer file the `phoebe-agent` pin in a Dockerfile (`ARG PHOEBE_AGENT_VERSION`). That pin has to move with the engine ref, and `phoebe upgrade --both` moves the two together, while a dependency PR moved it alone. `dependency-updates` and `dependency-security` each take a new option, `bootstrapperPin`. It defaults to `"skip"`; set it to `"propose"` to have the pin filed like any other dependency.
