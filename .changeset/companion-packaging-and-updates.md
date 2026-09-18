---
"phoebe-agent": minor
---

The companion ships, and an installed one keeps itself in step with its relay.

Every `phoebe-agent@x.y.z` release now carries the app. A packaging stage runs
after `changeset publish` on three runners and attaches the artifacts to the
GitHub Release at the tag the publish just pushed: mac arm64 as a dmg and a zip,
win x64 as an NSIS installer, linux x64 as an AppImage. One human trigger, merging
the version PR, releases npm and the app together — there is no second version to
track and no separate cadence. Self-build stays what it was: `vp run -r build`,
then `vp run package` in `apps/desktop`, which is the same script CI runs.

All three ship unsigned this effort. The docs carry the Gatekeeper workaround, and
the app's own updater is off on macOS, because Squirrel.Mac refuses to install an
unsigned bundle. When a certificate lands, that clause flips and nothing else
moves.

Updates are `electron-updater`, and they are deliberately unhurried: one check
shortly after launch, no poll, no download without a click, and the install waits
for the app to quit unless you ask for a restart. A tool that drives Docker on
your machine does not swap itself out while you are watching. Only the stable feed
exists — there is no nightly channel.

Which build you are offered is the relay's business. Signed in, the feed is pinned
to the relay's own version, so the only update ever offered is one that relay
serves; signed out, it is the newest stable release. Signed in to a relay that
cannot be reached, nothing is checked at all, because the newest build there is
may be one that relay cannot serve. There is no downgrade in any case: a companion
ahead of its relay is told to upgrade the relay, never offered a way back.

When there is something to do about a new build, the rail says so in one line, and
that line is the only place an update is ever mentioned.
