# How T3 Code builds and ships its desktop and mobile clients

Research for [#518](https://github.com/JesusFilm/phoebe/issues/518) on the console map
([#497](https://github.com/JesusFilm/phoebe/issues/497)), read 2026-09-14 from the
[pingdotgg/t3code](https://github.com/pingdotgg/t3code) source at commit
`112a7088da63ea4fa48fee63dc8f29557c545ed7` (`112a708`, main as of 15:58 -0300 that day; main
had moved on to `549d182` by the time I finished, but every path below was read at `112a708`).
Stable is still `v0.0.40`; the current nightly is `0.0.41-nightly.20260914.1722`. This builds on
[t3-code-remote-relay.md](https://github.com/JesusFilm/phoebe/blob/research/t3-code-remote-relay/docs/research/t3-code-remote-relay.md),
which covered the transport; this one covers the clients themselves. Facts and links only.

## The short answers

- **Desktop is Electron 44, and the renderer is the same web bundle the server serves.** There is
  no second UI. `apps/desktop` bundles the Electron main process; `apps/web` is built once into
  `apps/server/dist/client` and the desktop loads that directory through a custom `t3code://`
  scheme, not through the local server
  ([apps/desktop/package.json](https://github.com/pingdotgg/t3code/blob/112a7088da63ea4fa48fee63dc8f29557c545ed7/apps/desktop/package.json)
  `"electron": "44.1.0"`;
  [apps/desktop/src/app/DesktopApp.ts](https://github.com/pingdotgg/t3code/blob/112a7088da63ea4fa48fee63dc8f29557c545ed7/apps/desktop/src/app/DesktopApp.ts)
  "The renderer is served from the bundled client (or Vite in development) rather than through the
  local backend, so the window can open without one").
- **Main owns the server child process, SSH, WSL, the updater, Clerk, snapshots and the browser
  preview. There is no tray or menu-bar presence.** I searched `apps/desktop/src` for `Tray` and
  found nothing. Notifications are the web `Notification` API from the renderer plus a dock or
  taskbar badge set over IPC.
- **Packaged with electron-builder 26 into DMG+zip, AppImage and NSIS; signed with Developer ID
  plus notarization on macOS and Azure Trusted Signing on Windows; Linux is unsigned.** Updates
  come from `electron-updater` reading `latest*.yml` or `nightly*.yml` off GitHub Releases. No app
  store for desktop. winget, Homebrew cask and AUR are listed as install routes; only AUR is
  automated in the repo.
- **Mobile is Expo 57 / React Native 0.86 with seven in-tree native modules (Swift and Kotlin).**
  Not a web wrapper. It supports T3 Connect (relay) and direct pairing (LAN, Tailscale, any
  reachable HTTPS or HTTP endpoint) but not SSH. Sign-in is Clerk's Expo SDK. Push is native
  APNs and FCM tokens registered with the relay, no Expo Push service. Distribution is App Store
  and Google Play via EAS Build with auto-submit, plus fingerprint-gated EAS OTA updates on every
  merge to main.
- **Shared code is two packages.** `packages/contracts` is the wire schema (RPC, HTTP, relay,
  desktop IPC) and `packages/client-runtime` is the connection supervisor, atom state and
  per-environment persistence contracts. Each client supplies a `platform.ts` layer implementing
  seven `Context.Service` tags. UI is not shared between web and mobile.
- **Local mode exists and is the default on desktop.** Main spawns the bundled server as a child
  with `ELECTRON_RUN_AS_NODE=1`, hands it a bootstrap payload over fd 3, waits on
  `/.well-known/t3/environment`, and the renderer authenticates to it with a bootstrap token.
  A setting turns the local server off and the app becomes a pure remote client.

## Desktop

### Framework and process layout

`@t3tools/desktop` at version `0.0.40`, `productName: "T3 Code (Alpha)"`, depends on
`electron 44.1.0`, `electron-updater ^6.6.2`, `electron-store`, `@clerk/electron`,
`@clerk/electron-passkeys`, `@napi-rs/keyring`, `dbus-next`, `ffi-rs`, `playwright-core` and
`react-grab`; devDependency `electron-builder 26.15.6`
([apps/desktop/package.json](https://github.com/pingdotgg/t3code/blob/112a7088da63ea4fa48fee63dc8f29557c545ed7/apps/desktop/package.json)).
Main is written in Effect, composed as layers in
[apps/desktop/src/main.ts](https://github.com/pingdotgg/t3code/blob/112a7088da63ea4fa48fee63dc8f29557c545ed7/apps/desktop/src/main.ts)
(229 lines, all wiring) and run by `DesktopApp.program`.

The Vite config bundles main the way the server CLI is bundled: everything inlined except
`electron` and a short list of native runtime externals, so "the packaged app then installs just
those externals, instead of a full production install of apps/desktop's dependency tree next to a
server bundle that already carries its own copy of the same libraries"
([apps/desktop/vite.config.ts](https://github.com/pingdotgg/t3code/blob/112a7088da63ea4fa48fee63dc8f29557c545ed7/apps/desktop/vite.config.ts)).
Five entries come out as CJS in `dist-electron/`: `main.cjs`, three worker scripts for window
focus and screen capture, and four preloads (`preload.cjs` with Clerk's bridge inlined,
`preview-pick-preload`, `preview-pip-preload`, `mac-permission-preload`). The Clerk publishable key
is a `define` baked in at build time.

The architecture doc records a rule that matters for anyone copying this: "Native modules never
load in the Electron main process on the startup path." `@crowecawcaw/xa11y` runs only in forked
Node-mode children and `ffi-rs` loads lazily for a few Win32 calls; "new native capability goes in
a child with a deadline, not an `import` in main"
([docs/internals/overview.md](https://github.com/pingdotgg/t3code/blob/112a7088da63ea4fa48fee63dc8f29557c545ed7/docs/internals/overview.md)).

### How the renderer relates to the web client

One bundle. `vp run build:desktop` runs `t3#build` (which depends on `@t3tools/web#build`) and
`@t3tools/desktop#build`, "so apps/server/dist holds the server bundle plus the web client and
apps/desktop/dist-electron the Electron main"
([.github/workflows/release.yml](https://github.com/pingdotgg/t3code/blob/112a7088da63ea4fa48fee63dc8f29557c545ed7/.github/workflows/release.yml),
job `build_bundle`). `DesktopEnvironment` resolves `clientAssetsDir` to
`<serverRoot>/apps/server/dist/client`
([apps/desktop/src/app/DesktopEnvironment.ts](https://github.com/pingdotgg/t3code/blob/112a7088da63ea4fa48fee63dc8f29557c545ed7/apps/desktop/src/app/DesktopEnvironment.ts)
line 219).

At bootstrap, main registers a privileged custom scheme (`t3code` in production, a dev variant
in development; both `standard`, `secure`, `supportFetchAPI`, `corsEnabled`, `stream`) and
serves that directory from disk with a Content-Security-Policy header; in development it proxies
to the Vite dev server instead
([apps/desktop/src/electron/ElectronProtocol.ts](https://github.com/pingdotgg/t3code/blob/112a7088da63ea4fa48fee63dc8f29557c545ed7/apps/desktop/src/electron/ElectronProtocol.ts)
lines 118 to 143, 258 to 281; `DesktopApp.ts` `registerDesktopProtocol`). The window then
`loadURL`s that origin
([apps/desktop/src/window/DesktopWindow.ts](https://github.com/pingdotgg/t3code/blob/112a7088da63ea4fa48fee63dc8f29557c545ed7/apps/desktop/src/window/DesktopWindow.ts)
line 682). The consequence, spelled out in
[docs/internals/remote.md](https://github.com/pingdotgg/t3code/blob/112a7088da63ea4fa48fee63dc8f29557c545ed7/docs/internals/remote.md):
"the desktop renderer is not served by the backend: the `t3code://` scheme serves the bundled
client from disk (Vite in development) and API traffic always goes to the environment's own URL."

The web app detects where it is running at module load. `isElectron` is
`window.desktopBridge !== undefined`, set by the preload's `contextBridge.exposeInMainWorld`
([apps/web/src/env.ts](https://github.com/pingdotgg/t3code/blob/112a7088da63ea4fa48fee63dc8f29557c545ed7/apps/web/src/env.ts);
[apps/desktop/src/preload.ts](https://github.com/pingdotgg/t3code/blob/112a7088da63ea4fa48fee63dc8f29557c545ed7/apps/desktop/src/preload.ts)).
The root route then picks one of three gate states: `hosted-pairing` (a `/pair` URL on the hosted
app), `hosted-static` (the hosted app, or desktop with its local server disabled), or the normal
server-auth gate
([apps/web/src/routes/__root.tsx](https://github.com/pingdotgg/t3code/blob/112a7088da63ea4fa48fee63dc8f29557c545ed7/apps/web/src/routes/__root.tsx)
lines 78 to 100). `isHostedStaticApp` is true when no backend URL is configured and either a
hosted channel is set or the origin matches the hosted app URL
([apps/web/src/hostedPairing.ts](https://github.com/pingdotgg/t3code/blob/112a7088da63ea4fa48fee63dc8f29557c545ed7/apps/web/src/hostedPairing.ts)
line 34). So one bundle serves three deployments: bundled into the desktop, served by the `t3`
CLI, and hosted on Vercel at `app.t3.codes`.

### What main owns

The `DesktopBridge` interface in the contracts package is the full list of what the renderer can
ask main for
([packages/contracts/src/ipc.ts](https://github.com/pingdotgg/t3code/blob/112a7088da63ea4fa48fee63dc8f29557c545ed7/packages/contracts/src/ipc.ts)
lines 1213 to 1360). Grouped:

- **Local backend(s).** `getLocalEnvironmentBootstraps`, `getLocalEnvironmentBearerToken`,
  `get/setLocalEnvironmentEnabled`, WSL state and distro, server exposure mode, Tailscale serve,
  advertised endpoints. See "Local mode" below.
- **SSH.** `discoverSshHosts`, `resolveSshHost`, `ensureSshEnvironment`,
  `disconnectSshEnvironment`, `fetchSshEnvironmentDescriptor`, `bootstrapSshBearerSession`,
  `fetchSshSessionState`, `issueSshWebSocketTicket`, password prompt callbacks. Main runs the
  SSH tunnel and the remote launch because "it can spawn SSH and handle authentication prompts"
  (remote.md). In production the remote runs "the exact release this app is on, from its
  self-contained archive, so it needs neither Node nor npm"
  ([main.ts](https://github.com/pingdotgg/t3code/blob/112a7088da63ea4fa48fee63dc8f29557c545ed7/apps/desktop/src/main.ts)
  `resolveDesktopSshCliRunner`).
- **Updates.** `getUpdateState`, `setUpdateChannel`, `checkForUpdate`, `downloadUpdate`,
  `installUpdate`, `onUpdateState`.
- **Notifications.** `setNotificationBadge({count, image})` and `onNotificationBadgeClear`. The
  handler sets `app.setBadgeCount` on macOS and Linux and a per-window overlay icon on Windows,
  and zeroes the count when a window has focus
  ([apps/desktop/src/ipc/methods/notificationBadge.ts](https://github.com/pingdotgg/t3code/blob/112a7088da63ea4fa48fee63dc8f29557c545ed7/apps/desktop/src/ipc/methods/notificationBadge.ts)).
  The notification itself is `new Notification(title, {body, tag, silent: true})` in the renderer,
  gated on `Notification.permission === "granted"` and the document not being focused
  ([apps/web/src/components/ThreadNotificationCoordinator.tsx](https://github.com/pingdotgg/t3code/blob/112a7088da63ea4fa48fee63dc8f29557c545ed7/apps/web/src/components/ThreadNotificationCoordinator.tsx)
  line 179). No `Electron.Notification`, no tray icon, no menu-bar item anywhere in
  `apps/desktop/src`. There is an application menu (`DesktopApplicationMenu.ts`) and a
  `QuitHold` overlay.
- **Shell affordances.** `pickFolder`, `pickProjectFavicon`, `pickThemeFiles`, `setTheme`,
  `showContextMenu`, `openExternal`, `openSystemSettings`, `pasteAsText`, `getSystemLocale`
  (the packaged app ships only the `en-US` Chromium locale pak, so the renderer cannot read the OS
  locale itself), `onMenuAction`, fullscreen state.
- **Desktop-only features.** The screen-capture "SnapShot" API, the browser `preview` bridge
  (webview tabs, cookie import, element picker, recording), Clerk passkeys, and
  `appActivation` for `npx t3 app` (open the current directory in the running desktop app).
- **Persistence.** `get/setClientSettings`, `get/set/clearConnectionCatalog`; saved environments
  live in main's `electron-store`, not in the renderer.

Cloud identity on desktop is `@clerk/electron` with a native passkey addon; the build derives the
Clerk frontend API hostname from the publishable key and the macOS build carries a provisioning
profile with Associated Domains for the passkey relying party
([apps/desktop/src/app/DesktopClerk.ts](https://github.com/pingdotgg/t3code/blob/112a7088da63ea4fa48fee63dc8f29557c545ed7/apps/desktop/src/app/DesktopClerk.ts);
[docs/operations/release.md](https://github.com/pingdotgg/t3code/blob/112a7088da63ea4fa48fee63dc8f29557c545ed7/docs/operations/release.md)
"Apple signing + notarization setup").

### Packaging

The whole electron-builder configuration is generated in code, not YAML:
[scripts/build-desktop-artifact.ts](https://github.com/pingdotgg/t3code/blob/112a7088da63ea4fa48fee63dc8f29557c545ed7/scripts/build-desktop-artifact.ts)
(3,900 lines) stages a pruned tree, writes a config, and shells out to
`electron-builder --projectDir <stage> --mac|--linux|--win --<arch> --publish never`. Key values
from `createBuildConfig` (lines 2621 to 2770):

| Field | Value |
| --- | --- |
| `appId` | `com.t3tools.t3code` |
| `productName` | `T3 Code (Alpha)` on stable, `T3 Code (Nightly)` on nightly |
| `artifactName` | `T3-Code-${version}-${arch}.${ext}` |
| mac target | `dmg` plus `zip` (the zip is the Squirrel.Mac update payload), category `public.app-category.developer-tools`, `t3code://` and `t3code-dev://` protocol handlers |
| linux target | `AppImage`, `executableName: t3code`, category `Development`, same protocol handlers via `MimeType=x-scheme-handler` |
| win target | `nsis` with `differentialPackage: true`, `signAndEditExecutable: true` |
| `electronLanguages` | `["en-US"]` only |

Payload trimming is aggressive and documented inline: source maps excluded ("the web client's maps
alone were 50 MB of app.asar that no request ever read"), `@anthropic-ai/claude-agent-sdk-*`
platform binaries excluded ("each a ~200MB bundled executable"), node-pty prebuilds for other
platforms excluded (lines 940 to 990). Windows ships the server tree as a separate
`resources/server.asar` sidecar so NSIS extracts "a handful of large archives instead of
thousands of small files", with a hard cap of 80 loose files in the unpacked app; macOS and Linux
put both processes in one `app.asar` (line 991 onward; release.md "Windows payload topology").
Windows also embeds the same-arch Linux CLI archive as `resources/wsl-runtime.tar.gz` for the WSL
backend. Extra resources include a Rust `t3-resource-monitor` binary per platform and, on Linux,
Rust capture helpers for KDE and Hyprland plus a libsecret helper.

The release assets for `v0.0.40` confirm the shape: `T3-Code-0.0.40-{arm64,x64}.dmg` and `.zip`
with `.blockmap`s, `T3-Code-0.0.40-x64.exe` with blockmap, `T3-Code-0.0.40-x86_64.AppImage`,
`latest.yml`, `latest-mac.yml`, `latest-linux.yml`, and `builder-debug.yml`
(`gh api repos/pingdotgg/t3code/releases/latest`). Sizes run 152 to 183 MB.

Six desktop jobs run per release, each on hardware of its own architecture: macOS arm64 and x64
(DMG), Linux x64 and arm64 (AppImage), Windows x64 and arm64 (NSIS). The platform-independent JS
is built once (`build_bundle`) and handed to every job as an artifact
([release.yml](https://github.com/pingdotgg/t3code/blob/112a7088da63ea4fa48fee63dc8f29557c545ed7/.github/workflows/release.yml);
[release-desktop.yml](https://github.com/pingdotgg/t3code/blob/112a7088da63ea4fa48fee63dc8f29557c545ed7/.github/workflows/release-desktop.yml)).
The same jobs build the self-contained CLI archives (a Node single-executable built with Node
26.8.2 `--build-sea`, the web client, the resource monitor, and the native externals) on every
platform except macOS x64, "because Node cannot produce a single executable for that platform"
([docs/user/install.md](https://github.com/pingdotgg/t3code/blob/112a7088da63ea4fa48fee63dc8f29557c545ed7/docs/user/install.md)).

### Signing

Signing is "optional and auto-detected per platform from secrets" (release.md). Per platform:

- **macOS.** `CSC_LINK`/`CSC_KEY_PASSWORD` (Developer ID Application .p12), `APPLE_API_KEY`,
  `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` (App Store Connect API key, for notarization),
  `APPLE_TEAM_ID`, and a base64 `MACOS_PROVISIONING_PROFILE` carrying Associated Domains for
  Clerk passkeys. The sign hook is
  [scripts/sign-macos.ts](https://github.com/pingdotgg/t3code/blob/112a7088da63ea4fa48fee63dc8f29557c545ed7/scripts/sign-macos.ts),
  a one-liner around `@electron/osx-sign` with `batchCodesignCalls: true`. The entitlements
  written at build time include `allow-jit`, `allow-unsigned-executable-memory` and
  `disable-library-validation` (build script lines 1298 to 1302), plus the associated-domains
  entitlement keyed on `${teamId}.${appId}`. Notarization runs through electron-builder's built-in
  `electron-notarize` (the workflow enables its debug namespace). The CLI archive is signed with
  the same certificate and every native addon inside it too, "since the hardened runtime refuses
  unsigned libraries" (release.md).
- **Windows.** Azure Trusted Signing with seven `AZURE_*` secrets, installed as the
  `TrustedSigning` PowerShell module on the runner and passed as `win.azureSignOptions`
  (release-desktop.yml "Prepare Azure Trusted Signing"; build script line 2757).
- **Linux.** "Signing disabled for linux" (release-desktop.yml). The AppImage is unsigned.

Preview builds from PRs (`desktop-macos-preview.yml`, label `preview:mac`) are built on macOS
arm64 only and never carry an update feed.

### Updates

`electron-updater` with the GitHub provider. The publish config is resolved at build time from
`T3CODE_DESKTOP_UPDATE_REPOSITORY` or `GITHUB_REPOSITORY` and is
`{provider: "github", owner, repo, releaseType: "prerelease" | "release", channel?: "nightly"}`
(build script lines 2540 to 2565). electron-builder writes `app-update.yml` into the app's
resources and `latest*.yml`/`nightly*.yml` manifests plus blockmaps as release assets. Per-arch
mac manifests are merged into one `latest-mac.yml` because the updater "reads one manifest per
platform and channel and picks the file entry whose name carries the running arch" (release.yml
"Merge macOS updater manifests"). Windows manifests carry no arch either and are merged the same
way.

Runtime behaviour, from
[apps/desktop/src/updates/DesktopUpdates.ts](https://github.com/pingdotgg/t3code/blob/112a7088da63ea4fa48fee63dc8f29557c545ed7/apps/desktop/src/updates/DesktopUpdates.ts):
`AUTO_UPDATE_STARTUP_DELAY = "15 seconds"`, `AUTO_UPDATE_POLL_INTERVAL = "4 minutes"`, no
automatic download or install ("The desktop UI shows a rocket update button when an update is
available; click once to download, click again after download to restart/install", release.md).
Two channels, `"latest" | "nightly"`
([ipc.ts](https://github.com/pingdotgg/t3code/blob/112a7088da63ea4fa48fee63dc8f29557c545ed7/packages/contracts/src/ipc.ts)
line 172), defaulting from the running version's suffix
([updateChannels.ts](https://github.com/pingdotgg/t3code/blob/112a7088da63ea4fa48fee63dc8f29557c545ed7/apps/desktop/src/updates/updateChannels.ts));
nightly sets `allowPrerelease`. An update whose version does not match the selected channel is
ignored (line 699). A third "preview" train exists for maintainers and is built with no publish
config at all, so "the build itself reports that no update feed is configured instead of
polling" (build script `isDesktopPreviewVersion`).

Two more update paths cross the desktop boundary. A remote client can ask a desktop-hosted server
to update: `DesktopRemoteUpdates.ts` implements a two-phase prepare/commit handoff with a token
and a 5-minute TTL, because "installing the app stops its bundled backend" and the commit must
not be lost with the socket
([docs/internals/server-updates.md](https://github.com/pingdotgg/t3code/blob/112a7088da63ea4fa48fee63dc8f29557c545ed7/docs/internals/server-updates.md)).
And the release graph is ordered `publish_cli` before `release` before `deploy_web` because
"Connected servers update to the client's exact version, not to an npm dist-tag" (release.md
"Server self-update release invariant").

### Channels and install routes

Stable is cut by promoting the latest nightly's commit ("stable only ever ships a build that
nightly users have already run", release.yml `resolve_commit`); a pushed `vX.Y.Z` tag builds that
exact commit. Nightlies are checked every 30 minutes and require new commits and six hours since
the last one. Version format `0.0.41-nightly.YYYYMMDD.<run>`.

Install routes in
[docs/user/install.md](https://github.com/pingdotgg/t3code/blob/112a7088da63ea4fa48fee63dc8f29557c545ed7/docs/user/install.md):
GitHub Releases download, `winget install T3Tools.T3Code`, `brew install --cask t3-code`,
`yay -S t3code-bin` and `t3code-nightly-bin`. Only AUR is automated in-repo
([packaging/aur/README.md](https://github.com/pingdotgg/t3code/blob/112a7088da63ea4fa48fee63dc8f29557c545ed7/packaging/aur/README.md):
"Both repackage the official x86_64 AppImage from GitHub Releases", pushed by
`publish-aur.yml` after each non-preview release). I found no winget or Homebrew automation in
`.github` or `scripts`; those manifests are maintained elsewhere. The npm route (`npx t3`) is
the CLI, not the desktop app: a `t3` launcher with `@t3code/t3-<platform>-<arch>`
optionalDependencies that "execs the installed executable"
([scripts/build-npm-platform-packages.ts](https://github.com/pingdotgg/t3code/blob/112a7088da63ea4fa48fee63dc8f29557c545ed7/scripts/build-npm-platform-packages.ts)).

## Mobile

### Framework

`@t3tools/mobile` is Expo SDK 57 (`expo ~57.0.18`, `react-native 0.86.3`, `react 19.2.3`) with
`expo-dev-client`, `expo-updates`, `expo-notifications`, `expo-secure-store`, `expo-sqlite`,
`expo-camera`, `expo-widgets`, `expo-sharing`, `@clerk/expo`, `react-native-nitro-modules`,
`uniwind` for styling and `@effect/atom-react` for state
([apps/mobile/package.json](https://github.com/pingdotgg/t3code/blob/112a7088da63ea4fa48fee63dc8f29557c545ed7/apps/mobile/package.json)).
Expo Go is unsupported: "Uses native modules so using Expo Go is not supported. You need to use
the Expo Dev Client"
([apps/mobile/README.md](https://github.com/pingdotgg/t3code/blob/112a7088da63ea4fa48fee63dc8f29557c545ed7/apps/mobile/README.md)).
Seven local Expo modules live under `apps/mobile/modules/` as `file:` dependencies:
`t3-agent-notifications` (Kotlin, FCM handler and Android Live Updates), `t3-composer-editor`
(Swift and Kotlin), `t3-markdown-text`, `t3-native-controls`, `t3-review-diff`,
`t3-subscription-widget`, `t3-terminal` (vendored native terminal). iOS Live Activities and home
screen widgets are built with `expo-widgets` and `@expo/ui/swift-ui`
([apps/mobile/src/widgets/AgentActivity.tsx](https://github.com/pingdotgg/t3code/blob/112a7088da63ea4fa48fee63dc8f29557c545ed7/apps/mobile/src/widgets/AgentActivity.tsx)).
The app is not a web view of `apps/web`; its screens are React Native components under
`apps/mobile/src/features/`.

[apps/mobile/app.config.ts](https://github.com/pingdotgg/t3code/blob/112a7088da63ea4fa48fee63dc8f29557c545ed7/apps/mobile/app.config.ts)
defines three variants installable side by side:

| Variant | Name | Bundle / package | Scheme |
| --- | --- | --- | --- |
| development | T3 Code Dev | `com.t3tools.t3code.dev` | `t3code-dev` |
| preview | T3 Code Preview | `com.t3tools.t3code.preview` | `t3code-preview` |
| production | T3 Code | `com.t3tools.t3code` | `t3code` |

App version `1.1.1` (independent of the desktop's `0.0.40`), `appleTeamId: "ARK85ZXQ4Z"`, iOS
deployment target 18.0, Android `minSdkVersion 24`, `supportsTablet: true`,
`NSAllowsArbitraryLoads: true` and a cleartext-traffic plugin for Android (so plain-HTTP LAN
pairing works), `NSLocalNetworkUsageDescription` "Allow T3 Code to connect to T3 Code servers on
your local network or tailnet", associated domains on `clerk.t3.codes`.

### Connection methods

The mobile platform layer registers the same `client-runtime` capabilities as web, with two
differences: `PrimaryEnvironmentAuth` always returns `Option.none()` (no bundled server), and
`SshEnvironmentGateway.provision` fails with "SSH environments are only available in the desktop
app"
([apps/mobile/src/connection/platform.ts](https://github.com/pingdotgg/t3code/blob/112a7088da63ea4fa48fee63dc8f29557c545ed7/apps/mobile/src/connection/platform.ts)
lines 156 to 185). That leaves two of the four connection target kinds:

- **Bearer (direct pairing).** `ConnectionsNewRouteScreen` scans a QR code with `expo-camera` or
  accepts a pasted host and code. `buildPairingUrl` defaults an IP literal to `http://` and a
  hostname to `https://`; `parsePairingUrl` reads the token from the URL fragment (or query) and
  also understands hosted-app pairing URLs and `t3code://…?pairingUrl=` QR payloads
  ([apps/mobile/src/features/connection/pairing.ts](https://github.com/pingdotgg/t3code/blob/112a7088da63ea4fa48fee63dc8f29557c545ed7/apps/mobile/src/features/connection/pairing.ts)).
  So LAN, Tailscale HTTPS, and any reachable endpoint all work; the user doc says "On mobile, an
  IP address entered without a scheme uses HTTP, so include `https://` when your server uses
  HTTPS"
  ([docs/user/remote-access.md](https://github.com/pingdotgg/t3code/blob/112a7088da63ea4fa48fee63dc8f29557c545ed7/docs/user/remote-access.md)).
- **Relay (T3 Connect).** Sign in, and linked environments appear as `RelayConnectionTarget`s
  (`CloudEnvironmentRows.tsx`, `features/cloud/`). The relay URL and Clerk config are baked in
  from `T3CODE_RELAY_URL`, `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY`, `EXPO_PUBLIC_CLERK_JWT_TEMPLATE`
  under `extra` in `app.config.ts`; "T3 Connect is optional and disabled in a fresh clone"
  (mobile README).

Connectivity comes from `expo-network` plus `AppState` foreground transitions; the wakeup stream
distinguishes "application-active-probe" from "application-active-reconnect" by how long the
app was backgrounded (`platform.ts` lines 46 to 110).

### Sign-in

`@clerk/expo`. `CloudAuthProvider.tsx` wraps the app in `ClerkProvider` with the Expo token
cache, and a `CloudAuthBridge` turns `useAuth()` into a relay token provider; every sign-in or
account switch clears the previous account's environments and requests the T3 Connect onboarding
sheet
([apps/mobile/src/features/cloud/CloudAuthProvider.tsx](https://github.com/pingdotgg/t3code/blob/112a7088da63ea4fa48fee63dc8f29557c545ed7/apps/mobile/src/features/cloud/CloudAuthProvider.tsx)).
The sign-in UI is Clerk's native `AuthView` and `UserProfileView` from `@clerk/expo/native`
([apps/mobile/src/features/settings/SettingsAuthRouteScreen.tsx](https://github.com/pingdotgg/t3code/blob/112a7088da63ea4fa48fee63dc8f29557c545ed7/apps/mobile/src/features/settings/SettingsAuthRouteScreen.tsx)
lines 1 to 2). The Clerk plugin enables Sign in with Apple except on Personal Team builds, and
native Google sign-in client IDs are passed through `extra` (app.config.ts). Android native
sign-in needs the `clerk://<applicationId>.callback` redirect allow-listed in the Clerk instance
([docs/operations/android-notifications.md](https://github.com/pingdotgg/t3code/blob/112a7088da63ea4fa48fee63dc8f29557c545ed7/docs/operations/android-notifications.md)).
The relay-side DPoP token and per-request proofs are in `features/cloud/dpop.ts` and the shared
`client-runtime/relay/managedRelay.ts`.

### Push

Native tokens, not Expo Push. `remoteRegistration.ts` checks notification permission, calls
`Notifications.getDevicePushTokenAsync()`, keeps the token only if `token.type === Platform.OS`,
and posts it with preferences to the relay through `ManagedRelayClient.registerDevice`
([apps/mobile/src/features/agent-awareness/remoteRegistration.ts](https://github.com/pingdotgg/t3code/blob/112a7088da63ea4fa48fee63dc8f29557c545ed7/apps/mobile/src/features/agent-awareness/remoteRegistration.ts)
lines 270 to 300, 400 to 450), which hits `RelayRegisterDeviceEndpoint`
([packages/contracts/src/relay.ts](https://github.com/pingdotgg/t3code/blob/112a7088da63ea4fa48fee63dc8f29557c545ed7/packages/contracts/src/relay.ts)
line 920; the `/v1/mobile/*` and `/v2/client/devices` routes seen in #498). Android re-registers
on an interval; a stale success after sign-out is discarded. The relay "sends them directly
through FCM HTTP v1; an Expo Push account is not required"; iOS uses APNs with the relay's
`APNS_*` secrets (android-notifications.md; release.md "T3 Connect relay deployment").

The user-facing rule: "Background delivery requires T3 Connect; a direct or Tailscale connection
alone does not enable push notifications. The mobile app does not need to maintain a connection
to your environment"
([docs/user/mobile-notifications.md](https://github.com/pingdotgg/t3code/blob/112a7088da63ea4fa48fee63dc8f29557c545ed7/docs/user/mobile-notifications.md)).
Ordinary alerts are suppressed while the app is foregrounded; ongoing activity (Android Live
Updates on API 36, iOS Live Activities) keeps updating.

### Distribution

EAS Build and EAS Update, project `d763fcb8-d37c-41ea-a773-b54a0ab4a454`, owner `pingdotgg`.
[apps/mobile/eas.json](https://github.com/pingdotgg/t3code/blob/112a7088da63ea4fa48fee63dc8f29557c545ed7/apps/mobile/eas.json)
has four build profiles (`development` dev-client internal, `preview` internal, `preview:dev`
dev-client APK, `production` with `autoIncrement`) and a `submit.production` block with iOS
`ascAppId: "6787819824"` and Android `track: "internal"`.

The production workflow runs on every push to `main` touching the mobile app or the shared
packages, and on Linux only ("never from a laptop") because the native fingerprint must be
computed in the same OS and pnpm as the EAS build. Per platform it (1) cuts and auto-submits a
store build if the latest production build's version differs from `app.config.ts`, "so bumping
`version` is therefore all it takes to start the next release train", and (2) publishes a
`production`-channel OTA if at least one finished production build matches the current native
fingerprint, otherwise skips and flags it
([.github/workflows/mobile-eas-production.yml](https://github.com/pingdotgg/t3code/blob/112a7088da63ea4fa48fee63dc8f29557c545ed7/.github/workflows/mobile-eas-production.yml)).
"Releasing to the App Store stays a manual App Store Connect step." A PR check labels
native-fingerprint changes so they can be batched before the next store submission
([mobile-fingerprint-check.yml](https://github.com/pingdotgg/t3code/blob/112a7088da63ea4fa48fee63dc8f29557c545ed7/.github/workflows/mobile-fingerprint-check.yml)),
and a PR labelled "🚀 Mobile Continuous Deployment" gets a per-PR EAS preview branch
([mobile-eas-preview.yml](https://github.com/pingdotgg/t3code/blob/112a7088da63ea4fa48fee63dc8f29557c545ed7/.github/workflows/mobile-eas-preview.yml)).

OTA at runtime: `expo-updates` with `checkAutomatically: "ON_LOAD"`, `fallbackToCacheTimeout: 0`,
runtime version policy `fingerprint` on preview and production, `appVersion` on development
(app.config.ts). `features/updates/app-updates.ts` checks, fetches, and reloads only after
flushing drafts and queued messages; the user doc says the app "can also download updates in the
background and apply them when you next leave the app"
([docs/user/updating.md](https://github.com/pingdotgg/t3code/blob/112a7088da63ea4fa48fee63dc8f29557c545ed7/docs/user/updating.md)).
`T3CODE_MOBILE_UPDATES_ENABLED=0` disables the OTA source for private builds.

Store status: install.md links the
[App Store](https://apps.apple.com/us/app/t3-code-remote-claude-more/id6787819824) and
[Google Play](https://play.google.com/store/apps/details?id=com.t3tools.t3code). I fetched the
App Store page on 2026-09-14: "T3 Code - Remote Claude & more", seller T3 Tools, Inc., version
1.1.0, requires iOS 18.0, category Developer Tools. The Play page did not render through my
fetch, so its live status is unverified. The mobile README still says "T3 Code Mobile is
currently in development and is not distributed yet", which is stale relative to install.md and
the store listing.

## Shared code

The architecture doc states the split: "Shared connection and domain state belongs in
`packages/client-runtime`; clients supply platform services and UI. Keeping that logic shared
prevents reconnect and multi-environment behavior from diverging between web and mobile"
([docs/internals/overview.md](https://github.com/pingdotgg/t3code/blob/112a7088da63ea4fa48fee63dc8f29557c545ed7/docs/internals/overview.md)).

**`packages/contracts`** (version-aligned with the release, `0.0.40`) is Effect `Schema` only,
one dependency (`effect`). Its modules are the wire boundaries: `rpc.ts` (1,454 lines, the
WebSocket RPC group), `environmentHttp.ts` (622, the environment's HTTP API), `relay.ts` (1,126,
the relay's HTTP API), `ipc.ts` (1,606, the desktop `DesktopBridge` and update/WSL/SSH/preview
types), `desktopBootstrap.ts` (the payload main hands the child server), `auth.ts`, `settings.ts`,
and the domain types (orchestration, threads, terminals, VCS, providers, keybindings). Exports
are `.`, `./settings`, `./relay`
([packages/contracts/package.json](https://github.com/pingdotgg/t3code/blob/112a7088da63ea4fa48fee63dc8f29557c545ed7/packages/contracts/package.json)).
"The RPC contract is the boundary between independently versioned clients and servers"; clients
negotiate features through the environment descriptor's capability flags, never a version number
(overview.md "Pull request linking compatibility").

**`packages/client-runtime`** depends on `contracts`, `shared`, `effect` and a few remark
packages. Its export map
([package.json](https://github.com/pingdotgg/t3code/blob/112a7088da63ea4fa48fee63dc8f29557c545ed7/packages/client-runtime/package.json))
lists about sixty entry points; the ones that matter here:

- `./connection`: the catalog of targets (`Primary | Bearer | Relay | Ssh`), registrations,
  credential and profile stores, the per-environment `supervisor.ts` (retry ladder from #498),
  `registry.ts`, `onboarding.ts` (`registerPairing`, `updateBearer`), `connectivity.ts`,
  `wakeups.ts`
  ([connection/catalog.ts](https://github.com/pingdotgg/t3code/blob/112a7088da63ea4fa48fee63dc8f29557c545ed7/packages/client-runtime/src/connection/catalog.ts),
  [connection/model.ts](https://github.com/pingdotgg/t3code/blob/112a7088da63ea4fa48fee63dc8f29557c545ed7/packages/client-runtime/src/connection/model.ts)
  lines 9 to 54).
- `./rpc`: Effect `RpcClient` over WebSocket, HTTP helpers, the session.
- `./authorization`: pairing exchange, bearer bootstrap, token store.
- `./relay`: `ManagedRelayClient` (DPoP-signed calls to the relay), discovery, error
  presentation.
- `./state/*`: atom-based read models (threads, orchestration, terminal, review, usage,
  connections, settings) consumed by both React DOM and React Native through
  `@effect/atom-react`.
- `./platform`: the seam. Seven `Context.Service` tags a client must supply:
  `CloudSession` (Clerk token), `RelayDeviceIdentity`, `ClientPresentation` (label, device
  type, scopes), `PrimaryEnvironmentAuth` (bearer for the bundled server), `SshEnvironmentGateway`,
  `PlatformConnectionSource` (the stream of platform-managed environments), and the persistence
  stores `ConnectionTargetStore`, `ConnectionRegistrationStore`, `EnvironmentCacheStore`
  ([platform/capabilities.ts](https://github.com/pingdotgg/t3code/blob/112a7088da63ea4fa48fee63dc8f29557c545ed7/packages/client-runtime/src/platform/capabilities.ts),
  [platform/source.ts](https://github.com/pingdotgg/t3code/blob/112a7088da63ea4fa48fee63dc8f29557c545ed7/packages/client-runtime/src/platform/source.ts),
  [platform/persistence.ts](https://github.com/pingdotgg/t3code/blob/112a7088da63ea4fa48fee63dc8f29557c545ed7/packages/client-runtime/src/platform/persistence.ts)).

**Where the clients diverge.** Each has one file that fills those tags:
[apps/web/src/connection/platform.ts](https://github.com/pingdotgg/t3code/blob/112a7088da63ea4fa48fee63dc8f29557c545ed7/apps/web/src/connection/platform.ts)
(navigator.onLine connectivity; `PrimaryEnvironmentAuth` reads the desktop bridge's bearer token
when in Electron; `PlatformConnectionSource` emits the desktop's local backends; SSH goes through
`desktopBridge.ensureSshEnvironment`) and
[apps/mobile/src/connection/platform.ts](https://github.com/pingdotgg/t3code/blob/112a7088da63ea4fa48fee63dc8f29557c545ed7/apps/mobile/src/connection/platform.ts)
(expo-network connectivity; no primary; SSH unsupported; storage in `expo-sqlite` and
`expo-secure-store`). Desktop is not a third client; it is web plus a `desktopBridge` global.
Mobile also keeps a hot-swappable atom runtime for Metro Fast Refresh that production does not
use
([docs/internals/mobile-development.md](https://github.com/pingdotgg/t3code/blob/112a7088da63ea4fa48fee63dc8f29557c545ed7/docs/internals/mobile-development.md)).
UI is not shared at all: web uses `@base-ui/react`, Lexical, TanStack Router and Tailwind; mobile
uses React Navigation, `@expo/ui`, uniwind and the native modules above. `packages/shared` (not
in the ticket's question) holds the bits both server and clients need: relay auth helpers, CLI
release naming, the hosted-pairing URL reader.

CI treats the two shared packages as part of the mobile app: changes under
`packages/client-runtime/**` or `packages/contracts/**` trigger the production EAS workflow and
the fingerprint check (mobile-eas-production.yml `paths`).

## Local mode

Desktop's default is to run its own server. The sequence in `DesktopApp.ts` `bootstrap`:

1. Register the `t3code://` protocol and IPC handlers, so the window can open with or without a
   backend.
2. If `settings.localEnvironmentEnabled` is false, log "skipping local environment" and open the
   main window straight away.
3. Otherwise pick a port: `DEFAULT_DESKTOP_BACKEND_PORT = 3773`, scanning upward until a port is
   free on all of `127.0.0.1`, `0.0.0.0` and `::`
   ([DesktopApp.ts](https://github.com/pingdotgg/t3code/blob/112a7088da63ea4fa48fee63dc8f29557c545ed7/apps/desktop/src/app/DesktopApp.ts)
   lines 37 to 40, 78 to 105). Development requires an explicit `T3CODE_PORT`.
4. Spawn the primary backend through `DesktopBackendPool`. The start config is
   `executablePath: process.execPath` (Electron itself), `args: [backendEntryPath,
   "--bootstrap-fd", "3"]`, `env: { ELECTRON_RUN_AS_NODE: "1" }`, with the bootstrap payload
   `{mode: "desktop", noBrowser: true, port, t3Home, host, desktopBootstrapToken,
   tailscaleServeEnabled, tailscaleServePort, desktopTelemetryFd: 4,
   desktopTelemetryControlFd: 5, resourceMonitorPath}` delivered over fd 3
   ([DesktopBackendConfiguration.ts](https://github.com/pingdotgg/t3code/blob/112a7088da63ea4fa48fee63dc8f29557c545ed7/apps/desktop/src/backend/DesktopBackendConfiguration.ts)
   lines 507 to 543;
   [contracts/desktopBootstrap.ts](https://github.com/pingdotgg/t3code/blob/112a7088da63ea4fa48fee63dc8f29557c545ed7/packages/contracts/src/desktopBootstrap.ts)).
   On Windows the entry is inside `resources/server.asar`; on macOS and Linux it is
   `apps/server/dist/bin.mjs` inside `app.asar`.
5. Wait for HTTP readiness at `/.well-known/t3/environment`, 1-minute timeout, 100 ms interval;
   restart on exit with a 500 ms to 10 s backoff; stop the restart loop after five fatal
   preflight failures and surface the reason
   ([DesktopBackendManager.ts](https://github.com/pingdotgg/t3code/blob/112a7088da63ea4fa48fee63dc8f29557c545ed7/apps/desktop/src/backend/DesktopBackendManager.ts)
   lines 53 to 66).
6. The renderer reads `desktopBridge.getLocalEnvironmentBootstraps()` (one entry per pool
   instance, the primary with id `"primary"`) and asks main for a bearer token; main exchanges
   the `desktopBootstrapToken` at the backend's `/api/auth/bootstrap/bearer` once and caches the
   session
   ([DesktopLocalEnvironmentAuth.ts](https://github.com/pingdotgg/t3code/blob/112a7088da63ea4fa48fee63dc8f29557c545ed7/apps/desktop/src/backend/DesktopLocalEnvironmentAuth.ts)).
   The primary then connects as a `PrimaryConnectionTarget` on same-origin cookie auth; a
   parallel WSL backend connects as a `BearerConnectionRegistration` on its own loopback port
   ([client-runtime connection/catalog.ts](https://github.com/pingdotgg/t3code/blob/112a7088da63ea4fa48fee63dc8f29557c545ed7/packages/client-runtime/src/connection/catalog.ts)
   "Platform-managed registrations").

Discovery is therefore not network discovery. Main knows the port because it chose it and the
renderer learns it over IPC. The listener binds `127.0.0.1` unless the user picks
`network-accessible` in Settings, which binds `0.0.0.0` and restarts the app (the direct/LAN row
in #498). Other machines' local servers are never auto-discovered; they are added by pairing URL.
`npx t3 app` from a terminal talks to the running desktop app through the `appActivation` bridge,
not through the server.

Turning the local server off is a first-class mode: "the desktop setting `localEnvironmentEnabled`
turns that off. Changing it relaunches the app; no local state is deleted. On the next start the
main process skips port selection, server exposure, and the primary and WSL backends, and opens
the window right away. The renderer sees this through `desktopBridge.getLocalEnvironmentEnabled()`
… only saved environments (pairing, relay, SSH) connect" (remote.md "Desktop without a local
environment"). In that mode the desktop app behaves like the hosted web app plus SSH.

## What is unknown or unverified

- Google Play listing state (the page did not render through my fetch). The App Store listing is
  live at version 1.1.0; the repo says 1.1.1, so a submission is presumably in flight.
- Who maintains the winget and Homebrew cask manifests, and how they are updated. Nothing in the
  repo does it.
- Whether the AppImage self-update actually works on every distro; electron-updater supports it
  and `latest-linux.yml` ships, but I did not trace `DesktopPreReadyPlatform`'s `Exec` refresh
  beyond the note in overview.md that "AppImage updates can remove the previous executable".
- Whether the desktop offers any always-on presence (tray, login item) at all. I found no `Tray`
  and no `setLoginItemSettings`; the "keep this machine reachable" story is the systemd/launchd
  service from #498, not the desktop app.
- The exact list of Clerk sign-in strategies enabled on mobile. `AuthView` renders whatever the
  Clerk instance is configured for; the config only shows Apple and Google client IDs being
  passed through.
