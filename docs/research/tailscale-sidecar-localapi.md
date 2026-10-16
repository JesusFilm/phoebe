# Reading tailscaled's LocalAPI from the bootstrapper over a shared socket

Research for [Research: tailscaled LocalAPI over a socket shared from the sidecar](https://github.com/JesusFilm/phoebe/issues/692)
on the map [Remote access over Tailscale: the deployment API and direct pairing](https://github.com/JesusFilm/phoebe/issues/690).
Read on 2026-10-15 from the [tailscale/tailscale](https://github.com/tailscale/tailscale) source at tag
`v1.104.1`, commit [`9a522a9`](https://github.com/tailscale/tailscale/tree/9a522a9786c97eb7910c01ccb7bd66557b04c910)
(the newest stable tag that day), and from Tailscale's KB. Source links below are pinned to that commit.

I also ran the official static `tailscaled` 1.104.1 build (`pkgs.tailscale.com/stable/tailscale_1.104.1_amd64.tgz`,
sha256 `108d1d96…4528`, checked against the published sum) as uid 10001 with `--tun=userspace-networking --state=mem:`
and probed its socket from Node 24's `node:http`. It never logged in, so that run shows socket mode, the request
guards and the JSON shape, and nothing that needs a tailnet. Results are marked "observed".

## The short answers

- **Yes, with one header.** A uid-10001 process can connect to the sidecar's socket and read
  `GET /localapi/v0/status?peers=false` using `node:http` and nothing else. There is no token on Linux. But
  LocalAPI rejects any `Host` other than `local-tailscaled.sock`, and `node:http` sends `Host: localhost` over
  a `socketPath` unless told otherwise. Pass `host: 'local-tailscaled.sock'`, or the call gets a 403.
- **The socket is world-connectable, read-only for us.** `tailscaled` creates it mode `0666` on Linux and
  authorizes each connection by peer credentials. Any Unix-socket peer gets read. Write needs root, the
  daemon's own uid, the configured operator, or a sudoer. The sidecar's `tailscaled` runs as root, so uid
  10001 is read-only.
- **The default socket path is `/tmp/tailscaled.sock`, not what the docs say.** Set `TS_SOCKET` explicitly and
  put its directory on a volume both containers mount.
- **Serve works in the default userspace mode.** No `/dev/net/tun`, no `NET_ADMIN`.
- **Identity headers are injected in userspace mode too, and spoofed copies are stripped**, but only on
  requests that come through Serve. In userspace mode, a tailnet peer that connects to the node's 100.x
  address on a port Serve doesn't handle is forwarded to `127.0.0.1:<port>`. So a backend listening on
  loopback in the shared network namespace can be reached directly, with no TLS and no header stripping.
  Tailscale's own advice ("listen only on localhost") does not hold in the sidecar pattern. Serve can proxy
  to a `unix:` socket instead, which closes that path.
- **`${TS_CERT_DOMAIN}` is a plain string replace** with the first entry of the netmap's `CertDomains`,
  re-applied whenever that changes or the file's directory changes. With HTTPS disabled it becomes
  `no-https`, and a config with an HTTPS endpoint is skipped with only a log line.
- **The certificate is fetched as soon as the node is Running with an HTTPS Serve entry**, then checked
  hourly, plus lazily on the first TLS handshake if it is still missing.
- **`TS_ENABLE_HEALTH_CHECK` exposes an unauthenticated `GET /healthz`** on `[::]:9002` that returns 200 once
  the node has a tailnet IP, else 503. Nothing more.
- **Auth key: tagged, non-ephemeral, and pre-approved if device approval is on.** The KB recommends tagged
  keys for servers. Tagging turns off node key expiry, and the device's identity becomes its tags. The KB's
  "containers should use ephemeral keys" line fits short-lived workloads, not a deployment that has to keep
  its name.

## 1. The socket: path, owner, mode, and a second container

### Path and `TS_SOCKET`

containerboot defaults the socket to `/tmp/tailscaled.sock` unless `TS_SOCKET` is set
([settings.go#L125](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/cmd/containerboot/settings.go#L125)).
It passes that path to `tailscaled` as `--socket=`, waits for the file to appear, and then talks to it with
`UseSocketOnly: true`
([tailscaled.go#L44-L69](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/cmd/containerboot/tailscaled.go#L44-L69)).
The package comment documents the variable without a default
([main.go#L58-L59](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/cmd/containerboot/main.go#L58-L59)).
`main` has the same `/tmp/tailscaled.sock` default (checked 2026-10-15).

The KB's [Docker configuration parameters](https://tailscale.com/docs/features/containers/docker/docker-params)
page says `TS_SOCKET` "Defaults to `/var/run/tailscale/tailscaled.sock`". That is the CLI's default path on
Linux, not containerboot's, so the page is wrong for the image. Don't rely on either default. Set
`TS_SOCKET=/var/run/tailscale/tailscaled.sock` (or any path) and mount a volume at that directory in both
containers.

### Owner and mode

The image is built with `mkctr` on `tailscale/alpine-base:3.22`, with `containerboot` as entrypoint and no
user set ([build_docker.sh#L48-L69](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/build_docker.sh#L48-L69),
[Dockerfile.base](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/Dockerfile.base)),
so `containerboot` and the `tailscaled` it spawns run as root. The socket is owned by root.

`safesocket.listen` removes a stale socket file, creates the parent directory `0755` if it is missing, listens,
then `chmod`s the socket to `socketPermissionsForOS()`
([unixsocket.go#L24-L71](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/safesocket/unixsocket.go#L24-L71)).
That is `0666` wherever the platform authenticates by peer credentials, otherwise `0600`
([unixsocket.go#L85-L91](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/safesocket/unixsocket.go#L85-L91)).
Linux uses peer credentials
([safesocket.go#L144-L161](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/safesocket/safesocket.go#L144-L161)).
Because the mode is set by `chmod` after `listen`, the umask doesn't affect it. Observed: `srw-rw-rw-` in a
freshly created `drwxr-xr-x` directory.

### Can uid 10001 in another container connect?

Yes. The kernel needs two things:

- Search permission on each directory in the path, which `0755` gives everyone.
- Write permission on the socket inode: `unix_find_bsd` calls `path_permission(&path, MAY_WRITE)`
  ([af_unix.c#L1084, v6.6](https://github.com/torvalds/linux/blob/v6.6/net/unix/af_unix.c#L1084)), and `0666`
  grants it.

A read-only mount (`:ro`) doesn't block it. The read-only check in `sb_permission` only refuses writes to
regular files, directories and symlinks
([namei.c#L480-L490, v6.6](https://github.com/torvalds/linux/blob/v6.6/fs/namei.c#L480-L490)), so the
bootstrapper can mount the socket directory `:ro`. I could not test this here (`unshare` is not permitted in
this sandbox). It comes from the kernel source alone.

Unverified: I expect a fresh Docker named volume mounted at a path that doesn't exist in the image to come up
`root:root 0755`. If it came up tighter, `tailscaled` would not loosen an existing directory. It only `chmod`s
a directory it just created. Check the mode on the first real deployment.

### What the bootstrapper is allowed to do

The server builds a LocalAPI handler per request and sets `PermitRead, PermitWrite = actor.Permissions(...)`
([ipnserver/server.go#L217-L222](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/ipn/ipnserver/server.go#L217-L222)).
On Linux any Unix-socket connection gets read, and write unless the connection is read-only
([server.go#L336-L354](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/ipn/ipnserver/server.go#L336-L354)).
A connection gets write if its uid is 0, matches the daemon's own non-root uid, is the configured operator, or
passes a `sudo` check. Everything else is read-only
([ipnauth.go#L166-L206](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/ipn/ipnauth/ipnauth.go#L166-L206)).
Cert fetching needs write, or a uid named in `TS_PERMIT_CERT_UID`
([server.go#L390-L401](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/ipn/ipnserver/server.go#L390-L401),
[localapi/cert.go#L24-L28](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/ipn/localapi/cert.go#L24-L28)).

So uid 10001 can read `status`, `whois` and the serve config (`GET serve-config` needs read, `POST` needs write,
[localapi/serve.go#L25-L60](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/ipn/localapi/serve.go#L25-L60)).
It cannot change prefs or Serve, and it cannot pull the TLS key.

One consequence for Phoebe: every tenant engine and the agent share uid 10001 (`src/tenant-commands.ts`, the
model-A note). Whatever the bootstrapper can read over this socket, an agent process can read too, if the
socket directory is mounted into the same container. That means the tailnet's peer list with names and IPs
(`status` with peers), and `whois` for any address. It is read-only, but it should go into `docs/trust.md`
beside the inbound-listener reversal the map already flags. `?peers=false` keeps the bootstrapper's own call
narrow. It doesn't stop anyone else from asking for more.

## 2. The status call: what to send and what comes back

### The call

`tailscale status --json` calls `localClient.Status` (or `StatusWithoutPeers`) and prints the result with
`json.MarshalIndent`
([cli/status.go#L80-L96](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/cmd/tailscale/cli/status.go#L80-L96)).
The client methods are `GET /localapi/v0/status` and `GET /localapi/v0/status?peers=false`, both marked
"considered a stable API"
([client/local/local.go#L786-L811](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/client/local/local.go#L786-L811)).
The handler needs only `PermitRead`
([localapi.go#L844-L859](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/ipn/localapi/localapi.go#L844-L859)).

### Headers and tokens

Before routing, LocalAPI refuses any request that carries a `Referer` or `Origin`, or whose `Host` is not valid
([localapi.go#L249-L253](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/ipn/localapi/localapi.go#L249-L253)).
Without a configured password, the only valid hosts are the empty string and `local-tailscaled.sock`
([localapi.go#L284-L306](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/ipn/localapi/localapi.go#L284-L306),
[apitype.go#L14](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/client/tailscale/apitype/apitype.go#L14)).
The Basic-auth token path only applies to the macOS GUI's TCP transport
([local.go#L119-L133, L169-L184](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/client/local/local.go#L169-L184)).
On a Linux Unix socket there is no token. The Go client also sends `Tailscale-Cap`, and the server doesn't
require it.

Observed, against the real daemon from `node:http`:

| Request                                             | Result                                                             |
| --------------------------------------------------- | ------------------------------------------------------------------ |
| `http.get({ socketPath, path })` (Host `localhost`) | `403 invalid localapi request`                                     |
| `host: 'local-tailscaled.sock'`                     | `200`, the status JSON                                             |
| same, plus an `Origin` header                       | `403 invalid localapi request`                                     |
| `setHost: false` (no Host at all)                   | `400 Bad Request: missing required Host header` (Go's HTTP server) |

So the whole client is:

```js
import http from "node:http";

function tailscaleStatus(socketPath) {
  return new Promise((resolve, reject) => {
    http
      .get(
        { socketPath, host: "local-tailscaled.sock", path: "/localapi/v0/status?peers=false" },
        (res) => {
          let body = "";
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () =>
            res.statusCode === 200
              ? resolve(JSON.parse(body))
              : reject(new Error(`LocalAPI ${res.statusCode}: ${body}`)),
          );
        },
      )
      .on("error", reject);
  });
}
```

### Response shape

`ipnstate.Status`
([ipnstate.go#L32-L91](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/ipn/ipnstate/ipnstate.go#L32-L91)).
These are the fields the deployment needs:

| Field                           | Meaning                                                                                                                                                                                                                                                   |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BackendState`                  | `"NoState"`, `"NeedsLogin"`, `"NeedsMachineAuth"`, `"Stopped"`, `"Starting"`, `"Running"`. Read nothing else until `"Running"`.                                                                                                                           |
| `Self.DNSName`                  | The node's FQDN, "ends with a dot" ([L244-L246](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/ipn/ipnstate/ipnstate.go#L244-L246)). Strip it.                                                                      |
| `CertDomains`                   | "the set of DNS names for which the control plane server will assist with provisioning TLS certificates", FQDNs without trailing dots. Empty or null when HTTPS is off for the tailnet.                                                                   |
| `CurrentTailnet.MagicDNSSuffix` | e.g. `tail1234.ts.net`. `CurrentTailnet` is null when not connected ([L172-L191](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/ipn/ipnstate/ipnstate.go#L172-L191)). The top-level `MagicDNSSuffix` is deprecated. |
| `TUN`                           | `false` in userspace mode.                                                                                                                                                                                                                                |
| `Self.TailscaleIPs`, `Health`   | Addresses, and health warnings as strings.                                                                                                                                                                                                                |

Observed before login: `BackendState: "NeedsLogin"`, `Self.DNSName: ""`, `CertDomains: null`,
`CurrentTailnet: null`. The bootstrapper should treat an empty name as "not yet" and keep polling. Better, it
can stream `GET /localapi/v0/watch-ipn-bus`, which also needs only read. `CertDomains[0]` is the name to put in
a pairing URL, because it is the name the certificate covers. `Self.DNSName` minus its dot is normally the same
string, and it is the only name available when HTTPS is off.

The CLI marks `--json` "format subject to change"
([cli/status.go#L51](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/cmd/tailscale/cli/status.go#L51)),
but the LocalAPI `Status` method is the one marked stable. That is the one this design reads.

## 3. Serve in userspace mode

`TS_USERSPACE` defaults to true
([settings.go#L111](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/cmd/containerboot/settings.go#L111)).
In that mode containerboot passes `--tun=userspace-networking`. Only kernel mode calls `ensureTunFile`
([tailscaled.go#L84-L88](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/cmd/containerboot/tailscaled.go#L84-L88)).
The KB says kernel networking "requires `/dev/net/tun` and additional capabilities"
([docker-params](https://tailscale.com/docs/features/containers/docker/docker-params)). Userspace needs neither.

Serve works there because netstack handles every inbound TCP flow to the node's own IPs when it runs alone
(`ns.ProcessLocalIPs = onlyNetstack`,
[cmd/tailscaled/netstack.go#L41](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/cmd/tailscaled/netstack.go#L41)).
`acceptTCP` asks the backend for a handler first
([netstack.go#L1710-L1719](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/wgengine/netstack/netstack.go#L1710-L1719)),
and `TCPHandlerForDst` returns the Serve handler for a served port
([ipnlocal/netstack.go#L67-L71](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/ipn/ipnlocal/netstack.go#L67-L71)).
None of the containerboot options that refuse userspace mode (`TS_DEST_IP`, `TS_TAILNET_TARGET_*`, and so on)
involve Serve
([settings.go#L259-L272](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/cmd/containerboot/settings.go#L259-L272)).

### The loopback bypass

When no handler claims the flow and the destination is the node's own Tailscale IP, netstack rewrites the dial
target to `127.0.0.1:<same port>` and proxies the connection there
([netstack.go#L1736-L1781](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/wgengine/netstack/netstack.go#L1736-L1781)).
Tailscale added explicit RSTs for the quad-100 and VIP-service cases because of exactly this, "forwardTCP'ing
the connection onto whatever random service happens to be listening on the host's loopback". A plain
node IP has no such guard.

In the sidecar pattern the bootstrapper shares that loopback. A listener on `127.0.0.1:8080` is therefore
reachable at `http://<node-100.x>:8080` by any peer the tailnet policy lets reach that port. That traffic is
plain HTTP, and identity headers pass through unstripped.

There are two ways to close this:

- **Serve to a Unix socket.** `HTTPHandler.Proxy` and `TCPForward` accept `unix:/path`
  ([ipn/serve.go#L144-L150](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/ipn/serve.go#L144-L150),
  [L776-L790](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/ipn/serve.go#L776-L790)),
  and the reverse proxy dials the socket with `Host: localhost`
  ([ipnlocal/serve.go#L883-L905, L992-L997](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/ipn/ipnlocal/serve.go#L883-L905)).
  Setting a config that serves a Unix target needs a local admin, which is root on Linux
  ([localapi/serve.go#L80-L109](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/ipn/localapi/serve.go#L80-L109)).
  containerboot is root, so `TS_SERVE_CONFIG` can do it. Serve refuses to proxy to the tailscaled socket itself.
  The listener has nothing for netstack to forward to, and only processes that can see the shared directory
  can reach it.
- **Authenticate everything regardless.** The map already requires a paired token on every request. That holds
  over the bypass, but the token then travels over plain HTTP inside WireGuard, and `Tailscale-User-*` headers
  can't be trusted unless the app can tell the request came through Serve.

If it stays on TCP, there is a way to identify the peer anyway. netstack registers the loopback source
`ip:port` of each forwarded connection against the real peer IP
([netstack.go#L1829-L1835](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/wgengine/netstack/netstack.go#L1829-L1835)),
and `WhoIs` consults that map
([ipnlocal/local.go#L1734-L1778](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/ipn/ipnlocal/local.go#L1734-L1778)).
So `GET /localapi/v0/whois?addr=127.0.0.1:<remotePort>` names the peer on a bypassed connection. A request
that came through Serve also arrives from 127.0.0.1, so the address alone doesn't say which path it took. I
didn't trace whether Serve's own backend dial is registered the same way. Treat that as open.

The same forwarding exposes `TS_LOCAL_ADDR_PORT` (`[::]:9002`) to the tailnet when health or metrics are on.

## 4. Identity headers

Serve's reverse proxy calls `addTailscaleIdentityHeaders` on every proxied request
([ipnlocal/serve.go#L976-L1000](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/ipn/ipnlocal/serve.go#L976-L1000)).
That function first deletes `Tailscale-User-Login`, `-Name`, `-Profile-Pic`, `Tailscale-Funnel-Request` and
`Tailscale-Headers-Info` from the outgoing request, whatever the client sent
([ipnlocal/serve.go#L1098-L1104](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/ipn/ipnlocal/serve.go#L1098-L1104)).
Then it sets them from `WhoIs` on the connection's tailnet source address. It leaves them unset for Funnel
traffic and for unknown sources. It also leaves them unset when the source node is tagged: "Not setting identity
headers for tagged nodes"
([L1106-L1127](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/ipn/ipnlocal/serve.go#L1106-L1127)).
Non-ASCII values are RFC 2047 Q-encoded. `Tailscale-App-Capabilities` follows the same delete-then-set pattern
([L1144-L1146](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/ipn/ipnlocal/serve.go#L1144-L1146)).
The KB's [Serve page](https://tailscale.com/kb/1312/serve) says the same: headers are stripped from incoming
requests, tagged devices don't get them, and shared-in users do.

The tag check applies to the client that connects, not to the serving node. Tagging the deployment's own
sidecar doesn't stop a person's phone from getting headers. A tagged machine calling the deployment gets
none.

Nothing in that code depends on the networking mode. In userspace mode the Serve handler gets the real tailnet
source, because netstack hands it the flow (section 3). The sidecar pattern changes nothing as long as the
request arrives through Serve. The gap is the bypass, not header injection.

## 5. `TS_SERVE_CONFIG`, `${TS_CERT_DOMAIN}`, certificates and health

### Substitution

`readServeConfig` reads the whole file and does `bytes.ReplaceAll(j, "${TS_CERT_DOMAIN}", certDomain)` before
JSON-decoding it into `ipn.ServeConfig`. A missing or empty file is skipped
([containerboot/serve.go#L177-L196](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/cmd/containerboot/serve.go#L177-L196)).
`certDomain` is the first entry of the netmap's `DNS.CertDomains`, or `no-https` when there is none
([main.go#L934-L948](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/cmd/containerboot/main.go#L934-L948),
[kubetypes/types.go#L52](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/kube/kubetypes/types.go#L52),
source of `certDomains`: [main.go#L236, L244](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/cmd/containerboot/main.go#L236)).

With `no-https` and any `TCP` entry marked `HTTPS`, `updateServeConfig` logs a warning and returns nil without
applying anything
([containerboot/serve.go#L144-L161](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/cmd/containerboot/serve.go#L144-L161)).
The container stays up and serves nothing. Status still shows `Running`, and only the empty `CertDomains` hints
at the cause. The bootstrapper's doctor check should look for exactly that.

### When it is applied

The watcher starts once the node has its first netmap with addresses
([main.go#L1004-L1008](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/cmd/containerboot/main.go#L1004-L1008)).
It re-reads and re-applies the file when the cert domain changes, on any fsnotify event in the file's
directory, or every 5 s if fsnotify is unavailable. It skips the apply when the parsed config deep-equals the
previous one
([containerboot/serve.go#L35-L110](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/cmd/containerboot/serve.go#L35-L110)).
It watches the directory, which is why the KB says to bind-mount the directory, not the file
([docker-params](https://tailscale.com/docs/features/containers/docker/docker-params)).
A read or parse error is `log.Fatalf`. A malformed serve config kills the sidecar.

### Certificate provisioning

In this release `tailscaled` provisions proactively. The ACME extension runs a refresh loop whenever the
backend is `Running` and the serve config has an HTTPS entry. "The first iteration runs immediately so that a
node coming back online with stale or absent certs starts ACME within seconds", and then it runs every hour
([feature/acme/refresh.go#L21-L76](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/feature/acme/refresh.go#L21-L76)).
On top of that, the TLS `GetCertificate` hook fetches on the first handshake for a configured name, with a
one-minute timeout
([ipnlocal/serve.go#L1361-L1386](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/ipn/ipnlocal/serve.go#L1361-L1386)).
I didn't trace which release introduced the refresh loop. Older sidecars may only fetch lazily, which makes
the first HTTPS request slow.

Certs are cached under `<TS_STATE_DIR>/certs`, mode `0700`
([feature/acme/certstore.go#L61-L104](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/feature/acme/certstore.go#L61-L104)).
Without `TS_STATE_DIR`, containerboot uses `--state=mem: --statedir=/tmp`
([tailscaled.go#L69-L82](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/cmd/containerboot/tailscaled.go#L69-L82)),
so every restart is a new node and a new certificate. The [HTTPS KB](https://tailscale.com/kb/1153/enabling-https)
warns that frequent requests hit Let's Encrypt rate limits. It also warns that every issued name lands in the
public Certificate Transparency log. The scaffold should persist `TS_STATE_DIR` and choose `TS_HOSTNAME` with
the CT log in mind. HTTPS also needs MagicDNS and "Enable HTTPS" turned on in the admin console (same page).

### `TS_ENABLE_HEALTH_CHECK`

When true, containerboot registers `GET /healthz` on `TS_LOCAL_ADDR_PORT`, default `[::]:9002`
([settings.go#L133-L135](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/cmd/containerboot/settings.go#L133-L135),
[main.go#L513-L535](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/cmd/containerboot/main.go#L513-L535)).
It answers `200 ok` while the node has at least one tailnet IP, otherwise `503 node currently has no tailscale IPs`
([kube/health/healthz.go#L33-L52](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/kube/health/healthz.go#L33-L52),
updated at [main.go#L988-L990](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/cmd/containerboot/main.go#L988-L990)).
The comment says "the health criteria might change in the future"
([main.go#L77-L80](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/cmd/containerboot/main.go#L77-L80)).
It says nothing about Serve or certificates. It works as a compose `healthcheck` for "joined the tailnet".
`BackendState` and `CertDomains` from LocalAPI tell the bootstrapper more.

## 6. Which auth key

From the [auth keys KB](https://tailscale.com/kb/1085/auth-keys):

- Kinds: one-off, reusable ("Be very careful with reusable keys!"), ephemeral, pre-approved, and tagged.
- Auth keys expire after 1 to 90 days (default 90). A node that already joined keeps working after its auth key
  expires, until its node key expires. Node keys expire every 180 days by default.
- "shared devices, such as servers, should use a tagged auth key to connect", and "a pre-approved auth key"
  where device approval is on. "containers or Lambda functions should use an ephemeral key".

From the [tags KB](https://tailscale.com/kb/1068/tags):

- "the tagged device's key expiry is disabled by default". Changing tags later only changes expiry after
  re-authentication.
- "Applying a tag to a device removes any user-based authentication". The device's identity is the union of its
  tags, and ACLs match on tags, not on whoever minted the key. Only `tagOwners` (or admins) can apply a tag.
- "Only use tags for non-human machines."

From the [ephemeral nodes KB](https://tailscale.com/kb/1111/ephemeral-nodes): ephemeral devices are removed
"30 to 60 minutes after the last activity", and a new one gets a new IP. A deployment that is down for an hour
would come back as a new node with a new IP, and paired devices would lose it. That
rules ephemeral out here, whatever the KB's line about containers says.

From the [OAuth clients KB](https://tailscale.com/kb/1215/oauth-clients) and
[docker-params](https://tailscale.com/docs/features/containers/docker/docker-params): an OAuth client secret
with the `auth_keys` scope can stand in for `TS_AUTHKEY`. It must come with `--advertise-tags`
(`TS_EXTRA_ARGS`), and it registers ephemeral nodes unless suffixed `?ephemeral=false`
(`&preauthorized=true` skips device approval). Devices registered this way are tag-owned. containerboot also
takes `TS_CLIENT_ID` / `TS_CLIENT_SECRET` directly
([main.go#L14-L28](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/cmd/containerboot/main.go#L14-L28)).
The KB doesn't say whether client secrets expire.

For a Phoebe deployment that means a tagged key (e.g. `tag:phoebe`), non-ephemeral, pre-approved where approval
is on, with persistent `TS_STATE_DIR` and `TS_AUTH_ONCE=true`. `TS_AUTH_ONCE` defaults to false, which forces
login on every start
([docker-params](https://tailscale.com/docs/features/containers/docker/docker-params)), and that fails once a
one-off key has been used. Reusable keys or an OAuth secret avoid that, at the cost of a longer-lived secret on
disk. The tag also gives the tailnet policy one handle for "who may reach Phoebe deployments on 443". The
deployment's own tag doesn't affect identity headers for people calling it (section 4).

## Open after this pass

- The Unix-socket Serve backend avoids the bypass. Choosing it over TCP plus a mandatory token is a decision for
  the map, not this ticket.
- Whether Serve's own backend dial is registered in the proxy map, i.e. whether `whois` on a Serve-proxied
  loopback connection returns the peer. Not traced.
- Which release added the eager cert refresh loop, and so the minimum sidecar tag to pin.
- The initial mode of a Docker named volume at a fresh mountpoint (assumed `0755`, not checked).
