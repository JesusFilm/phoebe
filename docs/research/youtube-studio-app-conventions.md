# What youtube-studio's app guidelines require of a new desktop or mobile app

Research for [#519](https://github.com/JesusFilm/phoebe/issues/519) on the Phoebe console map
([#497](https://github.com/JesusFilm/phoebe/issues/497)), read 2026-09-14. Every source is a file
in the private repo `JesusFilm/youtube-studio` at `main` = `3cad5d4eeaa8c97b193af7bf8ff45c356b1060fd`
(the commit at read time; paths below are relative to that tree). The conflict section reads the
resolution comments on Phoebe issues #506, #514 and #515. Facts only; the map decides.

One framing note before the checklist. The repo has two app families and they do not share a
toolchain. Desktop apps (Resonance, Wheat, Insights) are Electron shells built by Vite through
`vp`, under `apps/`. Native apps (Reach, Hearth) are Expo under `expo-apps/`, bundled by Metro,
tested by jest-expo, shipped through EAS. Both sit in one pnpm workspace with one lockfile. A new
app picks a family first; most lines below apply to one family or the other, and the checklist
says which.

## Checklist

Each line is one requirement and the path that states it. "Both" means the rule applies to either
family. Quoted words are the source's.

### Workspace and toolchain (both)

- [ ] Run every install, check, test and build through the global `vp` CLI; do not call `pnpm`, `npm`, `vitest`, `tsc`, `eslint` or `prettier` directly. `AGENTS.md` ("Toolchain: everything goes through `vp`")
- [ ] Per-package tooling config lives in `vite.config.ts` (lint, fmt, test, build, pack blocks); no `vitest.config.ts`, `.eslintrc` or `.prettierrc`. `AGENTS.md`
- [ ] Reference shared dependency versions as `"catalog:"`, and add or remove them with `vp add` / `vp remove` rather than editing `package.json` by hand. `AGENTS.md` ("Dependencies are catalog-managed"); catalog in `pnpm-workspace.yaml`
- [ ] The workspace globs are `apps/*`, `packages/*`, `tools/*`, `expo-apps`, `expo-apps/apps/*`, `expo-apps/packages/*`, `expo-apps/modules/*`, `expo-apps/services/*`; a new app goes in one of those. `pnpm-workspace.yaml`
- [ ] The workspace uses `nodeLinker: hoisted` (Metro needs a flat `node_modules`); a new app must tolerate a hoisted tree. `pnpm-workspace.yaml`
- [ ] Two React lines coexist on purpose: default catalog `react ^19.2.6`, `catalog:expo` `react 19.1.0`. Peer checks for `react`, `react-dom`, `react-native` and `@types/react` are set to `allowedVersions: "*"`, and `@types/react` is pinned `~19.1.0` everywhere because the exact 19.1.0 wins the hoist. `pnpm-workspace.yaml`
- [ ] Node `>=22.13.0`; `packageManager` is `pnpm@11.2.2` via corepack. root `package.json`; `expo-apps/AGENTS.md` ("Toolchain")
- [ ] Native build scripts run only for packages listed under `allowBuilds` in `pnpm-workspace.yaml` (`better-sqlite3`, `electron`, `lzma-native`, `esbuild`, `llama.rn` are `true`; `opensrc`, `unrs-resolver`, `electron-winstaller`, `sharp`, `workerd`, the `@ffprobe-installer/*` platform packages are `false`). A new native dependency needs an entry or `pnpm install` fails with `ERR_PNPM_IGNORED_BUILDS`. `pnpm-workspace.yaml`
- [ ] A 24-hour `minimumReleaseAge` gate applies to lockfile changes in CI; packages published less than a day ago fail `setup-vp`'s `vp install`. `docs/agents/phoebe.md` ("Engine upgrades"); `minimumReleaseAgeExclude` in `pnpm-workspace.yaml`
- [ ] Tests import the runner from `vite-plus/test`, not `vitest`, and import sources with explicit `.ts` extensions; the lint rule `vite-plus/prefer-vite-plus-imports` is an error. `AGENTS.md` ("Tests"). Expo packages are the exception, below.
- [ ] `vp run ready` is the gate to pass before work is done: `vp check && vp run -r lint && vp run -r typecheck && vp run -r test && vp run -r build`. `AGENTS.md`; root `package.json` `scripts.ready`
- [ ] CI runs the same gate on every PR via `.github/workflows/ready.yml`. `expo-apps/AGENTS.md`; `expo-apps/README.md`
- [ ] Code shared across both families lives in root `packages/*` (today `packages/shared`) and must be pure TS with no React or react-native imports. `AGENTS.md`; `expo-apps/AGENTS.md`; `CONTEXT-MAP.md`
- [ ] Any code that calls, stores, caches or displays YouTube API data follows `.github/instructions/*.instructions.md` (the single source; mirrored into `.coderabbit.yaml`, the `youtube-compliance` skill and `.cursor/rules`). Apps with no YouTube surface are exempt, and say so. `AGENTS.md` ("YouTube API compliance"); `docs/jfp-viewer-app-prd.md` ("Problem Statement")
- [ ] Finish issue work by opening the PR yourself from a branch named `<type>/<issue>-<slug>`, title `<type>(<scope>): <summary> (#<issue>)`, body with `Closes #<issue>`. `AGENTS.md` ("Finishing issue work")
- [ ] Vendored skills under `.agents/skills/` and `.claude/skills/` are pinned in `skills-lock.json` and never edited in place; repo-local rules go in `AGENTS.md`. `AGENTS.md` ("Skills")
- [ ] Prose a person will read (PR bodies, docs, commit messages) runs through the `unslop` skill; `AGENTS.md`, `CLAUDE.md`, `SKILL.md`, `docs/agents/`, `CONTEXT-MAP.md`, per-package `CONTEXT.md` and ADRs keep their structure. `AGENTS.md` ("User-facing prose runs through unslop")

### Registering in the domain map (both)

- [ ] Add a `CONTEXT.md` at the app root with its domain language, and a one-line entry under "Contexts" in root `CONTEXT-MAP.md` linking it. Every existing app (Resonance, Wheat, Insights, JFP Viewer) has one. `CONTEXT-MAP.md`; `docs/agents/domain.md` ("File structure")
- [ ] Context-scoped decisions go in `apps/<app>/docs/adr/`; system-wide ones in `docs/adr/`. `docs/agents/domain.md`
- [ ] `CONTEXT.md` and ADRs follow the formats in `.claude/skills/domain-modeling/CONTEXT-FORMAT.md` and `ADR-FORMAT.md`. `AGENTS.md` ("User-facing prose runs through unslop"); `docs/agents/domain.md`
- [ ] Use the glossary's terms in issue titles, test names and proposals; flag any contradiction with an existing ADR explicitly. `docs/agents/domain.md`
- [ ] Phoebe is not an app in this repo. `phoebe-agent` is an exact-pinned root devDependency (`0.10.0` at read time) for config types only; the engine ref is pinned in root `phoebe.config.ts`; `.phoebe/` holds the prompts, Dockerfile, compose files and `.env.example`. `docs/agents/phoebe.md`; root `package.json`; `AGENTS.md` ("Agent tooling")
- [ ] Phoebe's `installCommand` is `vp install --ignore-scripts`; a new app's `postinstall` will not run inside the Phoebe container, and `vp run ready` must stay pure JS end to end. `docs/agents/phoebe.md` ("Toolchain commands")

### Desktop family: Electron under `apps/` (Resonance, Wheat, Insights)

- [ ] Layout: `main.ts` and `preload.ts` at the app root, renderer under `src/`, `"main": "dist-electron/main.js"`; scripts `dev: vp dev`, `build: vp build`, `start: electron .`, `test: vp test`. `apps/resonance/package.json`; `apps/wheat/package.json`
- [ ] `vite.config.ts` uses `defineConfig` from `vite-plus`, `@vitejs/plugin-react`, and `vite-plugin-electron/simple` with `main` and `preload` entries built to `dist-electron/`; Electron-side `rollupOptions.external` lists native modules (`better-sqlite3`, `electron`, `playwright`). `apps/resonance/vite.config.ts`
- [ ] Alias and dedupe `react` and `react-dom` to one resolved copy, because the hoisted workspace puts Expo's React 19.1 beside the studio's 19.2 and the shell fails to mount otherwise. `apps/resonance/vite.config.ts` (comment in `resolve.alias`)
- [ ] Vitest config lives in the `test` block of `vite.config.ts` (`include: src/**/*.test.{ts,tsx}`, a `setupFiles` entry); Electron is shimmed for tests via an alias to `src/test-shims/electron.ts`. `apps/resonance/vite.config.ts`
- [ ] Each desktop app takes a fixed dev port with `strictPort: true`: Resonance 5174, Wheat 5175, Insights 5176 (Reach web is 8081). A new app takes the next one and registers it in the lifecycle script. `apps/resonance/vite.config.ts`; `scripts/dev-app-lifecycle.sh` (`app_port`)
- [ ] Agents stop the dev server before edits and resume only if it was running: `scripts/dev-app-lifecycle.sh {status|stop-if-running|resume-if-was-running|start} <app>`; state lives in `.cursor/dev-app-state/<app>.was-running`; the app must be added to the script's `case` arms (`app_port`, `app_process_running`, `stop_*`, `start_app`, `main`). `AGENTS.md` ("Cursor agent dev lifecycle"); `scripts/dev-app-lifecycle.sh`
- [ ] Secrets come from Doppler project `yt-studio`, config `dev` (override with `DOPPLER_CONFIG`), into a gitignored `apps/<app>/.env`, via a per-app `fetch-secrets` script (`node scripts/fetch-secrets.mjs`) that `vp run -r fetch-secrets` sweeps. The fetch replaces the file, no merge; keys are filtered by an app prefix (`RESONANCE_*`, `WHEAT_*`); ship an `.env.example`. `AGENTS.md` ("Secrets (Doppler)"); `apps/resonance/scripts/fetch-secrets.mjs`
- [ ] Never commit `.env` or real secret values. `AGENTS.md` ("Secrets (Doppler)")
- [ ] YouTube OAuth for desktop apps goes through the workspace package `packages/youtube-auth` (Electron main-process PKCE loopback, `safeStorage` token store, quota-aware retry, `withRequestTimeout`); it is studio-only and not for Metro/Expo. `CONTEXT-MAP.md`
- [ ] Distribution is self-build: operators clone, `vp install`, `vp run package`; no hosted binaries; updates are `git pull` then rebuild. `apps/resonance/docs/BUILD_YOUR_OWN.md`
- [ ] `package` script = `vp build && <stage extra resources> && electron-builder --config electron-builder.config.ts --publish never`; output goes to `release/` (gitignored). `apps/resonance/package.json`; `apps/resonance/src/main/electron-packaging.ts` (`PACKAGING_OUTPUT_DIR`)
- [ ] electron-builder targets: Windows `portable` x64 (single `.exe`, no installer); macOS `dir` plus `zip` (no `.dmg`); `asar: false`; `npmRebuild: true`; artifact name `<Product>-<version>-${os}-${arch}.${ext}`. `apps/resonance/src/main/electron-packaging.ts` (`createElectronBuilderConfig`); `apps/resonance/docs/BUILD_YOUR_OWN.md` ("Artifacts")
- [ ] Build on the OS you run on; there is no cross-compilation, and artifacts built locally carry no Mark-of-the-Web or quarantine attributes. `apps/resonance/docs/BUILD_YOUR_OWN.md`
- [ ] The packaged `package.json` is rewritten in `beforePack` to only the runtime dependencies electron-builder must collect (`better-sqlite3`, `dotenv`, `node-fetch`, `playwright` for Resonance), restored in `afterPack`, and bundled or workspace deps (`shared`, `react`, `react-dom`, `zustand`) are stripped from the packaged app's `package.json`. `apps/resonance/electron-builder.config.ts`; `apps/resonance/src/main/electron-packaging.ts`
- [ ] `files` in the builder config: `dist/**`, `dist-electron/**`, `prompts/**`, `package.json`, excluding `src/**`, `scripts/**`, `*.test.*`, `release/**`. `apps/resonance/src/main/electron-packaging.ts`
- [ ] `appId` is reverse-DNS `org.jesusfilm.<app>`; mac `category` is `public.app-category.productivity`. `apps/resonance/src/main/electron-packaging.ts`
- [ ] User data (settings, OAuth tokens, databases, logs) lives in `app.getPath('userData')` (`%APPDATA%\<app>` on Windows, `~/Library/Application Support/<app>` on macOS), never beside the executable, so a rebuild keeps state. `apps/resonance/docs/BUILD_YOUR_OWN.md`
- [ ] A packaged app reads OAuth client credentials from a JSON file in the user data directory (`youtube-oauth-client.json` with `clientId` and `clientSecret`); environment variables win when set; in dev the same values come from `.env`. `apps/resonance/docs/BUILD_YOUR_OWN.md` ("YouTube OAuth credentials")
- [ ] What Resonance persists in user data: `settings.json`, `youtube-oauth-token.bin` (encrypted refresh token), `playwright-session/`, `data/*_fingerprints.db`, `logs/`; retention is documented in the app's `COMPLIANCE.md`. `apps/resonance/docs/BUILD_YOUR_OWN.md`
- [ ] A `postinstall` that downloads binaries must be guarded on `EAS_BUILD` (Resonance skips `playwright install chromium` when it is set), because EAS runs one root install for the whole workspace. `apps/resonance/package.json`; `.easignore`
- [ ] Heavy Electron installs on EAS build VMs are skipped by `ELECTRON_SKIP_BINARY_DOWNLOAD=1` in every EAS profile's `env`. `expo-apps/apps/reach/eas.json`; `expo-apps/apps/hearth/eas.json`; `.easignore`
- [ ] Root scripts alias the flagship: `dev` is `vp run resonance#dev`, `package` is `vp run resonance#package`. Other apps use `vp run <pkg>#<script>`. root `package.json`; `AGENTS.md` ("Workspace-aware execution")

### Native family: Expo under `expo-apps/` (Reach, Hearth)

- [ ] Expo SDK 54 (React Native 0.81, React 19.1), Expo Router, Tamagui (`@tamagui/core`), strict TypeScript. `expo-apps/AGENTS.md` ("Toolchain"); `pnpm-workspace.yaml` (`catalogs.expo`)
- [ ] Viewer packages reference `catalog:expo`; the named catalog in root `pnpm-workspace.yaml` is the pin set. `expo install --fix` is the source of SDK-correct versions, and what it resolves is mirrored into the catalog by hand (it cannot spawn pnpm in this PATH setup). `expo-apps/AGENTS.md`; `pnpm-workspace.yaml`
- [ ] Install at the repo root; there is no `expo-apps/`-local lockfile. `expo-apps/AGENTS.md`; `expo-apps/README.md`
- [ ] Build, dev and EAS work use `expo` and `eas` directly (`pnpm run reach`, `pnpm run hearth`, `pnpm run export:web` from `expo-apps/`); `vp run -r lint|typecheck|test` sweeps the viewer scripts so the root gate covers them. `AGENTS.md` (the `expo-apps/` exception); `expo-apps/AGENTS.md`
- [ ] Root `vite.config.ts` excludes `expo-apps/**` from `fmt`/`lint` and root `tsconfig.json` excludes it from type-check; eslint-config-expo and each package's `tsc` own those. Keep it that way. `expo-apps/AGENTS.md`
- [ ] Tests use jest-expo (plus React Native Testing Library), not `vite-plus/test`; one shared flat `eslint.config.js`, each `lint` script is `eslint .`. `expo-apps/AGENTS.md` ("Testing", "Common commands")
- [ ] Each app's `typecheck` script regenerates the gitignored expo-router typed-routes file (`apps/*/.expo/types/router.d.ts`) first via `node ../../scripts/generate-router-types.mjs`; deleting that file by hand is always a safe recovery. `expo-apps/AGENTS.md`; `AGENTS.md`
- [ ] Layout: `expo-apps/apps/<app>` is a thin Expo Router shell (routes, providers, hooks); `expo-apps/packages/design` holds tokens, themes and presentational screens; `packages/core` and `packages/api` are the focus/player and GraphQL-codegen seams. `expo-apps/AGENTS.md` ("Layout"); `expo-apps/packages/design/DESIGN.md`
- [ ] Do not style in `apps/<app>/app/**` except platform wiring; presentational components go under `packages/design/src/` and are exported from `src/index.ts`. `expo-apps/packages/design/DESIGN.md` ("How to change the look", "Adding new UI")
- [ ] Text goes through `AppText` with a `variant` (`eyebrow`, `caption`, `body`, `bodyMedium`, `bodyLg`, `bodyLgBold`, `title`, `headline`, `display`, `verse`) and a `tone` (`default`, `muted`, `subtle`, `brand`, `onPrimary`); no raw `fontSize` or inline hex. `expo-apps/packages/design/DESIGN.md` ("Typography roles")
- [ ] Spacing uses `tokens.space.*` (`xxs` 2, `xs` 4, `sm` 8, `md` 16, `lg` 24, `xl` 40, `xxl` 56); colors via `useThemeColors()` or `AppText` tones; shadows via `shadows.sm`/`shadows.md`. `expo-apps/packages/design/DESIGN.md`
- [ ] Web column widths: `REACH_PHONE_COLUMN_MAX_WIDTH` 480, `REACH_WIDE_COLUMN_MAX_WIDTH` 720; compare web at about 414 px, not desktop width. `expo-apps/packages/design/DESIGN.md` ("Web column width")
- [ ] Figma is not the source of truth; `src/themes.ts`, `src/tokens.ts`, `src/typography.ts` are. `expo-apps/packages/design/DESIGN.md`
- [ ] Before "done": Android and iOS side by side on the same Metro bundle, web at a narrow viewport, light and dark. `expo-apps/packages/design/DESIGN.md` ("Tri-platform verification")
- [ ] `eas.json` has `cli.version >= 20.0.0`, `appVersionSource: remote`, a shared `base` profile (`node: 22.13.0`, `distribution: internal`, `env.ELECTRON_SKIP_BINARY_DOWNLOAD: "1"`), and `preview` / `production` profiles with a `channel` of the same name; Reach adds `development` (dev client) and `testflight` (store, `autoIncrement`); Hearth adds `preview-tv` with `EXPO_TV=1`. `expo-apps/apps/reach/eas.json`; `expo-apps/apps/hearth/eas.json`; `expo-apps/README.md`
- [ ] `expo-updates` is a dependency, `app.json` carries a `runtimeVersion` policy, and each app is `eas init`'d (`owner`, `projectId`, `updates.url` in `app.json`). Cloud builds and submits need the JFP Expo account and do not run in CI. `expo-apps/README.md` ("EAS builds & OTA updates")
- [ ] `.easignore` is the EAS upload filter (EAS archives from the git root and runs one root `pnpm install`), so it excludes only `**/node_modules/`, `**/dist/`, `**/dist-electron/`, `**/.turbo/`, native `android/`/`ios/` dirs, and `.github/`, `.phoebe/`, `.cursor/`, `.claude/`; it must keep every workspace `package.json` plus the root lockfile. `.easignore`
- [ ] TV builds go through `@react-native-tvos/config-tv` plus Expo CNG, driven by `EXPO_TV`; the TV app's React Native for Web export is the smart-TV/kiosk deliverable. `docs/jfp-viewer-app-prd.md` ("Repo & toolchain"); `expo-apps/AGENTS.md`
- [ ] Two-app split by input model (touch vs 10-foot) rather than one tree. `docs/jfp-viewer-app-prd.md`
- [ ] Focus/spatial navigation and the video player are stable interfaces with per-platform implementations; the pure logic (focus-graph traversal, player state machine) is the unit-test target. Tests are mandated for focus core, player state machine, data layer and the thin design/shell layers. `docs/jfp-viewer-app-prd.md` ("Deep modules", "Testing Decisions")
- [ ] Anonymous-first identity behind a provider-agnostic boundary; audience may include minors, so privacy-by-default and no behavioral ad targeting are standing constraints. `docs/jfp-viewer-app-prd.md` ("Architecture seams deferred")
- [ ] Cross-tool agent guidance anchors on `AGENTS.md`, with editor configs deferring to it. `AGENTS.md` ("Project guide"); `docs/jfp-viewer-app-prd.md` ("Agent tooling")

### A stale-doc note

`docs/jfp-viewer-app-prd.md` still describes `expo-apps/` as "an isolated Expo toolchain island" with "its own pnpm/Metro/EAS workspace, lockfile, `node_modules`, and catalog", and names the apps `apps/{mobile,tv}` with Turborepo. The current `pnpm-workspace.yaml`, `expo-apps/AGENTS.md` and `expo-apps/README.md` say the opposite: one root install and lockfile, apps named `reach` and `hearth`, no `expo-apps/`-local workspace file, and nothing in the tree mentions a Turborepo pipeline (the `.easignore` still excludes `**/.turbo/`). Where they differ, `AGENTS.md` and `pnpm-workspace.yaml` are what the gate actually runs.

## Conflicts with the map's decisions

These are places where following the youtube-studio conventions to the letter would contradict a resolution already recorded on the console map. Each cites the deciding comment.

1. **The relay is the only listener; a browser is the client.** #506 §1 has one Node process serving the console over HTTP and the deployments over a WebSocket at `/deployments`, and §10 has the browser reading `GET /api/deployments`, `GET /api/deployments/:fingerprint`, `POST` verbs and one `GET /api/events` SSE stream behind a `__Host-` session cookie. Neither youtube-studio family matches that shape. The desktop family is an Electron main process with a preload bridge and a Vite renderer on a fixed dev port (`apps/resonance/vite.config.ts`, `scripts/dev-app-lifecycle.sh`); the native family is Expo Router screens over a GraphQL client (`docs/jfp-viewer-app-prd.md`). A Phoebe app built as either would add a second listener or a second protocol beside the relay's nine message types (#506 §6), which the resolution does not provide for.

2. **Zero dependencies on the deployment; WebCrypto only in the browser.** #514 §6 fixes the envelope as ECIES from WebCrypto primitives (X25519, HKDF-SHA256, AES-256-GCM) with no dependencies in either runtime, and cites #506 fixing the deployment's dependency count at zero. The youtube-studio conventions pull the other way: catalog-managed dependency sets (`pnpm-workspace.yaml`), `packages/youtube-auth` for OAuth with `safeStorage` (`CONTEXT-MAP.md`), Expo's `expo-crypto` and `@noble/hashes` in `catalogs.expo`. A native app on Expo has no WebCrypto guarantee at all; the Expo catalog carries `expo-crypto` precisely because React Native lacks it. The browser console has WebCrypto; an Expo client would need a dependency the resolution rejected.

3. **Secrets never rest on the relay; the app is not where a secret is typed into a file.** #514 §4 and §9 have the browser encrypting to the deployment's box key and the bootstrapper unwrapping on receipt; `phoebe secret set` never sees an envelope. The desktop convention is the reverse for its own secrets: Doppler downloads into a plaintext `apps/<app>/.env` that the fetch replaces wholesale (`AGENTS.md` "Secrets (Doppler)"), and a packaged app reads OAuth client credentials from a plaintext JSON file in `userData` (`apps/resonance/docs/BUILD_YOUR_OWN.md`). Those are conventions for the app's own credentials, not for tenant secrets, but an app author following them would have a plaintext-on-disk path the map's write-only decision has no room for.

4. **Configuration is four (now five) env vars on the relay, not a settings page or a per-app config.** #506 §9 says `RELAY_HOST`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `ALLOWED_EMAILS`, no `relay.config.ts`; #515 adds `RELAY_ALERT_WEBHOOK` and §7 rejects a console settings page. The desktop family persists a `settings.json` in `userData` (`apps/resonance/docs/BUILD_YOUR_OWN.md`) and the design system persists a theme preference (`expo-apps/packages/design/DESIGN.md`). A Phoebe app following that would introduce app-local persisted settings that the map keeps off the console.

5. **Distribution.** #506 §1 ships the relay in the `phoebe-agent` npm package with `phoebe relay init` scaffolding a consumer-owned `relay/{Dockerfile,compose.yml,.env.example}` and a Caddy sidecar (§2). Desktop apps in youtube-studio are self-build Electron artifacts (portable `.exe`, mac `.app` + `.zip`, no hosted binaries, `apps/resonance/docs/BUILD_YOUR_OWN.md`); native apps ship through EAS Build channels and OTA updates (`expo-apps/README.md`). Neither distribution model matches "one npm package, one process, one compose scaffold". Relay version equals bootstrapper version (#506 §1), whereas each youtube-studio app has its own `package.json` version that appears in its artifact name.

6. **Alerting has one channel, a generic webhook, and no browser push.** #515 §2 rejects email and browser push and keeps alerting on the relay. A native app would be the natural home for push notifications, and Expo's catalog is set up for a device app; the resolution has already ruled that out for this effort.

7. **Where the app lives.** `docs/agents/phoebe.md` and `AGENTS.md` are explicit that Phoebe "is not an app in this repo": a root devDependency, `phoebe.config.ts`, and `.phoebe/`. The `.easignore` excludes `/.phoebe/` from EAS uploads and Phoebe's own container runs `vp install --ignore-scripts`. Placing a Phoebe console app under `apps/` or `expo-apps/apps/` in youtube-studio would contradict that doc, and would put a Phoebe artifact into a tree whose install and CI gates were tuned to keep Phoebe out of the app set. The ticket frames the question as "whether or not it lives in that repo"; this is the fact that bears on the "in" arm.

None of these are choices. Items 1, 2 and 5 are hard contradictions with recorded decisions; 3, 4 and 6 are conventions that would need an explicit exception; 7 is a documented statement about where Phoebe sits in that repo.

## What carries over cleanly

For completeness, the conventions that do not collide with anything on the map: `AGENTS.md` as the cross-tool anchor; `CONTEXT.md` plus a `CONTEXT-MAP.md` entry for a new context; ADRs under `docs/adr/`; the unslop pass on human-facing prose; the PR-as-last-step rule with `Closes #<issue>`; never committing `.env` or secret values; and the 24-hour `minimumReleaseAge` gate, which already governs how youtube-studio bumps its `phoebe-agent` devDependency (`docs/agents/phoebe.md`).
