---
"phoebe-agent": patch
---

A pipeline no longer sleeps out a poll interval behind a slot that is already free (#456). The engine wakes its loop when an in-flight unit settles, but that only reached wakers registered at that instant, and the loop sits inside the registration window for part of each pass. A unit finishing while a sibling admission was parked in `slotClient.acquire()` fired into an empty waker set, so the next wait — the idle one in particular — slept a full interval before reconsidering admission.

The settle now latches when nobody is listening, and the next wait consumes the latch and returns at once. Consuming clears it, so the worst case is one extra pass and the loop cannot spin. This closes the part of the settle-vs-poll race #422 left open; the added latency was bounded at one idle poll and never a hang.
