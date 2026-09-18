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
the desktop bridge, so nothing else in here knows which side it is running on.
[`src/main.tsx`](src/main.tsx) picks between them by reading the global the
companion's preload exposes; that is the only thing in the bundle that can tell
the two surfaces apart ([#526](https://github.com/JesusFilm/phoebe/issues/526)
shell A).

The relay is one of the companion's two arms. The other is **local installs** —
folders on this machine, listed under "This machine" on the rail, each with an
**install tab** that takes one from nothing to running with buttons
([#555](https://github.com/JesusFilm/phoebe/issues/555)). That arm goes through
the bridge directly rather than through the relay client, because none of it is a
relay call: [`src/local-install.ts`](src/local-install.ts) holds the readings and
the reducers, and [`src/install-page.tsx`](src/install-page.tsx) renders them. A
browser has no local arm at all and the group is not drawn there.

A local install's other five tabs — overview, pipelines, doctor, secrets, config —
are the ones every deployment has, and they are fed without a relay: main's local
read loop execs `status --json` in the container and emits the same `report` event
the relay's stream carries ([#556](https://github.com/JesusFilm/phoebe/issues/556)).
So [`src/deployment-tabs.tsx`](src/deployment-tabs.tsx) takes a narrowed report
and draws it, and the only place the arm shows is the overview's connection card,
which the page builds. A stopped install shows config from the file and says what
the rest need; the last report the window is still holding is not drawn
([#526](https://github.com/JesusFilm/phoebe/issues/526)).

`vp run dev` serves the bundle on a fixed, strict port with no relay behind it, so
the pages land on the signed-out notice; `apps/desktop`'s `vp run dev` points the
companion's window at that same port. To see real data, build and let the relay
serve it.

The reports arrive opaque — the relay stores and forwards `state/deployment.json`
without reading a field of it — so [`src/report.ts`](src/report.ts) is the first
thing in the chain to look inside, and it checks the `schema` integer before it
trusts a field. [`src/facts.ts`](src/facts.ts) holds the fleet's rollup and sort,
[`src/deployment-facts.ts`](src/deployment-facts.ts) holds one deployment's lines,
[`src/config-facts.ts`](src/config-facts.ts) flattens the effective-config
tree into the rows its table draws, and [`src/config-edit.ts`](src/config-edit.ts)
decides which of those rows may be edited and what the rest say instead — all pure
and tested apart from the components: two readers of one report must not be able to
disagree about what it says.

Editing is the one thing the console asks a deployment to _do_
([#547](https://github.com/JesusFilm/phoebe/issues/547)). The deployment is the
authority on every edit: it holds the pen, it validates the patch against the
loader it is running, and its refusal — with the exact manual edit attached — is
the answer. The console's own decision is narrower and comes first, which leaves
it reading `CLOSED_EDIT_BLOCKS` out of `phoebe-agent/contracts` rather than
keeping a table of its own.

Pages are hash routes ([`src/route.ts`](src/route.ts)), because the relay serves
no single-page fallback and the companion loads the bundle off a custom scheme
where there is no server to ask. Links are plain `href`s into the hash; the
browser does the navigating and the history, and the app only listens.

One page writes: the secrets tab ([`src/secrets-tab.tsx`](src/secrets-tab.tsx)).
It seals a value in the browser to the deployment's published box key and sends
the envelope through the same client seam, so the relay carries something it
cannot open ([#550](https://github.com/JesusFilm/phoebe/issues/550)). Nothing on
that page ever shows a value — not a last four, not a hash, not a length — because
the section it renders carries none.
