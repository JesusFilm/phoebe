---
"phoebe-agent": minor
---

The companion pairs a local install with the relay it is signed in to, in one click. `pair` is a composite verb run in main: it mints a pairing token with the device token, writes the relay's `wss://` address into the install's root config, writes `PHOEBE_RELAY_TOKEN` into the root `.env`, and nudges Compose so the container comes back holding both. Every step streams as a line. The token appears in none of them.

`phoebe-agent/contracts` gains `PairOutcome`, `MintedPairingToken` and `RELAY_TOKEN_ENV`, `HostVerb` gains `pair`, and `LocalInstall` gains the two facts a paired install is recognised by, `deploymentName` and `relayUrl`, both read off the root config on every list. A paired install shows once in the console's rail, under "This machine", with a `paired` chip, and the Relay group drops the row it would otherwise draw beside it.

Two engine-side pieces come with it. `src/config-handle.ts` grows `editConfigGetRelay` and `editConfigSetRelayUrl`, the static read and write of the `relay` block that pairing owns rather than `config set`. `src/dotenv-edit.ts` sets one key in a `.env` and leaves the rest of the operator's file alone.

The scaffolded `container/compose.yml` now forwards `PHOEBE_RELAY_TOKEN` into the container. Without that line the token sits on the host and the deployment never pairs, so a deployment scaffolded before this release needs it adding to its own compose file by hand.
