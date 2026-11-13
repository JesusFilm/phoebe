---
"phoebe-agent": patch
---

A dependency issue closed without a merged PR now vetoes each row it listed, not the bundle's fingerprint. Before, a person who closed "Update 2 npm dependencies (dev:all)" got the same two bumps back as soon as a third package joined the bundle, because the new package changed the fingerprint. Now a row stays out of every bundle until that package's target moves or it picks up an advisory the closed issue did not list, and the rest of the bundle files without it. A bundle with every row vetoed files nothing. The scan log names each row it held back and the issue that vetoed it, for example `npm:dev:all: held back electron@45.3.2 (vetoed by #855).` `dependency-security` follows the same rule.
