---
"phoebe-agent": patch
---

One docs home for the console, the relay and the companion (#562).

`docs/console.md` is the page to send someone who asks "how do I watch a Phoebe I
have no shell on". It covers standing up a relay, pairing a deployment, what each
of the console's pages shows, alerting and its two sinks, the companion's remote
and local arms, and the part that stays at a shell on purpose. `relay.md` keeps
the mechanism next door and now points home; `operating.md`, `configuration.md`
and `trust.md` point at it rather than growing a second copy.

- `CONTEXT.md` gains **remote deployment**, and **console** is one entry rather
  than the two the arms each wrote. Every noun the console arm introduced now
  carries an avoid-list.
- The findings behind the design land under `docs/research/`: the outbound
  transport, Google sign-in for a self-hosted service, how T3 Code reaches remote
  machines and packages its clients, what youtube-studio's app guidelines
  require, and WebCrypto and secure storage on Electron and Expo.
- `relay.md`'s "Not here yet" is true again: config edits, secrets and all five
  tabs have landed, and alerting evaluates all five conditions against stored
  reports. What is left is the People page, running doctor from the console, and
  the test-alert button.
- Integration, from merging the four arms: the companion's relay client gained
  `setConfigField` and `setSecret` over the same passthrough its reads use, so
  one console bundle serves the browser and the window. The doctor report has one
  contract file again rather than two copies of the same type.
