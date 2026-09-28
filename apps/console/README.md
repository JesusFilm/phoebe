# apps/console

The **console**: the operator's view of the installs on a machine, as one React
bundle the companion loads.

```sh
vp run dev     # from this directory; apps/desktop's dev window points here
vp run build   # writes ../../console, which the companion loads from disk
vp run test
```

`vp run build` emits into `console/` at the repo root rather than a local `dist/`.
`apps/*` itself never ships.

[`src/main.tsx`](src/main.tsx) reads the global the companion's preload exposes,
which is the only thing in the bundle that can tell the companion's window from a
plain browser ([#526](https://github.com/JesusFilm/phoebe/issues/526) shell A).
Everything the pages read arrives over that bridge.

What the pages show is **local installs**: folders on this machine, listed under
"This machine" on the rail, each with its host's mark
([`src/host-icon.tsx`](src/host-icon.tsx)) and a gear onto its settings, a
workspace root opening out to its children ([`src/rail.tsx`](src/rail.tsx)), and
each with an **install tab** that takes one from nothing to running with buttons
([#555](https://github.com/JesusFilm/phoebe/issues/555)).
[`src/local-install.ts`](src/local-install.ts) holds the readings and the
reducers, and [`src/install-page.tsx`](src/install-page.tsx) renders them. A
browser has no bridge, so it has no installs to list.

An install's other five tabs are overview, pipelines, doctor, secrets and config.
Main's local read loop execs `status --json` in the container and emits a `report`
event ([#556](https://github.com/JesusFilm/phoebe/issues/556)), so
[`src/deployment-tabs.tsx`](src/deployment-tabs.tsx) takes a narrowed report and
draws it. A stopped install shows config from the file and says what the rest
need; the last report the window is still holding is not drawn
([#526](https://github.com/JesusFilm/phoebe/issues/526)).

The reports arrive opaque, so [`src/report.ts`](src/report.ts) is the first thing
in the chain to look inside, and it checks the `schema` integer before it trusts a
field.

Pages are hash routes ([`src/route.ts`](src/route.ts)), because the companion
loads the bundle off a custom scheme where there is no server to ask. Links are
plain `href`s into the hash; the browser does the navigating and the history, and
the app only listens.

`vp run dev` serves the bundle on a fixed, strict port; `apps/desktop`'s
`vp run dev` points the companion's window at that same port.

## Components: Coss UI

The console's components come from [Coss UI](https://coss.com/ui), the shadcn-style
set on Base UI that T3 Code builds its desktop app from, added through the shadcn
CLI against `components.json`:

```sh
pnpm dlx shadcn@latest add @coss/dialog   # from this directory; writes src/components/ui/dialog.tsx
```

Only the components something here uses are checked in — `button`, `field`,
`input`, `label`, `spinner` and `tooltip` today — because each is a source file this repo then lints, type-checks
and formats. Add the next one when there is a use for it, not before.

What the CLI writes imports `~/lib/utils` and `~/components/ui/*`; the `~` alias
is in `tsconfig.json` and `vite.config.ts`. Styling is Tailwind 4 through its Vite
plugin, with the Coss theme's variables in [`src/index.css`](src/index.css) as
`shadcn init @coss/style` wrote them, and two changes of ours. Tailwind's preflight
is not imported: [`src/console.css`](src/console.css) was written against the
browser's defaults and preflight would take them away from every page at once, so
the base layer restores only the border defaults the components' utilities count
on. And the `dark` variant is the class the CLI wrote, put on `<html>` by
[`src/theme.ts`](src/theme.ts) whenever the OS is dark, so the components follow the
OS the way the console's own colours do (#526). The fonts are the theme's — Inter,
and Geist Mono for code — and console.css takes them by name.
