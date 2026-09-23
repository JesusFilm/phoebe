---
"phoebe-agent": minor
---

The companion takes a folder inside a WSL distro as a local install. Pick it under Linux in the folder picker, as `\\wsl.localhost\<distro>\…`; the config, the Dockerfile pin and the `.env` are read and written through that path like any other folder's. Docker is the difference: Compose run from Windows would resolve the deployment's bind mounts to UNC paths Docker Desktop cannot mount, and the containers are the distro's own. So every `docker` the companion spawns for such an install — the `ps` behind the rail, the `status --json` read, the events stream, start and stop, `secret set` into the container, pairing's `up -d` — now runs inside the distro through `wsl.exe --exec`, with each path translated to the one the distro knows. The rail and the install tab name the distro, and this machine's own Docker check is not held against it.
