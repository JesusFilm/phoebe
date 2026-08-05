---
"phoebe-agent": minor
---

Wire the poison-unit quarantine write path into the engine (#75/#80). A unit of
work that repeatedly fails is now quarantined rather than retried indefinitely,
keeping a poison ticket from stalling the fleet.
