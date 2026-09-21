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

`vp run build` is two passes, one per entry point, because a sandboxed preload's
`require` resolves `electron` and a few built-ins and nothing else. A shared chunk
on disk beside it is a file it could never load. Building needs no Electron
binary, which is why the gate can run with `--ignore-scripts` and the agent
container sets `ELECTRON_SKIP_BINARY_DOWNLOAD=1` (`.phoebe/container/compose.yml`). Running the app needs the
binary; packaging is [#561](https://github.com/JesusFilm/phoebe/issues/561)'s.

## What main answers today

The shell's worth of the bridge: its version, and a relay arm with no session, so
the console draws shell A empty, a "This machine" group and a "Relay" group
([#526](https://github.com/JesusFilm/phoebe/issues/526)). Sign-in
([#554](https://github.com/JesusFilm/phoebe/issues/554)), the host verbs and the
install list ([#555](https://github.com/JesusFilm/phoebe/issues/555)) and the
local read loop ([#556](https://github.com/JesusFilm/phoebe/issues/556)) are
changes in here, behind the contract the preload already exposes.
