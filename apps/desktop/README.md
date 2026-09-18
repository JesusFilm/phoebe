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
([#521 §4](https://github.com/JesusFilm/phoebe/issues/521)). It reads no `.env`.
The one secret it holds is the relay's device token, and that lives in main behind
`safeStorage` — never in the renderer, never on disk in the clear
([#523 §5](https://github.com/JesusFilm/phoebe/issues/523)).

**Electron floor: 44, and never below 35.** The secret envelope for a remote
`secret set` is built in the renderer by the same console code a browser runs
([#514](https://github.com/JesusFilm/phoebe/issues/514),
[#523 §6](https://github.com/JesusFilm/phoebe/issues/523)), which needs X25519 in
`crypto.subtle` — Chromium 134, Electron 35. `package.json` pins a current major
well above that; the floor is what a downgrade may not cross.

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

**The local arm, in full.** The installs on this machine, the Docker check, the
verb runs that drive them ([#555](https://github.com/JesusFilm/phoebe/issues/555))
and the local read loop that feeds their tabs
([#556](https://github.com/JesusFilm/phoebe/issues/556)):

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
- [`local-read.ts`](src/local-read.ts) — the read loop: Compose's event stream
  for the moment a container moves, a 15 s poll for how it is doing, and one
  `report` event out — the relay's own, so the tabs do not branch on arm.
- [`container-read.ts`](src/container-read.ts) — the two seams under it: the
  `phoebe status --json` exec, and the `docker compose events` subscription.

**The relay arm** ([#554](https://github.com/JesusFilm/phoebe/issues/554)):
sign-in, the JSON reads the renderer asks for, the relay's event stream re-emitted
over IPC, and sign-out. Main is the relay client — it holds the device token and
the renderer never sees it
([#523 §1](https://github.com/JesusFilm/phoebe/issues/523)).

Sign-in runs in the operator's own browser, because Google refuses an embedded
webview. Main mints a PKCE verifier, opens `${relay}/auth/device/start`, and the
relay comes back to `phoebe://auth?code=…`. The single-instance lock is what makes
that land on the process holding the verifier: on Windows and Linux the OS
launches a _second_ process with the URL on its command line, and without the lock
one process would hold the code and the other the verifier.

**The notifications** ([#559](https://github.com/JesusFilm/phoebe/issues/559)) sit
across both arms: [`alerting.ts`](src/alerting.ts) keeps the raised set and
decides what to show, and [`notify.ts`](src/notify.ts) is the Electron half —
`new Notification`, the dock badge, and the click that opens a page.

The loop reads `phoebe status --json` inside the container. That verb is
[#533](https://github.com/JesusFilm/phoebe/issues/533)'s and the report it prints
is [#532](https://github.com/JesusFilm/phoebe/issues/532)'s, so against a
container built from this branch the exec fails and every read comes back
`report: null` with the container's own sentence on it — which is the path the
tabs draw anyway when nothing is running. `STATUS_ARGV` in
[`src/container-read.ts`](src/container-read.ts) is the one line that moves when
those land.

Two things a later ticket owes this package. `upgrade` and `migrate` spawn their
children through `spawnSync`, which blocks main for as long as they run — so the
window freezes, and neither can be cancelled (`CANCELLABLE_VERBS` is `start` and
`stop`). And a run's lines are held only in memory, so quitting the app loses the
last run's output.
