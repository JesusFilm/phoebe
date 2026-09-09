# Outbound-only persistent connections from a Node 24 deployment to a relay

Research for [#500](https://github.com/JesusFilm/phoebe/issues/500) on the relay map
([#497](https://github.com/JesusFilm/phoebe/issues/497)), read 2026-09-09. Sources are the
Node 24 API docs (v24.21.0, the version this repo runs), RFC 6455 and RFC 8441, the WHATWG
WebSocket and HTML (Server-Sent Events) specs, the gRPC project's own design docs and guides,
and the READMEs and `package.json` of `ws`, `@grpc/grpc-js` and undici. Every claim cites the
thing that owns it. Where I had to infer, the section "What I could not verify" says so.

The map wants a deployment with no inbound port to dial a relay, hold the connection, push
status snapshots, doctor reports and effective config up, and accept the occasional config edit
and write-only secret back down. The channel is low volume: a message every few seconds at
most, usually far less. This note compares WebSocket, SSE plus POST, and gRPC bidirectional
streams on that job, and ends with one pick.

## The short answers

- **WebSocket, with the built-in Node 24 client and `ws` on the relay.** The client is in
  Node core and stable; the server is not in core and needs one library. `ws` has no
  runtime dependencies. That is the whole dependency set.
- **None of the three reconnects for you in Node.** The WebSocket API has no reconnect;
  `EventSource` does but is experimental and flag-gated in Node 24; gRPC reconnects the
  *channel* but not the *stream*, and a broken bidi stream is the application's to reopen.
  A small reconnect loop is unavoidable, so pick the transport that makes the loop simplest.
- **Heartbeat has to come from the relay side.** The built-in client answers pings but cannot
  send them, and exposes no ping event. The relay pings; the client watches for any inbound
  traffic and treats silence as death.
- **Ordering is a property of the single TCP connection, not the transport.** All three
  deliver in order within one connection. None survive a reconnect without an
  application-level sequence number. SSE's `Last-Event-ID` is the only built-in resume
  cursor, and it only covers one direction.
- **Proxies favour anything that looks like HTTPS on 443.** WebSocket over TLS and SSE over
  TLS both pass through a CONNECT tunnel unchanged. gRPC needs HTTP/2 end to end and
  detects incompatible proxies via `te: trailers`, which is a failure mode, not a fallback.
- **gRPC is the wrong shape for this.** It brings a proto toolchain and two dependencies for a
  channel carrying a dozen JSON message types, and its retry policy explicitly does not
  cover a stream once the first response byte has arrived.

## What Node 24 ships, and what it does not

**A WebSocket client, stable, no flag.** The `WebSocket` global was added in v21.0.0/v20.10.0,
unflagged in v22.0.0 and marked no longer experimental in v22.4.0
([globals.html#class-websocket](https://nodejs.org/docs/latest-v24.x/api/globals.html#class-websocket)).
It is undici's implementation, which "follows the WHATWG WebSocket specification and RFC 6455"
([undici WebSocket](https://github.com/nodejs/undici/blob/main/docs/docs/api/WebSocket.md)).

**No WebSocket server.** Nothing in the `http`, `net` or global docs constructs one. What core
gives the server side is the `http.Server` `'upgrade'` event, whose contract is that once you
listen for it "future communication must handled directly through the raw socket"
([http.html#event-upgrade_1](https://nodejs.org/docs/latest-v24.x/api/http.html#event-upgrade_1)).
Framing, masking, the `Sec-WebSocket-Accept` hash and control frames are then yours. That is
what `ws` is for.

**An `EventSource` client, experimental, flagged.** Added in v22.3.0/v20.18.0, Stability 1,
and only present with `--experimental-eventsource`
([globals.html#class-eventsource](https://nodejs.org/docs/latest-v24.x/api/globals.html#class-eventsource),
[cli.html#--experimental-eventsource](https://nodejs.org/docs/latest-v24.x/api/cli.html#--experimental-eventsource)).
Without the flag, consuming SSE means `fetch()` and hand-parsing the body stream.

**A full HTTP/2 client and server.** `http2.connect()` opens a client session;
`http2.createServer()`/`createSecureServer()` the server side. `Http2Stream` extends
`stream.Duplex`, so one stream is bidirectional without any library
([http2.html](https://nodejs.org/docs/latest-v24.x/api/http2.html)). Sessions have a native
liveness probe, `http2session.ping([payload,] callback)`, which reports the round-trip
duration and errors on timeout
([http2.html#http2sessionpingpayload-callback](https://nodejs.org/docs/latest-v24.x/api/http2.html#http2sessionpingpayload-callback)),
and an idle timer, `http2session.setTimeout(msecs, callback)`
([http2.html#http2sessionsettimeoutmsecs-callback](https://nodejs.org/docs/latest-v24.x/api/http2.html#http2sessionsettimeoutmsecs-callback)).
This is the substrate `@grpc/grpc-js` sits on, and it is also a zero-dependency fourth
option, which I come back to under the recommendation.

**Environment proxy support, for the `http`/`https` global agent.** `NODE_USE_ENV_PROXY=1`
(v24.0.0) and `--use-env-proxy` (v24.5.0) make "the global agent" honour `HTTP_PROXY`,
`HTTPS_PROXY` and `NO_PROXY`
([http.html#built-in-proxy-support](https://nodejs.org/docs/latest-v24.x/api/http.html#built-in-proxy-support),
[cli.html#--use-env-proxy](https://nodejs.org/docs/latest-v24.x/api/cli.html#--use-env-proxy)).
The docs describe this in terms of the `http` agent; they do not say whether the WebSocket
global or `http2` inherit it. See "What I could not verify".

## Reconnect and backoff

**WebSocket.** Neither the protocol nor the API reconnects. RFC 6455 §7.2.3 puts the burden
on the client and specifies the shape: "The first reconnect attempt SHOULD be delayed by a
random amount of time … a value chosen randomly between 0 and 5 seconds is a reasonable
initial delay", and "subsequent reconnect attempts SHOULD be delayed by increasingly longer
amounts of time, using a method such as truncated binary exponential backoff"
([RFC 6455 §7.2.3](https://www.rfc-editor.org/rfc/rfc6455.html#section-7.2.3)). The WHATWG
API surface is `open`/`message`/`error`/`close` and `readyState`
([WHATWG §3.1](https://websockets.spec.whatwg.org/#the-websocket-interface)); the
undici doc adds that a `WebSocket` "cannot be reused once it has been closed"
([undici WebSocket](https://github.com/nodejs/undici/blob/main/docs/docs/api/WebSocket.md)),
so reconnect means constructing a new one on `close`.

**SSE.** The one transport with reconnect in the spec. On a dropped connection the user agent
waits the reconnection time and reestablishes; the server sets that time with the `retry:`
field, and "if the previous attempt failed, then user agents might introduce an exponential
backoff delay"
([HTML §9.2.5](https://html.spec.whatwg.org/multipage/server-sent-events.html#reestablish-the-connection)).
On reconnect the client sends `Last-Event-ID` carrying the last `id:` field it saw
([HTML §9.2.3](https://html.spec.whatwg.org/multipage/server-sent-events.html#the-last-event-id-header)),
so a relay that keeps a short replay buffer can fill the gap. In Node this only applies with
the experimental flag on; a `fetch()`-based reader gets none of it.

**gRPC.** Two separate mechanisms, and it matters which one you are relying on. The *channel*
backs off per the connection-backoff spec: `INITIAL_BACKOFF` 1 s, `MULTIPLIER` 1.6,
`MAX_BACKOFF` 120 s, `JITTER` 0.2, reset when "the SETTINGS frame is received"
([connection-backoff.md](https://github.com/grpc/grpc/blob/master/doc/connection-backoff.md)).
`@grpc/grpc-js` exposes this as `grpc.initial_reconnect_backoff_ms` and
`grpc.max_reconnect_backoff_ms`
([grpc-js README](https://github.com/grpc/grpc-node/blob/master/packages/grpc-js/README.md)).
But an *RPC* is retried only under a service-config retry policy, and for a stream "Once the
response header is received, the RPC is committed. No further retries will be attempted, and
gRPC hands over the RPC to the application"
([grpc.io retry guide](https://grpc.io/docs/guides/retry/)). A long-lived bidi stream is
committed the moment the relay sends anything, so when it breaks, the application opens a new
one. The reconnect loop does not go away; it moves up a layer.

**The repo already has the shape of the loop.** `src/backoff.ts` is `withBackoffSync`: a
schedule array, an `isRetryable` predicate, and an `onRetry` hook so "the caller owns the log
line". It is deliberately synchronous because the engine's `gh`/git seams block on
`execFileSync`. A relay client is event-driven and cannot block the loop, so it cannot call
`withBackoffSync`, but the design carries over unchanged: a `scheduleMs` array with jitter
applied at the call site, `onRetry(error, delayMs, retry)` for the log line, and a reset to
the head of the schedule once the connection has been open for longer than the largest delay
(the gRPC rule of "reset on SETTINGS" translated). One thing to add that `backoff.ts` does not
have, because its callers are finite: no terminal attempt. The relay client retries forever
at the capped delay.

## Heartbeat and dead-peer detection

The problem is the same on all three: TCP does not tell you a peer is gone until you try to
write and the retransmit timer expires, and a NAT or proxy that dropped the mapping tells you
nothing at all. Something has to send bytes periodically, and something has to notice when the
reply stops.

**WebSocket.** The protocol has Ping and Pong control frames. "Upon receipt of a Ping frame,
an endpoint MUST send a Pong frame in response"; "A Ping frame may serve either as a keepalive
or as a means to verify that the remote endpoint is still responsive"
([RFC 6455 §5.5.2](https://www.rfc-editor.org/rfc/rfc6455.html#section-5.5.2)); and "A Pong
frame MAY be sent unsolicited. This serves as a unidirectional heartbeat"
([§5.5.3](https://www.rfc-editor.org/rfc/rfc6455.html#section-5.5.3)). The WHATWG API does
not expose them: "These are not currently exposed in the API"
([WHATWG §5](https://websockets.spec.whatwg.org/#ping-and-pong-frames)). Node's client
matches that. Its receiver answers a Ping with a Pong automatically
([undici `receiver.js`](https://github.com/nodejs/undici/blob/main/lib/web/websocket/receiver.js)),
the global emits only `open`/`message`/`error`/`close`, and undici's `ping()` helper is an
export of the `undici` package, not of Node core. So the client can neither send a ping nor
see one arrive.

The server side has both. `ws` exposes `websocket.ping()`, `websocket.pong()` and `'ping'`/
`'pong'` events ([ws.md](https://github.com/websockets/ws/blob/master/doc/ws.md)). The
working arrangement is therefore: the relay pings every N seconds and terminates a socket
whose pong does not come back within the timeout; the client sets a timer on every inbound
event of any kind and closes and reconnects when it fires. The deployment cannot see the
relay's pings, so the relay also has to send *something* the application layer can see. A
tiny `{"type":"hb"}` message every N seconds costs nothing at this volume and gives the client
its liveness signal. That makes the relay's WebSocket-level ping redundant for the client, but
it is still the relay's own dead-peer detector, and it comes free with `ws`.

**SSE.** Downstream, the spec's own advice: "authors can include a comment line (one starting
with a ':' character) every 15 seconds or so" because "Legacy proxy servers are known to, in
certain cases, drop HTTP connections after a short timeout"
([HTML §9.2.7](https://html.spec.whatwg.org/multipage/server-sent-events.html#authoring-notes)).
The client detects death by the same inbound-silence timer. Upstream there is nothing to
detect: each POST is its own request with its own outcome.

**gRPC.** HTTP/2 PING frames, configured per channel: `GRPC_ARG_KEEPALIVE_TIME_MS` (client
default `INT_MAX`, off), `GRPC_ARG_KEEPALIVE_TIMEOUT_MS` (20 s), and
`GRPC_ARG_KEEPALIVE_PERMIT_WITHOUT_CALLS` (0) ([keepalive.md](https://github.com/grpc/grpc/blob/master/doc/keepalive.md)).
The server side polices it: `GRPC_ARG_HTTP2_MIN_RECV_PING_INTERVAL_WITHOUT_DATA_MS` defaults
to five minutes, and a client that pings faster gets a `GOAWAY` with `too_many_pings`
([keepalive.md](https://github.com/grpc/grpc/blob/master/doc/keepalive.md)). The guide is
blunt that "it is recommended to avoid enabling keepalive without calls and for clients to
avoid configuring their keepalive much below one minute"
([grpc.io keepalive guide](https://grpc.io/docs/guides/keepalive/)). Since we own both ends,
the policing is a knob rather than a hazard, but it is a knob that must agree on both sides
or the client is silently disconnected.

**TCP keepalive underneath any of them.** `socket.setKeepAlive(true, initialDelay)` sets
`SO_KEEPALIVE`, `TCP_KEEPIDLE`, `TCP_KEEPINTVL` (default 1 s) and `TCP_KEEPCNT` (default 10)
([net.html#socketsetkeepaliveenable-initialdelay](https://nodejs.org/docs/latest-v24.x/api/net.html#socketsetkeepaliveenable-initialdelay)).
It keeps a NAT mapping warm but is invisible to a proxy that terminates TCP, which is why every
transport above also has an in-band heartbeat. `socket.setTimeout()` is only an idle
notification: "the connection will not be severed. The user must manually call `socket.end()`
or `socket.destroy()`"
([net.html#socketsettimeouttimeout-callback](https://nodejs.org/docs/latest-v24.x/api/net.html#socketsettimeouttimeout-callback)).

## Message ordering and delivery

**Within one connection, all three are ordered.** WebSocket: "Message fragments MUST be
delivered to the recipient in the order sent by the sender"
([RFC 6455 §5.4](https://www.rfc-editor.org/rfc/rfc6455.html#section-5.4)), and there is
one TCP connection per WebSocket. SSE: one response body, read sequentially. gRPC: one HTTP/2
stream, and "DATA frame boundaries have no relation to Length-Prefixed-Message boundaries"
but the messages within the stream are sequential
([PROTOCOL-HTTP2.md](https://github.com/grpc/grpc/blob/master/doc/PROTOCOL-HTTP2.md)).

**Across a reconnect, none of them are.** A message handed to `send()` and sitting in
`bufferedAmount` ("queued using send() but … not yet transmitted to the network",
[WHATWG §3.1](https://websockets.spec.whatwg.org/#dom-websocket-bufferedamount)) is lost
when the socket dies, and the sender does not learn which. gRPC's transparent retry covers
only an RPC that "never leaves the client" or reaches the server library but was "never seen
by the server application logic" ([grpc.io retry guide](https://grpc.io/docs/guides/retry/)),
which does not describe a mid-stream loss. SSE's `Last-Event-ID` is the one resume cursor in
any of the specs, and it is downstream only.

**SSE plus POST is the odd one out upstream.** Each POST is an independent HTTP request. Two
in flight at once can arrive in either order, and one that fails has no relation to the next.
A client wanting order must serialise its own POSTs, which for a config-edit ack or a secret
write is exactly the kind of thing you would rather not get subtly wrong.

**What the channel actually needs.** Status snapshots and effective config are idempotent:
the latest wins and a lost one is superseded by the next. Doctor reports are the same.
Config edits and write-only secrets coming down are the only messages where "did it arrive"
matters, and for those the right tool is an application-level id and an ack, not a transport
guarantee. Every transport here needs that ack layer equally; none removes it. Reuse the
convention `src/slot-client.ts` already has: string message types under a `phoebe:` prefix
(`phoebe:slot:acquire`, `phoebe:slot:granted`), a pending FIFO settled by the reply, and
rejecting every pending promise on disconnect rather than leaving it hanging. That last
point is the one the slot client documents at length, and it transfers verbatim: a config
edit awaiting an ack when the socket drops must fail loudly, not stall.

## Proxy and NAT friendliness

The deployment is the dialler, so NAT is not a problem for any of them; what matters is what
sits between it and the relay.

**WebSocket.** Designed for this. The handshake is "interpreted by HTTP servers as an Upgrade
request" and defaults to "port 443 for WebSocket connections tunneled over Transport Layer
Security"; the RFC notes that at the time "connections on ports 80 and 443 have
significantly different success rates, with connections on port 443 being significantly more
likely to succeed" ([RFC 6455 §1.7, §1.8](https://www.rfc-editor.org/rfc/rfc6455.html#section-1.7)).
Through an explicit proxy, "the client SHOULD connect to that proxy and ask it to open a TCP
connection to the host", the CONNECT method
([§4.1](https://www.rfc-editor.org/rfc/rfc6455.html#section-4.1)). undici's client takes a
`dispatcher` in the `WebSocketInit` object and documents routing through a `ProxyAgent` that
way ([undici WebSocket](https://github.com/nodejs/undici/blob/main/docs/docs/api/WebSocket.md)).
RFC 8441 extends this to HTTP/2 by adding a `:protocol` pseudo-header to CONNECT and a
`SETTINGS_ENABLE_CONNECT_PROTOCOL` setting so "one TCP connection [can] be shared by both
protocols" ([RFC 8441 §1, §3, §4](https://www.rfc-editor.org/rfc/rfc8441.html)). undici
marks its RFC 8441 support experimental and gates it on `allowH2` ([undici
WebSocket](https://github.com/nodejs/undici/blob/main/docs/docs/api/WebSocket.md)). For a
deployment holding one connection, HTTP/1.1 upgrade is the right default and RFC 8441 is
irrelevant.

**SSE.** Plain HTTPS. The friendliest of the three by construction: a GET whose response
never ends. The hazard is buffering proxies and the idle-drop the spec's comment-line advice
exists for. The `Content-Type` must be exactly `text/event-stream` or the client fails the
connection ([HTML §9.2.2](https://html.spec.whatwg.org/multipage/server-sent-events.html#sse-processing-model)).

**gRPC.** HTTP/2 end to end. The wire spec requires `content-type: application/grpc`, and
`te: trailers` is sent "to detect incompatible proxies"
([PROTOCOL-HTTP2.md](https://github.com/grpc/grpc/blob/master/doc/PROTOCOL-HTTP2.md)),
because status arrives in HTTP trailers and an HTTP/1.1 hop drops them. Through a CONNECT
tunnel with TLS this is fine; through anything that terminates and re-originates HTTP it is
not. That is a real class of corporate egress. The keepalive policing above also means a
ping interval that works in one environment can trip `too_many_pings` after an intermediary
starts coalescing.

## What a Node 24 client and a Node server need with no framework

| | Client (deployment, Node 24) | Server (relay, Node) | Runtime deps |
| --- | --- | --- | --- |
| WebSocket | `new WebSocket(url)` global; stable, no flag; auto-pongs; no ping API, no reconnect | `http.createServer` + `'upgrade'` handed to `ws`'s `WebSocketServer({ noServer: true }).handleUpgrade`; `ws.ping()` and `'pong'` for liveness | `ws` (server only; `bufferutil` and `utf-8-validate` are optional peers, [package.json](https://github.com/websockets/ws/blob/master/package.json)) |
| SSE + POST | Downstream: `EventSource` behind `--experimental-eventsource`, or `fetch()` and a hand-written `text/event-stream` parser. Upstream: `fetch()` POST per message, serialised by the client | `http.createServer`; one handler writes `text/event-stream` and holds the response open with `response.write`; another handler reads POST bodies | none |
| gRPC bidi | `@grpc/grpc-js` client; a `.proto` loaded with `@grpc/proto-loader`, or a hand-written service definition with your own serializers | `@grpc/grpc-js` `Server` on Node `http2` | `@grpc/grpc-js` (pulls `@grpc/proto-loader` and `@js-sdsl/ordered-map`, [package.json](https://github.com/grpc/grpc-node/blob/master/packages/grpc-js/package.json)); `grpc-js` "does not directly handle `.proto` files" ([README](https://github.com/grpc/grpc-node/blob/master/packages/grpc-js/README.md)) |
| Raw HTTP/2 stream | `http2.connect` + one `client.request()` held open; `session.ping` for liveness | `http2.createSecureServer` + `'stream'` | none |

The raw HTTP/2 row is there because it is the zero-dependency bidirectional option Node core
actually has. It loses on proxies for the same reason gRPC does, and it means inventing a
framing for messages on the stream, which `ws` and the WebSocket message boundary give for
free.

## What this means for the relay

The volume rules out caring about throughput, framing overhead or compression. What is left
is operational: how many moving parts sit between "socket died" and "connection is back and
the pending config edit has been reported as failed", and how often a customer's egress breaks
the transport for reasons we cannot see.

On both, WebSocket is the smallest thing that works. The client is in core and needs no
flag. The reconnect loop is ours to write on all three transports anyway, and WebSocket's
version is the shortest: on `close`, wait the next scheduled delay with jitter, construct a
new `WebSocket`, re-send the current snapshot. Liveness is a relay-side `ws.ping()` plus an
application heartbeat message, and a client timer on inbound silence. Ordering within a
connection is guaranteed, ordering across one is handled by the ack layer the slot client
already models, and the `phoebe:`-prefixed message types can carry straight over.

SSE plus POST would be the pick if the client side had to be a browser or if the relay had to
be a plain CDN-fronted HTTP endpoint. It is not, and paying for the flagged `EventSource`
or a hand-written parser, plus serialising POSTs, buys nothing here.

gRPC would be the pick if the messages were many, typed, and shared with other languages, or
if the stream carried enough that HTTP/2 flow control mattered. They are a dozen JSON shapes
between two Node processes we own.

## Recommendation

**WebSocket over TLS on 443, HTTP/1.1 upgrade.**

Dependency set:

- Deployment (client): none. `WebSocket` global, Node 24.
- Relay (server): `ws`. No runtime dependencies; leave its optional native peers uninstalled.

Conventions to carry over:

- `src/backoff.ts`'s `scheduleMs` + `isRetryable` + `onRetry` shape, made async, with jitter
  per RFC 6455 §7.2.3, no terminal attempt, and reset-to-head after a stable open.
- `src/slot-client.ts`'s `phoebe:`-prefixed message types, pending FIFO settled by reply, and
  reject-all-pending on disconnect.
- Relay-initiated liveness: `ws.ping()` with a pong deadline, plus a visible heartbeat
  message, since the built-in client cannot see pings.
- Application-level ids and acks for the two downstream message kinds that must not be lost
  (config edits, write-only secrets); everything upstream is latest-wins.

## What I could not verify

- Whether `NODE_USE_ENV_PROXY=1` routes the `WebSocket` global through the proxy. The Node
  docs describe it in terms of "the global agent" of `http`; undici's `WebSocket` defaults to
  "the global dispatcher". Whether Node wires the one to the other is not stated in either
  place. If a customer needs an explicit egress proxy, test it, and be ready to fall back to
  reading `HTTPS_PROXY` and opening the CONNECT tunnel by hand on a `net.Socket` handed to a
  custom dispatcher.
- Whether Node's built-in `WebSocket` accepts the `WebSocketInit` object form (`dispatcher`,
  `headers`). undici documents it as "an undici extension and is not available in browsers";
  Node's page says only "browser-compatible". The `headers` option matters for sending a
  bearer token on the handshake instead of in the URL.
- Whether Node's `http2` client honours `--use-env-proxy` at all. The `http` doc does not
  mention `http2`. This only matters if the raw-HTTP/2 or gRPC options are revisited.
