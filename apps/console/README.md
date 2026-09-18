# apps/console

The **console**: the operator's view of a relay's fleet, as one React bundle.

```sh
vp run dev     # from this directory; the relay is not proxied, see below
vp run build   # writes ../../console, which the published package carries
vp run test
```

`vp run build` emits into `console/` at the repo root rather than a local `dist/`,
because that directory is in the root package's published `files`. That is what
lets `phoebe relay serve` hand the pages out of the single installed package
([#522 §5](https://github.com/JesusFilm/phoebe/issues/522)). `apps/*` itself never
ships.

Everything the pages read goes through one seam, [`src/relay-client.ts`](src/relay-client.ts).
The browser arm is the relay's own origin, its `__Host-` session cookie and
`EventSource`. The companion's arm is a second implementation of the same type over
the desktop bridge ([#553](https://github.com/JesusFilm/phoebe/issues/553)), so
nothing else in here knows which side it is running on.

Pages are hash routes, picked in [`src/app.tsx`](src/app.tsx): `#/fleet` is the
rail and the grid, `#/people` is the allowlist and the pairing panel
([#548](https://github.com/JesusFilm/phoebe/issues/548)). The hash and not the
path, because the relay serves this build and nothing else — a real path would
need a catch-all there, and a catch-all is what costs the relay its ability to
say a route does not exist.

`vp run dev` serves the bundle on its own origin with no relay behind it, so the
pages land on the signed-out notice. To see real data, build and let the relay
serve it.

The reports arrive opaque — the relay stores and forwards `state/deployment.json`
without reading a field of it — so [`src/report.ts`](src/report.ts) is the first
thing in the chain to look inside, and it checks the `schema` integer before it
trusts a field. [`src/facts.ts`](src/facts.ts) holds the rollup and the sort, pure
and tested apart from the components: two readers of one report must not be able
to disagree about what it says.
