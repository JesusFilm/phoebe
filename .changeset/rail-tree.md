---
"phoebe-agent": minor
---

The console's rail reads more like T3 Code's project list. Every entry, a local install or a relay deployment, carries the mark of the host it runs on, Windows, macOS or Linux, with WSL as Linux too, and a settings gear at its edge that opens the install tab or the deployment's config. A workspace root opens out: a chevron before its name lists the children under it, found the way the bootstrapper finds them, each with a mark and a word read off the latest report (working, waiting, idle, held, wedged, or not in the fleet), and a child opens the workspace's pipelines tab.

For a relay deployment the host comes from its report: the bootstrapper now says where it runs in the report's identity, read off the kernel it sees, so a WSL2 kernel is `wsl`, a LinuxKit kernel is a Mac, and any other is Linux. A report from an older bootstrapper draws a cloud instead.
