# How T3 Code reaches remote machines

Research for [#498](https://github.com/JesusFilm/phoebe/issues/498) on the console-and-relay
map ([#497](https://github.com/JesusFilm/phoebe/issues/497)), read 2026-09-09 directly from the
[pingdotgg/t3code](https://github.com/pingdotgg/t3code) source at commit
`e16b8b059c9f5ff6dfed1addecffb831c6aee043` (`e16b8b0`, the tree behind nightly
`0.0.41-nightly.20260909.1461`; stable is `v0.0.40`, 2026-09-08). Every claim cites the file that
owns it. The local install under `~/.t3/` was inspected read-only and is used only as
corroboration, marked as such.

First captured on the throwaway `research/t3-code-remote-relay` branch while #497 was being
charted, then landed here on the ticket's own resolution after a second reading of the same
tree. The second pass added the loopback origin rule, the connector handshake, the two-minute
mint credential and its scopes, and the client rebuild that self-hosting the relay implies.

T3 Code is a client (web, Electron desktop, iOS/Android) that controls coding agents running in an
**environment**: one server process on the machine that owns the workspace
([docs/internals/glossary.md](https://github.com/pingdotgg/t3code/blob/e16b8b059c9f5ff6dfed1addecffb831c6aee043/docs/internals/glossary.md)).
The remote story is four routes to that same server, and one of them has a hosted component T3
calls "the relay". That word means something narrower than it does on #497, and the difference is
the main finding.

## The short answers

- **There is no server component in the data path.** T3 Code's "relay" is a control plane only.
  "After a client connects, regular API and WebSocket traffic goes directly between that client and
  the selected environment"
  ([infra/relay/README.md](https://github.com/pingdotgg/t3code/blob/e16b8b059c9f5ff6dfed1addecffb831c6aee043/infra/relay/README.md)).
  What makes the environment reachable from the internet is a **Cloudflare Tunnel**: the
  environment spawns `cloudflared tunnel run` as a child process
  ([apps/server/src/cloud/ManagedEndpointRuntime.ts](https://github.com/pingdotgg/t3code/blob/e16b8b059c9f5ff6dfed1addecffb831c6aee043/apps/server/src/cloud/ManagedEndpointRuntime.ts)),
  and the relay provisions the tunnel and DNS name
  ([infra/relay/src/environments/ManagedEndpointProvider.ts](https://github.com/pingdotgg/t3code/blob/e16b8b059c9f5ff6dfed1addecffb831c6aee043/infra/relay/src/environments/ManagedEndpointProvider.ts)).
- **Hosting: one hosted relay, Cloudflare Worker plus Postgres, deployed with Alchemy;
  self-hosting is supported but not the product.** `infra/relay/alchemy.run.ts` provisions the
  Worker, queues, Hyperdrive, tunnel and DNS records across two Cloudflare zones, a PlanetScale
  database and Axiom trace datasets, with Clerk and APNs credentials as runtime secrets; the
  `prod` stage owns the retained database every other stage branches from, so it deploys first.
  `relay.t3.codes` is the production instance; a self-hosted relay is a different
  `T3CODE_RELAY_URL` baked into a source build, and since "client and bundled-server builds
  embed the public values", pointing desktop, mobile and web at your own relay means building
  your own clients
  ([infra/relay/README.md](https://github.com/pingdotgg/t3code/blob/e16b8b059c9f5ff6dfed1addecffb831c6aee043/infra/relay/README.md),
  [.env.example](https://github.com/pingdotgg/t3code/blob/e16b8b059c9f5ff6dfed1addecffb831c6aee043/.env.example),
  [docs/operations/connect-setup.md](https://github.com/pingdotgg/t3code/blob/e16b8b059c9f5ff6dfed1addecffb831c6aee043/docs/operations/connect-setup.md),
  [docs/operations/relay-observability.md](https://github.com/pingdotgg/t3code/blob/e16b8b059c9f5ff6dfed1addecffb831c6aee043/docs/operations/relay-observability.md)).
- **Connection direction: the environment dials out, twice.** Outbound HTTPS to the relay to link
  and to publish activity, and an outbound `cloudflared` connection that carries inbound client
  traffic back to a loopback origin. The environment's own listener stays on `127.0.0.1` for this
  route ("Managed tunnels expose only a validated loopback HTTP origin",
  [docs/internals/t3-connect.md](https://github.com/pingdotgg/t3code/blob/e16b8b059c9f5ff6dfed1addecffb831c6aee043/docs/internals/t3-connect.md)).
  The relay itself _does_ make one inbound call into the environment, through the tunnel: the
  credential-mint request (see "Login and pairing").
- **Transport: Effect RPC over a WebSocket at `/ws`, JSON-serialised, plus plain HTTP for
  auth, snapshots and file bytes.** `RpcServer.toHttpEffectWebsocket(WsRpcGroup, …)` with
  `RpcSerialization.layerJson`
  ([apps/server/src/ws.ts](https://github.com/pingdotgg/t3code/blob/e16b8b059c9f5ff6dfed1addecffb831c6aee043/apps/server/src/ws.ts)
  around line 2937); the client mirrors it with `RpcClient.makeProtocolSocket` and
  `Socket.layerWebSocket`
  ([packages/client-runtime/src/rpc/session.ts](https://github.com/pingdotgg/t3code/blob/e16b8b059c9f5ff6dfed1addecffb831c6aee043/packages/client-runtime/src/rpc/session.ts)).
- **Reconnect: one supervisor per environment, a four-rung ladder `3s, 4s, 8s, 16s`, 15-second
  establishment and probe timeouts, and wakeups instead of retries when offline or unauthenticated.**
  Subscriptions re-attach on the new session; mutations are not replayed
  ([packages/client-runtime/src/connection/supervisor.ts](https://github.com/pingdotgg/t3code/blob/e16b8b059c9f5ff6dfed1addecffb831c6aee043/packages/client-runtime/src/connection/supervisor.ts)
  lines 32–34;
  [docs/internals/connection-runtime.md](https://github.com/pingdotgg/t3code/blob/e16b8b059c9f5ff6dfed1addecffb831c6aee043/docs/internals/connection-runtime.md)).
- **Sessions: the environment issues its own.** A 30-day scoped session token, a 5-minute
  single-use WebSocket ticket to keep the long-lived token out of socket URLs, and per-RPC scope
  checks
  ([apps/server/src/auth/SessionStore.ts](https://github.com/pingdotgg/t3code/blob/e16b8b059c9f5ff6dfed1addecffb831c6aee043/apps/server/src/auth/SessionStore.ts)
  lines 417–418;
  [apps/server/src/auth/RpcAuthorization.ts](https://github.com/pingdotgg/t3code/blob/e16b8b059c9f5ff6dfed1addecffb831c6aee043/apps/server/src/auth/RpcAuthorization.ts)).
- **Login and pairing are two different systems.** Cloud identity is **Clerk** (OAuth + PKCE for
  the CLI, native SDKs for desktop and mobile) and buys you a relay token. Environment access is a
  **pairing grant** minted by the environment (a 12-character one-time code, or a relay-brokered
  bootstrap credential bound to the client's DPoP key) exchanged at the environment's
  `/oauth/token`. "A relay token is never an environment login"
  ([docs/internals/environment-auth.md](https://github.com/pingdotgg/t3code/blob/e16b8b059c9f5ff6dfed1addecffb831c6aee043/docs/internals/environment-auth.md)).

## The four routes

[docs/internals/remote.md](https://github.com/pingdotgg/t3code/blob/e16b8b059c9f5ff6dfed1addecffb831c6aee043/docs/internals/remote.md)
states the invariant: "Direct access, Tailscale, SSH, and T3 Connect change how the client
reaches that server; they do not introduce another execution model." The contract encodes the
same set as `ClientConnectionMethod = "direct" | "ssh" | "relay" | "unknown"`
([packages/contracts/src/baseSchemas.ts](https://github.com/pingdotgg/t3code/blob/e16b8b059c9f5ff6dfed1addecffb831c6aee043/packages/contracts/src/baseSchemas.ts)
line 154; Tailscale is `direct` with a different address).

| Route        | Who opens the path                                                    | Where the listener binds                              | Hosted component                    |
| ------------ | --------------------------------------------------------------------- | ----------------------------------------------------- | ----------------------------------- |
| Direct / LAN | Nobody; client connects to `host:3773`                                | `0.0.0.0` when network access is on, else `127.0.0.1` | None                                |
| Tailscale    | `tailscale serve` maps HTTPS 443 to the local port                    | Loopback, fronted by tailscaled                       | Tailscale's (not T3's)              |
| SSH          | Desktop main spawns `ssh -L`, launches or reuses `npx t3 serve` there | Loopback on the remote host                           | None                                |
| T3 Connect   | Environment runs `cloudflared`; relay provisions the tunnel           | Loopback, fronted by Cloudflare                       | Relay (control) + Cloudflare (data) |

Sources: default port `DEFAULT_PORT = 3773`
([apps/server/src/config.ts](https://github.com/pingdotgg/t3code/blob/e16b8b059c9f5ff6dfed1addecffb831c6aee043/apps/server/src/config.ts)
line 20); desktop bind hosts `127.0.0.1` / `0.0.0.0` and the `local-only | network-accessible`
setting
([apps/desktop/src/backend/DesktopServerExposure.ts](https://github.com/pingdotgg/t3code/blob/e16b8b059c9f5ff6dfed1addecffb831c6aee043/apps/desktop/src/backend/DesktopServerExposure.ts)
lines 30–31,
[packages/contracts/src/ipc.ts](https://github.com/pingdotgg/t3code/blob/e16b8b059c9f5ff6dfed1addecffb831c6aee043/packages/contracts/src/ipc.ts)
line 566); Tailscale via the `tailscale` CLI's `status` and `serve` subcommands, default port 443
([packages/tailscale/src/tailscale.ts](https://github.com/pingdotgg/t3code/blob/e16b8b059c9f5ff6dfed1addecffb831c6aee043/packages/tailscale/src/tailscale.ts));
SSH tunnel with a 200-port scan window, 20 s SSH-ready, 60 s remote-ready and 90 s launch
timeouts, and the rule that a server the launcher did not start survives disconnect
([packages/ssh/src/tunnel.ts](https://github.com/pingdotgg/t3code/blob/e16b8b059c9f5ff6dfed1addecffb831c6aee043/packages/ssh/src/tunnel.ts)
lines 50–57 and the `remoteServerKind: "external" | "managed"` field).

**Local corroboration.** `~/.t3/userdata/server-runtime.json` on this machine reads
`{"host":"0.0.0.0","port":3774,"origin":"http://127.0.0.1:3774"}` and
`desktop-settings.json` has `"serverExposureMode":"network-accessible"`, which is the direct/LAN
row. `~/.t3/userdata/secrets/` holds `cloud-link-ed25519-key-pair.bin` (the environment's link
signing key, see below) and `server-signing-key.bin`. The `state.sqlite` has `auth_sessions`
(columns include `scopes`, `method`, `expires_at`, `revoked_at`, `last_connected_at`) and
`auth_pairing_links`, matching `SessionStore.ts` and `PairingGrantStore.ts`. Secret contents were
not read.

## T3 Connect: the relay as a broker

The relay is a Cloudflare Worker (`infra/relay/src/worker.ts`) with an Effect `HttpApi`
([infra/relay/src/http/Api.ts](https://github.com/pingdotgg/t3code/blob/e16b8b059c9f5ff6dfed1addecffb831c6aee043/infra/relay/src/http/Api.ts))
backed by Postgres on PlanetScale via drizzle
([infra/relay/package.json](https://github.com/pingdotgg/t3code/blob/e16b8b059c9f5ff6dfed1addecffb831c6aee043/infra/relay/package.json),
migrations under `infra/relay/migrations/postgres/`, baseline dated 2026-05-27). It was called
"T3 Cloud" until the rename in
[v0.0.27](https://github.com/pingdotgg/t3code/releases/tag/v0.0.27) (2026-06-09, PR #3011);
headless `t3 connect` for SSH hosts and per-user managed-tunnel limits landed by
[v0.0.29](https://github.com/pingdotgg/t3code/releases/tag/v0.0.29) (PRs #3749, #4530).

Its stated responsibilities, verbatim from the README: linking environments to a cloud account;
provisioning and tracking managed endpoints; issuing short-lived credentials to connect clients
to linked environments; listing environments and devices; registering APNs/FCM tokens; receiving
published agent activity and delivering push notifications and Live Activities. The full route
surface from
[packages/contracts/src/relay.ts](https://github.com/pingdotgg/t3code/blob/e16b8b059c9f5ff6dfed1addecffb831c6aee043/packages/contracts/src/relay.ts)
(lines 902–1095):

```
GET  /health
GET  /.well-known/oauth-authorization-server
GET  /.well-known/oauth-protected-resource
POST /v1/client/dpop-token                              Clerk JWT or CLI OAuth token -> relay DPoP token
POST /v1/client/environment-link-challenges             ask for a challenge nonce
POST /v1/client/environment-links                       submit environment-signed link proof
DELETE /v1/client/environment-links/:environmentId      unlink
DELETE /v1/client/environment-links/:environmentId/tunnel  release the managed tunnel
GET  /v1/environments                                   list linked environments
POST /v1/environments/:environmentId/connect            broker a bootstrap credential
GET  /v1/environments/:environmentId/status
POST /v1/environments/:environmentId/threads/:threadId/agent-activity
GET/POST /v1/client/devices, /v2/client/devices, /v1/mobile/devices, /v1/mobile/live-activities, /v1/mobile/agent-activity
```

Nothing on that list carries a thread, a file, or an RPC. The README puts it plainly: "The relay is
intentionally not in the hot path for normal T3 Code traffic."

### How an environment gets a public address

1. The client (or `t3 connect`) requests a challenge, then asks the environment to sign a
   **link proof**: an Ed25519 JWT over `{challenge, descriptor, environmentId,
environmentPublicKey, endpoint, origin, scopes}` where `endpoint` is the public
   `{httpBaseUrl, wsBaseUrl, providerKind}` and `origin` is the loopback `{localHttpHost,
localHttpPort}` the tunnel will front
   (`RelayEnvironmentLinkProofPayload`, `RelayLinkProofRequest`, relay.ts lines 165–252;
   environment side `POST /api/connect/link-proof`,
   [packages/contracts/src/environmentHttp.ts](https://github.com/pingdotgg/t3code/blob/e16b8b059c9f5ff6dfed1addecffb831c6aee043/packages/contracts/src/environmentHttp.ts)
   line 558).
2. The relay verifies the proof in eleven named stages (`decode_token` … `validate_endpoint`,
   [infra/relay/src/environments/EnvironmentLinker.ts](https://github.com/pingdotgg/t3code/blob/e16b8b059c9f5ff6dfed1addecffb831c6aee043/infra/relay/src/environments/EnvironmentLinker.ts)),
   records the link for the `(user, environment)` pair, and if `managedTunnelsEnabled`,
   provisions a Cloudflare Tunnel and a `prod-<digest>.<RELAY_TUNNEL_ZONE_NAME>` hostname,
   returning `endpointRuntime = {providerKind, connectorToken, tunnelId, tunnelName}`
   (`RelayManagedEndpointRuntimeConfig`, relay.ts line 181; README "Deployment"). It refuses
   before it provisions anything if the proof's origin is not loopback: `isLoopbackOrigin`
   accepts `127.0.0.1`, `::1` and `localhost` with a port in 1–65535, and nothing else
   (ManagedEndpointProvider.ts). The whole provisioning run is an eleven-stage checkpointed
   sequence (`derive-environment-hash` … `mark-allocation-ready`) so a retry can reconcile
   partial work.
3. The environment stores that config in its secret store and spawns
   `cloudflared tunnel run` with the connector token passed as `TUNNEL_TOKEN` in the child's
   environment, then waits for the line `Registered tunnel connection` on its stderr before
   calling the route live. It restarts on exit with a 1 s → 60 s backoff and a 30 s
   "stable uptime" reset
   ([ManagedEndpointRuntime.ts](https://github.com/pingdotgg/t3code/blob/e16b8b059c9f5ff6dfed1addecffb831c6aee043/apps/server/src/cloud/ManagedEndpointRuntime.ts)
   lines 78–82, 276). The `cloudflared` binary is downloaded from Cloudflare's GitHub releases,
   pinned at `2026.5.2`
   ([packages/shared/src/relayClient.ts](https://github.com/pingdotgg/t3code/blob/e16b8b059c9f5ff6dfed1addecffb831c6aee043/packages/shared/src/relayClient.ts)
   lines 75–95).

`RelayManagedEndpointProviderKind` is `"manual" | "cloudflare_tunnel" | "t3_relay"` (relay.ts
line 158). `manual` is a user-supplied public endpoint (a Tailscale HTTPS address, for example)
that the relay records but does not provision. **Unverified:** what `t3_relay` is. The runtime
only implements `cloudflare_tunnel` and reports any other kind as `"unsupported"`
(`ManagedEndpointRuntime.ts` lines 55–58); I found no handler for `t3_relay` in this tree and
no doc mentioning it. It may be a reserved value for a first-party tunnel.

### Link lifetime versus process lifetime

[docs/internals/t3-connect.md](https://github.com/pingdotgg/t3code/blob/e16b8b059c9f5ff6dfed1addecffb831c6aee043/docs/internals/t3-connect.md)
separates three lifetimes: CLI authorisation (stored Clerk credential), desired exposure (the
link record), and the running connector. Linking "can record intent while the server is
stopped. Startup reconciles that intent." A normal shutdown of a CLI-managed link releases the
tunnel to avoid paying for it idle, but keeps the hostname reservation and the allocation record
so the environment shows as "offline" rather than "not authorized". Two cases keep the tunnel
across shutdown: a link installed from a client (no startup provisioning path) and an update
handoff (avoids DNS propagation delay on every update). Managed tunnels are limited per user
([infra/relay/src/environments/ManagedTunnelLimits.ts](https://github.com/pingdotgg/t3code/blob/e16b8b059c9f5ff6dfed1addecffb831c6aee043/infra/relay/src/environments/ManagedTunnelLimits.ts)),
surfaced as `environment_link_limit_exceeded`
([docs/user/remote-access.md](https://github.com/pingdotgg/t3code/blob/e16b8b059c9f5ff6dfed1addecffb831c6aee043/docs/user/remote-access.md)).

The environment must run continuously to be reachable: T3 ships a systemd user service (with
`loginctl enable-linger`) and a macOS LaunchAgent, installed by `t3 service install`; Windows
services are not supported
([docs/user/background-service.md](https://github.com/pingdotgg/t3code/blob/e16b8b059c9f5ff6dfed1addecffb831c6aee043/docs/user/background-service.md),
[apps/server/src/cloud/bootService.ts](https://github.com/pingdotgg/t3code/blob/e16b8b059c9f5ff6dfed1addecffb831c6aee043/apps/server/src/cloud/bootService.ts)).

## Transport and session semantics

**Handshake.** A client with a session token calls `POST /api/auth/websocket-ticket`
(environmentHttp.ts line 441; client side
[packages/client-runtime/src/authorization/remote.ts](https://github.com/pingdotgg/t3code/blob/e16b8b059c9f5ff6dfed1addecffb831c6aee043/packages/client-runtime/src/authorization/remote.ts)
line 191), receives a 5-minute ticket, and opens `wss://…/ws?wsTicket=…` with optional client
identity on the same URL (ws.ts line 403). Browser sessions may authenticate the upgrade with
their cookie instead. The session is not "ready" when the socket opens; it waits for the initial
server-configuration event first (connection-runtime.md, "Transport health and data freshness
are separate").

**Wire format.** Effect's `RpcServer`/`RpcClient` over the socket with JSON serialisation
(ws.ts line 2968, session.ts line 204). The RPC group and its per-method required scopes are in
`packages/contracts/src/rpc.ts` and `apps/server/src/auth/RpcAuthorization.ts`. Thread and shell
state arrive as **subscriptions** that send only what that client views; the replay cursor is
kept client-side for five idle minutes so back-navigation resumes without a fresh snapshot
(connection-runtime.md). HTTP carries the things a socket carries badly: auth, snapshots
(`/api/orchestration/snapshot`), command dispatch (`/api/orchestration/dispatch`), PR diffs,
and signed asset URLs (environmentHttp.ts lines 509–542; environment-auth.md).

**Reconnect.** One supervisor per environment owns the retry policy; endpoint resolution and
socket open are single attempts inside it. Ladder `[3_000, 4_000, 8_000, 16_000]` ms, capped at
the last rung; `CONNECTION_ESTABLISHMENT_TIMEOUT` and `CONNECTION_PROBE_TIMEOUT` both 15 s
(supervisor.ts lines 32–34). Offline and auth-failure states do not consume rungs; they wait for
a network-change or app-foreground wakeup, and a foreground event resets the ladder
(supervisor.ts lines 700–745). Foregrounding probes an established session before replacing it;
a long mobile suspension forces replacement "because the OS can kill a socket without reporting
closure" (connection-runtime.md). Involuntary disconnect keeps the registration and cached
projections; explicit removal clears credentials and drafts. Durable subscriptions follow the
replacement session; "Reconnection does not automatically replay mutations, whose retry and
idempotency rules belong to the operation" (connection-runtime.md). On the server side,
commands carry a **command receipt** so re-dispatch after a reconnect is idempotent
(glossary.md, overview.md "Durable intent and side effects").

**Credential expiry does not close the socket.** "RPC sessions authenticate at socket upgrade,
while HTTP requests need current credentials … Credential expiry does not close the socket, and
refresh failure belongs to the HTTP operation" (connection-runtime.md). The connections list
keeps an expired-but-connected session visible so it can still be revoked. Release notes for
v0.0.39 record the two fixes that made this true for T3 Connect: "refresh relay credentials
before expiry" (#9178) and "refresh authorization without disconnecting" (#9582)
([v0.0.39](https://github.com/pingdotgg/t3code/releases/tag/v0.0.39)).

## Login and pairing

There are two identities and the docs are emphatic that they must not merge.

**Environment access (every route).** The environment issues scoped sessions:
`orchestration:read`, `orchestration:operate`, `terminal:operate`, `review:write`,
`access:read`, `access:write`, `relay:read`, `relay:write`
([packages/contracts/src/auth.ts](https://github.com/pingdotgg/t3code/blob/e16b8b059c9f5ff6dfed1addecffb831c6aee043/packages/contracts/src/auth.ts)
lines 81–98). Pairing delegates scopes; an exchange can narrow a grant, never widen it;
creating a further pairing link needs `access:write` plus every scope being delegated
(environment-auth.md). Pairing links are 12 characters from a 32-symbol alphabet with
rejection sampling, one-time-token TTL 5 minutes, desktop-bootstrap and dev-startup grants 24 h
([apps/server/src/auth/PairingGrantStore.ts](https://github.com/pingdotgg/t3code/blob/e16b8b059c9f5ff6dfed1addecffb831c6aee043/apps/server/src/auth/PairingGrantStore.ts)
lines 239–285). The grant is exchanged at the environment's `POST /oauth/token` with an OAuth
token-exchange `grant_type` (environmentHttp.ts line 433; remote.ts lines 98–131) for a session
token; sessions can be bearer, cookie, or DPoP-bound. Sessions are revocable per client and
"revoke others" exists (`/api/auth/clients/revoke`, `/revoke-others`, environmentHttp.ts lines
471–486). Only the creation response ever returns the raw pairing secret; the access read model
never does (environment-auth.md; v0.0.39 #9523). The hosted web app carries the pairing secret
in the URL **fragment** so it never reaches the hosting origin
([apps/web/src/hostedPairing.ts](https://github.com/pingdotgg/t3code/blob/e16b8b059c9f5ff6dfed1addecffb831c6aee043/apps/web/src/hostedPairing.ts);
remote.md).

**Cloud identity (T3 Connect only).** Clerk. The relay accepts either a Clerk session JWT from
the `t3-relay` template with `aud: "t3-code-relay"`, or a CLI OAuth access token from a public
PKCE client with no secret; both are traded at `/v1/client/dpop-token` for a relay DPoP token
with a 30-minute TTL
([infra/relay/src/auth/RelayTokens.ts](https://github.com/pingdotgg/t3code/blob/e16b8b059c9f5ff6dfed1addecffb831c6aee043/infra/relay/src/auth/RelayTokens.ts)
line 29;
[docs/operations/connect-setup.md](https://github.com/pingdotgg/t3code/blob/e16b8b059c9f5ff6dfed1addecffb831c6aee043/docs/operations/connect-setup.md)).
DPoP proofs are replay-guarded with a 5-minute window (`DpopProofs.ts` line 132) and a
`time_window` failure code so clients can distinguish clock skew from delay
(relay-observability.md). The headless CLI uses a pasted-code flow through the hosted
`app.t3.codes/connect` page because "the browser cannot ordinarily reach a listener on the
remote machine"; the loopback callback is `http://127.0.0.1:34338/callback` with a 10-minute
wait (t3-connect.md; connect-setup.md;
[apps/server/src/cloud/CliTokenManager.ts](https://github.com/pingdotgg/t3code/blob/e16b8b059c9f5ff6dfed1addecffb831c6aee043/apps/server/src/cloud/CliTokenManager.ts)
line 43). Sign-up restriction is a Clerk allowlist or invitation-only mode; an "enabled empty
allowlist blocks all new sign-ups" (connect-setup.md).

**Bridging the two: the brokered connect.** The client `POST`s
`/v1/environments/:id/connect` with its relay DPoP token. The relay checks the user's link,
then itself calls the environment's `POST /api/t3-connect/mint-credential` over the tunnel
`httpBaseUrl` with a relay-signed proof naming the environment, the user, the operation and the
client's DPoP key thumbprint
([infra/relay/src/environments/EnvironmentConnector.ts](https://github.com/pingdotgg/t3code/blob/e16b8b059c9f5ff6dfed1addecffb831c6aee043/infra/relay/src/environments/EnvironmentConnector.ts)
lines 298, 467, 623; environmentHttp.ts line 610). The environment checks that proof's lifetime,
scope, nonce and JTI against a replay guard, then creates a pairing link with
`ttl: Duration.minutes(2)`, subject `cloud-connect`, the standard client scopes
(`orchestration:read`, `orchestration:operate`, `terminal:operate`, `review:write`,
`relay:read`) and the client's proof-key thumbprint bound in
([apps/server/src/cloud/http.ts](https://github.com/pingdotgg/t3code/blob/e16b8b059c9f5ff6dfed1addecffb831c6aee043/apps/server/src/cloud/http.ts)).
A brokered connect therefore never carries `access:write` or `relay:write`: the administrative
scopes stay with whoever paired the machine directly. The environment returns that one-time
bootstrap credential and a signed response bound to the request nonce and that thumbprint; the relay
verifies the binding (EnvironmentConnector.ts lines 218–241) and hands the credential to the
client, which redeems it directly at the environment's `/oauth/token`. "The relay never
receives that session token, and possessing the bootstrap credential alone does not permit
redeeming it without the client's private key" (t3-connect.md). The doc names the residual trust:
"The relay holds the signing authority for mint requests … it does not make a compromised relay
signing key harmless." Health and mint requests set `redirect: "manual"` and reject forwarded
authority headers so the relay cannot be used as an egress proxy (EnvironmentConnector.ts line
189; t3-connect.md).

## What is unknown or unverified

- What the `t3_relay` provider kind is for (see above).
- Whether `POST /v1/environments/:id/status` polls the environment live or reads the allocation
  record. The user doc says `t3 connect status` "is not a live reachability check", which is a
  different command; not traced further.
- The exact WebSocket ping/keepalive interval, if any. I found none in `supervisor.ts` or
  `session.ts`; liveness appears to come from the 15 s probe on foreground and socket-close
  events rather than an application-level heartbeat. Treat as "none found", not "none exists".
- Release notes are per-PR changelogs; the first stable tag that shipped T3 Connect end to end
  is not stated. The rename PR is in v0.0.27 and the relay's baseline migration is dated
  2026-05-27, which brackets it between v0.0.24 (2026-05-15) and v0.0.27 (2026-06-09).

## What this means for Phoebe's relay

Phoebe's relay ([#497](https://github.com/JesusFilm/phoebe/issues/497)) is a self-hosted
container that deployments dial out to, behind Google login, with the config file as source of
truth and the relay carrying status and config edits. T3 Code's relay is a different animal: a
hosted control plane that never sees application traffic, with Cloudflare Tunnel doing the
dial-out. So "modelled on T3 Code" has to be read piecewise.

**Transfers.**

- _The environment dials out and never listens publicly._ T3's server binds loopback and
  `cloudflared` makes the outbound connection; Phoebe's bootstrapper holding one outbound
  connection is the same shape with the tunnel and the relay collapsed into one container. #469's
  "no inbound listener" stands.
- _One connection per environment, one retry owner._ The supervisor design (single owner of
  retry policy; single attempts inside it; a short capped ladder; wait-for-wakeup on
  auth failure instead of spinning) is directly reusable for the bootstrapper's side, and the
  `cloudflared` restart policy (1 s → 60 s, reset after 30 s stable) is a ready answer for #500.
- _Identity independent of route, link independent of process._ T3 keeps a stable environment
  ID across restarts and endpoint changes, and lets a link be recorded while the server is down,
  with startup reconciling intent. Phoebe's deployment registration (#505) should do the same:
  registration is a record on the relay plus a file-side identity, and boot reconciles.
- _Cloud identity is not deployment authority._ Even with a single Google allowlist and no roles,
  keep "who may talk to the relay" (Google) separate from "what this deployment will accept
  from the relay" (a per-deployment key the deployment generated). T3's Ed25519 environment key
  and signed link proof is the pattern; it is what lets the relay be a broker rather than a root.
- _Signed, nonce-bound requests into the deployment._ The mint exchange (relay-signed proof,
  environment-signed response bound to the nonce) is exactly the shape a config edit from the
  console needs on #503: the deployment must be able to verify the edit came from its relay for
  its identity, and the console must be able to verify the deployment applied it.
- _Credential renewal without dropping the connection._ T3 learned this the hard way (two fixes
  in v0.0.39). Design the relay session so token refresh is an HTTP-side concern and the
  outbound socket outlives it.
- _Idempotent commands with receipts._ T3 does not replay mutations on reconnect; it makes each
  command carry a receipt so a client can safely re-send. Config edits over Phoebe's relay
  should carry an edit ID the deployment records before writing the file.
- _Restricting sign-up by allowlist with an empty allowlist meaning "nobody"._ Same semantics as
  #497's self-bootstrapping allowlist.

**Does not transfer.**

- _The relay as pure control plane._ T3 can keep the relay out of the data path because
  Cloudflare carries the bytes and the client can reach the environment's public hostname
  directly. Phoebe's relay has no Cloudflare behind it and its deployments have no public
  hostname, so the relay _is_ the data path: it must terminate the deployment's outbound
  connection and serve the console from what arrives on it. That makes #506 closer to
  `cloudflared` plus the T3 relay merged than to the T3 relay alone.
- _Clerk, DPoP, the OAuth token-exchange vocabulary, and a Postgres-backed Worker._ All sized for
  a public multi-tenant service with mobile push. A single-operator relay behind Google login
  (#499) needs an allowlist and a signed per-deployment key, not a second token system.
- _Client-side reconnect semantics._ T3's supervisor lives in the client because the client
  reconnects to the environment. In Phoebe the console reads the relay, which is always up; the
  reconnecting party is the deployment. Borrow the policy, not the placement.
- _Push notifications, Live Activities, managed-tunnel quotas, SSH launch, Tailscale._ Out of
  scope for #497 and each is either a hosted-product concern or a different route entirely.
- _Session TTLs._ 30-day environment sessions and 5-minute socket tickets are tuned for a phone
  that opens and closes an app. A deployment holding a permanent outbound connection wants a
  long-lived key and short-lived per-message signatures, not a session that expires.
