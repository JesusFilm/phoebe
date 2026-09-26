---
"phoebe-agent": minor
---

The console, the log display a local install opens on, has colour themes, and the operator picks one. A select on the console's header offers System, which is Phoebe's own light or dark by the OS, and ten terminal schemes at their published values: Phoebe light and dark, Solarized light and dark, Nord, Gruvbox dark, Dracula, Catppuccin mocha, One dark, Tokyo night and Monokai. A theme is what a terminal's is, a background, a foreground and the sixteen ANSI colours, and the lines are drawn on it: the engine's tags coloured by role, the bootstrapper's, a pipeline's, the unit it is on, an agent's and stderr, and any ANSI colour an agent's own output carries shown in the palette rather than as codes. The choice lives in `companion.json` under `preferences.consoleTheme`; an id from a newer console reads as System in an older one. The app around the console keeps following the OS as it did.
