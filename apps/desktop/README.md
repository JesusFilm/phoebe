# apps/desktop

The **companion**: the Electron app whose window is the console
([#522](https://github.com/JesusFilm/phoebe/issues/522)).

```sh
vp run build   # writes dist/main.cjs and dist/preload.cjs
vp run start   # the built bundle, over the console scheme
vp run dev     # the same window against apps/console's dev server
vp run test
```

This package is **main and preload, and nothing else**. No UI lives in here. The
window's renderer is the `apps/console` bundle, the same React app the relay
serves in a browser, loaded from disk over the privileged `phoebe://console/`
scheme ([#521 §5](https://github.com/JesusFilm/phoebe/issues/521),
[#522 §4](https://github.com/JesusFilm/phoebe/issues/522)). So a page the operator
sees is never written twice, and a fix to the fleet grid lands in both places at
once.

`vp run dev` expects `vp run dev` in `apps/console` to already be up. The console
pins that dev server to a fixed port with `strictPort`, and
[`src/console-source.test.ts`](src/console-source.test.ts) holds the two numbers
together.

The console learns it is in the companion by finding the bridge the preload
exposes, and by nothing else. No build flag, no second entry point
([`src/preload.ts`](src/preload.ts)). What the bridge carries is declared once, in
`phoebe-agent/contracts`, and implemented by main.

The app is `private` and carries no version of its own. `vite.config.ts` reads the
root package's version at build time and defines it into the bundle
([#521 §4](https://github.com/JesusFilm/phoebe/issues/521)). It reads no `.env`
and holds no secret. Signing in happens against the relay and the session is the
companion's ([#521 §8](https://github.com/JesusFilm/phoebe/issues/521)).

`vp run build` is two passes, one per entry point, and the two take different
formats. The preload is CommonJS because a sandboxed preload has to be — Electron
loads an ES-module preload only with the sandbox off — and it is bundled alone,
because a sandboxed `require` resolves `electron` and a few built-ins and nothing
else, so a shared chunk on disk beside it is a file it could never load. Main is
an ES module because it bundles the engine's host verbs, and engine modules
resolve their shipped `templates/` and `prompts/` through `import.meta`; a
CommonJS pass replaces that with `{}` and main stops loading at import time.

Building needs no Electron binary, which is why the gate can run with
`--ignore-scripts` and the agent container sets `ELECTRON_SKIP_BINARY_DOWNLOAD=1`
(`.phoebe/container/compose.yml`). Running the app needs the binary; packaging is
[#561](https://github.com/JesusFilm/phoebe/issues/561)'s — including putting
`templates/` and `prompts/` where `init` can find them, which is what
`packageRoot()` in [`src/verb-dispatch.ts`](src/verb-dispatch.ts) hooks.

## What main answers today

**The local arm, in full.** The installs on this machine, the Docker check, and
the verb runs that drive them ([#555](https://github.com/JesusFilm/phoebe/issues/555)):

- [`companion-file.ts`](src/companion-file.ts) — `companion.json` in `userData`:
  the install directories, the relay URL, the preferences. Nothing else. Every
  fact _about_ an install is derived on read.
- [`install-facts.ts`](src/install-facts.ts) — that derivation. Running, stopped
  or not initialised, from Compose and the folder itself.
- [`docker.ts`](src/docker.ts) — the check. Docker is checked and never
  installed; a missing one is a sentence and a link.
- [`verb-runs.ts`](src/verb-runs.ts) — ids, line buffers, busy-ness and cancel.
  One run per install, parallel across installs, 2000 lines kept, and the buffer
  lives here so a renderer reload rejoins a run rather than losing it.
- [`verb-dispatch.ts`](src/verb-dispatch.ts) — the six `run<Verb>` calls, in
  this process (ADR 0001). No second Node, no `bin.mjs`, no stdout parsing.

Beside it, a relay arm with no session, so the console draws the Relay group
signed out ([#526](https://github.com/JesusFilm/phoebe/issues/526)). Sign-in
([#554](https://github.com/JesusFilm/phoebe/issues/554)) and the local read loop
([#556](https://github.com/JesusFilm/phoebe/issues/556)) are changes in here,
behind the contract the preload already exposes.

## The two version rules

The companion is distributed on its own, so it can be older or newer than either
thing it talks to. Neither case is an odd failure
([#525](https://github.com/JesusFilm/phoebe/issues/525)).

**The relay arm refuses, and the rule is relay at or above companion.** The console
bundle reads `GET /api/version` before anything else and compares the `console`
integer there against its own `CONSOLE_PROTOCOL`. A relay below it gets the Relay
group rendered as too old with a link to
[the relay upgrade doc](../../docs/relay.md#upgrading), and no second call. The
comparison lives in
[`apps/console/src/relay-version.ts`](../console/src/relay-version.ts) and nowhere
else, because the relay publishes its integer and performs no comparison of its
own.

**The local arm reports and never refuses.** The install tab states the container's
`phoebe-agent` version beside the companion's own. That version is the
`ARG PHOEBE_AGENT_VERSION` pin in the install's `container/Dockerfile`, read by
[`install-facts.ts`](src/install-facts.ts), which is also what `upgrade` moves. A
difference is a sentence, and `Check for upgrades` sits a few lines above it. The
companion drives that install; it does not have to agree with it, and locking the
buttons on a skew would lock away the verb that fixes it.

Two things a later ticket owes this package. `upgrade` and `migrate` spawn their
children through `spawnSync`, which blocks main for as long as they run — so the
window freezes, and neither can be cancelled (`CANCELLABLE_VERBS` is `start` and
`stop`). And a run's lines are held only in memory, so quitting the app loses the
last run's output.
