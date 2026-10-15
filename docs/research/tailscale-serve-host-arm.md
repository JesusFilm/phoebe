# `tailscale serve` on the host against a Docker-published loopback port

Research for [#693](https://github.com/JesusFilm/phoebe/issues/693) on the Tailscale remote-access
map ([#690](https://github.com/JesusFilm/phoebe/issues/690)), read 2026-10-15. Sources are
Tailscale's KB, the `tailscale/tailscale` source at `v1.104.1`
(`9a522a9786c97eb7910c01ccb7bd66557b04c910`), Microsoft's WSL docs, Docker's docs, and
`pingdotgg/t3code` `main` at `c079503d07739096e9e672bfa42fa0fe42a8ae15`. The second comment on #690
already walks T3's pairing flow; this note reads only the two files that run `tailscale`, by
line. I ran no network experiment on the owner's machine; the last section names the ones
that would settle what the docs leave open.

The setup under test is the one T3 ships. The container publishes the bootstrapper's port on
`127.0.0.1`, the host's own Tailscale runs `tailscale serve --bg --https=443
http://127.0.0.1:<port>`, and a device on the tailnet opens
`https://<machine>.<tailnet>.ts.net/`. Does that hold on each host Phoebe runs on, and what
does the host verb have to do?

## The short answers

- **Linux with Docker Engine: yes, with nothing extra.** A `127.0.0.1:<port>:<port>` publish gives
  the host a loopback listener only the host can reach, and Serve's proxy target is exactly
  that loopback. This is the case T3 Code ships.
- **macOS with Docker Desktop: yes.** Docker Desktop's backend forwards the VM's port to the
  host and honours a `127.0.0.1` bind. Serve to a loopback target works on both GUI variants;
  only file serving is off limits there. The CLI is
  `/Applications/Tailscale.app/Contents/MacOS/Tailscale` on the App Store build and a
  `/usr/local/bin/tailscale` launcher on the standalone build.
- **Windows with Docker inside WSL2 (the owner's setup): the Windows client should reach it,
  but the docs stop one step short of proving it.** WSL forwards ports bound to localhost in
  the VM to Windows `localhost:<port>` by default, and the Windows Tailscale service dials
  `127.0.0.1:<port>`. Docker's default userland proxy is what gives WSL a real socket to
  forward. No primary source says WSL's forwarding sees that socket, or serves a dial from the
  LocalSystem service rather than the user's session. One `curl` from PowerShell settles it. A
  Tailscale client inside the distro is the fallback; Tailscale tells WSL users to run the
  Windows client only.
- **`Self.DNSName` is the FQDN with a trailing dot.** T3 strips the dot and treats an empty
  value as "MagicDNS off".
- **Serve with `--bg` survives reboots** and is stored in tailscaled's state. Tailscale itself
  overwrites a handler on the same port without asking; T3's probe is what refuses to.
- **The certificate is fetched on the first TLS handshake**, with a one-minute timeout inside
  tailscaled, and T3 waits for it with five probes a second apart.

## What Serve does with the target

Serve accepts a bare port, `localhost:3000`, or a full URL, and the CLI reference says only
`http://127.0.0.1` is supported as a proxy target
([Serve CLI reference](https://tailscale.com/kb/1242/tailscale-serve)). The source bears
that out. A numeric target expands to `http://127.0.0.1:<port>`
([`ipn/ipnlocal/serve.go:1330`](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/ipn/ipnlocal/serve.go#L1330)),
and `isRemote` treats `localhost`, `127.0.0.1` and `::1` as local and anything else as remote
([`cmd/tailscale/cli/serve_v2.go:1178-1206`](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/cmd/tailscale/cli/serve_v2.go#L1178-L1206)).
A remote target is not rejected, but on the two macOS GUI variants the CLI refuses it with
"doesn't support connecting to remote destinations from non-default route"
([`serve_v2.go:1221-1230`](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/cmd/tailscale/cli/serve_v2.go#L1221-L1230)).

The proxy itself is Go's `httputil.ReverseProxy` with no `ErrorHandler` set
([`ipn/ipnlocal/serve.go:976`](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/ipn/ipnlocal/serve.go#L976)),
so a dead backend produces the stdlib default, "log the provided error and return a 502
Status Bad Gateway response" ([pkg.go.dev](https://pkg.go.dev/net/http/httputil#ReverseProxy)).
A proxy that is being torn down answers 503
([`serve.go:970-974`](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/ipn/ipnlocal/serve.go#L970-L974)).
Those two codes are why T3's "stale mapping" rule looks the way it does, below.

Serve requires HTTPS certificates to be enabled on the tailnet; the CLI walks the user through
enabling the feature if it is off
([Serve KB, troubleshooting](https://tailscale.com/kb/1312/serve);
[`serve_v2.go:462-475`](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/cmd/tailscale/cli/serve_v2.go#L462-L475)).
Enabling HTTPS means MagicDNS on and "Enable HTTPS" on the admin console's DNS page, and the
machine names go on a public certificate ledger
([Enabling HTTPS](https://tailscale.com/kb/1153/enabling-https)). Tailnets created on or after
2022-10-20 have MagicDNS on by default ([MagicDNS](https://tailscale.com/kb/1081/magicdns)).

## Linux host with Docker Engine

`docker run -p 127.0.0.1:8080:80` publishes on loopback and "only the Docker host can access
the published container port"; without a host address Docker binds `0.0.0.0` and `[::]`, and
the docs call that insecure by default
([Port publishing](https://docs.docker.com/engine/network/port-publishing/)). The daemon's
`--userland-proxy` flag, default `true`, is described as "Use userland proxy for loopback
traffic" ([dockerd reference](https://docs.docker.com/reference/cli/dockerd/)). On Linux that
is the whole story. The host has a loopback socket, tailscaled dials it, the compose file gains
`ports: ["127.0.0.1:<port>:<port>"]`, and nothing else changes.

## macOS with Docker Desktop

Docker Desktop runs containers in a Linux VM; its backend process listens on the host port and
forwards into the VM, and `-p` can be restricted to "a specific address, such as `127.0.0.1`
(`localhost`)" ([Docker Desktop networking](https://docs.docker.com/desktop/features/networking/)).
So a `127.0.0.1` publish lands on the Mac's loopback the same way.

On the Tailscale side there are three macOS builds: App Store (sandboxed network extension),
standalone (system extension, Tailscale's recommendation), and the open-source `tailscaled`
with no GUI ([macOS variants](https://tailscale.com/kb/1065/macos-variants)). Serving files is
"limited to the open source variant" because of the sandbox
([Serve KB](https://tailscale.com/kb/1312/serve);
[`serve_v2.go:1261-1262`](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/cmd/tailscale/cli/serve_v2.go#L1261-L1262)),
but proxying a loopback port is fine on all three; the remote-destination refusal above is the
only GUI-variant restriction on proxy targets. The CLI location differs per build. App Store:
run `/Applications/Tailscale.app/Contents/MacOS/Tailscale <command>`, or alias it. Standalone:
the client's settings install a launcher at `/usr/local/bin/tailscale` (macOS 13 or later).
The GUI and CLI are one executable, and a script can force CLI mode with `TAILSCALE_BE_CLI=1`
([CLI KB](https://tailscale.com/kb/1080/cli)). T3 spawns a bare `tailscale` and relies on
PATH ([`tailscale.ts:15-18`](https://github.com/pingdotgg/t3code/blob/c079503d07739096e9e672bfa42fa0fe42a8ae15/packages/tailscale/src/tailscale.ts#L15-L18)),
which misses the App Store build unless the user has aliased it. A Phoebe host verb should try
PATH, then the App Store path, before declaring Tailscale absent.

## Windows with Docker inside WSL2

This is the owner's setup: Docker Engine in an Arch distro, Tailscale's Windows client on the
host. Two routes exist, and I read them in turn.

### Route A: the Windows client serves a port published inside the distro

The WSL 2 VM has its own virtual adapter and IP under the default NAT mode, and Microsoft's
networking page says a Linux app "can be accessed from a Windows app ... using `localhost`
(just like you normally would)"
([Accessing network applications with WSL](https://learn.microsoft.com/en-us/windows/wsl/networking)).
The `.wslconfig` setting behind that is `localhostForwarding`, default `true`, "specifying if
ports bound to wildcard or localhost in the WSL 2 VM should be connectable from the host via
`localhost:port`" ([.wslconfig reference](https://learn.microsoft.com/en-us/windows/wsl/wsl-config)).
A Docker port published on `127.0.0.1` inside the distro is a port bound to localhost in the
VM, so it should appear on Windows `127.0.0.1:<port>`. On Windows `tailscaled` runs as a
service named "Tailscale" ([tailscaled reference](https://tailscale.com/docs/reference/tailscaled))
and its proxy dials `127.0.0.1:<port>` on the Windows side. Put together, the Windows client's
`tailscale serve --bg --https=443 http://127.0.0.1:<port>` should front the container with no
change to the argv T3 uses.

Two things the docs do not say, and I would not ship without checking:

1. Whether WSL's forwarding sees a Docker-published port. Docker's default userland proxy opens
   a real socket on the distro's loopback. With `--userland-proxy=false` only NAT rules exist,
   and I would expect WSL to have nothing to forward. The docs describe the proxy in one line
   ([dockerd reference](https://docs.docker.com/reference/cli/dockerd/)) and never say what
   WSL watches. Keep the proxy on; test with it on.
2. Whether a connection from the Tailscale service (LocalSystem, no user session) is forwarded
   the same as one from the user's browser. Microsoft's docs do not say who may use the
   forwarded port.

The experiment is three commands on the owner's machine: start the stack, then from
PowerShell `curl.exe http://127.0.0.1:<port>/` (proves forwarding), then `tailscale.exe serve
--bg --https=443 http://127.0.0.1:<port>` and `curl.exe https://<machine>.<tailnet>.ts.net/`
from the same machine (proves the service's dial goes through the same path). `tailscale serve
--https=443 off` cleans up.

Mirrored networking mode (Windows 11 22H2 or later) removes the NAT layer: "the Windows host
and WSL2 VM can connect to each other using `localhost` (127.0.0.1)", and the
`localhostForwarding` key "is ignored when networkingMode=mirrored"
([networking](https://learn.microsoft.com/en-us/windows/wsl/networking);
[.wslconfig](https://learn.microsoft.com/en-us/windows/wsl/wsl-config)). Microsoft's own
troubleshooting page records a known issue where Docker Desktop containers with published ports
fail to be created under mirrored mode, with `--network host` or the `ignoredPorts` setting as
workarounds ([troubleshooting](https://learn.microsoft.com/en-us/windows/wsl/troubleshooting)).
That is Docker Desktop, not Engine in a distro, but enough to keep mirrored mode off the table.

The MSI installs to `C:\Program Files\Tailscale` by default
([MSI install](https://tailscale.com/docs/install/windows/msi)), the CLI is `tailscale.exe`
([tailscaled reference](https://tailscale.com/docs/reference/tailscaled)), and the KB shows it
run bare from a Command Prompt ([CLI KB](https://tailscale.com/kb/1080/cli)). T3 spawns it
directly, never through `cmd.exe`
([`tailscale.ts:15-18`](https://github.com/pingdotgg/t3code/blob/c079503d07739096e9e672bfa42fa0fe42a8ae15/packages/tailscale/src/tailscale.ts#L15-L18)).
`serve` needs no elevation on Windows. A Windows user "always [has] read/write access to the
local API if they're allowed to connect", and the connect check only refuses a different user
than the one already using the GUI
([`ipn/ipnserver/server.go:336-347`](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/ipn/ipnserver/server.go#L336-L347),
[`:251-290`](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/ipn/ipnserver/server.go#L251-L290)).

One wrinkle. The owner's shell is the WSL distro, and a host verb there can still drive the
Windows client because interop puts `tailscale.exe` on PATH when `appendWindowsPath` is on
(default `true`, [wsl.conf](https://learn.microsoft.com/en-us/windows/wsl/wsl-config)). T3
picks `tailscale.exe` only when Node reports `win32`, which a process inside WSL does not;
Phoebe would need to try it on `linux` too, or let the config name the binary.

### Route B: a Tailscale client inside the distro

Tailscale's WSL page is blunt: "it is recommended that users run Tailscale on the Windows host
only, and not inside WSL 2", because "Tailscale encrypted traffic that flows from WSL 2 over
Tailscale on the Windows host will not work" when both run; `tailscaled` also has to raise WSL
2's 1280 MTU to 1340 ([Install on Windows with WSL 2](https://tailscale.com/kb/1295/install-windows-wsl2)).
Otherwise the route is plain Linux: `tailscaled` under systemd (opt-in via `[boot]
systemd=true`), the `tun` module loaded by default, and Serve to the distro's own loopback with
no forwarding at all. The cost is a second tailnet node with its own name and key, and a VM
that WSL stops after `vmIdleTimeout` (60 s) when nothing keeps it busy
([wsl.conf and .wslconfig](https://learn.microsoft.com/en-us/windows/wsl/wsl-config)). The owner
already keeps Docker alive there; the "do not run both" warning is the real cost. Route B is
the fallback if the Route A experiment fails.

## What `tailscale status --json` returns and how T3 reads it

`Status.Self` is a `*PeerStatus`, and the comment on `PeerStatus.DNSName` reads "DNSName is
the Peer's FQDN. It ends with a dot. It has the form `"host.<MagicDNSSuffix>."`"
([`ipn/ipnstate/ipnstate.go:48-50`](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/ipn/ipnstate/ipnstate.go#L48-L50),
[`:244-246`](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/ipn/ipnstate/ipnstate.go#L244-L246)).
With `--json` the CLI prints the whole struct and exits 0 whatever `BackendState` is; the
"Logged out." message and exit 1 belong to the table output only
([`cmd/tailscale/cli/status.go:88-101`](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/cmd/tailscale/cli/status.go#L88-L101),
[`:143-155`](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/cmd/tailscale/cli/status.go#L143-L155)).
The KB warns the JSON format is "subject to change" ([CLI KB](https://tailscale.com/kb/1080/cli)).

T3 decodes only `Self.DNSName` and `Self.TailscaleIPs`, both as `unknown`, trims the trailing
dot, and keeps IPv4 addresses in `100.64.0.0/10`
([`tailscale.ts:129-215`](https://github.com/pingdotgg/t3code/blob/c079503d07739096e9e672bfa42fa0fe42a8ae15/packages/tailscale/src/tailscale.ts#L129-L215)).
The three states map to three errors in `pair.ts`. A spawn failure, non-zero exit, unreadable
output or a 1.5 s timeout all become `TailscaleUnavailableError` ("Is tailscaled running? Try
`tailscale status`"); a null `magicDnsName` becomes `MagicDnsNameMissingError` ("Run
`tailscale up` and enable MagicDNS")
([`pair.ts:88-104`](https://github.com/pingdotgg/t3code/blob/c079503d07739096e9e672bfa42fa0fe42a8ae15/apps/server/src/cli/pair.ts#L88-L104),
[`:363-371`](https://github.com/pingdotgg/t3code/blob/c079503d07739096e9e672bfa42fa0fe42a8ae15/apps/server/src/cli/pair.ts#L363-L371)).
So a logged-out node is not told apart at the status step. It still prints JSON, with an empty
`DNSName`, and lands in the MagicDNS error, whose message is wrong for that case. Phoebe can
do better by reading `BackendState` as well.

Stderr is never logged raw, "stderr can contain auth keys (`tskey-…`) and node names". It is
matched against three anchored patterns, most specific first: `handler does not exist` to
`no-existing-handler`, `not logged in|logged out|needs? login` to `not-logged-in`, `permission
denied|access denied|must be root|operation not permitted` to `permission-denied`; anything
else is `unknown`, and the error carries only the label plus byte counts
([`tailscale.ts:26-55`](https://github.com/pingdotgg/t3code/blob/c079503d07739096e9e672bfa42fa0fe42a8ae15/packages/tailscale/src/tailscale.ts#L26-L55),
[`:81-99`](https://github.com/pingdotgg/t3code/blob/c079503d07739096e9e672bfa42fa0fe42a8ae15/packages/tailscale/src/tailscale.ts#L81-L99)).
`no-existing-handler` is there so `serve off` on an unmapped port can be ignored.

## Persistence, stale mappings and the occupied-port refusal

With `--bg`, Serve "resumes automatically after a reboot or after `tailscale down` and
`tailscale up`"; without it, Serve stops when Tailscale restarts
([Serve CLI reference](https://tailscale.com/kb/1242/tailscale-serve)). The mechanism is a
`ServeConfig` in tailscaled's state store under `_serve/<profile-id>`; foreground sessions
live in a nested `Foreground` map that dies with the CLI session
([`ipn/serve.go:28-31`](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/ipn/serve.go#L28-L31),
[`:51-76`](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/ipn/serve.go#L51-L76),
[`ipn/ipnlocal/serve.go:389-391`](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/ipn/ipnlocal/serve.go#L389-L391)).
The mapping outlives the container, which is the whole reason a stale-mapping rule is needed.

Tailscale does not protect an existing mapping. `SetWebHandler` does `mak.Set(&webCfg.Handlers,
mount, handler)`, replacing whatever was at that mount, and the CLI only refuses when the port
already carries raw TCP forwarding
([`ipn/serve.go:426-452`](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/ipn/serve.go#L426-L452),
[`serve_v2.go:1289-1295`](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/cmd/tailscale/cli/serve_v2.go#L1289-L1295)).
T3's guard is a probe of `/.well-known/t3/environment` over the HTTPS URL before it runs
`serve`, with three outcomes
([`pair.ts:195-230`](https://github.com/pingdotgg/t3code/blob/c079503d07739096e9e672bfa42fa0fe42a8ae15/apps/server/src/cli/pair.ts#L195-L230)):

- Transport error or 2.5 s timeout, or an HTTP 502, 503 or 504, is `unreachable`. The comment
  says it: "Bad-gateway family means a proxy (Tailscale Serve) answered for a backend that is
  gone — a stale mapping, not a live occupant." Safe to (re)configure.
- A 2xx whose body decodes as a T3 descriptor is `descriptor`. Same `environmentId` as the local
  server: reuse the mapping as is. Different id: `ServesOtherEnvironmentError`, pick another
  port.
- Any other HTTP answer is `not-a-t3-server`, and `t3 pair` stops with `ServePortOccupiedError`
  rather than overwrite someone else's mapping
  ([`pair.ts:377-396`](https://github.com/pingdotgg/t3code/blob/c079503d07739096e9e672bfa42fa0fe42a8ae15/apps/server/src/cli/pair.ts#L377-L396)).

`serve` itself is `["serve", "--bg", "--https=<servePort>", "http://<localHost>:<localPort>"]`,
default port 443 and host `127.0.0.1`, 10 s timeout; teardown is `serve --https=<port> off`
([`tailscale.ts:370-392`](https://github.com/pingdotgg/t3code/blob/c079503d07739096e9e672bfa42fa0fe42a8ae15/packages/tailscale/src/tailscale.ts#L370-L392)).
`t3 pair` never tears it down; the user doc tells people to run `tailscale serve --https=443
off` themselves
([`docs/user/remote-access.md:122-148`](https://github.com/pingdotgg/t3code/blob/c079503d07739096e9e672bfa42fa0fe42a8ae15/docs/user/remote-access.md#L122-L148)).
A Phoebe `remote off` verb that runs the `off` form and ignores `no-existing-handler` would be
tidier than that.

## The certificate on first request

Serve's TLS config has a `GetCertificate` callback and no preloaded certificate. On each
handshake it checks that a web handler exists for the SNI name and port, then calls
`GetCertPEM` with a one-minute context, which is the Let's Encrypt DNS-01 flow
([`ipn/ipnlocal/serve.go:1361-1386`](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/ipn/ipnlocal/serve.go#L1361-L1386),
[`:1397-1399`](https://github.com/tailscale/tailscale/blob/9a522a9786c97eb7910c01ccb7bd66557b04c910/ipn/ipnlocal/serve.go#L1397-L1399);
[Enabling HTTPS](https://tailscale.com/kb/1153/enabling-https)). So the first request to a fresh
mapping blocks on issuance, and the KB's rate-limit warning applies: too many requests and
"you may find yourself waiting 34 hours". `GetCertPEM` is keyed by the SNI name, not the
port, so one certificate covers every port the machine serves on.

T3's answer is five probes one second apart, each with a 2.5 s timeout, after `serve` returns.
If none succeeds it still prints the pairing link, with a note that first use "can take a
moment while Tailscale provisions certificates"
([`pair.ts:58-63`](https://github.com/pingdotgg/t3code/blob/c079503d07739096e9e672bfa42fa0fe42a8ae15/apps/server/src/cli/pair.ts#L58-L63),
[`:351-361`](https://github.com/pingdotgg/t3code/blob/c079503d07739096e9e672bfa42fa0fe42a8ae15/apps/server/src/cli/pair.ts#L351-L361),
[`:415-425`](https://github.com/pingdotgg/t3code/blob/c079503d07739096e9e672bfa42fa0fe42a8ae15/apps/server/src/cli/pair.ts#L415-L425)).
Five seconds against a one-minute server-side timeout is optimistic; the note covers the gap.
A Phoebe host verb can afford a longer loop, and `doctor` can repeat the probe later.

## What this means for the host verb

In order: find the CLI (PATH, then the App Store path on macOS, then `tailscale.exe` through
WSL interop); `status --json`, reading `BackendState` and `Self.DNSName`; probe
`https://<dnsname>:<port>/` for Phoebe's own descriptor and apply the three-outcome rule; run
`serve --bg --https=<port> http://127.0.0.1:<port>`; probe until the certificate lands.
Everything spawned is argv, never a shell string, and stderr is classified, never stored.

## What is unverified

- That WSL's localhost forwarding presents a Docker-published `127.0.0.1` port to Windows, and
  that it does so for the Tailscale service's dial. The `curl.exe` experiment above settles both.
- That the forwarding depends on Docker's userland proxy; not tested with `--userland-proxy=false`.
- Behaviour under mirrored networking mode with Docker Engine in the distro, as opposed to the
  Docker Desktop issue Microsoft documents.
- Whether the Windows installer adds `C:\Program Files\Tailscale` to PATH. The KB shows the CLI
  run bare; no page says how it got there.
- Whether a WSL distro running Docker and `tailscaled` stays up with no shell open. The docs
  give the idle timeouts, not what counts as busy.
