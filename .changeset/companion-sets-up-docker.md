---
"phoebe-agent": minor
---

The companion sets up the machine it runs on. When Docker is missing or not running it opens on a setup page that shows the command it would run, installs Docker Desktop through winget or Homebrew or the distro's package manager under pkexec, or starts a Docker that is installed but stopped, and streams the output onto the page. Nothing runs without a click. The home page and the install tab link there while Docker stays unready. The desktop bridge gains a `bootstrap` namespace and `environmentChanges`.
