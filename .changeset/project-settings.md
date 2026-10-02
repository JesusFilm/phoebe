---
"phoebe-agent": minor
---

A local install's own settings, at the top of its install tab: the display name the rail shows, and the folder it points at. The name is a label kept in `companion.json` beside the folder, empty meaning the folder's own name as before. Changing the location opens the folder picker, inside WSL for a WSL install, and re-points the same entry at what was picked: the date it was added and its name come along, nothing is moved on disk, and the new folder is read as it stands. A folder already on the rail is refused. The bridge gains `installs.update` for both.
