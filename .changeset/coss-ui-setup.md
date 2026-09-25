---
"phoebe-agent": minor
---

The console is set up for Coss UI, the shadcn-style component set on Base UI that T3 Code builds from: the shadcn CLI against `components.json` with the `@coss` registry, Tailwind 4 through its Vite plugin, the Coss theme's variables and fonts, and Lucide for icons. Tailwind's preflight is left out so the console's own stylesheet keeps the browser defaults it was written against, and the theme's `dark` class follows the OS the way the console's colours already do. The first components in use are the rail's shortcut buttons and their spinner; the rest are added one at a time, as something needs them.
