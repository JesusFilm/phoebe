---
"phoebe-agent": patch
---

Rotate a tenant's PAT without a relaunch (#205). Editing only `GH_TOKEN` in a
tenant's `.env` no longer drains and respawns that tenant's engine child: the
supervisor answers each credential lease with the token as it currently is on
disk, and the engine picks it up at its next poll. Every other `.env` value
still triggers the relaunch (they are frozen into the child's env at spawn).
Removing or blanking `GH_TOKEN` also relaunches, so an absent token cannot
linger in a running child.
