# Pairing codes are minted root-only, through a file drop

Everything in the deployment container runs as one uid, 10001, with one view
of the filesystem (`docs/trust.md`, one container is one trust domain). A
tenant's engine child, and the agent under it, can already write the config
pen, the secret store and `~/.gitconfig`; it can kill the bootstrapper or
replace its materialized code on `/data/engine` and wait for a relaunch. What a
child that could mint a pairing code would newly gain is an outside credential:
a 30-day `operate` session that outlives the work unit, sits on another tailnet
device, and looks like a legitimate row in the devices list.

So minting is the one thing in the container that is root-only. `phoebe pair`
runs as root through `docker compose exec -u root`, refuses unless it is uid 0
and `phoebe boot` is the container's main process, and writes the code's
SHA-256 as `<nonce>.json` into `/run/phoebe-mint`, a `root:root 0755`
directory the Dockerfile creates in the image on no volume. The bootstrapper
watches the drop, reads only files owned by uid 0, holds the hash in memory as a
pending code, and acknowledges by writing the nonce under its own `state/`.
The root process then deletes its file and prints the code. At rest the drop
is empty.

## Considered options

- **A mint secret held in the bootstrapper's memory.** A non-dumpable node
  keeps it from children, but there is no path to the host that children cannot
  read, and container stdout is a shipped log.
- **Minting over the host arm's loopback port.** Anything on `127.0.0.1:7463`
  is reachable by a child, and there is no credential to put on the request.
  Both arms therefore mint by exec.
- **The config pen.** Writable by uid 10001, and imported as code.
- **No gate at all.** One HTTP request would become a persistent outside
  foothold.

`SO_PEERCRED` was not on the table: Node does not expose it.

## Consequences

- A host verb carries `-u root`, which is surprising in a system whose every
  other process is unprivileged. The host side checks the same two conditions
  before the exec, and the `phoebe` shim skips materializing into
  `/data/engine` when the marker exists, so a root run writes nothing there.
- The drop has to exist in the image, root-owned, on no volume. It cannot sit
  under `/var/run/phoebe`, the sidecar arm's uid 10001 tmpfs. A `--tmpfs /run`
  or a volume over it silently breaks minting, which is what the doctor
  `remote` check looks for.
- A pending code lives only in the bootstrapper's memory, so a relaunch between
  mint and redeem voids it; the person mints again.
- The gate defends against a child using what it legitimately has. It does not
  defend against a child that has already subverted the bootstrapper through
  `/data/engine`, and the sessions store itself stays forgeable in this model:
  a child can append a row whose hash it chose. That is made visible (the
  report's `tampered` flag, the devices list) rather than prevented, and real
  separation remains model B's job.
