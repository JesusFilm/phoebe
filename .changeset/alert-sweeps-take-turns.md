---
"phoebe-agent": patch
---

The relay no longer sends the same alert twice when two sweeps overlap. A sweep records what it sent only after the webhook answers, so a second sweep that started in the meantime (the timer, or a deployment connecting or dropping) found nothing recorded and sent again. Sweeps now run one at a time.
