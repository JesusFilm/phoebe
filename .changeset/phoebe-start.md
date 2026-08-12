---
"phoebe-agent": minor
---

`phoebe start [--build]` brings the deployment container up detached from the
host. It reuses the Compose discovery and injectable command runner from
`phoebe stop` (#186), does not rebuild an existing image unless `--build` is
passed, confirms the container stayed up after a short settle wait, and returns
to the prompt pointing at how to follow the logs.
