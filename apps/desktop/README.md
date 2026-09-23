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
(`.phoebe/container/compose.yml`). Running the app needs the binary, and so does
packaging it.

## Packaging

```sh
vp run package   # electron-builder, this platform, into release/
```

The config is [`electron-builder.config.cjs`](electron-builder.config.cjs) and the
decisions behind it are [#525 §1–§2](https://github.com/JesusFilm/phoebe/issues/525):
mac arm64 dmg and zip, win x64 NSIS, linux x64 AppImage, all **unsigned** this
effort. On a release CI runs this same script on three runners and attaches the
artifacts to the `phoebe-agent@x.y.z` GitHub Release; a self-build gets the same
app, which is why the script is one command and not a document. What CI does with
it, and the one wiring step still outstanding, are in
[`docs/releasing.md`](../../docs/releasing.md).

`vp run -r build` first, from the root: packaging copies the console bundle and
this package's `dist/` rather than building either. Two directories ride along
beside the executable rather than inside the asar — the console bundle main loads
over the `phoebe://` scheme, and the `templates/` and `prompts/` `init` writes into
a folder, which is what `packageRoot()` in
[`src/verb-dispatch.ts`](src/verb-dispatch.ts) points at. A packaged main is a
bundle with no package around it to walk up through, so nothing here can be found
by the walk-up that works in a checkout.

Because the app carries no version of its own, the config reads the root
package's and injects it. It is the only reason the config is JavaScript rather
than YAML.

## Updating

One check shortly after launch, and nothing else moves on its own
([#525 §3](https://github.com/JesusFilm/phoebe/issues/525)). No poll. The download
waits for a click on the rail's notice, and the install waits for the app to quit
unless the operator asks for a restart. A tool that is driving Docker on someone's
machine does not swap itself out while they are watching.

- [`src/updates.ts`](src/updates.ts) — the rules, and every state the window can be
  shown. Three flags carry three of them: `autoDownload` false, `allowDowngrade`
  false, `autoInstallOnAppQuit` true.
- [`src/update-feed.ts`](src/update-feed.ts) — **follows the relay**
  ([#525 §5](https://github.com/JesusFilm/phoebe/issues/525)). Signed in, the feed
  is pinned to the relay's own version, so the only build ever offered is one that
  relay serves. Signed out, it is the newest stable release. Signed in to a relay
  that cannot be reached, there is no check at all — falling back to the newest
  build there is would offer one this relay may not serve.

**Two companions do not update.** macOS, until the signing task lands, because
Squirrel.Mac refuses an unsigned bundle: a macOS operator gets the new build from
[the releases page](https://github.com/JesusFilm/phoebe/releases), after the
Gatekeeper workaround below. And one run from a checkout, which is a `git pull`
away from newer. Both say which they are rather than sitting on a state that never
moves.

### Opening an unsigned build

macOS refuses a downloaded app that nobody signed. Right-click the app and choose
**Open**, or clear the quarantine flag by hand:

```sh
xattr -d com.apple.quarantine /Applications/Phoebe.app
```

Windows SmartScreen shows **More info → Run anyway** for the same reason. Both
stop once the signing task lands.

## What main answers today

**The local arm, in full.** The installs on this machine, the Docker check, the
verb runs that drive them ([#555](https://github.com/JesusFilm/phoebe/issues/555)),
the local read loop that feeds their tabs
([#556](https://github.com/JesusFilm/phoebe/issues/556)) the two writes that
change them ([#557](https://github.com/JesusFilm/phoebe/issues/557)) and pairing
([#558](https://github.com/JesusFilm/phoebe/issues/558)):

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
- [`verb-dispatch.ts`](src/verb-dispatch.ts) — the `run<Verb>` calls, in this
  process (ADR 0001). No second Node, no `bin.mjs`, no stdout parsing.
- [`secret-write.ts`](src/secret-write.ts) — the two secret writers and the rule
  that picks between them. A running install's value goes through the container
  into the tenant secret store; a stopped or freshly initialised one's goes into
  the deployment `.env` on this machine, which is where the first `GH_TOKEN` is
  typed. The value is piped on the child's stdin and never put in an argument.
- [`local-read.ts`](src/local-read.ts) — the read loop: Compose's event stream
  for the moment a container moves, a 15 s poll for how it is doing, and one
  `report` event out — the relay's own, so the tabs do not branch on arm.
- [`container-read.ts`](src/container-read.ts) — the two seams under it: the
  `phoebe status --json` exec, and the `docker compose events` subscription.
- [`pair.ts`](src/pair.ts) — the seventh verb, and the one the engine does not
  have: a mint on the relay, the address into the config, the token into the
  root `.env`, and an `up -d` so Compose recreates the container holding both
  ([#558](https://github.com/JesusFilm/phoebe/issues/558)). The token goes into
  the file and into no line.
- [`wsl.ts`](src/wsl.ts) — a local install inside a WSL distro. Windows shows the
  distro's files at `\\wsl.localhost\<distro>\…`, and every file this package
  reads or writes goes through that path unchanged. "Add a WSL folder" on the home
  page opens the picker at that root, because the Windows picker ignores a typed
  path and keeps distros under a "Linux" node at the foot of its tree; the button
  appears when `wsl.exe -l -q` lists a distro, which the environment probe
  reports as `wslDistros`. Docker does not: Compose run from Windows would resolve the
  deployment's bind mounts to UNC paths Docker Desktop cannot mount, and the
  containers are the distro's own. So for such an install every `docker` the
  companion would spawn — the `ps` behind the rail, the `status --json` exec,
  the events stream, `up`/`stop`, the stdin-fed `secret set`, pairing's nudge —
  runs as `wsl.exe -d <distro> --cd <dir> --exec docker …` with each path argument
  translated to the distro's. The rail and the install tab say which distro. This
  machine's own Docker check is not consulted for it; a distro with no Docker
  fails the read or the run with its own words. `docker events` under `wsl.exe`
  has one rough edge: killing the relay closes the pipe and the Linux side exits
  on the next write rather than at once.

**The relay arm**
([#554](https://github.com/JesusFilm/phoebe/issues/554)) is sign-in, the JSON reads
the renderer asks for, the relay's event stream re-emitted over IPC, and sign-out.
Main is the relay client — it holds the device token and the renderer never sees
it ([#523 §1](https://github.com/JesusFilm/phoebe/issues/523)).

Sign-in runs in the operator's own browser, because Google refuses an embedded
webview. Main mints a PKCE verifier, opens `${relay}/auth/device/start`, and the
relay comes back to `phoebe://auth?code=…`. The single-instance lock is what makes
that land on the process holding the verifier: on Windows and Linux the OS
launches a _second_ process with the URL on its command line, and without the lock
one process would hold the code and the other the verifier.

**The notifications** ([#559](https://github.com/JesusFilm/phoebe/issues/559)) sit
across both arms, and they are split between this package and the console for one
reason: the banner is the renderer's and the badge is main's
([#524 §2](https://github.com/JesusFilm/phoebe/issues/524), §4).

[`alerting.ts`](src/alerting.ts) is main's half. It runs the shared edge rule
over every local read — the same `src/contracts/alerts.ts` the relay runs, never
a second copy of it — and it keeps the raised set for both arms, which is what
the dock badge counts. The relay's own alerts arrive already decided and are
forwarded as they came; a local install's are computed here, because there is no
relay between a folder on this machine and the process watching it. The first
read of an install seeds it silently, so relaunching onto a fleet that was
already wedged does not re-fire everything.

Raising the notification is `apps/console/src/notifications.ts`, in the window:
the tag that folds a clear onto its raise, the silence, the suppression while the
window is focused, and the click. So the companion notifies while a window is
open, which is the same property T3 Code's desktop app has — there is no tray
item and no login item, by decision, and the badge is the only thing on screen
when the window is not.

`app.setBadgeCount` is the dock on macOS and the launcher on Linux. Windows has
no count on a taskbar button — it takes an overlay icon — so the badge is a
no-op there until packaging ([#561](https://github.com/JesusFilm/phoebe/issues/561))
gives it one to draw.

**The writes never reach that arm.** A
local install's config edit and secrets run against this machine even when the
same install is paired with a relay — so nothing in main builds an envelope, and
both forms in the console say so. The envelope exists for a deployment a console
can only reach through a server; this one is a folder. `config set` carries the
fingerprint the window was shown, so an edit composed against a config a terminal
has since changed is refused `stale` with the manual edit to make instead —
identically on both arms, which is what the fingerprint is for.

The loop reads `phoebe status --json` inside the container: the verb is
[#533](https://github.com/JesusFilm/phoebe/issues/533)'s and the report it prints
is [#532](https://github.com/JesusFilm/phoebe/issues/532)'s. A container running an
engine older than those answers the exec with its own sentence, and the read
comes back `report: null` with that sentence on it — the path the tabs draw
anyway when nothing is running. `STATUS_ARGV` in
[`src/container-read.ts`](src/container-read.ts) is the one line that moves if the
verb's flags do.

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
