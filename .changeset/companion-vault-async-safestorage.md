---
"phoebe-agent": patch
---

The companion's bearer vault now uses Electron's async `safeStorage` calls, so launching no longer prints the two `safeStorage` deprecation warnings. Left alone, a future Electron that drops the sync calls would crash the first time the vault read a saved bearer. The remote arm waits for the keyring to answer before it serves anything, and when the keyring says `remote-bearers.bin` was encrypted under an older key, the vault writes it back under the current one.
