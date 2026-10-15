# tailscaled's LocalAPI over a socket shared from the sidecar

Research for [#692](https://github.com/JesusFilm/phoebe/issues/692) on the Tailscale remote-access
map ([#690](https://github.com/JesusFilm/phoebe/issues/690)), read 2026-10-15 from the
[tailscale/tailscale](https://github.com/tailscale/tailscale) source at commit
`9a522a9786c97eb7910c01ccb7bd66557b04c910` (`9a522a9`, the commit behind tag `v1.104.1`,
released 2026-10-07) and from Tailscale's KB. The image `tailscale/tailscale:v1.104.1` reports
itself as `1.104.1-t9a522a978`, so image and source match. Every claim cites the file that owns it.
"Verified live" means I ran it here with Docker 29.8.1: the sidecar as `docker run -e
TS_USERSPACE=true -e TS_SOCKET=/var/run/tailscale/tailscaled.sock -v sock:/var/run/tailscale
tailscale/tailscale:v1.104.1`, the probe as `node:24-alpine` with `--user 10001:10001
--network container:<sidecar>` and the same volume mounted read-only, calling
`http.request({ socketPath, path, headers: { Host: 'local-tailscaled.sock' } })`.

The question was whether the bootstrapper, uid 10001 in a container sharing its network namespace
with a `tailscale/tailscale` sidecar, can read what it needs from tailscaled's LocalAPI over a shared
Unix socket with nothing beyond `node:http`. Yes, with two constants to get right: the socket has
to sit in a directory the second container can traverse, and the request has to carry
`Host: local-tailscaled.sock`. A root-run sidecar gives a non-root reader read access only.

## The short answers

1. **Socket.** containerboot defaults `TS_SOCKET` to `/tmp/tailscaled.sock`, then symlinks
   `/var/run/tailscale/tailscaled.sock` to it inside a directory it creates `0700`. The socket is
   `0666`, owned by whoever runs tailscaled (root, by default). A second container can mount the
   directory, even read-only, and connect as a non-root user.
2. **Status call.** `GET /localapi/v0/status?peers=false` returns `ipnstate.Status`, the struct
   `tailscale status --json` prints: `Self.DNSName` (trailing dot) and `CertDomains[0]` (none).
   No token, only `Host: local-tailscaled.sock` and no `Origin` or `Referer`. Non-root callers are
   read-only, which covers status and `GET serve-config`.
3. **Serve in userspace.** Works. `TS_USERSPACE` defaults to true and netstack intercepts inbound
   TCP to the node's own address on any Serve port. `/dev/net/tun` and `net_admin` are for
   subnet routes, exit nodes and the L3 proxy modes.
4. **Identity headers.** Injected by the same proxy code in both modes, keyed on the tailnet source
   address, so the sidecar layout changes nothing. Incoming copies of the five identity headers and
   `Tailscale-App-Capabilities` are deleted. Tagged sources and Funnel carry no identity.
5. **`${TS_CERT_DOMAIN}`.** A byte-level `ReplaceAll` with `CertDomains[0]`, re-read on directory
   change, posted to `serve-config`. The certificate is issued on the first TLS handshake naming
   the domain, not at config time. `TS_ENABLE_HEALTH_CHECK` exposes an unauthenticated `/healthz`
   on `TS_LOCAL_ADDR_PORT` (default `[::]:9002`), 200 once the node has a tailnet IP, 503 before.
6. **Auth key.** A tagged key, reusable or an OAuth client secret with `?ephemeral=false`, plus
   `TS_STATE_DIR` on a volume and `TS_AUTH_ONCE=true`. Tagging turns off node-key expiry and moves
   the node from a user's identity to `tagOwners` in the ACL.

## 1. The socket: path, owner, mode, and who may connect

containerboot reads `TS_SOCKET` and falls back to `/tmp/tailscaled.sock`
([cmd/containerboot/settings.go#L125](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/cmd/containerboot/settings.go#L125)),
passes it to `tailscaled --socket=`
([cmd/containerboot/tailscaled.go#L70](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/cmd/containerboot/tailscaled.go#L70)),
and, once tailscaled is up and only when the path is not already the default, runs
`os.MkdirAll("/var/run/tailscale", 0700)` and symlinks the default path to the real socket so the
bundled CLI works without `--socket`
([cmd/containerboot/main.go#L558-L573](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/cmd/containerboot/main.go#L558-L573)).
The KB says the default is `/var/run/tailscale/tailscaled.sock`
([docker-params](https://tailscale.com/docs/features/containers/docker/docker-params)); that is the
symlink, not the socket. Verified live with no `TS_SOCKET` set: `/tmp/tailscaled.sock` is
`root:root 0666`, `/var/run/tailscale` is `root:root 0700`, and the symlink inside points at `/tmp`.
That `0700` directory is the trap in the default layout: a non-root reader cannot traverse it. Set
`TS_SOCKET` to a path inside a directory you control and mount that directory.

The mode comes from `safesocket`. On Linux `PlatformUsesPeerCreds()` is true, so
`socketPermissionsForOS()` returns `0666`; the listener chmods the socket after `net.Listen` and
creates a missing parent directory `0755`
([safesocket/unixsocket.go#L24-L72](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/safesocket/unixsocket.go#L24-L72),
[#L81-L87](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/safesocket/unixsocket.go#L81-L87),
[safesocket/safesocket.go#L146-L161](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/safesocket/safesocket.go#L146-L161)).
Verified live with `TS_SOCKET=/var/run/tailscale/tailscaled.sock` on a named volume: `root:root
0666` in a `root:root 0755` directory.

The published image is built by `mkctr` from `tailscale/alpine-base:3.22` with no `USER`
([build_docker.sh#L55-L75](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/build_docker.sh#L55-L75),
[Dockerfile.base](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/Dockerfile.base)),
and `docker image inspect` confirms an empty user, so tailscaled runs as root unless Compose says
otherwise. The repo's Kubernetes example runs the userspace sidecar as `runAsUser: 1000`
([docs/k8s/userspace-sidecar.yaml#L14-L22](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/docs/k8s/userspace-sidecar.yaml#L14-L22)),
the README's reason being "reducing the amount of permissions Tailscale needs"
([docs/k8s/README.md#L60-L62](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/docs/k8s/README.md#L60-L62)).
Verified live: `--user 10001:10001` with `TS_USERSPACE=true` boots cleanly once the socket
directory is chowned to that uid; a fresh Docker volume is root `0755` and the bind fails otherwise.

What a uid may do is decided per request, not by file mode. `ipnserver` builds an actor from
`SO_PEERCRED` for every connection
([ipn/ipnauth/ipnauth_unix_creds.go#L19-L33](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/ipn/ipnauth/ipnauth_unix_creds.go#L19-L33),
[ipn/ipnserver/server.go#L535-L538](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/ipn/ipnserver/server.go#L535-L538)),
then sets `PermitRead, PermitWrite = true, !IsReadonlyConn(operatorUID)` for Unix-socket callers
([ipn/ipnserver/server.go#L336-L354](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/ipn/ipnserver/server.go#L336-L354)).
`IsReadonlyConn` grants write to uid 0, to the daemon's own non-root uid, to the configured
operator, and to a platform admin group; on Linux that last branch errors with "no system admin
group found", so everyone else is read-only
([ipn/ipnauth/ipnauth.go#L166-L225](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/ipn/ipnauth/ipnauth.go#L166-L225)).
Both branches verified live: uid 10001 against a root daemon gets 200 on status and
`GET serve-config`, 403 on `POST serve-config` and `cert/`; against a uid-10001 daemon both writes
pass the permission check (then fail 500 because the node is not logged in). A narrower hatch
exists for certificates: `TS_PERMIT_CERT_UID=<uid>` in the daemon's environment grants that uid
`cert/` without write
([ipn/ipnserver/server.go#L380-L402](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/ipn/ipnserver/server.go#L380-L402)).

## 2. The status call and what a Unix-socket caller must send

`/localapi/v0/status` routes to `serveStatus`, which needs `PermitRead`, honours `?peers=false`,
and writes `ipnstate.Status` as JSON
([ipn/localapi/localapi.go#L94](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/ipn/localapi/localapi.go#L94),
[#L844-L858](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/ipn/localapi/localapi.go#L844-L858)).
The Go client's `Status` hits that path
([client/local/local.go#L789-L810](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/client/local/local.go#L789-L810))
and `tailscale status --json` is `json.MarshalIndent` of the result
([cmd/tailscale/cli/status.go#L80-L96](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/cmd/tailscale/cli/status.go#L80-L96)).

The fields that matter, from
[ipn/ipnstate/ipnstate.go#L32-L76](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/ipn/ipnstate/ipnstate.go#L32-L76)
and [#L238-L246](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/ipn/ipnstate/ipnstate.go#L238-L246):

- `BackendState`, one of `NoState`, `NeedsLogin`, `NeedsMachineAuth`, `Stopped`, `Starting`,
  `Running`. Wait for `Running` before trusting anything else.
- `TUN`, false in userspace mode.
- `Self.DNSName`, "the Peer's FQDN. It ends with a dot. It has the form `host.<MagicDNSSuffix>.`".
- `CertDomains`, "FQDNs without trailing periods", copied from the netmap's `DNS.CertDomains`
  ([ipn/ipnlocal/local.go#L1514-L1516](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/ipn/ipnlocal/local.go#L1514-L1516)).
  containerboot takes `${TS_CERT_DOMAIN}` from the same list, so `[0]` is the exact name Serve
  answers on. Empty until HTTPS is enabled on the tailnet.
- `CurrentTailnet.MagicDNSSuffix` and `.Name`; top-level `MagicDNSSuffix` is the deprecated alias.

Verified live before login: `NeedsLogin`, `TUN: false`, empty `Self.DNSName`, null `CertDomains`.

The request itself. `Handler.ServeHTTP` rejects any request carrying a `Referer`, an `Origin`, or
a `Host` other than empty or `local-tailscaled.sock`
([ipn/localapi/localapi.go#L249-L253](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/ipn/localapi/localapi.go#L249-L253),
[#L285-L293](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/ipn/localapi/localapi.go#L285-L293),
[client/tailscale/apitype/apitype.go#L14](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/client/tailscale/apitype/apitype.go#L14)).
`node:http` fills `Host` from the socket path unless told otherwise, and that gets 403 "invalid
localapi request" (verified live; `Host: localhost` is refused too). Pass the header. Nothing else
is needed: the basic-auth branch only fires when `RequiredPassword` is set, the macOS sandbox case,
and `safesocket.LocalTCPPortAndToken` returns `ErrNoTokenOnOS` on Linux, so the Go client sends no
credential either
([ipn/localapi/localapi.go#L258-L270](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/ipn/localapi/localapi.go#L258-L270),
[safesocket/safesocket.go#L128-L143](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/safesocket/safesocket.go#L128-L143),
[client/local/local.go#L169-L183](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/client/local/local.go#L169-L183)).
The response carries `Tailscale-Version`, a free version probe.

`serve-config` is `GET` under `PermitRead` and `POST` under `PermitWrite` with an `If-Match` etag
([ipn/localapi/serve.go#L25-L72](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/ipn/localapi/serve.go#L25-L72)),
so the read-only bootstrapper can confirm what Serve is doing but not change it. That is the map's
split anyway: containerboot owns the config file, the bootstrapper reads.

## 3. Serve under `TS_USERSPACE=true`

`TS_USERSPACE` defaults to true
([cmd/containerboot/settings.go#L111](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/cmd/containerboot/settings.go#L111);
KB "Enabled by default", [docker-params](https://tailscale.com/docs/features/containers/docker/docker-params)).
containerboot then adds `--tun=userspace-networking` and skips creating `/dev/net/tun`
([cmd/containerboot/tailscaled.go#L84-L88](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/cmd/containerboot/tailscaled.go#L84-L88),
[cmd/containerboot/main.go#L427-L430](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/cmd/containerboot/main.go#L427-L430));
the validator only refuses the L3 proxy modes in userspace mode, not `TS_SERVE_CONFIG`
([cmd/containerboot/settings.go#L259-L270](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/cmd/containerboot/settings.go#L259-L270)).

Serve does not need the kernel. In netstack mode `shouldProcessInbound` claims inbound TCP to the
node's own IP on any port `ShouldInterceptTCPPort` reports, and Serve registers its ports there
([wgengine/netstack/netstack.go#L1253-L1280](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/wgengine/netstack/netstack.go#L1253-L1280),
[ipn/ipnlocal/local.go#L8345-L8350](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/ipn/ipnlocal/local.go#L8345-L8350)).
The host-level listeners Serve opens in TUN mode are skipped with "don't listen on netmap addresses
if we're in userspace mode"; their type doc says "Most serve traffic and peer traffic for the web
client are intercepted by netstack" and the kernel listener exists "purely for connections from
the machine itself"
([ipn/ipnlocal/serve.go#L107-L115](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/ipn/ipnlocal/serve.go#L107-L115),
[#L283-L286](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/ipn/ipnlocal/serve.go#L283-L286)).

The KB calls `net_admin` "required when using kernel networking"
([connect-docker-container](https://tailscale.com/docs/features/containers/docker/how-to/connect-docker-container)).
The first-party examples do run Serve sidecars with `TS_USERSPACE=false` and `/dev/net/tun`
([04-ts-mealie/compose.yaml](https://github.com/tailscale-dev/docker-guide-code-examples/blob/5334a1878cc9272f8db0ca8355eaba44973603a5/04-ts-mealie/compose.yaml)),
but those apps want outbound tailnet access too, which userspace mode only gives through a SOCKS or
HTTP proxy ([docs/k8s/README.md#L62](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/docs/k8s/README.md#L62)).
Phoebe only needs inbound.

## 4. Identity headers in userspace mode and in the sidecar pattern

The reverse proxy's `Rewrite` hook calls `addProxyForwardedHeaders`, `addTailscaleIdentityHeaders`
and `addAppCapabilitiesHeader` in that order
([ipn/ipnlocal/serve.go#L995-L1000](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/ipn/ipnlocal/serve.go#L995-L1000)).
`addTailscaleIdentityHeaders` deletes `Tailscale-User-Login`, `Tailscale-User-Name`,
`Tailscale-User-Profile-Pic`, `Tailscale-Funnel-Request` and `Tailscale-Headers-Info` from the
outgoing request, then runs `WhoIs` on the tailnet source address. No match, no headers. A tagged
source, no headers ("Not setting identity headers for tagged nodes"). Otherwise it sets login,
display name, profile picture and `Tailscale-Headers-Info`; a Funnel request gets
`Tailscale-Funnel-Request: ?1` instead
([ipn/ipnlocal/serve.go#L1098-L1127](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/ipn/ipnlocal/serve.go#L1098-L1127)).
Non-ASCII names are RFC 2047 Q-encoded
([#L1129-L1142](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/ipn/ipnlocal/serve.go#L1129-L1142)),
and `addAppCapabilitiesHeader` strips an incoming `Tailscale-App-Capabilities` the same way
([#L1144-L1146](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/ipn/ipnlocal/serve.go#L1144-L1146)).
The KB agrees: Serve removes the three user headers from incoming requests "to avoid header
spoofing", and "These identity headers are not populated for traffic originating from tagged
devices"; Funnel traffic has none ([kb/1312/serve](https://tailscale.com/kb/1312/serve)).

None of that branches on TUN versus netstack; the connection reaches the proxy through
`TCPHandlerForDst` either way and the source address is the WireGuard peer's. The backend at
`http://127.0.0.1:<port>` in the shared namespace is the far side of the proxy, never consulted for
identity. The deployment being tagged is irrelevant; what matters is whether the device opening the
browser is. A laptop or phone is not, so the console sees `Tailscale-User-Login`; a tagged CI node
gets nothing, and the pairing token has to carry identity on its own.

## 5. `${TS_CERT_DOMAIN}`, certificate timing, and the health endpoint

containerboot's main loop watches the IPN bus; on every netmap it takes `CertDomains[0]`,
substitutes the sentinel `kubetypes.ValueNoHTTPS` when the list is empty, and signals a change
([cmd/containerboot/main.go#L228-L244](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/cmd/containerboot/main.go#L228-L244),
[#L934-L947](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/cmd/containerboot/main.go#L934-L947)).
`watchServeConfigChanges` starts once and re-reads the file on that signal, on an fsnotify event
for the file's directory, or every 5 seconds without inotify
([cmd/containerboot/main.go#L1005-L1008](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/cmd/containerboot/main.go#L1005-L1008),
[cmd/containerboot/serve.go#L35-L56](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/cmd/containerboot/serve.go#L35-L56)).
Hence the KB's rule to mount the config "as a directory (not an individual file)".
`readServeConfig` is a `bytes.ReplaceAll` of the literal `${TS_CERT_DOMAIN}` then `json.Unmarshal`
([cmd/containerboot/serve.go#L175-L199](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/cmd/containerboot/serve.go#L175-L199)).
Any `HTTPS: true` port while the domain is still the sentinel logs a pointer to the enabling-HTTPS
KB and applies nothing
([#L144-L161](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/cmd/containerboot/serve.go#L144-L161));
otherwise the config is POSTed as the daemon's own uid. The JSON is `TCP[port].HTTPS`,
`Web["host:port"].Handlers["/"].Proxy` and `AllowFunnel["host:port"]`
([ipn/serve.go#L53-L68](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/ipn/serve.go#L53-L68),
[#L124-L173](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/ipn/serve.go#L124-L173));
the first-party example is
[04-ts-mealie/config/mealie.json](https://github.com/tailscale-dev/docker-guide-code-examples/blob/5334a1878cc9272f8db0ca8355eaba44973603a5/04-ts-mealie/config/mealie.json).

The certificate is not fetched when the config lands. Serve's `GetCertificate` callback refuses a
hello without SNI, checks a web handler exists for that name and port, then calls `GetCertPEM`
with a one-minute timeout
([ipn/ipnlocal/serve.go#L1361-L1385](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/ipn/ipnlocal/serve.go#L1361-L1385)).
That lands in `feature/acme`, which orders from Let's Encrypt and raises the health warnable
"Fetching TLS certificate" during initial issuance or after an expired cache
([feature/acme/acme.go#L198-L213](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/feature/acme/acme.go#L198-L213),
[#L277-L286](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/feature/acme/acme.go#L277-L286)).
So the first HTTPS request on a fresh state directory blocks on a DNS-01 order, and the KB warns
that repeated requests hit Let's Encrypt rate limits
([kb/1153/enabling-https](https://tailscale.com/kb/1153/enabling-https)). containerboot's only
pre-warm is the Kubernetes cert-share mode, gated on `TS_EXPERIMENTAL_CERT_SHARE` and `POD_NAME`
([cmd/containerboot/settings.go#L164-L170](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/cmd/containerboot/settings.go#L164-L170)).
Outside Kubernetes, `docker exec <sidecar> tailscale cert <domain>` after first login is the
pre-warm, and the cert lives in `TS_STATE_DIR` across restarts.

`TS_ENABLE_HEALTH_CHECK=true` serves `GET /healthz` on `TS_LOCAL_ADDR_PORT`, default `[::]:9002`
([cmd/containerboot/settings.go#L133-L135](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/cmd/containerboot/settings.go#L133-L135),
[cmd/containerboot/main.go#L525-L545](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/cmd/containerboot/main.go#L525-L545)).
The handler writes `ok` when the node has at least one tailnet IP and 503 "node currently has no
tailscale IPs" otherwise, driven by `SelfChange` notifications
([kube/health/healthz.go](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/kube/health/healthz.go)).
The KB calls it "unauthenticated". Verified live: 503 before login. `[::]` binds every interface in
the shared namespace, so set `TS_LOCAL_ADDR_PORT=127.0.0.1:9002` and use it as a Compose
`healthcheck`, not a listener on the bridge.

## 6. Which auth key

The auth-key KB lists reusable, one-off, ephemeral, pre-approved and tagged keys, with key expiry
1 to 90 days (default 90); "shared devices, such as servers, should use a tagged auth key to
connect", and ephemeral is for "containers or Lambda functions" that come and go
([kb/1085/auth-keys](https://tailscale.com/kb/1085/auth-keys)). A Phoebe deployment is the
long-lived server case. An OAuth client secret works directly as the key with
`?ephemeral=false&preauthorized=true`, needs the `auth_keys` scope, and the node must advertise one
of the client's tags ([kb/1215/oauth-clients](https://tailscale.com/kb/1215/oauth-clients)); the
first-party examples do exactly that with `TS_AUTHKEY=tskey-client-...?ephemeral=false` and
`TS_EXTRA_ARGS=--advertise-tags=tag:container`. containerboot also takes `TS_CLIENT_ID` and
`TS_CLIENT_SECRET`, mutually exclusive with `TS_AUTHKEY`
([cmd/containerboot/settings.go#L97-L99](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/cmd/containerboot/settings.go#L97-L99),
[#L315-L317](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/cmd/containerboot/settings.go#L315-L317)).

Tagging does two things. Node-key expiry is "disabled by default" for tagged devices, so no
periodic re-login ([kb/1068/tags](https://tailscale.com/kb/1068/tags)). And the device stops being
the owner's: "a device cannot have both a tag and a user identity", the tag is defined under
`tagOwners`, and ACL rules target the tag. Right shape for a server, and what makes the console's
`Tailscale-User-Login` meaningful.

One containerboot default bites long-lived nodes. `TS_AUTH_ONCE` is false, which runs
`tailscale up --authkey` on every start
([cmd/containerboot/settings.go#L126](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/cmd/containerboot/settings.go#L126),
[#L429-L440](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/cmd/containerboot/settings.go#L429-L440));
a one-off key breaks the first restart and a reusable one stops working when the key expires at 90
days. Set `TS_AUTH_ONCE=true`, keep `TS_STATE_DIR` on a volume (the KB: without it "your container
will appear as a new node each time"), and the key is needed once.

## What this means for the scaffold

The sidecar runs as root with `TS_USERSPACE` at its default, `TS_SOCKET` inside a named volume the
bootstrapper mounts read-only, `TS_SERVE_CONFIG` in a mounted directory, `TS_AUTH_ONCE=true`,
`TS_STATE_DIR` on a volume, and a tagged non-ephemeral key. The bootstrapper polls
`GET /localapi/v0/status?peers=false` with `Host: local-tailscaled.sock`, waits for
`BackendState == "Running"`, and reads `Self.DNSName` (strip the dot) and `CertDomains[0]`. It never
needs write access. If a later ticket wants the bootstrapper to own the serve config, the lever is
`user: 10001` on the sidecar plus a chowned socket volume, also verified live.

## What is unverified

- Serve and the identity headers were not exercised end to end in userspace mode; that needs a
  logged-in node. Those claims rest on the netstack and proxy code and the KB, not on a request I
  made.
- `SO_PEERCRED` across two containers reports the kernel uid. With `userns-remap` or a rootless
  daemon both containers would have to map uid 10001 the same way; not tested.
- Certificate renewal cadence inside `feature/acme`; the KB says Let's Encrypt certificates last
  90 days.
