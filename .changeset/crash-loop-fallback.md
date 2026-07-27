---
"phoebe-agent": minor
---

`phoebe boot` now guards against a bad engine ref. Tracking a branch means
eventually tracking it onto a commit that will not boot; after three consecutive
fast crashes (a non-zero exit inside 60s) boot quarantines that commit and
materializes the last engine SHA that ran healthily instead, keeping the
container serving until the tracked ref moves past the bad commit — at which
point the quarantine lapses and reconcile resumes normally.

A run is judged three ways — healthy, crash, or inconclusive — so that a run boot
itself ended (a reconcile drain, a container stop) moves nothing, and a commit
that outlives the healthy window is banked as last-good while it is still
running. The record (last-good SHA, quarantined SHA, crash count) is JSON in
`paths.stateDir`, so a quarantine survives the container restart a crash-looping
engine causes; an unwritable state dir is a warning, not a failure. The guard is
inert unless the engine ref is a moving branch — a `local` mount has no commit to
pin, and a pinned SHA or tag means the operator chose that exact commit — and
inert until some commit has proven itself, so a first boot onto a broken ref
still fails loudly.
