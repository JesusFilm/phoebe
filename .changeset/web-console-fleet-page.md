---
"phoebe-agent": minor
---

`phoebe relay serve` now serves the console. Opening the relay in a browser shows
the fleet: a rail down the left with every deployment on it, and a grid beside it
with one card per deployment and one bar segment per pipeline.

The rail is always on screen, because "is everything alive" is the question the
console exists to answer. Rows are sorted dark first, then anything with a wedged
pipeline or a crash-looping child, then by name — no health score and no "needs
attention" word, just counts of things you can go and look at. The four connection
words each get their own mark rather than four shades of one: a filled dot for
connected, a ring for disconnected with the seconds the relay counted, a square
for dark with its age, a dashed outline for unseen with when it was paired.
`replaced?` rides beside the word rather than instead of it. Light and dark themes
follow the OS.

Updates arrive over the relay's event stream, so the page never reloads and never
polls.

The bundle lives in the new `apps/console` workspace app and builds into `console/`
inside the published package, so there is nothing extra to install and nothing to
keep in version step with the relay. The build is generated rather than committed,
and `prepublishOnly` runs it, so every published tarball carries it. A relay whose
package was assembled without that build says so in a sentence instead of serving a
blank page.
