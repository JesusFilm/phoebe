---
"phoebe-agent": minor
---

A running local install shows its container's output in a pane beside its page. "Logs" on the install's tab row opens it: `docker compose logs --follow` on the phoebe service, the last 200 lines then live, streamed over the bridge and kept to 2000 lines. The pane stays pinned to the newest line until you scroll up to read, follows again when the container comes back, and says why when the stream ends. A WSL install's logs are followed inside its distro, like every other Docker call for one.
