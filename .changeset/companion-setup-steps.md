---
"phoebe-agent": minor
---

The companion walks a fresh install through its setup. An install that is not initialised or has no .env opens on four numbered steps: initialise, give Phoebe access to the repository, give it an agent to run, start. The GitHub step opens GitHub's fine-grained token page with the five grants ticked and the owner and lifetime filled in, checks the pasted token against the repository with the non-mutating probes, and saves it as GH_TOKEN. The agent step asks for the provider's key by the name the config uses. The desktop bridge gains `github.verifyToken`.
