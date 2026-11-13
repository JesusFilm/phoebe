---
"phoebe-agent": patch
---

Scanning the same commit twice now plans the same dependency bundles. Before, the agent source could call a Dockerfile pin `prod` in one scan and `dev` in the next, or a patch a `minor`. Each answer put the bump under a different bundle key, so one bump could end up in two open issues and get the wrong maturity wait. Three changes fix that:

- The engine now works out the size of each move from the two versions and ignores what the agent wrote. A move between two image digests or two commit SHAs is a `digest` update.
- A pin in a Dockerfile, a compose file, a CI workflow or a script is always `prod`. For a manifest that does split dev from prod, the agent reports the section the package is declared in. The detection prompt no longer asks for `updateType`, so if you override `dependency-detect-prompt.md`, drop that key from your copy. A copy that still writes it keeps working; the value is ignored.
- Before filing, a row that an open issue under another bundle key already lists, at the same workspace and target, is held back. A bundle left with no rows files nothing, and the log names the issue that has the row, for example `dockerfile:relation:renovate: held back renovate@44.239.1 (already proposed in #850).` A row carrying an advisory the open issue does not list still files. `dependency-security` follows the same rule.
