---
"phoebe-agent": minor
---

The companion has a window. `apps/desktop` is a new Electron app whose renderer is
the console bundle, the same React app the relay serves in a browser, loaded from
disk over a privileged `phoebe://console/` scheme rather than over `file:` or a
second local listener.

It holds main and preload and nothing else. No UI lives in the desktop package, so
a page the operator sees is never written twice, and a fix to the fleet grid lands
in the browser and in the window at once. The console tells the two apart by
finding the bridge the preload exposes, and by nothing else. No build flag, no
second bundle, no user-agent sniff. The relay-client seam that every read goes
through now has both of its arms: the relay's own origin and its cookie in a
browser, the bridge in the companion, where main holds the session instead.

Signed out and with nothing installed, the window is shell A. One rail, a "This
machine" group above a "Relay" group, each saying which kind of empty it is. Local
installs, sign-in and the host verbs fill those groups in later tickets. The shell
they fill is here.

The app is private and carries no version of its own, reading the root package's
version at build time. It reads no `.env`, and Electron is pinned. `pnpm run ready`
builds it, so a broken main or preload fails the gate instead of waiting for
someone to package the app. Building needs no Electron binary, so the agent
container never downloads one.
