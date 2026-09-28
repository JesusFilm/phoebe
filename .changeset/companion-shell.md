---
"phoebe-agent": minor
---

The companion has a window. `apps/desktop` is a new Electron app whose renderer is
the console bundle, loaded from disk over a privileged `phoebe://console/` scheme
rather than over `file:` or a second local listener.

It holds main and preload and nothing else. No UI lives in the desktop package.
The console learns it is in the companion by finding the bridge the preload
exposes, and by nothing else. No build flag, no second bundle, no user-agent
sniff.

With nothing installed, the window is one rail with a "This machine" group that
says it is empty. Local installs and the host verbs fill it in later tickets.

The app is private and carries no version of its own, reading the root package's
version at build time. It reads no `.env`, and Electron is pinned. `pnpm run ready`
builds it, so a broken main or preload fails the gate instead of waiting for
someone to package the app. Building needs no Electron binary, so the agent
container never downloads one.
