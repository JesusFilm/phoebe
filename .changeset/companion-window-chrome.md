---
"phoebe-agent": patch
---

The companion window drops the native titlebar and, on Windows and Linux, Electron's stock File / Edit / View / Window / Help menu bar. The console's own top row is the titlebar now: drag the rail's brand or the route line to move the window, and the system's own window buttons sit over it, traffic lights on the left on macOS and minimise, maximise and close on the right elsewhere, in the console's light or dark colours. macOS keeps a small menu in the system bar, so Cmd+C, Cmd+V and Cmd+Q work as before. On Windows and Linux the keys the stock menu carried still work without it: zoom, F11 for full screen, Ctrl+Q on Linux, and reload and devtools in a checkout. A packaged app no longer reloads or opens devtools from the keyboard.
