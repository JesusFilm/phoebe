---
"phoebe-agent": minor
---

The companion signs in to a relay, and stays signed in.

Sign-in runs in the operator's own browser, because Google refuses to sign anyone
in inside an embedded webview and the relay's one registered redirect URI is its
own HTTPS callback. Main mints a PKCE verifier, opens the browser at the relay's
`/auth/device/start`, and the relay — after the same Google flow and the same
allowlist check a browser gets — comes back to `phoebe://auth?code=…`. The code is
single use, lives sixty seconds, and is bound to that challenge, so any app on the
machine can register the scheme but only the one holding the verifier can spend it.

What comes back is a **device token**: an opaque bearer the relay stores as a
SHA-256 hash in `devices.json` beside the person's `sub`, address, device name and
last seen. It has no expiry. Revocation is the only end it has, and it survives a
relay restart, which is the point — a companion is not a browser with an operator
sitting in front of it.

Main is the relay client. It holds the token, makes every call, and forwards the
relay's event stream to the renderer over IPC, so the console bundle running in
the window never learns the token and never reaches the relay itself. A 401 ends
the session rather than starting a retry: main drops the token and the rail draws
its sign-in control again.

At rest the token is wrapped with Electron's `safeStorage`. On a machine with no
keyring — headless Linux, a container, a minimal desktop — the companion refuses
to persist it, keeps it in memory for the session, and says so in the rail.
Plaintext on disk was not an option for a bearer that never expires.

The relay's door now reads two carriers, a `__Host-` cookie or an
`Authorization: Bearer`, and nothing behind it knows which one it got. Two new
reads come with it: the devices a relay holds, and the revoke that ends one — by
device, or by person, which is what removing someone from the allowlist has to do.
